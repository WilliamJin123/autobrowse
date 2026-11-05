import { describe, expect, it } from "vitest";
import { type CodeCall, CodeFailed, memoryStore, runCode } from "../src/browser/code.js";
import type { FlowPage, ReadTab } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";

/** A fake page with read tabs: `read` answers `<url>:<css>`; `/bad` throws until `fixed`. */
const fake = (readTabs = 3) => {
  const log: string[] = [];
  const state = { fixed: false, open: 0, most: 0, made: 0, closed: 0, wall: "" };
  let url = "https://x.test/";
  const tab = (): ReadTab => {
    const id = state.made++;
    let at = "about:blank";
    return {
      page: {} as ReadTab["page"],
      open: async (u) => {
        log.push(`t${id} open ${u}`);
        state.open++;
        state.most = Math.max(state.most, state.open);
        await new Promise((r) => setTimeout(r, 5));
        state.open--;
        if (u === state.wall) throw new Error("read tab: a login page; sign in on fp first");
        at = u;
      },
      url: () => at,
      read: async (h) => {
        log.push(`t${id} read ${at}`);
        if (at.endsWith("/bad") && !state.fixed) throw new Error("no #title");
        return `${at}:${(h as { css: string }).css}`;
      },
      has: async () => true,
      wait: async () => undefined,
      scroll: async () => undefined,
      act: async (op) => {
        log.push(`t${id} act ${op.kind}`);
      },
      close: async () => {
        state.closed++;
      },
    };
  };
  const fp = {
    url: () => url,
    open: async (u: string) => {
      log.push(`main open ${u}`);
      url = u;
    },
    read: async () => "main",
    has: async () => true,
    act: async (op: { kind: string }) => {
      log.push(`main act ${op.kind}`);
    },
    wait: async () => undefined,
    human: (r: string) => {
      throw new NeedsHuman(r);
    },
    readTab: async () => tab(),
    readTabs,
  } as unknown as FlowPage;
  return { fp, log, state };
};

const fast = { tabGapMs: [0, 0] as [number, number] };
const URLS = (n: number) => Array.from({ length: n }, (_, i) => `https://x.test/${i}`);
const EACH = `
const got = await fp.each(plan.urls, async (tab, url, i) => {
  await tab.open(url);
  return { i, title: await tab.read({ css: "#t" }) };
});
rows.push(...got);`;

describe("fp.each", () => {
  it("reads items in at most N tabs, results in item order, every tab closed", async () => {
    const { fp, state } = fake(3);
    const r = await runCode(fp, { code: EACH, plan: { urls: URLS(7) } }, fast);
    expect(r.rows).toEqual(URLS(7).map((u, i) => ({ i, title: `${u}:#t` })));
    expect(state.made).toBe(3);
    expect(state.most).toBeLessThanOrEqual(3);
    expect(state.most).toBeGreaterThan(1);
    expect(state.closed).toBe(3);
  });

  it("takes fewer tabs when asked, never more than the setting", async () => {
    const one = fake(3);
    await runCode(
      one.fp,
      {
        code: `rows.push(...(await fp.each(plan.urls, async (t, u) => { await t.open(u); return t.read({css:"a"}) }, { tabs: 1 })))`,
        plan: { urls: URLS(4) },
      },
      fast,
    );
    expect(one.state.made).toBe(1);
    const capped = fake(2);
    await runCode(
      capped.fp,
      {
        code: `await fp.each(plan.urls, async (t, u) => { await t.open(u); await t.read({css:"a"}) }, { tabs: 9 })`,
        plan: { urls: URLS(6) },
      },
      fast,
    );
    expect(capped.state.made).toBe(2);
  });

  it("a failed item names its index; the rerun replays done items with no tab work", async () => {
    const { fp, log, state } = fake(2);
    const urls = [...URLS(3), "https://x.test/bad", "https://x.test/9"];
    const store = memoryStore();
    const err = await runCode(fp, { code: EACH, plan: { urls } }, { ...fast, store }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CodeFailed);
    expect((err as CodeFailed).result.failed).toMatchObject({
      call: "read",
      item: 3,
      url: "https://x.test/bad",
      error: "no #title",
    });
    expect(state.closed).toBe(state.made);

    state.fixed = true;
    log.length = 0;
    const trace: CodeCall[] = [];
    const r = await runCode(
      fp,
      { code: EACH, plan: { urls } },
      { ...fast, store, trace: (c) => trace.push(c) },
    );
    expect(r.rows).toHaveLength(5);
    // Items 0-2 from the store: no open, no read for them.
    expect(log.filter((l) => /x\.test\/[012]$/.test(l))).toEqual([]);
    expect(trace.find((c) => c.call === "read" && c.stored)?.each?.[0]).toBe(0);
  });

  it("an effect act in a tab throws; hover and a view click run", async () => {
    const { fp, log } = fake();
    const ok = await runCode(
      fp,
      {
        code: `await fp.each(["https://x.test/a"], async (t, u) => {
          await t.open(u);
          await t.act({ kind: "hover" }, { css: "a" });
          await t.act({ kind: "click" }, { css: "more" }, { goal: "more", view: true });
          await t.read({ css: "a" });
        })`,
      },
      fast,
    );
    expect(ok.calls).toBeGreaterThan(0);
    expect(log.filter((l) => l.includes("act"))).toEqual(["t0 act hover", "t0 act click"]);
    const err = await runCode(
      fp,
      {
        code: `await fp.each(["https://x.test/a"], async (t, u) => {
          await t.open(u);
          await t.act({ kind: "click" }, { css: "buy" }, { goal: "buy" });
        })`,
      },
      fast,
    ).catch((e) => e);
    expect((err as CodeFailed).result.failed?.error).toMatch(/goes on fp/);
  });

  it("the main page is closed to calls while items run", async () => {
    const { fp } = fake();
    const err = await runCode(
      fp,
      {
        code: `await fp.each(["https://x.test/a"], async (t, u) => { await fp.read({ css: "a" }) })`,
      },
      fast,
    ).catch((e) => e);
    expect((err as CodeFailed).result.failed?.error).toMatch(/inside fp.each: use the tab/);
  });

  it("a person's need from a tab stops the run as it is", async () => {
    const { fp } = fake();
    const err = await runCode(
      fp,
      { code: `await fp.each(["https://x.test/a"], async () => { fp.human("captcha") })` },
      fast,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NeedsHuman);
  });

  it("a read before open throws; a wall names the main page", async () => {
    const { fp, state } = fake();
    state.wall = "https://x.test/login";
    const before = await runCode(
      fp,
      { code: `await fp.each([1], async (t) => { await t.read({ css: "a" }) })` },
      fast,
    ).catch((e) => e);
    expect((before as CodeFailed).result.failed?.error).toMatch(/tab.open\(url\) first/);
    const wall = await runCode(
      fp,
      { code: EACH, plan: { urls: ["https://x.test/login"] } },
      fast,
    ).catch((e) => e);
    expect((wall as CodeFailed).result.failed?.error).toMatch(/sign in on fp first/);
  });
});
