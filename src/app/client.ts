/**
 * Clients for the CLI and the UI server: one place that knows the object names and where each runs.
 * The desk's services (`desk`, `claude`, `studio`, `calls`) are at wren's door; every other name
 * runs on the local runner's file (designs/2026-11-16-local-runner.md).
 */
import * as clients from "@restatedev/restate-sdk-clients";
import { CALLS_SERVICE } from "../calls/service.js";
import { CLAUDE_SERVICE } from "../claude/service.js";
import { BROWSER_SERVICE, type BrowserService } from "../engine/browser-service.js";
import type { RunObject } from "../engine/object.js";
import { REGISTRY_KEY, type RunsRegistry, registryOf } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { expandHome } from "../google/auth.js";
import { named, operator } from "../owner.js";
import { doorFetch, ingressOf, RUNNER_URL } from "../runtime/index.js";
import { sqliteStore } from "../runtime/sqlite.js";
import type { RuntimeStore } from "../runtime/store.js";
import { DESK_SERVICE, SITES_SERVICE, type SitesService } from "../sites/service.js";
import { STUDIO_SERVICE } from "../studio/service.js";
import { COMPILED_OBJECT, compiledKey, HAND_WRITTEN } from "../workflows/compiled.js";

/** Served by the desk through wren's door. */
export const DOOR_SERVICES = [DESK_SERVICE, CLAUDE_SERVICE, STUDIO_SERVICE, CALLS_SERVICE] as const;

/** A full name (`desk_acme`) the door serves; false: the local runner's. */
export const atDoor = (name: string, owner: string): boolean =>
  DOOR_SERVICES.some((s) => named(s, owner) === name);

export interface IngressOptions {
  /** wren's door. */
  url: string;
  authToken?: string | null;
  /** Whose worker to call: every object and service name carries it. */
  owner?: string;
  /** The runner's file (opened on first use), or the store this process already runs. */
  runner: string | RuntimeStore;
}

export function ingress(opts: IngressOptions) {
  const door = clients.connect({
    url: opts.url,
    ...(opts.authToken ? { headers: { authorization: `Bearer ${opts.authToken}` } } : {}),
  });
  let local: { store: RuntimeStore; conn: clients.Ingress; fetch: typeof fetch } | undefined;
  const runner = () => {
    if (!local) {
      const store =
        typeof opts.runner === "string" ? sqliteStore(expandHome(opts.runner)) : opts.runner;
      local = { store, conn: ingressOf(store), fetch: doorFetch(store) };
    }
    return local;
  };
  const owner = opts.owner ?? operator();
  const conn = (name: string) => (atDoor(name, owner) ? door : runner().conn);
  const compiled = { name: named(COMPILED_OBJECT.name, owner) };
  /** A job id the runner holds; else the door's. */
  const isLocal = async (id: string) => (await runner().store.result(id)) !== undefined;
  return {
    /** A run of `workflow`: hand-written ones have an object each; compiled ones share `Compiled`. */
    run: (workflow: string, key: string) =>
      HAND_WRITTEN.has(workflow)
        ? runner().conn.objectClient<RunObject<AnyWorkflow>>({ name: named(workflow, owner) }, key)
        : runner().conn.objectClient<RunObject<AnyWorkflow>>(compiled, compiledKey(workflow, key)),
    registry: () =>
      runner().conn.objectClient<RunsRegistry>(registryOf(owner) as RunsRegistry, REGISTRY_KEY),
    /** The browser legs (`browser/flow`), on the runner. */
    browser: () =>
      runner().conn.serviceClient<BrowserService>({
        name: named(BROWSER_SERVICE, owner),
      } as BrowserService),
    /** The site facade (`sites/*`), on the runner. */
    sites: () =>
      runner().conn.serviceClient<SitesService>({
        name: named(SITES_SERVICE, owner),
      } as SitesService),
    /** The same facade on the desk (`desk/*`), at the door: prod's tokens. */
    desk: () =>
      door.serviceClient<SitesService>({ name: named(DESK_SERVICE, owner) } as SitesService),
    /** Jobs (`app/jobs.ts`): a send by key, then attach, or a look at the output that never waits. */
    job: {
      send: async (
        service: string,
        handler: string,
        input: unknown,
        o: { key: string; delayMs?: number },
      ): Promise<clients.Send> => {
        const name = named(service, owner);
        const client = conn(name).serviceSendClient({ name }) as unknown as Record<
          string,
          (i: unknown, opts: unknown) => Promise<clients.Send>
        >;
        const send = client[handler];
        if (!send) throw new Error(`job: no handler ${handler}`);
        return send(
          input,
          clients.rpc.sendOpts({
            idempotencyKey: o.key,
            ...(o.delayMs ? { delay: o.delayMs } : {}),
          }),
        );
      },
      result: async (id: string): Promise<unknown> =>
        ((await isLocal(id)) ? runner().conn : door).result({
          invocationId: id,
          status: "Accepted",
          attachable: true,
        }),
      /** 470 while the invocation runs: `{done: false}`. */
      output: async (
        id: string,
        http: typeof fetch = fetch,
      ): Promise<{ done: false } | { done: true; status: number; body: string }> => {
        const path = `/restate/invocation/${encodeURIComponent(id)}/output`;
        const r = (await isLocal(id))
          ? await runner().fetch(`${RUNNER_URL}${path}`)
          : await http(`${opts.url}${path}`, {
              headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {},
            });
        if (r.status === 470) return { done: false };
        return { done: true, status: r.status, body: await r.text() };
      },
    },
  };
}

export type Ingress = ReturnType<typeof ingress>;
