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

/** `left` or `right` (a half of the screen's free area), or `x,y,w,h`. */
export async function windowPlace(
  spec: string,
  screen: () => Promise<WindowPlace> = visibleScreen,
): Promise<WindowPlace> {
  const n = spec.split(",").map((s) => Number(s.trim()));
  if (n.length === 4 && n.every((v) => Number.isFinite(v))) {
    const [x, y, w, h] = n as [number, number, number, number];
    if (w > 0 && h > 0) return { x, y, w, h };
  }
  if (spec !== "left" && spec !== "right")
    throw new Error(`window "${spec}": left, right or x,y,w,h (w and h above 0)`);
  const s = await screen();
  const half = Math.floor(s.w / 2);
  return spec === "left"
    ? { x: s.x, y: s.y, w: half, h: s.h }
    : { x: s.x + half, y: s.y, w: s.w - half, h: s.h };
}

/** The main screen less the menu bar and Dock, top-left origin. macOS only. */
export async function visibleScreen(): Promise<WindowPlace> {
  if (process.platform !== "darwin") throw new Error("left and right need macOS: give x,y,w,h");
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
