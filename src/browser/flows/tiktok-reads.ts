/**
 * TikTok reads in the signed-in tiktok profile (OpenCLI port). Mapped live 2026-11-10:
 * - a profile page carries `webapp.user-detail.userInfo` (user, stats, statsV2) in
 *   `#__UNIVERSAL_DATA_FOR_REHYDRATION__`;
 * - its grid is `[data-e2e=user-post-item] a`; more pages come by `/api/post/item_list/` as it scrolls
 *   (signed by the page: no call of ours can make one, so the flow keeps the page's own);
 * - Explore loads `POST /api/prefetch/explore/item_list` (or `/api/explore/item_list/`);
 * - every signed-in page polls `/api/notice/multi` (`notice_lists`).
 * Bodies stay whole.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { type Fell, ladder, RungBroke, type Strategy } from "../ladder.js";
import { captureJson } from "../page-json.js";
import { scrollCollect } from "../scroll-collect.js";

const WEB = "https://www.tiktok.com";
const SIGNED_OUT = /\/login\b/;
const ITEM_LIST = /^https:\/\/www\.tiktok\.com\/api\/post\/item_list\//;
const EXPLORE = /^https:\/\/www\.tiktok\.com\/api\/(prefetch\/)?explore\/item_list\b/;
const NOTICES = /^https:\/\/www\.tiktok\.com\/api\/notice\/multi\b/;

const signedOut = (fp: FlowPage) =>
  fp.human("TikTok is signed out on this profile: `autobrowse login tiktok`");

const REHYDRATION = `(() => {
  const s = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (!s) return null;
  try { return JSON.parse(s.textContent || "null"); } catch { return null; }
})()`;

/** The profile's `userInfo` from the page's rehydration data; null for none or another page. */
export function userInfoOf(data: unknown): {
  info: Record<string, unknown> | null;
  status: number | null;
} {
  const ud = (data as { __DEFAULT_SCOPE__?: Record<string, unknown> })?.__DEFAULT_SCOPE__?.[
    "webapp.user-detail"
  ] as { statusCode?: unknown; userInfo?: unknown } | undefined;
  if (!ud) return { info: null, status: null };
  const status = typeof ud.statusCode === "number" ? ud.statusCode : null;
  const info =
    ud.userInfo && typeof ud.userInfo === "object"
      ? (ud.userInfo as Record<string, unknown>)
      : null;
  return { info: info && (info as { user?: unknown }).user ? info : null, status };
}

/** Video items in an item-list answer, whole, by `id`. */
export function itemsOf(body: unknown, into = new Map<string, Record<string, unknown>>()) {
  const list =
    (body as { itemList?: unknown; item_list?: unknown })?.itemList ??
    (body as { item_list?: unknown })?.item_list;
  for (const i of Array.isArray(list) ? list : []) {
    const id = (i as { id?: unknown })?.id;
    if ((typeof id === "string" || typeof id === "number") && !into.has(String(id)))
      into.set(String(id), i as Record<string, unknown>);
  }
  return into;
}

const handleOf = (u: string) => u.replace(/^@/, "");

export interface TiktokUserInput {
  username: string;
}

export interface TiktokUser {
  username: string;
  found: boolean;
  /** `userInfo` whole: `user`, `stats`, `statsV2`. */
  info: Record<string, unknown> | null;
}

async function openProfile(fp: FlowPage, username: string): Promise<TiktokUser | "signed_out"> {
  await fp.open(`${WEB}/@${encodeURIComponent(username)}`);
  if (SIGNED_OUT.test(fp.url())) return "signed_out";
  const { info, status } = userInfoOf(await fp.page.evaluate(REHYDRATION).catch(() => null));
  // 10202: no such user; 10221/10222: banned or private shell.
  if (!info) {
    if (status !== null && status !== 0) return { username, found: false, info: null };
    throw new RungBroke("no user-detail in the page's rehydration data");
  }
  return { username, found: true, info };
}

export const tiktokUser = defineFlow<TiktokUserInput, TiktokUser>({
  site: "tiktok",
  name: "user",
  strategies: ["cookie"],
  async run(fp, { username }) {
    const u = await openProfile(fp, handleOf(username));
    return u === "signed_out" ? signedOut(fp) : u;
  },
});

export interface TiktokVideosInput {
  username: string;
  max?: number;
}

export interface TiktokVideos {
  username: string;
  found: boolean;
  via?: Strategy;
  fell: Fell[];
  /** Video urls in grid order. */
  urls: string[];
  /** Items whole from the page's item lists (intercept); empty from ui. */
  items: Record<string, unknown>[];
}

