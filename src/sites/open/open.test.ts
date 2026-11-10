import { describe, expect, it } from "vitest";
import { challengeUrlOf } from "../../browser/flows/page-api.js";
import { arxivFeed, arxivIdOf } from "./arxiv.js";
import { listOf, parseXml, qs } from "./kit.js";
import { abstractOf } from "./openalex.js";
import { noteKind, notesOf } from "./openreview.js";
import { abstractText, pubmedTerm } from "./pubmed.js";

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
