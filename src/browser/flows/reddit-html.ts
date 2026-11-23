/**
 * Reddit reads from its HTML when `.json` is refused. Since about 2026-11 Reddit answers some
 * `.json` paths with a 403 "blocked by network security" page, signed in or out, on old and www
 * alike: a subreddit's new/hot/rising, both searches, `/api/info`, `/by_id`. Threads, user pages,
 * about, rules, `top` and the inbox still answer. The feeds (`.rss`) answer 404 on every path.
 *
 * Three pages still carry what a caller reads, each turned into the Data API's own listing:
 * - www `/svc/shreddit/community-more-posts/<sort>/`: the partial a subreddit's feed scrolls in,
 *   24 posts a page, signed in or out. Every number and the whole text body. One subreddit a page.
 * - old `/by_id/<names>`: `.thing` rows (signed in only). No text body.
 * - old `/search/`: search rows with the text body (signed in only).
 * - www `/svc/shreddit/search`: a signed-out search. Title, author, subreddit and time only.
 *
 * Honest by rule: a field the page does not show stays absent.
 */

import { decode, type Listing, mdOfHtml, num } from "./reddit-rss.js";

type Obj = Record<string, unknown>;

/** A page script's read of one fetched page. */
export interface HtmlPage<R> {
  status: number;
  /** Where the fetch landed: a login wall shows here. */
  url: string;
  rows: R[];
  /** The page's next cursor: a more-posts cursor, or an old `after` name. */
  next: string | null;
}

/** A www `<shreddit-post>`: every attribute, and its text body's HTML when it has one. */
export interface ShredditRow {
  attrs: Record<string, string>;
  body: string | null;
}

/** An old `.thing` row (a listing or `/by_id`). */
export interface OldThingRow {
  attrs: Record<string, string>;
  cls: string;
  title: string | null;
  flair: string | null;
  body: string | null;
}

/** An old search row: what its header and meta line say. */
export interface OldSearchRow {
  name: string;
  title: string | null;
  titleHref: string | null;
  link: string | null;
  score: string | null;
  comments: string | null;
  commentsHref: string | null;
  time: string | null;
  author: string | null;
  authorCls: string | null;
  sub: string | null;
  flair: string | null;
  body: string | null;
}

/** A www search unit: its tracking context (post, author, subreddit) and what the row shows. */
export interface WwwSearchRow {
  ctx: string | null;
  href: string | null;
  time: string | null;
  counts: string | null;
}

export type RowKind = "shreddit" | "old" | "oldSearch" | "wwwSearch";

const WWW = "https://www.reddit.com";

const secs = (iso: string | null | undefined): number | undefined => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

const pathOf = (href: string | null | undefined): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href, WWW).pathname;
  } catch {
    return undefined;
  }
};

/** `/r/x/comments/…` → the full www URL, as the API's `url` gives a self post. */
const absolute = (href: string | null | undefined): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(decode(href), WWW).href;
  } catch {
    return undefined;
  }
};

const firstNum = (s: string | null | undefined): number | undefined => {
  const m = s ? /-?[\d,.]+\s*[kKmM]?/.exec(s) : null;
  if (!m) return undefined;
  const raw = m[0].replace(/[,\s]/g, "");
  const mult = /k$/i.test(raw) ? 1e3 : /m$/i.test(raw) ? 1e6 : 1;
  const n = Number(raw.replace(/[kKmM]$/, ""));
  return Number.isFinite(n) ? Math.round(n * mult) : undefined;
};

const defined = (o: Obj): Obj => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

const has = (a: Record<string, string>, k: string) => Object.hasOwn(a, k);

const listing = (children: Array<{ kind: string; data: Obj }>, after: string | null): Listing => ({
  kind: "Listing",
  data: { after, before: null, children },
});

