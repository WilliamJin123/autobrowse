import type { BrowserContext, CDPSession, FileChooser, Locator, Page } from "playwright";
import { checkUrl, landedOk } from "../reach/net-guard.js";
import type { CaptchaSolve, FlowRunRow } from "../runs/flows.js";
import { markReached } from "./attempt.js";
import type { CaptchaOutcome } from "./captcha/index.js";
import {
  type FilePayload,
  OFFLINE_PAGE,
  type Op,
  pageWide,
  type ReadTab,
  type Site,
} from "./flow-api.js";
import { type Hands, instantHands, pickOption } from "./human/index.js";
import { inPage } from "./in-page.js";
import { type Hints, locate, textOf } from "./locate.js";
import { backgroundTab } from "./own-tabs.js";
import { looksLikeWall } from "./session.js";

export const ACT_TIMEOUT_MS = 15_000;
/** How often a step waiting for its control looks for something in the way. */
export const POLL_MS = 250;
/** Clicks past what is in the way before one act gives up: a new screen or two, not a new flow. */
export const MAX_DETOURS = 3;

/** One flow-run row (`runs/flows`), timed from `startedAt` to now. */
export function runRow(
  flow: { site: Site; name: string },
  startedAt: number,
  r: Omit<FlowRunRow, "site" | "flow" | "startedAt" | "endedAt" | "ms">,
): FlowRunRow {
  return {
    site: flow.site,
    flow: flow.name,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    ms: Date.now() - startedAt,
    ...r,
  };
}

/** One solve for the run's row: the page without its query, each model's answers. */
export function solveRow(got: CaptchaOutcome, url: string, ms: number): CaptchaSolve {
  let page = url;
  try {
    const u = new URL(url);
    page = `${u.origin}${u.pathname}`;
  } catch {
    // not a URL: kept as is
  }
  return {
    kind: got.kind,
    vendor: got.vendor,
    solved: got.solved,
    ...(got.solved ? { rounds: got.rounds } : { reason: got.reason }),
    page,
    ms,
    ...(got.looks ? { looks: got.looks } : {}),
  };
}

/** `AUTOBROWSE_SEED`: one run's seed, to replay its motions. */
export function seedOf(given = process.env.AUTOBROWSE_SEED): number | undefined {
  const n = Number(given);
  return given && Number.isInteger(n) && n >= 0 ? n >>> 0 : undefined;
}

/** The same page, fragment aside. */
export function samePage(current: string, url: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return strip(current) === strip(url);
}

// Busy apps never go idle: this caps what each open pays (8 s was half of an App Store Connect step).
export const SETTLE_MS = 4_000;
/** AWS's console → sign-in chain takes 30–60 s to DOMContentLoaded headless; Playwright's 30 s default cut it. */
const NAVIGATE_MS = 90_000;

/**
 * Navigate and let client-side redirects finish: a dashboard that bounces
 * to its login page does so after DOMContentLoaded, and a wall check
 * before that would call an unauthenticated page "signed in".
 */
export async function settle(page: Page, url: string): Promise<void> {
  await checkUrl(url, { browser: true });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_MS });
  await landedOk(page);
  // after the load: a goto that fails offline reached nothing
  markReached();
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

/**
 * Choose a value on a `<select>`, or on a custom dropdown (a combobox/button
 * that opens a list): open it, then click the option whose text is the value.
 * The step stays a `select` either way, so a recording replays the same.
 */
export async function chooseOption(
  target: Locator,
  value: string,
  timeout: number,
  hands: Hands = instantHands,
): Promise<void> {
  const o = { timeout };
  // Asked to choose: a combobox input opens a list too.
  await pickOption(target, value, o, (l) => hands.click(l, o), null);
}

export async function doOp(
  page: Page,
  hints: Hints,
  op: Op,
  timeout: number,
  hands: Hands,
): Promise<void> {
  if (op.kind === "script" && pageWide(hints)) {
    await inPage(page, op.js);
    return;
  }
  const target = locate(page, hints);
  await hands.think(page);
  switch (op.kind) {
    case "script":
      // A string is an expression to Playwright, never called: wrap it as a function of el.
      await target
        .first()
        .evaluate(
          new Function("el", `return (${op.js})(el);`) as (el: unknown) => unknown,
          undefined,
          {
            timeout,
          },
        );
      return;
    case "click":
      return hands.click(target, { timeout });
    case "fill":
      await hands.type(target, op.value, { timeout });
      return;
    case "select":
      return chooseOption(target, op.value, timeout, hands);
    case "press":
      return hands.press(target, op.key, { timeout });
    case "hover":
      return hands.hover(target, { timeout });
    case "upload": {
      if (op.files.some((f) => typeof f !== "string"))
        return uploadFiles(page, target, op.files as FilePayload[], timeout, hands);
      // A ref from another machine (s3://, a signed URL) becomes a cached local file.
      const { resolveFile } = await import("./run-files.js");
      const paths = await Promise.all((op.files as string[]).map((f) => resolveFile(f)));
      return uploadFiles(page, target, paths, timeout, hands);
    }
  }
}

