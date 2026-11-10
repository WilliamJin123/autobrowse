/**
 * OpenAlex, the open scholarly graph (works, authors, sources, institutions, topics).
 * No key: one shared $0.10 a day per IP; a search costs $0.001, a get by id 0 (11-09).
 * `OPENALEX_API_KEY` (free, $1 a day) is sent when set. Answers whole, `meta` with its cost.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://api.openalex.org";
const KINDS = [
  "works",
  "authors",
  "sources",
  "institutions",
  "topics",
  "publishers",
  "funders",
] as const;

/** A work's abstract as text, from OpenAlex's word → positions index. */
export function abstractOf(index: unknown): string | null {
  if (!index || typeof index !== "object") return null;
  const words: string[] = [];
  for (const [w, at] of Object.entries(index as Record<string, number[]>))
    for (const i of at) words[i] = w;
  return words.length ? words.filter((w) => w !== undefined).join(" ") : null;
}

/** Each work gains `abstract` (text) beside its inverted index. */
const withAbstract = (w: unknown) =>
  w && typeof w === "object" && "abstract_inverted_index" in w
    ? {
        ...w,
        abstract: abstractOf((w as { abstract_inverted_index: unknown }).abstract_inverted_index),
      }
    : w;

const call = (leg: ApiLeg, path: string, params: Record<string, string | number | undefined>) =>
  getJson<Record<string, unknown>>(
    leg.http,
    `${API}${path}?${qs({ ...params, api_key: leg.env("OPENALEX_API_KEY") })}`,
    { label: `openalex ${path}`, empty: [404] },
  );

const list = z.object({
  q: z.string().optional(),
  /** OpenAlex's filter syntax: `publication_year:2024,is_oa:true`. */
  filter: z.string().optional(),
  sort: z.string().optional(),
  n: z.coerce.number().int().min(1).max(200).default(25),
  /** `*` starts cursor paging; the answer's `meta.next_cursor` goes next. */
  cursor: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
});

export const openalex: SiteApi = {
  site: "openalex",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  // 90 searches a day fit the keyless $0.10; gets are free
  caps: { search: 90 },
  routes: [
    route({
      method: "GET",
      path: "/works",
      summary:
        "Works by search (`q`) and OpenAlex `filter`/`sort`, `n` up to 200, `page` or `cursor`: meta (count, cost) and each work whole, with `abstract` as text",
      ported: ported("openalex/search.js"),
      request: list,
      meter: () => ({ search: 1 }),
      api: async ({ q, filter, sort, n, cursor, page }, leg) => {
        const body = await call(leg, "/works", {
          search: q,
          filter,
          sort,
          "per-page": n,
          cursor,
          page,
        });
        return { ...body, results: ((body?.results as unknown[]) ?? []).map(withAbstract) };
      },
    }),
    route({
      method: "GET",
      path: "/works/{id}",
      summary:
        "One work by OpenAlex id (`W2741809807`), `doi:10.…`, `pmid:…` or a DOI URL: the work whole with `abstract`, or found false",
      ported: ported("openalex/work.js"),
      request: z.object({ id: z.string().min(1) }),
      api: async ({ id }, leg) => {
        const w = await call(leg, `/works/${encodeURIComponent(id)}`, {});
        return w ? { found: true, work: withAbstract(w) } : { found: false, work: null };
      },
    }),
    route({
      method: "GET",
      path: "/{kind}",
      summary: `Any other entity list (${KINDS.slice(1).join(", ")}) by search, filter and sort, like /works`,
      request: list.extend({ kind: z.enum(KINDS) }),
      meter: () => ({ search: 1 }),
      api: ({ kind, q, filter, sort, n, cursor, page }, leg) =>
        call(leg, `/${kind}`, { search: q, filter, sort, "per-page": n, cursor, page }),
    }),
    route({
      method: "GET",
      path: "/{kind}/{id}",
      summary: "Any one entity by id (`A5023888391`, an ORCID, a ROR): whole, or found false",
      request: z.object({ kind: z.enum(KINDS), id: z.string().min(1) }),
      api: async ({ kind, id }, leg) => {
        const e = await call(leg, `/${kind}/${encodeURIComponent(id)}`, {});
        return e ? { found: true, entity: e } : { found: false, entity: null };
      },
    }),
  ],
};
