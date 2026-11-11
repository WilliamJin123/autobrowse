/**
 * Facebook's public pages, read signed out: never Wren's Meta login (it runs our ads, and
 * Meta bans accounts that scrape). Each route is a built walk on the owner's Mac
 * (`walks/fb-public/<name>.json`, a `records` op, designs/2026-10-05-records-and-ai-steps.md),
 * so call it on the desk. `GET /ads` is the Ad Library (a keyword, or one advertiser's ads), read
 * from the library page's own JSON (`browser/flows/fb-ad-library`). The Ad Library API only covers
 * political ads outside the EU, so this is the browser read. Groups: Meta removed the Groups API
 * in 2024. Signed out, a group's About reads whole and its feed shows only the featured post, but
 * a single post's page reads whole with its top comments, and Google indexes public posts: so
 * `GET /groups?q=` finds groups and posts through Google, then the About and post walks read them.
 */
import { z } from "zod";
import type { Serp } from "../browser/flows/google-search.js";
import type { WalkOutput } from "../walks/flow.js";
import { route, type SiteApi } from "./types.js";

const GROUP_URL =
  /^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/([\w.-]+)\/?(?:(?:posts|permalink)\/(\d+))?/;
const id = z.string().regex(/^[\w.-]{2,100}$/);

export interface GroupHit {
  group: string;
  /** As Google names the site: "Facebook · <group>". */
  name: string | null;
  url: string;
  posts: {
    post: string;
    url: string;
    title: string;
    snippet: string | null;
    shown: string | null;
  }[];
}

/** Google's results grouped by Facebook group, each with the public posts Google showed. */
export function groupsOf(serp: Serp): GroupHit[] {
  const by = new Map<string, GroupHit>();
  for (const r of serp.results) {
    const m = r.url?.match(GROUP_URL);
    if (!m || !r.url) continue;
    const group = m[1] as string;
    const hit = by.get(group) ?? {
      group,
      name: null,
      url: `https://www.facebook.com/groups/${group}/`,
      posts: [],
    };
    hit.name ??= r.site?.replace(/^Facebook\s*·\s*/, "").trim() || null;
    if (m[2])
      hit.posts.push({
        post: m[2],
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        shown: r.date ?? r.shown,
      });
    by.set(group, hit);
  }
  return [...by.values()];
}

const rowsOf = (o: unknown, as: string) => (o as WalkOutput).records[as] ?? [];

export const fbPublic: SiteApi = {
  site: "fb-public",
  origin: "https://www.facebook.com",
  auth: { open: true },
  signedOut: true,
  // 30 ads a result page; a person browsing the library doesn't load hundreds of pages a day.
  caps: { reads: 200, google: 100 },
  pace: { gapMs: 20_000, jitterMs: 20_000 },
  routes: [
    route({
      method: "GET",
      path: "/ads",
      standing: {
        final:
          "no API has a commercial ad shown outside the EU: Meta's Ad Library API gives political ads and EU-shown ads only (a first pass for those)",
      },
      summary:
        "Ad Library ads for keyword `q`, or all of one advertiser's ads (`page`: its page id, URL or username), in `country` (ISO or ALL, default US); running ads only unless `inactive`. Up to `max` (default 30, up to 600; 30 a result page). Each ad: Library ID, advertiser (id, name, page, likes), active, started, ended, daysRunning, platforms, versions (ads on the same creative), format, headline, body, CTA, link, shown domain, media (image URLs; video HD/SD URLs and posters), carousel cards, and the library's record whole (`raw`). Media URLs are signed and expire. `total` is the library's count. A browser leg: call it on the desk",
      request: z
        .object({
          q: z.string().trim().min(2).max(100).optional(),
          page: z.string().trim().min(2).max(300).optional(),
          country: z
            .string()
            .regex(/^([A-Z]{2}|ALL)$/)
            .default("US"),
          inactive: z.coerce.boolean().default(false),
          max: z.coerce.number().int().min(1).max(600).default(30),
        })
        .refine((o) => !!o.q !== !!o.page, { message: "give q or page, not both" }),
      // one read per result page, one more to find a page id from its URL
      meter: ({ max, page }) => ({
        reads: Math.ceil(max / 30) + (page && !/^\d+$/.test(page) ? 1 : 0),
      }),
      browser: { flow: "fb-public/ad-library" },
    }),
    route({
      method: "GET",
      path: "/groups",
      standing: { final: "Meta has no Groups API (closed 2024)" },
      summary:
        "Facebook groups about `q` through Google (`site:facebook.com/groups`, `n` results, default 10, up to 30): each group's id, name and link, with the public posts Google showed (link, title, snippet); `serp` is Google's whole page. A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(200),
        n: z.coerce.number().int().min(1).max(30).default(10),
      }),
      meter: ({ n }) => ({ google: Math.ceil(n / 10) }),
      browser: {
        flow: "web/google",
        input: ({ q, n }) => ({ q: `site:facebook.com/groups ${q}`, n }),
        output: (o) => ({ groups: groupsOf(o as Serp), serp: o }),
      },
    }),
    route({
      method: "GET",
      path: "/groups/{group}",
      standing: { final: "Meta has no Groups API (closed 2024)" },
      summary:
        "A group's About as a visitor sees it: name, privacy, members, the About text (cut where Facebook cuts it), place, created date, posts today and last month, total members, admins, and the panel's whole text (`all`). A private group shows this too. A browser leg: call it on the desk",
      request: z.object({ group: id }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-group-about",
        output: (o) => ({ about: rowsOf(o, "about")[0] ?? null }),
      },
    }),
    route({
      method: "GET",
      path: "/groups/{group}/posts/{post}",
      standing: { final: "Meta has no Groups API (closed 2024)" },
      summary:
        "One public group post as a visitor sees it: author (no profile link signed out), badge, time, Meta's AI title, text, reaction, comment and share counts, links out, the whole text (`all`); and the top comments shown (author, text, age, reactions). A browser leg: call it on the desk",
      request: z.object({ group: id, post: z.string().regex(/^\d{5,25}$/) }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-group-post",
        output: (o) => ({ post: rowsOf(o, "post")[0] ?? null, comments: rowsOf(o, "comments") }),
      },
    }),
    route({
      method: "GET",
      path: "/marketplace",
      standing: { final: "Meta has no Marketplace API for buyers" },
      summary:
        "Marketplace listings for `q` near `city` (a Marketplace city slug such as `nyc`, `la`, or a place id; default nyc): the first 15, each whole (title, price, location, photo, seller, delivery types). Signed out Facebook shows no more. A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(100),
        city: z
          .string()
          .regex(/^[\w-]{2,60}$/)
          .default("nyc"),
      }),
      meter: () => ({ reads: 1 }),
      browser: { flow: "fb-public/marketplace" },
      ported: "clis/facebook/marketplace-listings.js@9bc5f5c",
    }),
  ],
  setup: [],
};
