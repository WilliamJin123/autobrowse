import { request } from "node:http";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { watchDialogs } from "../src/browser/dialogs.js";
import {
  fitViewport,
  type LiveView,
  liveViewOf,
  startLiveView,
  streamSize,
  toastHtml,
} from "../src/browser/live-view.js";
import { isLive } from "../src/browser/session.js";
import type { HostEvent, OverlayHost } from "../src/explore/overlay-host.js";

const SCREEN = { width: 1512, height: 982 };

describe.runIf(process.platform === "darwin")("what shows in the live view", () => {
  const local = { tier: "local" as const, headedView: "live" as const };
  it("takes a headed browser, never a headless one", () => {
    expect(isLive({ ...local, headless: false })).toBe(true);
    expect(isLive({ ...local, headless: true })).toBe(false);
    expect(isLive({ ...local, headless: true, live: true })).toBe(true);
  });
  it("leaves Chrome's window to a film, a placed window and HEADED_VIEW=window", () => {
    expect(isLive({ ...local, headless: false, film: {} as never })).toBe(false);
    expect(isLive({ ...local, headless: false, window: {} as never })).toBe(false);
    expect(isLive({ ...local, headless: false, headedView: "window" })).toBe(false);
    expect(isLive({ tier: "browserbase" as never, headless: false, headedView: "live" })).toBe(
      false,
    );
  });
});

describe("live view sizes", () => {
  it("keeps the viewport inside the screen, less menu bar and Chrome's toolbar", () => {
    expect(fitViewport({ w: 5000, h: 5000 }, SCREEN)).toEqual({ w: 1512, h: 982 - 37 - 87 });
    expect(fitViewport({ w: 10, h: 10 }, SCREEN)).toEqual({ w: 320, h: 240 });
    expect(fitViewport({ w: 1000.4, h: 700.6 }, SCREEN)).toEqual({ w: 1000, h: 701 });
  });
  it("streams CSS px times the scale", () => {
    expect(streamSize({ w: 1000, h: 600 }, 1.2)).toEqual({ maxWidth: 1200, maxHeight: 720 });
  });
  it("escapes the site and reason in the toast", () => {
    const html = toastHtml("<b>x</b>", `a "quote" & 'tick'`);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; needs you");
    expect(html).toContain("a &quot;quote&quot; &amp; &#39;tick&#39;");
    expect(html).not.toContain("<b>x</b>");
  });
});

/** The app, minus the window: records what the session sends, plays its events back. */
function fakeHost() {
  const sent: Array<{ t: string; [k: string]: unknown }> = [];
  const fns: Array<(e: HostEvent) => void> = [];
  let closed = false;
  const host: OverlayHost = {
    pid: 4242,
    send: (o) => void sent.push(o),
    on: (fn) => void fns.push(fn),
    close: () => {
      closed = true;
    },
  };
  return {
    host,
    sent,
    emit: (e: HostEvent) => {
      for (const fn of fns) fn(e);
    },
    closed: () => closed,
  };
}

/** The viewer's socket: JSON in `msgs`, frames counted. */
async function viewer(live: LiveView, origin = `http://127.0.0.1:${live.port}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${live.port}/?k=${live.token}`, { origin });
  const msgs: Array<{ t: string; [k: string]: unknown }> = [];
  let frames = 0;
  ws.on("message", (d, binary) => {
    if (binary) frames++;
    else msgs.push(JSON.parse(String(d)));
  });
  await new Promise<void>((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
  });
  return {
    ws,
    msgs,
    frames: () => frames,
    send: (m: object) => ws.send(JSON.stringify(m)),
    until: async <T>(fn: () => T | undefined | false | null, ms = 5000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

function get(port: number, path: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; csp: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      ok({
        status: res.statusCode ?? 0,
        csp: String(res.headers["content-security-policy"] ?? ""),
      });
    });
    req.on("error", fail);
    req.end();
  });
}

