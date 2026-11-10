/**
 * dblp, computer science bibliography. Every call runs in a dblp.org page (flow `dblp/api`):
 * the hosts answer a bot check to any plain client. Search is dblp's JSON; a person's and a
 * record's pages are its XML, parsed whole.
 */
import { z } from "zod";
import type { PageApiAnswer } from "../../browser/flows/page-api.js";
import { route, type SiteApi } from "../types.js";
import { listOf, parseXml, ported, qs } from "./kit.js";

const DBLP = "https://dblp.org";
const n = z.coerce.number().int().min(1).max(1000).default(30);
const first = z.coerce.number().int().min(0).default(0);

type Search = { result?: { hits?: { "@total"?: string; hit?: unknown } } };

/** dblp's search answer: total and each hit whole (`info` holds the record). */
const hitsOf = (o: unknown) => {
  const hits = ((o as PageApiAnswer).json as Search)?.result?.hits;
  return { total: Number(hits?.["@total"] ?? 0), hits: listOf(hits?.hit) };
};

const search = (kind: "publ" | "author" | "venue", file: string, summary: string) =>
  route({
    method: "GET",
    path: kind === "publ" ? "/search" : `/${kind}s/search`,
    summary,
    ported: ported(file),
    request: z.object({ q: z.string().min(1), n, first }),
    standing: { waits: "bot-check" },
    browser: {
      flow: "dblp/api",
      input: ({ q, n, first }: { q: string; n: number; first: number }) => ({
        url: `${DBLP}/search/${kind}/api?${qs({ q, h: n, f: first, format: "json" })}`,
      }),
      output: hitsOf,
    },
  });

/** An XML answer whole, or found false for a 404. */
const xmlOf = (key: string) => (o: unknown) => {
  const xml = (o as PageApiAnswer).xml;
  return xml ? { found: true, [key]: parseXml(xml) } : { found: false, [key]: null };
};

export const dblp: SiteApi = {
  site: "dblp",
  origin: "https://dblp.org",
  auth: { open: true },
  signedOut: true,
  setup: [],
  blockers: {
    "bot-check": {
      what: "Every dblp host answers an Anubis proof of work to a plain client (11-09); the API reads inside dblp.org's page until a plain client passes again",
      since: "2026-11-09",
    },
  },
  pace: { gapMs: 2_000, jitterMs: 2_000 },
  routes: [
    search(
      "publ",
      "dblp/search.js",
      "Publications by words (`q`, `n` up to 1000, `first` offset): total and each hit whole",
    ),
    search(
      "author",
      "dblp/author.js",
      "Authors by name (`q`, `n`, `first`): total and each hit whole, with the pid for /authors",
    ),
    search(
      "venue",
      "dblp/venue.js",
      "Venues by name (`q`, `n`, `first`): total and each hit whole",
    ),
    route({
      method: "GET",
      path: "/authors",
      summary:
        "One author's whole dblp record by pid (`pid` like `56/953`): every publication, coauthors, links",
      ported: ported("dblp/author.js"),
      request: z.object({ pid: z.string().regex(/^[\w-]+\/[\w-]+$/) }),
      standing: { waits: "bot-check" },
      browser: {
        flow: "dblp/api",
        input: ({ pid }: { pid: string }) => ({ url: `${DBLP}/pid/${pid}.xml` }),
        output: xmlOf("person"),
      },
    }),
    route({
      method: "GET",
      path: "/records",
      summary: "One record whole by dblp key (`key` like `conf/nips/VaswaniSPUJGKP17`)",
      ported: ported("dblp/paper.js"),
      request: z.object({ key: z.string().regex(/^[\w-]+(\/[\w-]+)+$/) }),
      standing: { waits: "bot-check" },
      browser: {
        flow: "dblp/api",
        input: ({ key }: { key: string }) => ({ url: `${DBLP}/rec/${key}.xml` }),
        output: xmlOf("record"),
      },
    }),
  ],
};
