// The local runner on SQLite (designs/2026-11-16-local-runner.md, "Tests").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crash, sqliteStore, startRunner } from "../src/runtime/index.js";
import * as restate from "../src/runtime/sdk.js";
import { conformance, type Status } from "./runtime/scenarios.js";

const dirs: string[] = [];
const dbFile = () => {
  const d = mkdtempSync(join(tmpdir(), "runner-"));
  dirs.push(d);
  return join(d, "runner.db");
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

it("node:sqlite loads under vitest, with no experimental warning", async () => {
  const warned: string[] = [];
  const on = (w: Error) => warned.push(w.message);
  process.on("warning", on);
  const store = sqliteStore(dbFile());
  expect(await store.open()).toBe(0);
  await store.close();
  await new Promise((r) => setTimeout(r, 10));
  process.off("warning", on);
  expect(warned.filter((m) => m.includes("SQLite"))).toEqual([]);
});

// not in replay mode: two scenarios count handler-body runs, which a replay repeats
conformance("sqlite", { sdk: restate, clients }, async (services) => {
  const runner = await startRunner({
    file: dbFile(),
    services,
    leaseMs: 10_000,
    pollMs: 50,
    concurrency: 16,
  });
  return {
    ingress: runner.ingress,
    missingId: "inv_00000000000000000000000000",
    async status(id: string): Promise<Status> {
      const r = await runner.store.result(id);
      return r?.status === "done" ? "completed" : r?.status === "paused" ? "paused" : "other";
    },
    stop: () => runner.stop(),
  };
});

// ── crash points: a crash at each boundary, then lease expiry and replay ───────────────────────
const LEASE_MS = 400;
const hits = new Map<string, number>();
const hit = (k: string) => hits.set(k, (hits.get(k) ?? 0) + 1).get(k) ?? 0;
type R = { run: string };

const kid = restate.service({
  name: "CrashKid",
  handlers: {
    work: async (ctx: restate.Context, { run }: R) => {
      await ctx.run("k", () => hit(`${run}:k`));
      return `kid ${run}`;
    },
  },
});
const flow = restate.object({
  name: "CrashFlow",
  handlers: {
    go: async (ctx: restate.ObjectContext, { run }: R) => {
      await ctx.run("a", () => hit(`${run}:a`));
      ctx.set("s", 1);
      await ctx.sleep(20); // suspends: localWaitMs 0
      const k = await ctx.genericCall({
        service: "CrashKid",
        method: "work",
        parameter: Buffer.from(JSON.stringify({ run })),
        inputSerde: restate.serde.binary,
        outputSerde: restate.serde.json as restate.Serde<string>,
      });
      await ctx.run("b", () => hit(`${run}:b`));
      return { k, s: await ctx.get<number>("s") };
    },
  },
});

describe("sqlite crash points", () => {
  const POINTS = [
    "none",
    ...["a", "b", "k"].flatMap((n) =>
      ["before", "after-effect", "after-journal"].map((w) => `run:${n}:${w}`),
    ),
    "finish:before",
  ];
  let armed = "none";
  let fired = false;
  let stop = async () => {};
  let ingress: clients.Ingress;
  beforeAll(async () => {
    const runner = await startRunner({
      file: dbFile(),
      services: [kid, flow],
      leaseMs: LEASE_MS,
      pollMs: 50,
      concurrency: 4,
      localWaitMs: 0,
      log: () => {},
      crash: (point) => {
        if (!fired && point === armed) {
          fired = true;
          throw new Crash(point);
        }
      },
    });
    ingress = runner.ingress;
    stop = () => runner.stop();
  });
  afterAll(() => stop());

  let baseline: unknown;
  for (const point of POINTS)
    it(point, async () => {
      armed = point;
      fired = false;
      const run = `crash-${point}`;
      const out = await ingress.objectClient(flow, run).go({ run });
      if (point === "none") baseline = out;
      else expect(fired).toBe(true);
      expect(JSON.stringify(out)).toBe(
        JSON.stringify({ ...(baseline as object), k: `kid ${run}` }),
      );
      for (const n of ["a", "b", "k"]) {
        const c = hits.get(`${run}:${n}`) ?? 0;
        expect(c, `${n} ran ${c}x`).toBeGreaterThanOrEqual(1);
        expect(c, `${n} ran ${c}x`).toBeLessThanOrEqual(
          point.startsWith(`run:${n}:after-effect`) ? 2 : 1,
        );
      }
    }, 30_000);
});

// ── a Mac that sleeps past the lease mid-ctx.run ────────────────────────────────────────────
describe("a lease that lapses mid-ctx.run", () => {
  it("is renewed before the next claim: no second attempt", async () => {
    let starts = 0;
    let wake = () => {};
    const asleep = new Promise<void>((r) => {
      wake = r;
    });
    const nap = restate.service({
      name: "Nap",
      handlers: {
        go: async (ctx: restate.Context) => {
          await ctx.run("long", async () => {
            starts++;
            await asleep;
          });
          return starts;
        },
      },
    });
    const runner = await startRunner({ file: dbFile(), services: [nap], leaseMs: 300, pollMs: 20 });
    const out = runner.ingress.serviceClient(nap).go();
    await new Promise((r) => setTimeout(r, 50));
    // the beat stops, as when the Mac sleeps: the row's lease lapses while the act still runs
    const blocked = Date.now() + 700;
    while (Date.now() < blocked) {}
    await new Promise((r) => setTimeout(r, 200));
    wake();
    expect(await out).toBe(1);
    expect(starts).toBe(1);
    await runner.stop();
  }, 10_000);

  it("a second process does not dispatch while the holder lives", async () => {
    const file = dbFile();
    // after the warning test: a top-level import would warn first
    const { DatabaseSync } = await import("node:sqlite");
    const hold = (pid: number) => {
      const db = new DatabaseSync(file);
      db.prepare("INSERT OR REPLACE INTO runners (name, pid, at) VALUES ('main', ?, 0)").run(pid);
      db.close();
    };
    await (await startRunner({ file, services: [kid] })).stop();
    hold(process.ppid); // alive: our parent
    const b = await startRunner({ file, services: [kid] });
    expect(b.dispatching).toBe(false);
    await b.stop();
    hold(2 ** 22 + 7); // past macOS's pid range: dead
    const c = await startRunner({ file, services: [kid] });
    expect(c.dispatching).toBe(true);
    await c.stop();
  });
});

// ── the pid lock hands over; the idle check ─────────────────────────────────────────────────
describe("a runner that only calls", () => {
  it("takes over once the holder's pid dies, then runs the call it queued", async () => {
    const file = dbFile();
    const { DatabaseSync } = await import("node:sqlite");
    const hold = (pid: number) => {
      const db = new DatabaseSync(file);
      db.prepare("INSERT OR REPLACE INTO runners (name, pid, at) VALUES ('main', ?, 0)").run(pid);
      db.close();
    };
    await (await startRunner({ file, services: [kid] })).stop();
    hold(process.ppid);
    const b = await startRunner({ file, services: [kid], takeOverMs: 30, pollMs: 20 });
    expect(b.dispatching).toBe(false);
    const out = b.ingress.serviceClient(kid).work({ run: "takeover" });
    await new Promise((r) => setTimeout(r, 150));
    expect(hits.get("takeover:k")).toBeUndefined();
    hold(2 ** 22 + 7);
    expect(await out).toBe("kid takeover");
    expect(b.dispatching).toBe(true);
    expect(hits.get("takeover:k")).toBe(1);
    await b.stop();
  }, 10_000);

  it("due counts running rows and rows due now, never a later one", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const hold = restate.service({
      name: "DueHold",
      handlers: { go: async (ctx: restate.Context) => ctx.run("wait", () => held) },
    });
    const runner = await startRunner({ file: dbFile(), services: [hold, kid], pollMs: 20 });
    const out = runner.ingress.serviceClient(hold).go();
    const until = Date.now() + 3000;
    while ((await runner.store.due()) === 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    expect(await runner.store.due()).toBe(1);
    await runner.ingress
      .serviceSendClient(kid)
      .work({ run: "later" }, clients.rpc.sendOpts({ delay: { hours: 1 } }));
    expect(await runner.store.due()).toBe(1);
    expect(await runner.store.due(["CrashKid"])).toBe(0);
    expect(await runner.store.due(undefined, Date.now() + 2 * 3_600_000)).toBe(2);
    release();
    await out;
    expect(await runner.store.due()).toBe(0);
    await runner.stop();
  }, 10_000);
});
