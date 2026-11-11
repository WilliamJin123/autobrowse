import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTab, backgroundTab, dropTab, readTabs, reapTabs } from "../src/browser/own-tabs.js";

describe("own-browser tabs (U10)", () => {
  // As in production: a running browser, attached over CDP, its default context.
  let server: Awaited<ReturnType<typeof chromium.launch>>;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  let dir: string;
  beforeAll(async () => {
    const port = 9600 + Math.floor(Math.random() * 300);
    server = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    dir = mkdtempSync(join(tmpdir(), "own-tabs-"));
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a ledger row per tab, one per target", () => {
    const file = join(dir, "ledger.json");
    expect(readTabs(file)).toEqual([]);
    addTab(file, { pid: 1, targetId: "a", browser: "x", at: "t" });
    addTab(file, { pid: 2, targetId: "a", browser: "x", at: "t" });
    addTab(file, { pid: 3, targetId: "b", browser: "x", at: "t" });
    expect(readTabs(file).map((t) => [t.targetId, t.pid])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
    dropTab(file, "a");
    expect(readTabs(file).map((t) => t.targetId)).toEqual(["b"]);
  });

  it("opens a background tab, and reaps only dead owners' tabs of this browser", async () => {
    const file = join(dir, "reap.json");
    const context = browser.contexts()[0] as BrowserContext;
    const theirs = await context.newPage();
    const cdp = await browser.newBrowserCDPSession();
    const dead = await backgroundTab(context, cdp);
    const live = await backgroundTab(context, cdp);
    const other = await backgroundTab(context, cdp);
    expect(dead.page).not.toBe(live.page);
    addTab(file, { pid: 999_001, targetId: dead.targetId, browser: "b1", at: "t" });
    addTab(file, { pid: 999_002, targetId: live.targetId, browser: "b1", at: "t" });
    addTab(file, { pid: 999_001, targetId: other.targetId, browser: "b2", at: "t" });
    addTab(file, { pid: 999_001, targetId: "gone-already", browser: "b1", at: "t" });
    const alive = (pid: number) => pid === 999_002;
    expect(await reapTabs(cdp, file, "b1", alive)).toEqual([dead.targetId]);
    await expect.poll(() => dead.page.isClosed()).toBe(true);
    expect(live.page.isClosed()).toBe(false);
    expect(other.page.isClosed()).toBe(false);
    expect(theirs.isClosed()).toBe(false);
    expect(readTabs(file).map((t) => t.targetId)).toEqual([live.targetId, other.targetId]);
  });
});
