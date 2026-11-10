/**
 * News by RSS, no key: BBC News, Bloomberg's section feeds, Reuters by Google News. Each item whole as sent
 * (title, link, description, pubDate, media). Bloomberg articles themselves sit behind its
 * paywall and bot check: headlines only here.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { getText, ported, qs, rssFeed } from "./kit.js";

const BBC = "https://feeds.bbci.co.uk/news";
const BBC_TOPICS = [
  "top",
  "world",
  "uk",
  "business",
  "politics",
  "health",
  "education",
  "science_and_environment",
  "technology",
  "entertainment_and_arts",
] as const;

export const bbc: SiteApi = {
  site: "bbc",
  origin: BBC,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/news",
      summary: `Newest BBC News headlines by \`topic\` (${BBC_TOPICS.join("|")}): the RSS items whole`,
      ported: ported("bbc/topic.js"),
      request: z.object({ topic: z.enum(BBC_TOPICS).default("top") }),
      api: async ({ topic }, leg) =>
        rssFeed(
          await getText(leg.http, `${BBC}/${topic === "top" ? "" : `${topic}/`}rss.xml`, {
            label: "bbc /news",
            empty: [404],
          }),
        ),
    }),
  ],
};

// feeds.bloomberg.com redirects here since 2026; businessweek's feed is served empty
const BLOOMBERG = "https://www.bloomberg.com/feeds";
const SECTIONS = {
  main: "",
  markets: "markets/",
  economics: "economics/",
  industries: "industries/",
  tech: "technology/",
  politics: "politics/",
  opinions: "bview/",
  green: "green/",
  crypto: "crypto/",
  pursuits: "pursuits/",
} as const;

export const bloomberg: SiteApi = {
  site: "bloomberg",
  origin: BLOOMBERG,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/news",
      summary: `Newest Bloomberg headlines by \`section\` (${Object.keys(SECTIONS).join("|")}): the RSS items whole`,
      ported: ported("bloomberg/feeds.js"),
      request: z.object({
        section: z.enum(Object.keys(SECTIONS) as [keyof typeof SECTIONS]).default("main"),
      }),
      api: async ({ section }, leg) =>
        rssFeed(
          await getText(leg.http, `${BLOOMBERG}/${SECTIONS[section]}news.rss`, {
            label: "bloomberg /news",
            empty: [404],
          }),
        ),
    }),
  ],
};

// reuters.com, its feeds and sitemaps sit behind DataDome (401, a captcha even in a browser):
// Google News' search feed, scoped to the site, lists its articles
const GOOGLE_NEWS = "https://news.google.com/rss/search";

export const reuters: SiteApi = {
  site: "reuters",
  origin: GOOGLE_NEWS,
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 1_000, jitterMs: 1_000 },
  routes: [
    route({
      method: "GET",
      path: "/news",
      summary:
        "Reuters articles by Google News: newest first, `q` words (none: all), `when` 1h|1d|7d|30d. Each item whole (title, Google News link, pubDate, source) plus `headline` without the ' - Reuters' suffix. Article text stays behind Reuters' bot check",
      ported: ported("reuters/search.js"),
      request: z.object({
        q: z.string().max(200).optional(),
        when: z.enum(["1h", "1d", "7d", "30d"]).default("7d"),
        hl: z
          .string()
          .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
          .default("en-US"),
        gl: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .default("US"),
      }),
      api: async ({ q, when, hl, gl }, leg) => {
        const query = ["site:reuters.com", q?.trim(), `when:${when}`].filter(Boolean).join(" ");
        const feed = rssFeed(
          await getText(
            leg.http,
            `${GOOGLE_NEWS}?${qs({ q: query, hl, gl, ceid: `${gl}:${hl.slice(0, 2)}` })}`,
            { label: "reuters /news", empty: [404] },
          ),
        );
        const items = feed.items
          .map(
            (i): Record<string, unknown> => ({
              ...i,
              headline: typeof i.title === "string" ? i.title.replace(/\s+-\s+Reuters$/, "") : null,
            }),
          )
          .sort((a, b) => Date.parse(String(b.pubDate)) - Date.parse(String(a.pubDate)));
        return { ...feed, query, items };
      },
    }),
  ],
};
