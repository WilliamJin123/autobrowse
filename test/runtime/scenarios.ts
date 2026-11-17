// Copied from wren packages/runtime/test/integration/conformance/scenarios.ts at dc80ecd28, unchanged: edit there, then copy.
/**
 * The runtime's contract, as tests (designs/2026-11-09-own-runtime.md, "Tests and lints first").
 * One set of scenarios; each runtime runs it through its own harness. Restate's run is today's
 * truth: a scenario that fails there is a wrong scenario, not a Restate bug.
 *
 * Side effects count into `hits` (this process runs the handlers), keyed by a per-test run id.
 */
import type * as Sdk from "@restatedev/restate-sdk";
import type * as clients from "@restatedev/restate-sdk-clients";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export type Status = "completed" | "paused" | "other";
export interface Harness {
  ingress: clients.Ingress;
  /** Coarse status of one invocation, from its id. */
  status(invocationId: string): Promise<Status>;
  /** A well-formed invocation id this runtime never made. */
  missingId: string;
  stop(): Promise<void>;
}
export type StartHarness = (services: Sdk.ServiceDefinition<string, unknown>[]) => Promise<Harness>;
/** A runtime under test: its handler API and its ingress clients, Restate's shape. */
export interface Runtime {
  sdk: typeof Sdk;
  clients: typeof clients;
}

