/**
 * The probe (OpenCLI audit U17): a weekly pass that proves what still works with no caller
 * waiting. Each site's who-am-I call (`checkSite`), and a re-proof of each compiled workflow
 * that opted in with a `.plan.json` (gates declined). One row each, typed, in
 * `probes/probes-YYYY-MM.jsonl`; `autobrowse stats success` shows the newest per name.
 * Opt-in for workflows: a proof runs every act but the gated ones, and a profile edit or a
 * sign-up is not gated.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorOf } from "../errors.js";
import type { CheckRow } from "../sites/facade.js";
import type { ErrorCode } from "../ui/http.js";
import type { Proof } from "../workflows/proof.js";

/** Agent-Reach's route states, plus a proof whose output missed its fixture. */
export type ProbeState =
  | "ready"
  | "needs_login"
  | "cooldown"
  | "needs_person"
  | "off_fixture"
  | "broken"
  | "unchecked";

export interface ProbeRow {
  at: string;
  kind: "site" | "workflow";
  name: string;
  state: ProbeState;
  ms?: number;
  why?: string;
}

export const PROBE_EVERY_MS = 7 * 24 * 60 * 60_000;
const WHY_CHARS = 200;
const monthOf = (iso: string) => iso.slice(0, 7);

export function stateOfCode(code: ErrorCode | undefined): ProbeState {
  switch (code) {
    case undefined:
      return "ready";
    case "unauthorized":
    case "forbidden":
      return "needs_login";
    case "rate_limited":
    case "profile_busy":
      return "cooldown";
    case "needs_person":
    case "gate_refused":
      return "needs_person";
    default:
      return "broken";
  }
}

export function siteProbeRow(c: CheckRow, at: string): ProbeRow {
  const state: ProbeState = c.ok
    ? "ready"
    : c.why === "no probe"
      ? "unchecked"
      : c.code
        ? stateOfCode(c.code)
        : /no token|not configured|no api leg|consent|sign in/i.test(c.why ?? "")
          ? "needs_login"
          : "broken";
  return {
    at,
    kind: "site",
    name: c.site,
    state,
    ...(c.ms !== undefined ? { ms: c.ms } : {}),
    ...(c.why ? { why: c.why.slice(0, WHY_CHARS) } : {}),
  };
}

export function workflowProbeRow(name: string, p: Proof | Error, ms: number): ProbeRow {
  if (p instanceof Error) {
    const e = errorOf(p);
    return {
      at: new Date().toISOString(),
      kind: "workflow",
      name,
      state: stateOfCode(e.code),
      ms,
      why: e.message.slice(0, WHY_CHARS),
    };
  }
  const last = p.steps.at(-1);
  const state: ProbeState =
    p.status === "done"
      ? p.expect?.ok === false
        ? "off_fixture"
        : "ready"
      : /human|person|gate|waiting/i.test(p.status)
        ? "needs_person"
        : "broken";
  const why =
    state === "off_fixture"
      ? p.expect?.failed.join("; ")
      : state === "ready"
        ? undefined
        : `${p.status}${last ? ` at ${last.name}: ${last.detail}` : ""}`;
  return {
    at: p.at,
    kind: "workflow",
    name,
    state,
    ms,
    ...(why ? { why: why.slice(0, WHY_CHARS) } : {}),
  };
}

export function recordProbes(dir: string, rows: readonly ProbeRow[]): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const r of rows)
      appendFileSync(join(dir, `probes-${monthOf(r.at)}.jsonl`), `${JSON.stringify(r)}\n`, {
        mode: 0o600,
      });
  } catch {
    // a full disk never fails the probe
  }
}

/** Rows since `since` (ISO), oldest first. */
export function readProbes(dir: string, since: string): ProbeRow[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: ProbeRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^probes-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as ProbeRow;
        if (row.at >= since) out.push(row);
      } catch {
        // torn
      }
    }
  }
  return out;
}

/** The newest row per kind and name, with when it last was ready; broken first. */
export function latestProbes(rows: readonly ProbeRow[]) {
  const last = new Map<string, ProbeRow & { lastReady: string | null }>();
  const ready = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.kind}:${r.name}`;
    if (r.state === "ready") ready.set(k, r.at);
    last.set(k, { ...r, lastReady: ready.get(k) ?? null });
  }
  const rank = (s: ProbeState) => (s === "ready" ? 2 : s === "unchecked" ? 1 : 0);
  return [...last.values()].sort(
    (a, b) =>
      rank(a.state) - rank(b.state) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

/** Due when the newest row is a week old, or there is none. */
export function probeDue(dir: string, now = Date.now()): boolean {
  const rows = readProbes(dir, new Date(now - 2 * PROBE_EVERY_MS).toISOString());
  const at = rows.at(-1)?.at;
  return !at || now - Date.parse(at) >= PROBE_EVERY_MS;
}

export function probeLines(rows: ReturnType<typeof latestProbes>): string[] {
  if (!rows.length) return ["probes: none yet (`autobrowse probe`)"];
  const counts = new Map<ProbeState, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const unchecked = rows.filter((r) => r.state === "unchecked").map((r) => r.name);
  return [
    `probes: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}`,
    ...rows
      .filter((r) => r.state !== "ready" && r.state !== "unchecked")
      .map(
        (r) =>
          `  ${r.state.padEnd(12)} ${r.kind} ${r.name} (${r.at.slice(0, 10)}${r.lastReady ? `, ready ${r.lastReady.slice(0, 10)}` : ""})${r.why ? `: ${r.why}` : ""}`,
      ),
    ...(unchecked.length ? [`  unchecked (no probe): ${unchecked.join(" ")}`] : []),
  ];
}
