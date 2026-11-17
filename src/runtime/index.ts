/**
 * The local runner (designs/2026-11-16-local-runner.md): handlers run in this process on one
 * SQLite file. `startRunner` serves and, when no live process holds the file, dispatches;
 * `localIngress` only calls.
 */
import * as clients from "@restatedev/restate-sdk-clients";
import { Registry } from "./core/registry.js";
import { Dispatcher } from "./dispatcher.js";
import { doorFetch, RUNNER_URL } from "./door.js";
import { DEFAULT_LEASE_MS, runTurn } from "./executor.js";
import { sqliteStore } from "./sqlite.js";
import type { RuntimeStore } from "./store.js";

// the client library's second door (the first: src/app/client.ts): the runtime imports nothing from app
export { type Ingress, rpc } from "@restatedev/restate-sdk-clients";
export { Registry } from "./core/registry.js";
export { Crash } from "./core/turn.js";
export { Dispatcher } from "./dispatcher.js";
export { doorFetch, RUNNER_URL } from "./door.js";
export { runTurn } from "./executor.js";
export { sqliteStore } from "./sqlite.js";
export type { RuntimeStore } from "./store.js";

export interface RunnerOptions {
  /** The SQLite file; or a store already open. */
  file?: string;
  store?: RuntimeStore;
  services: readonly unknown[];
  /** The lock row's name: one dispatcher per name per file. */
  name?: string;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  /** A process that lost the lock tries again this often (the holder may exit). */
  takeOverMs?: number;
  /** Restate's `disableRetries`: a failed handler ends on its first error. */
  disableRetries?: boolean;
  /** Restate's `alwaysReplay`, for tests. */
  replay?: boolean;
  /** Ends no turn early: `localWaitMs` of the turn (tests set 0 to suspend every sleep). */
  localWaitMs?: number;
  crash?: (point: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

export interface Runner {
  store: RuntimeStore;
  ingress: clients.Ingress;
  /** False: a live process dispatches this file; this one only calls, and takes over once it exits. */
  readonly dispatching: boolean;
  stop(): Promise<void>;
}

const open = (o: { file?: string; store?: RuntimeStore }) => {
  if (o.store) return o.store;
  if (!o.file) throw new Error("runner: a file or a store");
  return sqliteStore(o.file);
};

/** A client on the store: same calls as Restate's ingress, no port. */
export const ingressOf = (store: RuntimeStore): clients.Ingress =>
  clients.connect({ url: RUNNER_URL, fetch: doorFetch(store) });

/** Calls only: the dispatching process runs them (the desk, or a `startRunner`). */
export function localIngress(file: string): { ingress: clients.Ingress; store: RuntimeStore } {
  const store = sqliteStore(file);
  return { store, ingress: ingressOf(store) };
}

export async function startRunner(o: RunnerOptions): Promise<Runner> {
  const store = open(o);
  const registry = new Registry(o.services);
  if (o.disableRetries)
    for (const h of registry.list()) h.retry = { maxAttempts: 1, onMaxAttempts: "kill" };
  await store.register(
    registry.list().map((h) => ({
      service: h.service,
      handler: h.name,
      object: h.object,
      exclusive: h.exclusive,
      private: h.private,
    })),
  );
  const lane = { only: [...registry.services.keys()] };
  const name = o.name ?? "main";
  const leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
  const dispatcher = new Dispatcher({
    store,
    lane,
    leaseMs,
    ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
    ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
    ...(o.log ? { log: o.log } : {}),
    run: (c) =>
      runTurn(
        {
          store,
          registry,
          leaseMs,
          ...(o.replay ? { replay: true } : {}),
          ...(o.crash ? { crash: o.crash } : {}),
          ...(o.localWaitMs === undefined ? {} : { localWaitMs: o.localWaitMs }),
          ...(o.log ? { log: o.log } : {}),
        },
        c,
      ),
  });
  let dispatching = false;
  let stopped = false;
  const claim = async () => {
    if (stopped || dispatching || !(await store.takeOver(name, lane))) return;
    dispatching = true;
    clearInterval(retry);
    dispatcher.start();
  };
  // the holder (desk or worker) may exit: then this process dispatches
  const retry = setInterval(
    () => void claim().catch((e) => o.log?.("runner: take over failed", e)),
    o.takeOverMs ?? 5_000,
  );
  retry.unref();
  await claim();
  return {
    store,
    ingress: ingressOf(store),
    get dispatching() {
      return dispatching;
    },
    async stop() {
      stopped = true;
      clearInterval(retry);
      if (dispatching) await dispatcher.stop();
      if (!o.store) await store.close();
    },
  };
}
