/**
 * Pinterest public reads, signed out (OpenCLI port, `clis/pinterest/*`). Mapped live 2026-11-10:
 * - search: in-page GET `/resource/BaseSearchResource/get/` with `X-Requested-With` and
 *   `X-Pinterest-PWS-Handler`, paged by
 *   `resource_response.bookmark`;
 * - a profile or board page carries its data in `script#__PWS_INITIAL_PROPS__`
 *   (`initialReduxState.resources`: `UserResource`, `BoardsFeedResource`, `UserPinsResource`;
 *   `BoardResource`, `BoardFeedResource`);
 * - our own `UserResource`/`BoardsResource` calls answer 403; `BoardFeedResource` pages by the
 *   props' `nextBookmark` (signed out, the page itself stops at the login wall).
 * Items stay whole.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { RungBroke } from "../ladder.js";
import { pageJson } from "../page-json.js";

const WEB = "https://www.pinterest.com";
/** Without the handler header the resource calls answer 403 "Invalid Resource Request". */
const XHR = {
  headers: {
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-PWS-Handler": "www/search/[scope].js",
  },
};
const BOARD_XHR = {
  headers: {
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
  },
};
/** Signed out, every page shows a sign-up pop-up over the content: not a wall here. */
const SIGNED_OUT_OK = { allowWall: true };
const MISSING = /sorry! we couldn.t find that page|page not found/i;

const capOf = (max: number | undefined, def: number, most: number) =>
  Math.min(Math.max(1, max ?? def), most);

/** `resource name → first entry's data` from the page's initial props. */
const INITIAL = `(() => {
  const s = document.getElementById("__PWS_INITIAL_PROPS__");
  if (!s) return null;
  try {
    const r = JSON.parse(s.textContent || "null")?.initialReduxState?.resources || {};
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      const e = Object.values(v || {})[0];
      out[k] = { data: e?.data ?? null, bookmark: e?.nextBookmark ?? null };
    }
    return out;
  } catch { return null; }
})()`;

type Initial = Record<string, { data: unknown; bookmark: string | null }>;

/** Rows of a resource answer (`resource_response.data`: an array, or `{results}`), by `id`. */
export function rowsOf(
  data: unknown,
  into = new Map<string, Record<string, unknown>>(),
): Map<string, Record<string, unknown>> {
  const list = Array.isArray(data)
    ? data
    : ((data as { results?: unknown })?.results ?? (data as { data?: unknown })?.data);
  for (const r of Array.isArray(list) ? list : []) {
    const id = (r as { id?: unknown })?.id;
    if ((typeof id === "string" || typeof id === "number") && !into.has(String(id)))
      into.set(String(id), r as Record<string, unknown>);
  }
  return into;
}

/** A resource answer's data and next bookmark (`-end-` or none: the last page). */
export function pageOf(body: unknown): { data: unknown; bookmark: string | null } {
  const rr = (body as { resource_response?: { data?: unknown; bookmark?: unknown } })
    ?.resource_response;
  const b = rr?.bookmark;
  return {
    data: rr?.data ?? null,
    bookmark: typeof b === "string" && b && b !== "-end-" ? b : null,
  };
}

