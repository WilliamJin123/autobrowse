/**
 * Restate's ingress protocol over the store, as a `fetch`: `clients.connect({url, fetch})` calls
 * the runner with no port. wren `src/pg/door.ts`'s routes, minus pull, bearer and drain:
 *   POST /{svc}[/{key}]/{handler}[/send[?delay=10s]]    header idempotency-key
 *   POST /restate/a/{id}/resolve | /reject   (also /restate/awakeables/...)
 *   GET  /restate/invocation/{id}/attach | /output    (output: 470 while it runs; + `retry`)
 *   GET  /restate/invocation/{svc}[/{key}]/{handler}/{idempotency-key}/attach | /output
 *   GET  /restate/health
 * Plain names, same routes: /health, /calls/..., /awakeables/...
 */
import { newInvocationId, parseAwakeableId } from "./core/ids.js";
import type { Result, RuntimeStore } from "./store.js";

/** The base URL a runner client connects to; never dialed. */
export const RUNNER_URL = "http://runner.local";

const MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Restate's `delay`: humantime (`10s`, `1h30m`) or ISO 8601 (`PT10S`). Null: not a duration. */
export function parseDelay(v: string | null): number | null {
  if (!v) return 0;
  if (/^(\d+(ms|s|m|h|d))+$/.test(v))
    return [...v.matchAll(/(\d+)(ms|s|m|h|d)/g)].reduce(
      (t, [, n, u]) => t + Number(n) * MS[u as keyof typeof MS],
      0,
    );
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(v);
  if (iso && v.length > 1 && !/T$/i.test(v)) {
    const [, d, h, m, sec] = iso;
    return Math.round(
      Number(d ?? 0) * MS.d +
        Number(h ?? 0) * MS.h +
        Number(m ?? 0) * MS.m +
        Number(sec ?? 0) * 1000,
    );
  }
  return null;
}

const DROP = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "cookie",
  "transfer-encoding",
]);

const send = (status: number, data: string | Uint8Array, type = "application/json") =>
  new Response(
    status === 202 && data === "" ? null : (data as ConstructorParameters<typeof Response>[0]),
    {
      status,
      headers: { "content-type": type },
    },
  );
const json = (status: number, v: unknown) => send(status, JSON.stringify(v));
const notFound = () => json(404, { message: "not found" });
const ended = (r: Result | undefined) => !r || r.status === "done" || r.status === "killed";

