/**
 * Live view (designs/2026-11-25-live-view.md): a headless session shown in a background Mac app.
 * The session serves the viewer page and its socket on 127.0.0.1; the app (`overlay-host live`)
 * holds only the window, the toast, the Dock and the clipboard. Chromium streams over CDP;
 * Firefox and WebKit (`browser/engines`) over `page.screencast`, with no page script: no
 * select menu, cursor or copy out (a binding outside an isolated world is visible to the page).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { type WebSocket, WebSocketServer } from "ws";
import { type HostEvent, nativeHost, type OverlayHost } from "../explore/overlay-host.js";
import { askDialogsWith, type DialogAnswer } from "./dialogs.js";

/** The isolated world the viewer's page script runs in: the page's own scripts never see it. */
const WORLD = "autobrowse-live";
const BINDING = "autobrowseLive";
const QUALITY = 75;
/** A real Mac Chrome's tab strip and toolbar: outer height = inner + this. */
const CHROME_TOP = 87;
/** Menu bar and Dock a window never covers. */
const SCREEN_TOP = 37;
/** A socket further behind than this skips frames, so lag never grows. */
const BACKLOG = 2_000_000;
/** A dialog the person never answers falls back to the default after this. */
const DIALOG_MS = 60_000;
/** Person input this recent makes a file chooser or a dialog theirs. */
const PERSON_MS = 10_000;
const VIEWER = fileURLToPath(new URL("../../assets/live-view/viewer.html", import.meta.url));

export interface LiveViewOptions {
  site: string;
  /** Stream scale over CSS px (`liveViewScale`). */
  scale: number;
  /** The page's DPR (the fingerprint's); Chrome is launched with it forced. */
  dpr: number;
  /** The fingerprint's screen: the viewport never grows past it. */
  screen: { width: number; height: number };
  /** An emulated device's viewport (`ios`): kept whatever size the viewer is. */
  fixed?: { w: number; h: number } | undefined;
  /** A touch device (`ios`): a click lands as a tap; a mouse press means nothing to its pages. */
  touch?: boolean | undefined;
  /** The session's first page: ⌘W never closes it. */
  main: Page;
  /** Default the app (`overlay-host live`); tests pass a fake. */
  host?: (why: (reason: string) => void) => Promise<OverlayHost | null>;
  /** ⌘⇧O: the person asked for a real window; the tabs' URLs. */
  onWindow?: (urls: string[]) => Promise<string | null>;
  log?: (line: string) => void;
}

export interface LiveView {
  readonly port: number;
  /** Tests only: the socket's secret. */
  readonly token: string;
  /** The person moved the session to a window (⌘⇧O): its browser is closed. */
  readonly moved: boolean;
  /** A reason: the toast, the Dock bounce, the banner. null takes them away. */
  person(why: string | null): void;
  /** The overlay's host: the panel draws in the viewer, over the stream. */
  overlayHost(why: (reason: string) => void): Promise<OverlayHost | null>;
  /** The overlay's geometry: the viewport is the window. */
  geometry(page: Page): Promise<LiveGeometry | null>;
  close(): Promise<void>;
}

export interface LiveGeometry {
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; w: number; h: number };
  view: { outerW: number; outerH: number; innerW: number; innerH: number; dpr: number };
}

interface Tab {
  id: number;
  page: Page;
  /** null: no CDP (Firefox, WebKit); frames come from `page.screencast`. */
  cdp: CDPSession | null;
  title: string;
  /** The isolated world's context in the main frame. */
  world: number | null;
  /** The main frame's CDP id. */
  frame: string;
}

/** In from the viewer. */
type ViewerMsg = { t: string; [k: string]: unknown };

const byContext = new WeakMap<BrowserContext, LiveView>();

/** The live view on a context, if one runs. */
export function liveViewOf(context: BrowserContext): LiveView | null {
  return byContext.get(context) ?? null;
}

