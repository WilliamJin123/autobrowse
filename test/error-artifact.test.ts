import { describe, expect, it } from "vitest";
import { FlowFailed } from "../src/browser/flow.js";
import { errorOf, failureOf } from "../src/errors.js";

describe("failure record on the error (U19)", () => {
  const failed = new FlowFailed("x/apply", new Error("Timeout"), { failure: "/a/1.failure.json" });

  it("puts the flow's failure record on the contract", () => {
    expect(errorOf(failed).artifact).toBe("/a/1.failure.json");
    expect(errorOf(new Error("plain")).artifact).toBeUndefined();
  });

  it("finds it down a cause chain", () => {
    const wrapped = new Error("wrapped");
    Object.defineProperty(wrapped, "cause", { value: failed });
    expect(failureOf(wrapped)).toBe("/a/1.failure.json");
  });
});
