import type { Page } from "playwright";

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
