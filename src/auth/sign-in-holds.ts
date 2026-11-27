/**
 * Holds after a failed sign-in, by case (designs/2026-11-26-branching-sign-ins.md, "Holds"):
 * a password the site rejected waits for a new password or 24 h; the rest climb a short
 * ladder with jitter, capped per 24 h. Every try goes to an append-only log.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Why a sign-in failed, as the hold sees it. */
export type FailCase = "password" | "account" | "unproven" | "code" | "later" | "ours";

export interface Hold {
  until: number;
  error: string;
  case?: FailCase;
  /** Failures in a row since the last sign-in that worked. */
  fails?: number;
  /** Capped failures of the last 24 h. */
  recent?: { at: number; case: FailCase }[];
  /** A person signs in by hand (24 h); else the caller tries again after `until`. */
  strict?: boolean;
}

/** Holds by credential name. A record outlives its `until`: its `fails` set the next rung. */
export interface SignInHolds {
  get(name: string): Hold | null;
  set(name: string, hold: Hold): void;
  clear(name: string): void;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Minutes per rung; past the last, the last. */
export const LADDER_MIN = [1, 3, 5, 10, 30, 60] as const;
export const JITTER = 0.2;
/** The rung a case starts on: an unproven password waits longer from the first. */
const START: Partial<Record<FailCase, number>> = { unproven: 3 };
/** Failures of a case per 24 h, then 24 h and a person. */
export const CAPS: Partial<Record<FailCase, number>> = { unproven: 3, code: 6, later: 6 };
/** These wait 24 h at once (a password change lifts `password` sooner). */
const STRICT: readonly FailCase[] = ["password", "account"];

/** The hold after a failure: its case, the record before it, now, a random in [0, 1). */
export function nextHold(
  c: FailCase,
  error: string,
  prev: Hold | null,
  now: number,
  random: () => number = Math.random,
): Hold {
  const fails = (prev?.fails ?? 0) + 1;
  const recent = (prev?.recent ?? []).filter((r) => r.at > now - DAY_MS);
  if (CAPS[c] !== undefined) recent.push({ at: now, case: c });
  const capped = CAPS[c] !== undefined && recent.filter((r) => r.case === c).length >= CAPS[c];
  const base = { error, case: c, fails, recent };
  if (STRICT.includes(c) || capped) return { ...base, until: now + DAY_MS, strict: true };
  const rung = Math.min((START[c] ?? 0) + fails - 1, LADDER_MIN.length - 1);
  const ms = (LADDER_MIN[rung] as number) * 60_000 * (1 + (random() * 2 - 1) * JITTER);
  return { ...base, until: now + Math.round(ms), strict: false };
}

/** Holds in one JSON file (an absolute path); a broken file reads as none. */
export function fileSignInHolds(file: string): SignInHolds {
  type Marks = Record<string, Hold>;
  const read = (): Marks => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Marks;
    } catch {
      return {};
    }
  };
  const write = (m: Marks) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  };
  return {
    get: (name) => read()[name] ?? null,
    set: (name, hold) => write({ ...read(), [name]: hold }),
    clear(name) {
      const m = read();
      if (!(name in m)) return;
      delete m[name];
      write(m);
    },
  };
}

/** One sign-in try, as kept: never a secret. */
export interface SignInTry {
  at: string;
  name: string;
  /** `password`, `via:google`, … */
  method?: string;
  outcome: "signed-in" | "signed-in-anyway" | "failed" | "held";
  case?: FailCase;
  error?: string;
  /** Where the page ended. */
  url?: string;
  typed?: { password: number; code: number };
  /** Screens a login walk passed, in order. */
  screens?: string[];
  hold?: { until: string; strict: boolean; fails: number };
  ms?: number;
}

export interface SignInLog {
  add(row: SignInTry): void;
}

/** Tries as JSON lines (append-only); a write that fails loses the row, never the sign-in. */
export function fileSignInLog(file: string): SignInLog {
  return {
    add(row) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(row)}\n`);
      } catch {
        // the log is a record, not a gate
      }
    },
  };
}
