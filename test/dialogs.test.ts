import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAnswer, dialogsOf, watchDialogs } from "../src/browser/dialogs.js";

describe("native dialogs (U7)", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("says yes to what informs or leaves, no to what asks", () => {
    expect(defaultAnswer("alert")).toBe(true);
    expect(defaultAnswer("beforeunload")).toBe(true);
    expect(defaultAnswer("confirm")).toBe(false);
    expect(defaultAnswer("prompt")).toBe(false);
  });

  it("answers by default, logs each, and takes one set answer for the next ask", async () => {
    const context = await browser.newContext();
    const d = watchDialogs(context);
    expect(watchDialogs(context)).toBe(d);
    const page = await context.newPage();
    expect(dialogsOf(page)).toBe(d);
    expect(await page.evaluate(() => confirm("Delete it?"))).toBe(false);
    await page.evaluate(() => alert("Saved"));
    d.answerNext({ accept: true, text: "kept" });
    expect(await page.evaluate(() => prompt("Name?", "x"))).toBe("kept");
    // One answer only: the next confirm is a no again.
    expect(await page.evaluate(() => confirm("Again?"))).toBe(false);
    expect(d.count()).toBe(4);
    expect(d.log.map((l) => [l.type, l.message, l.answered])).toEqual([
      ["confirm", "Delete it?", false],
      ["alert", "Saved", true],
      ["prompt", "Name?", true],
      ["confirm", "Again?", false],
    ]);
    expect(d.log[2]?.text).toBe("kept");
    expect(d.since(3).map((l) => l.message)).toEqual(["Again?"]);
    await context.close();
  });

  it("leaves a dialog to a flow's own listener, and logs it", async () => {
    const context = await browser.newContext();
    const d = watchDialogs(context);
    const page = await context.newPage();
    page.on("dialog", (x) => void x.accept());
    expect(await page.evaluate(() => confirm("Leave?"))).toBe(true);
    expect(d.log[0]?.answered).toBeNull();
    await context.close();
  });

  it("watches one tab only in a shared browser", async () => {
    const context = await browser.newContext();
    const ours = await context.newPage();
    const theirs = await context.newPage();
    const d = watchDialogs(ours);
    theirs.on("dialog", (x) => void x.accept());
    expect(await theirs.evaluate(() => confirm("Theirs?"))).toBe(true);
    expect(await ours.evaluate(() => confirm("Ours?"))).toBe(false);
    expect(d.log.map((l) => l.message)).toEqual(["Ours?"]);
    await context.close();
  });
});
