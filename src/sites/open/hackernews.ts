/**
 * Hacker News: the Firebase API (lists, items, users) and Algolia's search, no key, no stated
 * limit. Items whole as sent; a story read walks its comment tree to `depth`.
 * The `hn` browser profile and the `hn-search` workflow stay for signed-in acts.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, mapLimit, ported, qs } from "./kit.js";

const FB = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA = "https://hn.algolia.com/api/v1";
const AT_ONCE = 8;

export type Item = { id: number; kids?: number[]; deleted?: boolean; dead?: boolean } & Record<
  string,
  unknown
>;
export type Thread = Item & { replies: Thread[]; more: number };

const item = (leg: ApiLeg, id: number) =>
  getJson<Item>(leg.http, `${FB}/item/${id}.json`, { label: "hackernews /item" });

/**
 * A comment tree to `depth` (1: top comments only), `n` children a level. `more` counts the
 * children cut; deleted and dead ones are dropped, as the site hides them.
 */
export async function threadOf(
  get: (id: number) => Promise<Item | null>,
  root: Item,
  depth: number,
  n: number,
): Promise<Thread> {
  const kids = root.kids ?? [];
  if (depth <= 0) return { ...root, replies: [], more: kids.length };
  const got = await mapLimit(kids.slice(0, n), AT_ONCE, get);
  const live = got.filter((k): k is Item => !!k && !k.deleted && !k.dead);
  return {
    ...root,
    replies: await Promise.all(live.map((k) => threadOf(get, k, depth - 1, n))),
    more: Math.max(0, kids.length - n),
  };
}

/** What the site sends that callers read: checked on each answer (U2); the rest passes as sent. */
const ITEM = z.looseObject({ id: z.number(), type: z.string().optional() });
const HITS = z.looseObject({
  hits: z.array(z.looseObject({ objectID: z.string() })),
  nbHits: z.number(),
  page: z.number(),
});

const LISTS = { top: "top", new: "new", best: "best", ask: "ask", show: "show", job: "job" };

export const hackernews: SiteApi = {
  site: "hackernews",
  origin: FB,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/stories",
      summary:
        "A front list (`list` top|new|best|ask|show|job, `n` up to 100, `start`): each story whole, in the list's order",
      ported: ported("hackernews/top.js"),
      request: z.object({
        list: z.enum(["top", "new", "best", "ask", "show", "job"]).default("top"),
        n: z.coerce.number().int().min(1).max(100).default(30),
        start: z.coerce.number().int().min(0).default(0),
      }),
      response: z.looseObject({ total: z.number(), stories: z.array(ITEM) }),
      api: async ({ list, n, start }, leg) => {
        const ids =
          (await getJson<number[]>(leg.http, `${FB}/${LISTS[list]}stories.json`, {
            label: "hackernews /stories",
          })) ?? [];
        const stories = await mapLimit(ids.slice(start, start + n), AT_ONCE, (id) => item(leg, id));
        return { total: ids.length, start, stories: stories.filter((s): s is Item => s !== null) };
      },
    }),
    route({
      method: "GET",
      path: "/items/{id}",
      summary:
        "One item (story, comment, job, poll) whole with its comment tree: `depth` levels (0: none), `n` children a level, `more` counts what was cut; found false when gone",
      ported: ported("hackernews/read.js"),
      request: z.object({
        id: z.coerce.number().int().positive(),
        depth: z.coerce.number().int().min(0).max(10).default(2),
        n: z.coerce.number().int().min(1).max(200).default(30),
      }),
      api: async ({ id, depth, n }, leg) => {
        const root = await item(leg, id);
        if (!root) return { found: false, item: null };
        return { found: true, item: await threadOf((i) => item(leg, i), root, depth, n) };
      },
    }),
    route({
      method: "GET",
      path: "/users/{id}",
      summary:
        "One user whole (karma, about, created, `submitted` ids); found false when no such user",
      ported: ported("hackernews/user.js"),
      request: z.object({ id: z.string().min(1) }),
      response: z.looseObject({
        found: z.boolean(),
        user: z.looseObject({ id: z.string(), karma: z.number() }).nullable(),
      }),
      api: async ({ id }, leg) => {
        const user = await getJson(leg.http, `${FB}/user/${encodeURIComponent(id)}.json`, {
          label: "hackernews /user",
        });
        return user ? { found: true, user } : { found: false, user: null };
      },
    }),
    route({
      method: "GET",
      path: "/search",
      summary:
        "Algolia search (`q`; `sort` relevance|date; `tags` story|comment|ask_hn|show_hn|author_<name>|story_<id>, comma = and; `since` unix seconds; `n`, `page`): the answer whole, hits with their points and comment counts",
      ported: ported("hackernews/search.js"),
      request: z.object({
        q: z.string().default(""),
        sort: z.enum(["relevance", "date"]).default("relevance"),
        tags: z.string().default("story"),
        since: z.coerce.number().int().optional(),
        n: z.coerce.number().int().min(1).max(1000).default(20),
        page: z.coerce.number().int().min(0).default(0),
      }),
      response: HITS,
      api: ({ q, sort, tags, since, n, page }, leg) =>
        getJson(
          leg.http,
          `${ALGOLIA}/${sort === "date" ? "search_by_date" : "search"}?${qs({
            query: q,
            tags,
            numericFilters: since ? `created_at_i>${since}` : undefined,
            hitsPerPage: n,
            page,
          })}`,
          { label: "hackernews /search" },
        ),
    }),
  ],
};
