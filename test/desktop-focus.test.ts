import { describe, expect, it } from "vitest";
import { seeded } from "../src/browser/human/draw.js";
import {
  coarsePath,
  desktopHands,
  IDLE_MS,
  keyOf,
  MOVE_MS,
  RUN_INTERVAL_MS,
} from "../src/desktop/hands.js";
import { type FakeCall, fakeDesktop, fakeWindow } from "../src/desktop/types.js";

const claude = () => fakeWindow("w-1", "Claude", "Claude", [["textfield", "Prompt"]]);
const term = () => fakeWindow("w-2", "Ghostty", "~ zsh", [["textfield", ""]]);
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

/** What the runs and presses leave in the box: chars by their combos, Backspace erases. */
function typed(calls: FakeCall[], text: string): string {
  const back = new Map([...text].map((ch) => [keyOf(ch), ch]));
  let out = "";
  for (const c of calls) {
    if (c.call === "type") for (const ch of c.text) out = ch === "\b" ? out.slice(0, -1) : out + ch;
    if (c.call !== "press") continue;
    out = c.combo === "backspace" ? out.slice(0, -1) : out + (back.get(c.combo) ?? "?");
  }
  return out;
}

describe("keyOf", () => {
  it("maps a US layout: letters, capitals, shifted and plain punctuation", () => {
    expect([..."aZ5 ~?.,\n"].map(keyOf)).toEqual([
      "a",
      "shift+z",
      "5",
      "space",
      "shift+grave",
      "shift+slash",
      "period",
      "comma",
      "shift+return",
    ]);
    expect(() => keyOf("é")).toThrow(/no US key/);
  });
});

describe("focus lease", () => {
  it("paceMs types headless at that pace, takes no focus, and stays out of the journal", async () => {
    const d = fakeDesktop([claude()], { focusedId: undefined });
    const h = desktopHands(d, clock());
    await h.act({ op: "snapshot", window: "w-1" });
    const r = await h.act({ op: "type", ref: "@s1:e1", text: "hi", paceMs: 60 });
    expect(d.calls.filter((c) => c.call === "type")).toEqual([
      expect.objectContaining({ mode: "headless", intervalMs: 60, text: "hi" }),
    ]);
    expect(d.calls.some((c) => c.call === "focus")).toBe(false);
    expect(r.op).not.toHaveProperty("paceMs");
  });

  it("types human in runs at the film pace, headed, to the field; the journal keeps human", async () => {
    const d = fakeDesktop([claude()], { focusedId: undefined });
    const h = desktopHands(d, { ...clock(), random: seeded(7) });
    await h.act({ op: "snapshot", window: "w-1" });
    const text = "Use autobrowse to post on X, ~/Movies/post.txt word for word.";
    const r = await h.act({ op: "type", ref: "@s1:e1", text, human: true });
    expect(r.op).toMatchObject({ op: "type", human: true, headed: true, text });
    const input = d.calls.filter((c) => c.call === "press" || c.call === "type");
    expect(input.every((c) => c.mode === "headed" && c.windowId === "w-1")).toBe(true);
    const runs = input.filter((c) => c.call === "type");
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.length).toBeLessThan(text.length / 2); // words, not keys
    expect(runs.every((c) => c.intervalMs === RUN_INTERVAL_MS)).toBe(true);
    expect(typed(d.calls, text)).toBe(text);
  });

  it("stops when the person takes focus, waits for them, goes on from the same run", async () => {
    const d = fakeDesktop([claude(), term()]);
    const type = d.type.bind(d);
    let n = 0;
    d.type = async (ref, text, mode, every) => {
      await type(ref, text, mode, every);
      if (++n === 2) d.focus("w-2"); // the person clicks their terminal
    };
    const h = desktopHands(d, { ...clock(), random: seeded(3) });
    await h.act({ op: "snapshot", window: "w-1" });
    const text = "make it way shorter and to the point";
    await h.act({ op: "type", ref: "@s1:e1", text, human: true });
    expect(typed(d.calls, text)).toBe(text);
    const runsBefore = (j: number) => d.calls.slice(0, j).filter((x) => x.call === "type").length;
    const back = d.calls.findIndex(
      (c, j) => c.call === "focusWindow" && c.windowId === "w-1" && runsBefore(j) === 2,
    );
    expect(back).toBeGreaterThan(0);
    expect(d.calls.slice(back).some((c) => c.call === "type")).toBe(true);
  });

  it("waits until the person is idle before taking focus", async () => {
    const d = fakeDesktop([claude()], { idle: [100, 900, IDLE_MS + 1] });
    const c = clock();
    const h = desktopHands(d, { ...c, random: seeded(1) });
    await h.act({ op: "snapshot", window: "w-1" });
    await h.act({ op: "type", ref: "@s1:e1", text: "hi", human: true });
    expect(c.now()).toBeGreaterThanOrEqual(IDLE_MS - 100 + IDLE_MS - 900);
  });

  it("gives up, sending nothing, when the person never stops", async () => {
    const d = fakeDesktop([claude()], { idle: [0] });
    const h = desktopHands(d, { ...clock(), random: seeded(1) });
    await h.act({ op: "snapshot", window: "w-1" });
    await expect(h.act({ op: "type", ref: "@s1:e1", text: "hi", human: true })).rejects.toThrow(
      /nothing was sent/,
    );
    expect(d.calls.filter((c) => c.call === "press" || c.call === "type")).toEqual([]);
  });

  it("gives focus back to the app that had it", async () => {
    const d = fakeDesktop([claude(), term()], { focusedId: undefined });
    d.focus("w-2");
    const h = desktopHands(d, { ...clock(), random: seeded(1) });
    await h.act({ op: "snapshot", window: "w-1" });
    await h.act({ op: "type", ref: "@s1:e1", text: "ok", human: true });
    expect(d.calls.at(-1)).toEqual({ call: "focusWindow", windowId: "w-2" });
    const kept = fakeDesktop([claude(), term()]);
    kept.focus("w-2");
    const h2 = desktopHands(kept, { ...clock(), random: seeded(1), giveFocusBack: false });
    await h2.act({ op: "snapshot", window: "w-1" });
    await h2.act({ op: "type", ref: "@s1:e1", text: "ok", human: true });
    expect(kept.calls.at(-1)?.call).toBe("type");
  });

  it("refuses keys sent from a shell, and human with a secret", async () => {
    const d = fakeDesktop([claude()]);
    const h = desktopHands(d, { ...clock(), secret: async () => "x" });
    await expect(
      h.act({
        op: "shell",
        command: `osascript -e 'tell application "System Events" to keystroke "a"'`,
      }),
    ).rejects.toThrow(/focus lease/);
    await expect(
      h.act({ op: "type", window: "w-1", secret: "profile.phone", human: true }),
    ).rejects.toThrow(/without human/);
    expect(d.calls).toEqual([]);
  });

  it("replays a human type the same way", async () => {
    const d = fakeDesktop([claude()]);
    const h = desktopHands(d, { ...clock(), random: seeded(2) });
    await h.run({
      op: "type",
      window: { app: "Claude", title: "Claude" },
      control: { role: "textfield", name: "Prompt" },
      text: "go",
      human: true,
      headed: true,
    });
    expect(typed(d.calls, "go")).toBe("go");
    expect(d.calls.some((c) => c.call === "click" && c.mode === "headed")).toBe(true);
  });
});

