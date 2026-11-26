import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { redditRead, WWW } from "../src/browser/flows/reddit.js";
import { decode, listingFromAtom, mdOf, parseAtom } from "../src/browser/flows/reddit-rss.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/reddit/${name}`, import.meta.url), "utf8");
const NEW = fixture("new-feed.xml");
const THREAD = fixture("thread.xml");
const SUBS = fixture("subreddits.xml");

describe("parseAtom", () => {
  it("reads each entry's id, author, sub, link, times and title; content comes back as HTML", () => {
    const [a, b, c] = parseAtom(NEW);
    expect(a).toMatchObject({
      id: "t3_aaa111",
      author: "example_poster_1",
      sub: "examplesub",
      href: "https://www.reddit.com/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      published: "2026-01-05T12:10:00+00:00",
      title: "Invoices eat our Fridays & our nerves",
    });
    expect(a?.html).toContain('<div class="md">');
    expect(b?.id).toBe("t3_bbb222");
    // A deleted author has no <author> block.
    expect(c).toMatchObject({ id: "t3_ccc333", author: null });
  });

  it("anything that is not a feed has no entries", () => {
    for (const junk of ["", "<html>blocked</html>", "<feed></feed>", "{}"])
      expect(parseAtom(junk)).toEqual([]);
  });

  it("skips an entry whose id is not a thing name", () => {
    expect(parseAtom("<feed><entry><id>/r/x/</id><title>t</title></entry></feed>")).toEqual([]);
  });
});

