/**
 * Every reel of one Instagram account, read in the signed-in instagram profile (WA-1250).
 * Business and creator accounts go by API first: `meta GET /instagram/{username}/reels`.
 * Three rungs (`ladder`, WA-1251.3); each keeps items whole:
 *
 * 1. cookie: the page's feed call, `/api/v1/feed/user/<username>/username/?count=N`, paged by
 *    `next_max_id` (endpoint from OpenCLI clis/instagram/user.js@9bc5f5c); a reel is
 *    `product_type: "clips"`. 2026-11-09: 404 not-logged-in HTML from our profile, even with the
 *    page's CSRF, claim and ASBD headers; kept since it costs one call.
 * 2. intercept: the Reels tab's own GraphQL (`PolarisProfileReelsTabContentQuery`, 12 a page,
 *    then 3 a scroll), each answer under `data.fetch__XDTUserDict.clips_connection.edges[].node.media`,
 *    kept as the tab is scrolled. Mapped live 2026-11-09.
 * 3. ui: the Reels tab scrolled for `/reel/` links; urls only.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { type Fell, ladder, RungBroke, type Strategy } from "../ladder.js";
import { captureJson, pagedJson } from "../page-json.js";
import { scrollCollect } from "../scroll-collect.js";
import { IG_APP_ID, postCodesOf } from "./instagram-act.js";

const WEB = "https://www.instagram.com";
const PAGE = 33;
/** Between feed pages: 2–5 s, as a person scrolls a grid. */
const PAUSE_MS: [number, number] = [2_000, 5_000];
const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;
const GRAPHQL = /^https:\/\/www\.instagram\.com\/(api\/graphql|graphql\/query)\b/;

/** The little of the DOM the page script touches; the project compiles without lib dom. */
declare const document: {
  querySelectorAll(sel: string): Iterable<{ getAttribute(n: string): string | null }>;
};

export const reelUrl = (code: string) => `${WEB}/reel/${encodeURIComponent(code)}/`;

export interface ReelsInput {
  username: string;
  /** Most posts read (reels and others), newest first. */
  max?: number;
}

export interface Reels {
  username: string;
  found: boolean;
  /** The rung that answered: cookie (feed items), intercept (Reels tab media), ui (urls only). Absent when not found. */
  via?: Strategy;
  /** Rungs that broke before it, each with why. */
  fell: Fell[];
  urls: string[];
  /** Each reel whole: a feed item (cookie) or a Reels tab media (intercept); empty from ui. */
  reels: unknown[];
  /** Posts read, reels or not. */
  scanned: number;
  /** Feed pages, or GraphQL answers seen. */
  pages: number;
}

type Got = Pick<Reels, "urls" | "reels" | "scanned" | "pages">;

/** One feed item's reel code, or null for a photo or carousel. */
export function reelCodeOf(item: unknown): string | null {
  const i = (item ?? {}) as { product_type?: unknown; code?: unknown };
  return i.product_type === "clips" && typeof i.code === "string" && i.code ? i.code : null;
}

interface Clips {
  edges?: Array<{ node?: { media?: { code?: unknown } } }>;
  page_info?: { end_cursor?: unknown; has_next_page?: unknown };
}

/** A Reels tab GraphQL answer's connection, or null for another query. */
export function clipsOf(body: unknown): Clips | null {
  const c = (body as { data?: { fetch__XDTUserDict?: { clips_connection?: unknown } } })?.data
    ?.fetch__XDTUserDict?.clips_connection;
  return c && typeof c === "object" ? (c as Clips) : null;
}

/** Every media in the answers so far, in order, each once by code. */
export function clipMedia(bodies: readonly unknown[]): Array<{ code: string }> {
  const out = new Map<string, { code: string }>();
  for (const b of bodies)
    for (const e of clipsOf(b)?.edges ?? []) {
      const m = e?.node?.media;
      if (m && typeof m.code === "string" && m.code && !out.has(m.code))
        out.set(m.code, m as { code: string });
    }
  return [...out.values()];
}

const pause = (fp: FlowPage) =>
  fp.wait(PAUSE_MS[0] + Math.round(Math.random() * (PAUSE_MS[1] - PAUSE_MS[0])));

async function byFeed(fp: FlowPage, username: string, cap: number): Promise<Got> {
  type Feed = { items?: unknown[]; next_max_id?: unknown; more_available?: unknown };
  const { items, pages } = await pagedJson<unknown>(fp, {
    url: (after) =>
      `/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=${PAGE}${after ? `&max_id=${encodeURIComponent(after)}` : ""}`,
    items: (j) => ((j as Feed).items ?? []) as unknown[],
    next: (j) => {
      const { next_max_id: n, more_available } = j as Feed;
      return more_available === true && (typeof n === "string" || typeof n === "number")
        ? String(n)
        : null;
    },
    max: cap,
    pause: () => pause(fp),
    fetch: { headers: { "X-IG-App-ID": IG_APP_ID } },
  });
  const reels = items.filter((i) => reelCodeOf(i));
  return {
    urls: reels.map((i) => reelUrl(reelCodeOf(i) as string)),
    reels,
    scanned: items.length,
    pages,
  };
}

const reelsTab = (username: string) => `${WEB}/${encodeURIComponent(username)}/reels/`;

/** The first page comes with the tab's load, so the listener is on before the open. */
async function byGraphql(fp: FlowPage, username: string, cap: number): Promise<Got> {
  const { bodies, result } = await captureJson(
    fp,
    { match: GRAPHQL, keep: (j) => clipsOf(j) !== null },
    async (seen) => {
      await fp.open(reelsTab(username));
      return scrollCollect(fp, {
        read: async () => clipMedia(seen),
        key: (m) => m.code,
        max: cap,
        settleMs: 2_000,
      });
    },
  );
  if (!bodies.length) throw new RungBroke("no Reels tab GraphQL answer seen");
  return {
    urls: result.rows.map((m) => reelUrl(m.code)),
    reels: result.rows,
    scanned: result.rows.length,
    pages: bodies.length,
  };
}

async function byGrid(fp: FlowPage, username: string, cap: number): Promise<Got> {
  if (!fp.url().includes("/reels")) await fp.open(reelsTab(username));
  const { rows } = await scrollCollect(fp, {
    read: async () =>
      postCodesOf(
        await fp.page.evaluate(() =>
          [...document.querySelectorAll('main a[href*="/reel/"]')].map(
            (a) => a.getAttribute("href") ?? "",
          ),
        ),
      ),
    key: (code) => code,
    max: cap,
    settleMs: 2_000,
  });
  return { urls: rows.map(reelUrl), reels: [], scanned: rows.length, pages: 0 };
}

export const instagramReels = defineFlow<ReelsInput, Reels>({
  site: "instagram",
  name: "reels",
  strategies: ["cookie", "intercept", "ui"],
  async run(fp, { username, max }) {
    const cap = Math.min(Math.max(1, max ?? 1000), 2000);
    await fp.open(`${WEB}/${encodeURIComponent(username)}/`);
    if (SIGNED_OUT.test(fp.url()))
      return fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
    if (MISSING.test(await fp.text()))
      return { username, found: false, fell: [], urls: [], reels: [], scanned: 0, pages: 0 };
    const { value, via, fell } = await ladder<Got>([
      { strategy: "cookie", run: () => byFeed(fp, username, cap) },
      { strategy: "intercept", run: () => byGraphql(fp, username, cap) },
      { strategy: "ui", run: () => byGrid(fp, username, cap) },
    ]);
    return { username, found: true, via, fell, ...value };
  },
});