/** The page script, in an isolated world of every frame; acts in the top one only. */
const PAGE_SCRIPT = `(() => {
  if (window !== window.top || window.__abLive) return;
  window.__abLive = true;
  const send = (m) => { try { ${BINDING}(JSON.stringify(m)); } catch {} };
  // <select>: headless paints no popup; the viewer draws its own menu
  let open = null;
  addEventListener('mousedown', (e) => {
    const s = e.target instanceof Element ? e.target.closest('select') : null;
    if (!s || !e.isTrusted || e.button !== 0 || s.multiple || s.size > 1 || s.disabled) return;
    e.preventDefault();
    s.focus();
    open = s;
    const r = s.getBoundingClientRect();
    send({ t: 'select', rect: [r.x, r.y, r.width, r.height], at: s.selectedIndex,
      options: [...s.options].map((o) => ({ label: o.label || o.text, disabled: o.disabled,
        group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null })) });
  }, true);
  window.__abPick = (i) => {
    const s = open;
    open = null;
    if (!s || i < 0 || i >= s.options.length || s.selectedIndex === i) return;
    s.selectedIndex = i;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // cursor shape: headless draws none
  const TEXT = 'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea,[contenteditable=""],[contenteditable=true]';
  let cursor = '';
  addEventListener('mousemove', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    let c = getComputedStyle(t).cursor;
    if (c === 'auto') c = t.closest(TEXT) ? 'text' : t.closest('a[href]') ? 'pointer' : 'default';
    if (c !== cursor) { cursor = c; send({ t: 'cursor', c }); }
  }, { capture: true, passive: true });
  // copy and cut: what the page put on the clipboard, else the selection
  const selected = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'password'))) {
      try { if (a.selectionStart != null) return a.value.slice(a.selectionStart, a.selectionEnd); } catch {}
    }
    return String(getSelection() || '');
  };
  for (const k of ['copy', 'cut']) addEventListener(k, (e) => {
    const sel = selected();
    let sent = false;
    const go = (text) => { if (!sent) { sent = true; send({ t: 'copy', text }); } };
    addEventListener(k, (e2) => { if (e2 === e) go((e.defaultPrevented && e.clipboardData && e.clipboardData.getData('text/plain')) || sel); }, { once: true });
    setTimeout(() => go(sel), 0);
  }, true);
})();`;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** The toast: over every app, never key; Open brings the viewer, Later hides it and the bounce. */
export function toastHtml(site: string, why: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:rgba(250,250,252,.94);--fg:#16161a;--mut:#5b5b66;--line:rgba(0,0,0,.08);--btn:rgba(0,0,0,.06);--pri:#16161a;--onpri:#fff}
@media (prefers-color-scheme:dark){:root{--bg:rgba(32,32,38,.94);--fg:#f2f2f5;--mut:#a3a3ad;--line:rgba(255,255,255,.1);--btn:rgba(255,255,255,.08);--pri:#f2f2f5;--onpri:#16161a}}
html,body{margin:0;background:transparent;font:13px/1.35 -apple-system,system-ui,sans-serif;color:var(--fg);-webkit-user-select:none;cursor:default}
.c{box-sizing:border-box;height:88px;margin:4px;padding:12px 14px;border-radius:14px;background:var(--bg);border:1px solid var(--line);display:flex;gap:12px;align-items:center;-webkit-backdrop-filter:blur(20px);animation:in .18s cubic-bezier(.16,1,.3,1)}
@keyframes in{from{opacity:0;transform:translateY(-6px)}}
.t{flex:1;min-width:0}.h{font-weight:600}.r{color:var(--mut);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
button{font:inherit;font-weight:500;border:0;border-radius:8px;padding:6px 12px;background:var(--btn);color:var(--fg)}
button.p{background:var(--pri);color:var(--onpri)}.b{display:flex;flex-direction:column;gap:6px}
</style></head><body><div class="c"><div class="t"><div class="h">${esc(site)} needs you</div><div class="r">${esc(why)}</div></div>
<div class="b"><button class="p" onclick="post('open')">Open</button><button onclick="post('later')">Later</button></div></div>
<script>function post(t){window.ipc.postMessage(JSON.stringify({t}))}</script></body></html>`;
}

/** The viewer's size in CSS px, inside the fingerprint's screen. */
export function fitViewport(
  want: { w: number; h: number },
  screen: { width: number; height: number },
): { w: number; h: number } {
  return {
    w: Math.max(320, Math.min(Math.round(want.w), screen.width)),
    h: Math.max(240, Math.min(Math.round(want.h), screen.height - SCREEN_TOP - CHROME_TOP)),
  };
}

/** Stream frame size: CSS px × scale. */
export function streamSize(view: { w: number; h: number }, scale: number) {
  return { maxWidth: Math.round(view.w * scale), maxHeight: Math.round(view.h * scale) };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function startLiveView(
  context: BrowserContext,
  opts: LiveViewOptions,
): Promise<LiveView> {
  const log = opts.log ?? ((l: string) => console.error(`autobrowse live: ${l}`));
  const token = randomBytes(32).toString("hex");
  const tabs: Tab[] = [];
  const clients = new Set<WebSocket>();
  let nextId = 1;
  let shown: Tab | null = null;
  let streaming: Tab | null = null;
  let visible = false;
  let needs = "";
  let moved = false;
  let closed = false;
  let personAt = 0;
  let view = opts.fixed ?? fitViewport({ w: 1280, h: 800 }, opts.screen);
  /** The page the overlay follows: drawn only while it is the shown tab. */
  let followed: Page | null = null;
  const send = (m: object) => {
    const s = JSON.stringify(m);
    for (const c of clients) c.send(s);
  };

  // --- the app -------------------------------------------------------------
  let host: OverlayHost | null = null;
  let hostDead = false;
  let starting: Promise<OverlayHost | null> | null = null;
  const picks = new Map<number, (paths: string[]) => void>();
  let pickN = 0;
  const onHost = (e: HostEvent) => {
    if (e.t === "visible" && typeof e.on === "boolean") {
      visible = e.on;
      void stream();
    } else if (e.t === "closed") {
      visible = false;
      void stream();
    } else if (e.t === "picked" && typeof e.id === "number") {
      picks.get(e.id)?.(Array.isArray(e.paths) ? e.paths.map(String) : []);
      picks.delete(e.id);
    } else if (e.t === "exit") {
      hostDead = true;
      visible = false;
      void stream();
    }
  };
  const app = (): Promise<OverlayHost | null> => {
    if (host && !hostDead) return Promise.resolve(host);
    if (starting) return starting;
    starting = (opts.host ?? ((why) => nativeHost(why, "live")))((r) => log(r)).then((h) => {
      starting = null;
      if (closed) {
        h?.close();
        return null;
      }
      host = h;
      hostDead = false;
      if (h) {
        h.on(onHost);
        h.send({ t: "open", url: `http://127.0.0.1:${port}/?k=${token}` });
        if (needs) h.send({ t: "attention", html: toastHtml(opts.site, needs) });
      }
      return h;
    });
    return starting;
  };

  // --- tabs and frames -------------------------------------------------------
  const tabList = () =>
    send({
      t: "tabs",
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title || t.page.url(),
        url: t.page.url(),
        on: t === shown,
        main: t.page === opts.main,
      })),
      overlay: !!shown && shown.page === followed,
    });

  const frame = (t: Tab, data: string | Buffer) => {
    if (t !== streaming) return;
    const buf = typeof data === "string" ? Buffer.from(data, "base64") : data;
    for (const c of clients) if (c.bufferedAmount < BACKLOG) c.send(buf);
  };

  /** Frames flow only for the shown tab, while the viewer is on screen and connected. */
  let streamQ: Promise<void> = Promise.resolve();
  const stream = (): Promise<void> => {
    streamQ = streamQ.then(async () => {
      const want = visible && clients.size > 0 && !closed ? shown : null;
      const size = streamSize(view, opts.scale);
      const key = want ? `${want.id}:${size.maxWidth}x${size.maxHeight}` : "";
      if (key === streamKey) return;
      if (streaming?.cdp) await streaming.cdp.send("Page.stopScreencast").catch(() => undefined);
      else if (streaming) await streaming.page.screencast.stop().catch(() => undefined);
      streaming = want;
      streamKey = key;
      if (!want) return;
      if (!want.cdp) return castFrames(want, size);
      // a static page sends no frame: one screenshot first
      const shot = await want.cdp
        .send("Page.captureScreenshot", {
          format: "jpeg",
          quality: QUALITY,
          clip: { x: 0, y: 0, width: view.w, height: view.h, scale: opts.scale / opts.dpr },
        })
        .catch(() => null);
      if (shot) frame(want, shot.data);
      await want.cdp
        .send("Page.startScreencast", { format: "jpeg", quality: QUALITY, ...size })
        .catch((e: Error) => log(`screencast: ${e.message.split("\n")[0]}`));
    });
    return streamQ;
  };
  let streamKey = "";

  /** No CDP: Playwright's screencast, same JPEG frames; a screenshot first for a static page. */
  const castFrames = async (t: Tab, size: { maxWidth: number; maxHeight: number }) => {
    const shot = await t.page
      .screenshot({ type: "jpeg", quality: QUALITY, scale: "css" })
      .catch(() => null);
    if (shot) frame(t, shot);
    await t.page.screencast
      .start({
        onFrame: (f) => frame(t, f.data),
        size: { width: size.maxWidth, height: size.maxHeight },
        quality: QUALITY,
      })
      .catch((e: Error) => log(`screencast: ${e.message.split("\n")[0]}`));
  };

  const show = async (t: Tab) => {
    if (shown === t) return;
    shown = t;
    tabList();
    await stream();
  };

  /** Viewport, screen and window, as a real window of this size reports them. */
  const sizeTab = async (t: Tab) => {
    if (opts.fixed) return; // the device's own viewport, set at launch
    await t.page.setViewportSize({ width: view.w, height: view.h }).catch(() => undefined);
    if (!t.cdp) return;
    // Playwright's resize sets screen to the viewport: put the fingerprint's back
    await t.cdp
      .send("Emulation.setDeviceMetricsOverride", {
        width: view.w,
        height: view.h,
        deviceScaleFactor: opts.dpr,
        mobile: false,
        screenWidth: opts.screen.width,
        screenHeight: opts.screen.height,
      })
      .catch(() => undefined);
    const w = await t.cdp.send("Browser.getWindowForTarget").catch(() => null);
    if (w)
      await t.cdp
        .send("Browser.setWindowBounds", {
          windowId: w.windowId,
          bounds: { width: view.w, height: view.h + CHROME_TOP },
        })
        .catch(() => undefined);
  };

  const worldOf = async (t: Tab): Promise<number | null> => {
    if (t.world) return t.world;
    const cdp = t.cdp;
    if (!cdp) return null;
    const tree = await cdp.send("Page.getFrameTree").catch(() => null);
    if (!tree) return null;
    t.frame = tree.frameTree.frame.id;
    const w = await cdp
      .send("Page.createIsolatedWorld", { frameId: t.frame, worldName: WORLD })
      .catch(() => null);
    if (!w) return null;
    await cdp
      .send("Runtime.evaluate", { expression: PAGE_SCRIPT, contextId: w.executionContextId })
      .catch(() => undefined);
    t.world = w.executionContextId;
    return t.world;
  };

  const onBinding = (t: Tab, payload: string) => {
    let m: ViewerMsg;
    try {
      m = JSON.parse(payload) as ViewerMsg;
    } catch {
      return;
    }
    if (m.t === "copy" && typeof m.text === "string" && m.text) {
      host?.send({ t: "clip", text: m.text });
      return;
    }
    if (t !== shown) return;
    if (m.t === "select" || m.t === "cursor") send(m);
  };

  /** Chromium: CDP frames, and the page script in an isolated world (select menu, cursor, copy). */
  const attachCdp = async (t: Tab, cdp: CDPSession) => {
    cdp.on("Page.screencastFrame", (f) => {
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      frame(t, f.data);
    });
    cdp.on("Runtime.bindingCalled", (b) => {
      if (b.name === BINDING) onBinding(t, b.payload);
    });
    cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
      const aux = c.auxData as { isDefault?: boolean; frameId?: string } | undefined;
      if (c.name === WORLD && aux?.isDefault === false && aux.frameId === t.frame) t.world = c.id;
    });
    cdp.on("Runtime.executionContextsCleared", () => {
      t.world = null;
    });
    cdp.on("Page.frameNavigated", ({ frame: f }) => {
      if (!f.parentId) t.frame = f.id;
    });
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }),
      cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: PAGE_SCRIPT,
        worldName: WORLD,
      }),
    ]).catch((e: Error) => log(`tab setup: ${e.message.split("\n")[0]}`));
  };

  const add = async (page: Page) => {
    if (closed || tabs.some((t) => t.page === page)) return;
    // no CDP (Firefox, WebKit): frames and input still work; the page script stays off
    const cdp = await context.newCDPSession(page).catch(() => null);
    if (closed || tabs.some((t) => t.page === page)) return;
    const t: Tab = { id: nextId++, page, cdp, title: "", world: null, frame: "" };
    tabs.push(t);
    if (cdp) await attachCdp(t, cdp);
    page.on("filechooser", (fc) => {
      // the agent's own chooser stays the agent's; the person's opens the Mac panel
      if (Date.now() - personAt > PERSON_MS) return;
      void pick(fc.isMultiple()).then((files) =>
        files.length ? fc.setFiles(files).catch(() => undefined) : undefined,
      );
    });
    void worldOf(t);
    await sizeTab(t);
    page.on("framenavigated", (fr) => {
      if (fr !== page.mainFrame()) return;
      void page
        .title()
        .catch(() => "")
        .then((title) => {
          t.title = title;
          tabList();
        });
    });
    page.on("download", (d) => send({ t: "note", text: `Downloaded ${d.suggestedFilename()}` }));
    page.on("close", () => {
      tabs.splice(tabs.indexOf(t), 1);
      if (shown === t) {
        shown = null;
        const next = tabs.at(-1);
        if (next) void show(next);
        else void stream();
      }
      tabList();
    });
    // the first tab, and what a page opened (an OAuth popup): shown at once. Our own
    // background tabs (read tabs, the held tab) join the strip without taking the view.
    const opener = await page.opener().catch(() => null);
    if (!shown || opener) await show(t);
    else tabList();
  };

  const pick = async (multiple: boolean): Promise<string[]> => {
    const h = await app();
    if (!h) return [];
    const id = ++pickN;
    return new Promise((resolve) => {
      picks.set(id, resolve);
      h.send({ t: "pick", id, multiple });
    });
  };

  // --- dialogs ---------------------------------------------------------------
  const dialogs = new Map<number, (a: DialogAnswer | null) => void>();
  let dialogN = 0;
  askDialogsWith(context, async (d) => {
    // nobody looks: the default, as before
    if (!visible && !needs && Date.now() - personAt > PERSON_MS) return null;
    const id = ++dialogN;
    return new Promise<DialogAnswer | null>((resolve) => {
      const timer = setTimeout(() => {
        dialogs.delete(id);
        send({ t: "dialog-gone", id });
        resolve(null);
      }, DIALOG_MS);
      timer.unref();
      dialogs.set(id, (a) => {
        clearTimeout(timer);
        dialogs.delete(id);
        resolve(a);
      });
      send({ t: "dialog", id, type: d.type, message: d.message, value: d.defaultValue ?? "" });
    });
  });

  // --- input -----------------------------------------------------------------
  /** One input at a time: Playwright's keyboard holds modifier state. */
  let inputQ: Promise<unknown> = Promise.resolve();
  const queue = (fn: () => Promise<unknown>) => {
    inputQ = inputQ.then(fn).catch(() => undefined);
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const button = (v: unknown): "left" | "right" | "middle" =>
    v === "right" || v === "middle" ? v : "left";

  const urlOf = (s: string) =>
    /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[^\s]+\.[^\s]+$/.test(s) ? `https://${s}` : null;

  const onViewer = (m: ViewerMsg) => {
    const t = shown;
    const page = t?.page;
    switch (m.t) {
      case "size": {
        if (opts.fixed) return;
        const next = fitViewport({ w: num(m.w), h: num(m.h) }, opts.screen);
        if (next.w === view.w && next.h === view.h) return;
        view = next;
        void Promise.all(tabs.map(sizeTab)).then(() => stream());
        return;
      }
      case "visible":
        if (typeof m.on === "boolean") {
          visible = m.on;
          void stream();
        }
        return;
      case "mouse": {
        if (!page) return;
        personAt = Date.now();
        const x = num(m.x);
        const y = num(m.y);
        const o = { button: button(m.button), clickCount: Math.max(1, num(m.clickCount)) };
        if (opts.touch) {
          if (m.type === "up" && o.button === "left") queue(() => page.touchscreen.tap(x, y));
          return;
        }
        queue(async () => {
          await page.mouse.move(x, y);
          if (m.type === "down") await page.mouse.down(o);
          else if (m.type === "up") await page.mouse.up(o);
        });
        return;
      }
      case "wheel":
        if (!page) return;
        personAt = Date.now();
        queue(async () => {
          await page.mouse.move(num(m.x), num(m.y));
          await page.mouse.wheel(num(m.dx), num(m.dy));
        });
        return;
      case "key": {
        if (!page) return;
        personAt = Date.now();
        const key = str(m.key);
        if (!key) return;
        queue(async () => {
          if (m.type === "up") return page.keyboard.up(key).catch(() => undefined);
          // a key Playwright's layout lacks (é from ⌥e, emoji): text only
          return page.keyboard
            .down(key)
            .catch(() => (key.length <= 2 ? page.keyboard.insertText(key) : undefined));
        });
        return;
      }
      case "text":
        if (!page || !str(m.text)) return;
        personAt = Date.now();
        queue(() => page.keyboard.insertText(str(m.text)));
        return;
      case "copy":
      case "cut":
        if (!page) return;
        queue(() => page.keyboard.press(m.t === "copy" ? "Meta+KeyC" : "Meta+KeyX"));
        return;
      case "select": {
        if (!t) return;
        const i = Math.trunc(num(m.i));
        void worldOf(t).then((ctx) =>
          ctx && t.cdp
            ? t.cdp
                .send("Runtime.evaluate", { expression: `__abPick(${i})`, contextId: ctx })
                .catch(() => undefined)
            : undefined,
        );
        return;
      }
      case "dialog":
        dialogs.get(num(m.id))?.({
          accept: m.accept === true,
          ...(typeof m.text === "string" ? { text: m.text } : {}),
        });
        return;
      case "tab": {
        const x = tabs.find((y) => y.id === num(m.id));
        if (x) void show(x);
        return;
      }
      case "new":
        personAt = Date.now();
        void context
          .newPage()
          .then(async (p) => {
            const x = tabs.find((y) => y.page === p);
            if (x) await show(x);
          })
          .catch(() => undefined);
        return;
      case "close": {
        const x = tabs.find((y) => y.id === num(m.id));
        // the session's own page stays: the agent works in it
        if (x && x.page !== opts.main) void x.page.close().catch(() => undefined);
        return;
      }
      case "go": {
        const u = urlOf(str(m.url).trim());
        if (page && u) void page.goto(u).catch(() => undefined);
        return;
      }
      case "back":
        if (page) void page.goBack().catch(() => undefined);
        return;
      case "forward":
        if (page) void page.goForward().catch(() => undefined);
        return;
      case "reload":
        if (page) void page.reload().catch(() => undefined);
        return;
      case "window":
        void toWindow();
        return;
      // ⌃⌥P: as the headed host's global key, and the panel's Pause
      case "pause":
        personAt = Date.now();
        for (const fn of ov.fns) fn({ t: "js", pause: !ov.held });
        return;
      case "overlay-ready":
        ov.loaded = true;
        for (const js of ov.queue) send({ t: "ov-js", js });
        ov.queue = [];
        return;
      case "overlay": {
        // the panel's post: the native host's ipc, minus what only a window needs
        const { t: _, rect: _r, key: _k, ...rest } = (m.m ?? {}) as Record<string, unknown>;
        if (Object.keys(rest).length) for (const fn of ov.fns) fn({ t: "js", ...rest });
        return;
      }
    }
  };

  const toWindow = async () => {
    if (!opts.onWindow || moved) return;
    send({ t: "moving" });
    const urls = tabs.map((t) => t.page.url()).filter((u) => /^https?:/.test(u));
    const refused = await opts.onWindow(urls).catch((e: Error) => e.message);
    if (refused) {
      send({ t: "note", text: refused });
      send({ t: "moving", off: true });
      return;
    }
    moved = true;
  };

  // --- the overlay, drawn in the viewer --------------------------------------
  const ov = {
    html: "",
    shown: true,
    loaded: false,
    queue: [] as string[],
    fns: [] as Array<(e: HostEvent) => void>,
    view: null as null | { w: number; h: number },
    held: false,
  };
  const overlayHost = async (): Promise<OverlayHost | null> => {
    const h = await app();
    ov.fns = [];
    const adapter: OverlayHost = {
      ...(h?.pid ? { pid: h.pid } : {}),
      send(o) {
        switch (o.t) {
          case "html":
            ov.html = String(o.html ?? "");
            ov.loaded = false;
            ov.queue = [];
            send({ t: "ov-html", html: ov.html });
            return;
          case "js":
            if (ov.loaded && clients.size) send({ t: "ov-js", js: String(o.js ?? "") });
            else if (ov.queue.push(String(o.js ?? "")) > 500) ov.queue.shift();
            return;
          // the stream is the window: found at once
          case "target":
            queueMicrotask(() => {
              for (const fn of ov.fns) fn({ t: "found" });
            });
            return;
          case "view":
            ov.view = { w: Number(o.innerW) || view.w, h: Number(o.innerH) || view.h };
            send({ t: "ov-view", ...ov.view });
            return;
          // the menu bar item's state: ⌃⌥P flips it
          case "tray":
            ov.held = o.held === true;
            return;
          case "hide":
          case "show":
            ov.shown = o.t === "show";
            send({ t: "ov-shown", on: ov.shown });
            return;
        }
      },
      on(fn) {
        ov.fns.push(fn);
      },
      close() {
        ov.html = "";
        ov.fns = [];
        send({ t: "ov-html", html: "" });
      },
    };
    return adapter;
  };

  // --- the server --------------------------------------------------------------
  let port = 0;
  const allowed = (req: IncomingMessage): boolean => {
    // DNS rebinding: only our own address names us
    if (req.headers.host !== `127.0.0.1:${port}`) return false;
    const k = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).searchParams.get("k") ?? "";
    return sameSecret(k, token);
  };
  const viewerHtml = readFileSync(VIEWER, "utf8");
  const server: Server = createServer((req, res) => {
    if (!allowed(req)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ws://127.0.0.1:${port}; frame-src about:`,
    );
    res.end(viewerHtml);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4_000_000 });
  server.on("upgrade", (req, socket, head) => {
    // a page in the person's own browser cannot connect: its Origin is not ours
    if (!allowed(req) || req.headers.origin !== `http://127.0.0.1:${port}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("message", (d, binary) => {
        if (binary) return;
        try {
          onViewer(JSON.parse(String(d)) as ViewerMsg);
        } catch {
          // not a message of ours
        }
      });
      ws.on("close", () => {
        clients.delete(ws);
        void stream();
      });
      ws.send(
        JSON.stringify({
          t: "hello",
          site: opts.site,
          scale: opts.scale,
          view,
          needs,
          window: !!opts.onWindow,
        }),
      );
      if (ov.html) {
        ov.loaded = false;
        ws.send(JSON.stringify({ t: "ov-html", html: ov.html }));
        if (ov.view) ws.send(JSON.stringify({ t: "ov-view", ...ov.view }));
        ws.send(JSON.stringify({ t: "ov-shown", on: ov.shown }));
      }
      tabList();
      void stream();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  server.unref();
  port = (server.address() as AddressInfo).port;

  context.on("page", (p) => void add(p));
  for (const p of context.pages()) await add(p);
  void app();

  const live: LiveView = {
    port,
    token,
    get moved() {
      return moved;
    },
    person(why) {
      needs = why ?? "";
      send({ t: "needs", why: needs });
      if (!why) {
        host?.send({ t: "calm" });
        return;
      }
      // a viewer the person quit comes back for the next ask; a new one shows the toast itself
      if (host && !hostDead) host.send({ t: "attention", html: toastHtml(opts.site, why) });
      else void app();
    },
    overlayHost: () => overlayHost(),
    async geometry(page) {
      followed = page;
      tabList();
      return {
        pid: host?.pid ?? 0,
        windowId: 0,
        bounds: { x: 0, y: 0, w: view.w, h: view.h },
        view: { outerW: view.w, outerH: view.h, innerW: view.w, innerH: view.h, dpr: opts.dpr },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      askDialogsWith(context, null);
      for (const [, done] of dialogs) done(null);
      for (const c of clients) c.close();
      wss.close();
      server.close();
      host?.close();
      byContext.delete(context);
    },
  };
  byContext.set(context, live);
  return live;
}