describe("decode", () => {
  it("turns named, decimal and hex entities into characters, one level", () => {
    expect(decode("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x27;f&#x27;")).toBe(
      `a & b <c> "d" 'e' 'f'`,
    );
    expect(decode("&amp;amp;")).toBe("&amp;");
    expect(decode("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
  });
});

describe("mdOf", () => {
  it("keeps paragraphs, bold, links and bullets as markdown; entities decode", () => {
    const [a] = parseAtom(NEW);
    expect(mdOf(a?.html ?? "")).toBe(
      [
        "We're a 3-person shop & invoices eat our Fridays.",
        "",
        "Anyone automate this? See [this guide](https://example.com/guide?a=1&b=2) or **ask** me.",
        "",
        "- quotes",
        "- invoices",
      ].join("\n"),
    );
  });

  it("is empty for a link post, which carries no body", () => {
    const [, b] = parseAtom(NEW);
    expect(mdOf(b?.html ?? "")).toBe("");
  });

  it("keeps quotes, headings, code and a bare URL", () => {
    const html =
      '<!-- SC_OFF --><div class="md"><h2>Plan</h2><blockquote><p>said</p></blockquote><p>run <code>x</code> at <a href="https://e.test/a">https://e.test/a</a></p><pre><code>a &lt; b\n</code></pre></div><!-- SC_ON -->';
    expect(mdOf(html)).toBe("## Plan\n\n> said\n\nrun `x` at https://e.test/a\n\n```\na < b\n```");
  });
});

describe("listingFromAtom", () => {
  it("is the Data API's listing: self post, link post, deleted author", () => {
    const l = listingFromAtom(NEW, { limit: 25 });
    expect(l.kind).toBe("Listing");
    expect(l.data.after).toBeNull();
    expect(l.data.children.map((c) => c.kind)).toEqual(["t3", "t3", "t3"]);
    const [a, b, c] = l.data.children.map((x) => x.data);
    expect(a).toMatchObject({
      id: "aaa111",
      name: "t3_aaa111",
      title: "Invoices eat our Fridays & our nerves",
      author: "example_poster_1",
      subreddit: "examplesub",
      permalink: "/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      url: "https://www.reddit.com/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      created_utc: Date.parse("2026-01-05T12:10:00+00:00") / 1000,
      is_self: true,
      domain: "self.examplesub",
    });
    expect(String(a?.selftext)).toContain("invoices eat our Fridays");
    expect(b).toMatchObject({
      url: "https://www.example.org/tools/scheduler?x=1&y=2",
      is_self: false,
      domain: "example.org",
      selftext: "",
    });
    expect(c).not.toHaveProperty("author");
  });

  it("never invents numbers the feed lacks", () => {
    const [a] = listingFromAtom(NEW).data.children.map((c) => c.data);
    for (const k of [
      "score",
      "num_comments",
      "upvote_ratio",
      "locked",
      "archived",
      "stickied",
      "over_18",
      "removed_by_category",
      "link_flair_text",
    ])
      expect(a).not.toHaveProperty(k);
  });

  it("`after` is the last name only when the feed is full", () => {
    expect(listingFromAtom(NEW, { limit: 3 }).data.after).toBe("t3_ccc333");
    expect(listingFromAtom(NEW, { limit: 4 }).data.after).toBeNull();
    expect(listingFromAtom(NEW, { limit: 3, paged: false }).data.after).toBeNull();
    expect(listingFromAtom("", { limit: 3 }).data).toEqual({
      after: null,
      before: null,
      children: [],
    });
  });

  it("subreddit search: t5 things with the name, title, blurb and birthday; no member count", () => {
    const l = listingFromAtom(SUBS);
    expect(l.data.children).toEqual([
      {
        kind: "t5",
        data: {
          id: "2examp",
          name: "t5_2examp",
          display_name: "examplesub",
          title: "examplesub: Examples for tests",
          public_description: "A made-up community for tests & fixtures.",
          created_utc: Date.parse("2010-03-04T05:06:07+00:00") / 1000,
          url: "/r/examplesub/",
        },
      },
      {
        kind: "t5",
        data: {
          id: "9two",
          name: "t5_9two",
          display_name: "ExampleTwo",
          title: "ExampleTwo",
          created_utc: Date.parse("2023-05-28T17:43:47+00:00") / 1000,
          url: "/r/ExampleTwo/",
        },
      },
    ]);
  });
});

/** A fake www page: `page.evaluate` runs the flow's own script against stubbed `fetch`. */
function wwwPage(o: { json?: number; feeds?: Record<string, { status: number; text?: string }> }) {
  let url = "about:blank";
  const fetched: string[] = [];
  const opens: string[] = [];
  vi.stubGlobal("fetch", async (u: string) => {
    fetched.push(u);
    const feed = Object.entries(o.feeds ?? {}).find(([k]) => u.includes(k));
    const a = u.includes(".json")
      ? {
          status: o.json ?? 403,
          text: o.json === 200 ? '{"kind":"Listing","data":{"children":[]}}' : "",
        }
      : (feed?.[1] ?? { status: 404 });
    return {
      status: a.status,
      url: u,
      ok: a.status >= 200 && a.status < 300,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => a.text ?? "",
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
      url = u;
    },
    url: () => url,
  } as unknown as FlowPage;
  return { fp, fetched, opens };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("reddit/read signed out, `.json` refused", () => {
  it("subreddit search uses its feed, without a page", async () => {
    const p = wwwPage({ feeds: { "/subreddits/search/.rss": { status: 200, text: SUBS } } });
    const out = (await redditRead.run(p.fp, {
      path: "/subreddits/search",
      query: { q: "small business", limit: 10 },
      signedOut: true,
    })) as ReturnType<typeof listingFromAtom>;
    // %20, not +: the same rule the .json read follows.
    expect(p.fetched[1]).toBe(`${WWW}/subreddits/search/.rss?q=small%20business&limit=10`);
    expect(out.data.children.map((c) => c.kind)).toEqual(["t5", "t5"]);
    expect(p.opens).toEqual([`${WWW}/`]);
  });

  it("a user's overview is their own feed: posts and comments together, one fetch", async () => {
    const p = wwwPage({ feeds: { "/user/example_user/.rss": { status: 200, text: THREAD } } });
    const out = (await redditRead.run(p.fp, {
      path: "/user/example_user/overview",
      query: { limit: 20, sort: "new" },
      signedOut: true,
    })) as ReturnType<typeof listingFromAtom>;
    expect(p.fetched[1]).toBe(`${WWW}/user/example_user/.rss?limit=20&sort=new`);
    const kinds = out.data.children.map((c) => c.kind);
    expect(kinds).toContain("t3");
    expect(kinds).toContain("t1");
    expect(p.fetched).toHaveLength(2);
  });

  it("a feed 404 is a block: every feed is gone, not this one thing", async () => {
    const p = wwwPage({ feeds: { "/user/example_user/submitted/.rss": { status: 404 } } });
    await expect(
      redditRead.run(p.fp, { path: "/user/example_user/submitted", signedOut: true }),
    ).rejects.toMatchObject({ code: "platform_blocked" });
  });

  it("any other feed status fails the read", async () => {
    const p = wwwPage({ feeds: { "/user/example_user/submitted/.rss": { status: 429 } } });
    await expect(
      redditRead.run(p.fp, { path: "/user/example_user/submitted", signedOut: true }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("an answering `.json` is still the way, feeds untouched", async () => {
    const p = wwwPage({ json: 200 });
    await redditRead.run(p.fp, { path: "/user/example_user/submitted", signedOut: true });
    expect(p.fetched).toHaveLength(1);
  });
});
