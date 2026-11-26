/**
 * Where a session's top frame may go (agent-browser audit row 12, WA-1351):
 * a page's text can tell the agent to open a URL that carries data away. A
 * top-frame document request outside the hosts fails before it is sent: an
 * `open`, a link, a form post, a script redirect, each redirect hop. Iframes
 * pass (captchas, embedded sign-in), and so does every subresource.
 * Browser-level `Fetch`: a popup's first request (a `target=_blank` form post)
 * is paused before Playwright hands over the page. A page target's id is its
 * main frame's id, so a paused frame that is a page target of this context is
 * a top frame. No browser session (non-Chromium): per page, and that first
 * request leaves; the popup is then blanked.
 * Own CDP `Fetch` on Document requests only: Playwright's `route` would turn
 * the HTTP cache off for the whole context, which sites can see.
 * Firefox and WebKit have no CDP. `context.route` misses a redirect hop on Firefox; WebKit's
 * route stops it (both measured 11-26). `FENCE_HOPS=block`: the session refuses a fenced run
 * there (`refusalOf`); this throws if one gets here. `blank`: the route stops every other
 * top-frame request; a hop's outside page loads, is blanked, and `onLanded` hears it (explore
 * drops that command's answer).
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import { NetRefused } from "../reach/net-guard.js";
import type { FenceHops } from "./engines.js";

export type HostRule = (host: string) => boolean;

/** about:, data:, blob:, chrome-error: carry nothing out; http(s) goes by host. */
export function urlAllowed(url: string, allow: HostRule): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  return allow(u.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

/** The refusal an `open` gets before anything is sent. */
export function outsideSession(url: string): NetRefused {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // not a URL: the message names it as given
  }
  return new NetRefused(url, `${host} is outside this session's sites`);
}

export interface FenceOptions {
  /** No CDP: "block" throws; "blank" fences by route. Default "block". */
  hops?: FenceHops;
  /** Each URL stopped unsent. */
  onRefused?: (url: string) => void;
  /** Each outside page that loaded (a redirect hop off Chromium, a popup's first request), then blanked. */
  onLanded?: (url: string) => void;
}

/** Fences every page of the context, now and later. Says which fence holds. */
export async function fenceNavigations(
  context: BrowserContext,
  allow: HostRule,
  o: FenceOptions = {},
): Promise<"cdp" | "route"> {
  const { onRefused } = o;
  const watch = blankOutside(allow, o.onLanded);
  const first = context.pages()[0];
  if (
    first &&
    !(await context.newCDPSession(first).then(
      (c) => c.detach().then(() => true),
      () => false,
    ))
  ) {
    if (o.hops !== "blank")
      throw new Error("the nav fence needs Chromium: this browser cannot stop a redirect hop");
    await fenceByRoute(context, allow, onRefused);
    for (const p of context.pages()) watch(p);
    context.on("page", watch);
    return "route";
  }
  const whole = await fenceBrowser(context, allow, onRefused).catch(() => false);
  const each = whole
    ? async (p: Page) => watch(p)
    : async (p: Page) => {
        await fencePage(context, p, allow, onRefused);
        watch(p);
      };
  await Promise.all(context.pages().map(each));
  context.on("page", (p) => void each(p).catch(() => undefined));
  return "cdp";
}

/** No CDP: each top-frame request off the sites fails unsent; Firefox never routes a redirect hop. */
async function fenceByRoute(
  context: BrowserContext,
  allow: HostRule,
  onRefused?: (url: string) => void,
): Promise<void> {
  await context.route("**/*", (route, req) => {
    let top = false;
    try {
      top = req.isNavigationRequest() && req.frame().parentFrame() === null;
    } catch {
      // a worker's request has no frame
    }
    if (!top || urlAllowed(req.url(), allow)) return route.fallback();
    onRefused?.(req.url());
    return route.abort("blockedbyclient");
  });
}

/** The answer of a load that got past a fence (a page already open, a hop off Chromium) is kept from the agent. */
function blankOutside(allow: HostRule, onLanded?: (url: string) => void) {
  return (page: Page): void => {
    const blank = () => {
      if (!urlAllowed(page.url(), allow)) {
        onLanded?.(page.url());
        void page.goto("about:blank").catch(() => undefined);
      }
    };
    blank();
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) blank();
    });
  };
}

type Paused = { requestId: string; frameId: string; request: { url: string } };

/** Decides one paused request on `cdp`: refused when `top` and the URL is off the sites. */
function settle(
  cdp: CDPSession,
  e: Paused,
  top: boolean,
  allow: HostRule,
  onRefused?: (url: string) => void,
): void {
  const ok = !top || urlAllowed(e.request.url, allow);
  if (!ok) onRefused?.(e.request.url);
  void (
    ok
      ? cdp.send("Fetch.continueRequest", { requestId: e.requestId })
      : cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" })
  ).catch(() => undefined); // the page closed meanwhile
}

const DOCUMENTS = {
  patterns: [
    { urlPattern: "*", resourceType: "Document" as const, requestStage: "Request" as const },
  ],
};

/** One browser-level session; false when there is no browser session or no page to scope by. */
async function fenceBrowser(
  context: BrowserContext,
  allow: HostRule,
  onRefused?: (url: string) => void,
): Promise<boolean> {
  const browser = context.browser();
  const first = context.pages()[0];
  if (!browser || !first) return false;
  const own = await context.newCDPSession(first);
  const { targetInfo } = await own.send("Target.getTargetInfo");
  await own.detach().catch(() => undefined);
  const scope = targetInfo.browserContextId;
  const cdp = await browser.newBrowserCDPSession();
  // page targets: ours = judged; another context's = passed; not a page target = an iframe
  const pages = new Map<string, boolean>();
  const refresh = async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos)
      if (t.type === "page") pages.set(t.targetId, t.browserContextId === scope);
  };
  cdp.on("Fetch.requestPaused", (e) => {
    void (async () => {
      if (!pages.has(e.frameId)) {
        await refresh().catch(() => undefined);
        // a page target exists before its first request: still unknown = an iframe
        if (!pages.has(e.frameId)) pages.set(e.frameId, false);
      }
      settle(cdp, e, pages.get(e.frameId) === true, allow, onRefused);
    })();
  });
  await refresh();
  await cdp.send("Fetch.enable", DOCUMENTS);
  context.on("close", () => void cdp.detach().catch(() => undefined));
  return true;
}

/** Per page, for a browser with no browser-level session. */
async function fencePage(
  context: BrowserContext,
  page: Page,
  allow: HostRule,
  onRefused?: (url: string) => void,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const top = frameTree.frame.id;
  cdp.on("Fetch.requestPaused", (e) => settle(cdp, e, e.frameId === top, allow, onRefused));
  await cdp.send("Fetch.enable", DOCUMENTS);
}
