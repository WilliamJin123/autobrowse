/**
 * Instagram reads of any account and of our own lists, in the signed-in profile (OpenCLI port).
 * Mapped live 2026-11-10: the username calls (`users/web_profile_info`, `web/search/topsearch`,
 * `feed/user/<name>/username`) answer 404 signed-out HTML from our profile; `users/<pk>/info`
 * answered 429. What answers: the profile page's own GraphQL (`PolarisProfilePageContentQuery`,
 * `data.user` whole, with `pk`), `friendships/<pk>/followers|following`, `discover/web/explore_grid`,
 * `feed/saved/posts`. Items stay whole.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { type Fell, ladder, RungBroke, type Strategy } from "../ladder.js";
import { captureJson, pagedJson, pageJson } from "../page-json.js";
import { IG_APP_ID } from "./instagram-act.js";

const WEB = "https://www.instagram.com";
const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;
const GRAPHQL = /^https:\/\/www\.instagram\.com\/(api\/graphql|graphql\/query)\b/;
const HEADERS = { headers: { "X-IG-App-ID": IG_APP_ID } };
/** Between list pages: 2–5 s, as a person scrolls a list. */
const PAUSE_MS: [number, number] = [2_000, 5_000];

const pause = (fp: FlowPage) =>
  fp.wait(PAUSE_MS[0] + Math.round(Math.random() * (PAUSE_MS[1] - PAUSE_MS[0])));

const signedOut = (fp: FlowPage) =>
  fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");

/** A profile query answer's user, or null for another query. */
export function profileUserOf(body: unknown, username: string): Record<string, unknown> | null {
  const u = (body as { data?: { user?: unknown } })?.data?.user;
  if (!u || typeof u !== "object") return null;
  const name = (u as { username?: unknown }).username;
  return typeof name === "string" && name.toLowerCase() === username.toLowerCase()
    ? (u as Record<string, unknown>)
    : null;
}

/** The numeric id of a profile user. */
export const pkOf = (u: Record<string, unknown>): string | null => {
  const id = u.pk ?? u.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
};

/** Every media in an answer, found by shape (`code` + `taken_at`), whole, each once. */
export function mediaOf(body: unknown, into = new Map<string, Record<string, unknown>>()) {
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.code === "string" && o.code && typeof o.taken_at === "number") {
      if (!into.has(o.code)) into.set(o.code, o);
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(body);
  return into;
}

/** The header's counts from the page's meta description: "104M Followers, 91 Following, 5,008 Posts". */
export function headerCounts(
  desc: string,
): { followers: string; following: string; posts: string } | null {
  const m =
    /([\d.,]+[KMB]?)\s+Followers,\s*([\d.,]+[KMB]?)\s+Following,\s*([\d.,]+[KMB]?)\s+Posts/i.exec(
      desc,
    );
  return m ? { followers: m[1] as string, following: m[2] as string, posts: m[3] as string } : null;
}

export interface ProfileInput {
  username: string;
}

export interface IgProfile {
  username: string;
  found: boolean;
  via?: Strategy;
  fell: Fell[];
  /** The profile query's `data.user`, whole (intercept); from ui only the header counts. */
  user: Record<string, unknown> | null;
  pk: string | null;
}

/** Opens the profile and reads its own GraphQL user; null when the page is missing. */
async function readProfile(fp: FlowPage, username: string): Promise<IgProfile | "signed_out"> {
  const url = `${WEB}/${encodeURIComponent(username)}/`;
  let missing = false;
  const climbed = await ladder<Record<string, unknown>>([
    {
      strategy: "intercept",
      run: async () => {
        const { bodies } = await captureJson(
          fp,
          { match: GRAPHQL, keep: (j) => profileUserOf(j, username) !== null },
          async () => {
            await fp.open(url);
            for (let i = 0; i < 10; i++) {
              await fp.wait(800);
              if (SIGNED_OUT.test(fp.url()) || MISSING.test(await fp.text())) return;
            }
          },
        );
        if (SIGNED_OUT.test(fp.url())) throw new RungBroke("signed out");
        if (MISSING.test(await fp.text())) {
          missing = true;
          return {};
        }
        const u = bodies.map((b) => profileUserOf(b, username)).find(Boolean);
        if (!u) throw new RungBroke("no profile GraphQL answer seen");
        return u;
      },
    },
    {
      strategy: "ui",
      run: async () => {
        if (SIGNED_OUT.test(fp.url())) throw new RungBroke("signed out");
        const desc = await fp.page
          .evaluate(
            `document.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""`,
          )
          .catch(() => "");
        const counts = headerCounts(String(desc));
        if (!counts) throw new RungBroke("no header counts");
        return { username, ...counts };
      },
    },
  ]).catch((err) => {
    if (SIGNED_OUT.test(fp.url())) return "signed_out" as const;
    throw err;
  });
  if (climbed === "signed_out") return climbed;
  if (missing) return { username, found: false, fell: [], user: null, pk: null };
  const { value, via, fell } = climbed;
  return {
    username,
    found: true,
    via,
    fell,
    user: value,
    pk: via === "intercept" ? pkOf(value) : null,
  };
}

export const instagramProfile = defineFlow<ProfileInput, IgProfile>({
  site: "instagram",
  name: "profile",
  strategies: ["intercept", "ui"],
  async run(fp, { username }) {
    const p = await readProfile(fp, username.replace(/^@/, ""));
    return p === "signed_out" ? signedOut(fp) : p;
  },
});

export interface PeopleInput {
  username: string;
  /** followers (default) or following. */
  list?: "followers" | "following";
  max?: number;
}