describe("render", () => {
  it("keeps human on a typed desktop op", async () => {
    const { structure } = await import("../src/compiler/structure.js");
    const { render } = await import("../src/compiler/render.js");
    const src =
      render(
        structure({
          name: "prompt",
          site: "scratch",
          startedAt: "2026-11-17T10:00:00Z",
          finishedAt: "2026-11-17T10:01:00Z",
          trace: null,
          terminal: null,
          commands: [],
          actions: [
            { t: 0, kind: "note", url: "about:blank", text: "Prompt" },
            {
              t: 1,
              kind: "desktop",
              url: "",
              op: {
                op: "type",
                window: { app: "Claude", title: "Claude" },
                control: { role: "textfield", name: "Prompt" },
                text: "go",
                human: true,
                headed: true,
              },
              redacted: false,
            },
          ],
        }),
      ).files["index.ts"] ?? "";
    expect(src).toContain("human: true, headed: true })");
  });
});

describe("mouse path", () => {
  it("coarsePath keeps the end and the total wait", () => {
    const path = Array.from({ length: 10 }, (_, i) => ({ x: i, y: i, after: 14 }));
    const c = coarsePath(path);
    expect(c.at(-1)).toMatchObject({ x: 9, y: 9 });
    expect(c.reduce((n, s) => n + s.after, 0)).toBe(140);
    expect(c.slice(0, -1).every((s) => s.after >= MOVE_MS)).toBe(true);
  });

  it("a headed click reaches the control along a path, then clicks inside it", async () => {
    const d = fakeDesktop([claude()], { headedOnly: ["Claude"], pointer: { x: 700, y: 500 } });
    const h = desktopHands(d, { ...clock(), random: seeded(3) });
    await h.act({ op: "snapshot", window: "w-1" });
    const r = await h.act({ op: "click", ref: "@s1:e1" });
    expect(r.op).toMatchObject({ op: "click", headed: true });
    const moves = d.calls.filter((c) => c.call === "move");
    const at = d.calls.find((c) => c.call === "clickAt");
    expect(moves.length).toBeGreaterThan(3);
    expect(d.calls.some((c) => c.call === "click" && c.mode === "headed")).toBe(false);
    // inside the field's box (10,10 100×24), not its exact middle every time
    expect(at).toBeDefined();
    if (at?.call !== "clickAt") return;
    expect(at.x).toBeGreaterThan(10);
    expect(at.x).toBeLessThan(110);
    expect(at.y).toBeGreaterThan(10);
    expect(at.y).toBeLessThan(34);
  });

  it("no pointer API: the headed click is agent-desktop's", async () => {
    const d = fakeDesktop([claude()], { headedOnly: ["Claude"] });
    const h = desktopHands(d, { ...clock(), random: seeded(3) });
    await h.act({ op: "snapshot", window: "w-1" });
    await h.act({ op: "click", ref: "@s1:e1" });
    expect(d.calls.some((c) => c.call === "click" && c.mode === "headed")).toBe(true);
  });
});