/** A `<shreddit-post>` as the Data API's t3 thing. */
export function thingOfShreddit(r: ShredditRow): { kind: string; data: Obj } | null {
  const a = r.attrs;
  const name = a.id ?? "";
  if (!/^t3_[a-z0-9]+$/.test(name)) return null;
  const domain = a.domain;
  const isSelf = a["post-type"] === "text" || (domain?.startsWith("self.") ?? false);
  return {
    kind: "t3",
    data: defined({
      id: name.slice(3),
      name,
      title: a["post-title"],
      selftext: r.body ? mdOfHtml(r.body) : isSelf ? "" : undefined,
      author: a.author,
      author_fullname: a["author-id"],
      permalink: a.permalink,
      url: absolute(a["content-href"]),
      subreddit: a["subreddit-name"],
      subreddit_id: a["subreddit-id"],
      created_utc: secs(a["created-timestamp"]),
      score: num(a.score),
      upvote_ratio: num(a["upvote-ratio"]),
      num_comments: num(a["comment-count"]),
      is_self: isSelf,
      over_18: has(a, "nsfw"),
      spoiler: has(a, "spoiler"),
      domain,
      post_hint: a["post-type"],
    }),
  };
}

/** An old `.thing` row as the Data API's t3 thing. Promoted rows (ads) are none. */
export function thingOfOld(r: OldThingRow): { kind: string; data: Obj } | null {
  const a = r.attrs;
  const name = a["data-fullname"] ?? "";
  if (!/^t3_[a-z0-9]+$/.test(name) || a["data-promoted"] === "true") return null;
  const domain = a["data-domain"];
  const isSelf = domain?.startsWith("self.") ?? false;
  const cls = ` ${r.cls} `;
  const ms = num(a["data-timestamp"]);
  return {
    kind: "t3",
    data: defined({
      id: name.slice(3),
      name,
      title: r.title ?? undefined,
      selftext: r.body ? mdOfHtml(r.body) : undefined,
      author: a["data-author"],
      author_fullname: a["data-author-fullname"],
      permalink: a["data-permalink"],
      url: absolute(a["data-url"]),
      subreddit: a["data-subreddit"],
      subreddit_id: a["data-subreddit-fullname"],
      created_utc: ms === undefined ? undefined : Math.floor(ms / 1000),
      score: num(a["data-score"]),
      num_comments: num(a["data-comments-count"]),
      num_crossposts: num(a["data-num-crossposts"]),
      is_self: isSelf,
      over_18: a["data-nsfw"] === undefined ? undefined : a["data-nsfw"] === "true",
      spoiler: a["data-spoiler"] === undefined ? undefined : a["data-spoiler"] === "true",
      stickied: cls.includes(" stickied "),
      locked: cls.includes(" locked "),
      link_flair_text: r.flair ?? undefined,
      domain,
    }),
  };
}

