import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright";

const run = promisify(execFile);

/** Where a headed window opens: screen points, top-left origin. */
export interface WindowPlace {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Named places: x, y, w, h as fractions of the screen's free area (menu bar and Dock out). */
export const WINDOW_PRESETS: Record<string, readonly [number, number, number, number]> = {
  full: [0, 0, 1, 1],
  center: [0.1, 0.05, 0.8, 0.9],
  left: [0, 0, 0.5, 1],
  right: [0.5, 0, 0.5, 1],
  "left-third": [0, 0, 1 / 3, 1],
  "right-third": [2 / 3, 0, 1 / 3, 1],
  "left-two-thirds": [0, 0, 2 / 3, 1],
  "right-two-thirds": [1 / 3, 0, 2 / 3, 1],
};
/** What `explore --window` and a headed launch with no place use. */
export const DEFAULT_WINDOW = "full";

const usage = (spec: string) =>
  new Error(
    `window "${spec}": ${Object.keys(WINDOW_PRESETS).join(", ")}, or x,y,w,h in points or % of the free screen (w and h above 0)`,
  );

/** A preset name, or `x,y,w,h`: each part in points, or `N%` of the screen's free area. */
export async function windowPlace(
  spec: string,
  screen: () => Promise<WindowPlace> = visibleScreen,
): Promise<WindowPlace> {
  const name = spec.trim().toLowerCase();
  const preset = WINDOW_PRESETS[name];
  const parts = name.split(",").map((p) => p.trim());
  if (!preset && parts.length !== 4) throw usage(spec);
  const pct = preset ? [] : parts.map((p) => p.endsWith("%"));
  const n = preset ?? parts.map((p, i) => Number(pct[i] ? p.slice(0, -1) : p));
  if (!n.every((v) => Number.isFinite(v))) throw usage(spec);
  const s = preset || pct.some(Boolean) ? await screen() : null;
  const frac = (i: number) => (preset ? n[i] : pct[i] ? (n[i] as number) / 100 : null) ?? null;
  // one axis: a share of the free area, edges floored so two halves meet with no gap
  const axis = (pos: number, size: number, origin: number, span: number) => {
    const fp = frac(pos);
    const fs = frac(size);
    const edge = (f: number) => origin + Math.floor(f * span);
    const p = fp === null ? (n[pos] as number) : edge(fp);
    const z = fs === null ? (n[size] as number) : edge((fp ?? (p - origin) / span) + fs) - p;
    return [p, z] as const;
  };
  const [x, w] = axis(0, 2, s?.x ?? 0, s?.w ?? 0);
  const [y, h] = axis(1, 3, s?.y ?? 0, s?.h ?? 0);
  if (!(w > 0 && h > 0)) throw usage(spec);
  return { x, y, w, h };
}

/** The main screen less the menu bar and Dock, top-left origin. macOS only. */
export async function visibleScreen(): Promise<WindowPlace> {
  if (process.platform !== "darwin")
    throw new Error("presets and % need macOS: give x,y,w,h in points");
  // AppKit: bottom-left origin; screens[0] holds the menu bar
  const js =
    'ObjC.import("AppKit");const s=$.NSScreen.screens.objectAtIndex(0),f=s.frame,v=s.visibleFrame;' +
    "JSON.stringify({x:v.origin.x,y:f.size.height-v.origin.y-v.size.height,w:v.size.width,h:v.size.height})";
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", js], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const b = JSON.parse(stdout) as WindowPlace;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

/** Chrome's window in screen points, top-left origin (CDP `Browser.Bounds`). */
export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
}

type Want = { [K in keyof WindowBounds]?: WindowBounds[K] | undefined };

/** Read, or move and size, the window that holds `page`. Answers where it landed. */
export async function windowBounds(page: Page, want: Want = {}): Promise<WindowBounds> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    const { x, y, w, h, state } = want;
    const box = x !== undefined || y !== undefined || w !== undefined || h !== undefined;
    // bounds only move a normal window: leave maximized or fullscreen first
    if (box || state === "normal")
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    if (box)
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          ...(x !== undefined ? { left: x } : {}),
          ...(y !== undefined ? { top: y } : {}),
          ...(w !== undefined ? { width: w } : {}),
          ...(h !== undefined ? { height: h } : {}),
        },
      });
    else if (state && state !== "normal")
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
    const { bounds: b } = (await cdp.send("Browser.getWindowBounds", { windowId })) as {
      bounds: {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        windowState?: string;
      };
    };
    return {
      x: b.left ?? 0,
      y: b.top ?? 0,
      w: b.width ?? 0,
      h: b.height ?? 0,
      state: (b.windowState ?? "normal") as WindowBounds["state"],
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
