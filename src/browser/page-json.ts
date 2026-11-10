/**
 * The site's own JSON from inside its page, with the session's cookies (`cookie` rung), and
 * the JSON a page fetches as it loads (`intercept` rung). Each answer is classed once here:
 * 429 → `rate_limited`, a sign-in or checkpoint answer → `need_login` / `platform_blocked`
 * (both stop the ladder), a 404 or a body that is not JSON → `RungBroke` (the next rung).
 * Bodies come back whole: no field is dropped.
 */
import type { Response } from "playwright";
import type { FlowPage } from "./flow.js";
import { RungBroke } from "./ladder.js";
import { AccessRefused } from "./session.js";

export interface PageFetch {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** A form or JSON string, as the page's own call sends it. */
  body?: string;
  /** "omit" for a read the site serves signed out. Default "include". */
  credentials?: "include" | "omit" | "same-origin";
}

export interface Fetched {
  status: number;
  /** The URL after redirects. */
  url: string;
  contentType: string;
  text: string;
}

/** One fetch in the page; nothing classed. */
export function pageFetch(
  fp: Pick<FlowPage, "page">,
  url: string,
  o: PageFetch = {},
): Promise<Fetched> {
  return fp.page.evaluate(
    async ({ url, o }) => {
      const r = await fetch(url, {
        method: o.method ?? "GET",
        headers: o.headers ?? {},
        credentials: o.credentials ?? "include",
        ...(o.body !== undefined ? { body: o.body } : {}),
      });
      return {
        status: r.status,
        url: r.url,
        contentType: r.headers.get("content-type") ?? "",
        text: await r.text(),
      };
    },
    { url, o },
  );
}

const SIGN_IN_URL = /\/(accounts\/)?login\b|\/signin\b|\/uas\/login/i;
/** Words a JSON refusal uses for a session that is gone, or a hold on the account. */
const LOGIN_WORDS =
  /login_required|not[-_ ]logged[-_ ]in|"require_login"\s*:\s*true|unauthenticated/i;
const BLOCK_WORDS =
  /checkpoint_required|challenge_required|feedback_required|consent_required|spam|suspended|restricted/i;
/** Some sites guard JSON against script inclusion: `for (;;);`, `)]}'`. */
const GUARD = /^\s*(for\s*\(;;\);|\)\]\}',?|while\s*\(1\);)/;

export function parseJson(text: string): { ok: true; json: unknown } | { ok: false } {
  try {
    return { ok: true, json: JSON.parse(text.replace(GUARD, "")) };
  } catch {
    return { ok: false };
  }
}

/** The class of one answer: the JSON, or a throw that says which way to go. */
export function classify(f: Fetched, what: string): unknown {
  if (f.status === 429) throw new AccessRefused("rate_limited", `${what}: HTTP 429`);
  if (SIGN_IN_URL.test(new URL(f.url, "https://x").pathname))
    throw new AccessRefused("need_login", `${what}: sent to sign in`);
  const parsed = parseJson(f.text);
  const head = f.text.slice(0, 2000);
  if (parsed.ok && f.status >= 400) {
    if (BLOCK_WORDS.test(head))
      throw new AccessRefused("platform_blocked", `${what}: ${f.status} ${head.slice(0, 160)}`);
    if (LOGIN_WORDS.test(head) || f.status === 401)
      throw new AccessRefused("need_login", `${what}: ${f.status} ${head.slice(0, 160)}`);
  }
  if (f.status === 401) throw new AccessRefused("need_login", `${what}: HTTP 401`);
  if (f.status >= 400 || !parsed.ok)
    throw new RungBroke(`${what}: HTTP ${f.status}${parsed.ok ? "" : ", not JSON"}`);
  return parsed.json;
}

/** The site's JSON at `url`, classed. */
export async function pageJson<T = unknown>(
  fp: Pick<FlowPage, "page">,
  url: string,
  o: PageFetch = {},
): Promise<T> {
  return classify(await pageFetch(fp, url, o), url.replace(/\?.*/, "")) as T;
}

export interface Paged<T> {
  /** Page 1's URL with no cursor, then each next one with it. */
  url: (cursor: string | null) => string;
  items: (json: unknown) => readonly T[];
  /** The next cursor, null at the end. */
  next: (json: unknown) => string | null;
  max: number;
  /** Between pages: a person's pause. */
  pause?: () => Promise<void>;
  fetch?: PageFetch;
}

/** Every page of a cursor list up to `max` items, stopped by a cursor seen before. */
export async function pagedJson<T>(
  fp: Pick<FlowPage, "page">,
  o: Paged<T>,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const json = await pageJson(fp, o.url(cursor), o.fetch);
    pages++;
    items.push(...o.items(json));
    const next = o.next(json);
    if (next !== null && seen.has(next)) break;
    if (next !== null) seen.add(next);
    cursor = next;
    if (cursor && items.length < o.max) await o.pause?.();
  } while (cursor && items.length < o.max);
  return { items: items.slice(0, o.max), pages };
}

export interface Capture {
  /** Responses whose URL this matches are kept. */
  match: RegExp;
  /** Only bodies this says hold the data (a GraphQL answer for the right query). */
  keep?: (json: unknown) => boolean;
}

/**
 * Keep the JSON the page fetches while `during` runs (open a page, scroll a feed): whole bodies,
 * in arrival order, also handed to `during` as they come (a scroll stops on enough). Any text
 * body that parses counts: Instagram sends GraphQL as `text/javascript`. A 429 among them
 * stops with `rate_limited`.
 */
export async function captureJson<R>(
  fp: Pick<FlowPage, "page">,
  c: Capture,
  during: (bodies: readonly unknown[]) => Promise<R>,
): Promise<{ bodies: unknown[]; result: R }> {
  const bodies: unknown[] = [];
  const pending: Promise<void>[] = [];
  let limited: string | null = null;
  const on = (res: Response) => {
    if (!c.match.test(res.url())) return;
    if (res.status() === 429) limited = res.url();
    pending.push(
      res
        .text()
        .then((t) => {
          const p = parseJson(t);
          if (p.ok && (!c.keep || c.keep(p.json))) bodies.push(p.json);
        })
        .catch(() => {}),
    );
  };
  fp.page.on("response", on);
  try {
    const result = await during(bodies);
    await Promise.all(pending);
    if (limited)
      throw new AccessRefused(
        "rate_limited",
        `HTTP 429 from ${String(limited).replace(/\?.*/, "")}`,
      );
    return { bodies, result };
  } finally {
    fp.page.off("response", on);
  }
}
