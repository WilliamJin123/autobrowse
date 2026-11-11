/**
 * `proof` (PinchTab audit P13, from `P/internal/audit/compare.go`): one page loaded at each
 * width, with what a person would flag. Per width: horizontal overflow and the boxes past the
 * edge, text cut by its box, uncaught page errors, broken assets, a full-page shot.
 * `compareProofs` says what changed between two proofs, by identity, not count:
 * - an error is its first line with the page's origin masked: one bug on localhost and on prod is one;
 * - an asset counts only with an HTTP status >= 400: a reset or a timeout belongs to the run, not the page;
 * - a swap (one fixed, one new) is a change, not a wash.
 * No pixel diff: William turned screenshot compare off (10-18); shots are for reading.
 */
import type { Page, Request, Response } from "playwright";
import { checkUrl } from "../reach/net-guard.js";
import type { PageErrors } from "./page-errors.js";

export const PROOF_WIDTHS = [390, 1280];
const PROOF_HEIGHT = 900;
const SETTLE_MS = 1_500;
const LOAD_MS = 30_000;
const KEEP_BOXES = 12;

export interface Box {
  /** tag#id.class, enough to find it. */
  sel: string;
  left: number;
  right: number;
  width: number;
  text?: string;
}

export interface BrokenAsset {
  url: string;
  /** 0: no HTTP answer (reset, blocked, timed out). */
  status: number;
  type: string;
  failure?: string;
}

export interface WidthProof {
  width: number;
  /** The page scrolls sideways. */
  scrolls: boolean;
  pageWidth: number;
  /** Outermost boxes past the left or right edge, not clipped by a parent. */
  over: Box[];
  /** Text wider than its box, hidden by `overflow`. */
  cut: Box[];
  errors: { message: string; stack?: string }[];
  broken: BrokenAsset[];
  shot: string | null;
}

export interface Proof {
  url: string;
  at: string;
  widths: WidthProof[];
}

