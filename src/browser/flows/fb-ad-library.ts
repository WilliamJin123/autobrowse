/**
 * Meta Ad Library, signed out (WA-1256). Mapped live 2026-11-11:
 * - the search page carries its first 30 results whole in one script
 *   (`…__bbox.result.data.ad_library_main.search_results_connection`: `count`, `edges[].node
 *   .collated_results[]`, `page_info.end_cursor`);
 * - scrolling loads 30 more a time by POST `/api/graphql/` `AdLibrarySearchPaginationQuery`,
 *   the same connection shape;
 * - an advertiser's own ads: `search_type=page&view_all_page_id=<id>`; a page's URL gives the id
 *   as `delegate_page.id` in its HTML (the `al:` profile id is a different number).
 * Each ad stays whole in `raw`; media URLs are signed fbcdn links that expire (`oe=`).
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { RungBroke } from "../ladder.js";
import { scrollCollect } from "../scroll-collect.js";

const WEB = "https://www.facebook.com";
const PER_PAGE = 30;
/** Signed out, a "Log In" bar sits over every page: not a wall here. */
const SIGNED_OUT_OK = { allowWall: true };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

export interface AdMedia {
  images: { url: string; resized: string | null }[];
  videos: { hd: string | null; sd: string | null; poster: string | null }[];
}

export interface AdCard {
  headline: string | null;
  body: string | null;
  cta: string | null;
  link: string | null;
  caption: string | null;
  image: string | null;
  video: { hd: string | null; sd: string | null; poster: string | null } | null;
}

export interface LibraryAd {
  libraryId: string;
  advertiser: { id: string | null; name: string | null; url: string | null; likes: number | null };
  active: boolean;
  /** ISO dates; `ended` only for an ad no longer running. */
  started: string | null;
  ended: string | null;
  /** Days from start to now (running) or to its end. */
  daysRunning: number | null;
  /** FACEBOOK, INSTAGRAM, AUDIENCE_NETWORK, MESSENGER, THREADS. */
  platforms: string[];
  /** Ads the library groups under this creative ("N ads use this creative"); 1 when alone. */
  versions: number;
  /** IMAGE, VIDEO, CAROUSEL, DCO, DPA… */
  format: string | null;
  headline: string | null;
  body: string | null;
  cta: string | null;
  ctaType: string | null;
  link: string | null;
  /** The shown domain. */
  caption: string | null;
  media: AdMedia;
  /** Carousel and catalog cards, each with its own text, link and media. */
  cards: AdCard[];
  /** The library's record whole. */
  raw: Obj;
}

const iso = (s: unknown) =>
  typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString().slice(0, 10) : null;

/** One library record → the fields a reader wants, the record kept whole. */
export function adOf(r: Obj, now = Date.now()): LibraryAd {
  const s = obj(r.snapshot);
  const active = r.is_active === true;
  const start = typeof r.start_date === "number" ? r.start_date : null;
  const end = typeof r.end_date === "number" ? r.end_date : null;
  const until = active || !end ? now / 1000 : end;
  const video = (v: Obj) => ({
    hd: str(v.video_hd_url),
    sd: str(v.video_sd_url),
    poster: str(v.video_preview_image_url),
  });
  const images = list(s.images)
    .map((i) => ({
      url: str(i.original_image_url) ?? str(i.resized_image_url),
      resized: str(i.resized_image_url),
    }))
    .filter((i): i is { url: string; resized: string | null } => !!i.url);
  const likes = s.page_like_count;
  return {
    libraryId: String(r.ad_archive_id ?? ""),
    advertiser: {
      id: str(r.page_id) ?? str(s.page_id),
      name: str(r.page_name) ?? str(s.page_name),
      url: str(s.page_profile_uri),
      likes: typeof likes === "number" ? likes : null,
    },
    active,
    started: iso(start),
    ended: active ? null : iso(end),
    daysRunning: start ? Math.max(0, Math.floor((until - start) / 86_400)) : null,
    platforms: Array.isArray(r.publisher_platform) ? r.publisher_platform.map(String) : [],
    versions:
      typeof r.collation_count === "number" && r.collation_count > 0 ? r.collation_count : 1,
    format: str(s.display_format),
    headline: str(s.title),
    body: str(obj(s.body).text),
    cta: str(s.cta_text),
    ctaType: str(s.cta_type),
    link: str(s.link_url),
    caption: str(s.caption),
    media: { images, videos: list(s.videos).map(video) },
    cards: list(s.cards).map((c) => {
      const v = video(c);
      return {
        headline: str(c.title),
        body: str(c.body),
        cta: str(c.cta_text),
        link: str(c.link_url),
        caption: str(c.caption),
        image: str(c.original_image_url) ?? str(c.resized_image_url),
        video: v.hd || v.sd ? v : null,
      };
    }),
    raw: r,
  };
}

export interface Connection {
  count: number | null;
  records: Obj[];
  cursor: string | null;
}

