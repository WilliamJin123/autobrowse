/**
 * A state per route (OpenCLI audit U18, Agent-Reach's form): from what the facade knows now
 * (missing leg, refused token, a cap hold) and the newest call in the site-call ledger.
 * No call is made. `site status` shows it; `doctor` counts what is not ready.
 */
import type { SiteCallRow } from "../runs/calls.js";
import type { ProbeState } from "../runs/probes.js";
import { ACCOUNT_HOLD } from "./caps.js";
import type { RouteRow } from "./facade.js";

export interface RouteState {
  state: ProbeState;
  /** The newest call's time, when the state comes from one. */
  checkedAt?: string;
  why?: string;
}

/** `GET /x/{id}` → `GET` + `/x/{id}`, as the ledger keeps them. */
const keyOf = (method: string, template: string) => `${method} ${template}`;

/** The newest ledger row per `METHOD template`. */
export function lastCalls(rows: readonly SiteCallRow[], site: string): Map<string, SiteCallRow> {
  const out = new Map<string, SiteCallRow>();
  for (const r of rows) {
    if (r.site !== site || !r.template || r.from) continue;
    const k = keyOf(r.route.split(" ")[0] ?? "", r.template);
    const had = out.get(k);
    if (!had || had.at <= r.at) out.set(k, r);
  }
  return out;
}

export function routeState(
  r: Pick<RouteRow, "method" | "path" | "missing">,
  o: { refused: boolean; heldS: number; last?: SiteCallRow },
): RouteState {
  if (r.missing) {
    const state: ProbeState = /no token|consent|sign/i.test(r.missing)
      ? "needs_login"
      : /waiting on/i.test(r.missing)
        ? "needs_person"
        : "broken";
    return { state, why: r.missing };
  }
  if (o.refused) return { state: "needs_login", why: "token refused" };
  if (o.heldS > 0) return { state: "cooldown", why: `held ${Math.ceil(o.heldS / 60)} min` };
  const c = o.last;
  if (!c) return { state: "unchecked" };
  const at = { checkedAt: c.at };
  // 400/404/409: the caller's input, not the route.
  if (c.ok || (c.status !== null && [400, 404, 409, 422].includes(c.status)))
    return { state: "ready", ...at };
  const why = (c.error ?? `status ${c.status}`).slice(0, 120);
  if (c.status === 401 || c.status === 403) return { state: "needs_login", ...at, why };
  if (c.status === 429) return { state: "cooldown", ...at, why };
  if (/needs a person|needs_person|human/i.test(c.error ?? ""))
    return { state: "needs_person", ...at, why };
  return { state: "broken", ...at, why };
}

/**
 * Seconds left on a whole-account hold (`ACCOUNT_HOLD`) at this site, from `caps.held()`.
 * A bucket's hold is left out: a route row does not say which buckets it meters.
 */
export function siteHeldS(
  held: Record<string, { until: number }>,
  site: string,
  now = Date.now(),
): number {
  let most = 0;
  for (const [k, h] of Object.entries(held))
    if (k.startsWith(`${site}|`) && k.endsWith(`|${ACCOUNT_HOLD}`))
      most = Math.max(most, (h.until - now) / 1000);
  return Math.max(0, Math.round(most));
}
