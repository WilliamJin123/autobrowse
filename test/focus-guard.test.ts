import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  GUARD_JS,
  guardFocus,
  MARK_MS,
  onActivated,
  onWaiting,
} from "../src/browser/focus-guard.js";

const fakeSpawn = () => {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    return child;
  }) as never;
  return { calls, child, spawn };
};

it("one Chrome by pid, stopped at once on release", () => {
  const f = fakeSpawn();
  const g = guardFocus({ spawn: f.spawn, platform: "darwin", pid: 4242, markFile: "/m" });
  expect(f.calls).toEqual([
    { cmd: "osascript", args: ["-l", "JavaScript", "-e", GUARD_JS, "4242", "/m"] },
  ]);
  g.release();
  g.release();
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

it("no pid: no guard", () => {
  const f = fakeSpawn();
  guardFocus({ spawn: f.spawn, platform: "darwin", pid: 0 }).mark();
  expect(f.calls).toEqual([]);
});

it("a script fault is logged; a clean exit or a release is not", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const f = fakeSpawn();
    guardFocus({ spawn: f.spawn, platform: "darwin", pid: 9, markFile: "/m" });
    f.child.emit("exit", 0);
    expect(err).not.toHaveBeenCalled();
    f.child.emit("exit", 1);
    expect(err).toHaveBeenCalledWith("autobrowse: focus guard stopped (exit 1)");
    const g2 = fakeSpawn();
    guardFocus({ spawn: g2.spawn, platform: "darwin", pid: 9, markFile: "/m" }).release();
    g2.child.emit("exit", 143);
    expect(err).toHaveBeenCalledTimes(1);
  } finally {
    err.mockRestore();
  }
});

const act = { ours: true, theirs: false, otherAutobrowse: false, person: false, marked: false };
it.each([
  ["our Chrome, no input", {}, "restore"],
  ["our Chrome, a site tab with input", { person: true, marked: true }, "restore"],
  ["our Chrome, input and no mark yet", { person: true }, "wait"],
  ["our Chrome while it is theirs", { theirs: true, person: true }, "ignore"],
  ["another app", { ours: false }, "follow"],
  ["another autobrowse Chrome", { ours: false, otherAutobrowse: true }, "ignore"],
] as const)("onActivated: %s → %s", (_, s, want) => {
  expect(onActivated({ ...act, ...s })).toBe(want);
});

const wait = { stillOurs: true, marked: false, waitedMs: 0, markMs: MARK_MS };
it.each([
  ["a mark comes in", { marked: true }, "restore"],
  ["no mark yet", { waitedMs: MARK_MS - 1 }, "wait"],
  ["no mark in time: the person's switch", { waitedMs: MARK_MS }, "drop"],
  ["the front moved on", { stillOurs: false, marked: true }, "drop"],
] as const)("onWaiting: %s → %s", (_, s, want) => {
  expect(onWaiting({ ...wait, ...s })).toBe(want);
});

it("the script carries the rules it runs", () => {
  expect(GUARD_JS).toContain(onActivated.toString());
  expect(GUARD_JS).toContain(onWaiting.toString());
});

it("the script compiles as JavaScript", () => {
  expect(() => new Function(`${GUARD_JS}; return run;`)).not.toThrow();
});

it("does nothing off a Mac", () => {
  const f = fakeSpawn();
  guardFocus({ spawn: f.spawn, platform: "linux", pid: 1 }).release();
  expect(f.calls).toEqual([]);
});

it("a mark touches the file the script reads; release removes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "focus-mark-"));
  try {
    const f = fakeSpawn();
    const file = join(dir, "mark");
    const g = guardFocus({ spawn: f.spawn, platform: "darwin", pid: 7, markFile: file });
    expect(f.calls[0]?.args.at(-1)).toBe(file);
    expect(existsSync(file)).toBe(false);
    g.mark();
    expect(existsSync(file)).toBe(true);
    g.release();
    expect(existsSync(file)).toBe(false);
    g.mark();
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("off a Mac, mark is a no-op too", () => {
  expect(() => guardFocus({ platform: "linux", pid: 1 }).mark()).not.toThrow();
});
