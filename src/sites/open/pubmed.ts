/**
 * PubMed through NCBI E-utilities, no key (3 calls a second; `NCBI_API_KEY` raises it to 10).
 * Search and links answer each summary whole (esummary JSON); one article is the efetch
 * record whole (abstract, MeSH, references), with `abstract` as text.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, getText, listOf, parseXml, ported, qs } from "./kit.js";

const API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

const url = (leg: ApiLeg, tool: string, params: Record<string, string | number | undefined>) => {
  const key = leg.env("NCBI_API_KEY");
  return `${API}/${tool}.fcgi?${qs({ db: "pubmed", tool: "autobrowse", api_key: key, ...params })}`;
};
const gapOf = (leg: ApiLeg) => (leg.env("NCBI_API_KEY") ? 110 : 350);

/** Each summary whole, in the order of `ids`. */
async function summaries(leg: ApiLeg, ids: string[]): Promise<unknown[]> {
  if (!ids.length) return [];
  const body = await getJson<{ result?: Record<string, unknown> }>(
    leg.http,
    url(leg, "esummary", { id: ids.join(","), retmode: "json" }),
    { label: "pubmed esummary", gapMs: gapOf(leg) },
  );
  return ids.map((id) => body?.result?.[id]).filter(Boolean);
}

/** PubMed's term with the asked filters ANDed on. */
export function pubmedTerm(i: {
  q: string;
  author?: string | undefined;
  journal?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  type?: string | undefined;
  free?: boolean | undefined;
}): string {
  const t = [i.q];
  if (i.author) t.push(`${i.author}[Author]`);
  if (i.journal) t.push(`${i.journal}[Journal]`);
  if (i.from || i.to) t.push(`${i.from ?? 1800}:${i.to ?? 3000}[PDAT]`);
  if (i.type) t.push(`${i.type}[PT]`);
  if (i.free) t.push("free full text[sb]");
  return t.join(" AND ");
}

/** AbstractText parts (a string, or labeled `{#text, @Label}`) as one text. */
export function abstractText(article: unknown): string | null {
  const a = (
    article as { MedlineCitation?: { Article?: { Abstract?: { AbstractText?: unknown } } } }
  )?.MedlineCitation?.Article?.Abstract?.AbstractText;
  const parts = listOf<unknown>(a).map((p) => {
    if (typeof p === "string") return p;
    const o = p as { "#text"?: unknown; "@Label"?: unknown };
    const text = typeof o?.["#text"] === "string" ? o["#text"] : "";
    return o?.["@Label"] ? `${o["@Label"]}: ${text}` : text;
  });
  return parts.filter(Boolean).join("\n") || null;
}

const n = z.coerce.number().int().min(1).max(200).default(20);
const yes = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1")
  .optional();

export const pubmed: SiteApi = {
  site: "pubmed",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Articles by PubMed query (`q`; `author`, `journal`, `from`/`to` years, `type` like Review or Clinical Trial, `free` full text; `n`, `start`, `sort` relevance|pub_date): total, ids, and each summary whole",
      ported: ported("pubmed/search.js"),
      request: z.object({
        q: z.string().min(1),
        author: z.string().optional(),
        journal: z.string().optional(),
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        type: z.string().optional(),
        free: yes,
        n,
        start: z.coerce.number().int().min(0).default(0),
        sort: z.enum(["relevance", "pub_date"]).default("relevance"),
      }),
      api: async (i, leg) => {
        const term = pubmedTerm(i);
        const body = await getJson<{
          esearchresult?: { count?: string; idlist?: string[]; querytranslation?: string };
        }>(
          leg.http,
          url(leg, "esearch", {
            term,
            retmax: i.n,
            retstart: i.start,
            sort: i.sort,
            retmode: "json",
          }),
          { label: "pubmed esearch", gapMs: gapOf(leg) },
        );
        const r = body?.esearchresult ?? {};
        const ids = r.idlist ?? [];
        return {
          term,
          translated: r.querytranslation ?? null,
          total: Number(r.count ?? 0),
          ids,
          articles: await summaries(leg, ids),
        };
      },
    }),
    route({
      method: "GET",
      path: "/articles/{pmid}",
      summary:
        "One article by PMID: the efetch record whole (abstract, MeSH, references) and `abstract` as text, or found false",
      ported: ported("pubmed/article.js"),
      request: z.object({ pmid: z.string().regex(/^\d+$/) }),
      api: async ({ pmid }, leg) => {
        const xml = await getText(leg.http, url(leg, "efetch", { id: pmid, retmode: "xml" }), {
          label: "pubmed efetch",
          gapMs: gapOf(leg),
        });
        const set = (parseXml(xml ?? "").PubmedArticleSet ?? {}) as Record<string, unknown>;
        const article = listOf(set.PubmedArticle)[0] ?? listOf(set.PubmedBookArticle)[0];
        return article
          ? { found: true, pmid, abstract: abstractText(article), article }
          : { found: false, pmid, abstract: null, article: null };
      },
    }),
    route({
      method: "GET",
      path: "/articles/{pmid}/links",
      summary:
        "Articles linked to one (`kind` related|citedby|refs, `n`): ids and each summary whole. `citedby` counts PubMed Central citers only",
      ported: ported("pubmed/related.js"),
      request: z.object({
        pmid: z.string().regex(/^\d+$/),
        kind: z.enum(["related", "citedby", "refs"]).default("related"),
        n,
      }),
      api: async ({ pmid, kind, n }, leg) => {
        const linkname = {
          related: "pubmed_pubmed",
          citedby: "pubmed_pubmed_citedin",
          refs: "pubmed_pubmed_refs",
        }[kind];
        const body = await getJson<{
          linksets?: Array<{ linksetdbs?: Array<{ links?: string[] }> }>;
        }>(leg.http, url(leg, "elink", { dbfrom: "pubmed", id: pmid, linkname, retmode: "json" }), {
          label: "pubmed elink",
          gapMs: gapOf(leg),
        });
        const all = (body?.linksets?.[0]?.linksetdbs?.[0]?.links ?? []).filter((id) => id !== pmid);
        const ids = all.slice(0, n);
        return { pmid, kind, total: all.length, ids, articles: await summaries(leg, ids) };
      },
    }),
  ],
};
