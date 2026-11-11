import { describe, expect, it } from "vitest";
import { judge } from "../src/browser/article.js";

describe("article text (P7)", () => {
  it("a skip from Readability's pre-check is no article, with its why", () => {
    expect(judge({ skip: "not an article (Readability's pre-check)", pageChars: 9_000 })).toEqual({
      article: false,
      why: "not an article (Readability's pre-check)",
    });
  });
  it("an article under 25 % of a long page is a bad cut", () => {
    expect(judge({ text: "x".repeat(200), pageChars: 1_000 })).toMatchObject({ article: false });
  });
  it("a short page keeps what Readability found", () => {
    expect(judge({ text: "short", title: "T", pageChars: 300 })).toMatchObject({
      article: true,
      title: "T",
      text: "short",
    });
  });
  it("keeps a whole article and tidies blank runs", () => {
    const a = judge({ text: `${"para ".repeat(100)}\n\n\n\nend`, pageChars: 800 });
    expect(a).toMatchObject({ article: true });
    expect(a.article && a.text.endsWith("\n\nend")).toBe(true);
  });
});
