import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DesktopSession,
  displayOf,
  screenSurface,
  startDesktopSession,
} from "../src/desktop/session.js";
import { fakeDesktop, fakeWindow } from "../src/desktop/types.js";
import type { HostEvent, OverlayHost } from "../src/explore/overlay-host.js";

/** A command still waiting after this long is held. */
const pending = async (p: Promise<unknown>, ms = 300) =>
  Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

/** The overlay's window: records what it is sent; `panel` plays the person's buttons and note box. */
function fakeHost(pid = 109) {
  const fns: Array<(e: HostEvent) => void> = [];
  const sent: Array<{ t: string; [k: string]: unknown }> = [];
  const ui = {
    s: null as Record<string, unknown> | null,
    draw(s: Record<string, unknown>) {
      ui.s = s;
    },
  };
  const host: OverlayHost = {
    pid,
    send: (o) => {
      sent.push(o);
      if (o.t === "js" && String(o.js).startsWith("ui.draw"))
        new Function("ui", o.js as string)(ui);
    },
    on: (fn) => void fns.push(fn),
    close: () => undefined,
  };
  return {
    host: async () => host,
    sent,
    ui,
    panel: (m: Record<string, unknown>) => {
      for (const fn of fns) fn({ t: "js", ...m });
    },
    opened: () => fns.length > 0,
  };
}

const calc = () =>
  fakeWindow(
    "w-1",
    "Calculator",
    "Calculator",
    [
      ["button", "7"],
      ["button", "Buy $20 of credits"],
      ["textfield", "Display", "0"],
    ],
    { bounds: { x: 300, y: 400, w: 230, h: 410 }, focused: true },
  );
const term = () => fakeWindow("w-2", "Ghostty", "zsh", [["textfield", "Terminal", "$ "]]);
/** The overlay's own window, as list-windows shows it. */
const panelWindow = () => fakeWindow("w-9", "overlay-host", "", []);

