import { describe, expect, it } from "vitest";
import { missText } from "../src/explore/marks.js";

const timeout = (m: string) => Object.assign(new Error(m), { name: "TimeoutError" });

describe("missText", () => {
  it("names the target and the wait of a locator timeout", () => {
    const err = timeout("locator.evaluate: Timeout 10000ms exceeded.\nCall log:\n  - waiting");
    expect(missText(err, { text: "Buy" })).toBe(
      'no element matches {"text":"Buy"} after 10 s; pick one from marks',
    );
  });
  it("keeps any other error's first line", () => {
    expect(missText(new Error("boom\nstack"), { text: "Buy" })).toBe("boom");
    expect(missText(timeout("page.goto: Timeout 5000ms exceeded."), undefined)).toBe(
      "page.goto: Timeout 5000ms exceeded.",
    );
  });
});