/** Every `search_results_connection` in a parsed body (script or GraphQL answer). */
export function connectionsOf(root: unknown): Connection[] {
  const out: Connection[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 60) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Obj;
    const c = o.search_results_connection;
    if (c && typeof c === "object") {
      const conn = obj(c);
      const info = obj(conn.page_info);
      out.push({
        count: typeof conn.count === "number" ? conn.count : null,
        records: list(conn.edges).flatMap((e) => list(obj(e.node).collated_results)),
        cursor: info.has_next_page === true ? str(info.end_cursor) : null,
      });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** A GraphQL answer: one JSON, or several on their own lines (Facebook streams parts). */
export function jsonLines(text: string): unknown[] {
  const body = text.replace(/^for \(;;\);/, "");
  try {
    return [JSON.parse(body)];
  } catch {
    return body
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
  }
}

export interface LibraryQuery {
  /** Keyword search. */
  q?: string;
  /** An advertiser: its page id, or its page URL or username. */
  page?: string;
  /** ISO country, or ALL. */
  country?: string;
  /** Ended ads too. */
  inactive?: boolean;
  max?: number;
}

/** The library's search page for a keyword or one page's ads. */
export function libraryUrl(o: {
  q?: string;
  pageId?: string;
  country: string;
  inactive: boolean;
}): string {
  const p = new URLSearchParams({
    active_status: o.inactive ? "all" : "active",
    ad_type: "all",
    country: o.country,
    media_type: "all",
  });
  if (o.pageId) {
    p.set("search_type", "page");
    p.set("view_all_page_id", o.pageId);
  } else {
    p.set("q", o.q ?? "");
    p.set("search_type", "keyword_unordered");
  }
  return `${WEB}/ads/library/?${p}`;
}

/** A page id as given, else the page URL or username to fetch for it. */
export function pageRef(page: string): { id: string } | { url: string } {
  const t = page.trim();
  if (/^\d{5,25}$/.test(t)) return { id: t };
  const m = t.match(/[?&](?:view_all_page_id|id)=(\d{5,25})/);
  if (m) return { id: m[1] as string };
  const path = t.replace(/^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\//i, "").replace(/^@/, "");
  return { url: `${WEB}/${path.replace(/^\/+/, "")}` };
}

const PAGE_ID = `(() => {
  const h = document.documentElement.innerHTML;
  const m = h.match(/"delegate_page":\\{"id":"(\\d+)"/) || h.match(/"pageID":"(\\d+)"/);
  return m ? m[1] : null;
})()`;

const FIRST = `[...document.scripts]
  .map((s) => s.textContent || "")
  .filter((t) => t.includes("search_results_connection"))
  .map((t) => { try { return JSON.parse(t); } catch { return null; } })
  .filter(Boolean)`;

async function resolvePage(fp: FlowPage, page: string): Promise<string | null> {
  const ref = pageRef(page);
  if ("id" in ref) return ref.id;
  await fp.open(ref.url, SIGNED_OUT_OK);
  return (await fp.page.evaluate(PAGE_ID).catch(() => null)) as string | null;
}

export interface AdLibrary {
  query: { q: string | null; page: string | null; country: string; inactive: boolean };
  /** The advertiser's page id the search ran on (a `page` search). */
  pageId: string | null;
  found: boolean;
  /** Results the library counts for the search. */
  total: number | null;
  ads: LibraryAd[];
  /** Result answers read: the page's own, then each paging answer (up to 30 ads each). */
  pages: number;
}

export const fbAdLibrary = defineFlow<LibraryQuery, AdLibrary>({
  site: "fb-public",
  name: "ad-library",
  strategies: ["intercept"],
  async run(fp, { q, page, country, inactive, max }) {
    const cc = country ?? "US";
    const all = inactive === true;
    const cap = Math.min(Math.max(1, max ?? PER_PAGE), 600);
    const query = { q: q ?? null, page: page ?? null, country: cc, inactive: all };
    if (!q && !page) throw new Error("ad library: give q or page");
    const pageId = page ? await resolvePage(fp, page) : null;
    if (page && !pageId)
      return { query, pageId: null, found: false, total: null, ads: [], pages: 0 };

    const seen = new Map<string, Obj>();
    let total: number | null = null;
    let cursor: string | null = null;
    let pages = 0;
    const take = (c: Connection) => {
      pages++;
      total ??= c.count;
      cursor = c.cursor;
      for (const r of c.records) {
        const id = String(r.ad_archive_id ?? "");
        if (id && !seen.has(id)) seen.set(id, r);
      }
    };
    const pending: Promise<void>[] = [];
    const onResponse = (res: import("playwright").Response) => {
      if (!/\/api\/graphql\/?(\?|$)/.test(res.url())) return;
      if (!/AdLibrarySearchPaginationQuery/.test(res.request().postData() ?? "")) return;
      pending.push(
        res
          .text()
          .then((t) => {
            for (const j of jsonLines(t)) for (const c of connectionsOf(j)) take(c);
          })
          .catch(() => undefined),
      );
    };
    fp.page.on("response", onResponse);
    try {
      await fp.open(
        libraryUrl({ ...(pageId ? { pageId } : { q: q ?? "" }), country: cc, inactive: all }),
        SIGNED_OUT_OK,
      );
      let first: unknown[] = [];
      for (let i = 0; i < 10 && !first.length; i++) {
        first = ((await fp.page.evaluate(FIRST).catch(() => [])) as unknown[]) ?? [];
        if (!first.length) await fp.wait(800);
      }
      for (const root of first) for (const c of connectionsOf(root)) take(c);
      if (!pages) {
        if (/no ads match|no results/i.test(await fp.text().catch(() => "")))
          return { query, pageId, found: true, total: 0, ads: [], pages: 0 };
        throw new RungBroke("no search_results_connection in the Ad Library page");
      }
      if (cursor && seen.size < cap)
        await scrollCollect(fp, {
          read: async () => {
            await Promise.all(pending);
            return [...seen.keys()];
          },
          key: (id) => id,
          max: cap,
          settleMs: 2_000,
          idle: 3,
        });
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    const now = Date.now();
    return {
      query,
      pageId,
      found: true,
      total,
      ads: [...seen.values()].slice(0, cap).map((r) => adOf(r, now)),
      pages,
    };
  },
});
