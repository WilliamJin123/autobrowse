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
  expect(await windowPlace("full", screen)).toEqual({ x: 0, y: 33, w: 1511, h: 949 });
  expect(await windowPlace("Right-Third", screen)).toEqual({ x: 1007, y: 33, w: 504, h: 949 });
  expect(await windowPlace("center", screen)).toEqual({ x: 151, y: 80, w: 1208, h: 854 });
  // % of the free area, mixed with points
  expect(await windowPlace("60%,0%,40%,100%", screen)).toEqual({ x: 906, y: 33, w: 605, h: 949 });
  expect(await windowPlace("100,0%,800,50%", screen)).toEqual({ x: 100, y: 33, w: 800, h: 474 });
  await expect(windowPlace("top", screen)).rejects.toThrow(/full, center, left, right/);
  await expect(windowPlace("0,0,0,600", screen)).rejects.toThrow(/above 0/);
  expect(geometry(false, "darwin", { x: 755, y: 33, w: 756, h: 949 }).args).toEqual([
    "--window-position=755,33",
    "--window-size=756,949",
  ]);
  expect(geometry(false, "darwin").args).toEqual(["--window-size=1280,900"]);
});
