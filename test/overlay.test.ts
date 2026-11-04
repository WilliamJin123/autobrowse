import { type Browser, chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { Command } from "../src/explore/commands.js";
import { type Geometry, overlayFor, traceRow } from "../src/explore/overlay.js";
import type { HostEvent, OverlayHost } from "../src/explore/overlay-host.js";

const PAGE = `<button onclick="this.textContent='Hit'">Save</button><a href="#x">Docs</a>`;
const row = { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] };

/**
 * The native window as a page: `html` loads it, `js` runs in it, its `postMessage` comes back
 * as the host's `js` line. What the WKWebView does, in Chromium.
 */
async function webHost(browser: Browser) {
  const view = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const sent: Array<{ t: string; [k: string]: unknown }> = [];
  const fns: Array<(e: HostEvent) => void> = [];
  const rects: number[][] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let made = 0;
  let closed = false;
  await view.exposeBinding("__post", (_s, m: { rect: number[]; [k: string]: unknown }) => {
    const { rect, ...rest } = m;
    rects.push(rect);
    for (const fn of fns) fn({ t: "js", ...rest });
  });
  await view.addInitScript(
    "window.webkit = { messageHandlers: { host: { postMessage: (m) => window.__post(m) } } }",
  );
  let html = "";
  // a navigation, not setContent: init scripts (the webkit stub) run only on a new document
  await view.route("https://panel.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: html }),
  );
  const errors: unknown[] = [];
  const queue = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).catch((e) => errors.push(e));
  };
  const host: OverlayHost = {
    send(o) {
      sent.push(o);
      if (o.t === "html")
        queue(() => {
          html = o.html as string;
          return view.goto("https://panel.test/");
        });
      else if (o.t === "js") queue(() => view.evaluate(o.js as string));
    },
    on(fn) {
      fns.push(fn);
    },
    close() {
      closed = true;
    },
  };
  return {
    view,
    sent,
    rects,
    emit: (e: HostEvent) => {
      for (const fn of fns) fn(e);
    },
    factory: async () => {
      made++;
      return host;
    },
    /** Every line sent so far has run in the view. */
    idle: async () => {
      await chain;
      if (errors.length) throw errors[0];
      await view.evaluate("0");
    },
    get made() {
      return made;
    },
    get closed() {
      return closed;
    },
  };
}

const FAKE_GEO: Geometry = {
  pid: 1,
  windowId: 7,
  bounds: { x: 0, y: 0, w: 1000, h: 800 },
  view: { outerW: 1000, outerH: 800, innerW: 1000, innerH: 700, dpr: 1 },
};
const geo =
  (g: Partial<Geometry["view"]> = {}) =>
  async () => ({
    ...FAKE_GEO,
    view: { ...FAKE_GEO.view, ...g },
  });

/** A button's centre in the panel, by its action. */
const btnAt = (view: Page, a: string) =>
  view.evaluate<{ x: number; y: number }>(
    `(() => { const r = [...ui.tuiEl.querySelectorAll('[data-a]')].find((b) => b.getAttribute('data-a') === '${a}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
const panelBox = (view: Page) =>
  view.evaluate("ui.tuiEl.getBoundingClientRect().toJSON()") as Promise<DOMRect>;

/** A page that counts every way it could notice us. */
const TRAPS = `${PAGE}<script>
  window.hits = { mut: 0, read: 0, ev: 0 };
  new MutationObserver((l) => hits.mut += l.length).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const k of ['innerHeight', 'innerWidth', 'outerHeight', 'outerWidth', 'devicePixelRatio', 'screenX', 'screenY']) {
    const d = Object.getOwnPropertyDescriptor(window, k);
    Object.defineProperty(window, k, { configurable: true, get() { hits.read++; return d.get.call(window); } });
  }
  for (const k of ['focus', 'blur', 'scroll', 'resize', 'pointerdown', 'pointermove', 'mousedown', 'mousemove', 'click', 'keydown', 'wheel'])
    addEventListener(k, () => hits.ev++, true);
  document.addEventListener('visibilitychange', () => hits.ev++);
  window.globals = 0;
  globals = Object.keys(window).length;
