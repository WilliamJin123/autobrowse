/**
 * Medium's RSS feeds, no sign-in: a tag, a writer, a publication. Each item whole as sent
 * (`content:encoded` is the post's HTML; `category` always a list). About 10 newest a feed.
 * Search and the reader's feed need Medium's page (OpenCLI uses cookies): not here.
 */
import { z } from "zod";
import type { ApiLeg } from "../types.js";
import { route, type SiteApi } from "../types.js";
import { getText, ported, rssFeed } from "./kit.js";

const SITE = "https://medium.com";

const feed = async (leg: ApiLeg, path: string) =>
  rssFeed(await getText(leg.http, `${SITE}/feed/${path}`, { label: "medium /feed", empty: [404] }));

const slug = z.string().regex(/^[\w.-]+$/);

export const medium: SiteApi = {
  site: "medium",
  origin: SITE,
  auth: { open: true },
  signedOut: true,
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/tags/{tag}",
      summary: "Newest posts with a tag (`machine-learning`): the RSS items whole",
      ported: ported("medium/tag.js"),
      request: z.object({ tag: slug }),
      api: ({ tag }, leg) => feed(leg, `tag/${tag}`),
    }),
    route({
      method: "GET",
      path: "/writers/{name}",
      summary: "A writer's newest posts (`name` without the @): the RSS items whole",
      ported: ported("medium/user.js"),
      request: z.object({ name: slug }),
      api: ({ name }, leg) => feed(leg, `@${name}`),
    }),
    route({
      method: "GET",
      path: "/publications/{name}",
      summary: "A publication's newest posts (`towards-data-science`): the RSS items whole",
      request: z.object({ name: slug }),
      api: ({ name }, leg) => feed(leg, name),
    }),
  ],
};
