/**
 * Skill size budget (designs/2026-11-10-pinchtab-audit.md, P12): every byte of a skill file is
 * paid on each load. A ceiling stops slow growth; a floor catches a file emptied by a bad edit.
 * Raise a ceiling only after cutting what can go.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../.claude/skills/autobrowse");
/** Bytes; 11-11 sizes plus about a fifth. */
const CEILING: Record<string, number> = { "explore.md": 28_000, "SKILL.md": 6_500 };
const DEFAULT_CEILING = 5_500;
const FLOOR = 800;
const TOTAL = 56_000;

const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const size = (f: string) => Buffer.byteLength(readFileSync(join(DIR, f), "utf8"));

describe("skill size budget (P12)", () => {
  it.each(files)("%s sits between floor and ceiling", (f) => {
    const n = size(f);
    expect(n, `${f}: ${n} bytes`).toBeGreaterThanOrEqual(FLOOR);
    expect(n, `${f}: ${n} bytes`).toBeLessThanOrEqual(CEILING[f] ?? DEFAULT_CEILING);
  });

  it("all files together stay under the total", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.reduce((a, f) => a + size(f), 0)).toBeLessThanOrEqual(TOTAL);
  });
});
