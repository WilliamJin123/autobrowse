/**
 * Every reel of one Instagram account, read in the signed-in instagram profile (WA-1250).
 * Business and creator accounts go by API first: `meta GET /instagram/{username}/reels`.
 *
 * 1. The page's own feed call, `/api/v1/feed/user/<username>/username/?count=N`, paged by
 *    `next_max_id` (endpoint from OpenCLI clis/instagram/user.js@9bc5f5c). Each item kept whole;
 *    a reel is `product_type: "clips"`. A person's pause between pages.
 *    2026-11-09: 404 with a not-logged-in page from our profile, even with the page's CSRF,
 *    claim and ASBD headers; kept since it costs one call and gives whole items when it answers.
 * 2. That call refused or not JSON: the account's Reels tab, scrolled for `/reel/` links.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";
import { IG_APP_ID, postCodesOf } from "./instagram-act.js";

const WEB = "https://www.instagram.com";
const PAGE = 33;
/** Between feed pages: 2–5 s, as a person scrolls a grid. */
const PAUSE_MS: [number, number] = [2_000, 5_000];
const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;

/** The little of the DOM the page script touches; the project compiles without lib dom. */
declare const document: {
  querySelectorAll(sel: string): Iterable<{ getAttribute(n: string): string | null }>;
};

export const reelUrl = (code: string) => `${WEB}/reel/${encodeURIComponent(code)}/`;

export interface ReelsInput {
  username: string;
  /** Most posts read (reels and others), newest first. */
  max?: number;
}

export interface Reels {
  username: string;
  found: boolean;
  /** `feed`: the page's feed call; `grid`: the Reels tab scrolled (urls only). */
  source: "feed" | "grid";
  urls: string[];
  /** Each reel's whole feed item (source `feed`); empty from the grid. */
  reels: unknown[];
  /** Posts read, reels or not. */
  scanned: number;
  pages: number;
  /** Why the feed call was left for the grid. */
  feedFailed?: string;
}

interface FeedPage {
  status: number;
  json: boolean;
  items: unknown[];
  next: string | null;
  more: boolean;
}

/** One feed item's reel code, or null for a photo or carousel. */
export function reelCodeOf(item: unknown): string | null {
  const i = (item ?? {}) as { product_type?: unknown; code?: unknown };
  return i.product_type === "clips" && typeof i.code === "string" && i.code ? i.code : null;
}

const pause = (fp: FlowPage) =>
  fp.wait(PAUSE_MS[0] + Math.round(Math.random() * (PAUSE_MS[1] - PAUSE_MS[0])));

async function byFeed(
  fp: FlowPage,
  username: string,
  cap: number,
): Promise<{ items: unknown[]; pages: number } | { failed: string }> {
  const items: unknown[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const got: FeedPage = await fp.page.evaluate(
      async ({ username, after, count, app }) => {
        const q = `count=${count}${after ? `&max_id=${encodeURIComponent(after)}` : ""}`;
        const r = await fetch(`/api/v1/feed/user/${encodeURIComponent(username)}/username/?${q}`, {
          headers: { "X-IG-App-ID": app },
          credentials: "include",
        });
        let j: { items?: unknown[]; next_max_id?: unknown; more_available?: unknown } = {};
        let json = false;
        try {
          j = JSON.parse(await r.text());
          json = true;
        } catch {}
        const next = j.next_max_id;
        return {
          status: r.status,
          json,
          items: Array.isArray(j.items) ? j.items : [],
          next: typeof next === "string" || typeof next === "number" ? String(next) : null,
          more: j.more_available === true,
        };
      },
      { username, after, count: PAGE, app: IG_APP_ID },
    );
    pages++;
    if (got.status !== 200 || !got.json)
      return { failed: `HTTP ${got.status}${got.json ? "" : ", not JSON"} on page ${pages}` };
    items.push(...got.items);
    after = got.more ? got.next : null;
    if (after && items.length < cap) await pause(fp);
  } while (after && items.length < cap);
  return { items: items.slice(0, cap), pages };
}

export const instagramReels = defineFlow<ReelsInput, Reels>({
  site: "instagram",
  name: "reels",
  async run(fp, { username, max }) {
    const cap = Math.min(Math.max(1, max ?? 1000), 2000);
    await fp.open(`${WEB}/${encodeURIComponent(username)}/`);
    if (SIGNED_OUT.test(fp.url()))
      return fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
    const none = { username, urls: [], reels: [], scanned: 0, pages: 0 };
    if (MISSING.test(await fp.text())) return { ...none, found: false, source: "feed" };
    const feed = await byFeed(fp, username, cap);
    if (!("failed" in feed)) {
      const reels = feed.items.filter((i) => reelCodeOf(i));
      const urls = reels.map((i) => reelUrl(reelCodeOf(i) as string));
      return {
        username,
        found: true,
        source: "feed",
        urls,
        reels,
        scanned: feed.items.length,
        pages: feed.pages,
      };
    }
    await fp.open(`${WEB}/${encodeURIComponent(username)}/reels/`);
    const { rows } = await scrollCollect(fp, {
      read: async () =>
        postCodesOf(
          await fp.page.evaluate(() =>
            [...document.querySelectorAll('main a[href*="/reel/"]')].map(
              (a) => a.getAttribute("href") ?? "",
            ),
          ),
        ),
      key: (code) => code,
      max: cap,
      settleMs: 2_000,
    });
    return {
      ...none,
      found: true,
      source: "grid",
      urls: rows.map(reelUrl),
      scanned: rows.length,
      feedFailed: feed.failed,
    };
  },
});
