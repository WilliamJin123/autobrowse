/**
 * X reads off the page's own GraphQL answers (OpenCLI port; their commands call the same
 * operations). Mapped live 2026-11-10 as x@wren: `Bookmarks`, `Followers`/`Following`,
 * `CombinedLists`, `ExplorePage` + `GenericTimelineById` (trending), `TweetDetail`, `Likes`,
 * `ListLatestTweetsTimeline`; `UserOriginalsTimeline` (11-12; `UserTweets` before) + `UserByScreenName` (a profile's posts, WA-1362). The page signs each call; the flow opens the page, keeps every
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

/** To the page's foot: X's list is virtual (only cells near the screen exist) but sized for every loaded post, so the foot is where it asks for the next page. */
const TO_FOOT = `scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })`;

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
    if (kind === "trend") {
      // `TimelineTrend` items carry the name on themselves; older answers nest a `trend`.
      if (o.__typename === "TimelineTrend") put(o.name, o);
      else if (o.trend && typeof o.trend === "object") {
        const t = o.trend as Record<string, unknown>;
        put(t.name, t);
      }
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
): Promise<(Captured & { bodies: unknown[]; ops: string[] }) | "signed_out"> {
  const seen = new Map<string, Record<string, unknown>>();
  // what came instead, for the miss message
  const ops = new Set<string>();
  const onAny = (r: { url(): string; status(): number }) => {
    const op = /\/graphql\/[^/]+\/(\w+)/.exec(r.url())?.[1];
    if (op) ops.add(`${op} ${r.status()}`);
  };
  fp.page.on("response", onAny);
  const { bodies } = await captureJson(fp, { match: opsMatch(o.ops) }, async (got) => {
    await fp.open(o.url);
    if (SIGNED_OUT.test(fp.url())) return;
    // first answer holding `kind`: another op (UserByScreenName) can land first
    const has = () => got.some((b) => entitiesOf(b, o.kind).size > 0);
    for (let i = 0; i < 15 && !has(); i++) await fp.wait(700);
    // same profile twice in one tab: X renders from memory, no call; a reload asks again
    if (!has()) {
      await fp.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      for (let i = 0; i < 15 && !has(); i++) await fp.wait(700);
    }
    if (o.scroll === false) return;
    await scrollCollect(fp, {
      read: async () => {
        for (const b of got) entitiesOf(b, o.kind, seen);
        return [...seen.keys()];
      },
      key: (id) => id,
      max: o.max,
      // one answer is ~20 tall cells: screen-sized steps go idle before the next page loads
      scroll: async () => {
        await fp.page.evaluate(TO_FOOT).catch(() => undefined);
      },
      settleMs: 1_800,
    });
  }).finally(() => fp.page.off("response", onAny));
  if (SIGNED_OUT.test(fp.url())) return "signed_out";
  if (!bodies.length)
    throw new RungBroke(
      `no ${o.ops.join("/")} answer seen (calls: ${[...ops].join(", ") || "none"}; ${fp.url()})`,
    );
  for (const b of bodies) entitiesOf(b, o.kind, seen);
  return {
    items: [...seen.values()].slice(0, o.max),
    calls: bodies.length,
    bodies,
    ops: [...ops],
  };
}

const signedOut = (fp: FlowPage) =>
  fp.human("X is signed out on this profile: `autobrowse login x@<account>`");

const capOf = (max: number | undefined, def: number, most: number) =>
  Math.min(Math.max(1, max ?? def), most);

const handle = (u: string) => encodeURIComponent(u.replace(/^@/, ""));

