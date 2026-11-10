/**
 * AI answer engines on their own pages, signed out: ChatGPT (with web search and its sources)
 * and Gemini (Flash-Lite, no sources). Browser legs, paced like a person asking
 * (`browser/flows/answer-engines.ts`). Perplexity is its own site (`perplexity`).
 */
import { z } from "zod";
import { route, type SiteApi } from "../types.js";
import { flag, ported } from "./kit.js";

const question = z.string().trim().min(1).max(4_000);

export const chatgpt: SiteApi = {
  site: "chatgpt",
  origin: "https://chatgpt.com",
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 10_000, jitterMs: 10_000 },
  caps: { ask: 60 },
  blockers: {
    "openai-api": {
      what: "OpenAI's Responses API answers with its web_search tool and citations, with an API key; no OpenAI key is set",
      since: "2026-11-10",
    },
  },
  routes: [
    route({
      method: "GET",
      path: "/ask",
      summary:
        "One question to ChatGPT's page, signed out: the answer as text and its sources (url, link text). `search` (default true) turns on web search. A browser leg; no chat is kept",
      ported: ported("chatgpt/ask.js"),
      request: z.object({ q: question, search: flag(true) }),
      standing: { waits: "openai-api" },
      meter: () => ({ ask: 1 }),
      browser: { flow: "chatgpt/ask" },
    }),
  ],
};

export const gemini: SiteApi = {
  site: "gemini",
  origin: "https://gemini.google.com",
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 10_000, jitterMs: 10_000 },
  caps: { ask: 60 },
  blockers: {
    "gemini-api": {
      what: "The Gemini API answers grounded in Google Search (google_search tool) with a key; not wired into this site",
      since: "2026-11-10",
    },
  },
  routes: [
    route({
      method: "GET",
      path: "/ask",
      summary:
        "One question to Gemini's page, signed out (Flash-Lite): the answer as text, and links when it gives any. A browser leg; no chat is kept",
      ported: ported("gemini/ask.js"),
      request: z.object({ q: question }),
      standing: { waits: "gemini-api" },
      meter: () => ({ ask: 1 }),
      browser: { flow: "gemini/ask" },
    }),
  ],
};