export const tiktokVideos = defineFlow<TiktokVideosInput, TiktokVideos>({
  site: "tiktok",
  name: "videos",
  strategies: ["intercept", "ui"],
  async run(fp, { username, max }) {
    const name = handleOf(username);
    const cap = Math.min(Math.max(1, max ?? 60), 1000);
    const seen = new Map<string, Record<string, unknown>>();
    const grid = async () =>
      (
        (await fp.page
          .evaluate(
            `[...document.querySelectorAll('[data-e2e=user-post-item] a[href*="/video/"]')].map((a) => a.href)`,
          )
          .catch(() => [])) as string[]
      ).filter(Boolean);
    let opened: TiktokUser | "signed_out" | null = null;
    const { result } = await captureJson(
      fp,
      { match: ITEM_LIST, keep: (j) => itemsOf(j).size > 0 },
      async (bodies) => {
        opened = await openProfile(fp, name);
        if (opened === "signed_out" || !opened.found) return { rows: [] as string[] };
        // The profile's first page sits in its rehydration data on some loads.
        itemsOf({ itemList: (opened.info as { itemList?: unknown })?.itemList }, seen);
        return scrollCollect(fp, {
          read: async () => {
            for (const b of bodies) itemsOf(b, seen);
            return grid();
          },
          key: (u) => u,
          max: cap,
          settleMs: 2_000,
        });
      },
    );
    const o = opened as TiktokUser | "signed_out" | null;
    if (o === "signed_out") return signedOut(fp);
    if (!o?.found) return { username: name, found: false, fell: [], urls: [], items: [] };
    const urls = result.rows.slice(0, cap);
    const climbed = await ladder<Record<string, unknown>[]>([
      {
        strategy: "intercept",
        run: async () => {
          if (!seen.size) throw new RungBroke("no item list answer seen");
          return [...seen.values()].slice(0, cap);
        },
      },
      {
        strategy: "ui",
        run: async () => {
          if (!urls.length) throw new RungBroke("no videos in the grid");
          return [];
        },
      },
    ]).catch((err) => {
      // A profile with no videos: nothing to climb.
      if (err instanceof RungBroke && !urls.length) return null;
      throw err;
    });
    if (!climbed) return { username: name, found: true, fell: [], urls: [], items: [] };
    return {
      username: name,
      found: true,
      via: climbed.via,
      fell: climbed.fell,
      urls,
      items: climbed.value,
    };
  },
});

export interface TiktokListInput {
  max?: number;
}

export const tiktokExplore = defineFlow<
  TiktokListInput,
  { items: Record<string, unknown>[]; pages: number }
>({
  site: "tiktok",
  name: "explore",
  strategies: ["intercept"],
  async run(fp, { max }) {
    const cap = Math.min(Math.max(1, max ?? 50), 500);
    const seen = new Map<string, Record<string, unknown>>();
    const { bodies } = await captureJson(fp, { match: EXPLORE }, async (got) => {
      await fp.open(`${WEB}/explore`);
      if (SIGNED_OUT.test(fp.url())) return;
      await scrollCollect(fp, {
        read: async () => {
          for (const b of got) itemsOf(b, seen);
          return [...seen.keys()];
        },
        key: (id) => id,
        max: cap,
        settleMs: 2_500,
      });
    });
    if (SIGNED_OUT.test(fp.url())) return signedOut(fp);
    for (const b of bodies) itemsOf(b, seen);
    if (!seen.size) throw new RungBroke("no Explore item list answer seen");
    return { items: [...seen.values()].slice(0, cap), pages: bodies.length };
  },
});

/** Each notice in `notice_lists[].notice_list`, whole, by `nid`. */
export function noticesOf(body: unknown, into = new Map<string, Record<string, unknown>>()) {
  const lists = (body as { notice_lists?: unknown })?.notice_lists;
  for (const l of Array.isArray(lists) ? lists : []) {
    const items = (l as { notice_list?: unknown })?.notice_list;
    for (const n of Array.isArray(items) ? items : []) {
      const id =
        (n as { nid_str?: unknown; nid?: unknown })?.nid_str ?? (n as { nid?: unknown })?.nid;
      const key =
        typeof id === "string" || typeof id === "number"
          ? String(id)
          : JSON.stringify(n).slice(0, 200);
      if (!into.has(key)) into.set(key, n as Record<string, unknown>);
    }
  }
  return into;
}

/** Our notifications as the inbox's own `notice/multi` calls send them, whole, newest first. */
export const tiktokNotifications = defineFlow<
  TiktokListInput,
  { notices: Record<string, unknown>[]; calls: number }
>({
  site: "tiktok",
  name: "notifications",
  strategies: ["intercept"],
  async run(fp, { max }) {
    const cap = Math.min(Math.max(1, max ?? 50), 500);
    const { bodies } = await captureJson(fp, { match: NOTICES }, async (got) => {
      await fp.open(`${WEB}/foryou`);
      if (SIGNED_OUT.test(fp.url())) return;
      // The page polls the inbox after it settles.
      for (let i = 0; i < 20 && !got.length; i++) await fp.wait(1_000);
    });
    if (SIGNED_OUT.test(fp.url())) return signedOut(fp);
    if (!bodies.length) throw new RungBroke("no notice/multi answer seen");
    const seen = new Map<string, Record<string, unknown>>();
    for (const b of bodies) noticesOf(b, seen);
    return { notices: [...seen.values()].slice(0, cap), calls: bodies.length };
  },
});