// ── side-effect ledger ───────────────────────────────────────────────────────────────────────
const hits = new Map<string, number>();
const hit = (key: string) => {
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  return n;
};
const count = (key: string) => hits.get(key) ?? 0;
const seen = new Map<string, unknown[]>();
const note = (key: string, v: unknown) => seen.set(key, [...(seen.get(key) ?? []), v]);
/** Awakeable ids a handler hands out, for the test to resolve. */
const handed = new Map<string, string>();
/** Open latches, for proving two shared handlers run side by side. */
const latches = new Map<string, { n: number; open: () => void; done: Promise<void> }>();
const latch = (key: string, need: number) => {
  let l = latches.get(key);
  if (!l) {
    let open = () => {};
    const done = new Promise<void>((r) => {
      open = r;
    });
    l = { n: 0, open, done };
    latches.set(key, l);
  }
  l.n++;
  if (l.n >= need) l.open();
  return l.done;
};
const until = async (fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
let runs = 0;
const runId = (name: string) => `${name}-${process.pid}-${++runs}`;

// ── services ─────────────────────────────────────────────────────────────────────────────────
type R = { run: string };

function build(restate: typeof Sdk) {
  const kid = restate.service({
    name: "ConfKid",
    handlers: {
      record: async (ctx: Sdk.Context, { run }: R) => {
        await ctx.run("at", () => note(`${run}:at`, Date.now()));
      },
      slow: async (ctx: Sdk.Context, { run, ms }: R & { ms: number }) => {
        await ctx.sleep(ms);
        await ctx.run("slow", () => hit(`${run}:slow`));
        return `slow ${run}`;
      },
      child: async (ctx: Sdk.Context, { run, fail }: R & { fail?: boolean | undefined }) => {
        await ctx.run("child", () => hit(`${run}:child`));
        if (fail) throw new restate.TerminalError("child said no");
        return `child of ${run}`;
      },
    },
  });

  const steps = restate.service({
    name: "ConfSteps",
    handlers: {
      /** step a, then b (fails its first try), then c. */
      replay: async (ctx: Sdk.Context, { run }: R) => {
        const a = await ctx.run("a", () => hit(`${run}:a`));
        const b = await ctx.run("b", () => {
          if (hit(`${run}:b`) === 1) throw new Error("transient");
          return 2;
        });
        const c = await ctx.run("c", () => hit(`${run}:c`));
        return a + b + c;
      },
      /** A step that always fails, capped at 3 tries: the handler sees a TerminalError. */
      capped: async (ctx: Sdk.Context, { run }: R) => {
        try {
          await ctx.run(
            "flaky",
            () => {
              hit(`${run}:flaky`);
              throw new Error("down");
            },
            { maxRetryAttempts: 3, initialRetryInterval: 10 },
          );
          return "ok";
        } catch (err) {
          return err instanceof restate.TerminalError ? "terminal" : "other";
        }
      },
      terminal: async (ctx: Sdk.Context, { run }: R) => {
        await ctx.run("t", () => {
          hit(`${run}:t`);
          throw new restate.TerminalError("no", { errorCode: 422 });
        });
      },
      /** ctx.date and ctx.rand give the same values on the retry as on the first try. */
      stable: async (ctx: Sdk.Context, { run }: R) => {
        const now = await ctx.date.now();
        const id = ctx.rand.uuidv4();
        const r = ctx.rand.random();
        note(`${run}:values`, [now, id, r]);
        await ctx.run("fail once", () => {
          if (hit(`${run}:once`) === 1) throw new Error("transient");
        });
        return [now, id, r];
      },
      sleep: async (ctx: Sdk.Context, { run, ms }: R & { ms: number }) => {
        const t0 = await ctx.date.now();
        await ctx.sleep(ms);
        const t1 = await ctx.date.now();
        hit(`${run}:woke`);
        return t1 - t0;
      },
      counted: async (ctx: Sdk.Context, { run }: R) => {
        await ctx.run("body", () => hit(`${run}:body`));
        return `done ${run}`;
      },
      /** Send to `record`, `ms` later. */
      later: async (ctx: Sdk.Context, { run, ms }: R & { ms: number }) => {
        await ctx.run("sent", () => note(`${run}:sent`, Date.now()));
        ctx.serviceSendClient(kid).record({ run }, restate.rpc.sendOpts({ delay: ms }));
      },
      parent: async (ctx: Sdk.Context, { run, fail }: R & { fail?: boolean | undefined }) => {
        try {
          return await ctx.serviceClient(kid).child({ run, fail });
        } catch (err) {
          if (err instanceof restate.TerminalError) return `caught: ${err.message}`;
          throw err;
        }
      },
      both: async (ctx: Sdk.Context, { run }: R) => {
        const c = ctx.serviceClient(kid);
        const [x, y] = await restate.RestatePromise.all([
          c.child({ run: `${run}-x` }),
          c.child({ run: `${run}-y` }),
        ]);
        const first = await restate.RestatePromise.race([
          c.child({ run: `${run}-z` }),
          ctx.sleep(60_000).map(() => "slept"),
        ]);
        return [x, y, first];
      },
      /** A call raced against a timer short enough to wait inside the turn: the call still starts. */
      callWithin: async (ctx: Sdk.Context, { run }: R) => {
        try {
          return await ctx.serviceClient(kid).child({ run }).orTimeout(1000);
        } catch (err) {
          if (err instanceof restate.TimeoutError) return "timed out";
          throw err;
        }
      },
      wait: async (ctx: Sdk.Context, { run, timeout }: R & { timeout?: number }) => {
        const { id, promise } = ctx.awakeable<string>();
        await ctx.run("hand out", () => handed.set(run, id));
        try {
          return await (timeout ? promise.orTimeout(timeout) : promise);
        } catch (err) {
          if (err instanceof restate.TimeoutError) return "timed out";
          if (err instanceof restate.TerminalError) return `rejected: ${err.message}`;
          throw err;
        }
      },
      /** PostPublish's settle: send, look for a moment, attach again later; a failed one; one that is not. */
      attach: async (ctx: Sdk.Context, { run }: R) => {
        const slow = await ctx.serviceSendClient(kid).slow({ run, ms: 800 }).invocationId;
        const fail = await ctx.serviceSendClient(kid).child({ run, fail: true }).invocationId;
        const out: string[] = [];
        try {
          out.push(await ctx.invocation(slow).attach<string>().orTimeout(100));
        } catch (err) {
          out.push(err instanceof restate.TimeoutError ? "timed out" : `other: ${err}`);
        }
        out.push(await ctx.invocation(slow).attach<string>());
        out.push(await ctx.attach<string>(slow));
        try {
          out.push(await ctx.invocation(fail).attach<string>());
        } catch (err) {
          out.push(
            err instanceof restate.TerminalError ? `failed: ${err.message}` : `other: ${err}`,
          );
        }
        return out;
      },
      /** Attaches that race their targets' ends: a lost wake hangs. */
      attachMany: async (ctx: Sdk.Context, { run, n }: R & { n: number }) => {
        const ids: Sdk.InvocationId[] = [];
        for (let i = 0; i < n; i++)
          ids.push(await ctx.serviceSendClient(kid).child({ run: `${run}-${i}` }).invocationId);
        const out = await restate.RestatePromise.all(
          ids.map((id) => ctx.invocation(id).attach<string>()),
        );
        return out.length;
      },
      attachMissing: async (ctx: Sdk.Context, { missing }: { missing: string }) => {
        try {
          return await ctx
            .invocation(restate.InvocationIdParser.fromString(missing))
            .attach<string>()
            .orTimeout(3000);
        } catch (err) {
          if (err instanceof restate.TimeoutError) return "missing waits";
          if (err instanceof restate.TerminalError) return `missing: ${err.code}`;
          throw err;
        }
      },
      /** Fails every try: the server's retry policy pauses it after 2. */
      stuck: restate.handlers.handler(
        { retryPolicy: { maxAttempts: 2, onMaxAttempts: "pause", initialInterval: 10 } },
        async (ctx: Sdk.Context, { run }: R) => {
          await ctx.run("never", () => {
            hit(`${run}:stuck`);
            throw new Error("always");
          });
        },
      ),
    },
  });

  const box = restate.object({
    name: "ConfBox",
    handlers: {
      /** Read, wait, write: a lost update shows when two run at once. */
      add: async (ctx: Sdk.ObjectContext, { run }: R) => {
        const inside = hit(`${run}:${ctx.key}:inside`) - count(`${run}:${ctx.key}:left`);
        note(`${run}:${ctx.key}:overlap`, inside);
        const n = (await ctx.get<number>("n")) ?? 0;
        await ctx.sleep(30);
        ctx.set("n", n + 1);
        await ctx.run("leave", () => hit(`${run}:${ctx.key}:left`));
        return n + 1;
      },
      get: restate.handlers.object.shared(
        async (ctx: Sdk.ObjectSharedContext) => (await ctx.get<number>("n")) ?? null,
      ),
      put: async (ctx: Sdk.ObjectContext, v: number) => {
        ctx.set("n", v);
      },
      wipe: async (ctx: Sdk.ObjectContext) => {
        ctx.clear("n");
      },
      /** Two shared calls meet at a latch: only possible if they run side by side. */
      meet: restate.handlers.object.shared(async (ctx: Sdk.ObjectSharedContext, { run }: R) => {
        await ctx.run("meet", () => latch(run, 2));
        return "met";
      }),
    },
  });

  return { steps, kid, box };
}

// ── the suite ────────────────────────────────────────────────────────────────────────────────
export function conformance(name: string, rt: Runtime, start: StartHarness) {
  const { steps, kid, box } = build(rt.sdk);
  const ingressOpts = (o: { idempotencyKey: string }) => rt.clients.rpc.opts<R, string>(o);
  describe(`runtime conformance: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await start([steps, kid, box] as Sdk.ServiceDefinition<string, unknown>[]);
    });
    afterAll(async () => {
      await h?.stop();
    });
    const svc = () => h.ingress.serviceClient(steps);
    const obj = (key: string) => h.ingress.objectClient(box, key);

    it("replays done steps and retries the failed one", async () => {
      const run = runId("replay");
      expect(await svc().replay({ run })).toBe(4);
      expect([count(`${run}:a`), count(`${run}:b`), count(`${run}:c`)]).toEqual([1, 2, 1]);
    });

    it("a capped step gives the handler a TerminalError after its tries", async () => {
      const run = runId("capped");
      expect(await svc().capped({ run })).toBe("terminal");
      expect(count(`${run}:flaky`)).toBe(3);
    });

    it("a TerminalError never retries and reaches the caller", async () => {
      const run = runId("terminal");
      const err = await Promise.resolve(svc().terminal({ run })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toContain("no");
      expect(count(`${run}:t`)).toBe(1);
    });

    it("ctx.date and ctx.rand replay the same values", async () => {
      const run = runId("stable");
      const out = await svc().stable({ run });
      const values = seen.get(`${run}:values`) ?? [];
      expect(values.length).toBe(2);
      expect(values[1]).toEqual(values[0]);
      expect(out).toEqual(values[0]);
    });

    it("sleep waits at least its time", async () => {
      const run = runId("sleep");
      const t0 = Date.now();
      const slept = await svc().sleep({ run, ms: 400 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
      expect(slept).toBeGreaterThanOrEqual(400);
      expect(count(`${run}:woke`)).toBe(1);
    });

    it("a delayed send arrives no earlier than its delay", async () => {
      const run = runId("later");
      await svc().later({ run, ms: 400 });
      await until(() => (seen.get(`${run}:at`) ?? []).length > 0);
      const sent = (seen.get(`${run}:sent`) as number[])[0] as number;
      const at = (seen.get(`${run}:at`) as number[])[0] as number;
      expect(at - sent).toBeGreaterThanOrEqual(400);
      expect(seen.get(`${run}:at`)?.length).toBe(1);
    });

    it("an idempotency key runs the body once and returns the first result twice", async () => {
      const run = runId("idem");
      const opts = { idempotencyKey: run };
      const [x, y] = await Promise.all([
        svc().counted({ run }, ingressOpts(opts)),
        svc().counted({ run }, ingressOpts(opts)),
      ]);
      expect(x).toBe(`done ${run}`);
      expect(y).toBe(x);
      expect(await svc().counted({ run }, ingressOpts(opts))).toBe(x);
      expect(count(`${run}:body`)).toBe(1);
    });

    it("exclusive handlers on one key run one at a time; other keys run apart", async () => {
      const run = runId("excl");
      const key = `${run}-k`;
      const out = await Promise.all(Array.from({ length: 5 }, () => obj(key).add({ run })));
      expect(out.sort()).toEqual([1, 2, 3, 4, 5]);
      expect(await obj(key).get()).toBe(5);
      expect(Math.max(...((seen.get(`${run}:${key}:overlap`) as number[]) ?? [0]))).toBe(1);
      expect(await obj(`${run}-other`).get()).toBeNull();
    });

    it("shared handlers run side by side", async () => {
      const run = runId("shared");
      const key = `${run}-k`;
      expect(await Promise.all([obj(key).meet({ run }), obj(key).meet({ run })])).toEqual([
        "met",
        "met",
      ]);
    });

    it("state is per key and clears", async () => {
      const run = runId("state");
      await obj(`${run}-a`).put(7);
      expect(await obj(`${run}-a`).get()).toBe(7);
      expect(await obj(`${run}-b`).get()).toBeNull();
      await obj(`${run}-a`).wipe();
      expect(await obj(`${run}-a`).get()).toBeNull();
    });

    it("a call returns the child's result, and its TerminalError", async () => {
      const run = runId("call");
      expect(await svc().parent({ run })).toBe(`child of ${run}`);
      expect(await svc().parent({ run: `${run}-f`, fail: true })).toBe("caught: child said no");
      expect(count(`${run}:child`)).toBe(1);
    });

    it("all and race over calls", async () => {
      const run = runId("all");
      expect(await svc().both({ run })).toEqual([
        `child of ${run}-x`,
        `child of ${run}-y`,
        `child of ${run}-z`,
      ]);
    });

    it("an awakeable resolves and rejects from the ingress", async () => {
      const ok = runId("wake");
      const pending = svc().wait({ run: ok });
      await until(() => handed.has(ok));
      await h.ingress.resolveAwakeable(handed.get(ok) as string, "hello");
      expect(await pending).toBe("hello");

      const no = runId("wake-no");
      const rejected = svc().wait({ run: no });
      await until(() => handed.has(no));
      await h.ingress.rejectAwakeable(handed.get(no) as string, "nope");
      expect(await rejected).toBe("rejected: nope");
    });

    it("a call under a short orTimeout answers before the timer", async () => {
      const run = runId("within");
      expect(await svc().callWithin({ run })).toBe(`child of ${run}`);
    });

    it("orTimeout ends a wait", async () => {
      const run = runId("timeout");
      expect(await svc().wait({ run, timeout: 300 })).toBe("timed out");
    });

    it("attach waits on a sent call's outcome, again and after it ended", async () => {
      const run = runId("attach");
      expect(await svc().attach({ run })).toEqual([
        "timed out",
        `slow ${run}`,
        `slow ${run}`,
        "failed: child said no",
      ]);
      expect(count(`${run}:slow`)).toBe(1);
    });

    it("attaches racing their targets' ends all settle", async () => {
      const run = runId("attach-many");
      const outs = await Promise.all(
        Array.from({ length: 8 }, (_, i) => svc().attachMany({ run: `${run}-${i}`, n: 12 })),
      );
      expect(outs).toEqual(Array(8).fill(12));
    }, 60_000);

    // Restate retries the handler until it pauses; pg answers 404, so a caller can move on
    it.runIf(name === "pg")(
      "attach to an id the runtime never made answers 404",
      async () => {
        expect(await svc().attachMissing({ missing: h.missingId })).toBe("missing: 404");
      },
      30_000,
    );

    it("a call that fails every try pauses, never drops", async () => {
      const run = runId("stuck");
      const sent = await h.ingress.serviceSendClient(steps).stuck({ run });
      await until(() => count(`${run}:stuck`) >= 2);
      let status: Status = "other";
      for (let i = 0; i < 80 && status !== "paused"; i++) {
        status = await h.status(sent.invocationId);
        if (status !== "paused") await new Promise((r) => setTimeout(r, 250));
      }
      expect(status).toBe("paused");
      expect(count(`${run}:stuck`)).toBe(2);
    });
  });
}
