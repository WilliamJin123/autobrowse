/**
 * Wikipedia (MediaWiki action API + REST v1) and Wikidata, no key. Any language edition by
 * `lang`. Answers whole; Wikimedia asks for a named User-Agent, which the kit sends.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const lang = z
  .string()
  .regex(/^[a-z][a-z-]{1,15}$/)
  .default("en");
const wp = (l: string) => `https://${l}.wikipedia.org`;
const n = z.coerce.number().int().min(1).max(500).default(20);

export const wikipedia: SiteApi = {
  site: "wikipedia",
  origin: "https://en.wikipedia.org",
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Articles by words (`q`, `n`, `offset`, `lang`): total and each hit whole (title, snippet, size, words, timestamp)",
      ported: ported("wikipedia/search.js"),
      request: z.object({
        q: z.string().min(1),
        n,
        offset: z.coerce.number().int().min(0).default(0),
        lang,
      }),
      api: async ({ q, n, offset, lang }, leg) => {
        const body = await getJson<{
          query?: { searchinfo?: { totalhits?: number }; search?: unknown[] };
        }>(
          leg.http,
          `${wp(lang)}/w/api.php?${qs({ action: "query", list: "search", srsearch: q, srlimit: n, sroffset: offset, format: "json", formatversion: 2 })}`,
          { label: "wikipedia search" },
        );
        return { total: body?.query?.searchinfo?.totalhits ?? 0, hits: body?.query?.search ?? [] };
      },
    }),
    route({
      method: "GET",
      path: "/pages/{title}",
      summary:
        "One article's whole plain text, description, url and page info (`lang`; follows redirects), or found false",
      ported: ported("wikipedia/page.js"),
      request: z.object({ title: z.string().min(1), lang }),
      api: async ({ title, lang }, leg) => {
        const body = await getJson<{ query?: { pages?: Array<Record<string, unknown>> } }>(
          leg.http,
          `${wp(lang)}/w/api.php?${qs({ action: "query", prop: "extracts|info|description|pageprops", inprop: "url", explaintext: 1, redirects: 1, titles: title, format: "json", formatversion: 2 })}`,
          { label: "wikipedia page" },
        );
        const page = body?.query?.pages?.[0];
        return page && !page.missing ? { found: true, page } : { found: false, page: null };
      },
    }),
    route({
      method: "GET",
      path: "/pages/{title}/summary",
      summary:
        "One article's REST summary whole: extract, description, thumbnail, Wikidata id (`lang`), or found false",
      ported: ported("wikipedia/summary.js"),
      request: z.object({ title: z.string().min(1), lang }),
      api: async ({ title, lang }, leg) => {
        const s = await getJson(
          leg.http,
          `${wp(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
          { label: "wikipedia summary", empty: [404] },
        );
        return s ? { found: true, summary: s } : { found: false, summary: null };
      },
    }),
    route({
      method: "GET",
      path: "/featured",
      summary:
        "A day's featured feed whole (`date` YYYY-MM-DD, default today UTC; `lang`): most read, featured article, news, on this day, picture",
      ported: ported("wikipedia/trending.js"),
      request: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        lang,
      }),
      api: ({ date, lang }, leg) => {
        const d = (date ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "/");
        return getJson(leg.http, `${wp(lang)}/api/rest_v1/feed/featured/${d}`, {
          label: "wikipedia featured",
        });
      },
    }),
    route({
      method: "GET",
      path: "/random",
      summary: "A random article's REST summary whole (`lang`)",
      ported: ported("wikipedia/random.js"),
      request: z.object({ lang }),
      api: ({ lang }, leg) =>
        getJson(leg.http, `${wp(lang)}/api/rest_v1/page/random/summary`, {
          label: "wikipedia random",
        }),
    }),
  ],
};

const WD = "https://www.wikidata.org";

export const wikidata: SiteApi = {
  site: "wikidata",
  origin: WD,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Entities by label (`q`, `n` up to 50, `type` item|property|lexeme, `lang`): each match whole (id, label, description, aliases)",
      ported: ported("wikidata/search.js"),
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(50).default(10),
        type: z.enum(["item", "property", "lexeme"]).default("item"),
        lang,
      }),
      api: async ({ q, n, type, lang }, leg) => {
        const body = await getJson<{ search?: unknown[] }>(
          leg.http,
          `${WD}/w/api.php?${qs({ action: "wbsearchentities", search: q, limit: n, type, language: lang, uselang: lang, format: "json" })}`,
          { label: "wikidata search" },
        );
        return { matches: body?.search ?? [] };
      },
    }),
    route({
      method: "GET",
      path: "/entities/{id}",
      summary: "One entity whole (`Q42`, `P31`): every label, claim and sitelink, or found false",
      ported: ported("wikidata/entity.js"),
      request: z.object({ id: z.string().regex(/^[QPL]\d+$/i) }),
      api: async ({ id }, leg) => {
        const body = await getJson<{ entities?: Record<string, unknown> }>(
          leg.http,
          `${WD}/wiki/Special:EntityData/${encodeURIComponent(id.toUpperCase())}.json`,
          { label: "wikidata entity", empty: [404] },
        );
        // a redirected id answers under its new id
        const entity = body?.entities ? Object.values(body.entities)[0] : null;
        return entity ? { found: true, entity } : { found: false, entity: null };
      },
    }),
  ],
};
