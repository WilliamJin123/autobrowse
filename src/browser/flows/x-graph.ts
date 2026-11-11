/**
 * X reads off the page's own GraphQL answers (OpenCLI port; their commands call the same
 * operations). Mapped live 2026-11-10 as x@wren: `Bookmarks`, `Followers`/`Following`,
 * `CombinedLists`, `ExplorePage` + `GenericTimelineById` (trending), `TweetDetail`, `Likes`,
 * `ListLatestTweetsTimeline`. The page signs each call; the flow opens the page, keeps every
 * answer of the named operations while it scrolls, and returns each tweet, user, list or trend
 * whole (`tweet_results.result`, `user_results.result`, `list`, `trend`).
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { RungBroke } from "../ladder.js";
import { captureJson } from "../page-json.js";
import { scrollCollect } from "../scroll-collect.js";

const WEB = "https://x.com";
const SIGNED_OUT = /\/(i\/flow\/login|login)\b/;

export type Kind = "tweet" | "user" | "list" | "trend";

/** A GraphQL call of one of `ops`: `…/graphql/<queryId>/<Op>?…`. */
export const opsMatch = (ops: readonly string[]) =>
  new RegExp(`/graphql/[\\w-]+/(${ops.join("|")})(\\?|$)`);

/** Every object of `kind` in an answer, whole, by its id, in order. */
export function entitiesOf(
  body: unknown,
  kind: Kind,
  into = new Map<string, Record<string, unknown>>(),
): Map<string, Record<string, unknown>> {
  const put = (id: unknown, o: unknown) => {
    if ((typeof id === "string" || typeof id === "number") && o && !into.has(String(id)))
      into.set(String(id), o as Record<string, unknown>);
  };
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (kind === "tweet" && o.tweet_results && typeof o.tweet_results === "object") {
      let r = (o.tweet_results as { result?: Record<string, unknown> }).result;
      // A tweet with visibility results wraps the tweet one level down.
      if (r && r.__typename === "TweetWithVisibilityResults")
        r = r.tweet as Record<string, unknown>;
      if (r) put(r.rest_id, r);
    }
    if (kind === "user" && o.user_results && typeof o.user_results === "object") {
      const r = (o.user_results as { result?: Record<string, unknown> }).result;
      if (r) put(r.rest_id, r);
    }
    if (kind === "list" && o.list && typeof o.list === "object") {
      const l = o.list as Record<string, unknown>;
      put(l.id_str ?? l.id, l);
    }
    if (kind === "trend" && o.trend && typeof o.trend === "object") {
      const t = o.trend as Record<string, unknown>;
      put(t.name, t);
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(body);
  return into;
}

export interface Captured {
  /** Each entity whole, in the order the answers gave them. */
  items: Record<string, unknown>[];
  /** GraphQL answers kept. */
  calls: number;
}

/** Opens `url`, keeps answers of `ops` while scrolling, returns the entities of `kind`. */
export async function captureOps(
  fp: FlowPage,
  o: { url: string; ops: readonly string[]; kind: Kind; max: number; scroll?: boolean },
): Promise<Captured | "signed_out"> {
  const seen = new Map<string, Record<string, unknown>>();
  const { bodies } = await captureJson(fp, { match: opsMatch(o.ops) }, async (got) => {
    await fp.open(o.url);
    if (SIGNED_OUT.test(fp.url())) return;
    // The first answer comes with the load.
    for (let i = 0; i < 15 && !got.length; i++) await fp.wait(700);
    if (o.scroll === false) return;
    await scrollCollect(fp, {
      read: async () => {
        for (const b of got) entitiesOf(b, o.kind, seen);
        return [...seen.keys()];
      },
      key: (id) => id,
      max: o.max,
      settleMs: 1_800,
    });
  });
  if (SIGNED_OUT.test(fp.url())) return "signed_out";
  if (!bodies.length) throw new RungBroke(`no ${o.ops.join("/")} answer seen`);
  for (const b of bodies) entitiesOf(b, o.kind, seen);
  return { items: [...seen.values()].slice(0, o.max), calls: bodies.length };
}

const signedOut = (fp: FlowPage) =>
  fp.human("X is signed out on this profile: `autobrowse login x@<account>`");

const capOf = (max: number | undefined, def: number, most: number) =>
  Math.min(Math.max(1, max ?? def), most);

const handle = (u: string) => encodeURIComponent(u.replace(/^@/, ""));

async function read(fp: FlowPage, o: Parameters<typeof captureOps>[1]): Promise<Captured> {
  const c = await captureOps(fp, o);
  return c === "signed_out" ? signedOut(fp) : c;
}

/** A post with its replies as the conversation page shows them (`TweetDetail`). */
export const xThread = defineFlow<{ id: string; max?: number }, Captured>({
  site: "x",
  name: "thread",
  strategies: ["intercept"],
  run: (fp, { id, max }) =>
    read(fp, {
      url: `${WEB}/i/status/${encodeURIComponent(id)}`,
      ops: ["TweetDetail"],
      kind: "tweet",
      max: capOf(max, 50, 300),
    }),
});

/** An account's followers or follows (`Followers`, `Following`). */
export const xPeople = defineFlow<
  { username: string; list?: "followers" | "following"; max?: number },
  Captured
>({
  site: "x",
  name: "people",
  strategies: ["intercept"],
  run: (fp, { username, list, max }) => {
    const which = list ?? "followers";
    return read(fp, {
      url: `${WEB}/${handle(username)}/${which}`,
      ops: [which === "followers" ? "Followers" : "Following"],
      kind: "user",
      max: capOf(max, 100, 1000),
    });
  },
});

/** Posts an account liked; X shows likes to their owner only (`Likes`). */
export const xLikes = defineFlow<{ username: string; max?: number }, Captured>({
  site: "x",
  name: "likes",
  strategies: ["intercept"],
  run: (fp, { username, max }) =>
    read(fp, {
      url: `${WEB}/${handle(username)}/likes`,
      ops: ["Likes"],
      kind: "tweet",
      max: capOf(max, 50, 500),
    }),
});

/** Our bookmarks (`Bookmarks`). */
export const xBookmarks = defineFlow<{ max?: number }, Captured>({
  site: "x",
  name: "bookmarks",
  strategies: ["intercept"],
  run: (fp, { max }) =>
    read(fp, {
      url: `${WEB}/i/bookmarks`,
      ops: ["Bookmarks"],
      kind: "tweet",
      max: capOf(max, 50, 500),
    }),
});

/** An account's lists: its own and those it is on (`CombinedLists`). */
export const xLists = defineFlow<{ username: string; max?: number }, Captured>({
  site: "x",
  name: "lists",
  strategies: ["intercept"],
  run: (fp, { username, max }) =>
    read(fp, {
      url: `${WEB}/${handle(username)}/lists`,
      ops: ["CombinedLists", "ListsManagementPageTimeline"],
      kind: "list",
      max: capOf(max, 50, 300),
    }),
});

/** A list's latest posts (`ListLatestTweetsTimeline`). */
export const xListPosts = defineFlow<{ id: string; max?: number }, Captured>({
  site: "x",
  name: "list-posts",
  strategies: ["intercept"],
  run: (fp, { id, max }) =>
    read(fp, {
      url: `${WEB}/i/lists/${encodeURIComponent(id)}`,
      ops: ["ListLatestTweetsTimeline"],
      kind: "tweet",
      max: capOf(max, 50, 500),
    }),
});

/** What is trending for the signed-in account (`ExplorePage`, `GenericTimelineById`). */
export const xTrending = defineFlow<{ max?: number }, Captured>({
  site: "x",
  name: "trending",
  strategies: ["intercept"],
  run: (fp, { max }) =>
    read(fp, {
      url: `${WEB}/explore/tabs/trending`,
      ops: ["ExplorePage", "GenericTimelineById"],
      kind: "trend",
      max: capOf(max, 30, 100),
      scroll: false,
    }),
});
