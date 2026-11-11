import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS, no types
import { tokenFileFor as fast } from "../bin/explore-cmd.mjs";
import { tokenFileFor } from "../src/explore/journal.js";

describe("bin/explore-cmd.mjs", () => {
  it("finds the same token file as the explore server", () => {
    expect(fast(9090)).toBe(tokenFileFor(9090));
    expect(fast(9123)).toBe(tokenFileFor(9123));
  });
});

describe("command ids (U6)", () => {
  it("takes the id off the command and checks it", async () => {
    const { commandId, withRepeat, browserGone } = await import("../src/explore/server.js");
    const raw: Record<string, unknown> = { cmd: "click", id: "a-1" };
    expect(commandId(raw)).toBe("a-1");
    expect(raw).toEqual({ cmd: "click" });
    expect(commandId({ cmd: "url" })).toBeNull();
    // A number is the network row id: left on the command.
    const net: Record<string, unknown> = { cmd: "network", id: 5 };
    expect(commandId(net)).toBeNull();
    expect(net).toEqual({ cmd: "network", id: 5 });
    expect(() => commandId({ id: "bad id!" })).toThrow(/id:/);
    expect(JSON.parse(withRepeat('{"ok":true}'))).toEqual({ ok: true, repeat: true });
    expect(withRepeat("[1]")).toBe("[1]");
    expect(browserGone(new Error("Target page, context or browser has been closed"))).toBe(true);
    expect(browserGone(new Error("Timeout 5000ms exceeded"))).toBe(false);
  });
});
