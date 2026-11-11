import { describe, expect, it } from "vitest";
import { SessionPark } from "../src/browser/park.js";
import { PoolFull, ProfileGate, ProfilePool } from "../src/browser/profile-pool.js";
import type { Session } from "../src/browser/session.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A session whose pages are plain objects: enough for the pool. */
function fakeSession(log: string[], name: string): Session {
  const page = { close: async () => void log.push(`close-tab ${name}`), evaluate: async () => 1 };
  return {
    page,
    context: {},
    close: async () => void log.push(`close ${name}`),
  } as unknown as Session;
}

describe("ProfileGate", () => {
  it("runs reads together up to the cap, a write alone, in arrival order", async () => {
    const g = new ProfileGate({ readers: 2, queue: 8 });
    const r1 = await g.acquire("p", "read");
    const r2 = await g.acquire("p", "read");
    const got: string[] = [];
    const w = g.acquire("p", "write").then((f) => {
      got.push("w");
      return f;
    });
    // A read after a queued write waits behind it: writes never starve.
    const r3 = g.acquire("p", "read").then((f) => {
      got.push("r3");
      return f;
    });
    await tick();
    expect(got).toEqual([]);
    expect(g.state("p")).toEqual({ readers: 2, writer: false, waiting: 2 });
    r1();
    await tick();
    expect(got).toEqual([]);
    r2();
    await tick();
    expect(got).toEqual(["w"]);
    (await w)();
    await tick();
    expect(got).toEqual(["w", "r3"]);
    (await r3)();
    expect(g.state("p")).toEqual({ readers: 0, writer: false, waiting: 0 });
  });

  it("keys are apart, and a full queue fails at once", async () => {
    const g = new ProfileGate({ readers: 1, queue: 1 });
    const a = await g.acquire("a", "write");
    const b = await g.acquire("b", "write");
    const queued = g.acquire("a", "read");
    await expect(g.acquire("a", "read")).rejects.toBeInstanceOf(PoolFull);
    a();
    (await queued)();
    b();
  });
});

describe("ProfilePool", () => {
  it("shares one browser among reads; the last one out parks it", async () => {
    const log: string[] = [];
    const park = new SessionPark({ idleMs: 60_000, max: 2 });
    let opened = 0;
    const pool = new ProfilePool({
      park,
      newTab: async () => ({ close: async () => void log.push("close-tab joined") }) as never,
      tidy: async (_s, o) => void log.push(`tidy keepTabs=${o.keepTabs}`),
    });
    const open = async () => fakeSession(log, `b${++opened}`);
    let releaseFirst = () => {};
    const first = pool.use("p", "read", open, async (lease) => {
      expect(lease.owner).toBe(true);
      expect(lease.reused).toBe(false);
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      return "one";
    });
    await tick();
    const second = await pool.use("p", "read", open, async (lease, leave) => {
      expect(lease.owner).toBe(false);
      expect(pool.users("p")).toBe(2);
      leave({ keepTabs: true });
      return "two";
    });
    expect(second).toBe("two");
    expect(log).toEqual(["close-tab joined"]);
    releaseFirst();
    expect(await first).toBe("one");
    expect(opened).toBe(1);
    // keepTabs from any user holds for the whole browser
    expect(log).toEqual(["close-tab joined", "tidy keepTabs=true"]);
    expect(park.size).toBe(1);
    // The next user takes the parked browser.
    await pool.use("p", "write", open, async (lease) => {
      expect(lease.reused).toBe(true);
    });
    expect(opened).toBe(1);
    await park.closeAll();
  });

  it("a discard closes the browser; fresh skips the parked one", async () => {
    const log: string[] = [];
    const park = new SessionPark({ idleMs: 60_000, max: 2 });
    let opened = 0;
    const pool = new ProfilePool({ park });
    const open = async () => fakeSession(log, `b${++opened}`);
    await pool.use("p", "write", open, async () => undefined);
    expect(park.size).toBe(1);
    await pool.use("p", "write", open, async (_l, leave) => leave({ discard: true }), {
      fresh: true,
    });
    expect(log).toEqual(["close b1", "close b2"]);
    expect(park.size).toBe(0);
  });

  it("a failed open lets the next caller in", async () => {
    const pool = new ProfilePool();
    await expect(
      pool.use(
        "p",
        "write",
        async () => {
          throw new Error("no browser");
        },
        async () => 1,
      ),
    ).rejects.toThrow("no browser");
    expect(pool.gate.state("p").writer).toBe(false);
  });
});
