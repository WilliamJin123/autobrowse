/**
 * arXiv's query API (Atom XML), no key. arXiv asks for 3 s between calls.
 * Each paper is the Atom entry whole; `author`, `link` and `category` always lists.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { getText, listOf, parseXml, ported, qs } from "./kit.js";

const API = "https://export.arxiv.org/api/query";
const GAP_MS = 3_000;

const SORT = { relevance: "relevance", submitted: "submittedDate", updated: "lastUpdatedDate" };

export interface ArxivPage {
  total: number;
  start: number;
  papers: Array<Record<string, unknown> & { arxivId: string }>;
}

/** `http://arxiv.org/abs/2201.00978v1` → `2201.00978v1`. */
export const arxivIdOf = (id: unknown): string =>
  String(id ?? "").replace(/^https?:\/\/arxiv\.org\/abs\//, "");

export function arxivFeed(xml: string): ArxivPage {
  const feed = (parseXml(xml).feed ?? {}) as Record<string, unknown>;
  const papers = listOf<Record<string, unknown>>(feed.entry)
    // an unknown id answers one entry titled "Error"
    .filter((e) => e.title !== "Error")
    .map((e) => ({
      ...e,
      arxivId: arxivIdOf(e.id),
      author: listOf(e.author),
      link: listOf(e.link),
      category: listOf(e.category),
    }));
  return {
    total: Number(feed["opensearch:totalResults"] ?? papers.length),
    start: Number(feed["opensearch:startIndex"] ?? 0),
    papers,
  };
}

const query = async (
  http: Parameters<typeof getText>[0],
  params: Record<string, string | number | undefined>,
) =>
  arxivFeed((await getText(http, `${API}?${qs(params)}`, { label: "arxiv", gapMs: GAP_MS })) ?? "");

const n = z.coerce.number().int().min(1).max(200).default(20);
const start = z.coerce.number().int().min(0).default(0);

export const arxiv: SiteApi = {
  site: "arxiv",
  origin: "https://export.arxiv.org",
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Papers by query (`q`: words, or arXiv's syntax like `ti:diffusion AND cat:cs.CV`; `n`, `start`, `sort` relevance|submitted|updated): total and each Atom entry whole",
      ported: ported("arxiv/search.js"),
      request: z.object({
        q: z.string().min(1),
        n,
        start,
        sort: z.enum(["relevance", "submitted", "updated"]).default("relevance"),
      }),
      api: ({ q, n, start, sort }, leg) =>
        query(leg.http, {
          search_query: /\w:/.test(q) ? q : `all:${q}`,
          start,
          max_results: n,
          sortBy: SORT[sort],
          sortOrder: "descending",
        }),
    }),
    route({
      method: "GET",
      path: "/papers/{id}",
      summary:
        "One paper by arXiv id (`2201.00978` or with its version): the Atom entry whole, or found false",
      ported: ported("arxiv/paper.js"),
      request: z.object({ id: z.string().min(1) }),
      api: async ({ id }, leg) => {
        const { papers } = await query(leg.http, { id_list: id });
        return papers[0] ? { found: true, paper: papers[0] } : { found: false, paper: null };
      },
    }),
    route({
      method: "GET",
      path: "/recent",
      summary: "Newest papers in a category (`category` like `cs.AI`, `n`, `start`)",
      ported: ported("arxiv/recent.js"),
      request: z.object({ category: z.string().min(1), n, start }),
      api: ({ category, n, start }, leg) =>
        query(leg.http, {
          search_query: `cat:${category}`,
          start,
          max_results: n,
          sortBy: "submittedDate",
          sortOrder: "descending",
        }),
    }),
    route({
      method: "GET",
      path: "/author",
      summary: "One author's papers, newest first (`name`, `n`, `start`)",
      ported: ported("arxiv/author.js"),
      request: z.object({ name: z.string().min(1), n, start }),
      api: ({ name, n, start }, leg) =>
        query(leg.http, {
          search_query: `au:"${name.replace(/"/g, "")}"`,
          start,
          max_results: n,
          sortBy: "submittedDate",
          sortOrder: "descending",
        }),
    }),
  ],
};
