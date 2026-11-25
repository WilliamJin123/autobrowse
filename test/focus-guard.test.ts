import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GUARD_JS, guardFocus } from "../src/browser/focus-guard.js";

const fakeSpawn = () => {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    return child;
  }) as never;
  return { calls, child, spawn };
};

it("a launch guard: any new Chrome, from before the launch until a grace after it", () => {
  vi.useFakeTimers();
  try {
    const f = fakeSpawn();
    const g = guardFocus({ spawn: f.spawn, platform: "darwin", capMs: 20_000, markFile: "/m" });
    expect(f.calls).toEqual([
      { cmd: "osascript", args: ["-l", "JavaScript", "-e", GUARD_JS, "0", "20000", "/m"] },
    ]);
    g.release(3_000);
    g.release(3_000);
    vi.advanceTimersByTime(2_999);
    expect(f.child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("a session guard: one Chrome by pid, no cap, stopped at once on release", () => {
  const f = fakeSpawn();
  const g = guardFocus({ spawn: f.spawn, platform: "darwin", pid: 4242 });
  expect(f.calls[0]?.args.slice(-3, -1)).toEqual(["4242", "0"]);
  g.release();
  expect(f.child.kill).toHaveBeenCalledTimes(1);
});

it("the script compiles as JavaScript", () => {
  expect(() => new Function(`${GUARD_JS}; return run;`)).not.toThrow();
});

it("does nothing off a Mac", () => {
  const f = fakeSpawn();
  guardFocus({ spawn: f.spawn, platform: "linux" }).release();
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
  expect(() => guardFocus({ platform: "linux" }).mark()).not.toThrow();
});
