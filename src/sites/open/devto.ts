/**
 * DEV (dev.to, Forem) public API, no key. Lists give each article's summary; one article
 * adds its body (`body_markdown`, `body_html`). Comments come as a tree (`children`).
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://dev.to/api";
// Forem throttles bursts; a small gap keeps a list walk under it
const GAP_MS = 300;

const get = (leg: ApiLeg, path: string, params: Record<string, string | number | undefined> = {}) =>
  getJson(leg.http, `${API}${path}${Object.keys(params).length ? `?${qs(params)}` : ""}`, {
    label: `devto ${path}`,
    gapMs: GAP_MS,
    empty: [404],
  });

const comments = z.enum(["true", "false"]).default("false");

async function article(leg: ApiLeg, path: string, comments: "true" | "false") {
  const found = (await get(leg, path)) as { id?: number } | null;
  if (!found) return { found: false, article: null };
  const tree =
    comments === "true" && found.id ? await get(leg, "/comments", { a_id: found.id }) : undefined;
  return { found: true, article: found, ...(tree ? { comments: tree } : {}) };
}

export const devto: SiteApi = {
  site: "devto",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/articles",
      summary:
        "Articles: `tag`, `username`, `top` (most liked in the last N days), `state` fresh|rising, `n` up to 1000, `page`; each article's summary whole",
      ported: ported("devto/top.js"),
      request: z.object({
        tag: z.string().optional(),
        username: z.string().optional(),
        top: z.coerce.number().int().min(1).optional(),
        state: z.enum(["fresh", "rising"]).optional(),
        n: z.coerce.number().int().min(1).max(1000).default(30),
        page: z.coerce.number().int().min(1).default(1),
      }),
      api: async ({ tag, username, top, state, n, page }, leg) =>
        (await get(leg, "/articles", { tag, username, top, state, per_page: n, page })) ?? [],
    }),
    route({
      method: "GET",
      path: "/articles/{id}",
      summary:
        "One article whole with its body, by numeric id; `comments` true adds the comment tree; found false when gone",
      ported: ported("devto/read.js"),
      request: z.object({ id: z.coerce.number().int().positive(), comments }),
      api: ({ id, comments }, leg) => article(leg, `/articles/${id}`, comments),
    }),
    route({
      method: "GET",
      path: "/articles/{username}/{slug}",
      summary: "One article by its path (`ben/my-post-1abc`), like /articles/{id}",
      ported: ported("devto/read.js"),
      request: z.object({
        username: z.string().regex(/^[\w-]+$/),
        slug: z.string().regex(/^[\w-]+$/),
        comments,
      }),
      api: ({ username, slug, comments }, leg) =>
        article(leg, `/articles/${username}/${slug}`, comments),
    }),
    route({
      method: "GET",
      path: "/users/{username}",
      summary: "One user or organization profile whole; found false when gone",
      ported: ported("devto/user.js"),
      request: z.object({ username: z.string().min(1) }),
      api: async ({ username }, leg) => {
        const user = await get(leg, "/users/by_username", { url: username });
        return user ? { found: true, user } : { found: false, user: null };
      },
    }),
    route({
      method: "GET",
      path: "/tags",
      summary: "Popular tags (`n`, `page`)",
      ported: ported("devto/tag.js"),
      request: z.object({
        n: z.coerce.number().int().min(1).max(1000).default(30),
        page: z.coerce.number().int().min(1).default(1),
      }),
      api: async ({ n, page }, leg) => (await get(leg, "/tags", { per_page: n, page })) ?? [],
    }),
  ],
};
