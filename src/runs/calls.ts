/**
 * Site calls: every attempt at a `sites`/`desk` call, one line, kept for good.
 * Restate keeps a finished invocation about a day and the caps ledger only
 * metered reads for 14 days; this is the history success rates are read from.
 * A retried call is several lines under one `invocation`: the last says how
 * it ended. One file per month (`calls-2026-10.jsonl`), plain appends like
 * the model call ledger: several processes write and a line under 4 KB lands
 * whole. The input and the answer go to the bodies ledger beside it (`bodies/`, call-bodies.ts);
 * the row carries the body's id.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendBody } from "./call-bodies.js";

export interface SiteCallRow {
  at: string;
  /** `sites` (the box) or `desk` (the Mac). */
  service: string;
  site: string;
  /** `GET /r/{sub}/new` as asked, ids and all. */
  route: string;
  caller: string | null;
  invocation: string | null;
  /** 1 for the first try of this invocation in this process; a rerun after a crash starts at 1 again. */
  attempt: number;
  ok: boolean;
  /** The SiteError's status (400 the caller's mistake, 429 a cap); null for an unexpected throw. */
  status: number | null;
  /** True: the caller gets this error, nothing retries it. */
  terminal: boolean;
  error: string | null;
  ms: number;
  /** The leg that ran (from 2026-11-05); absent when the call ended before a leg began. */
  via?: "api" | "browser" | "cache";
  /** The answer's line id in the bodies ledger (call-bodies.ts). */
  body?: string;
  /** The route's path as written, `{param}` and all: what `site paths --check` groups by. */
  template?: string;
  /** Imported from an older record (Restate's history, the caps ledger), not written live. */
  from?: "restate" | "caps";
  /** The flow's failure record, when a browser leg failed. */
  artifact?: string;
}

/** What a call took and gave, for the bodies ledger. */
export interface CallData {
  account: string | null;
  input: unknown;
  answer?: unknown;
}

export interface SiteCalls {
  record(row: SiteCallRow, data?: CallData): void;
}

export const bodiesDirOf = (callsDir: string): string => join(callsDir, "bodies");

const ERROR_CHARS = 300;
const monthOf = (iso: string): string => iso.slice(0, 7);

export function fileSiteCalls(dir: string): SiteCalls {
  return {
    record(row, data) {
      const body = data
        ? appendBody(bodiesDirOf(dir), {
            at: row.at,
            service: row.service,
            site: row.site,
            route: row.route,
            account: data.account,
            caller: row.caller,
            ok: row.ok,
            input: data.input,
            ...(row.ok ? { answer: data.answer } : { error: row.error }),
          })
        : null;
      const line = {
        ...row,
        ...(body ? { body } : {}),
        error: row.error?.slice(0, ERROR_CHARS) ?? null,
      };
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, `calls-${monthOf(row.at)}.jsonl`), `${JSON.stringify(line)}\n`, {
          mode: 0o600,
        });
      } catch {
        // A full disk never fails the call it records.
      }
    },
  };
}

export function memorySiteCalls(): SiteCalls & {
  rows: SiteCallRow[];
  data: (CallData | undefined)[];
} {
  const rows: SiteCallRow[] = [];
  const data: (CallData | undefined)[] = [];
  return {
    rows,
    data,
    record: (r, d) => {
      rows.push(r);
      data.push(d);
    },
  };
}

/** Rows since `since` (ISO), oldest first, from the month files that can hold them. */
export function readSiteCalls(dir: string, since: string): SiteCallRow[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: SiteCallRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^calls-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SiteCallRow;
        if (row.at >= since) out.push(row);
      } catch {
        // A torn line from a crash mid-write is skipped, not fatal.
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** One line per invocation: its last attempt, and how many it took. Rows without an invocation stand alone. */
export function settledCalls(rows: SiteCallRow[]): (SiteCallRow & { attempts: number })[] {
  const by = new Map<string, SiteCallRow & { attempts: number }>();
  rows.forEach((r, i) => {
    const key = r.invocation ?? `#${i}`;
    const had = by.get(key);
    by.set(key, { ...r, attempts: (had?.attempts ?? 0) + 1 });
  });
  return [...by.values()];
}
