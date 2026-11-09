/**
 * The desk pulls its calls from wren's door (wren designs/2026-11-09-own-runtime.md, "Phase 5"):
 * no inbound port, and calls wait in wren's Postgres while the Mac sleeps. Each handler runs
 * whole with a plain `ctx`; there is no journal here, so a rerun starts the handler again. The send
 * journal keeps each keyed write once, as it did under Restate. wren imports nothing from here and
 * this imports nothing from wren: the contract is the four `/rt/*` routes.
 */
import { randomUUID } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";

/** The SDK's handler wrapper: the part a runtime calls (wren `packages/runtime/src/pg/registry.ts`). */
interface Wrapper {
  options?: { retryPolicy?: RetryPolicy; ingressPrivate?: boolean };
  invoke(context: unknown, input: Uint8Array): Promise<Uint8Array>;
}

export interface RetryPolicy {
  initialInterval?: number;
  exponentiationFactor?: number;
  maxInterval?: number;
  maxAttempts?: number;
  onMaxAttempts?: "pause" | "kill";
}

type Def = {
  name: string;
  _kind?: string;
  service?: Record<string, unknown>;
  options?: { retryPolicy?: RetryPolicy; ingressPrivate?: boolean };
};

interface Handler {
  wrapper: Wrapper;
  retry: RetryPolicy;
  private: boolean;
}

export interface Call {
  id: string;
  attempt: number;
  service: string;
  handler: string;
  input: string;
  headers: Record<string, string>;
  cancel: boolean;
}

/** The door, over HTTP; a fake in tests. */
export type DoorPost = (
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<{
  status: number;
  text: string;
}>;

export function doorHttp(url: string, token: string): DoorPost {
  return async (path, body, headers = {}) => {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(path === "/rt/claim" ? 40_000 : 600_000),
    });
    return { status: res.status, text: await res.text() };
  };
}

const wrapperOf = (fn: unknown): Wrapper | undefined => {
  if (typeof fn !== "function") return undefined;
  const sym = Object.getOwnPropertySymbols(fn).find((s) => s.description === "Handler");
  return sym ? ((fn as unknown as Record<symbol, Wrapper>)[sym] as Wrapper) : undefined;
};