/** The search call's URL, as the page sends it. */
export function searchUrl(q: string, bookmark: string | null): string {
  const source = `/search/pins/?q=${encodeURIComponent(q)}`;
  const options = {
    query: q,
    scope: "pins",
    page_size: 25,
    ...(bookmark ? { bookmarks: [bookmark] } : {}),
  };
  return `/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(source)}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
}

async function initial(fp: FlowPage, url: string): Promise<Initial | null> {
  await fp.open(url, SIGNED_OUT_OK);
  if (MISSING.test(await fp.text().catch(() => ""))) return null;
  const got = (await fp.page.evaluate(INITIAL).catch(() => null)) as Initial | null;
  if (!got) throw new RungBroke("no __PWS_INITIAL_PROPS__ on the page");
  return got;
}

export interface PinSearch {
  q: string;
  /** Each pin whole, as the search call sends it. */
  pins: Record<string, unknown>[];
  pages: number;
}

/** Pins for a query (`BaseSearchResource`), paged by bookmark. */
export const pinterestSearch = defineFlow<{ q: string; max?: number }, PinSearch>({
  site: "pinterest",
  name: "search",
  strategies: ["cookie"],
  async run(fp, { q, max }) {
    const cap = capOf(max, 50, 500);
    await fp.open(`${WEB}/search/pins/?q=${encodeURIComponent(q)}`, SIGNED_OUT_OK);
    const seen = new Map<string, Record<string, unknown>>();
    let bookmark: string | null = null;
    let pages = 0;
    const marks = new Set<string>();
    do {
      const body = await pageJson(fp, searchUrl(q, bookmark), XHR);
      pages++;
      const p = pageOf(body);
      rowsOf(p.data, seen);
      bookmark = p.bookmark && !marks.has(p.bookmark) ? p.bookmark : null;
      if (bookmark) marks.add(bookmark);
      if (bookmark && seen.size < cap) await fp.wait(1_500 + Math.round(Math.random() * 2_500));
    } while (bookmark && seen.size < cap);
    return { q, pins: [...seen.values()].slice(0, cap), pages };
  },
});

export interface PinUser {
  username: string;
  found: boolean;
  /** `UserResource` data whole. */
  user: Record<string, unknown> | null;
  /** The profile's boards (`BoardsFeedResource`), whole. */
  boards: Record<string, unknown>[];
  /** The profile's first pins (`UserPinsResource`), whole. */
  pins: Record<string, unknown>[];
}

/** A profile: the user, its boards and first pins, off the profile page's own data. */
export const pinterestUser = defineFlow<{ username: string }, PinUser>({
  site: "pinterest",
  name: "user",
  strategies: ["cookie"],
  async run(fp, { username }) {
    const name = username.replace(/^@/, "");
    const got = await initial(fp, `${WEB}/${encodeURIComponent(name)}/`);
    const user = got?.UserResource?.data as Record<string, unknown> | null | undefined;
    if (!got || !user) return { username: name, found: false, user: null, boards: [], pins: [] };
    return {
      username: name,
      found: true,
      user,
      boards: [...rowsOf(got.BoardsFeedResource?.data).values()],
      pins: [...rowsOf(got.UserPinsResource?.data).values()],
    };
  },
});

export interface PinBoard {
  username: string;
  board: string;
  found: boolean;
  /** `BoardResource` data whole. */
  info: Record<string, unknown> | null;
  /** Pins whole: the page's first feed, then `BoardFeedResource` pages by bookmark. */
  pins: Record<string, unknown>[];
  pages: number;
}

/** The board feed call, as the board page sends it. */
export function boardFeedUrl(path: string, boardId: string, boardUrl: string, bookmark: string) {
  const options = { board_id: boardId, board_url: boardUrl, page_size: 25, bookmarks: [bookmark] };
  return `/resource/BoardFeedResource/get/?source_url=${encodeURIComponent(path)}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
}

/** A board's pins (`/<user>/<board>/`): the page's first feed, then our own feed calls. */
export const pinterestBoard = defineFlow<
  { username: string; board: string; max?: number },
  PinBoard
>({
  site: "pinterest",
  name: "board",
  strategies: ["cookie"],
  async run(fp, { username, board, max }) {
    const name = username.replace(/^@/, "");
    const cap = capOf(max, 50, 500);
    const path = `/${encodeURIComponent(name)}/${encodeURIComponent(board)}/`;
    const got = await initial(fp, `${WEB}${path}`);
    const info = (got?.BoardResource?.data ?? null) as Record<string, unknown> | null;
    if (!got || !info)
      return { username: name, board, found: false, info: null, pins: [], pages: 0 };
    const seen = rowsOf(got.BoardFeedResource?.data);
    let bookmark = got.BoardFeedResource?.bookmark ?? null;
    let pages = 1;
    const marks = new Set<string>();
    while (bookmark && seen.size < cap && !marks.has(bookmark)) {
      marks.add(bookmark);
      await fp.wait(1_500 + Math.round(Math.random() * 2_500));
      const p = pageOf(
        await pageJson(
          fp,
          boardFeedUrl(path, String(info.id), String(info.url ?? path), bookmark),
          BOARD_XHR,
        ),
      );
      pages++;
      rowsOf(p.data, seen);
      bookmark = p.bookmark;
    }
    return {
      username: name,
      board,
      found: true,
      info,
      pins: [...seen.values()].slice(0, cap),
      pages,
    };
  },
});
