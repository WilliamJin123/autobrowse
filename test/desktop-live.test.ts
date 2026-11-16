/**
 * The real desktop: a Ghostty of its own, placed, typed into headed, waited on, killed.
 * Takes focus for a few seconds. Out of the gate: `DESKTOP_LIVE=1 vitest run test/desktop-live.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { desktopHands } from "../src/desktop/hands.js";
import { localDesktop } from "../src/desktop/mac.js";

const live = process.env.DESKTOP_LIVE === "1";

describe.skipIf(!live)("desktop live", () => {
  it("types into a fresh terminal and sees its echo, nowhere else", async () => {
    const d = localDesktop();
    const h = desktopHands(d);
    const stamp = `abl${Date.now().toString(36)}`;
    // a launch that attached to William's Ghostty would hand back its pid: kill only a new one
    const before = new Set((await d.windows("Ghostty")).map((w) => w.pid));
    const launched = await h.act({
      op: "launch",
      app: "Ghostty",
      fresh: true,
      // restore off: a new instance reopens the last session's windows beside its own
      args: ["--window-save-state=never", `--title=${stamp}`],
    });
    const pid = (launched.answer as { pid: number }).pid;
    const fresh = !before.has(pid);
    try {
      expect(fresh).toBe(true);
      const w = await h.windowFor({ app: "Ghostty", title: stamp });
      expect(w.pid).toBe(pid);
      expect((await d.windows("Ghostty")).filter((x) => x.pid === pid)).toHaveLength(1);
      if (process.env.DESKTOP_LIVE_INPUT !== "1") return; // first pass: launch and check only
      await h.act({ op: "place", window: w.id, x: 0, y: 40, w: 720, h: 480 });
      // the typed line holds `$((40+2))`, never the marker: the wait sees only the echo
      const typed = await h.act({ op: "type", window: w.id, text: `echo ${stamp}-$((40+2))` });
      expect(typed.op).toMatchObject({ op: "type", headed: true });
      // a terminal takes a headless key (to its pid): the only-window check runs first anyway
      await h.act({ op: "key", combo: "return", window: w.id });
      const seen = await h.act({ op: "wait", window: w.id, text: `${stamp}-42`, timeoutS: 30 });
      expect(seen.answer).toMatchObject({ found: true });
    } finally {
      if (fresh) await d.shell(`kill ${pid}`, false);
    }
  }, 120_000);
});
