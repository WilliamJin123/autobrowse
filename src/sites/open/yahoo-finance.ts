/**
 * Yahoo Finance's own JSON (its pages call it), no key: price history by symbol, and search
 * over tickers and news. The v7 quote endpoint wants a cookie crumb (401 bare): a symbol's
 * chart `meta` carries the same live price, day range and 52-week range.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://query1.finance.yahoo.com";
const GAP_MS = 500;

const get = (leg: ApiLeg, path: string, params: Record<string, string | number | undefined>) =>
  getJson<Record<string, unknown>>(leg.http, `${API}${path}?${qs(params)}`, {
    label: `yahoo-finance ${path}`,
    gapMs: GAP_MS,
    // an unknown symbol answers 404 with chart.error
    empty: [404],
  });

const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"] as const;
const INTERVALS = [
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "90m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
] as const;

export const yahooFinance: SiteApi = {
  site: "yahoo-finance",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/chart/{symbol}",
      summary:
        "A symbol's price now and its history (`range` 1d…max, `interval` 1m…3mo; `from`/`to` unix seconds instead of range; `events` div,split): chart.result[0] whole, `meta` has price, day and 52-week ranges; found false for an unknown symbol",
      ported: ported("yahoo-finance/quote.js"),
      request: z.object({
        symbol: z.string().regex(/^[\w.^=-]{1,20}$/),
        range: z.enum(RANGES).default("1mo"),
        interval: z.enum(INTERVALS).default("1d"),
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        events: z.string().optional(),
      }),
      api: async ({ symbol, range, interval, from, to, events }, leg) => {
        const body = await get(leg, `/v8/finance/chart/${encodeURIComponent(symbol)}`, {
          interval,
          ...(from ? { period1: from, period2: to ?? Math.floor(Date.now() / 1000) } : { range }),
          events,
          includePrePost: "false",
        });
        const chart = (body?.chart ?? {}) as { result?: unknown[] | null };
        const first = chart.result?.[0];
        return first ? { found: true, chart: first } : { found: false, chart: null };
      },
    }),
    route({
      method: "GET",
      path: "/search",
      summary:
        "Tickers and news by words (`q`, `quotes` and `news` counts): the answer whole (quotes with symbol, exchange, type; news with publisher and link)",
      request: z.object({
        q: z.string().min(1),
        quotes: z.coerce.number().int().min(0).max(50).default(8),
        news: z.coerce.number().int().min(0).max(50).default(8),
      }),
      api: async ({ q, quotes, news }, leg) =>
        (await get(leg, "/v1/finance/search", { q, quotesCount: quotes, newsCount: news })) ?? {},
    }),
  ],
};
