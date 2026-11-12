/**
 * Read answers kept a short while: the same GET by the same account answers from memory, spends no
 * cap, no pace, no token. TTL bounds staleness (correctness); the LRU size bound caps memory.
 * Lasting refusals (a dead post's 400) are kept too: Nov 2026 read one dead Meta post 185 times.
 * Calls in flight are shared: a second identical call waits on the first.
 * In the process's memory (the desk serves every prod call); a restart starts empty.
 * Design: designs/2026-11-12-call-cache-and-breaker.md.
 */
import { LRUCache } from "lru-cache";

/** Default life of a kept read; a route's `ttl` overrides. */
export const CALL_TTL_MS = 60_000;
const MAX_ENTRIES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
/** Upstream statuses that answer the same next time: kept like an answer. */
const LASTING = new Set([400, 404, 410, 422]);

export type Kept = { ok: true; value: unknown } | { ok: false; error: unknown };

export interface CallCache {
  get(key: string): Kept | undefined;
  /** The same call in flight, if any. */
  flying(key: string): Promise<Kept> | undefined;
  /** Run `fn` once for `key`; keep its answer (or lasting refusal) for `ttlMs`. */
  run(key: string, ttlMs: number, fn: () => Promise<unknown>): Promise<Kept>;
  /** Drop every key under `prefix` (a write by that account). */
  clear(prefix: string): void;
  size(): number;
}

/** A status on an error, any class (HttpError, SiteError). */
const statusOf = (e: unknown): number | null => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
};

export const lastingError = (e: unknown): boolean => LASTING.has(statusOf(e) ?? 0);

const sizeOf = (k: Kept): number => {
  if (!k.ok) return 1024;
  try {
    return Math.max(1, JSON.stringify(k.value)?.length ?? 1);
  } catch {
    return MAX_BYTES; // not JSON: never kept long
  }
};

export function callCache(
  o: { now?: () => number; max?: number; maxBytes?: number } = {},
): CallCache {
  const lru = new LRUCache<string, Kept>({
    max: o.max ?? MAX_ENTRIES,
    maxSize: o.maxBytes ?? MAX_BYTES,
    sizeCalculation: sizeOf,
    ttl: CALL_TTL_MS,
    ...(o.now ? { perf: { now: o.now }, ttlResolution: 0 } : {}), // injected clock: read it every time
  });
  const inFlight = new Map<string, Promise<Kept>>();
  return {
    get: (key) => lru.get(key),
    flying: (key) => inFlight.get(key),
    run(key, ttlMs, fn) {
      const p = fn().then(
        (value): Kept => ({ ok: true, value }),
        (error: unknown): Kept => ({ ok: false, error }),
      );
      const settled = p.then((k) => {
        inFlight.delete(key);
        if (ttlMs > 0 && (k.ok || lastingError(k.error)) && sizeOf(k) < (o.maxBytes ?? MAX_BYTES))
          lru.set(key, k, { ttl: ttlMs });
        return k;
      });
      inFlight.set(key, settled);
      return settled;
    },
    clear(prefix) {
      for (const k of [...lru.keys()]) if (k.startsWith(prefix)) lru.delete(k);
      for (const k of [...inFlight.keys()]) if (k.startsWith(prefix)) inFlight.delete(k);
    },
    size: () => lru.size,
  };
}

/** Keys sorted at every level: the same input gives the same key. */
export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

/** Everything kept for one site and account starts with this. */
export const accountPrefix = (site: string, account: string | null): string =>
  `${site}|${account ?? ""}|`;

export const callKey = (
  site: string,
  account: string | null,
  route: string,
  input: unknown,
): string => `${accountPrefix(site, account)}${route}|${stableJson(input ?? null)}`;

/** A kept answer handed out: a copy, so a caller's edit never changes the next hit. */
export const replay = (k: Kept): unknown => {
  if (!k.ok) throw k.error;
  return k.value === undefined ? undefined : structuredClone(k.value);
};
