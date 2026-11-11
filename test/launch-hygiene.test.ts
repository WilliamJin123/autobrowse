import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { warnings } from "../src/browser/browsers.js";
import {
  assertOwnTabRoom,
  BrowserNotReady,
  CRASH_RING,
  cleanUncleanExit,
  launchFailed,
  OwnTabsFull,
  readCrashes,
  readyOrThrow,
  recentCrashes,
  recordCrash,
  selfOpener,
} from "../src/browser/launch-hygiene.js";
import { addTab } from "../src/browser/own-tabs.js";
import { errorOf } from "../src/errors.js";

const dir = () => mkdtempSync(join(tmpdir(), "hygiene-"));

function profile(prefs: unknown): string {
  const d = dir();
  mkdirSync(join(d, "Default", "Sessions"), { recursive: true });
  writeFileSync(join(d, "Default", "Preferences"), JSON.stringify(prefs));
  writeFileSync(join(d, "Default", "Sessions", "Session_1"), "x");
  writeFileSync(join(d, "Default", "Cookies"), "c");
  return d;
}

describe("launch hygiene", () => {
  it("P9: a crashed profile is marked clean, its sessions cleared, cookies kept", () => {
    const d = profile({
      profile: { exit_type: "Crashed", exited_cleanly: false, name: "x" },
      a: 1,
    });
    expect(cleanUncleanExit(d)).toBe(true);
    const p = JSON.parse(readFileSync(join(d, "Default", "Preferences"), "utf8"));
    expect(p).toEqual({ profile: { exit_type: "Normal", exited_cleanly: true, name: "x" }, a: 1 });
    expect(existsSync(join(d, "Default", "Sessions"))).toBe(false);
    expect(readFileSync(join(d, "Default", "Cookies"), "utf8")).toBe("c");
  });
  it("P9: a clean or new profile is left alone", () => {
    const d = profile({ profile: { exit_type: "Normal", exited_cleanly: true } });
    expect(cleanUncleanExit(d)).toBe(false);
    expect(existsSync(join(d, "Default", "Sessions"))).toBe(true);
    expect(cleanUncleanExit(dir())).toBe(false);
  });
  it("P8: a mute page is BrowserNotReady, mapped to browser_down", async () => {
    const mute = { evaluate: () => new Promise(() => {}) } as never;
    const err = await readyOrThrow(mute, "x", 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserNotReady);
    expect(errorOf(err).code).toBe("browser_down");
    await expect(readyOrThrow({ evaluate: async () => 1 } as never, "x")).resolves.toBeUndefined();
    expect(launchFailed(new Error("Timeout 60000ms exceeded."), "x")).toBeInstanceOf(
      BrowserNotReady,
    );
    const other = new Error("profile in use");
    expect(launchFailed(other, "x")).toBe(other);
  });
  it("P10: the ring keeps the last 20; recent ones warn", () => {
    const f = join(dir(), "c.jsonl");
    for (let i = 0; i < CRASH_RING + 5; i++)
      recordCrash({ profile: `p${i}`, reason: "closed", opener: "cli", pid: 1 }, f);
    const all = readCrashes(f);
    expect(all).toHaveLength(CRASH_RING);
    expect(all.at(-1)?.profile).toBe(`p${CRASH_RING + 4}`);
    recordCrash({ profile: "old", reason: "memory", at: "2020-01-01T00:00:00.000Z" }, f);
    const recent = recentCrashes(24, f);
    expect(recent[0]?.profile).toBe(`p${CRASH_RING + 4}`);
    expect(recent.some((c) => c.profile === "old")).toBe(false);
    const view = {
      browsers: [],
      explorers: [],
      strangers: [],
      totalMb: 0,
      ramMb: 0,
      crashes: recent,
    };
    expect(warnings(view).join("\n")).toMatch(/19 browser deaths in 24 h; last p24 \(closed, cli/);
  });
  it("P10: the opener is named as browsers names it", () => {
    expect(selfOpener(["node", "/x/src/app/desk.ts"])).toBe("desk");
    expect(selfOpener(["node", "/x/dist/app/cli.js", "site"])).toBe("cli");
    expect(selfOpener(["node", "/x/other.js"])).toBe("other");
  });
  it("P11: our tabs past the cap refuse as profile_busy; another browser's tabs do not count", () => {
    const f = join(dir(), "tabs.json");
    for (let i = 0; i < 2; i++) addTab(f, { pid: 1, targetId: `t${i}`, browser: "/a", at: "" });
    addTab(f, { pid: 1, targetId: "u", browser: "/b", at: "" });
    expect(() => assertOwnTabRoom(f, "/a", 3)).not.toThrow();
    addTab(f, { pid: 1, targetId: "t3", browser: "/a", at: "" });
    const err = (() => {
      try {
        assertOwnTabRoom(f, "/a", 3);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OwnTabsFull);
    expect(errorOf(err).code).toBe("profile_busy");
  });
});