let dir = "";
let open: DesktopSession | null = null;
afterEach(async () => {
  if (open) await open.exec({ cmd: "close" }).catch(() => undefined);
  await open?.done;
  open = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function session(
  windows = [calc(), term(), panelWindow()],
  o: { approve?: () => Promise<boolean | null>; headedOnly?: string[]; snapMs?: number } = {},
) {
  dir = await mkdtemp(join(tmpdir(), "desktop-session-"));
  const d = fakeDesktop(windows, { headedOnly: o.headedOnly ?? [] });
  if (o.snapMs) {
    // a real snapshot takes ~0.5 s
    const snap = d.snapshot.bind(d);
    d.snapshot = async (...a) => {
      const r = await snap(...a);
      await new Promise((ok) => setTimeout(ok, o.snapMs));
      return r;
    };
  }
  const h = fakeHost();
  const s = await startDesktopSession({
    name: "test",
    port: 0,
    recordingsDir: join(dir, "recordings"),
    tokenFile: join(dir, "explore-0.token"),
    journalFile: join(dir, "journal.jsonl"),
    desktop: d,
    overlayDeps: { host: h.host },
    sleep: async () => undefined,
    windowTries: 1,
    ...(o.approve ? { approve: o.approve } : {}),
  });
  open = s;
  return { s, d, h };
}

describe("desktop session: steering over a window", () => {
  it("holds a command on Pause and runs it on an unchanged Resume", async () => {
    const { s, h } = await session();
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } });
    expect(h.opened()).toBe(true);
    h.panel({ pause: true });
    await expect.poll(() => s.paused()).toBe(true);
    expect(await s.exec({ cmd: "resume" })).toMatchObject({ paused: true, by: "person" });
    const held = s.exec({ cmd: "os", act: { op: "windows" } });
    expect(await pending(held)).toBe(true);
    h.panel({ pause: false });
    expect(await held).toMatchObject({ windows: expect.any(Array) });
  });

  it("refuses a held command after the person changed the window, with their notes", async () => {
    const { s, d, h } = await session();
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } });
    h.panel({ pause: true });
    await expect.poll(() => s.paused()).toBe(true);
    const held = s.exec({ cmd: "os", act: { op: "windows" } });
    // the person typed into the display and wrote a note
    const w = d.windowsList.find((x) => x.id === "w-1");
    if (!w) throw new Error("no w-1");
    w.nodes = w.nodes.map((n) => (n.name === "Display" ? { ...n, value: "77" } : n));
    h.panel({ note: "I typed 77 for you" });
    h.panel({ pause: false });
    const a = (await held) as { ran?: boolean; steer?: Record<string, unknown> };
    expect(a.ran).toBe(false);
    expect(a.steer).toMatchObject({
      window: "Calculator w-1",
      notes: ["I typed 77 for you"],
      changed: { added: ['- textfield "Display": 77'], gone: 1 },
    });
    expect(String(a.steer?.note)).toContain("Read the window");
    // the next command runs
    expect(await s.exec({ cmd: "os", act: { op: "windows" } })).toMatchObject({
      windows: expect.any(Array),
    });
    const kinds = ((await s.exec({ cmd: "journal" })) as { actions: Array<{ kind: string }> })
      .actions;
    expect(kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(["pause", "resume", "note"]));
  });

  it("a resume during the pause's capture still compares (live: snapshot ~0.5 s)", async () => {
    const { s, d, h } = await session(undefined, { snapMs: 60 });
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } });
    h.panel({ pause: true });
    await expect.poll(() => s.paused()).toBe(true);
    const held = s.exec({ cmd: "os", act: { op: "windows" } });
    h.panel({ pause: false });
    const w = d.windowsList.find((x) => x.id === "w-1");
    if (!w) throw new Error("no w-1");
    w.nodes = w.nodes.map((n) => (n.name === "Display" ? { ...n, value: "7" } : n));
    expect(await held).toMatchObject({ ran: false, steer: { changed: { gone: 1 } } });
  });

  it("refuses after the person moved to another window", async () => {
    const { s, d, h } = await session();
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } });
    h.panel({ pause: true });
    await expect.poll(() => s.paused()).toBe(true);
    const held = s.exec({ cmd: "os", act: { op: "windows" } });
    await d.focusWindow("w-2");
    h.panel({ pause: false });
    expect(await held).toMatchObject({
      ran: false,
      steer: { from: "Calculator w-1", window: "Ghostty w-2" },
    });
  });

  it("a note outside a pause rides the next answer once", async () => {
    const { s, h } = await session();
    await s.exec({ cmd: "os", act: { op: "windows" } });
    h.panel({ note: "  use the left screen  " });
    const a = (await s.exec({ cmd: "os", act: { op: "windows" } })) as { notes?: string[] };
    expect(a.notes).toEqual(["use the left screen"]);
    const b = (await s.exec({ cmd: "os", act: { op: "windows" } })) as { notes?: string[] };
    expect(b.notes).toBeUndefined();
  });

  it("the agent's own pause and resume", async () => {
    const { s } = await session();
    expect(await s.exec({ cmd: "pause" })).toEqual({ paused: true });
    expect(await s.exec({ cmd: "resume" })).toMatchObject({ paused: false, handActs: 0 });
  });
});

