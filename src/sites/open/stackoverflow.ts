/**
 * Stack Exchange API 2.3, any SE site (`site`, default stackoverflow). No key: 300 calls a day
 * per IP; `STACKEXCHANGE_KEY` (an app key, not a secret) raises it to 10,000. Answers whole:
 * the envelope with `quota_remaining`, bodies included (`filter=withbody`).
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://api.stackexchange.com/2.3";

type Envelope = { items?: unknown[]; quota_remaining?: number } & Record<string, unknown>;

const call = async (
  leg: ApiLeg,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<Envelope> => {
  const query = qs({
    site: "stackoverflow",
    filter: "withbody",
    ...params,
    key: leg.env("STACKEXCHANGE_KEY"),
  });
  const body = await getJson<Envelope>(leg.http, `${API}${path}?${query}`, {
    label: `stackoverflow ${path}`,
    empty: [404],
  });
  return body ?? { items: [] };
};

const site = z.string().default("stackoverflow");
const n = z.coerce.number().int().min(1).max(100).default(20);
const page = z.coerce.number().int().min(1).default(1);
const SORTS = ["activity", "votes", "creation", "hot", "week", "month"] as const;

export const stackoverflow: SiteApi = {
  site: "stackoverflow",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  // keyless quota: 300 calls a day per IP
  caps: { call: 280 },
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Questions by words (`q`), `tagged` (`python;asyncio`), `accepted`, `sort` relevance|activity|votes|creation, `n`, `page`, `site`: the envelope whole (has_more, quota_remaining), each question with its body",
      ported: ported("stackoverflow/search.js"),
      request: z.object({
        q: z.string().min(1),
        tagged: z.string().optional(),
        accepted: z.enum(["true", "false"]).optional(),
        sort: z.enum(["relevance", "activity", "votes", "creation"]).default("relevance"),
        n,
        page,
        site,
      }),
      meter: () => ({ call: 1 }),
      api: ({ q, tagged, accepted, sort, n, page, site }, leg) =>
        call(leg, "/search/advanced", {
          q,
          tagged,
          accepted,
          sort,
          order: "desc",
          pagesize: n,
          page,
          site,
        }),
    }),
    route({
      method: "GET",
      path: "/questions",
      summary:
        "A question list: `list` all|unanswered|featured (open bounties), `tagged`, `sort` activity|votes|creation|hot|week|month, `n`, `page`, `site`",
      ported: ported("stackoverflow/hot.js"),
      request: z.object({
        list: z.enum(["all", "unanswered", "featured"]).default("all"),
        tagged: z.string().optional(),
        sort: z.enum(SORTS).default("hot"),
        n,
        page,
        site,
      }),
      meter: () => ({ call: 1 }),
      api: ({ list, tagged, sort, n, page, site }, leg) =>
        call(leg, list === "all" ? "/questions" : `/questions/${list}`, {
          tagged,
          // unanswered and featured sort only by activity|votes|creation
          sort: list === "all" || ["activity", "votes", "creation"].includes(sort) ? sort : "votes",
          order: "desc",
          pagesize: n,
          page,
          site,
        }),
    }),
    route({
      method: "GET",
      path: "/questions/{id}",
      summary:
        "One question whole with its comments, its answers by votes, each answer's comments (`answers`, `comments` caps, `site`); found false when gone",
      ported: ported("stackoverflow/read.js"),
      request: z.object({
        id: z.coerce.number().int().positive(),
        answers: z.coerce.number().int().min(0).max(100).default(30),
        comments: z.coerce.number().int().min(0).max(100).default(50),
        site,
      }),
      meter: () => ({ call: 4 }),
      api: async ({ id, answers, comments, site }, leg) => {
        const q = (await call(leg, `/questions/${id}`, { site })).items?.[0];
        if (!q) return { found: false, question: null };
        const sorted = { order: "asc", sort: "creation" };
        const [qc, as] = await Promise.all([
          comments
            ? call(leg, `/questions/${id}/comments`, { site, ...sorted, pagesize: comments })
            : ({ items: [] } as Envelope),
          answers
            ? call(leg, `/questions/${id}/answers`, {
                site,
                order: "desc",
                sort: "votes",
                pagesize: answers,
              })
            : ({ items: [] } as Envelope),
        ]);
        const list = (as.items ?? []) as Array<{ answer_id: number } & Record<string, unknown>>;
        const ids = list.map((a) => a.answer_id).join(";");
        const ac =
          comments && ids
            ? ((await call(leg, `/answers/${ids}/comments`, { site, ...sorted, pagesize: 100 }))
                .items ?? [])
            : [];
        const on = (id: number) =>
          (ac as Array<{ post_id: number }>).filter((c) => c.post_id === id);
        return {
          found: true,
          question: { ...(q as object), comments: qc.items ?? [] },
          answers: list.map((a) => ({ ...a, comments: on(a.answer_id) })),
          quota_remaining: as.quota_remaining ?? qc.quota_remaining,
        };
      },
    }),
    route({
      method: "GET",
      path: "/questions/{id}/related",
      summary: "Questions related to one (`n`, `site`): the envelope whole",
      ported: ported("stackoverflow/related.js"),
      request: z.object({ id: z.coerce.number().int().positive(), n, site }),
      meter: () => ({ call: 1 }),
      api: ({ id, n, site }, leg) =>
        call(leg, `/questions/${id}/related`, { pagesize: n, site, sort: "rank", order: "desc" }),
    }),
    route({
      method: "GET",
      path: "/users/{id}",
      summary:
        "One user whole, with their top answers and top tags (`n`, `site`); found false when gone",
      ported: ported("stackoverflow/user.js"),
      request: z.object({ id: z.coerce.number().int().positive(), n, site }),
      meter: () => ({ call: 3 }),
      api: async ({ id, n, site }, leg) => {
        const user = (await call(leg, `/users/${id}`, { site, filter: "default" })).items?.[0];
        if (!user) return { found: false, user: null };
        const [answers, tags] = await Promise.all([
          call(leg, `/users/${id}/answers`, { site, sort: "votes", order: "desc", pagesize: n }),
          call(leg, `/users/${id}/top-tags`, { site, filter: "default", pagesize: n }),
        ]);
        return { found: true, user, answers: answers.items ?? [], tags: tags.items ?? [] };
      },
    }),
    route({
      method: "GET",
      path: "/tags",
      summary: "Tags by popularity, or those whose name holds `q` (`n`, `page`, `site`)",
      ported: ported("stackoverflow/tag.js"),
      request: z.object({ q: z.string().optional(), n, page, site }),
      meter: () => ({ call: 1 }),
      api: ({ q, n, page, site }, leg) =>
        call(leg, "/tags", {
          inname: q,
          sort: "popular",
          order: "desc",
          pagesize: n,
          page,
          site,
          filter: "default",
        }),
    }),
  ],
};
