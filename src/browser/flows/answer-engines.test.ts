import { describe, expect, it } from "vitest";
import { cleanUrl, sourcesOf } from "./answer-engines.js";

describe("answer engine sources", () => {
  it("cuts the tracking tag and keeps the rest of the query", () => {
    expect(cleanUrl("https://playwright.dev/docs?utm_source=chatgpt.com")).toBe(
      "https://playwright.dev/docs",
    );
    expect(cleanUrl("https://a.dev/x?id=2&utm_source=chatgpt.com")).toBe("https://a.dev/x?id=2");
    expect(cleanUrl("not a url")).toBe("not a url");
  });

  it("keeps each source once, its first link text", () => {
    expect(
      sourcesOf([
        ["https://a.dev/?utm_source=chatgpt.com", " A docs "],
        ["https://a.dev/", "again"],
        ["https://b.dev/", "B"],
      ]),
    ).toEqual([
      { url: "https://a.dev/", text: "A docs" },
      { url: "https://b.dev/", text: "B" },
    ]);
  });
});
