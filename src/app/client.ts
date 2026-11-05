/** Restate ingress clients for the CLI and the UI server: one place that knows the object names. */
import * as clients from "@restatedev/restate-sdk-clients";
import { BROWSER_SERVICE, type BrowserService } from "../engine/browser-service.js";
import type { RunObject } from "../engine/object.js";
import { REGISTRY_KEY, type RunsRegistry, registryOf } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { named, operator } from "../owner.js";
import { DESK_SERVICE, SITES_SERVICE, type SitesService } from "../sites/service.js";
import { COMPILED_OBJECT, compiledKey, HAND_WRITTEN } from "../workflows/compiled.js";

export interface IngressOptions {
  url: string;
  authToken?: string | null;
  /** Whose worker to call: every object and service name carries it. */
  owner?: string;
}

export function ingress(opts: IngressOptions) {
  const conn = clients.connect({
    url: opts.url,
    ...(opts.authToken ? { headers: { authorization: `Bearer ${opts.authToken}` } } : {}),
  });
  const owner = opts.owner ?? operator();
  const compiled = { name: named(COMPILED_OBJECT.name, owner) };
  return {
    /** A run of `workflow`: hand-written ones have an object each; compiled ones share `Compiled`. */
    run: (workflow: string, key: string) =>
      HAND_WRITTEN.has(workflow)
        ? conn.objectClient<RunObject<AnyWorkflow>>({ name: named(workflow, owner) }, key)
        : conn.objectClient<RunObject<AnyWorkflow>>(compiled, compiledKey(workflow, key)),
    registry: () =>
      conn.objectClient<RunsRegistry>(registryOf(owner) as RunsRegistry, REGISTRY_KEY),
    /** The worker's browser legs (`browser/flow`): a flow run on the box, not here. */
    browser: () =>
      conn.serviceClient<BrowserService>({
        name: named(BROWSER_SERVICE, owner),
      } as BrowserService),
    /** The worker's site facade (`sites/*`): the box's tokens, caps and ledger. */
    sites: () =>
      conn.serviceClient<SitesService>({ name: named(SITES_SERVICE, owner) } as SitesService),
    /** The same facade on the Mac (`desk/*`): prod's tokens since the box was retired. */
    desk: () =>
      conn.serviceClient<SitesService>({ name: named(DESK_SERVICE, owner) } as SitesService),
    /** Jobs (`app/jobs.ts`): a send by key, then attach, or a look at the output that never waits. */
    job: {
      send: async (
        service: string,
        handler: string,
        input: unknown,
        o: { key: string; delayMs?: number },
      ): Promise<clients.Send> => {
        const client = conn.serviceSendClient({ name: named(service, owner) }) as unknown as Record<
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
      result: (id: string): Promise<unknown> =>
        conn.result({ invocationId: id, status: "Accepted", attachable: true }),
      /** Restate answers 470 while the invocation runs: `{done: false}`. */
      output: async (
        id: string,
        http: typeof fetch = fetch,
      ): Promise<{ done: false } | { done: true; status: number; body: string }> => {
        const r = await http(`${opts.url}/restate/invocation/${encodeURIComponent(id)}/output`, {
          headers: opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {},
        });
        if (r.status === 470) return { done: false };
        return { done: true, status: r.status, body: await r.text() };
      },
    },
  };
}

export type Ingress = ReturnType<typeof ingress>;
