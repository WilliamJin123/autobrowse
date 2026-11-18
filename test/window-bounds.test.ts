import { chromium } from "playwright";
import { expect, it } from "vitest";
import { geometry } from "../src/browser/fingerprint.js";
import { windowBounds, windowPlace } from "../src/browser/window-bounds.js";

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

it("a place opens the window there: halves of the free screen, or a box", async () => {
  const screen = async () => ({ x: 0, y: 33, w: 1511, h: 949 });
  expect(await windowPlace("left", screen)).toEqual({ x: 0, y: 33, w: 755, h: 949 });
  expect(await windowPlace("right", screen)).toEqual({ x: 755, y: 33, w: 756, h: 949 });
  expect(await windowPlace("10, 20, 800, 600", screen)).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  await expect(windowPlace("top", screen)).rejects.toThrow(/left, right or x,y,w,h/);
  await expect(windowPlace("0,0,0,600", screen)).rejects.toThrow(/above 0/);
  expect(geometry(false, "darwin", { x: 755, y: 33, w: 756, h: 949 }).args).toEqual([
    "--window-position=755,33",
    "--window-size=756,949",
  ]);
  expect(geometry(false, "darwin").args).toEqual(["--window-size=1280,900"]);
});
