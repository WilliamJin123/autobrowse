import { chromium } from "playwright";
import { expect, it } from "vitest";
import { windowBounds } from "../src/browser/window-bounds.js";

it("reads, then moves and sizes the window that holds a page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    expect((await windowBounds(page)).w).toBeGreaterThan(0);
    const placed = await windowBounds(page, { x: 40, y: 60, w: 800, h: 600 });
    expect(placed).toEqual({ x: 40, y: 60, w: 800, h: 600, state: "normal" });
    expect(await windowBounds(page)).toMatchObject({ w: 800, h: 600 });
  } finally {
    await browser.close();
  }
}, 30_000);