/** Each service's handlers, keyed `service/handler`; a service's own policy, else `fallback`. */
export function handlersOf(defs: readonly unknown[], fallback: RetryPolicy) {
  const out = new Map<string, Handler>();
  for (const d of defs as Def[]) {
    if (d._kind !== "service") throw new Error(`door pull: ${d.name}: services only`);
    for (const [name, fn] of Object.entries(d.service ?? {})) {
      const wrapper = wrapperOf(fn);
      if (!wrapper) throw new Error(`door pull: ${d.name}/${name}: not an SDK handler`);
      out.set(`${d.name}/${name}`, {
        wrapper,
        retry: wrapper.options?.retryPolicy ?? d.options?.retryPolicy ?? fallback,
        private: wrapper.options?.ingressPrivate ?? d.options?.ingressPrivate ?? false,
      });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const millis = (d: unknown) =>
  typeof d === "number"
    ? d
    : d && typeof d === "object"
      ? Object.entries(d as Record<string, number>).reduce(
          (n, [u, v]) =>
            n +
            v *
              ({ milliseconds: 1, seconds: 1e3, minutes: 6e4, hours: 3.6e6, days: 8.64e7 }[u] ?? 0),
          0,
        )
      : undefined;

type RunOpts = {
  maxRetryAttempts?: number;
  maxRetryDuration?: unknown;
  initialRetryInterval?: unknown;
  retryIntervalFactor?: number;
  maxRetryInterval?: unknown;
};

/** Thrown at the next step once wren asks for a cancel: ends the call with 409, as Restate. */
const cancelled = () => new restate.TerminalError("cancelled", { errorCode: 409 });

/**
 * A `ctx` for one call: `run` (its own retries; at the cap a `TerminalError`, as Restate), `sleep`,
 * `request()`, and clients that call through the door. Anything else throws by name.
 */
export function plainContext(
  c: Call,
  door: DoorPost,
  state: { cancel: boolean },
  log: (msg: string, extra?: Record<string, unknown>) => void,
) {
  const step = () => {
    if (state.cancel) throw cancelled();
  };
  const client = (send: boolean) => (def: { name: string }) =>
    new Proxy(
      {},
      {
        get: (_t, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          return (...args: unknown[]) => {
            const last = args.at(-1) as { getOpts?: () => Record<string, unknown> } | undefined;
            const hasOpts = typeof last?.getOpts === "function";
            const opts = hasOpts ? (last?.getOpts?.() ?? {}) : {};
            const parameter = !hasOpts || args.length === 2 ? args[0] : undefined;
            const delay = millis(opts.delay);
            const path = `/${encodeURIComponent(def.name)}/${encodeURIComponent(method)}${
              send ? `/send${delay ? `?delay=${delay}ms` : ""}` : ""
            }`;
            const headers: Record<string, string> = {
              ...((opts.headers as Record<string, string> | undefined) ?? {}),
              ...(opts.idempotencyKey ? { "idempotency-key": String(opts.idempotencyKey) } : {}),
            };
            const p = (async () => {
              step();
              const r = await door(path, parameter ?? null, headers);
              if (r.status >= 200 && r.status < 300) return r.text ? JSON.parse(r.text) : undefined;
              let message = r.text;
              try {
                message = (JSON.parse(r.text) as { message?: string }).message ?? r.text;
              } catch {}
              throw new restate.TerminalError(message, { errorCode: r.status });
            })();
            if (send) {
              // a send's handle is not awaited by its callers
              p.catch((e: unknown) => log("door pull: send failed", { path, err: String(e) }));
              return {
                invocationId: p.then((x) => (x as { invocationId?: string })?.invocationId),
              };
            }
            return p;
          };
        },
      },
    );
  const ctx = {
    // the SDK's wrapper (de)serializes with it
    defaultSerde: restate.serde.json,
    request: () => ({
      id: c.id,
      headers: new Map(Object.entries(c.headers)),
      attemptHeaders: new Map<string, string>(),
      body: Buffer.from(c.input, "base64"),
      extraArgs: [],
    }),
    async run<T>(name: string, fn: () => Promise<T> | T, opts?: RunOpts): Promise<T> {
      const capped =
        opts !== undefined &&
        (opts.maxRetryAttempts !== undefined ||
          opts.maxRetryDuration !== undefined ||
          opts.initialRetryInterval !== undefined ||
          opts.retryIntervalFactor !== undefined ||
          opts.maxRetryInterval !== undefined);
      const first = Date.now();
      for (let tries = 1; ; tries++) {
        step();
        try {
          return await fn();
        } catch (err) {
          // uncapped: the whole call fails and retries on the handler's policy, as Restate
          if (err instanceof restate.TerminalError || !capped) throw err;
          const maxD = millis(opts.maxRetryDuration);
          if (
            (opts.maxRetryAttempts !== undefined && tries >= opts.maxRetryAttempts) ||
            (maxD !== undefined && Date.now() - first >= maxD)
          )
            throw new restate.TerminalError((err as Error)?.message ?? String(err), {
              errorCode: 500,
            });
          const initial = millis(opts.initialRetryInterval) ?? 50;
          const max = millis(opts.maxRetryInterval) ?? 10_000;
          log("door pull: step retry", { call: c.id, step: name, tries, err: String(err) });
          await sleep(Math.min(initial * (opts.retryIntervalFactor ?? 2) ** (tries - 1), max));
        }
      }
    },
    async sleep(d: unknown) {
      step();
      await sleep(millis(d) ?? 0);
      step();
    },
    serviceClient: client(false),
    serviceSendClient: client(true),
    rand: { random: Math.random, uuidv4: randomUUID },
    date: { now: async () => Date.now(), toJSON: async () => new Date().toJSON() },
    console,
  };
  return new Proxy(ctx, {
    get(t, prop) {
      if (prop in t) return t[prop as keyof typeof t];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`door pull: ctx.${prop} is not served here`);
    },
  });
}

export interface PullOptions {
  door: DoorPost;
  services: readonly unknown[];
  /** The policy of a service that sets none (the desk's outage retry). */
  retry: RetryPolicy;
  /** Calls at once: more than one, since a call may wait on another of its own (`renew`). */
  concurrency: number;
  /** wren's lease is 60 s: renew well inside it. */
  renewMs?: number;
  /** First wait after a failed register or claim; doubles to 60 s for register. */
  retryMs?: number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Register, then claim and run calls until `stop`. */
export async function pullFromDoor(o: PullOptions) {
  const handlers = handlersOf(o.services, o.retry);
  const byService = new Map<string, { name: string; private: boolean }[]>();
  for (const [k, h] of handlers) {
    const [service, name] = k.split("/") as [string, string];
    byService.set(service, [...(byService.get(service) ?? []), { name, private: h.private }]);
  }
  let stopped = false;
  // a door that is down or an old build must not stop the desk: retry in the loop
  const register = async () => {
    try {
      const r = await o.door("/rt/register", {
        services: [...byService].map(([name, hs]) => ({ name, handlers: hs })),
      });
      if (r.status === 200) return true;
      o.log("door pull: register refused", { status: r.status, body: r.text.slice(0, 300) });
    } catch (e) {
      o.log("door pull: register failed", { err: String(e) });
    }
    return false;
  };
  let registered = await register();
  const running = new Set<Promise<void>>();

  const finish = async (c: Call, body: Record<string, unknown>) => {
    for (let i = 0; ; i++) {
      try {
        const r = await o.door("/rt/finish", { id: c.id, attempt: c.attempt, ...body });
        if (r.status === 409) o.log("door pull: lease lost before finish", { call: c.id });
        else if (r.status !== 200) throw new Error(`finish ${r.status}: ${r.text.slice(0, 200)}`);
        return;
      } catch (e) {
        // the door is down: try for a minute; past that the lease lapses and wren claims it again
        if (i >= 12) return o.log("door pull: finish gave up", { call: c.id, err: String(e) });
        await sleep(5_000);
      }
    }
  };

  const runOne = async (c: Call) => {
    const h = handlers.get(`${c.service}/${c.handler}`);
    if (!h) {
      await finish(c, {
        error: { message: `no handler ${c.service}/${c.handler} here`, code: 404 },
        terminal: true,
      });
      return;
    }
    const state = { cancel: c.cancel };
    const beat = setInterval(() => {
      o.door("/rt/renew", { id: c.id, attempt: c.attempt })
        .then((r) => {
          if (r.status === 200) state.cancel ||= (JSON.parse(r.text) as { cancel: boolean }).cancel;
        })
        .catch(() => {});
    }, o.renewMs ?? 20_000);
    beat.unref();
    try {
      if (state.cancel) throw cancelled();
      const out = await h.wrapper.invoke(
        plainContext(c, o.door, state, o.log),
        new Uint8Array(Buffer.from(c.input, "base64")),
      );
      await finish(c, { value: Buffer.from(out).toString("base64") });
    } catch (err) {
      const e = err as Error & { code?: number; metadata?: Record<string, string> };
      const error = {
        message: e?.message ?? String(err),
        ...(err instanceof restate.TerminalError ? { code: e.code } : {}),
        ...(e?.metadata && Object.keys(e.metadata).length ? { metadata: e.metadata } : {}),
      };
      await finish(c, { error, terminal: err instanceof restate.TerminalError, retry: h.retry });
    } finally {
      clearInterval(beat);
    }
  };

  const loop = (async () => {
    for (
      let wait = o.retryMs ?? 5_000;
      !stopped && !registered;
      wait = Math.min(wait * 2, 60_000)
    ) {
      await sleep(wait);
      registered = !stopped && (await register());
    }
    while (!stopped) {
      const free = o.concurrency - running.size;
      if (free <= 0) {
        await Promise.race(running);
        continue;
      }
      let calls: Call[] = [];
      try {
        const r = await o.door("/rt/claim", {
          services: [...byService.keys()],
          max: free,
          waitMs: 25_000,
        });
        if (r.status !== 200) throw new Error(`claim ${r.status}: ${r.text.slice(0, 200)}`);
        calls = (JSON.parse(r.text) as { calls: Call[] }).calls;
      } catch (e) {
        o.log("door pull: claim failed", { err: String(e) });
        await sleep(o.retryMs ?? 5_000);
        continue;
      }
      for (const c of calls) {
        const p = runOne(c).finally(() => running.delete(p));
        running.add(p);
      }
    }
  })();

  return {
    services: [...byService.keys()],
    /** Stops claiming; calls in hand run to their end. */
    async stop() {
      stopped = true;
      await loop;
      await Promise.all(running);
    },
  };
}
