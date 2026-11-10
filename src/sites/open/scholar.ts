/**
 * Google Scholar, signed out, in a browser (flows `google-scholar/search`, `/author`): Scholar
 * redirects plain clients and has no API. Each hit with its authors' profile ids, citation count,
 * `citesId` (who cites it, all versions) and PDF link; an author's profile with stats and papers.
 * Scholar shows a captcha after a burst: caps keep it under one.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { ported } from "./kit.js";

const FINAL = { final: "Google Scholar has no API; Google offers none for it" };

export const googleScholar: SiteApi = {
  site: "google-scholar",
  origin: "https://scholar.google.com",
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 4_000, jitterMs: 4_000 },
  caps: { page: 60 },
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Papers by words (`q`; `n` up to 20, `start` offset, `from`/`to` years, `sort` relevance|date): total and each hit with title, url, kind, byline, authors (name, profile `user`), year, snippet, citedBy, citesId, versions, pdf. A browser leg",
      ported: ported("google-scholar/search.js"),
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(20).default(10),
        start: z.coerce.number().int().min(0).default(0),
        from: z.coerce.number().int().min(1900).max(2100).optional(),
        to: z.coerce.number().int().min(1900).max(2100).optional(),
        sort: z.enum(["relevance", "date"]).default("relevance"),
      }),
      standing: FINAL,
      meter: () => ({ page: 1 }),
      browser: { flow: "google-scholar/search" },
    }),
    route({
      method: "GET",
      path: "/authors/{user}",
      summary:
        "One author's profile by Scholar `user` id: name, affiliation, interests, homepage, stats (citations, h-index, i10-index), citations by year, and papers (`n` up to 100, `sort` cited|date) with citedBy and year. A browser leg",
      ported: ported("google-scholar/profile.js"),
      request: z.object({
        user: z.string().regex(/^[\w-]{12}$/),
        n: z.coerce.number().int().min(1).max(100).default(100),
        sort: z.enum(["cited", "date"]).default("cited"),
      }),
      standing: FINAL,
      meter: () => ({ page: 1 }),
      browser: { flow: "google-scholar/author" },
    }),
  ],
};
