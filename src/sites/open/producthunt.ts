/**
 * Product Hunt's public Atom feed, no key: the newest launches, by category or all. Votes and
 * comments are not in the feed: they need its GraphQL API (a developer token) or the page.
 */
import { decodeHTML } from "entities";
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { flag, getText, listOf, parseXml, ported } from "./kit.js";

const PH = "https://www.producthunt.com";

/** OpenCLI's list; any slug Product Hunt knows works. */
const CATEGORIES = [
  "ai-agents",
  "ai-coding-agents",
  "ai-code-editors",
  "ai-chatbots",
  "ai-workflow-automation",
  "vibe-coding",
  "developer-tools",
  "productivity",
  "design-creative",
  "marketing-sales",
  "no-code-platforms",
  "llms",
  "finance",
  "social-community",
  "engineering-development",
];

type Entry = Record<string, unknown> & {
  id?: string;
  title?: string;
  published?: string;
  updated?: string;
  link?: unknown;
  content?: { "#text"?: string } | string;
  author?: { name?: string };
};

const text = (html: string) =>
  decodeHTML(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** One launch: the entry's fields, its tagline and outbound link out of the content HTML. */
export function launchOf(e: Entry) {
  const html = typeof e.content === "string" ? e.content : (e.content?.["#text"] ?? "");
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? "");
  const link = listOf<{ "@href"?: string }>(e.link)[0]?.["@href"] ?? null;
  return {
    postId: e.id?.match(/Post\/(\d+)/)?.[1] ?? null,
    name: e.title ? decodeHTML(e.title) : null,
    tagline: paras[0] ? text(paras[0]) || null : null,
    url: link,
    // Product Hunt's redirect to the maker's site
    website: html.match(/href="(https:\/\/www\.producthunt\.com\/r\/p\/[^"]+)"/)?.[1] ?? null,
    author: e.author?.name ?? null,
    published: e.published ?? null,
    updated: e.updated ?? null,
    content: html,
  };
}

export const producthunt: SiteApi = {
  site: "producthunt",
  origin: PH,
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 1_000, jitterMs: 1_000 },
  routes: [
    route({
      method: "GET",
      path: "/posts",
      summary: `The newest 50 launches, or a \`category\`'s (a slug: ${CATEGORIES.slice(0, 6).join(", ")}, …); \`today\` keeps only the newest day's (Pacific time). Each with name, tagline, url, website, author, published and the feed's content`,
      ported: ported("producthunt/posts.js"),
      request: z.object({
        category: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .optional(),
        today: flag(false),
        n: z.coerce.number().int().min(1).max(50).default(50),
      }),
      api: async ({ category, today, n }, leg) => {
        const xml = await getText(
          leg.http,
          `${PH}/feed${category ? `?category=${category}` : ""}`,
          { label: "producthunt /feed", empty: [404] },
        );
        const feed = parseXml(xml ?? "").feed as { entry?: unknown } | undefined;
        if (!feed) return { found: false, launches: [] };
        let launches = listOf<Entry>(feed.entry).map(launchOf);
        if (today) {
          // the feed's dates carry Pacific offsets: the newest day is its first 10 chars
          const newest = launches
            .map((l) => l.published?.slice(0, 10) ?? "")
            .sort()
            .at(-1);
          launches = launches.filter((l) => l.published?.slice(0, 10) === newest);
        }
        return { found: true, launches: launches.slice(0, n) };
      },
    }),
  ],
};