/** An old search row as the Data API's t3 thing. */
export function thingOfOldSearch(r: OldSearchRow): { kind: string; data: Obj } | null {
  if (!/^t3_[a-z0-9]+$/.test(r.name)) return null;
  const permalink = pathOf(r.commentsHref ?? r.titleHref);
  const sub = r.sub?.replace(/^\/?r\//, "") ?? undefined;
  const link = absolute(r.link);
  const isSelf = !link;
  const author = /\bid-(t2_[a-z0-9]+)\b/.exec(r.authorCls ?? "")?.[1];
  return {
    kind: "t3",
    data: defined({
      id: r.name.slice(3),
      name: r.name,
      title: r.title ?? undefined,
      selftext: r.body ? mdOfHtml(r.body) : isSelf ? "" : undefined,
      author: r.author ?? undefined,
      author_fullname: author,
      permalink,
      url: link ?? absolute(permalink),
      subreddit: sub,
      created_utc: secs(r.time),
      score: firstNum(r.score),
      num_comments: r.comments ? (firstNum(r.comments) ?? 0) : undefined,
      is_self: isSelf,
      link_flair_text: r.flair ?? undefined,
      domain: isSelf && sub ? `self.${sub}` : link ? new URL(link).hostname : undefined,
    }),
  };
}

/** A www search unit as the Data API's t3 thing: its tracking context names post, author, sub. */
export function thingOfWwwSearch(r: WwwSearchRow): { kind: string; data: Obj } | null {
  let ctx: Obj;
  try {
    ctx = JSON.parse(decode(r.ctx ?? "")) as Obj;
  } catch {
    return null;
  }
  const post = (ctx.post ?? {}) as Obj;
  const profile = (ctx.profile ?? {}) as Obj;
  const sub = (ctx.subreddit ?? {}) as Obj;
  const name = typeof post.id === "string" ? post.id : "";
  if (!/^t3_[a-z0-9]+$/.test(name)) return null;
  const counts = r.counts ?? "";
  const votes = /([\d.,]+\s*[kKmM]?)\s*votes?/.exec(counts)?.[1];
  const comments = /([\d.,]+\s*[kKmM]?)\s*comments?/.exec(counts)?.[1];
  const permalink = pathOf(r.href);
  return {
    kind: "t3",
    data: defined({
      id: name.slice(3),
      name,
      title: typeof post.title === "string" ? post.title : undefined,
      author: typeof profile.name === "string" ? profile.name : undefined,
      author_fullname: typeof profile.id === "string" ? profile.id : undefined,
      permalink,
      url: absolute(permalink),
      subreddit: typeof sub.name === "string" ? sub.name : undefined,
      subreddit_id: typeof sub.id === "string" ? sub.id : undefined,
      created_utc: secs(r.time),
      score: firstNum(votes),
      num_comments: firstNum(comments),
      over_18: typeof post.nsfw === "boolean" ? post.nsfw : undefined,
      spoiler: typeof post.spoiler === "boolean" ? post.spoiler : undefined,
    }),
  };
}

const THINGS: Record<RowKind, (r: never) => { kind: string; data: Obj } | null> = {
  shreddit: thingOfShreddit,
  old: thingOfOld,
  oldSearch: thingOfOldSearch,
  wwwSearch: thingOfWwwSearch,
};

/** Rows as the Data API's things, each post once, page order kept. */
export function thingsOf(
  kind: RowKind,
  rows: readonly unknown[],
): Array<{ kind: string; data: Obj }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; data: Obj }> = [];
  for (const r of rows) {
    const t = THINGS[kind](r as never);
    const name = t?.data.name;
    if (!t || typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    out.push(t);
  }
  return out;
}

/**
 * Things as the Data API's listing, cut to `limit`. `after` is the last thing's name when more
 * may follow (the API's own rule: a full page has a next one).
 */
export function listingOf(
  things: ReadonlyArray<{ kind: string; data: Obj }>,
  limit: number,
  more: boolean,
): Listing {
  const children = things.slice(0, limit);
  const last = children.at(-1)?.data.name;
  const full = more || things.length > limit;
  return listing(children, full && typeof last === "string" ? last : null);
}

/**
 * Several subreddits' posts as one listing, as `a+b+c` reads: newest first for `new`, highest
 * score first for `top`, each sub's own order taken in turn for `hot` (no shared rank exists).
 */
export function mergeSubs(
  perSub: ReadonlyArray<ReadonlyArray<{ kind: string; data: Obj }>>,
  sort: "new" | "hot" | "top",
): Array<{ kind: string; data: Obj }> {
  if (perSub.length === 1) return [...(perSub[0] ?? [])];
  if (sort === "hot") {
    const out: Array<{ kind: string; data: Obj }> = [];
    const most = Math.max(0, ...perSub.map((s) => s.length));
    for (let i = 0; i < most; i++) for (const s of perSub) if (s[i]) out.push(s[i] as never);
    return out;
  }
  const key = sort === "new" ? "created_utc" : "score";
  return perSub.flat().sort((x, y) => (Number(y.data[key]) || 0) - (Number(x.data[key]) || 0));
}

/** The more-posts cursor for an API `after` name: the partial pages on base64 of the name. */
export const cursorOf = (after: string): string => Buffer.from(after).toString("base64");

/**
 * Runs in the page: GET `url` from this origin with the session's cookies, parse it, and read the
 * rows of `kind`. Self-contained: it is serialized into the page.
 */
