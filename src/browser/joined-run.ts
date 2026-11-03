/**
 * A retried invocation joins the run its last try left going (WA-1023).
 *
 * The desk's link to Restate (cloudflared both ends) drops about every 18 min; each drop kills
 * every stream on it. The handler keeps going (its browser flow does not know), and Restate
 * retries a second later: the replay finds no journal entry for the step and starts it again,
 * a second browser flow and a second cap unit. Here the replay awaits the first one instead,
 * and a replay after it ended takes its result. In memory: a desk restart forgets, and that
 * replay runs the step again as before.
 */
import * as restate from "@restatedev/restate-sdk";

/** How long a finished step's outcome waits for a replay that never came. */
export const KEEP_MS = 60 * 60_000;

interface Entry {
  p: Promise<unknown>;
  /** settle time; null while in flight */
  at: number | null;
}

const runs = new Map<string, Entry>();

/**
 * `fn` once per `key` (`stepKey`) while in flight; after, its value or terminal
 * error for `KEEP_MS`. A retryable error is not kept: Restate's own retry runs `fn` again.
 */
export function joinedRun<T>(key: string, fn: () => Promise<T>, now = Date.now): Promise<T> {
  const t = now();
  for (const [k, e] of runs) if (e.at !== null && t - e.at > KEEP_MS) runs.delete(k);
  const had = runs.get(key);
  if (had) return had.p as Promise<T>;
  const entry: Entry = { p: Promise.resolve(), at: null };
  entry.p = fn().then(
    (v) => {
      entry.at = now();
      return v;
    },
    (err: unknown) => {
      if (err instanceof restate.TerminalError) entry.at = now();
      else runs.delete(key);
      throw err;
    },
  );
  runs.set(key, entry);
  return entry.p as Promise<T>;
}

const seen = new WeakMap<object, Map<string, number>>();

/**
 * The step's key: invocation, name, and how many steps of that name this try ran before (one
 * invocation may run a name twice: a call again after its refused token is re-made). Counted per
 * `ctx`, which each try gets new, so a replay counts the same.
 */
export function stepKey(ctx: object, invocation: string, name: string): string {
  const names = seen.get(ctx) ?? new Map<string, number>();
  seen.set(ctx, names);
  const n = (names.get(name) ?? 0) + 1;
  names.set(name, n);
  return `${invocation} ${name} #${n}`;
}

/** Tests: forget every run. */
export function forgetRuns(): void {
  runs.clear();
}
