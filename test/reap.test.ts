import { describe, expect, it } from "vitest";
import { orphanBrowsers, reapChromeClones, reapOrphans } from "../src/browser/reap.js";

const dir = "/home/u/.config/autobrowse/profiles";
const procs = [
  // Owner died: the root went to init.
  { pid: 10, ppid: 1, command: `/chrome --user-data-dir=${dir}/npm --headless` },
  { pid: 11, ppid: 10, command: `/chrome --type=renderer --user-data-dir=${dir}/npm` },
  // Owner alive: an explore server still holds it.
  { pid: 20, ppid: 500, command: `/chrome --user-data-dir=${dir}/langfuse` },
  // A person's own Chrome, not ours.
  { pid: 30, ppid: 1, command: "/chrome --user-data-dir=/Users/u/Library/Chrome" },
];

describe("orphaned browsers", () => {
  it("only roots on our profiles whose owner died", () => {
    expect(orphanBrowsers(procs, `${dir}/`, 4242)).toEqual([{ pid: 10, profile: "npm" }]);
  });
  it("never in a container where we are init: ppid 1 is then our own", () => {
    expect(orphanBrowsers(procs, dir, 1)).toEqual([]);
  });
  it("stops them, and a dry run only names them", async () => {
    const killed: number[] = [];
    const o = { procs: async () => procs, kill: (pid: number) => void killed.push(pid) };
    expect(await reapOrphans(dir, { ...o, dry: true })).toHaveLength(1);
    expect(killed).toEqual([]);
    expect(await reapOrphans(dir, o)).toEqual([{ pid: 10, profile: "npm" }]);
    expect(killed).toEqual([10]);
  });
});

describe("Chrome app copies (WA-1218)", () => {
  const setup = async () => {
    const { mkdtempSync, mkdirSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "clones-"));
    const old = Date.now() / 1000 - 3600;
    for (const n of [
      "code_sign_clone.held",
      "code_sign_clone.left",
      "code_sign_clone.new",
      "other",
    ]) {
      mkdirSync(join(dir, n));
      if (n !== "code_sign_clone.new") utimesSync(join(dir, n), old, old);
    }
    const { readdirSync } = await import("node:fs");
    return { dir, left: () => readdirSync(dir).sort() };
  };

  it("removes old copies no process holds", async () => {
    const { dir, left } = await setup();
    const n = await reapChromeClones({ dir, held: async () => new Set(["code_sign_clone.held"]) });
    expect(n).toBe(1);
    expect(left()).toEqual(["code_sign_clone.held", "code_sign_clone.new", "other"]);
  });

  it("removes none when lsof fails, or sees none held while Chrome runs", async () => {
    const { dir, left } = await setup();
    expect(await reapChromeClones({ dir, held: async () => null })).toBe(0);
    expect(
      await reapChromeClones({ dir, held: async () => new Set(), running: async () => true }),
    ).toBe(0);
    expect(left()).toHaveLength(4);
    expect(
      await reapChromeClones({ dir, held: async () => new Set(), running: async () => false }),
    ).toBe(2);
  });
});
