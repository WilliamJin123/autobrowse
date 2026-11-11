import { describe, expect, it } from "vitest";
import { editDistance, find } from "../src/workflows/find.js";

describe("workflow find", () => {
  const items = ["tiktok-search", "indeed-search", "pinterest-search", "search"].map((name) => ({
    name,
    site: null,
    aim: "search things",
  }));

  it("ranks a whole name within the typo budget before token hits", () => {
    expect(find(items, "serch")[0]?.name).toBe("search");
    expect(find(items, "search")[0]?.name).toBe("search");
    expect(find(items, "serch", 2).map((t) => t.name)).toContain("search");
  });

  it("counts edits", () => {
    expect(editDistance("serch", "search")).toBe(1);
    expect(editDistance("", "ab")).toBe(2);
  });
});
