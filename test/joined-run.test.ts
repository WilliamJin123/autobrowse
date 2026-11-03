import * as restate from "@restatedev/restate-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetRuns, joinedRun, KEEP_MS } from "../src/browser/joined-run.js";
import { waitForProfile } from "../src/browser/profile-wait.js";

// WA-1023: a dropped stream's replay must not run the browser flow (and spend the cap) again.
describe("joinedRun", () => {
  beforeEach(forgetRuns);

  it("a replay while the first try runs joins it: one run, one value", async () => {
    let runs = 0;
    let finish: (v: string) => void = () => undefined;
    const fn = () => {
      runs++;
      return new Promise<string>((r) => {
        finish = r;
      });
    };
    const first = joinedRun("inv_a sites linkedin GET /search", fn);
    const replay = joinedRun("inv_a sites linkedin GET /search", fn);
    finish("50 posts");
    expect(await first).toBe("50 posts");
    expect(await replay).toBe("50 posts");
    expect(runs).toBe(1);
    // another invocation, or another step, runs on its own
    await joinedRun("inv_b sites linkedin GET /search", async () => "b");
    expect(runs).toBe(1);
  });

  it("a replay after the end takes the kept value or terminal error, until KEEP_MS", async () => {
    let t = 0;
    const now = () => t;
    let runs = 0;
    const ok = async () => ++runs;
    expect(await joinedRun("k", ok, now)).toBe(1);
    t = KEEP_MS - 1;
    expect(await joinedRun("k", ok, now)).toBe(1);
    t = 2 * KEEP_MS + 1;
    expect(await joinedRun("k", ok, now)).toBe(2);
    const cap = async () => {
      runs++;
      throw new restate.TerminalError("linkedin search cap");
    };
    await expect(joinedRun("t", cap, now)).rejects.toThrow("cap");
    await expect(joinedRun("t", cap, now)).rejects.toThrow("cap");
    expect(runs).toBe(3);
  });

  it("a retryable error is not kept: Restate's retry runs the step again", async () => {
    let runs = 0;
    const flaky = async () => {
      if (++runs === 1) throw new Error("page.goto: timeout");
      return "ok";
    };
    await expect(joinedRun("r", flaky)).rejects.toThrow("timeout");
    expect(await joinedRun("r", flaky)).toBe("ok");
    expect(runs).toBe(2);
  });

  it("waitForProfile keys the join by invocation and step name", async () => {
    // each try (the first, its replay) gets its own ctx, as from Restate
    const ctxOf = () =>
      ({
        run: (_: string, fn: () => Promise<unknown>) => fn(),
        sleep: async () => undefined,
      }) as never;
    let runs = 0;
    let finish: () => void = () => undefined;
    const fn = () => {
      runs++;
      return new Promise<string>((r) => {
        finish = () => r("read");
      });
    };
    const a = waitForProfile(ctxOf(), "sites x GET /a", fn, { invocation: "inv_1" });
    const b = waitForProfile(ctxOf(), "sites x GET /a", fn, { invocation: "inv_1" });
    const c = waitForProfile(ctxOf(), "sites x GET /a", async () => "own");
    finish();
    expect([await a, await b, await c]).toEqual(["read", "read", "own"]);
    expect(runs).toBe(1);
    // one try that runs the name twice (a call again after a re-made token) runs it twice
    const ctx = ctxOf();
    const again = async () => ++runs;
    await waitForProfile(ctx, "sites x GET /b", again, { invocation: "inv_2" });
    await waitForProfile(ctx, "sites x GET /b", again, { invocation: "inv_2" });
    expect(runs).toBe(3);
  });
});
