import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SiteApi } from "./types.js";
import { portedOf, upstreamDue, WEEK_MS } from "./upstream.js";

const route = (path: string, ported?: string) => ({
  method: "GET" as const,
  path,
  summary: "",
  request: undefined as never,
  ...(ported ? { ported } : {}),
});

describe("portedOf", () => {
  it("groups routes by the file and sha they came from", () => {
    const got = portedOf([
      {
        site: "a",
        routes: [
          route("/x", "clis/a/x.js@9bc5f5c"),
          route("/y", "clis/a/x.js@9bc5f5c"),
          route("/z"),
        ] as unknown as SiteApi["routes"],
      },
    ]);
    expect(got).toEqual([
      { file: "clis/a/x.js", sha: "9bc5f5c", routes: ["a GET /x", "a GET /y"] },
    ]);
  });

  it("refuses a ported value that names no file and sha", () => {
    expect(() =>
      portedOf([{ site: "a", routes: [route("/x", "a/x.js")] as unknown as SiteApi["routes"] }]),
    ).toThrow(/clis\/<path>@<sha>/);
  });
});

describe("upstreamDue", () => {
  it("is due with no check, or one a week old", () => {
    const dir = mkdtempSync(join(tmpdir(), "upstream-"));
    const file = join(dir, "s.json");
    expect(upstreamDue(Date.now(), file)).toBe(true);
    const at = Date.parse("2026-11-01T00:00:00Z");
    writeFileSync(file, JSON.stringify({ checkedAt: new Date(at).toISOString(), tasked: {} }));
    expect(upstreamDue(at + WEEK_MS - 1, file)).toBe(false);
    expect(upstreamDue(at + WEEK_MS, file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).tasked).toEqual({});
  });
});
