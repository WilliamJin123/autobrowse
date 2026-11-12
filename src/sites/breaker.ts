/**
 * Circuit breakers on API legs. A key opens after `after` upstream faults in a row (5xx, timeout,
 * no answer); it stays open `firstMs`, doubling per reopen to `maxMs`. When open time ends, one call
 * goes through as the probe; its fault reopens at once, any answer closes it. `trip` opens a key
 * till a set time (a 429's spent app quota: UTC midnight).
 * Own code, not cockatiel/opossum: the facade decides the leg before the call (open → browser leg)
 * and returns the exact reopen time as Retry-After; both libraries wrap the call and hide that time.
 */
import { HttpError } from "../clients/http.js";

export const BREAK_AFTER = 5;
export const BREAK_FIRST_MS = 30_000;
export const BREAK_MAX_MS = 15 * 60_000;
/** While a probe runs, other calls wait this long. */
const PROBE_WAIT_MS = 5_000;
/** A probe that never reported (a cap refused the call after it was picked) frees the key after this. */
const PROBE_STALE_MS = 60_000;

interface State {
  fails: number;
  opens: number;
  openUntil: number;
  /** When the probe started; 0: none. */
  probing: number;
  why: string;
}

export interface BreakerState {
  key: string;
  fails: number;
  open: boolean;
  until: string | null;
  why: string;
}

export interface Breakers {
  /** Ms until `key` may be tried; null when closed or when this call is the probe. */
  blocked(key: string): number | null;
  /** The upstream answered (any answer, a 4xx too). */
  ok(key: string): void;
  /** An upstream fault: counts toward opening. */
  fault(key: string, why: string): void;
  /** Open till `until` (epoch ms). */
  trip(key: string, until: number, why: string): void;
  states(): BreakerState[];
}

/** The site is down or not answering, not refusing this call. */
export const upstreamFault = (e: unknown): boolean =>
  e instanceof HttpError && (e.status === 0 || e.status === 408 || e.status >= 500);

export function breakers(
  o: { now?: () => number; after?: number; firstMs?: number; maxMs?: number } = {},
): Breakers {
  const now = o.now ?? Date.now;
  const after = o.after ?? BREAK_AFTER;
  const firstMs = o.firstMs ?? BREAK_FIRST_MS;
  const maxMs = o.maxMs ?? BREAK_MAX_MS;
  const m = new Map<string, State>();
  const stateOf = (key: string) => {
    let s = m.get(key);
    if (!s) {
      s = { fails: 0, opens: 0, openUntil: 0, probing: 0, why: "" };
      m.set(key, s);
    }
    return s;
  };
  return {
    blocked(key) {
      const s = m.get(key);
      if (!s?.openUntil) return null;
      const t = now();
      if (t < s.openUntil) return s.openUntil - t;
      if (s.probing && t - s.probing < PROBE_STALE_MS) return PROBE_WAIT_MS;
      s.probing = t;
      return null;
    },
    ok: (key) => void m.delete(key),
    fault(key, why) {
      const s = stateOf(key);
      s.fails++;
      s.why = why.slice(0, 200);
      // A failed probe reopens at once, for longer.
      if (s.fails < after && !s.probing) return;
      s.probing = 0;
      s.opens++;
      s.openUntil = now() + Math.min(maxMs, firstMs * 2 ** (s.opens - 1));
    },
    trip(key, until, why) {
      const s = stateOf(key);
      s.probing = 0;
      s.opens++;
      s.openUntil = Math.max(s.openUntil, until);
      s.why = why.slice(0, 200);
    },
    states: () =>
      [...m].map(([key, s]) => ({
        key,
        fails: s.fails,
        open: s.openUntil > now(),
        until: s.openUntil ? new Date(s.openUntil).toISOString() : null,
        why: s.why,
      })),
  };
}
