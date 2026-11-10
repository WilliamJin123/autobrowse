import { describe, expect, it } from "vitest";
import { challengeUrlOf } from "../../browser/flows/page-api.js";
import { arxivFeed, arxivIdOf } from "./arxiv.js";
import { postUri } from "./bluesky.js";
import { type Item, threadOf } from "./hackernews.js";
import { flag, listOf, mapLimit, parseXml, qs, rssFeed } from "./kit.js";
import { pagePath } from "./lobsters.js";
import { abstractOf } from "./openalex.js";
import { noteKind, notesOf } from "./openreview.js";
import { launchOf } from "./producthunt.js";
import { abstractText, pubmedTerm } from "./pubmed.js";
import { pubHost } from "./substack.js";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2201.00978v1</id>
    <title>One</title>
    <author><name>A</name></author>
    <link href="http://arxiv.org/abs/2201.00978v1" rel="alternate"/>
    <category term="cs.AI"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v2</id>
    <title>Two</title>
    <author><name>B</name></author><author><name>C</name></author>
  </entry>
</feed>`;

describe("kit", () => {
  it("qs drops unset values", () => {
    expect(qs({ a: "x y", b: undefined, c: "", d: 3, e: false })).toBe("a=x+y&d=3&e=false");
  });
  it("listOf makes a lone child a list", () => {
    expect(listOf(undefined)).toEqual([]);
    expect(listOf({ a: 1 })).toEqual([{ a: 1 }]);
    expect(listOf([1, 2])).toEqual([1, 2]);
  });
  it("parseXml keeps attributes under @ and values as text", () => {
    expect(parseXml(`<a n="1"><b>007</b></a>`)).toEqual({ a: { "@n": "1", b: "007" } });
  });
});

describe("arxiv", () => {
  it("keeps each entry whole, lists always lists, with its id", () => {
    const f = arxivFeed(ATOM);
    expect(f.total).toBe(2);
    expect(f.papers.map((p) => p.arxivId)).toEqual(["2201.00978v1", "2301.00001v2"]);
    expect(f.papers[0]?.author).toEqual([{ name: "A" }]);
    expect(f.papers[0]?.category).toEqual([{ "@term": "cs.AI" }]);
    expect(f.papers[1]?.author).toHaveLength(2);
    expect(f.papers[1]?.link).toEqual([]);
  });
  it("drops the Error entry an unknown id answers", () => {
    const xml = `<feed><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry></feed>`;
    expect(arxivFeed(xml).papers).toEqual([]);
    expect(arxivIdOf("https://arxiv.org/abs/2201.00978")).toBe("2201.00978");
  });
});

describe("openalex", () => {
  it("rebuilds the abstract from the inverted index", () => {
    expect(abstractOf({ world: [1], hello: [0], again: [3], "!": [2] })).toBe(
      "hello world ! again",
    );
    expect(abstractOf(null)).toBeNull();
    expect(abstractOf({})).toBeNull();
  });
});

describe("pubmed", () => {
  it("ANDs the asked filters onto the term", () => {
    expect(
      pubmedTerm({ q: "crispr", author: "Doudna J", from: 2020, type: "Review", free: true }),
    ).toBe("crispr AND Doudna J[Author] AND 2020:3000[PDAT] AND Review[PT] AND free full text[sb]");
    expect(pubmedTerm({ q: "x" })).toBe("x");
  });
  it("joins labeled abstract parts", () => {
    const a = (t: unknown) => ({ MedlineCitation: { Article: { Abstract: { AbstractText: t } } } });
    expect(abstractText(a("plain"))).toBe("plain");
    expect(
      abstractText(
        a([
          { "#text": "why", "@Label": "BACKGROUND" },
          { "#text": "what", "@Label": "RESULTS" },
        ]),
      ),
    ).toBe("BACKGROUND: why\nRESULTS: what");
    expect(abstractText({})).toBeNull();
  });
});

describe("openreview", () => {
  it("names a note's kind", () => {
    expect(noteKind({ id: "p", forum: "p" })).toBe("paper");
    expect(
      noteKind({
        id: "r",
        forum: "p",
        invitations: ["ICLR.cc/2025/Conference/Submission1/-/Official_Review"],
      }),
    ).toBe("review");
    expect(noteKind({ id: "m", forum: "p", invitations: ["X/-/Meta_Review"] })).toBe("meta_review");
    expect(noteKind({ id: "d", forum: "p", invitations: ["X/-/Decision"] })).toBe("decision");
    expect(noteKind({ id: "c", forum: "p", invitations: ["X/-/Official_Comment"] })).toBe(
      "comment",
    );
    expect(noteKind({ id: "z", forum: "p", invitations: ["X/-/Ethics_Flag"] })).toBe("ethics_flag");
    expect(noteKind({ id: "z", forum: "p" })).toBe("note");
  });
  it("tags every note and keeps the count", () => {
    const r = notesOf({
      count: 2,
      notes: [
        { id: "p", forum: "p" },
        { id: "q", forum: "p" },
      ],
    });
    expect(r.count).toBe(2);
    expect(r.notes.map((n) => n.kind)).toEqual(["paper", "note"]);
    expect(notesOf(null)).toEqual({ count: null, notes: [] });
  });
});

describe("page-api", () => {
  it("reads the challenge page from a 403's details", () => {
    const at = "https://openreview.net/challenge?redirect=x";
    expect(
      challengeUrlOf(
        JSON.stringify({ name: "ChallengeRequiredError", details: { challengeUrl: at } }),
      ),
    ).toBe(at);
    expect(
      challengeUrlOf(JSON.stringify({ details: { challengeUrl: "javascript:x" } })),
    ).toBeNull();
    expect(challengeUrlOf("<html>")).toBeNull();
  });
});

describe("kit mapLimit", () => {
  it("keeps order and never runs more than the limit", async () => {
    let now = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (x) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, x));
      now--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(most).toBe(2);
  });
});

describe("hackernews", () => {
  const items: Record<number, Item> = {
    1: { id: 1, kids: [2, 3, 4] },
    2: { id: 2, kids: [5] },
    3: { id: 3, deleted: true },
    4: { id: 4 },
    5: { id: 5, kids: [6] },
  };
  const get = async (id: number) => items[id] ?? null;
  it("walks the tree to depth, drops deleted, counts what was cut", async () => {
    const t = await threadOf(get, items[1] as Item, 2, 2);
    expect(t.replies.map((r) => r.id)).toEqual([2]);
    expect(t.more).toBe(1);
    expect(t.replies[0]?.replies.map((r) => r.id)).toEqual([5]);
    expect(t.replies[0]?.replies[0]?.replies).toEqual([]);
    expect(t.replies[0]?.replies[0]?.more).toBe(1);
    expect((await threadOf(get, items[1] as Item, 0, 9)).replies).toEqual([]);
  });
});

describe("lobsters", () => {
  it("pages the front list at /page/N, the rest under their own path", () => {
    expect(pagePath("/hottest", 1)).toBe("/hottest");
    expect(pagePath("/hottest", 2)).toBe("/page/2");
    expect(pagePath("/t/rust", 3)).toBe("/t/rust/page/3");
  });
});

describe("bluesky", () => {
  it("turns a bsky.app post link into its at:// URI", () => {
    expect(postUri("https://bsky.app/profile/a.bsky.social/post/3kx?ref=1")).toBe(
      "at://a.bsky.social/app.bsky.feed.post/3kx",
    );
    expect(postUri("at://did:plc:x/app.bsky.feed.post/y")).toBe(
      "at://did:plc:x/app.bsky.feed.post/y",
    );
  });
});

describe("substack", () => {
  it("names a publication's host", () => {
    expect(pubHost("lenny")).toBe("lenny.substack.com");
    expect(pubHost("https://www.lennysnewsletter.com/p/x")).toBe("www.lennysnewsletter.com");
  });
});

describe("rss", () => {
  it("keeps each RSS item whole, categories always a list", () => {
    const f = rssFeed(
      `<rss><channel><title>T</title><link>https://medium.com/tag/x</link><item><title>A</title><category>ai</category></item></channel></rss>`,
    );
    expect(f).toMatchObject({ found: true, title: "T" });
    expect(f.items).toEqual([{ title: "A", category: ["ai"] }]);
    expect(rssFeed(null).found).toBe(false);
  });
});

