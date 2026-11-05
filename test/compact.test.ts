import { describe, expect, it } from "vitest";
import { compactText, compactValue } from "../src/explore/compact.js";

describe("compactValue", () => {
  it("keeps JSON that fits, TOON when that fits, else an even cut", () => {
    expect(compactValue({ a: 1 }, 100)).toEqual({ kind: "json", value: { a: 1 } });
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, t: `t${i}` }));
    const toon = compactValue(rows, 700);
    expect(toon).toMatchObject({ kind: "toon", even: false });
    const cut = compactValue({ rows, note: "n".repeat(5_000) }, 400);
    expect(cut).toMatchObject({ kind: "toon", even: true });
    const text = (cut as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain("_i");
    expect(text).toMatch(/ …\d+ chars… /);
  });

  it("marks the gaps in a list of plain values", () => {
    const v = compactValue(
      Array.from({ length: 1000 }, (_, i) => i),
      200,
    );
    expect((v as { text: string }).text).toMatch(/…\d+ more…/);
  });
});

describe("compactText", () => {
  it("drops a tree's deepest levels first, marking each run", () => {
    const tree = [
      "- main",
      ...Array.from(
        { length: 200 },
        (_, i) => `  - item ${i}\n    - detail ${i} ${"more words ".repeat(8)}`,
      ),
    ].join("\n");
    const out = compactText(tree, 6_000);
    expect(out.even).toBe(true);
    expect(out.text).toContain("  - item 199");
    expect(out.text).not.toContain("detail");
    expect(out.text).toContain("    …1 line…");
    // Over even the outline: the outline is sampled, both ends kept.
    const small = compactText(tree, 1_500).text;
    expect(small.length).toBeLessThanOrEqual(1_500);
    expect(small).toMatch(/^- main\n/);
    expect(small).toContain("  - item 199");
    expect(small).not.toContain("detail");
  });

  it("shortens every line alike, then samples lines evenly", () => {
    const page = Array.from({ length: 40 }, (_, i) => `para ${i} ${"word ".repeat(100)}`).join(
      "\n",
    );
    const out = compactText(page, 6_000);
    expect(out.text.length).toBeLessThanOrEqual(6_000);
    expect(out.text).toContain("para 0");
    expect(out.text).toContain("para 39");
    const many = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const sampled = compactText(many, 2_000).text;
    expect(sampled.length).toBeLessThanOrEqual(2_000);
    expect(sampled).toMatch(/^line 0\n/);
    expect(sampled).toMatch(/line 4999$/);
    expect(sampled).toMatch(/…\d+ lines…/);
  });
});
