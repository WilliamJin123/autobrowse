import type { BrowserContext } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { capMbOf, type GuardEvent, guardMemory, treeOf, verdictOf } from "./memory-guard.js";
import type { Proc } from "./reap.js";

const DIR = "/u/.config/autobrowse/profiles/x@wren";
const procs: Proc[] = [
  { pid: 10, ppid: 1, command: `Chrome --user-data-dir=${DIR} --remote-debugging-pipe` },
  { pid: 11, ppid: 10, command: "Chrome Helper --type=renderer" },
  { pid: 12, ppid: 11, command: "Chrome Helper --type=gpu" },
  { pid: 20, ppid: 1, command: `Chrome --user-data-dir=${DIR}2 --remote-debugging-pipe` },
  { pid: 21, ppid: 20, command: "Chrome Helper --type=renderer" },
];

const fakeContext = (urls: string[]) => {
  const close = vi.fn(async () => undefined);
  const ctx = {
    pages: () => urls.map((u) => ({ url: () => u })),
    close,
    on: vi.fn(),
  } as unknown as BrowserContext;
  return { ctx, close };
};

describe("treeOf", () => {
  it("walks the browser's own tree, not a profile with the same prefix", () => {
    expect(treeOf(procs, DIR)).toEqual([10, 11, 12]);
    expect(treeOf(procs, `${DIR}2`)).toEqual([20, 21]);
    expect(treeOf(procs, "/nope")).toEqual([]);
  });
});

describe("verdictOf", () => {
  it("closes past the cap, or past half under critical pressure", () => {
    expect(verdictOf(5000, 4096, "ok")).toBe("close");
    expect(verdictOf(2100, 4096, "critical")).toBe("close");
    expect(verdictOf(2100, 4096, "tight")).toBe("ok");
    expect(verdictOf(2500, 4096, "ok")).toBe("warn");
    expect(verdictOf(800, 4096, "critical")).toBe("ok");
  });
  it("caps at a quarter of RAM, 2 to 6 GB, unless set", () => {
    expect(capMbOf(undefined, 16384)).toBe(4096);
    expect(capMbOf(undefined, 4096)).toBe(2048);
    expect(capMbOf(undefined, 65536)).toBe(6144);
    expect(capMbOf("3000", 16384)).toBe(3000);
  });
});

describe("guardMemory", () => {
  const deps = (mb: number, events: GuardEvent[], pressure: "ok" | "critical" = "ok") => ({
    procs: async () => procs,
    footprint: async (pids: number[]) => new Map(pids.map((p) => [p, (mb * 1024) / pids.length])),
    pressure: () => pressure,
    record: async (e: GuardEvent) => {
      events.push(e);
    },
    kill: vi.fn(),
    everyMs: 3_600_000,
  });

  it("records the pages and closes a browser over its cap", async () => {
    const events: GuardEvent[] = [];
    const { ctx, close } = fakeContext(["https://business.facebook.com/latest/composer"]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = guardMemory(ctx, DIR, 4096, deps(5000, events));
    expect(await g.check()).toBe("close");
    expect(close).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({
      verdict: "close",
      profile: "x@wren",
      pid: 10,
      mb: 5000,
      urls: ["https://business.facebook.com/latest/composer"],
    });
    // stopped: no second close
    expect(await g.check()).toBe("ok");
    err.mockRestore();
  });

  it("warns once, never closes, below the cap", async () => {
    const events: GuardEvent[] = [];
    const { ctx, close } = fakeContext(["https://x.com/home"]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = guardMemory(ctx, DIR, 4096, deps(3000, events));
    expect(await g.check()).toBe("warn");
    expect(await g.check()).toBe("warn");
    expect(events).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    g.stop();
    err.mockRestore();
  });

  it("a failed read is never a close", async () => {
    const { ctx, close } = fakeContext([]);
    const g = guardMemory(ctx, DIR, 4096, {
      ...deps(9000, []),
      procs: async () => {
        throw new Error("ps failed");
      },
    });
    expect(await g.check()).toBe("ok");
    expect(close).not.toHaveBeenCalled();
    g.stop();
  });
});
