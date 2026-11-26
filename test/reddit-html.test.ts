import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { redditRead, WWW } from "../src/browser/flows/reddit.js";
import { cursorOf, mergeSubs } from "../src/browser/flows/reddit-html.js";

const OLD = "https://old.reddit.com";
type Listing = {
  data: { after: string | null; children: Array<{ kind: string; data: Record<string, unknown> }> };
};

const post = (o: {
  id: string;
  sub?: string;
  type?: string;
  score?: string;
  comments?: string;
  created?: string;
  href?: string;
  body?: string;
}) => `<shreddit-post id="${o.id}" post-title="Title ${o.id}" author="example_author" author-id="t2_aaa"
  permalink="/r/${o.sub ?? "examplesub"}/comments/${o.id.slice(3)}/slug/" subreddit-name="${o.sub ?? "examplesub"}"
  subreddit-id="t5_bbb" created-timestamp="${o.created ?? "2026-11-20T10:00:00.000000+0000"}"
  score="${o.score ?? "5"}" comment-count="${o.comments ?? "2"}" upvote-ratio="0.9" post-type="${o.type ?? "text"}"
  content-href="${o.href ?? `https://www.reddit.com/r/${o.sub ?? "examplesub"}/comments/${o.id.slice(3)}/slug/`}"
  domain="${o.type === "link" ? "example.com" : `self.${o.sub ?? "examplesub"}`}">
  ${o.body ? `<div slot="text-body"><a href="/r/x/comments/1/"><div class="md"><p>${o.body}</p></div></a></div>` : ""}
</shreddit-post>`;

const ctx = (id: string, title: string) =>
  JSON.stringify({
    post: { id, nsfw: false, spoiler: false, title },
    profile: { id: "t2_ccc", name: "example_searcher" },
    subreddit: { id: "t5_ddd", name: "examplesub" },
  }).replace(/"/g, "&quot;");

const searchUnit = (id: string, votes: string, comments: string) => `
<div data-testid="search-post-unit">
  <search-telemetry-tracker data-faceplate-tracking-context="${ctx(id, `Found ${id}`)}"><h2>
    <a data-testid="post-title" href="/r/examplesub/comments/${id.slice(3)}/found/">Found</a></h2>
  </search-telemetry-tracker>
  <div data-testid="sdui-post-unit"><faceplate-timeago ts="2026-11-19T17:16:15.867000+0000"></faceplate-timeago>
    <div data-testid="search-counter-row"> <span><faceplate-number number="${votes}" pretty=""></faceplate-number> votes</span><span class="mx-2xs">·</span><span><faceplate-number number="${comments}" pretty=""></faceplate-number> comments</span> </div>
  </div>
</div>`;

const oldSearch = (id: string) => `
<div class="search-result search-result-link" data-fullname="${id}">
  <header><a class="search-title" href="/r/examplesub/comments/${id.slice(3)}/slug/">Old ${id}</a></header>
  <div class="search-result-meta"><span class="search-score">1,204 points</span>
    <a class="search-comments" href="https://old.reddit.com/r/examplesub/comments/${id.slice(3)}/slug/">31 comments</a>
    <time datetime="2026-11-18T08:00:00+00:00">x</time>
    <span class="search-author"><a class="author may-blank id-t2_eee">example_old</a></span>
    <a class="search-subreddit-link">r/examplesub</a></div>
  <div class="search-result-body"><div class="md"><p>Old <strong>body</strong></p></div></div>