</script>`;

describe("headed overlay, out of the page", () => {
  it("leaves nothing in the page: no node, global, main-world read or event; shots and aria unchanged", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(TRAPS);
      let requests = 0;
      page.on("request", () => requests++);
      const aria = await page.locator("body").ariaSnapshot();
      const shot = await page.screenshot();
      const o = overlayFor(true, { host: h.factory });
      const drawn = await o.set(page, {
        goal: "save the form",
        step: "1 of 25",
        thought: "the Save button submits it",
        refs: [
          { n: 1, hints: { role: "button", name: "Save" } },
          { n: 2, hints: { role: "link", name: "Docs" } },
          { n: 3, hints: { role: "button", name: "Gone" } },
        ],
      });
      // A ref whose control is not there gets no box.
      expect(drawn).toEqual({ drawn: true, boxes: 2 });
      await o.begin(page, "click");
      await o.flash(page, { role: "button", name: "Save" }, "click: save", "save the draft");
      await o.end(page, row);
      await o.marked(page, [{ n: 1, box: { x: 1, y: 2, w: 3, h: 4 } }]);
      await o.after(page);
      await h.idle();
      // The window got the drawing and the geometry, read in an isolated world.
      expect(await h.view.evaluate("ui.s.thought")).toBe("save the draft");
      const view = h.sent.find((m) => m.t === "view");
      expect(view).toMatchObject({ innerW: 800, innerH: 600 });
      expect(h.sent.find((m) => m.t === "target")).toBeTruthy();
      // The page saw nothing.
      expect(await page.evaluate("JSON.stringify(hits)")).toBe(
        JSON.stringify({ mut: 0, read: 0, ev: 0 }),
      );
      expect(requests).toBe(0);
      expect(await page.evaluate("Object.keys(window).length === globals")).toBe(true);
      expect(await page.evaluate("document.documentElement.outerHTML")).not.toMatch(/data-o|tui/);
      expect(await page.locator("body").ariaSnapshot()).toBe(aria);
      expect((await page.screenshot()).equals(shot)).toBe(true);
      await o.remove(page);
      expect(h.closed).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("draws on pages that broke the in-page panel: strict CSP and Trusted Types, a hostile DOM, full screen", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      await page.route("https://tt.test/", (r) =>
        r.fulfill({
          contentType: "text/html",
          headers: {
            "content-security-policy":
              "require-trusted-types-for 'script'; style-src 'self'; script-src 'self'",
          },
          body: PAGE,
        }),
      );
      await page.goto("https://tt.test/");
      const o = overlayFor(true, { host: h.factory });
      expect(await o.set(page, { goal: "x" })).toMatchObject({ drawn: true });
      await h.idle();
      expect(
        await h.view.evaluate(
          "[...ui.tuiEl.querySelectorAll('.bar [data-a]')].map((e) => e.getAttribute('data-a'))",
        ),
      ).toEqual(["look", "marks", "theme", "min"]);
      expect(await h.view.evaluate("getComputedStyle(ui.tuiEl).borderRadius")).toBe("14px");
      // A page that breaks the DOM and JSON for everyone, frame-busts, and goes full screen.
      // a navigation: the last page's Trusted Types would refuse setContent's write
      await page.route("https://hostile.test/", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<button id="fs" onclick="document.documentElement.requestFullscreen()">fs</button><script>
        if (top !== self) top.location = self.location;
        Element.prototype.attachShadow = () => { throw new Error('no'); };
        document.createElement = () => { throw new Error('no'); };
        JSON.stringify = () => 'x';
      </script>`,
        }),
      );
      await page.goto("https://hostile.test/");
      await o.loaded(page);
      await page.click("#fs");
      await page.waitForFunction("!!document.fullscreenElement");
      const before = h.sent.filter((m) => m.t === "view").length;
      await o.set(page, { thought: "in full screen" });
      await h.idle();
      expect(h.sent.filter((m) => m.t === "view").length).toBeGreaterThan(before);
      expect(await h.view.evaluate("ui.s.thought")).toBe("in full screen");
    } finally {
      await browser.close();
    }
  });

  it("the window says when it moved: the geometry is read again", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      let calls = 0;
      const o = overlayFor(true, {
        host: h.factory,
        geometry: async () => {
          calls++;
          return { ...FAKE_GEO, view: { ...FAKE_GEO.view, innerH: calls > 1 ? 800 : 700 } };
        },
      });
      await o.set(page, { goal: "x" });
      h.emit({ t: "moved" });
      await new Promise((r) => setTimeout(r, 50));
      expect(h.sent.filter((m) => m.t === "view").map((m) => m.innerH)).toEqual([700, 800]);
      // Lost: the next draw names the window again.
      h.emit({ t: "lost" });
      await new Promise((r) => setTimeout(r, 50));
      expect(h.sent.filter((m) => m.t === "target").length).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it("boxes scale by the page's zoom over the window's", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo({ dpr: 2.5 }) });
      await o.marked(page, [{ n: 1, box: { x: 10, y: 10, w: 10, h: 10 } }]);
      await h.idle();
      expect(await h.view.evaluate("document.querySelector('.marks').style.transform")).toBe(
        "scale(2.5)",
      );
    } finally {
      await browser.close();
    }
  });

  it("minimized, the panel is a tab at the left edge, and the rect that takes the mouse is the tab's", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "save the form" });
      await o.end(page, row);
      await h.idle();
      const min = await btnAt(h.view, "min");
      await h.view.mouse.click(min.x, min.y);
      expect(await h.view.evaluate("[ui.min, ui.tuiEl]")).toEqual([true, null]);
      // the settled rect, after the tab's slide-in
      await expect.poll(() => h.rects.at(-1)?.[0]).toBe(0);
      expect(h.rects.at(-1)?.[2]).toBeLessThan(30);
      // A redraw from the session keeps it minimized; the tab brings it back.
      await o.end(page, row);
      await h.idle();
      await h.view.mouse.click(4, 350);
      expect(await h.view.evaluate("ui.min")).toBe(false);
      await expect.poll(() => h.rects.at(-1)?.[2]).toBe(460);
    } finally {
      await browser.close();
    }
  });

  it("the look button switches panel and terminal; a failed row has no mark in the panel", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "save the form" });
      await o.end(page, { ...row, ok: false, note: "not visible" });
      await h.idle();
      const look = () => h.view.evaluate<string>("ui.tuiEl.parentNode.className");
      const mark = () =>
        h.view.evaluate<string>("getComputedStyle(ui.tuiEl.querySelector('.row .mk')).display");
      expect(await look()).toMatch(/^wrap panel (light|dark)$/);
      expect(await mark()).toBe("none");
      const b = await btnAt(h.view, "look");
      await h.view.mouse.click(b.x, b.y);
      expect(await look()).toBe("wrap term");
      expect(await mark()).not.toBe("none");
      // A redraw keeps it.
      await o.end(page, row);
      await h.idle();
      expect(await look()).toBe("wrap term");
    } finally {
      await browser.close();
    }
  });

  it("the bar drags the panel anywhere and any corner sizes it", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "save the form" });
      await o.end(page, { ...row, note: "→ a.com/next" });
      await h.idle();
      const v = h.view;
      const before = await panelBox(v);
      expect(before.width).toBe(460);
      await v.mouse.move(before.left + 150, before.top + 8);
      await v.mouse.down();
      await v.mouse.move(600, 100, { steps: 5 });
      await v.mouse.up();
      const moved = await panelBox(v);
      expect([moved.left, moved.top]).toEqual([450, 92]);
      // Dropped: the host learns the new rect.
      expect(h.rects.at(-1)?.slice(0, 2)).toEqual([450, 92]);
      await v.mouse.move(moved.right - 4, moved.bottom - 4);
      await v.mouse.down();
      await v.mouse.move(moved.right + 46, moved.bottom + 196, { steps: 5 });
      await v.mouse.up();
      const sized = await panelBox(v);
      expect(Math.round(sized.width)).toBe(Math.round(moved.width + 50));
      expect(Math.round(sized.height)).toBe(Math.round(moved.height + 200));
      // The top left corner: that edge moves, the bottom right stays.
      await v.mouse.move(sized.left + 3, sized.top + 3);
      await v.mouse.down();
      await v.mouse.move(sized.left + 203, sized.top + 53, { steps: 5 });
      await v.mouse.up();
      const pulled = await panelBox(v);
      expect([pulled.right, pulled.bottom].map(Math.round)).toEqual(
        [sized.right, sized.bottom].map(Math.round),
      );
      // Narrow: smaller type, and the clock column goes.
      const font = () =>
        v.evaluate(`parseFloat(getComputedStyle(ui.tuiEl.querySelector('.body')).fontSize)`);
      const wide = await font();
      await v.mouse.move(pulled.left + 3, pulled.top + 3);
      await v.mouse.down();
      await v.mouse.move(pulled.right - 200, pulled.top + 3, { steps: 5 });
      await v.mouse.up();
      expect(Math.round((await panelBox(v)).width)).toBe(220);
      expect(await font()).toBeLessThan(wide);
      expect(await v.evaluate(`getComputedStyle(ui.tuiEl.querySelector('.row .at')).display`)).toBe(
        "none",
      );
      // A redraw keeps the place and the size.
      const last = await panelBox(v);
      await o.end(page, row);
      await h.idle();
      expect(await panelBox(v)).toEqual(last);
    } finally {
      await browser.close();
    }
  });

  it("the boxes button turns the boxes off, and off they are not looked up", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      const refs = [{ n: 1, hints: { role: "button", name: "Save" } }] as const;
      expect(await o.set(page, { goal: "x", refs: [...refs] })).toEqual({ drawn: true, boxes: 1 });
      await h.idle();
      const marks = await btnAt(h.view, "marks");
      await h.view.mouse.click(marks.x, marks.y);
      expect(await h.view.evaluate("ui.marks")).toBe(false);
      // Off: no count, no box, no flash.
      expect(await o.set(page, { refs: [...refs] })).toEqual({ drawn: true });
      await o.flash(page, { role: "button", name: "Save" }, "click: save");
      await h.idle();
      expect(await h.view.evaluate("ui.s.target")).toBeNull();
      const again = await btnAt(h.view, "marks");
      await h.view.mouse.click(again.x, again.y);
      expect(await o.set(page, { refs: [...refs] })).toEqual({ drawn: true, boxes: 1 });
    } finally {
      await browser.close();
    }
  });

  it("the theme and trace buttons flip and stay through redraws", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "x" });
      await o.end(page, row);
      await h.idle();
      const theme = () => h.view.evaluate<string>("ui.tuiEl.parentNode.className");
      const was = await theme();
      const t = await btnAt(h.view, "theme");
      await h.view.mouse.click(t.x, t.y);
      expect(await theme()).not.toBe(was);
      const tr = await btnAt(h.view, "trace");
      await h.view.mouse.click(tr.x, tr.y);
      expect(
        await h.view.evaluate("getComputedStyle(ui.tuiEl.querySelector('.rows')).display"),
      ).toBe("none");
      await o.end(page, row);
      await h.idle();
      expect(await theme()).not.toBe(was);
      expect(await h.view.evaluate("ui.trace")).toBe(false);
      // Folded, the trace button sits in the corner grip's square: the press is the button's.
      const back = await btnAt(h.view, "trace");
      await h.view.mouse.click(back.x, back.y);
      expect(await h.view.evaluate("ui.trace")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("a marks shot's boxes stay drawn in its colours; the boxes button hides and shows them", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.marked(page, [{ n: 1, box: { x: 20, y: 40, w: 60, h: 20 } }]);
      await h.idle();
      expect(await h.view.evaluate("document.querySelectorAll('.box').length")).toBe(1);
      const marks = await btnAt(h.view, "marks");
      await h.view.mouse.click(marks.x, marks.y);
      expect(await h.view.evaluate("document.querySelectorAll('.box').length")).toBe(0);
      // Kept while off: on again, they come back with no new shot.
      expect(await h.view.evaluate("ui.s.boxes.length")).toBe(1);
      // An act changes the page: its marks go.
      await o.after(page);
      await h.idle();
      expect(await h.view.evaluate("ui.s.boxes.length")).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("the trace scrolls and keeps its place as rows come; each draw sends only new rows", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "read" });
      for (let i = 0; i < 40; i++) await o.end(page, { ...row, what: `r${i}` });
      await h.idle();
      const v = h.view;
      const rows = "ui.tuiEl.querySelector('.rows')";
      const r = (await v.evaluate(`${rows}.getBoundingClientRect().toJSON()`)) as DOMRect;
      await v.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await v.mouse.wheel(0, 120);
      await v.waitForFunction(`${rows}.scrollTop > 0`);
      const was = await v.evaluate<number>(`${rows}.scrollTop`);
      const first = () =>
        v.evaluate(
          `[...${rows}.children].find((e) => e.getBoundingClientRect().top >= ${rows}.getBoundingClientRect().top).textContent`,
        );
      const seenRow = await first();
      await o.end(page, { ...row, what: "new" });
      await h.idle();
      expect(await v.evaluate<number>(`${rows}.scrollTop`)).toBeGreaterThan(was);
      expect(await first()).toBe(seenRow);
      expect(await v.evaluate(`${rows}.childElementCount`)).toBe(41);
      const last = h.sent.filter((m) => m.t === "js").at(-1)?.js as string;
      expect(last.match(/"what":"/g)?.length).toBe(1);
      // A new document keeps the trace.
      await page.setContent(PAGE);
      await o.loaded(page);
      await h.idle();
      expect(await v.evaluate(`${rows}.childElementCount`)).toBe(41);
      expect(await v.evaluate(`${rows}.firstChild.textContent`)).toContain("new");
    } finally {
      await browser.close();
    }
  });

  it("toggles off and on for the session, and keeps its trace", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "save the form" });
      await o.end(page, row);
      await o.toggle(page, false);
      expect(h.sent.at(-1)).toEqual({ t: "hide" });
      // Off, the session's commands draw nothing.
      const n = h.sent.length;
      await o.end(page, { ...row, what: "x" });
      expect(h.sent.length).toBe(n);
      expect(await o.toggle(page, true)).toEqual({ drawn: true });
      expect(h.sent.some((m) => m.t === "show")).toBe(true);
      await h.idle();
      expect(await h.view.evaluate("ui.s.count")).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("off, no window is made; no host for the platform, set says why", async () => {
    const browser = await chromium.launch();
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const off = overlayFor(false, { host: h.factory });
      expect(await off.set(page, { goal: "x" })).toEqual({ drawn: false });
      await off.flash(page, { role: "button", name: "Save" }, "click");
      expect(h.made).toBe(0);
      const none = overlayFor(true, {
        host: async (why) => {
          why("the overlay has no window host for freebsd");
          return null;
        },
      });
      expect(await none.set(page, { goal: "x" })).toEqual({
        drawn: false,
        why: "the overlay has no window host for freebsd",
      });
    } finally {
      await browser.close();
    }
  });

  it("a host still starting: off keeps it hidden, a closed context ends it", async () => {
    const browser = await chromium.launch();
    // a host that is ready only when told
    const slow = (h: Awaited<ReturnType<typeof webHost>>) => {
      let go = () => {};
      const started = new Promise<void>((r) => {
        go = r;
      });
      return {
        go: () => go(),
        factory: async (why: (r: string) => void) => {
          await started;
          return h.factory(why);
        },
      };
    };
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const a = slow(h);
      const o = overlayFor(true, { host: a.factory, geometry: geo() });
      const drawing = o.set(page, { goal: "x" });
      await o.toggle(page, false);
      a.go();
      await drawing;
      const at = (t: string) => h.sent.findIndex((m) => m.t === t);
      expect(at("hide")).toBeGreaterThanOrEqual(0);
      expect(at("hide")).toBeLessThan(at("target"));

      const h2 = await webHost(browser);
      const ctx = await browser.newContext();
      const b = slow(h2);
      const o2 = overlayFor(true, { host: b.factory, geometry: geo() });
      const drawing2 = o2.set(await ctx.newPage(), { goal: "x" });
      await ctx.close();
      b.go();
      expect(await drawing2).toEqual({ drawn: false });
      expect(h2.closed).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("a host that never finds Chrome's window says why; a later find clears it", async () => {
    const browser = await chromium.launch();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const h = await webHost(browser);
      const page = await browser.newPage();
      const o = overlayFor(true, { host: h.factory, geometry: geo() });
      await o.set(page, { goal: "x" });
      h.emit({ t: "found" });
      await wait(3_200);
      expect(o.why).toBeNull();
      // the window went; the new target is never found (Wayland)
      h.emit({ t: "lost" });
      await wait(3_200);
      expect(h.sent.filter((m) => m.t === "target")).toHaveLength(2);
      expect(o.why).toMatch(/cannot find Chrome's window/);
      h.emit({ t: "found" });
      expect(o.why).toBeNull();
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("the page's context closing ends the window", async () => {
    const browser = await chromium.launch();
    const h = await webHost(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const o = overlayFor(true, { host: h.factory, geometry: geo() });
    await o.set(page, { goal: "x" });
    await ctx.close();
    expect(h.closed).toBe(true);
    await browser.close();
  });

  it("a row's note says where the page went and what changed, never a value", () => {
    const r = traceRow(
      { cmd: "click", hints: { role: "button", name: "Go" } } as Command,
      null,
      9,
      {
        from: "https://a.com/x",
        to: "https://a.com/next?token=t",
        answer: { changed: { added: ["a", "b"], gone: 3, more: 1 } },
      },
    );
    expect(r.note).toBe("→ a.com/next · +3 −3 controls");
    const read = traceRow({ cmd: "read", hints: { css: "p" } } as Command, null, 1, {
      from: "u",
      to: "u",
      answer: { as: "text", text: "secret words" },
    });
    expect(read.note).toBe("12 chars read");
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(traceRow({ cmd: "click", hints: {} } as Command, new Error("gone\nstack"), 1).note).toBe(
      "gone",
    );
  });

  it("a trace row names the aim, never a typed value or a query", () => {
    const fill = traceRow(
      { cmd: "fill", hints: { role: "textbox", name: "Email" }, value: "me@x.com" } as Command,
      null,
      41.6,
    );
    expect(fill).toMatchObject({ cmd: "fill", what: 'textbox "Email"', ok: true, ms: 42 });
    expect(JSON.stringify(fill)).not.toContain("me@x.com");
    expect(traceRow({ cmd: "type", text: "secret" } as Command, null, 1).what).toBe("6 chars");
    expect(traceRow({ cmd: "open", url: "https://a.com/p?token=t" } as Command, null, 1).what).toBe(
      "a.com/p",
    );
    const bad = traceRow(
      { cmd: "click", hints: { text: "Go" } } as Command,
      new Error("no such"),
      3,
    );
    expect(bad.ok).toBe(false);
    expect(bad.detail.at(-1)).toBe("error no such");
  });
});
