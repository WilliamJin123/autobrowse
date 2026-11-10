/**
 * Substack's own JSON (the site's pages call it), no sign-in: search on substack.com, each
 * publication's archive and posts on its host. Answers whole; a paid post's body is cut by
 * the site. The reader's own inbox (OpenCLI `feed`) needs a sign-in: not here.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { flag, getJson, ported, qs } from "./kit.js";

const HOME = "https://substack.com/api/v1";
const GAP_MS = 500;

/** `lenny` → `lenny.substack.com`; a custom domain or full host stays. */
export const pubHost = (pub: string) => {
  const h = pub.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return h.includes(".") ? h : `${h}.substack.com`;
};

const get = (leg: ApiLeg, url: string, label: string) =>
  getJson<Record<string, unknown>>(leg.http, url, {
    label: `substack ${label}`,
    gapMs: GAP_MS,
    empty: [404],
  });

const pub = z.string().min(1);
const page = z.coerce.number().int().min(0).default(0);

export const substack: SiteApi = {
  site: "substack",
  origin: HOME,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/posts",
      summary:
        "Posts across Substack by words (`q`, `page` from 0): each post whole (title, byline, date, audience, canonical_url), `more` when a next page exists",
      ported: ported("substack/search.js"),
      request: z.object({ q: z.string().min(1), page }),
      api: ({ q, page }, leg) =>
        get(
          leg,
          `${HOME}/post/search?${qs({ query: q, page, includePlatformResults: true })}`,
          "/post/search",
        ),
    }),
    route({
      method: "GET",
      path: "/writers",
      summary:
        "Writers and their publications by words (`q`, `page` from 0): each profile whole, `primaryPublication` with its host and subscriber count",
      ported: ported("substack/search.js"),
      request: z.object({ q: z.string().min(1), page }),
      api: ({ q, page }, leg) =>
        get(leg, `${HOME}/profile/search?${qs({ query: q, page })}`, "/profile/search"),
    }),
    route({
      method: "GET",
      path: "/publications/{pub}/posts",
      summary:
        "A publication's archive (`pub`: subdomain or custom host; `sort` new|top; `n` up to 25; `cursor` from the last answer's nextCursor): each post whole",
      ported: ported("substack/publication.js"),
      request: z.object({
        pub,
        sort: z.enum(["new", "top"]).default("new"),
        n: z.coerce.number().int().min(1).max(25).default(25),
        cursor: z.string().optional(),
      }),
      api: async ({ pub, sort, n, cursor }, leg) =>
        (await get(
          leg,
          `https://${pubHost(pub)}/api/v1/archive?${qs({ sort, limit: n, cursor })}`,
          "/archive",
        )) ?? { posts: [], found: false },
    }),
    route({
      method: "GET",
      path: "/publications/{pub}/posts/{slug}",
      summary:
        "One post whole by slug (`body_html`; a paid post is cut by the site); `comments` true adds its comment tree; found false when gone",
      ported: ported("substack/publication.js"),
      request: z.object({
        pub,
        slug: z.string().regex(/^[\w-]+$/),
        comments: flag(false),
      }),
      api: async ({ pub, slug, comments }, leg) => {
        const base = `https://${pubHost(pub)}/api/v1`;
        const post = await get(leg, `${base}/posts/${slug}`, "/posts");
        if (!post || post.error) return { found: false, post: null };
        const tree = comments
          ? await get(
              leg,
              `${base}/post/${post.id}/comments?${qs({ all_comments: true, sort: "best_first" })}`,
              "/comments",
            )
          : null;
        return { found: true, post, ...(tree ? { comments: tree.comments ?? [] } : {}) };
      },
    }),
  ],
};