describe("live view session", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let live: LiveView | null = null;
  let app: ReturnType<typeof fakeHost>;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  afterEach(async () => {
    await live?.close();
    live = null;
    await context?.close();
  });

  async function start(
    onWindow?: (urls: string[]) => Promise<string | null>,
    o: { touch?: boolean; noCdp?: boolean } = {},
  ) {
    context = await browser.newContext(o.touch ? { hasTouch: true } : {});
    page = await context.newPage();
    // Firefox and WebKit have no CDP session: same refusal, Chromium's speed
    if (o.noCdp) context.newCDPSession = () => Promise.reject(new Error("no CDP"));
    app = fakeHost();
    live = await startLiveView(context, {
      ...(o.touch ? { touch: true } : {}),
      site: "example",
      scale: 1,
      dpr: 1,
      screen: SCREEN,
      main: page,
      host: async () => app.host,
      ...(onWindow ? { onWindow } : {}),
      log: () => undefined,
    });
    return live;
  }

  it("serves the viewer only with the secret, on its own Host, under a CSP", async () => {
    const lv = await start();
    expect((await get(lv.port, "/")).status).toBe(403);
    expect((await get(lv.port, `/?k=${"0".repeat(64)}`)).status).toBe(403);
    // DNS rebinding: a name that points at us is still refused
    expect((await get(lv.port, `/?k=${lv.token}`, `evil.test:${lv.port}`)).status).toBe(403);
    const ok = await get(lv.port, `/?k=${lv.token}`);
    expect(ok.status).toBe(200);
    expect(ok.csp).toContain(`connect-src ws://127.0.0.1:${lv.port}`);
    expect(liveViewOf(context)).toBe(lv);
  });

  it("refuses a socket from another origin", async () => {
    const lv = await start();
    await expect(viewer(lv, "https://evil.test")).rejects.toThrow();
  });

  it("opens the app on the viewer's URL and streams only while the viewer is on screen", async () => {
    const lv = await start();
    await page.setContent("<body style='background:#c00'><h1>hi</h1></body>");
    const v = await viewer(lv);
    const hello = await v.until(() => v.msgs.find((m) => m.t === "hello"));
    expect(hello).toMatchObject({ site: "example", scale: 1, window: false });
    const tabs = await v.until(() => v.msgs.find((m) => m.t === "tabs"));
    expect(tabs.tabs).toEqual([expect.objectContaining({ on: true, main: true })]);
    await v.until(() => app.sent.find((m) => m.t === "open"));
    expect(String(app.sent.find((m) => m.t === "open")?.url)).toBe(
      `http://127.0.0.1:${lv.port}/?k=${lv.token}`,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(v.frames()).toBe(0);
    app.emit({ t: "visible", on: true });
    await v.until(() => v.frames() > 0);
    v.ws.close();
  });

  it("clicks and types into the page from the viewer", async () => {
    const lv = await start();
    await page.setContent(
      "<input id=i style='position:fixed;left:0;top:0;width:300px;height:40px'>",
    );
    const v = await viewer(lv);
    await v.until(() => v.msgs.find((m) => m.t === "tabs"));
    v.send({ t: "mouse", type: "down", x: 20, y: 20, button: "left", clickCount: 1 });
    v.send({ t: "mouse", type: "up", x: 20, y: 20, button: "left", clickCount: 1 });
    v.send({ t: "text", text: "héllo" });
    await expect
      .poll(() => page.evaluate(() => (document.getElementById("i") as HTMLInputElement).value))
      .toBe("héllo");
    v.ws.close();
  });

  it("asks the person about a dialog while they look, and takes their answer", async () => {
    const lv = await start();
    watchDialogs(context);
    const v = await viewer(lv);
    app.emit({ t: "visible", on: true });
    const asked = page.evaluate(() => prompt("Name?", "x"));
    const d = await v.until(() => v.msgs.find((m) => m.t === "dialog"));
    expect(d).toMatchObject({ type: "prompt", message: "Name?", value: "x" });
    v.send({ t: "dialog", id: d.id, accept: true, text: "Ada" });
    expect(await asked).toBe("Ada");
    v.ws.close();
  });

  it("leaves a dialog to the default while nobody looks", async () => {
    await start();
    watchDialogs(context);
    expect(await page.evaluate(() => confirm("Sure?"))).toBe(false);
  });

  it("asks for the person with the toast and takes it back", async () => {
    const lv = await start();
    const v = await viewer(lv);
    await v.until(() => app.sent.find((m) => m.t === "open"));
    lv.person("solve the captcha");
    const toast = await v.until(() => app.sent.find((m) => m.t === "attention"));
    expect(String(toast.html)).toContain("solve the captcha");
    await v.until(() => v.msgs.find((m) => m.t === "needs" && m.why === "solve the captcha"));
    lv.person(null);
    await v.until(() => app.sent.find((m) => m.t === "calm"));
    await v.until(() => v.msgs.find((m) => m.t === "needs" && m.why === ""));
    v.ws.close();
  });

  it("moves to a window on ⌘⇧O, and stays when the move is refused", async () => {
    let refuse: string | null = "no profile";
    const got: string[][] = [];
    const lv = await start(async (urls) => {
      got.push(urls);
      return refuse;
    });
    await page.goto("data:text/html,<p>x</p>");
    const v = await viewer(lv);
    await v.until(() => v.msgs.find((m) => m.t === "tabs"));
    v.send({ t: "window" });
    await v.until(() => v.msgs.find((m) => m.t === "note" && m.text === "no profile"));
    expect(lv.moved).toBe(false);
    refuse = null;
    v.send({ t: "window" });
    await v.until(() => lv.moved);
    // only web pages reopen: a data: URL has no place in a plain window
    expect(got.at(-1)).toEqual([]);
    v.ws.close();
  });

  it("draws the overlay in the viewer: html first, scripts after it loads", async () => {
    const lv = await start();
    const v = await viewer(lv);
    const ov = await lv.overlayHost(() => undefined);
    if (!ov) throw new Error("no overlay host");
    const events: HostEvent[] = [];
    ov.on((e) => events.push(e));
    ov.send({ t: "html", html: "<div id=panel></div>" });
    ov.send({ t: "js", js: "draw(1)" });
    await v.until(() => v.msgs.find((m) => m.t === "ov-html" && m.html === "<div id=panel></div>"));
    expect(v.msgs.some((m) => m.t === "ov-js")).toBe(false);
    v.send({ t: "overlay-ready" });
    await v.until(() => v.msgs.find((m) => m.t === "ov-js" && m.js === "draw(1)"));
    // the stream is the window: found at once
    ov.send({ t: "target" });
    await v.until(() => events.find((e) => e.t === "found"));
    // ⌃⌥P flips the pause the tray last showed
    ov.send({ t: "tray", held: false, shown: true });
    v.send({ t: "pause" });
    await v.until(() => events.find((e) => e.t === "js" && e.pause === true));
    const g = await lv.geometry(page);
    expect(g).toMatchObject({ pid: 4242, bounds: { x: 0, y: 0 } });
    expect(g && "screen" in g).toBe(false);
    v.ws.close();
  });

  it("streams and clicks with no CDP (Firefox, WebKit)", async () => {
    const lv = await start(undefined, { noCdp: true });
    await page.setContent(
      "<body style='background:#c00'><button id=b style='position:fixed;left:0;top:0;width:200px;height:40px' onclick='this.textContent=\"hit\"'>b</button></body>",
    );
    const v = await viewer(lv);
    await v.until(() => v.msgs.find((m) => m.t === "tabs"));
    app.emit({ t: "visible", on: true });
    await v.until(() => v.frames() > 0);
    v.send({ t: "mouse", type: "down", x: 20, y: 20, button: "left", clickCount: 1 });
    v.send({ t: "mouse", type: "up", x: 20, y: 20, button: "left", clickCount: 1 });
    await expect.poll(() => page.textContent("#b")).toBe("hit");
    v.ws.close();
  });

  it("lands a click as one tap on a touch device (ios), on the release", async () => {
    const lv = await start(undefined, { touch: true });
    await page.setContent(
      "<div id=d style='position:fixed;inset:0'></div><script>window.seen=[];for(const e of ['touchstart','touchend','mousedown'])d.addEventListener(e,()=>seen.push(e))</script>",
    );
    const v = await viewer(lv);
    await v.until(() => v.msgs.find((m) => m.t === "tabs"));
    v.send({ t: "mouse", type: "down", x: 30, y: 30, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
    v.send({ t: "mouse", type: "up", x: 30, y: 30, button: "left", clickCount: 1 });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen.slice(0, 2)))
      .toEqual(["touchstart", "touchend"]);
    v.ws.close();
  });

  it("closes once: the socket, the app, the registry", async () => {
    const lv = await start();
    await lv.close();
    await lv.close();
    expect(liveViewOf(context)).toBeNull();
    await expect.poll(() => app.closed()).toBe(true);
    live = null;
  });
});
