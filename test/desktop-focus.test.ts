import { describe, expect, it } from "vitest";
import { seeded } from "../src/browser/human/draw.js";
import { desktopHands, IDLE_MS, keyOf } from "../src/desktop/hands.js";
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

/** What the presses leave in the box: chars by their combos, Backspace erases. */
function typed(calls: FakeCall[], text: string): string {
  const back = new Map([...text].map((ch) => [keyOf(ch), ch]));
  let out = "";
  for (const c of calls) {
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
  it("types human key by key, headed, to the window; the journal keeps human", async () => {
    const d = fakeDesktop([claude()], { focusedId: undefined });
    const h = desktopHands(d, { ...clock(), random: seeded(7) });
    await h.act({ op: "snapshot", window: "w-1" });
    const text = "Use autobrowse to post on X, ~/Movies/post.txt word for word.";
    const r = await h.act({ op: "type", ref: "@s1:e1", text, human: true });
    expect(r.op).toMatchObject({ op: "type", human: true, headed: true, text });
    const presses = d.calls.filter((c) => c.call === "press");
    expect(presses.every((c) => c.mode === "headed" && c.windowId === "w-1")).toBe(true);
    expect(d.calls.some((c) => c.call === "type")).toBe(false);
    expect(typed(d.calls, text)).toBe(text);
  });

  it("stops when the person takes focus, waits for them, goes on from the same key", async () => {
    const d = fakeDesktop([claude(), term()]);
    const press = d.press.bind(d);
    const seenFront: string[] = [];
    let n = 0;
    d.press = async (combo, where, mode) => {
      seenFront.push(d.windowsList.find((w) => w.pid === claude().pid) ? "ok" : "?");
      await press(combo, where, mode);
      if (++n === 5) d.focus("w-2"); // the person clicks their terminal
    };
    const front: string[] = [];
    const frontPid = d.frontPid?.bind(d);
    d.frontPid = async () => {
      const pid = (await frontPid?.()) ?? null;
      front.push(pid === claude().pid ? "claude" : "other");
      return pid;
    };
    const h = desktopHands(d, { ...clock(), random: seeded(3) });
    await h.act({ op: "snapshot", window: "w-1" });
    const text = "make it shorter";
    await h.act({ op: "type", ref: "@s1:e1", text, human: true });
    expect(typed(d.calls, text)).toBe(text);
    // the key after the switch waited: focus was taken again before any press
    const i = d.calls.findIndex(
      (c, j) =>
        j > 0 &&
        c.call === "focusWindow" &&
        c.windowId === "w-1" &&
        d.calls.slice(0, j).filter((x) => x.call === "press").length === 5,
    );
    expect(i).toBeGreaterThan(0);
    expect(front).toContain("other");
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
    expect(d.calls.filter((c) => c.call === "press")).toEqual([]);
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
    expect(kept.calls.at(-1)?.call).toBe("press");
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
