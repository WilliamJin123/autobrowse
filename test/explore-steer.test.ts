import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { Geometry } from "../src/explore/overlay.js";
import type { HostEvent, OverlayHost } from "../src/explore/overlay-host.js";
import { startExplore } from "../src/explore/server.js";

const PAGE = `data:text/html,${encodeURIComponent(
  `<input id="d"><button id="go" onclick="document.title='clicked';this.after(Object.assign(document.createElement('p'),{textContent:'Done'}))">Go</button>`,
)}`;
const GEO: Geometry = {
  pid: 1,
  windowId: 7,
  bounds: { x: 0, y: 0, w: 1000, h: 800 },
  view: { outerW: 1000, outerH: 800, innerW: 1000, innerH: 700, dpr: 1 },
};
/** A command still waiting after this long is held. */
const pending = async (p: Promise<unknown>, ms = 300) =>
  Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

describe("the panel's Pause and notes steer the agent", () => {
  it("holds commands, runs them on an unchanged resume, refuses them after a person acted; notes ride answers, a note resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explore-steer-"));
    const fns: Array<(e: HostEvent) => void> = [];
    let page: Page | null = null;
    const host: OverlayHost = {
      send: () => undefined,
      on: (fn) => void fns.push(fn),
      close: () => undefined,
    };
    const panel = (m: Record<string, unknown>) => {
      for (const fn of fns) fn({ t: "js", ...m });
    };
    const ex = await startExplore({
      site: "scratch",
      port: 0,
      recordingsDir: join(dir, "recordings"),
      overlay: true,
      overlayDeps: {
        host: async () => host,
        geometry: async (p) => {
          page = p;
          return GEO;
        },
      },
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    });
    try {
      await ex.exec({ cmd: "open", url: PAGE });
      expect(fns.length).toBeGreaterThan(0);

      // A note outside a pause rides the next answer, once.
      panel({ note: "  use the second account  " });
      const noted = (await ex
        .exec({ cmd: "url" })
        .then(() => ex.exec({ cmd: "eval", js: "1 + 1" }))) as { notes?: string[] };
      expect(noted.notes).toEqual(["use the second account"]);
      expect(
        ((await ex.exec({ cmd: "eval", js: "2 + 2" })) as { notes?: string[] }).notes,
      ).toBeUndefined();

      // Pause, no change: the held command runs on resume.
      panel({ pause: true });
      await expect.poll(() => ex.paused()).toBe(true);
      expect(await ex.exec({ cmd: "resume" })).toMatchObject({ paused: true, by: "person" });
      const held = ex.exec({ cmd: "eval", js: "document.title" });
      expect(await pending(held)).toBe(true);
      panel({ pause: false });
      expect(await held).toMatchObject({ result: expect.any(String) });

      // Pause, the person acts: the held command and the one queued behind it answer `steer`.
      await new Promise((r) => setTimeout(r, 800)); // past the agent's own late events
      panel({ pause: true });
      await expect.poll(() => ex.paused()).toBe(true);
      const first = ex.exec({ cmd: "click", hints: { role: "button", name: "Go" } });
      const second = ex.exec({ cmd: "eval", js: "document.title" });
      expect(await pending(first)).toBe(true);
      await (page as unknown as Page).evaluate("document.getElementById('go').click()");
      // the note is the person's go: no Resume press
      panel({ note: "I clicked it for you" });
      await expect.poll(() => ex.paused()).toBe(false);
      const a = (await first) as { ran: boolean; steer: Record<string, unknown> };
      expect(a.ran).toBe(false);
      expect(a.steer).toMatchObject({ acts: 1, notes: ["I clicked it for you"] });
      expect(a.steer.changed).toBeTruthy();
      expect(await second).toMatchObject({ ran: false, steer: { acts: 1 } });
      // sent after the resume: runs
      expect(await ex.exec({ cmd: "eval", js: "document.title" })).toMatchObject({
        result: "clicked",
      });
      const kinds = (
        (await ex.exec({ cmd: "journal" })) as { actions: Array<{ kind: string; text?: string }> }
      ).actions;
      expect(kinds.filter((k) => k.kind === "note").map((k) => k.text)).toContain(
        "person: I clicked it for you",
      );
    } finally {
      await ex.exec({ cmd: "close" }).catch(() => undefined);
      await ex.done;
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});