export interface IgPeople {
  username: string;
  list: "followers" | "following";
  found: boolean;
  pk: string | null;
  /** Each user row whole, as the friendships call sends it. */
  users: unknown[];
  pages: number;
  /** Instagram shows a big account's followers only in part ("Only <name> can see all followers"). */
  more: boolean;
}

export const instagramPeople = defineFlow<PeopleInput, IgPeople>({
  site: "instagram",
  name: "people",
  strategies: ["cookie"],
  async run(fp, { username, list, max }) {
    const which = list ?? "followers";
    const name = username.replace(/^@/, "");
    const cap = Math.min(Math.max(1, max ?? 200), 1000);
    const p = await readProfile(fp, name);
    if (p === "signed_out") return signedOut(fp);
    const none = { username: name, list: which, pk: null, users: [], pages: 0, more: false };
    if (!p.found) return { ...none, found: false };
    if (!p.pk) throw new RungBroke("no profile id: the profile query did not answer");
    type Page = { users?: unknown[]; next_max_id?: unknown; has_more?: unknown };
    let more = false;
    const { items, pages } = await pagedJson<unknown>(fp, {
      url: (after) =>
        `/api/v1/friendships/${p.pk}/${which}/?count=50${after ? `&max_id=${encodeURIComponent(after)}` : ""}`,
      items: (j) => ((j as Page).users ?? []) as unknown[],
      next: (j) => {
        const n = (j as Page).next_max_id;
        more = (j as Page).has_more === true || n != null;
        return typeof n === "string" || typeof n === "number" ? String(n) : null;
      },
      max: cap,
      pause: () => pause(fp),
      fetch: HEADERS,
    });
    return { username: name, list: which, found: true, pk: p.pk, users: items, pages, more };
  },
});

export interface GridInput {
  max?: number;
}

export interface IgGrid {
  /** Each media whole, in the order the answers gave them. */
  media: Record<string, unknown>[];
  pages: number;
}

/** Explore's grid: the page's own `discover/web/explore_grid` call, paged by `max_id`. */
export const instagramExplore = defineFlow<GridInput, IgGrid>({
  site: "instagram",
  name: "explore",
  strategies: ["cookie"],
  async run(fp, { max }) {
    const cap = Math.min(Math.max(1, max ?? 50), 500);
    await fp.open(`${WEB}/explore/`);
    if (SIGNED_OUT.test(fp.url())) return signedOut(fp);
    const seen = new Map<string, Record<string, unknown>>();
    type Page = { next_max_id?: unknown; more_available?: unknown };
    const { pages } = await pagedJson<unknown>(fp, {
      url: (after) =>
        `/api/v1/discover/web/explore_grid/${after ? `?max_id=${encodeURIComponent(after)}` : ""}`,
      items: (j) => {
        const before = seen.size;
        mediaOf(j, seen);
        return [...seen.values()].slice(before);
      },
      next: (j) => {
        const { next_max_id: n, more_available } = j as Page;
        return more_available !== false && (typeof n === "string" || typeof n === "number")
          ? String(n)
          : null;
      },
      max: cap,
      pause: () => pause(fp),
      fetch: HEADERS,
    });
    return { media: [...seen.values()].slice(0, cap), pages };
  },
});

export interface SavedInput {
  max?: number;
  /** A collection's name; omitted: all saved posts. */
  collection?: string;
}

export interface IgSaved extends IgGrid {
  collection: string | null;
  found: boolean;
}

/** Our own saved posts (all, or one collection by name): `feed/saved/posts` or `feed/collection/<id>/posts`. */
export const instagramSaved = defineFlow<SavedInput, IgSaved>({
  site: "instagram",
  name: "saved",
  strategies: ["cookie"],
  async run(fp, { max, collection }) {
    const cap = Math.min(Math.max(1, max ?? 100), 1000);
    await fp.open(`${WEB}/`);
    if (SIGNED_OUT.test(fp.url())) return signedOut(fp);
    let base = "/api/v1/feed/saved/posts/";
    if (collection) {
      type Lists = { items?: Array<{ collection_id?: unknown; collection_name?: unknown }> };
      const lists = await pageJson<Lists>(
        fp,
        `/api/v1/collections/list/?collection_types=${encodeURIComponent('["MEDIA","ALL_MEDIA_AUTO_COLLECTION"]')}`,
        HEADERS,
      );
      const hit = (lists.items ?? []).find(
        (c) => String(c.collection_name ?? "").toLowerCase() === collection.toLowerCase(),
      );
      if (!hit?.collection_id) return { collection, found: false, media: [], pages: 0 };
      base = `/api/v1/feed/collection/${encodeURIComponent(String(hit.collection_id))}/posts/`;
    }
    const seen = new Map<string, Record<string, unknown>>();
    type Page = { next_max_id?: unknown; more_available?: unknown };
    const { pages } = await pagedJson<unknown>(fp, {
      url: (after) => `${base}${after ? `?max_id=${encodeURIComponent(after)}` : ""}`,
      items: (j) => {
        const before = seen.size;
        mediaOf(j, seen);
        return [...seen.values()].slice(before);
      },
      next: (j) => {
        const { next_max_id: n, more_available } = j as Page;
        return more_available === true && (typeof n === "string" || typeof n === "number")
          ? String(n)
          : null;
      },
      max: cap,
      pause: () => pause(fp),
      fetch: HEADERS,
    });
    return {
      collection: collection ?? null,
      found: true,
      media: [...seen.values()].slice(0, cap),
      pages,
    };
  },
});
