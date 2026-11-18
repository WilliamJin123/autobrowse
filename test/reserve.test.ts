import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { profileBusyOf } from "../src/browser/browsers.js";
import { assertNotReserved, isDesk, reserve, reserves, unreserve } from "../src/browser/reserve.js";

let dir = "";
let file = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reserve-"));
  file = join(dir, "reserved.json");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

it("reserves a profile for a while, then lets it go on its own", () => {
  const t0 = Date.parse("2026-11-18T06:00:00Z");
  reserve("x@wren", 30, { by: "s1", why: "film" }, file, t0);
  expect(reserves(file, t0 + 29 * 60_000)).toHaveProperty("x@wren");
  expect(reserves(file, t0 + 31 * 60_000)).toEqual({});
});

it("meets the desk as a busy profile, opener reserved", () => {
  reserve("x@wren", 30, { by: "s1", why: "film" }, file);
  let err: unknown = null;
  try {
    assertNotReserved("x@wren", "/p/x@wren", file);
  } catch (e) {
    err = e;
  }
  // a wrapper that keeps only the words still reads as busy: the watcher pauses, calls wait
  const busy = profileBusyOf(new Error(String((err as Error).message)));
  expect(busy).toMatchObject({ profile: "x@wren", opener: "reserved" });
  expect(() => assertNotReserved("linkedin@wren", "/p/l", file)).not.toThrow();
  expect(unreserve("x@wren", file)).toBe(true);
  expect(() => assertNotReserved("x@wren", "/p/x@wren", file)).not.toThrow();
  expect(unreserve("x@wren", file)).toBe(false);
});

it("honours reserves only in the desk worker", () => {
  expect(isDesk(["node", "/a/autobrowse/src/app/desk.ts"])).toBe(true);
  expect(isDesk(["node", "/a/autobrowse/src/app/cli.ts", "explore", "x"])).toBe(false);
});
