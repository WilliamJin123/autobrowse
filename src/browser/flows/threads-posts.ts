/**
 * One Threads account's posts, each whole, with its profile user, read on the instagram profile
 * (Threads signs in through Instagram; the Threads API reads only our own account). Creator
 * index, WA-1362. Mapped live 2026-11-12:
 * - The first page comes in the HTML: a `script[type="application/json"]` holds `result.data`
 *   with `mediaData.edges[].node.thread_items[].post` and `user` (`pk`, `full_name`,
 *   `follower_count`).
 * - More come by `BarcelonaProfileThreadsTabRefetchableDirectQuery` (`data.mediaData`, same shape)
 *   as the window scrolls.
 * - A post: `code`, `taken_at`, `media_type`, `like_count`, and `text_post_app_info` with
 *   `direct_reply_count`, `repost_count`, `quote_count`, `reshare_count`. No view count: Threads
 *   shows views to the owner only.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { RungBroke } from "../ladder.js";
import { captureJson } from "../page-json.js";
import { scrollCollect } from "../scroll-collect.js";

const WEB = "https://www.threads.com";
const GRAPHQL = /^https:\/\/www\.threads\.com\/(api\/graphql|graphql\/query)\b/;
const TO_FOOT = `scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })`;
const MISSING = /sorry, this page isn.t available|this profile isn.t available/i;

type Post = Record<string, unknown> & { code: string };

/** The page's JSON scripts that hold posts or the profile user, parsed; a bad one is left. */
const PAGE_DATA = `[...document.querySelectorAll('script[type="application/json"]')]
  .filter((s) => s.textContent.includes('"mediaData"') || s.textContent.includes('"follower_count"'))
  .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
  .filter(Boolean)`;

/** Every `mediaData` connection and `data.user` in a tree (an HTML payload or a GraphQL answer). */
function walkData(
  v: unknown,
  on: (o: { mediaData?: unknown; user?: unknown }) => void,
  depth = 0,
): void {
  if (!v || typeof v !== "object" || depth > 40) return;
  if (Array.isArray(v)) {
    for (const x of v) walkData(x, on, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if ("mediaData" in o || "user" in o) on(o);
  for (const x of Object.values(o)) walkData(x, on, depth + 1);
}

/** The posts of `username` in the trees, each once by code, in order; a thread's own chain counts. */
export function threadsPostsOf(trees: readonly unknown[], username: string): Post[] {
  const want = username.toLowerCase();
  const seen = new Map<string, Post>();
  for (const t of trees)
    walkData(t, (o) => {
      const edges = (o.mediaData as { edges?: unknown })?.edges;
      if (!Array.isArray(edges)) return;
      for (const e of edges) {
        const items = (e as { node?: { thread_items?: unknown } })?.node?.thread_items;
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const p = (it as { post?: Record<string, unknown> })?.post;
          const by = (p?.user as { username?: unknown } | undefined)?.username;
          if (
            p &&
            typeof p.code === "string" &&
            p.code &&
            typeof by === "string" &&
            by.toLowerCase() === want &&
            !seen.has(p.code)
          )
            seen.set(p.code, p as Post);
        }
      }
    });
  return [...seen.values()];
}

/** The profile user of `username`: the `user` with that name and a follower count. */
export function threadsUserOf(
  trees: readonly unknown[],
  username: string,
): Record<string, unknown> | null {
  const want = username.toLowerCase();
  let found: Record<string, unknown> | null = null;
  for (const t of trees)
    walkData(t, (o) => {
      const u = o.user as Record<string, unknown> | undefined;
      if (
        !found &&
        u &&
        typeof u.username === "string" &&
        u.username.toLowerCase() === want &&
        "follower_count" in u
      )
        found = u;
    });
  return found;
}

export interface ThreadsPostsInput {
  username: string;
  /** Most posts, newest first after a pinned one. */
  max?: number;
}

export interface ThreadsPosts {
  username: string;
  found: boolean;
  /** The profile user whole: `pk`, `full_name`, `follower_count`. */
  user: Record<string, unknown> | null;
  pk: string | null;
  /** Each post whole. */
  posts: unknown[];
  /** GraphQL pages past the first (the first is in the HTML). */
  pages: number;
}

async function read(fp: FlowPage, username: string, cap: number): Promise<ThreadsPosts> {
  const none = { username, user: null, pk: null, posts: [], pages: 0 };
  let html: unknown[] = [];
  let gone = false;
  const { bodies } = await captureJson(
    fp,
    { match: GRAPHQL, keep: (j) => threadsPostsOf([j], username).length > 0 },
    async (seen) => {
      await fp.open(`${WEB}/@${encodeURIComponent(username)}`);
      if (/\/login\b/.test(fp.url()))
        fp.human("Threads is signed out on this profile: `autobrowse login instagram`");
      if (MISSING.test(await fp.text())) {
        gone = true;
        return;
      }
      html = (await fp.page.evaluate(PAGE_DATA).catch(() => [])) as unknown[];
      await scrollCollect(fp, {
        read: async () => threadsPostsOf([...html, ...seen], username),
        key: (p) => p.code,
        max: cap,
        // a page of posts is many screens: screen-sized steps go idle before the next loads
        scroll: async () => {
          await fp.page.evaluate(TO_FOOT).catch(() => undefined);
        },
        settleMs: 2_500,
      });
    },
  );
  if (gone) return { ...none, found: false };
  const trees = [...html, ...bodies];
  const user = threadsUserOf(trees, username);
  const posts = threadsPostsOf(trees, username).slice(0, cap);
  if (!user && !posts.length) throw new RungBroke("no profile data in the page or its GraphQL");
  const pk = user?.pk ?? user?.id;
  return {
    username,
    found: true,
    user,
    pk: typeof pk === "string" || typeof pk === "number" ? String(pk) : null,
    posts,
    pages: bodies.length,
  };
}

export const threadsPosts = defineFlow<ThreadsPostsInput, ThreadsPosts>({
  site: "instagram",
  name: "threads-posts",
  strategies: ["intercept"],
  run: (fp, { username, max }) =>
    read(fp, username.replace(/^@/, ""), Math.min(Math.max(1, max ?? 50), 300)),
});
