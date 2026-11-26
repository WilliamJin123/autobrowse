import { describe, expect, it } from "vitest";
import { inPage } from "../src/browser/page-script.js";

// What tsx emits for a named helper inside a page function.
const wrapped = Object.assign((a: { n: number }) => a.n, {
  toString: () =>
    '(a) => { const twice = /* @__PURE__ */ __name((x) => x * 2, "twice"); return twice(a.n); }',
});

describe("inPage", () => {
  it("runs a function whose helpers tsx wrapped in __name", () => {
    expect(new Function(`return ${inPage(wrapped, { n: 21 })}`)()).toBe(42);
  });

  it("leaves no __name global", () => {
    new Function(`return ${inPage(wrapped, { n: 1 })}`)();
    expect("__name" in globalThis).toBe(false);
  });

  it("calls with no argument", () => {
    expect(new Function(`return ${inPage(() => 7)}`)()).toBe(7);
  });
});
