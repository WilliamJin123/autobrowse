import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkExpect,
  EXPECT_FILE,
  readExpect,
  seedExpect,
  writeExpect,
} from "../src/workflows/expect.js";
import { isProven, type Proof, proofLine } from "../src/workflows/proof.js";

describe("proof fixtures (U16)", () => {
  const good = {
    url: "https://example.com/item/1",
    count: "1,204",
    rows: JSON.stringify([{ a: 1 }, { a: 2 }]),
    note: "",
  };
  const seeded = seedExpect(good, "2026-11-10T00:00:00.000Z");

  it("seeds types, not-empty, shapes and row counts from a good output", () => {
    expect(seeded.fields).toEqual({
      url: { type: "string", notEmpty: true, pattern: "^https?://" },
      count: { type: "string", notEmpty: true, pattern: "^-?[\\d,]+(\\.\\d+)?$" },
      rows: { type: "array", notEmpty: true, rowCount: { min: 1 } },
      note: { type: "string" },
    });
    expect(seeded.mustNotContain).toContain("sign in to");
    expect(checkExpect(seeded, good)).toEqual([]);
  });

  it("fails a wall read as data, an empty list, a missing field", () => {
    expect(
      checkExpect(seeded, {
        url: "Sign in to continue",
        count: "12",
        rows: "[]",
        note: "x",
      }),
    ).toEqual([
      "url: does not match /^https?:///",
      "rows: empty",
      "rows: 0 rows, want ≥1",
      'output holds "sign in to"',
    ]);
    expect(checkExpect(seeded, { url: "https://x.co" })).toEqual([
      "count: missing",
      "rows: missing",
      "note: missing",
    ]);
    expect(checkExpect(seeded, null)).toEqual(["no output"]);
  });

  it("a fixture is written once, never over a person's edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expect-"));
    try {
      await writeExpect(dir, seeded);
      await expect(writeExpect(dir, { ...seeded, mustNotContain: [] })).rejects.toThrow();
      expect((await readExpect(dir))?.mustNotContain).toEqual(seeded.mustNotContain);
      expect(readFileSync(join(dir, EXPECT_FILE), "utf8")).toContain('"seededFrom"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a done proof off its fixture is not proven", () => {
    const p: Proof = { at: "2026-11-10T00:00", status: "done", steps: [], output: null };
    expect(isProven(p)).toBe(true);
    const off = { ...p, expect: { ok: false, failed: ["rows: empty"] } };
    expect(isProven(off)).toBe(false);
    expect(proofLine(off)).toBe("proof off its fixture (expect.json): rows: empty");
  });
});
