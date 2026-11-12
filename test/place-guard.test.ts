import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldSwapped, HUMAN_PACE, handsFor, seeded } from "../src/browser/human/index.js";

// WA-1349: a page that swaps the field while the hand rests gets nothing typed.
describe("place guard", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(() => browser.close());
  const hands = () => handsFor(HUMAN_PACE, seeded(7));

  it("fills the field found", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form action="/login"><input name="password" type="text"
      onfocus="this.type='password'"></form>`);
    await hands().paste(page.locator("input[name=password]"), "s3cret", { timeout: 5_000 });
    expect(await page.locator("input").inputValue()).toBe("s3cret");
    await page.close();
  });

  it("refuses when the field is replaced on click", async () => {
    const page = await browser.newPage();
    // a click puts a look-alike field in its place, wired to another form
    await page.setContent(`<div id="box"><input class="pw" name="password"></div>
      <script>document.querySelector('.pw').addEventListener('mousedown', () => {
        document.getElementById('box').innerHTML = '<form action="https://evil.test"><input class="pw" name="q"></form>';
      });</script>`);
    const err = await hands()
      .paste(page.locator(".pw"), "s3cret", { timeout: 5_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldSwapped);
    expect(await page.locator(".pw").inputValue()).toBe("");
    await page.close();
  });

  it("refuses when the field is renamed or sent to another form", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form id="a" action="/login"></form><form id="b" action="https://evil.test"></form>
      <input id="pw" form="a" name="password"
        onmousedown="this.setAttribute('form','b')">`);
    const err = await hands()
      .paste(page.locator("#pw"), "s3cret", { timeout: 5_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldSwapped);
    expect(String(err)).toContain("nothing typed");
    expect(await page.locator("#pw").inputValue()).toBe("");
    await page.close();
  });

  it("a typed secret refuses a swap too; plain text types on", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form id="a" action="/login"></form><form id="b" action="https://evil.test"></form>
      <input id="pw" form="a" name="password" onmousedown="this.setAttribute('form','b')">
      <input id="note" form="a" name="note" onmousedown="this.setAttribute('form','b')">`);
    const typing = handsFor(HUMAN_PACE, seeded(7), undefined, (t) => t === "s3cret");
    const err = await typing
      .type(page.locator("#pw"), "s3cret", { timeout: 5_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldSwapped);
    expect(await page.locator("#pw").inputValue()).toBe("");
    await typing.type(page.locator("#note"), "hi", { timeout: 5_000 });
    expect(await page.locator("#note").inputValue()).toBe("hi");
    await page.close();
  });

  it("refuses when the hints now find another element", async () => {
    const page = await browser.newPage();
    // the first match moves down; a new field takes its place at the top
    await page.setContent(`<div id="top"></div><input class="f" name="password"
      onmousedown="const n=document.createElement('input');n.className='f';n.name='password';
        document.getElementById('top').append(n); this.className='old'">`);
    const err = await hands()
      .paste(page.locator(".f"), "s3cret", { timeout: 5_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldSwapped);
    await page.close();
  });
});
