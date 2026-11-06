import type { BrowserContext } from "playwright";
import { describe, expect, it } from "vitest";
import { dispatchersOf, trimRequests } from "../src/browser/driver-memory.js";

describe("the driver's request bound", () => {
  it("drops the oldest requests past the limit, as Playwright's own collection does", () => {
    const disposed: string[] = [];
    const list = new Set(["r1", "r2", "r3", "r4", "r5"]);
    const d = {
      _dispatchersByBucket: new Map([["Request", list]]),
      _dispatcherByGuid: new Map(
        [...list].map((g) => [g, { _dispose: (why: string) => disposed.push(`${g}:${why}`) }]),
      ),
    };
    expect(trimRequests(d, 3)).toBe(2);
    expect(disposed).toEqual(["r1:gc", "r2:gc"]);
    expect([...list]).toEqual(["r3", "r4", "r5"]);
    expect(trimRequests(d, 3)).toBe(0);
  });

  it("is off, not broken, on a shape it does not know", () => {
    expect(dispatchersOf({} as BrowserContext)).toBeNull();
    expect(
      dispatchersOf({ _connection: { toImpl: () => ({}) } } as unknown as BrowserContext),
    ).toBeNull();
  });

  // A Playwright upgrade that renames these turns the bound off without a word: this test says it.
  it.each(["patchright", "playwright"])(
    "%s still has the private names the bound reads",
    async (name) => {
      const { chromium } = (await import(name)) as { chromium: unknown };
      const d = dispatchersOf(chromium as BrowserContext);
      expect(d?._dispatchersByBucket).toBeInstanceOf(Map);
      const any = [...(d?._dispatcherByGuid.values() ?? [])][0];
      expect(typeof any?._dispose).toBe("function");
    },
  );
});