/** In the page: overflow and cut text at the current width. */
export const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + el.id;
    const cls = [...el.classList].slice(0, 2);
    return cls.length ? s + "." + cls.join(".") : s;
  };
  const clips = (el) => /(hidden|clip|auto|scroll)/.test(getComputedStyle(el).overflowX);
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement)
      if (clips(p)) return true;
    return false;
  };
  const words = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  const over = [], cut = [], seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "contents") continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
      let inner = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (seen.has(p)) { inner = true; break; }
      if (!inner) {
        seen.add(el);
        over.push({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && clips(el) && el.scrollWidth > el.clientWidth + 1)
      cut.push({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), text: words(el) });
  }
  return { pageWidth: document.documentElement.scrollWidth, viewport: vw, over, cut };
})()`;

interface Measured {
  pageWidth: number;
  viewport: number;
  over: Box[];
  cut: Box[];
}

/** A page that never scrolls sideways hides boxes wholly off it (a closed drawer): not a fault. */
export const visibleOver = (over: Box[], viewport: number, scrolls: boolean): Box[] =>
  scrolls ? over : over.filter((b) => b.left < viewport && b.right > 0);

const ASSET_TYPES = new Set([
  "document",
  "stylesheet",
  "script",
  "image",
  "font",
  "media",
  "fetch",
  "xhr",
]);

/** Loads `url` at each width; leaves the page at its first size again. */
export async function proofPage(
  page: Page,
  o: {
    url: string;
    widths?: number[];
    errors: PageErrors;
    shotPath?: (width: number) => string;
    settleMs?: number;
  },
): Promise<Proof> {
  await checkUrl(o.url, { browser: true });
  const first = page.viewportSize();
  const widths: WidthProof[] = [];
  try {
    for (const width of o.widths ?? PROOF_WIDTHS) {
      await page.setViewportSize({ width, height: first?.height ?? PROOF_HEIGHT });
      const broken: BrokenAsset[] = [];
      const onResponse = (r: Response) => {
        const type = r.request().resourceType();
        if (r.status() >= 400 && ASSET_TYPES.has(type))
          broken.push({ url: r.url(), status: r.status(), type });
      };
      const onFailed = (r: Request) => {
        if (ASSET_TYPES.has(r.resourceType()))
          broken.push({
            url: r.url(),
            status: 0,
            type: r.resourceType(),
            failure: r.failure()?.errorText ?? "failed",
          });
      };
      page.on("response", onResponse);
      page.on("requestfailed", onFailed);
      const errs = o.errors.count();
      try {
        await page.goto(o.url, { waitUntil: "load", timeout: LOAD_MS });
        await page.waitForTimeout(o.settleMs ?? SETTLE_MS);
      } finally {
        page.off("response", onResponse);
        page.off("requestfailed", onFailed);
      }
      const m = (await page.evaluate(MEASURE)) as Measured;
      const shot = o.shotPath ? o.shotPath(width) : null;
      if (shot) await page.screenshot({ path: shot, fullPage: true });
      const scrolls = m.pageWidth > m.viewport + 1;
      widths.push({
        width,
        scrolls,
        pageWidth: m.pageWidth,
        over: visibleOver(m.over, m.viewport, scrolls).slice(0, KEEP_BOXES),
        cut: m.cut.slice(0, KEEP_BOXES),
        errors: o.errors.since(errs).map((e) => ({
          message: e.message,
          ...(e.stack ? { stack: e.stack } : {}),
        })),
        broken,
        shot,
      });
    }
  } finally {
    if (first) await page.setViewportSize(first).catch(() => undefined);
  }
  return { url: o.url, at: new Date().toISOString(), widths };
}

const ORIGIN = "<origin>";

export function originOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol.startsWith("http") ? u.origin : "";
  } catch {
    return "";
  }
}

const mask = (v: string, origin: string) => (origin ? v.split(origin).join(ORIGIN) : v);

/** Sorted error identities: first line, origin masked. */
export function errorIds(w: WidthProof, origin: string): string[] {
  return w.errors.map((e) => mask((e.message.split("\n")[0] ?? "").trim(), origin)).sort();
}

/** Sorted asset identities: HTTP failures only, origin masked. */
export function brokenIds(w: WidthProof, origin: string): string[] {
  return w.broken
    .filter((b) => b.status >= 400)
    .map((b) => `${mask(b.url, origin)} ${b.status}`)
    .sort();
}

const boxIds = (bs: Box[]) => bs.map((b) => b.sel).sort();
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const said = (ids: string[]) => (ids.length ? `${ids.length}: ${ids.join(" | ")}` : "0");

export interface Drift {
  width: number;
  field: "scrolls" | "over" | "cut" | "errors" | "broken" | "missing";
  before: string;
  after: string;
}

/** What changed from `before` to `after`, per width both have; empty when the same. */
export function compareProofs(before: Proof, after: Proof): Drift[] {
  const bo = originOf(before.url);
  const ao = originOf(after.url);
  const out: Drift[] = [];
  for (const a of after.widths) {
    const b = before.widths.find((x) => x.width === a.width);
    if (!b) {
      out.push({ width: a.width, field: "missing", before: "not measured", after: "measured" });
      continue;
    }
    const add = (field: Drift["field"], x: string[], y: string[]) => {
      if (!same(x, y)) out.push({ width: a.width, field, before: said(x), after: said(y) });
    };
    if (a.scrolls !== b.scrolls)
      out.push({
        width: a.width,
        field: "scrolls",
        before: String(b.scrolls),
        after: String(a.scrolls),
      });
    add("over", boxIds(b.over), boxIds(a.over));
    add("cut", boxIds(b.cut), boxIds(a.cut));
    add("errors", errorIds(b, bo), errorIds(a, ao));
    add("broken", brokenIds(b, bo), brokenIds(a, ao));
  }
  return out;
}

/** One line per thing a person would flag. */
export function proofFlags(p: Proof): string[] {
  const origin = originOf(p.url);
  return p.widths.flatMap((w) => [
    ...(w.scrolls ? [`${w.width}: scrolls sideways (page ${w.pageWidth} px)`] : []),
    ...w.over.map((b) => `${w.width}: ${b.sel} past the edge (${b.left}..${b.right})`),
    ...w.cut.map((b) => `${w.width}: ${b.sel} text cut ("${b.text ?? ""}")`),
    ...errorIds(w, origin).map((e) => `${w.width}: page error ${e}`),
    ...brokenIds(w, origin).map((e) => `${w.width}: broken ${e}`),
  ]);
}
