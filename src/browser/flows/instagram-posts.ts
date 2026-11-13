/**
 * Every post of one Instagram account, all kinds (photo, video, carousel, reel), with its profile
 * user, read in the signed-in instagram profile (creator index, WA-1362). The reels route keeps
 * reels only; this keeps the whole grid.
 * Mapped live 2026-11-12: the profile page loads `PolarisProfilePageContentQuery` (`data.user`,
 * with `pk` and counts) and `PolarisProfilePostsQuery` (12 posts at `data.<connection>.edges[].node`,
 * each media whole: `media_type` 1 photo, 2 video, 8 carousel; `product_type` feed, clips,
 * carousel_container; `like_count`, `comment_count`, `view_count`, `reshare_count`). More come by
 * `PolarisProfilePostsTabContentQuery_connection`, 12 a page, once the last tile is in view; a
 * wheel past it fires no page. The page also loads the home timeline: posts are kept by owner.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { type Fell, ladder, RungBroke, type Strategy } from "../ladder.js";
import { captureJson } from "../page-json.js";
import { scrollCollect } from "../scroll-collect.js";
import { postCodesOf } from "./instagram-act.js";
import { pkOf, profileUserOf } from "./instagram-people.js";

const WEB = "https://www.instagram.com";
const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;
const GRAPHQL = /^https:\/\/www\.instagram\.com\/(api\/graphql|graphql\/query)\b/;
const TILES = 'main a[href*="/p/"], main a[href*="/reel/"]';

type Media = Record<string, unknown> & { code: string };

/** A grid answer's media, each whole: any `data.*` connection whose nodes carry `code` and `taken_at`. */
export function gridMedia(body: unknown): Media[] {
  const data = (body as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") return [];
  const out: Media[] = [];
  for (const c of Object.values(data)) {
    const edges = (c as { edges?: unknown })?.edges;
    if (!Array.isArray(edges)) continue;
    for (const e of edges) {
      const n = (e as { node?: Record<string, unknown> })?.node;
      if (n && typeof n.code === "string" && n.code && typeof n.taken_at === "number")
        out.push(n as Media);
    }
  }
  return out;
}

/** The media's owner or a co-author is `pk`; with no pk known, every media counts. */
export function ownedBy(m: Record<string, unknown>, pk: string | null): boolean {
  if (!pk) return true;
  const id = (u: unknown) => {
    const o = (u ?? {}) as { pk?: unknown; id?: unknown };
    const v = o.pk ?? o.id;
    return typeof v === "string" || typeof v === "number" ? String(v) : null;
  };
  if (id(m.user) === pk || id(m.owner) === pk) return true;
  const co = m.coauthor_producers;
  return Array.isArray(co) && co.some((u) => id(u) === pk);
}

/** Each media once by code, in arrival order, owned by `pk`. */
export function postsOf(bodies: readonly unknown[], pk: string | null): Media[] {
  const seen = new Map<string, Media>();
  for (const b of bodies)
    for (const m of gridMedia(b)) if (!seen.has(m.code) && ownedBy(m, pk)) seen.set(m.code, m);
  return [...seen.values()];
}

export const postUrl = (m: { code: string; product_type?: unknown }) =>
  `${WEB}/${m.product_type === "clips" ? "reel" : "p"}/${encodeURIComponent(m.code)}/`;

export interface PostsInput {
  username: string;
  /** Most posts, newest first after pinned ones. */
  max?: number;
}

export interface IgPosts {
  username: string;
  found: boolean;
  /** intercept: posts whole; ui: tile urls only. Absent when not found. */
  via?: Strategy;
  fell: Fell[];
  /** The profile query's `data.user`, whole: `pk`, `full_name`, `follower_count`; null from ui. */
  user: Record<string, unknown> | null;
  pk: string | null;
  /** Each media whole, every kind; empty from ui. */
  posts: unknown[];
  urls: string[];
  /** GraphQL answers seen. */
  pages: number;
}

/** The last tile into view: Instagram pages the grid on that, not on a wheel past it. */
const LAST_TILE = `(() => { const a = [...document.querySelectorAll(${JSON.stringify(TILES)})]; a.at(-1)?.scrollIntoView({ block: "end", behavior: "smooth" }); return a.length; })()`;
const TILE_HREFS = `[...document.querySelectorAll(${JSON.stringify(TILES)})].map((a) => a.getAttribute("href") ?? "")`;

type Got = Pick<IgPosts, "user" | "pk" | "posts" | "urls" | "pages">;

/** Signed out or no such account: the ladder stops, `run` answers. */
class NotRead extends Error {
  readonly why: "signed_out" | "missing";
  constructor(why: "signed_out" | "missing") {
    super(why);
    this.why = why;
  }
}

async function byGraphql(fp: FlowPage, username: string, cap: number): Promise<Got> {
  let user: Record<string, unknown> | null = null;
  const { bodies } = await captureJson(
    fp,
    { match: GRAPHQL, keep: (j) => profileUserOf(j, username) !== null || gridMedia(j).length > 0 },
    async (seen) => {
      // the grid's first answer comes with the load: the listener is on first
      await fp.open(`${WEB}/${encodeURIComponent(username)}/`);
      if (SIGNED_OUT.test(fp.url())) throw new NotRead("signed_out");
      if (MISSING.test(await fp.text())) throw new NotRead("missing");
      for (let i = 0; i < 12 && !seen.some((b) => gridMedia(b).length); i++) await fp.wait(700);
      const pkNow = () => {
        user ??= seen.map((b) => profileUserOf(b, username)).find(Boolean) ?? null;
        return user ? pkOf(user) : null;
      };
      await scrollCollect(fp, {
        read: async () => postsOf(seen, pkNow()),
        key: (m) => m.code,
        max: cap,
        scroll: async () => {
          await fp.page.evaluate(LAST_TILE);
        },
        settleMs: 2_000,
      });
      pkNow();
    },
  );
  const pk = user ? pkOf(user) : null;
  const posts = postsOf(bodies, pk).slice(0, cap);
  if (!posts.length && !bodies.some((b) => gridMedia(b).length))
    throw new RungBroke("no profile posts GraphQL answer seen");
  return { user, pk, posts, urls: posts.map(postUrl), pages: bodies.length };
}

async function byTiles(fp: FlowPage, cap: number): Promise<Got> {
  const { rows } = await scrollCollect(fp, {
    read: async () => postCodesOf((await fp.page.evaluate(TILE_HREFS)) as string[]),
    key: (code) => code,
    max: cap,
    scroll: async () => {
      await fp.page.evaluate(LAST_TILE);
    },
    settleMs: 2_000,
  });
  if (!rows.length) throw new RungBroke("no post tiles on the profile");
  return {
    user: null,
    pk: null,
    posts: [],
    urls: rows.map((c) => `${WEB}/p/${encodeURIComponent(c)}/`),
    pages: 0,
  };
}

export const instagramPosts = defineFlow<PostsInput, IgPosts>({
  site: "instagram",
  name: "posts",
  strategies: ["intercept", "ui"],
  async run(fp, { username, max }) {
    const name = username.replace(/^@/, "");
    const cap = Math.min(Math.max(1, max ?? 50), 500);
    // NotRead is not a RungBroke: the ladder stops at once, no ui rung
    const climbed = await ladder<Got>([
      { strategy: "intercept", run: () => byGraphql(fp, name, cap) },
      { strategy: "ui", run: () => byTiles(fp, cap) },
    ]).catch((e) => {
      if (e instanceof NotRead) return e;
      throw e;
    });
    if (climbed instanceof NotRead) {
      if (climbed.why === "signed_out")
        return fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
      const none = { user: null, pk: null, posts: [], urls: [], pages: 0 };
      return { username: name, found: false, fell: [], ...none };
    }
    const { value, via, fell } = climbed;
    return { username: name, found: true, via, fell, ...value };
  },
});
