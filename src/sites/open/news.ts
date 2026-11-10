/**
 * News by RSS, no key: BBC News and Bloomberg's section feeds. Each item whole as sent
 * (title, link, description, pubDate, media). Bloomberg articles themselves sit behind its
 * paywall and bot check: headlines only here.
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { getText, ported, rssFeed } from "./kit.js";

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