describe("desktop session: acts", () => {
  it("a click that spends waits for a yes; a no refuses it and nothing is clicked", async () => {
    const asked: string[] = [];
    const { s, d } = await session(undefined, {
      approve: async () => {
        asked.push("buy");
        return false;
      },
    });
    const snap = (await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } })) as {
      tree: string;
    };
    const ref = /"Buy \$20 of credits" (@\S+)/.exec(snap.tree)?.[1];
    expect(ref).toBeTruthy();
    await expect(s.exec({ cmd: "os", act: { op: "click", ref: ref as string } })).rejects.toThrow(
      /payment|refused|denied/i,
    );
    expect(asked).toEqual(["buy"]);
    expect(d.calls.filter((c) => c.call === "click")).toEqual([]);
  });

  it("with no approver a spending click is refused", async () => {
    const { s, d } = await session();
    const snap = (await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } })) as {
      tree: string;
    };
    const ref = /"Buy \$20 of credits" (@\S+)/.exec(snap.tree)?.[1] as string;
    await expect(s.exec({ cmd: "os", act: { op: "click", ref } })).rejects.toThrow(
      /needs a person/,
    );
    expect(d.calls.filter((c) => c.call === "click")).toEqual([]);
  });

  it("aims the overlay at the control, in points from its display's top-left", async () => {
    const w = calc();
    w.nodes = w.nodes.map((n) =>
      n.name === "7" ? { ...n, bounds: { x: 320, y: 600, w: 40, h: 30 } } : n,
    );
    const { s, h } = await session([w, term(), panelWindow()]);
    const snap = (await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } })) as {
      tree: string;
    };
    const ref = /"7" (@\S+)/.exec(snap.tree)?.[1] as string;
    const seen: unknown[] = [];
    const before = h.sent.length;
    await s.exec({ cmd: "os", act: { op: "click", ref } });
    for (const m of h.sent.slice(before))
      if (m.t === "js" && String(m.js).startsWith("ui.draw"))
        seen.push(JSON.parse(/^ui\.draw\((.*), \[/.exec(String(m.js))?.[1] ?? "{}").target);
    expect(seen).toContainEqual({ x: 320, y: 600, w: 40, h: 30 });
  });

  it("headed input runs with the overlay hidden", async () => {
    const { s, d, h } = await session([calc(), term(), panelWindow()], { headedOnly: ["Ghostty"] });
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-2" } });
    const before = h.sent.length;
    const a = await s.exec({ cmd: "os", act: { op: "type", window: "w-2", text: "ls" } });
    expect(a).toMatchObject({ ok: true, headed: true });
    const ts = h.sent.slice(before).map((m) => m.t);
    expect(ts.indexOf("hide")).toBeGreaterThanOrEqual(0);
    expect(ts.indexOf("show")).toBeGreaterThan(ts.indexOf("hide"));
    expect(d.calls.find((c) => c.call === "type")).toMatchObject({ mode: "headed", text: "ls" });
  });

  it("leaves the overlay's own window out of windows", async () => {
    const { s } = await session();
    await s.exec({ cmd: "goal", text: "open the calculator" });
    const a = (await s.exec({ cmd: "os", act: { op: "windows" } })) as {
      windows: Array<{ app: string }>;
    };
    expect(a.windows.map((w) => w.app)).not.toContain("overlay-host");
    expect(a.windows.map((w) => w.app)).toContain("Calculator");
  });

  it("journals desktop rows with no page, saves them as a desktop recording", async () => {
    const { s } = await session();
    await s.exec({ cmd: "os", act: { op: "focus", window: { app: "Calculator", title: "Calc" } } });
    const j = (await s.exec({ cmd: "journal" })) as {
      actions: Array<{ kind: string; url: string }>;
    };
    expect(j.actions).toEqual([expect.objectContaining({ kind: "desktop", url: "" })]);
    const saved = (await s.exec({ cmd: "save", name: "calc-focus" })) as { dir: string };
    const rec = JSON.parse(readFileSync(join(saved.dir, "manifest.json"), "utf8")) as {
      site: string;
      actions: unknown[];
    };
    expect(rec.site).toBe("desktop");
    expect(rec.actions).toHaveLength(1);
  });

  it("refuses page commands", async () => {
    const { s } = await session();
    await expect(s.exec({ cmd: "open", url: "https://example.com" })).rejects.toThrow(
      /page commands need explore/,
    );
  });
});

