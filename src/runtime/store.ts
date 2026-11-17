/**
 * What the runner needs from storage: wren `packages/runtime/src/pg/store.ts`, its verbs and shapes,
 * async so a pg store fits the same seat (designs/2026-11-16-local-runner.md).
 */
import type { RetryPolicy } from "./core/registry.js";
import type { ErrorJson, Invocation, Loaded, Outcome, Writes } from "./core/turn.js";
import { millis } from "./core/turn.js";

export interface Claim {
  id: string;
  attempt: number;
  service: string;
  handler: string;
}

export interface HandlerRow {
  service: string;
  handler: string;
  object: boolean;
  exclusive: boolean;
  private: boolean;
}

/** wren's `Lane`, the part one machine needs. */
export interface Lane {
  only?: readonly string[];
  /** Ids this dispatcher runs now: never claimed again under it. */
  skip?: ReadonlySet<string>;
}

export interface Submit {
  id: string;
  service: string;
  handler: string;
  key: string | null;
  input: Uint8Array;
  headers: Record<string, string>;
  idemKey: string | null;
  runAt: Date;
  callerWaits?: boolean;
}

export type Status = "pending" | "running" | "suspended" | "done" | "paused" | "killed";

export interface Result {
  status: Status;
  result: Uint8Array | null;
  error: ErrorJson | null;
}

export interface Awake {
  id: string;
  invocation: string;
  seq: number;
  value: Uint8Array | null;
  error: ErrorJson | null;
}

export type FinalOutcome = Exclude<Outcome, { type: "fenced" }>;

/** Thrown by `flush` and `renew` when the turn lost its row: wren's `RT001`. */
export class Fenced extends Error {
  readonly fenced = true;
}
export const isFenced = (e: unknown) => (e as { fenced?: boolean })?.fenced === true;

export interface RuntimeStore {
  register(defs: readonly HandlerRow[]): Promise<void>;
  handlers(): Promise<HandlerRow[]>;
  submit(s: Submit): Promise<{ id: string; fresh: boolean }>;
  claim(n: number, leaseMs: number, now: number, lane?: Lane): Promise<Claim[]>;
  /** Soonest future time a row of this lane is due; null: none. */
  nextDue(lane?: Lane): Promise<Date | null>;
  load(id: string, attempt: number): Promise<Loaded | undefined>;
  renew(id: string, attempt: number, leaseMs: number): Promise<void>;
  /** A claim given back unrun, no failure counted. */
  release(id: string, attempt: number, delayMs: number): Promise<boolean>;
  flush(inv: Invocation, w: Writes, leaseMs: number): Promise<void>;
  /** Fenced: a no-op, as wren. */
  finish(
    inv: Invocation,
    w: Writes | null,
    outcome: FinalOutcome,
    policy: RetryPolicy | undefined,
    leaseMs: number,
    now?: number,
  ): Promise<void>;
  result(id: string): Promise<Result | undefined>;
  /** The invocation an idempotency key made. */
  byIdempotencyKey(
    service: string,
    handler: string,
    key: string | null,
    idem: string,
  ): Promise<string | undefined>;
  /** Why an open call is being tried again (its deepest failing call). */
  retrying(id: string): Promise<{ count: number; reason: string } | undefined>;
  resolveAwakeable(a: Awake, now?: number): Promise<void>;
  /** The handler sees a cancel at its next await. */
  cancel(id: string, now?: number): Promise<boolean>;
  /** The row and its open children end with 409; a parent's journal gets it. */
  kill(id: string): Promise<boolean>;
  /** A paused row runs again now. */
  resume(id: string): Promise<boolean>;
  /** Rows not done or killed, of these services. */
  open(services?: readonly string[]): Promise<number>;
  /** Rows running or claimable now; not wren's: the idle stop's count (a row waiting on a person is not work). */
  due(services?: readonly string[], now?: number): Promise<number>;
  /** Wait until a write may have changed `id`'s row, at most `ms`. */
  changed(id: string, ms: number): Promise<void>;
  /** A row may be due now (wren's `rt_wake`); returns the unsubscribe. */
  onWake(f: () => void): () => void;
  /**
   * Become the one dispatcher of `name` (false: a live process holds it), then take back every
   * `running` row of the lane: the process that ran it is gone.
   */
  takeOver(name: string, lane?: Lane): Promise<boolean>;
  close(): Promise<void>;
}

/** Restate's server default, kept: 500 ms × 2 up to 1 min, 70 tries, then pause. */
export const SERVER_RETRY = {
  initialInterval: 500,
  exponentiationFactor: 2,
  maxInterval: 60_000,
  maxAttempts: 70,
  onMaxAttempts: "pause",
} as const;

export function retryDelay(policy: RetryPolicy | undefined, failures: number) {
  const initial = millis(policy?.initialInterval) ?? SERVER_RETRY.initialInterval;
  const factor = policy?.exponentiationFactor ?? SERVER_RETRY.exponentiationFactor;
  const max = millis(policy?.maxInterval) ?? SERVER_RETRY.maxInterval;
  return Math.min(initial * factor ** Math.max(0, failures - 1), max);
}
