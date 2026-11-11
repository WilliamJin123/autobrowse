/**
 * Before/after hooks on every site call (OpenCLI audit U23). A hook comes from code (a library
 * caller passes it) or from a trusted mod (`hooks/<name>.ts`). `before` may refuse a call by
 * throwing; it sees a copy of the input and cannot change it. `after` only observes: its error
 * is logged, never the caller's.
 */
import type { SiteFacade } from "./facade.js";
import { type Method, SiteError } from "./types.js";

export interface HookCall {
  site: string;
  method: Method;
  path: string;
  input: Readonly<Record<string, unknown>>;
  account: string | null;
  caller: string | null;
}

export type HookOutcome =
  | { ok: true; ms: number; result: unknown }
  | { ok: false; ms: number; error: unknown };

export interface CallHook {
  name: string;
  /** Only these sites; all when absent. */
  sites?: readonly string[];
  before?(call: HookCall): void | Promise<void>;
  after?(call: HookCall, out: HookOutcome): void | Promise<void>;
}

export const isCallHook = (v: unknown): v is CallHook =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as CallHook).name === "string" &&
  (typeof (v as CallHook).before === "function" || typeof (v as CallHook).after === "function");

/** A deep copy where the input allows one (a stream does not): a hook never edits the call. */
function copyOf(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(input);
  } catch {
    return { ...input };
  }
}

export function withHooks(
  facade: SiteFacade,
  hooks: readonly CallHook[],
  onHookError: (hook: string, err: unknown) => void = () => {},
): SiteFacade {
  if (!hooks.length) return facade;
  return {
    ...facade,
    async call(site, method, path, input, account, from) {
      const call: HookCall = Object.freeze({
        site,
        method,
        path,
        input: Object.freeze(copyOf(input)),
        account: account ?? null,
        caller: from?.caller ?? null,
      });
      const mine = hooks.filter((h) => !h.sites || h.sites.includes(site.split("@")[0] ?? site));
      for (const h of mine) {
        if (!h.before) continue;
        try {
          await h.before(call);
        } catch (err) {
          if (err instanceof SiteError) throw err;
          throw new SiteError(403, `refused by hook ${h.name}: ${(err as Error).message ?? err}`);
        }
      }
      const t0 = Date.now();
      const after = async (out: HookOutcome) => {
        for (const h of mine)
          if (h.after)
            await Promise.resolve(h.after(call, out)).catch((e) => onHookError(h.name, e));
      };
      try {
        const result = await facade.call(site, method, path, input, account, from);
        await after({ ok: true, ms: Date.now() - t0, result });
        return result;
      } catch (error) {
        await after({ ok: false, ms: Date.now() - t0, error });
        throw error;
      }
    },
  };
}
