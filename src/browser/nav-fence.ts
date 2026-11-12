/**
 * Where a session's top frame may go (agent-browser audit row 12, WA-1351):
 * a page's text can tell the agent to open a URL that carries data away. A
 * top-frame document request outside the hosts fails before it is sent: an
 * `open`, a link, a form post, a script redirect, each redirect hop. Iframes
 * pass (captchas, embedded sign-in), and so does every subresource.
 * Gap: a popup's first request leaves before its fence is up (Playwright hands
 * over the page after); the page is then blanked, so the agent never reads it.
 * Own CDP `Fetch` on Document requests only: Playwright's `route` would turn
 * the HTTP cache off for the whole context, which sites can see.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import { NetRefused } from "../reach/net-guard.js";

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

/** Fences every page of the context, now and later. `onRefused` hears each blocked URL. */
export async function fenceNavigations(
  context: BrowserContext,
  allow: HostRule,
  onRefused?: (url: string) => void,
): Promise<void> {
  const fence = async (page: Page): Promise<void> => {
    const cdp: CDPSession = await context.newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const top = frameTree.frame.id;
    cdp.on("Fetch.requestPaused", (e) => {
      const ok = e.frameId !== top || urlAllowed(e.request.url, allow);
      if (!ok) onRefused?.(e.request.url);
      void (
        ok
          ? cdp.send("Fetch.continueRequest", { requestId: e.requestId })
          : cdp.send("Fetch.failRequest", {
              requestId: e.requestId,
              errorReason: "BlockedByClient",
            })
      ).catch(() => undefined); // the page closed meanwhile
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
    // a popup's first load can land before its fence: the answer is kept from the agent
    const blank = () => {
      if (!urlAllowed(page.url(), allow)) {
        onRefused?.(page.url());
        void page.goto("about:blank").catch(() => undefined);
      }
    };
    blank();
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) blank();
    });
  };
  await Promise.all(context.pages().map(fence));
  context.on("page", (p) => void fence(p).catch(() => undefined));
}