async function read(fp: FlowPage, o: Parameters<typeof captureOps>[1]): Promise<Captured> {
  const c = await captureOps(fp, o);
  return c === "signed_out" ? signedOut(fp) : { items: c.items, calls: c.calls };
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

/** The signed-in account's handle, off the side bar's profile link. */
const OWN_HANDLE = `(() => {
  const h = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href");
  return h ? h.replace(/^\\//, "") : null;
})()`;

/** Posts the signed-in account liked (`Likes`): X shows likes to their owner only. */
export const xLikes = defineFlow<{ max?: number }, Captured>({
  site: "x",
  name: "likes",
  strategies: ["intercept"],
  async run(fp, { max }) {
    await fp.open(`${WEB}/home`);
    if (SIGNED_OUT.test(fp.url())) return signedOut(fp);
    const own = (await fp.page.evaluate(OWN_HANDLE).catch(() => null)) as string | null;
    if (!own) throw new RungBroke("no profile link in the side bar");
    return read(fp, {
      url: `${WEB}/${handle(own)}/likes`,
      ops: ["Likes"],
      kind: "tweet",
      max: capOf(max, 50, 500),
    });
  },
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

/** The user of `handle` among the answers' users (`core.screen_name`, older `legacy.screen_name`). */
export function userNamed(
  bodies: readonly unknown[],
  handle: string,
): Record<string, unknown> | null {
  const want = handle.replace(/^@/, "").toLowerCase();
  // UserByScreenName (`data.user.result`) first: tweet authors may carry less
  const profiles = bodies
    .map((b) => (b as { data?: { user?: { result?: unknown } } } | null)?.data?.user?.result)
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const users = new Map<string, Record<string, unknown>>();
  for (const b of bodies) entitiesOf(b, "user", users);
  for (const u of [...profiles, ...users.values()]) {
    const { core, legacy } = u as {
      core?: { screen_name?: unknown };
      legacy?: { screen_name?: unknown };
    };
    const name = core?.screen_name ?? legacy?.screen_name;
    if (typeof name === "string" && name.toLowerCase() === want) return u;
  }
  return null;
}

export interface UserPosts extends Captured {
  username: string;
  /** False: no such account (no user in the answers, no posts). */
  found: boolean;
  /** The profile user whole (`UserByScreenName`'s `data.user.result`): `rest_id`, followers in `relationship_counts.followers` (11-12; `legacy` before). */
  user: Record<string, unknown> | null;
  /** GraphQL calls the page made, `<op> <status>`. */
  seen: string[];
}

/** One account's posts as its profile page lists them (`UserOriginalsTimeline`, `UserTweets` before 11-12), newest first after a pinned post; retweets are kept whole. */
export const xUserPosts = defineFlow<{ username: string; max?: number }, UserPosts>({
  site: "x",
  name: "user-posts",
  strategies: ["intercept"],
  async run(fp, { username, max }) {
    const name = username.replace(/^@/, "");
    const c = await captureOps(fp, {
      url: `${WEB}/${handle(name)}`,
      ops: ["UserOriginalsTimeline", "UserTweets", "UserByScreenName"],
      kind: "tweet",
      max: capOf(max, 50, 300),
    });
    if (c === "signed_out") return signedOut(fp);
    const user = userNamed(c.bodies, name);
    return {
      username: name,
      found: user !== null || c.items.length > 0,
      user,
      items: c.items,
      calls: c.calls,
      // GraphQL calls the page made: tells empty or short from renamed
      seen: c.ops,
    };
  },
});

/** Trend cells' lines (rank and place, name, posts) when no answer carried trends. */
const TREND_CELLS = `[...document.querySelectorAll('[data-testid="trend"]')].map((c) =>
  [...c.querySelectorAll('div[dir="ltr"]')].map((d) => d.textContent.trim()).filter(Boolean))`;

/** What is trending for the signed-in account (`ExplorePage`, `GenericTimelineById`). */
export const xTrending = defineFlow<{ max?: number }, Captured & { cells?: string[][] }>({
  site: "x",
  name: "trending",
  strategies: ["intercept", "ui"],
  async run(fp, { max }) {
    const cap = capOf(max, 30, 100);
    const got = await read(fp, {
      url: `${WEB}/explore/tabs/trending`,
      ops: ["ExplorePage", "GenericTimelineById"],
      kind: "trend",
      max: cap,
      scroll: false,
    });
    if (got.items.length) return got;
    const cells = ((await fp.page.evaluate(TREND_CELLS).catch(() => [])) as string[][]).slice(
      0,
      cap,
    );
    return { ...got, cells };
  },
});
