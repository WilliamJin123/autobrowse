/**
 * Job boards, signed out, in a browser: Indeed and Upwork answer Cloudflare 403s to plain
 * clients. Each read takes the page's own state whole (Indeed's job cards and job model,
 * Upwork's store), not its markup.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { ported } from "./kit.js";

export const indeed: SiteApi = {
  site: "indeed",
  origin: "https://www.indeed.com",
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 3_000, jitterMs: 3_000 },
  caps: { page: 200 },
  routes: [
    route({
      method: "GET",
      path: "/jobs",
      summary:
        "Jobs by words (`q`; `l` place or remote, `fromage` days 1|3|7|14, `sort` relevance|date, `start` offset by 10): the count shown and each job card whole (jobkey, title, company, rating, salary, snippet, pubDate, location, taxonomy) and the page's meta. A browser leg",
      ported: ported("indeed/search.js"),
      request: z.object({
        q: z.string().min(1),
        l: z.string().optional(),
        fromage: z.coerce
          .number()
          .int()
          .refine((d) => [1, 3, 7, 14].includes(d), "1, 3, 7 or 14")
          .optional(),
        sort: z.enum(["relevance", "date"]).default("relevance"),
        start: z.coerce.number().int().min(0).multipleOf(10).default(0),
      }),
      standing: {
        final: "Indeed retired its job search API; its employer APIs post jobs and search none",
      },
      meter: () => ({ page: 1 }),
      browser: { flow: "indeed/search" },
    }),
    route({
      method: "GET",
      path: "/jobs/{jk}",
      summary:
        "One job by its jobkey: the page's job model whole (description HTML, salary, benefits, company, dates, apply links). A browser leg",
      ported: ported("indeed/job.js"),
      request: z.object({ jk: z.string().regex(/^[a-f0-9]{16}$/) }),
      standing: {
        final: "Indeed retired its job search API; its employer APIs post jobs and read none",
      },
      meter: () => ({ page: 1 }),
      browser: { flow: "indeed/job" },
    }),
  ],
};

export const upwork: SiteApi = {
  site: "upwork",
  origin: "https://www.upwork.com",
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 3_000, jitterMs: 3_000 },
  caps: { page: 200 },
  blockers: {
    "upwork-api": {
      what: "Upwork's GraphQL API searches and reads job posts (marketplaceJobPostingsSearch) with an approved API key; none applied for",
      since: "2026-11-10",
    },
  },
  routes: [
    route({
      method: "GET",
      path: "/jobs",
      summary:
        "Job posts by words (`q`; `page`, `perPage` 10|20|50, `sort` relevance|recency): each post whole as the search store holds it (ciphertext id, title, description, budget, client, skills, tier, dates) and paging (total, offset). A browser leg",
      ported: ported("upwork/search.js"),
      request: z.object({
        q: z.string().min(1),
        page: z.coerce.number().int().min(1).default(1),
        perPage: z.coerce
          .number()
          .int()
          .refine((n) => [10, 20, 50].includes(n), "10, 20 or 50")
          .default(50),
        sort: z.enum(["relevance", "recency"]).default("relevance"),
      }),
      standing: { waits: "upwork-api" },
      meter: () => ({ page: 1 }),
      browser: { flow: "upwork/search" },
    }),
    route({
      method: "GET",
      path: "/jobs/{id}",
      summary:
        "One job post by ciphertext id (`~02…`): the job store whole (job, buyer with stats, open jobs, work history, similar jobs, skills, applicants); found false when gone. A browser leg",
      ported: ported("upwork/detail.js"),
      request: z.object({ id: z.string().regex(/^~?0[0-9a-f]{17,20}$/) }),
      standing: { waits: "upwork-api" },
      meter: () => ({ page: 1 }),
      browser: { flow: "upwork/job" },
    }),
  ],
};
