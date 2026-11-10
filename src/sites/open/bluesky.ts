/**
 * Bluesky's public AppView (XRPC), no sign-in. Answers whole with their `cursor`.
 * Post search (`app.bsky.feed.searchPosts`) answers 403 signed out since 2025: not offered.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://public.api.bsky.app/xrpc";

const xrpc = (leg: ApiLeg, method: string, params: Record<string, string | number | undefined>) =>
  getJson(leg.http, `${API}/${method}?${qs(params)}`, {
    label: `bluesky ${method}`,
    // an unknown actor or post answers 400 with an error name
    empty: [400, 404],
  });

/** A post's bsky.app link (`/profile/<actor>/post/<rkey>`) as its at:// URI; a URI stays. */
export function postUri(ref: string): string {
  const m = ref.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  return m ? `at://${m[1]}/app.bsky.feed.post/${m[2]}` : ref;
}

const actor = z.string().min(1);
const n = z.coerce.number().int().min(1).max(100).default(50);
const cursor = z.string().optional();
const orMissing = (body: unknown, key: string) =>
  body ? { found: true, ...(body as object) } : { found: false, [key]: null };

export const bluesky: SiteApi = {
  site: "bluesky",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/profiles/{actor}",
      summary: "One profile whole by handle or DID (counts, bio, labels); found false when gone",
      ported: ported("bluesky/profile.js"),
      request: z.object({ actor }),
      api: async ({ actor }, leg) => {
        const p = await xrpc(leg, "app.bsky.actor.getProfile", { actor });
        return p ? { found: true, profile: p } : { found: false, profile: null };
      },
    }),
    route({
      method: "GET",
      path: "/profiles/{actor}/posts",
      summary:
        "An actor's feed (`filter` posts_with_replies|posts_no_replies|posts_with_media|posts_and_author_threads, `n`, `cursor`): each feed item whole",
      ported: ported("bluesky/user.js"),
      request: z.object({
        actor,
        filter: z
          .enum([
            "posts_with_replies",
            "posts_no_replies",
            "posts_with_media",
            "posts_and_author_threads",
          ])
          .default("posts_no_replies"),
        n,
        cursor,
      }),
      api: async ({ actor, filter, n, cursor }, leg) =>
        orMissing(
          await xrpc(leg, "app.bsky.feed.getAuthorFeed", { actor, filter, limit: n, cursor }),
          "feed",
        ),
    }),
    route({
      method: "GET",
      path: "/profiles/{actor}/followers",
      summary: "Who follows an actor (`n`, `cursor`)",
      ported: ported("bluesky/followers.js"),
      request: z.object({ actor, n, cursor }),
      api: async ({ actor, n, cursor }, leg) =>
        orMissing(
          await xrpc(leg, "app.bsky.graph.getFollowers", { actor, limit: n, cursor }),
          "followers",
        ),
    }),
    route({
      method: "GET",
      path: "/profiles/{actor}/follows",
      summary: "Whom an actor follows (`n`, `cursor`)",
      ported: ported("bluesky/following.js"),
      request: z.object({ actor, n, cursor }),
      api: async ({ actor, n, cursor }, leg) =>
        orMissing(
          await xrpc(leg, "app.bsky.graph.getFollows", { actor, limit: n, cursor }),
          "follows",
        ),
    }),
    route({
      method: "GET",
      path: "/profiles/{actor}/starter-packs",
      summary: "Starter packs an actor made (`n`, `cursor`)",
      ported: ported("bluesky/starter-packs.js"),
      request: z.object({ actor, n, cursor }),
      api: async ({ actor, n, cursor }, leg) =>
        orMissing(
          await xrpc(leg, "app.bsky.graph.getActorStarterPacks", { actor, limit: n, cursor }),
          "starterPacks",
        ),
    }),
    route({
      method: "GET",
      path: "/actors",
      summary: "Profiles by words (`q`, `n`, `cursor`)",
      ported: ported("bluesky/search.js"),
      request: z.object({ q: z.string().min(1), n: n.default(25), cursor }),
      api: ({ q, n, cursor }, leg) =>
        xrpc(leg, "app.bsky.actor.searchActors", { q, limit: n, cursor }),
    }),
    route({
      method: "GET",
      path: "/threads",
      summary:
        "One post with its replies and parents (`post`: an at:// URI or a bsky.app link; `depth`, `parents`); found false when gone",
      ported: ported("bluesky/thread.js"),
      request: z.object({
        post: z.string().min(1),
        depth: z.coerce.number().int().min(0).max(1000).default(6),
        parents: z.coerce.number().int().min(0).max(1000).default(80),
      }),
      api: async ({ post, depth, parents }, leg) =>
        orMissing(
          await xrpc(leg, "app.bsky.feed.getPostThread", {
            uri: postUri(post),
            depth,
            parentHeight: parents,
          }),
          "thread",
        ),
    }),
    route({
      method: "GET",
      path: "/feeds",
      summary: "Popular custom feeds, or those matching `q` (`n`, `cursor`)",
      ported: ported("bluesky/feeds.js"),
      request: z.object({ q: z.string().optional(), n, cursor }),
      api: ({ q, n, cursor }, leg) =>
        xrpc(leg, "app.bsky.unspecced.getPopularFeedGenerators", { query: q, limit: n, cursor }),
    }),
    route({
      method: "GET",
      path: "/trending",
      summary: "Trending topics and suggested ones, whole",
      ported: ported("bluesky/trending.js"),
      request: z.object({ n: z.coerce.number().int().min(1).max(25).default(10) }),
      api: ({ n }, leg) => xrpc(leg, "app.bsky.unspecced.getTrendingTopics", { limit: n }),
    }),
  ],
};