const TAB_ACTS = new Set(["hover", "click", "press"]);

/** Tabs that outlive a run on purpose (a watcher's): never closed as strays. */
export const keptTabs = new WeakSet<Page>();

/**
 * Closes the tabs a run's steps left open beside `main` (a `target=_blank` link, a popup). A
 * parked browser serves run after run: each stray holds a renderer until the browser closes.
 */
export async function closeStrayTabs(context: BrowserContext, main: Page): Promise<number> {
  const strays = context.pages().filter((p) => p !== main && !keptTabs.has(p) && !p.isClosed());
  await Promise.all(strays.map((p) => p.close().catch(() => undefined)));
  return strays.length;
}

/**
 * A background tab beside `from`, matched by target id: another read opening a tab at the
 * same moment never hands us its page. A context without CDP gets a plain tab, `from` kept in front.
 */
export async function backgroundPage(context: BrowserContext, from: Page): Promise<Page> {
  let cdp: CDPSession | null = null;
  try {
    cdp = await context.newCDPSession(from);
    return (await backgroundTab(context, cdp, SETTLE_MS * 4, { sameWindow: true })).page;
  } catch {
    const page = await context.newPage();
    await from.bringToFront().catch(() => undefined);
    return page;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}

/**
 * CDP `background: true`: the headed window stays on the main tab.
 * Measured 2026-11-05: lazy rows load in such a tab, headless and headed.
 */
export async function openReadTab(
  context: BrowserContext,
  from: Page,
  hands: Hands,
): Promise<ReadTab> {
  const page = await backgroundPage(context, from);
  return {
    page,
    async open(url) {
      await settle(page, url);
      if (OFFLINE_PAGE.test(page.url()))
        throw new Error(`net::ERR_INTERNET_DISCONNECTED opening ${url}`);
      const wall = await looksLikeWall(page);
      if (wall) throw new Error(`read tab: ${wall.detail}; sign in on fp first, then send again`);
    },
    url: () => page.url(),
    read: async (hints) => (await textOf(locate(page, hints))).slice(0, 2_000),
    has: async (hints, withinMs = 0) => {
      const l = locate(page, hints).first();
      if (withinMs > 0)
        await l.waitFor({ state: "visible", timeout: withinMs }).catch(() => undefined);
      return l.isVisible().catch(() => false);
    },
    wait: (ms) => page.waitForTimeout(ms),
    scroll: (dy) => hands.scroll(page, dy),
    act: async (op, hints) => {
      if (!TAB_ACTS.has(op.kind)) throw new Error(`read tab: no ${op.kind}; do it on fp`);
      await doOp(page, hints, op, ACT_TIMEOUT_MS, hands);
    },
    close: () => page.close().catch(() => undefined),
  };
}

/** Files into a file input, else through the chooser the target opens. */
export async function uploadFiles(
  page: Page,
  target: Locator,
  files: string[] | FilePayload[],
  timeout: number,
  hands: Hands,
): Promise<void> {
  const isInput = await target
    .evaluate(
      (el) => el.tagName === "INPUT" && (el as { type?: string }).type === "file",
      undefined,
      { timeout },
    )
    .catch(() => false);
  if (isInput) return target.setInputFiles(files, { timeout });
  // Caught here: a click that throws must not leave the wait to reject unhandled.
  const chooser = page.waitForEvent("filechooser", { timeout }).catch((e: unknown) => e);
  await hands.click(target, { timeout });
  const got = await chooser;
  if (!(got instanceof Error)) return (got as FileChooser).setFiles(files);
  // Some buttons open no chooser (YouTube Studio): their hidden input sits beside them.
  const near = target
    .locator("xpath=ancestor-or-self::*[.//input[@type='file']][1]//input[@type='file']")
    .first();
  if (await near.count()) return near.setInputFiles(files, { timeout });
  throw got;
}

/** How long a person has for a step on the page, and how often the page is asked. */
export const PERSON_MS = 5 * 60_000;
