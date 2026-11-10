import { describe, expect, it } from "vitest";
import { RungBroke } from "./ladder.js";
import { classify, type Fetched, pagedJson, parseJson } from "./page-json.js";

const f = (status: number, text: string, url = "https://x.test/api/a"): Fetched => ({
  status,
  url,
  contentType: "application/json",
  text,
});
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; name?: string };
  }
  throw new Error("did not throw");
};

describe("parseJson", () => {
  it("strips script-inclusion guards", () => {
    expect(parseJson('for (;;);{"a":1}')).toEqual({ ok: true, json: { a: 1 } });
    expect(parseJson(")]}'\n[1]")).toEqual({ ok: true, json: [1] });
    expect(parseJson("<html>")).toEqual({ ok: false });
  });
});

describe("classify", () => {
  it("passes JSON through", () => {
    expect(classify(f(200, '{"items":[]}'), "feed")).toEqual({ items: [] });
  });

  it("429 is rate_limited, never a fall", () => {
    expect(thrown(() => classify(f(429, "{}"), "feed")).code).toBe("rate_limited");
  });

  it("a sign-in redirect or a login refusal is need_login", () => {
    expect(
      thrown(() => classify(f(200, "<html>", "https://x.test/accounts/login/"), "a")).code,
    ).toBe("need_login");
    expect(thrown(() => classify(f(403, '{"message":"login_required"}'), "a")).code).toBe(
      "need_login",
    );
    expect(thrown(() => classify(f(401, "nope"), "a")).code).toBe("need_login");
  });

  it("a checkpoint is platform_blocked", () => {
    expect(thrown(() => classify(f(400, '{"message":"checkpoint_required"}'), "a")).code).toBe(
      "platform_blocked",
    );
  });

  it("a 404 or HTML falls to the next rung", () => {
    expect(thrown(() => classify(f(404, "<html>not found"), "a"))).toBeInstanceOf(RungBroke);
    expect(thrown(() => classify(f(200, "<html>"), "a"))).toBeInstanceOf(RungBroke);
  });
});

/** A page whose fetch answers from a list of cursor pages. */
const pageOf = (pages: Record<string, { items: number[]; next: string | null }>) => ({
  page: {
    evaluate: async (_fn: unknown, { url }: { url: string }) => {
      const c = new URL(url, "https://x.test").searchParams.get("c") ?? "";
      return { status: 200, url, contentType: "application/json", text: JSON.stringify(pages[c]) };
    },
  },
});

describe("pagedJson", () => {
  const list = (max: number) => ({
    url: (c: string | null) => `/l${c ? `?c=${c}` : ""}`,
    items: (j: unknown) => (j as { items: number[] }).items,
    next: (j: unknown) => (j as { next: string | null }).next,
    max,
  });

  it("follows cursors to the end", async () => {
    const fp = pageOf({ "": { items: [1, 2], next: "b" }, b: { items: [3], next: null } });
    // biome-ignore lint/suspicious/noExplicitAny: a stub page
    expect(await pagedJson(fp as any, list(10))).toEqual({ items: [1, 2, 3], pages: 2 });
  });

  it("stops at max and on a cursor seen before", async () => {
    const loop = pageOf({ "": { items: [1], next: "b" }, b: { items: [2], next: "b" } });
    // biome-ignore lint/suspicious/noExplicitAny: a stub page
    expect(await pagedJson(loop as any, list(10))).toEqual({ items: [1, 2], pages: 2 });
    const many = pageOf({ "": { items: [1, 2, 3], next: "b" }, b: { items: [4], next: null } });
    // biome-ignore lint/suspicious/noExplicitAny: a stub page
    expect(await pagedJson(many as any, list(2))).toEqual({ items: [1, 2], pages: 1 });
  });
});