export async function pageRows(a: { url: string; kind: RowKind }): Promise<HtmlPage<unknown>> {
  interface E {
    attributes: ArrayLike<{ name: string; value: string }>;
    className: string;
    textContent: string | null;
    innerHTML: string;
    getAttribute(n: string): string | null;
    querySelector(s: string): E | null;
    querySelectorAll(s: string): ArrayLike<E>;
  }
  const g = globalThis as unknown as {
    DOMParser: new () => { parseFromString(s: string, t: string): E };
  };
  const r = await fetch(a.url, { credentials: "include" });
  const text = r.status === 200 ? await r.text() : "";
  const d = new g.DOMParser().parseFromString(text, "text/html");
  const all = (s: string, root: E = d) => Array.from(root.querySelectorAll(s));
  const attrsOf = (e: E) =>
    Object.fromEntries(Array.from(e.attributes).map((x) => [x.name, x.value]));
  const txt = (e: E | null) => e?.textContent?.replace(/\s+/g, " ").trim() || null;
  let rows: unknown[] = [];
  let next: string | null = null;
  if (a.kind === "shreddit") {
    const posts = all("shreddit-post");
    rows = posts.map((p) => ({
      attrs: attrsOf(p),
      // The slot wraps the body in a link to the post: read the `.md` block inside.
      body:
        (p.querySelector('[slot="text-body"] .md') ?? p.querySelector('[slot="text-body"]'))
          ?.innerHTML ?? null,
    }));
    // The next page: base64 of the last post's name, padded (the posts' own cursor drops the
    // padding, and Reddit answers that with an empty page).
    const last = posts.at(-1)?.getAttribute("id");
    next = last ? btoa(last) : null;
  } else if (a.kind === "old") {
    rows = all("#siteTable > .thing").map((t) => ({
      attrs: attrsOf(t),
      cls: t.className,
      title: txt(t.querySelector("a.title")),
      flair: txt(t.querySelector(".linkflairlabel")),
      body: t.querySelector(".expando .usertext-body .md")?.innerHTML ?? null,
    }));
    const href = d.querySelector(".next-button a")?.getAttribute("href") ?? "";
    next = /[?&]after=([^&]+)/.exec(href)?.[1] ?? null;
  } else if (a.kind === "oldSearch") {
    rows = all(".search-result-link").map((s) => {
      const author = s.querySelector(".search-author .author");
      const title = s.querySelector("a.search-title");
      return {
        name: s.getAttribute("data-fullname") ?? "",
        title: txt(title),
        titleHref: title?.getAttribute("href") ?? null,
        link: s.querySelector("a.search-link")?.getAttribute("href") ?? null,
        score: txt(s.querySelector(".search-score")),
        comments: txt(s.querySelector(".search-comments")),
        commentsHref: s.querySelector(".search-comments")?.getAttribute("href") ?? null,
        time: s.querySelector("time[datetime]")?.getAttribute("datetime") ?? null,
        author: txt(author),
        authorCls: author?.className ?? null,
        sub: txt(s.querySelector(".search-subreddit-link")),
        flair: txt(s.querySelector(".linkflairlabel")),
        body: s.querySelector(".search-result-body .md")?.innerHTML ?? null,
      };
    });
    const href = d.querySelector('.nextprev a[rel~="next"]')?.getAttribute("href") ?? "";
    next = /[?&]after=([^&]+)/.exec(href)?.[1] ?? null;
  } else {
    rows = all('[data-testid="search-post-unit"]').map((u) => ({
      ctx:
        u
          .querySelector("search-telemetry-tracker[data-faceplate-tracking-context]")
          ?.getAttribute("data-faceplate-tracking-context") ?? null,
      href: u.querySelector('a[data-testid="post-title"]')?.getAttribute("href") ?? null,
      time: u.querySelector("faceplate-timeago")?.getAttribute("ts") ?? null,
      // `<span><faceplate-number number="227"></faceplate-number> votes</span>`: count only in the attribute
      counts:
        all('[data-testid="search-counter-row"] span', u)
          .map((e) => {
            const n = e.querySelector("faceplate-number")?.getAttribute("number");
            return n ? `${n} ${txt(e) ?? ""}` : "";
          })
          .join(" ")
          .trim() || null,
    }));
    const more = all("faceplate-partial")
      .map((p) => p.getAttribute("src") ?? "")
      .find((s) => s.includes("/svc/shreddit/search") && s.includes("cursor="));
    next = more ? (/[?&]cursor=([^&]+)/.exec(more)?.[1] ?? null) : null;
  }
  return { status: r.status, url: r.url, rows, next };
}
