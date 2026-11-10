/**
 * Lobsters: every page has a `.json` twin, no key. Stories and comments whole as sent;
 * a story's comments come flat, each with `depth` and `parent_comment`.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported } from "./kit.js";

const SITE = "https://lobste.rs";
// lobste.rs asks crawlers to go slow
const GAP_MS = 1_000;

const json = (leg: ApiLeg, path: string) =>
  getJson(leg.http, `${SITE}${path}.json`, {
    label: `lobsters ${path}`,
    gapMs: GAP_MS,
    empty: [404],
  });

/** `/hottest` page 1 is `/hottest`, page 2 `/page/2`; others gain `/page/N`. */
export const pagePath = (base: string, page: number) =>
  page <= 1 ? base : base === "/hottest" ? `/page/${page}` : `${base}/page/${page}`;

const page = z.coerce.number().int().min(1).default(1);
const stories = (leg: ApiLeg, path: string) => json(leg, path).then((s) => s ?? []);

export const lobsters: SiteApi = {
  site: "lobsters",
  origin: SITE,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/stories",
      summary: "A front list (`list` hottest|newest|active, `page`, 25 a page): each story whole",
      ported: ported("lobsters/hot.js"),
      request: z.object({
        list: z.enum(["hottest", "newest", "active"]).default("hottest"),
        page,
      }),
      api: ({ list, page }, leg) => stories(leg, pagePath(`/${list}`, page)),
    }),
    route({
      method: "GET",
      path: "/stories/{id}",
      summary:
        "One story by short id (`abc123`) whole with its comments (flat, `depth` and `parent_comment` on each); found false when gone",
      ported: ported("lobsters/read.js"),
      request: z.object({ id: z.string().regex(/^[a-z0-9]+$/) }),
      api: async ({ id }, leg) => {
        const story = await json(leg, `/s/${id}`);
        return story ? { found: true, story } : { found: false, story: null };
      },
    }),
    route({
      method: "GET",
      path: "/tags/{tag}",
      summary: "Stories with a tag (`rust`, or `rust,go` for either), `page`",
      ported: ported("lobsters/tag.js"),
      request: z.object({ tag: z.string().regex(/^[a-z0-9_.,+-]+$/), page }),
      api: ({ tag, page }, leg) => stories(leg, pagePath(`/t/${tag}`, page)),
    }),
    route({
      method: "GET",
      path: "/domains/{domain}",
      summary: "Stories linking to a domain (`github.com`), `page`",
      ported: ported("lobsters/domain.js"),
      request: z.object({ domain: z.string().min(3), page }),
      api: ({ domain, page }, leg) =>
        stories(leg, pagePath(`/domains/${encodeURIComponent(domain)}`, page)),
    }),
    route({
      method: "GET",
      path: "/users/{name}",
      summary: "One user whole (about, karma, invited by, links); found false when gone",
      request: z.object({ name: z.string().min(1) }),
      api: async ({ name }, leg) => {
        const user = await json(leg, `/~${encodeURIComponent(name)}`);
        return user ? { found: true, user } : { found: false, user: null };
      },
    }),
  ],
};