describe("producthunt", () => {
  it("reads a launch's tagline and outbound link out of the feed's content", () => {
    const entry = parseXml(`<feed><entry><id>tag:www.producthunt.com,2005:Post/42</id>
      <published>2026-11-09T00:16:41-08:00</published>
      <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/x"/>
      <title>X &amp; Co</title>
      <content type="html">&lt;p&gt; Ship &amp;amp; learn &lt;/p&gt;&lt;p&gt;&lt;a href="https://www.producthunt.com/r/p/42?app_id=339"&gt;Link&lt;/a&gt;&lt;/p&gt;</content>
      <author><name>Ana</name></author></entry></feed>`).feed as { entry: Record<string, unknown> };
    expect(launchOf(entry.entry)).toMatchObject({
      postId: "42",
      name: "X & Co",
      tagline: "Ship & learn",
      url: "https://www.producthunt.com/products/x",
      website: "https://www.producthunt.com/r/p/42?app_id=339",
      author: "Ana",
      published: "2026-11-09T00:16:41-08:00",
    });
  });
});

describe("kit flag", () => {
  it('reads "false" as false', () => {
    expect(flag(true).parse("false")).toBe(false);
    expect(flag(false).parse("true")).toBe(true);
    expect(flag(true).parse(undefined)).toBe(true);
  });
});
