import { describe, expect, it } from "vitest";
import { desktopHands } from "../src/desktop/hands.js";
import { overlaidDesktop } from "../src/desktop/overlaid.js";
import { fakeDesktop, fakeWindow } from "../src/desktop/types.js";
import type { OverlayHost } from "../src/explore/overlay-host.js";

function fakeHost(pid = 109) {
  const sent: Array<{ t: string; [k: string]: unknown }> = [];
  let closed = false;
  const host: OverlayHost = {
    pid,
    send: (o) => void sent.push(o),
    on: () => undefined,
    close: () => {
      closed = true;
    },
  };
  return { host: async () => host, sent, closed: () => closed };
}

/** Each `ui.draw` the host was sent: the panel state and the new trace rows (sent once each). */
const draws = (sent: Array<{ t: string; [k: string]: unknown }>) =>
  sent
    .filter((m) => m.t === "js" && String(m.js).startsWith("ui.draw"))
    .map((m) => {
      const [, view, rows] =
        /^ui\.draw\((.*), (\[.*\]), (?:true|false)\)$/s.exec(String(m.js)) ?? [];
      return {
        target: (JSON.parse(view ?? "{}") as { target: unknown }).target,
        rows: JSON.parse(rows ?? "[]") as Array<{ cmd: string; what: string; ok: boolean }>,
      };
    });
/** Every trace row, in order. */
const rows = (sent: Array<{ t: string; [k: string]: unknown }>) =>
  draws(sent).flatMap((d) => d.rows);

const claude = () => {
  const w = fakeWindow(
    "w-1",
    "Claude",
    "Claude",
    [
      ["textfield", "Prompt"],
      ["button", "Send"],
    ],
    { bounds: { x: 0, y: 0, w: 756, h: 982 }, focused: true },
  );
  w.nodes = w.nodes.map((n) =>
    n.name === "Send" ? { ...n, bounds: { x: 700, y: 900, w: 40, h: 30 } } : n,
  );
  return w;
};
const panel = () => fakeWindow("w-9", "overlay-host", "", []);

async function replay() {
  const d = fakeDesktop([claude(), panel()]);
  const h = fakeHost();
  const o = overlaidDesktop(d, { name: "film-director", deps: { host: h.host } });
  const hands = desktopHands(o.desktop);
  const win = { app: "Claude", title: "Claude" };
  return { d, h, o, hands, win };
}

describe("overlaidDesktop", () => {
  it("aims at the control from its display's top-left and adds a row per act", async () => {
    const { h, o, hands, win } = await replay();
    await hands.run({ op: "click", window: win, control: { role: "button", name: "Send" } });
    const ds = draws(h.sent);
    expect(ds.map((s) => s.target)).toContainEqual({ x: 700, y: 900, w: 40, h: 30 });
    expect(rows(h.sent).at(-1)).toMatchObject({ cmd: "click", what: 'button "Send"', ok: true });
    await o.close();
    expect(h.closed()).toBe(true);
  });

  it("a type row says how much, never the text", async () => {
    const { h, hands, win } = await replay();
    await hands.run({
      op: "type",
      window: win,
      control: { role: "textfield", name: "Prompt" },
      text: "hello there",
    });
    const row = rows(h.sent).at(-1);
    expect(row).toMatchObject({ cmd: "type", what: '11 chars in textfield "Prompt"' });
    expect(JSON.stringify(h.sent)).not.toContain("hello there");
  });

  it("hides for headed input and shows again", async () => {
    const { d, h, hands, win } = await replay();
    await hands.run({
      op: "click",
      window: win,
      control: { role: "button", name: "Send" },
      headed: true,
    });
    const ts = h.sent.map((m) => m.t);
    expect(ts.indexOf("hide")).toBeGreaterThan(-1);
    expect(ts.lastIndexOf("show")).toBeGreaterThan(ts.indexOf("hide"));
    expect(d.calls).toContainEqual(expect.objectContaining({ call: "click", mode: "headed" }));
  });

  it("a failed act is a failed row, and the error still throws", async () => {
    const { h, hands, win } = await replay();
    await hands.run({ op: "click", window: win, control: { role: "button", name: "Send" } });
    const d2 = (await hands.windowFor(win)).id;
    expect(d2).toBe("w-1");
    await expect(
      hands.run({ op: "focus", window: { app: "Claude", title: "nope" } }),
    ).rejects.toThrow();
    // no window found: nothing ran, so no row; the earlier row stays
    expect(rows(h.sent).map((r) => r.cmd)).toEqual(["click"]);
  });

  it("leaves its own window out of window lists", async () => {
    const { o, h } = await replay();
    await o.desktop.find("w-1", { role: "button", name: "Send" });
    // the host opens on the first draw; its pid is then known
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent.length).toBeGreaterThan(0);
    const ws = await o.desktop.windows();
    expect(ws.map((w) => w.id)).toEqual(["w-1"]);
  });
});