describe("desktop session: the wire", () => {
  it("writes explore's token and info files, answers over loopback, removes them on close", async () => {
    const { s } = await session();
    const token = join(dir, "explore-0.token");
    const info = JSON.parse(readFileSync(join(dir, "explore-0.json"), "utf8")) as {
      site: string;
      port: number;
    };
    expect(info).toMatchObject({ site: "desktop:test", port: s.port });
    const post = (body: object, auth = readFileSync(token, "utf8")) =>
      fetch(`http://127.0.0.1:${s.port}/`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}` },
        body: JSON.stringify(body),
      });
    expect((await post({ cmd: "url" })).status).toBe(200);
    expect((await post({ cmd: "url" }, "wrong")).status).toBe(401);
    const page = await post({ cmd: "aria" });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("page commands need explore");
    // a resend with the same id answers the first time's answer
    const first = await (await post({ cmd: "note", text: "one", id: "n1" })).json();
    const again = await (await post({ cmd: "note", text: "one", id: "n1" })).json();
    expect(first).toEqual({ ok: true });
    expect(again).toEqual({ ok: true, repeat: true });
    await post({ cmd: "close" });
    await s.done;
    open = null;
    expect(existsSync(token)).toBe(false);
    expect(existsSync(join(dir, "explore-0.json"))).toBe(false);
  });
});

describe("screen geometry", () => {
  const ds = [
    { id: "a", bounds: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2, primary: true },
    { id: "b", bounds: { x: 1512, y: 0, w: 1920, h: 1080 }, scale: 1, primary: false },
  ];

  it("the whole display of the window; no pid; a gone window: the primary", async () => {
    const d = fakeDesktop([calc()]);
    const screen = {
      pid: 0,
      windowId: 1,
      bounds: { x: 0, y: 0, w: 1512, h: 982 },
      view: { outerW: 1512, outerH: 982, innerW: 1512, innerH: 982, dpr: 2 },
      screen: true,
    };
    expect(await screenSurface(d).geometry({ id: "w-1" })).toEqual(screen);
    expect(await screenSurface(d).geometry({ id: "w-404" })).toEqual(screen);
  });

  it("a second display: its own bounds and scale; boxes from its top-left", async () => {
    const w = { ...calc(), bounds: { x: 1600, y: 100, w: 230, h: 410 } };
    const d = { ...fakeDesktop([w]), displays: async () => ds };
    const s = screenSurface(d);
    expect(await s.geometry({ id: "w-1" })).toMatchObject({
      windowId: 2,
      bounds: ds[1]?.bounds,
      view: { dpr: 1 },
    });
    expect(await s.local({ x: 1700, y: 300, w: 40, h: 30 }, w.bounds)).toEqual({
      x: 188,
      y: 300,
      w: 40,
      h: 30,
    });
  });

  it("picks the display under the window's center, else the primary", () => {
    const ds = [
      { id: "a", bounds: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2, primary: true },
      { id: "b", bounds: { x: 1512, y: 0, w: 1920, h: 1080 }, scale: 1, primary: false },
    ];
    expect(displayOf(ds, { x: 1600, y: 100, w: 400, h: 300 })?.id).toBe("b");
    expect(displayOf(ds, { x: -5000, y: 0, w: 10, h: 10 })?.id).toBe("a");
  });

  it("the host is sent the window's display as a screen target", async () => {
    const { s, h } = await session();
    await s.exec({ cmd: "os", act: { op: "snapshot", window: "w-1" } });
    expect(h.sent).toContainEqual({
      t: "target",
      pid: 0,
      x: 0,
      y: 0,
      w: 1512,
      h: 982,
      screen: true,
    });
    expect(h.sent).toContainEqual(expect.objectContaining({ t: "view", innerW: 1512, dpr: 2 }));
    // the screen panel starts bottom right, off the app on the left
    expect(String(h.sent.find((m) => m.t === "html")?.html)).toContain('"corner":"right"');
  });
});
