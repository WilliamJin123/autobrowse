/**
 * Site calls from before the call ledger, into it: the caps ledger (metered
 * reads, 14 days). One row per try, marked `from`, never a call the ledger
 * already has. (Restate's backfill went with Restate, 11-16.)
 */
import type { MeteredCall } from "../sites/caps.js";
import type { SiteCallRow } from "./calls.js";

/** `capped` and `paced` spent nothing and answered 429; `failed` spent the read and got no answer. */
export function fromCaps(calls: readonly MeteredCall[], service = "desk"): SiteCallRow[] {
  return calls.map((c) => ({
    at: c.at,
    service,
    site: c.site,
    route: c.route,
    caller: c.caller,
    invocation: c.invocation ?? null,
    attempt: 1,
    ok: c.outcome === "ok",
    status: c.outcome === "ok" ? null : c.outcome === "failed" ? 502 : 429,
    terminal: c.outcome !== "ok",
    error: c.outcome === "ok" ? null : `${c.outcome}${c.bucket ? ` (${c.bucket})` : ""}`,
    ms: 0,
    from: "caps" as const,
  }));
}

/**
 * New rows only: an invocation the ledger already has is skipped. The caps
 * ledger notes every try, so one invocation there can be several rows; they
 * stay, numbered as attempts.
 */
export function newRows(have: readonly SiteCallRow[], caps: readonly SiteCallRow[]): SiteCallRow[] {
  const had = new Set(have.map((r) => r.invocation).filter(Boolean));
  const out: SiteCallRow[] = [];
  const tries = new Map<string, number>();
  for (const r of [...caps].sort((a, b) => a.at.localeCompare(b.at))) {
    if (r.invocation && had.has(r.invocation)) continue;
    const attempt = r.invocation ? (tries.get(r.invocation) ?? 0) + 1 : 1;
    if (r.invocation) tries.set(r.invocation, attempt);
    out.push({ ...r, attempt });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