export function doorFetch(store: RuntimeStore): typeof globalThis.fetch {
  type Kind = { object: boolean; exclusive: Map<string, boolean>; private: Set<string> };
  /** The service's kinds; undefined: not registered. Read fresh each call: the desk may write them. */
  const served = async (service: string) => {
    let k: Kind | undefined;
    for (const h of await store.handlers()) {
      if (h.service !== service) continue;
      k ??= { object: h.object, exclusive: new Map(), private: new Set() };
      k.exclusive.set(h.handler, h.exclusive);
      if (h.private) k.private.add(h.handler);
    }
    return k;
  };

  /** Waits for the row's end; another process's finish shows within `changed`'s poll. */
  const settled = async (id: string, signal: AbortSignal | null) => {
    for (;;) {
      signal?.throwIfAborted();
      const r = await store.result(id);
      if (ended(r)) return r;
      await store.changed(id, 100);
    }
  };

  const reply = async (id: string, wait: boolean, signal: AbortSignal | null) => {
    if (!wait) {
      const now = await store.result(id);
      if (now && !ended(now)) {
        const retry = await store.retrying(id);
        return json(470, { message: "not ready", ...(retry ? { retry } : {}) });
      }
    }
    const r = await settled(id, signal);
    if (!r) return json(404, { message: `no invocation ${id}` });
    if (r.error) {
      const code = r.error.code && r.error.code >= 400 && r.error.code < 600 ? r.error.code : 500;
      return json(code, {
        code: r.error.code ?? 500,
        message: r.error.message,
        ...(r.error.metadata ? { metadata: r.error.metadata } : {}),
      });
    }
    return send(200, r.result ?? new Uint8Array());
  };

  /** `[id]` or `[svc, (key,) handler, idem]`: the invocation it names. */
  const named = async (p: string[]): Promise<string | undefined> => {
    if (p.length === 1) return (await store.result(p[0] as string)) ? p[0] : undefined;
    if (p.length !== 3 && p.length !== 4) return undefined;
    const [service, ...rest] = p as [string, ...string[]];
    const [key, handler, idem] = rest.length === 3 ? rest : [null, ...rest];
    const svc = await served(service);
    if (!svc || svc.object !== (key !== null)) return undefined;
    return store.byIdempotencyKey(service, handler as string, key ?? null, idem as string);
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "health" && parts.length === 1) parts.unshift("restate");
    else if (parts[0] === "calls") parts.splice(0, 1, "restate", "invocation");
    else if (parts[0] === "awakeables") parts.unshift("restate");

    if (parts[0] === "restate") {
      if (parts[1] === "health" && parts.length === 2) return send(200, "{}");
      if (
        (parts[1] === "a" || parts[1] === "awakeables") &&
        parts[2] &&
        req.method === "POST" &&
        (parts[3] === "resolve" || parts[3] === "reject")
      ) {
        const a = parseAwakeableId(parts[2]);
        if (!a) return notFound();
        const b = new Uint8Array(await req.arrayBuffer());
        await store.resolveAwakeable({
          id: parts[2],
          ...a,
          value: parts[3] === "resolve" ? b : null,
          error: parts[3] === "reject" ? { message: new TextDecoder().decode(b), code: 500 } : null,
        });
        return send(202, "");
      }
      const op = parts.at(-1);
      if (
        parts[1] === "invocation" &&
        req.method === "GET" &&
        (op === "attach" || op === "output")
      ) {
        const id = await named(parts.slice(2, -1));
        return id ? reply(id, op === "attach", req.signal) : notFound();
      }
      return notFound();
    }

    if (parts.length < 2) return notFound();
    const svc = await served(parts[0] as string);
    if (!svc)
      return json(404, {
        // a fresh file: nothing has registered yet
        message: `unknown service ${parts[0]}: no worker has served it from this file yet (start the desk or \`autobrowse worker\` once)`,
      });
    const want = svc.object ? 3 : 2;
    const handler = (parts[want - 1] ?? "") as string;
    if (req.method !== "POST") return json(405, { message: "POST only" });
    const isSend = parts.length === want + 1 && parts[want] === "send";
    if (parts.length !== (isSend ? want + 1 : want)) return json(404, { message: "bad path" });
    const [service, key] = svc.object
      ? [parts[0] as string, parts[1] as string]
      : [parts[0] as string, null];
    if (!svc.exclusive.has(handler))
      return json(404, { message: `unknown handler ${service}/${handler}` });
    if (svc.private.has(handler)) return json(400, { message: `${service}/${handler} is private` });
    const delay = parseDelay(url.searchParams.get("delay"));
    if (delay === null) return json(400, { message: "bad delay" });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!DROP.has(k) && !k.startsWith("x-restateclient")) headers[k] = v;
    });
    const { id, fresh } = await store.submit({
      id: newInvocationId(),
      service,
      handler,
      key,
      input: new Uint8Array(await req.arrayBuffer()),
      headers,
      idemKey: req.headers.get("idempotency-key"),
      runAt: new Date(Date.now() + delay),
      callerWaits: !isSend && delay === 0,
    });
    if (isSend)
      return json(202, { invocationId: id, status: fresh ? "Accepted" : "PreviouslyAccepted" });
    return reply(id, true, req.signal);
  };

  return (async (input: Request | string | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    try {
      return await route(req);
    } catch (e) {
      if (req.signal.aborted) throw e;
      return json(500, { message: String((e as Error)?.message ?? e) });
    }
  }) as typeof globalThis.fetch;
}
