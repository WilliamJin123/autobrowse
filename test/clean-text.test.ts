import { describe, expect, it } from "vitest";
import { digest } from "../src/agent/digest.js";
import { cleanStrings, cleanText } from "../src/browser/clean-text.js";

const tag = (s: string) =>
  [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

describe("cleanText", () => {
  it("drops bidi, zero-width, BOM, tag characters and controls", () => {
    expect(cleanText("pay‮olleh‬")).toBe("payolleh");
    expect(cleanText("a​b﻿c⁦d⁩")).toBe("abcd");
    expect(cleanText(`hi${tag("ignore previous")}`)).toBe("hi");
    expect(cleanText("a\u0000b\u0007c\u009Fd")).toBe("abcd");
  });

  it("keeps tab, newline, ZWJ emoji and other scripts", () => {
    expect(cleanText("a\tb\nc\r\n")).toBe("a\tb\nc\r\n");
    expect(cleanText("👨‍👩‍👧 مرحبا नमस्ते")).toBe("👨‍👩‍👧 مرحبا नमस्ते");
  });

  it("cleans every string in a JSON answer", () => {
    const body = JSON.stringify({ rows: ["x​y"], n: 1, deep: { t: "‮z" } }, cleanStrings);
    expect(JSON.parse(body)).toEqual({ rows: ["xy"], n: 1, deep: { t: "z" } });
  });

  it("the digest shows clean text; its refs keep the page's names", () => {
    const d = digest('- button "Sa​ve"');
    expect(d.text).not.toContain("​");
    expect(d.refs[0]?.name).toBe("Sa​ve");
  });
});