</div>`;

const oldThing = (id: string, promoted = false) => `
<div class="thing link self" data-fullname="${id}" data-author="example_old" data-author-fullname="t2_eee"
  data-permalink="/r/examplesub/comments/${id.slice(3)}/slug/" data-url="/r/examplesub/comments/${id.slice(3)}/slug/"
  data-subreddit="examplesub" data-subreddit-fullname="t5_bbb" data-timestamp="1795000000000" data-score="42"
  data-comments-count="7" data-domain="self.examplesub" data-nsfw="false" data-spoiler="false"
  ${promoted ? 'data-promoted="true"' : ""}><a class="title">Thing ${id}</a></div>`;

/** A fake page: `evaluate` runs the flow's own scripts on happy-dom, against stubbed `fetch`. */
function page(routes: Record<string, { status: number; html?: string; url?: string }>, doc = "") {
  const win = new Window({ url: WWW });
  win.document.body.innerHTML = doc;
  vi.stubGlobal("DOMParser", win.DOMParser);
  vi.stubGlobal("document", win.document);
  let at = "about:blank";
  const fetched: string[] = [];
  const opens: string[] = [];
  vi.stubGlobal("fetch", async (u: string) => {
    fetched.push(u);
    const hit = Object.entries(routes).find(([k]) => u.includes(k))?.[1];
    const a = hit ?? { status: u.includes(".json") ? 403 : 404 };
    return {
      status: a.status,
      url: a.url ?? u,
      ok: a.status >= 200 && a.status < 300,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => a.html ?? "",
    };
  });
  const fp = {
    page: {
      // A string is an `inPage` expression: run it in this realm, against the stubs.
      evaluate: async (fn: string | ((a: unknown) => unknown), arg?: unknown) =>
        typeof fn === "string" ? new Function(`return ${fn}`)() : fn(arg),
    },
    async open(u: string) {
      opens.push(u);
      at = u;
    },
    url: () => at,
    wait: async () => {},
  } as unknown as FlowPage;
  return { fp, fetched, opens };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("cursorOf", () => {
  it("keeps base64 padding: the unpadded cursor gets an empty page", () => {
    expect(cursorOf("t3_abc12")).toBe("dDNfYWJjMTI=");
  });
});

describe("mergeSubs", () => {
  const t = (name: string, created: number, score: number) => ({
    kind: "t3",
    data: { name, created_utc: created, score },
  });
  const a = [t("t3_a1", 30, 1), t("t3_a2", 10, 9)];
  const b = [t("t3_b1", 20, 5)];
  it("new: newest first across subs", () => {
    expect(mergeSubs([a, b], "new").map((x) => x.data.name)).toEqual(["t3_a1", "t3_b1", "t3_a2"]);
  });
  it("top: highest score first", () => {
    expect(mergeSubs([a, b], "top").map((x) => x.data.name)).toEqual(["t3_a2", "t3_b1", "t3_a1"]);
  });
  it("hot: each sub's own order, in turn", () => {
    expect(mergeSubs([a, b], "hot").map((x) => x.data.name)).toEqual(["t3_a1", "t3_b1", "t3_a2"]);
  });
});

describe("reddit/read from HTML after a 403 on `.json`", () => {
  it("a subreddit's new: the partial's posts as API things, body as markdown, pages by padded cursor", async () => {
    const p = page({
      "after=": {
        status: 200,
        html: post({ id: "t3_ccc333" }) + post({ id: "t3_ddd444" }),
      },
      "community-more-posts/new/": {
        status: 200,
        html:
          post({
            id: "t3_aaa111",
            body: "Hello <strong>there</strong>",
            score: "11",
            comments: "4",
          }) + post({ id: "t3_bbb222", type: "link", href: "https://example.com/x" }),
      },
    });
    const out = (await redditRead.run(p.fp, {
      path: "/r/examplesub/new",
      query: { limit: 3 },
      signedOut: true,
    })) as Listing;
    expect(p.fetched[1]).toBe(`${WWW}/svc/shreddit/community-more-posts/new/?name=examplesub`);
    expect(p.fetched[2]).toContain(`after=${encodeURIComponent(btoa("t3_bbb222"))}`);
    expect(out.data.children.map((c) => c.data.name)).toEqual([
      "t3_aaa111",
      "t3_bbb222",
      "t3_ccc333",
    ]);
    expect(out.data.after).toBe("t3_ccc333");
    expect(out.data.children[0]?.data).toMatchObject({
      title: "Title t3_aaa111",
      selftext: "Hello **there**",
      score: 11,
      num_comments: 4,
      is_self: true,
      created_utc: 1795168800,
    });
    expect(out.data.children[1]?.data).toMatchObject({
      url: "https://example.com/x",
      is_self: false,
    });
    expect(out.data.children[1]?.data).not.toHaveProperty("selftext");
  });

  it("an API `after` starts the partial at its padded cursor", async () => {
    const p = page({
      "community-more-posts/top/": { status: 200, html: post({ id: "t3_eee555" }) },
    });
    await redditRead.run(p.fp, {
      path: "/r/examplesub/top",
      query: { after: "t3_abc12", t: "week" },
      signedOut: true,
    });
    expect(p.fetched[1]).toContain("t=WEEK");
    expect(p.fetched[1]).toContain(`after=${encodeURIComponent("dDNfYWJjMTI=")}`);
  });

  it("signed-out search: www units, counts from the number attributes, no `after`", async () => {
    const p = page({
      "/search/?": {
        status: 200,
        html: searchUnit("t3_fff666", "227", "92") + searchUnit("t3_ggg777", "1", "0"),
      },
    });
    const out = (await redditRead.run(p.fp, {
      path: "/search",
      query: { q: "example words", sort: "new" },
      signedOut: true,
    })) as Listing;
    expect(out.data.after).toBeNull();
    expect(out.data.children[0]?.data).toMatchObject({
      name: "t3_fff666",
      title: "Found t3_fff666",
      author: "example_searcher",
      subreddit: "examplesub",
      permalink: "/r/examplesub/comments/fff666/found/",
      score: 227,
      num_comments: 92,
      created_utc: 1795108575,
    });
    expect(out.data.children[1]?.data).toMatchObject({ score: 1, num_comments: 0 });
  });

  it("signed-in search: old result rows, with old's own `after`", async () => {
    const p = page({
      "/r/examplesub/search/": {
        status: 200,
        html: `${oldSearch("t3_hhh888")}<div class="nextprev"><a rel="nofollow next" href="${OLD}/r/examplesub/search?q=x&after=t3_hhh888">next</a></div>`,
      },
    });
    const out = (await redditRead.run(p.fp, {
      path: "/r/examplesub/search",
      query: { q: "x", limit: 1 },
    })) as Listing;
    expect(p.fetched[1]).toContain("restrict_sr=on");
    expect(out.data.after).toBe("t3_hhh888");
    expect(out.data.children[0]?.data).toMatchObject({
      title: "Old t3_hhh888",
      selftext: "Old **body**",
      score: 1204,
      num_comments: 31,
      author_fullname: "t2_eee",
      subreddit: "examplesub",
      domain: "self.examplesub",
    });
  });

  it("signed-in /api/info: old /by_id rows; ads drop out", async () => {
    const p = page({
      "/by_id/": {
        status: 200,
        html: `<div id="siteTable">${oldThing("t3_iii999")}${oldThing("t3_jjj000", true)}</div>`,
      },
    });
    const out = (await redditRead.run(p.fp, {
      path: "/api/info",
      query: { id: "t3_iii999,t3_jjj000" },
    })) as Listing;
    expect(p.fetched[1]).toBe(`${OLD}/by_id/t3_iii999,t3_jjj000`);
    expect(out.data.children.map((c) => c.data.name)).toEqual(["t3_iii999"]);
    expect(out.data.children[0]?.data).toMatchObject({
      score: 42,
      num_comments: 7,
      created_utc: 1795000000,
    });
  });

  it("signed-out thread: the rendered post and its top-level comments", async () => {
    const p = page(
      {},
      `${post({ id: "t3_kkk111", body: "Post body" })}
      <shreddit-comment thingid="t1_c1" depth="0" author="a1" score="3" permalink="/c1/" created="2026-11-20T11:00:00.000Z"><div slot="comment"><p>Top</p></div></shreddit-comment>
      <shreddit-comment thingid="t1_c2" depth="1" author="a2" score="1"><div slot="comment"><p>Reply</p></div></shreddit-comment>`,
    );
    const [first, tree] = (await redditRead.run(p.fp, {
      path: "/comments/kkk111",
      signedOut: true,
    })) as [Listing, Listing];
    expect(p.opens).toContain(`${WWW}/comments/kkk111/`);
    expect(first.data.children[0]?.data).toMatchObject({
      name: "t3_kkk111",
      selftext: "Post body",
    });
    expect(tree.data.children.map((c) => c.data)).toEqual([
      expect.objectContaining({ name: "t1_c1", body: "Top", parent_id: "t3_kkk111", score: 3 }),
    ]);
  });

  it("an HTML page that is also refused is a block; a login wall is a sign-in", async () => {
    const blocked = page({ "community-more-posts": { status: 403 } });
    await expect(
      redditRead.run(blocked.fp, { path: "/r/examplesub/hot", signedOut: true }),
    ).rejects.toMatchObject({ code: "platform_blocked" });
    const walled = page({ "/by_id/": { status: 200, url: `${OLD}/login/?dest=x` } });
    await expect(
      redditRead.run(walled.fp, { path: "/api/info", query: { id: "t3_aaa111" } }),
    ).rejects.toMatchObject({ code: "need_login" });
  });

  it("signed in, a 403 no page serves is Reddit's block", async () => {
    const p = page({});
    await expect(
      redditRead.run(p.fp, { path: "/user/example_user/submitted" }),
    ).rejects.toMatchObject({ code: "platform_blocked" });
    expect(p.fetched).toHaveLength(1);
  });
});
