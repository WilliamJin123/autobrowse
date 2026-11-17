// Copied from wren packages/runtime/src/pg/turn.ts at dc80ecd28; parameter properties made plain fields (erasableSyntaxOnly), nothing else: edit there, then copy (designs/2026-11-16-local-runner.md).
/**
 * One turn of one invocation: replays the journal through the handler, runs new steps, buffers
 * entries, and ends with one outcome (designs/2026-11-09-own-runtime.md, "Phase 2").
 *
 * Journal rules:
 * - Each op takes the next seq. A journaled entry of another kind or name = non-deterministic → pause.
 * - Buffered entries (get, set, sleep, call, send, awakeable, combinator decisions) flush in order,
 *   with the next run result or with the outcome: the journal is always a prefix of the buffer
 *   plus run results. A run's result flushes before the handler sees it.
 * - Side effects run only in `ctx.run`; at least once, never lost.
 */
import {
  CancelledError,
  type Duration,
  type ObjectContext,
  Opts,
  PauseError,
  RetryableError,
  SendOpts,
  type Serde,
  serde,
  TerminalError,
  TimeoutError,
  type WorkflowContext,
} from "@restatedev/restate-sdk";
import { awakeableId, childId, Rand } from "./ids.js";
import {
  Combined,
  type Durable,
  deferred,
  type Host,
  Leaf,
  Never,
  type Variant,
} from "./promise.js";
import type { Handler } from "./registry.js";

export interface ErrorJson {
  message: string;
  code?: number | undefined;
  metadata?: Record<string, string> | undefined;
  stack?: string | undefined;
}

export interface Row {
  seq: number;
  kind: string;
  name: string;
  done: boolean;
  value: Uint8Array | null;
  error: ErrorJson | null;
  wake_at: Date | null;
  ref: string | null;
  tries: number;
  first_at: Date | null;
}

export interface Invocation {
  id: string;
  service: string;
  handler: string;
  key: string | null;
  input: Uint8Array;
  headers: Record<string, string>;
  attempt: number;
  failures: number;
  cancel: boolean;
  parent_id: string | null;
  parent_seq: number | null;
  caller_waits: boolean;
}

export interface Loaded {
  inv: Invocation;
  journal: Row[];
  state: Map<string, Uint8Array>;
  awakeables: Map<number, { value: Uint8Array | null; error: ErrorJson | null }>;
}

export interface Child {
  id: string;
  service: string;
  handler: string;
  key: string | null;
  input: Uint8Array;
  headers: Record<string, string>;
  parent_id: string;
  parent_seq: number | null;
  run_at: Date;
  idem_key: string | null;
  caller_waits: boolean;
}

/** One flush: written in one fenced transaction. */
export interface Writes {
  journal: Map<number, Row>;
  sets: Map<string, Uint8Array>;
  clears: Set<string>;
  clearAll: boolean;
  children: Child[];
  awakes: {
    id: string;
    invocation: string;
    seq: number;
    value: Uint8Array | null;
    error: ErrorJson | null;
  }[];
  cancels: string[];
  uncancel: boolean;
}

const emptyWrites = (): Writes => ({
  journal: new Map(),
  sets: new Map(),
  clears: new Set(),
  clearAll: false,
  children: [],
  awakes: [],
  cancels: [],
  uncancel: false,
});

const isEmpty = (w: Writes) =>
  w.journal.size === 0 &&
  w.sets.size === 0 &&
  w.clears.size === 0 &&
  !w.clearAll &&
  w.children.length === 0 &&
  w.awakes.length === 0 &&
  w.cancels.length === 0 &&
  !w.uncancel;

export type Outcome =
  | { type: "done"; value: Uint8Array }
  | { type: "done"; error: ErrorJson }
  /** counts toward the retry policy */
  | { type: "failed"; error: ErrorJson; retryAfterMs?: number | undefined }
  /** a capped step waits for its next try; not a failure of the invocation */
  | { type: "later"; delayMs: number; error: ErrorJson }
  | { type: "paused"; error: ErrorJson }
  | { type: "suspended"; wakeAt: number | null }
  | { type: "fenced" };

export interface TurnStore {
  /** Throws an error with `fenced: true` when the turn lost its lease. */
  flush(w: Writes): Promise<void>;
}

export interface TurnOptions {
  /** Longest wait kept inside the turn; longer sleeps suspend. */
  localWaitMs?: number;
  /** Longest delay between a capped step's tries kept inside the turn. */
  localRetryMs?: number;
  /** Test hook: throws at a named point to simulate a crash there. */
  crash?: ((point: string) => void) | undefined;
}

export class Crash extends Error {
  readonly crash = true;
}

export const toErrorJson = (e: unknown): ErrorJson => {
  if (e instanceof TerminalError)
    return {
      message: e.message,
      code: e.code,
      ...(Object.keys(e.metadata ?? {}).length ? { metadata: e.metadata } : {}),
    };
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  return { message: String(e) };
};

const fromErrorJson = (e: ErrorJson): TerminalError => {
  if (e.code === 409 && e.message === "Cancelled") return new CancelledError();
  if (e.code === 408 && e.message === "Timeout occurred") return new TimeoutError();
  return new TerminalError(e.message, {
    errorCode: e.code ?? 500,
    ...(e.metadata ? { metadata: e.metadata } : {}),
  });
};

export const millis = (d: Duration | number | undefined): number | undefined =>
  d === undefined
    ? undefined
    : typeof d === "number"
      ? Math.trunc(d)
      : (d.milliseconds ?? 0) +
        1000 * (d.seconds ?? 0) +
        60_000 * (d.minutes ?? 0) +
        3_600_000 * (d.hours ?? 0) +
        86_400_000 * (d.days ?? 0);

interface RunOptions {
  serde?: Serde<unknown>;
  maxRetryAttempts?: number;
  maxRetryDuration?: Duration | number;
  initialRetryInterval?: Duration | number;
  retryIntervalFactor?: number;
  maxRetryInterval?: Duration | number;
}

interface CallArgs {
  service: string;
  method: string;
  parameter: unknown;
  key?: string | undefined;
  headers?: Record<string, string> | undefined;
  inputSerde?: Serde<unknown> | undefined;
  outputSerde?: Serde<unknown> | undefined;
  idempotencyKey?: string | undefined;
  delay?: Duration | number | undefined;
}

type Descriptors = Record<string, { _inputSerde?: Serde<unknown>; _outputSerde?: Serde<unknown> }>;
type Def = { name: string; _handlers?: Descriptors };

const unpackOpts = (args: unknown[]) => {
  let parameter: unknown;
  let opts: Record<string, unknown> | undefined;
  const last = args[args.length - 1];
  if (last instanceof Opts || last instanceof SendOpts) {
    opts = last.getOpts() as Record<string, unknown>;
    if (args.length === 2) parameter = args[0];
  } else if (args.length > 1)
    throw new TypeError("The second argument must be either Opts or SendOpts");
  else parameter = args[0];
  return { parameter, opts };
};

export class Turn implements Host {
  private seq = 0;
  private journal: Map<number, Row>;
  private buf = emptyWrites();
  private flushing: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private localWork = 0;
  /** Short sleeps waited inside the turn; part of localWork. */
  private localSleeps = new Set<Leaf<unknown>>();
  private waiting = new Set<Durable<unknown>>();
  private remote = new Set<Leaf<unknown>>();
  private progress = 0;
  private checkQueued = false;
  private closed = false;
  private end = deferred<Outcome>();
  private state: Map<string, Uint8Array>;
  private cancelPending: boolean;
  private readonly defaultSerde: Serde<unknown>;
  private readonly localWaitMs: number;
  private readonly localRetryMs: number;
  readonly ctx: Record<string | symbol, unknown>;
  private loaded: Loaded;
  private handler: Handler;
  private store: TurnStore;
  private opts: TurnOptions;

  constructor(loaded: Loaded, handler: Handler, store: TurnStore, opts: TurnOptions = {}) {
    this.loaded = loaded;
    this.handler = handler;
    this.store = store;
    this.opts = opts;
    this.journal = new Map(loaded.journal.map((r) => [r.seq, r]));
    this.state = new Map(loaded.state);
    this.cancelPending = loaded.inv.cancel;
    this.defaultSerde = handler.serde ?? (serde.json as Serde<unknown>);
    this.localWaitMs = opts.localWaitMs ?? 1000;
    this.localRetryMs = opts.localRetryMs ?? 2000;
    this.ctx = this.buildContext();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  execute(): Promise<Outcome> {
    this.handler.wrapper.invoke(this.ctx, this.loaded.inv.input).then(
      (value) => this.finish({ type: "done", value }),
      (e: unknown) => this.finish(this.classify(e)),
    );
    return this.end.promise;
  }

  /** Writes not yet flushed, for the outcome transaction; none after a failed flush. */
  leftover(): Writes | null {
    return this.poisoned ? null : this.buf;
  }

  /** Resolves once no flush is in flight. */
  idle(): Promise<unknown> {
    return this.flushing;
  }

  finish(o: Outcome) {
    if (this.closed) return;
    this.closed = true;
    this.end.resolve(o);
  }

  private classify(e: unknown): Outcome {
    if (e instanceof Crash) return { type: "fenced" };
    if (e instanceof TerminalError) return { type: "done", error: toErrorJson(e) };
    if (e instanceof PauseError) return { type: "paused", error: toErrorJson(e) };
    if (e instanceof RetryableError)
      return { type: "failed", error: toErrorJson(e), retryAfterMs: millis(e.retryAfter) };
    return { type: "failed", error: toErrorJson(e) };
  }

  private crash(point: string) {
    if (!this.opts.crash) return;
    try {
      this.opts.crash(point);
    } catch (e) {
      this.finish({ type: "fenced" });
      throw e instanceof Crash ? e : new Crash(String(e));
    }
  }

  // ── journal ───────────────────────────────────────────────────────────────────────────────

  /** Next seq, and its journaled row if any; undefined once the turn has ended. */
  private op(kind: string, name: string): { seq: number; row: Row | undefined } | undefined {
    if (this.closed) return undefined;
    const seq = this.seq++;
    this.progressed();
    const row = this.journal.get(seq);
    if (row && (row.kind !== kind || row.name !== name)) {
      this.finish({
        type: "paused",
        error: {
          message: `non-deterministic replay at seq ${seq}: journal has ${row.kind} "${row.name}", handler asked for ${kind} "${name}"`,
          code: 570,
        },
      });
      return undefined;
    }
    return { seq, row };
  }

  private put(r: Partial<Row> & { seq: number; kind: string; name: string }) {
    const row: Row = {
      done: false,
      value: null,
      error: null,
      wake_at: null,
      ref: null,
      tries: 0,
      first_at: null,
      ...r,
    };
    this.buf.journal.set(row.seq, row);
  }

  /** Flush the buffer; false when the turn ended (fenced, crashed, or a write failed). */
  private flush(): Promise<boolean> {
    const next = this.flushing.then(async () => {
      if (this.closed) return false;
      if (isEmpty(this.buf)) return true;
      const w = this.buf;
      this.buf = emptyWrites();
      try {
        await this.store.flush(w);
        return !this.closed;
      } catch (e) {
        this.poisoned = true;
        if ((e as { fenced?: boolean }).fenced) this.finish({ type: "fenced" });
        else this.finish({ type: "failed", error: toErrorJson(e) });
        return false;
      }
    });
    this.flushing = next.catch(() => {});
    return next;
  }

  private settleFrom<T>(leaf: Leaf<T>, row: Row, s: Serde<unknown>) {
    if (row.error) leaf.reject(fromErrorJson(row.error));
    else leaf.resolve((row.value ? s.deserialize(row.value) : undefined) as T);
  }

  private never<T>(): Durable<T> {
    return new Never<T>(this);
  }

  // ── suspension ─────────────────────────────────────────────────────────────────────────────

  awaited(d: Durable<unknown>) {
    if (this.closed || d.settled) return;
    this.waiting.add(d);
    this.queueCheck();
  }

  progressed() {
    this.progress++;
  }

  /** Two event-loop turns with no new op or settle, nothing running locally, and the handler
   *  waits on an unsettled durable promise: it is blocked on the outside. */
  private queueCheck() {
    if (this.checkQueued || this.closed) return;
    this.checkQueued = true;
    const mark = this.progress;
    setImmediate(() =>
      setImmediate(() => {
        this.checkQueued = false;
        if (this.progress !== mark) return this.queueCheck();
        this.check();
      }),
    );
  }

  private check() {
    if (this.closed) return;
    for (const d of this.waiting) if (d.settled) this.waiting.delete(d);
    if (this.waiting.size === 0) return;
    const blocked = [...this.remote].filter((l) => !l.settled);
    if (this.localWork > 0) {
      // only short sleeps hold it and an outside result is pending (a call under orTimeout): suspend,
      // so that result wakes it; a live turn never sees a child's end
      const sleepsOnly = this.localWork === this.localSleeps.size;
      if (!sleepsOnly || blocked.length === 0) {
        // a run holds it: calls, cancels and wakes go out now, as on Restate
        const b = this.buf;
        if (b.children.length || b.awakes.length || b.cancels.length) void this.flush();
        return;
      }
      blocked.push(...this.localSleeps);
    }
    if (this.cancelPending && blocked.length) return this.deliverCancel(blocked);
    let wakeAt: number | null = null;
    for (const l of blocked)
      if (l.wakeAt !== undefined && (wakeAt === null || l.wakeAt < wakeAt)) wakeAt = l.wakeAt;
    this.finish({ type: "suspended", wakeAt });
  }

  /** Cancel reaches the promises the handler is blocked on, once; children are cancelled too. */
  private deliverCancel(blocked: Leaf<unknown>[]) {
    this.cancelPending = false;
    this.buf.uncancel = true;
    const err = toErrorJson(new CancelledError());
    for (const l of blocked) {
      const row = this.journal.get(l.seq) ?? this.buf.journal.get(l.seq);
      this.put({
        ...(row ?? {}),
        seq: l.seq,
        kind: l.kind,
        name: row?.name ?? "",
        done: true,
        error: err,
      });
      if (l.kind === "call" && row?.ref) this.buf.cancels.push(row.ref);
      l.reject(new CancelledError());
    }
  }

  // ── combinators ────────────────────────────────────────────────────────────────────────────

  combine(variant: Variant, children: Durable<unknown>[]): Durable<unknown> {
    const o = this.op("combine", variant);
    if (!o) return this.never();
    const { seq, row } = o;
    const decided = row?.value
      ? (JSON.parse(Buffer.from(row.value).toString()) as number)
      : undefined;
    let recorded = false;
    const record = (i: number) => {
      if (row || recorded) return;
      recorded = true;
      this.put({
        seq,
        kind: "combine",
        name: variant,
        done: true,
        value: Buffer.from(JSON.stringify(i)),
      });
    };
    const settled = children.map((c) =>
      Promise.resolve(c).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    let inner: Promise<unknown>;
    if (variant === "allSettled") {
      inner = Promise.all(settled).then((rs) => {
        record(-1);
        return rs.map((r) =>
          r.ok ? { status: "fulfilled", value: r.value } : { status: "rejected", reason: r.error },
        );
      });
    } else if (decided !== undefined) {
      // replay: the journaled decision, not arrival order, picks the result
      if (decided >= 0) {
        inner = (settled[decided] as (typeof settled)[number]).then((r) => {
          if (!r.ok) throw r.error;
          return r.value;
        });
      } else if (variant === "all") inner = Promise.all(children);
      else if (variant === "any")
        inner = Promise.all(settled).then((rs) => {
          throw new AggregateError(rs.map((r) => (r.ok ? undefined : r.error)));
        });
      else inner = new Promise(() => {});
    } else {
      inner = new Promise((resolve, reject) => {
        let left = children.length;
        const errors: unknown[] = [];
        if (left === 0) {
          record(-1);
          return variant === "any"
            ? reject(new AggregateError([]))
            : resolve(variant === "all" ? [] : undefined);
        }
        settled.forEach((p, i) => {
          p.then((r) => {
            left--;
            if (variant === "race") {
              record(i);
              return r.ok ? resolve(r.value) : reject(r.error);
            }
            if (variant === "all") {
              if (!r.ok) {
                record(i);
                return reject(r.error);
              }
              if (left === 0) {
                record(-1);
                Promise.all(children).then(resolve, reject);
              }
              return;
            }
            // any
            if (r.ok) {
              record(i);
              return resolve(r.value);
            }
            errors[i] = r.error;
            if (left === 0) {
              record(-1);
              reject(new AggregateError(errors));
            }
          });
        });
      });
    }
    // first settle wins; later settles of other children are ignored by the Promise
    inner.catch(() => {});
    return new Combined(this, inner);
  }

  timeout<T>(p: Durable<T>, d: Duration | number): Durable<T> {
    const sleep = this.sleep(d).map(() => {
      throw new TimeoutError();
    });
    return this.combine("race", [p, sleep as Durable<unknown>]) as Durable<T>;
  }

  // ── ops ────────────────────────────────────────────────────────────────────────────────────

  run<T>(
    nameOrAction: string | (() => T | Promise<T>),
    action?: unknown,
    options?: RunOptions,
  ): Durable<T> {
    const name = typeof nameOrAction === "string" ? nameOrAction : "";
    const fn = (typeof nameOrAction === "function" ? nameOrAction : action) as () => T | Promise<T>;
    const opts = (typeof nameOrAction === "function" ? action : options) as RunOptions | undefined;
    const s = opts?.serde ?? this.defaultSerde;
    const o = this.op("run", name);
    if (!o) return this.never();
    const leaf = new Leaf<T>(this, o.seq, "run");
    if (o.row?.done) {
      this.settleFrom(leaf, o.row, s);
      return leaf;
    }
    this.localWork++;
    void this.execRun(leaf, name, fn, s, opts, o.row)
      .catch((e: unknown) => {
        // Crash already ended the turn; anything else (a serde throw) fails the attempt
        if (!(e instanceof Crash)) this.finish({ type: "failed", error: toErrorJson(e) });
      })
      .finally(() => {
        this.localWork--;
        this.queueCheck();
      });
    return leaf;
  }

  private needsPreflush() {
    if (!this.handler.object || this.handler.exclusive) return false;
    for (const r of this.buf.journal.values())
      if (r.kind === "get" || r.kind === "keys") return true;
    return false;
  }

  private async execRun<T>(
    leaf: Leaf<T>,
    name: string,
    fn: () => T | Promise<T>,
    s: Serde<unknown>,
    opts: RunOptions | undefined,
    row: Row | undefined,
  ) {
    const seq = leaf.seq;
    let tries = row?.tries ?? 0;
    const firstAt = row?.first_at?.getTime() ?? Date.now();
    if (this.needsPreflush() && !(await this.flush())) return;
    const capped =
      opts !== undefined &&
      (opts.maxRetryAttempts !== undefined ||
        opts.maxRetryDuration !== undefined ||
        opts.initialRetryInterval !== undefined ||
        opts.retryIntervalFactor !== undefined ||
        opts.maxRetryInterval !== undefined);
    for (;;) {
      if (this.closed) return;
      this.crash(`run:${name}:before`);
      let res: T | undefined;
      let err: unknown;
      let failed = false;
      try {
        res = await fn();
      } catch (e) {
        err = e;
        failed = true;
      }
      if (this.closed) return;
      this.crash(`run:${name}:after-effect`);
      if (!failed) {
        const bytes = s.serialize(res);
        this.put({ seq, kind: "run", name, done: true, value: bytes });
        if (!(await this.flush())) return;
        this.crash(`run:${name}:after-journal`);
        leaf.resolve(s.deserialize(bytes) as T);
        return;
      }
      if (err instanceof TerminalError) {
        this.put({ seq, kind: "run", name, done: true, error: toErrorJson(err) });
        if (!(await this.flush())) return;
        leaf.reject(fromErrorJson(toErrorJson(err)));
        return;
      }
      if (err instanceof PauseError)
        return this.finish({ type: "paused", error: toErrorJson(err) });
      const retryAfter = err instanceof RetryableError ? millis(err.retryAfter) : undefined;
      if (!capped)
        return this.finish({ type: "failed", error: toErrorJson(err), retryAfterMs: retryAfter });
      tries++;
      const maxD = millis(opts?.maxRetryDuration);
      if (
        (opts?.maxRetryAttempts !== undefined && tries >= opts.maxRetryAttempts) ||
        (maxD !== undefined && Date.now() - firstAt >= maxD)
      ) {
        const t = { message: (err as Error)?.message ?? String(err), code: 500 };
        this.put({ seq, kind: "run", name, done: true, error: t, tries });
        if (!(await this.flush())) return;
        leaf.reject(fromErrorJson(t));
        return;
      }
      const initial = millis(opts?.initialRetryInterval) ?? 50;
      const factor = opts?.retryIntervalFactor ?? 2;
      const maxI = millis(opts?.maxRetryInterval) ?? 10_000;
      const delay = retryAfter ?? Math.min(initial * factor ** (tries - 1), maxI);
      if (delay <= this.localRetryMs) {
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      this.put({ seq, kind: "run", name, tries, first_at: new Date(firstAt) });
      return this.finish({ type: "later", delayMs: delay, error: toErrorJson(err) });
    }
  }

  sleep(duration: Duration | number, name = ""): Durable<void> {
    const ms = millis(duration) ?? 0;
    const o = this.op("sleep", name);
    if (!o) return this.never();
    const leaf = new Leaf<void>(this, o.seq, "sleep");
    if (o.row?.done) {
      this.settleFrom(leaf, o.row, this.defaultSerde);
      return leaf;
    }
    const wakeAt = o.row?.wake_at?.getTime() ?? Date.now() + ms;
    if (!o.row) this.put({ seq: o.seq, kind: "sleep", name, wake_at: new Date(wakeAt) });
    const left = wakeAt - Date.now();
    if (left <= 0) leaf.resolve(undefined);
    else if (left <= this.localWaitMs) {
      this.localWork++;
      leaf.wakeAt = wakeAt;
      this.localSleeps.add(leaf as Leaf<unknown>);
      setTimeout(() => {
        this.localWork--;
        this.localSleeps.delete(leaf as Leaf<unknown>);
        leaf.resolve(undefined);
        this.queueCheck();
      }, left).unref();
    } else {
      leaf.remote = true;
      leaf.wakeAt = wakeAt;
      this.remote.add(leaf as Leaf<unknown>);
    }
    return leaf;
  }

  genericCall<T>(c: CallArgs): Durable<T> & { invocationId: Promise<string> } {
    const name = `${c.service}/${c.method}`;
    const o = this.op("call", name);
    if (!o) return Object.assign(this.never<T>(), { invocationId: new Promise<string>(() => {}) });
    const leaf = new Leaf<T>(this, o.seq, "call");
    const out = c.outputSerde ?? serde.binary;
    let id: string;
    if (o.row) {
      id = o.row.ref as string;
      if (o.row.done) this.settleFrom(leaf, o.row, out);
    } else {
      id = childId(this.loaded.inv.id, o.seq);
      this.put({ seq: o.seq, kind: "call", name, ref: id });
      this.buf.children.push(this.child(id, c, o.seq, 0));
    }
    if (!leaf.settled) {
      leaf.remote = true;
      this.remote.add(leaf as Leaf<unknown>);
    }
    leaf.invocationId = Promise.resolve(id);
    return leaf as Leaf<T> & { invocationId: Promise<string> };
  }

  genericSend(c: CallArgs): { invocationId: Promise<string> } {
    const name = `${c.service}/${c.method}`;
    const o = this.op("send", name);
    if (!o) return { invocationId: new Promise<string>(() => {}) };
    const id = o.row?.ref ?? childId(this.loaded.inv.id, o.seq);
    if (!o.row) {
      this.put({ seq: o.seq, kind: "send", name, ref: id, done: true });
      this.buf.children.push(this.child(id, c, null, millis(c.delay) ?? 0));
    }
    return { invocationId: Promise.resolve(id) };
  }

  private child(id: string, c: CallArgs, parentSeq: number | null, delayMs: number): Child {
    return {
      id,
      service: c.service,
      handler: c.method,
      key: c.key ?? null,
      input: (c.inputSerde ?? serde.binary).serialize(c.parameter),
      headers: c.headers ?? {},
      parent_id: this.loaded.inv.id,
      parent_seq: parentSeq,
      run_at: new Date(Date.now() + Math.max(0, delayMs)),
      idem_key: c.idempotencyKey ?? null,
      // a call inherits; a send or a delayed call has no one waiting
      caller_waits: parentSeq !== null && delayMs <= 0 && this.loaded.inv.caller_waits,
    };
  }

  awakeable<T>(s?: Serde<T>): { id: string; promise: Durable<T> } {
    const o = this.op("awakeable", "");
    if (!o) return { id: "", promise: this.never() };
    const id = awakeableId(this.loaded.inv.id, o.seq);
    const leaf = new Leaf<T>(this, o.seq, "awakeable");
    const got = this.loaded.awakeables.get(o.seq);
    if (o.row?.done) this.settleFrom(leaf, o.row, s ?? this.defaultSerde);
    else if (got) this.settleFrom(leaf, { ...(o.row as Row), ...got }, s ?? this.defaultSerde);
    else {
      leaf.remote = true;
      this.remote.add(leaf as Leaf<unknown>);
    }
    if (!o.row) this.put({ seq: o.seq, kind: "awakeable", name: "" });
    return { id, promise: leaf };
  }

  private settleAwakeable(
    id: string,
    value: Uint8Array | null,
    error: ErrorJson | null,
    kind: string,
  ) {
    const o = this.op(kind, "");
    if (!o || o.row) return;
    this.put({ seq: o.seq, kind, name: "", done: true });
    const m = /^awk\.(inv_[0-9a-z]+)\.(\d+)$/.exec(id);
    if (!m) throw new TerminalError(`not an awakeable id: ${id}`, { errorCode: 400 });
    this.buf.awakes.push({ id, invocation: m[1] as string, seq: Number(m[2]), value, error });
  }

  /** Wait on any invocation's outcome; `finish` of the target settles it (store.ts). */
  attach<T>(target: string, s?: Serde<T>): Durable<T> {
    const o = this.op("attach", "");
    if (!o) return this.never();
    const leaf = new Leaf<T>(this, o.seq, "attach");
    if (o.row?.done) this.settleFrom(leaf, o.row, s ?? this.defaultSerde);
    else {
      leaf.remote = true;
      this.remote.add(leaf as Leaf<unknown>);
    }
    if (!o.row) this.put({ seq: o.seq, kind: "attach", name: "", ref: target });
    return leaf;
  }

  cancel(invocationId: string) {
    const o = this.op("cancel", "");
    if (!o || o.row) return;
    this.put({ seq: o.seq, kind: "cancel", name: "", done: true, ref: invocationId });
    this.buf.cancels.push(invocationId);
  }

  // ── state ──────────────────────────────────────────────────────────────────────────────────

  private get key(): string {
    if (this.loaded.inv.key === null)
      throw new TerminalError("this handler type doesn't support key()");
    return this.loaded.inv.key;
  }

  private getState<T>(name: string, s?: Serde<T>): Durable<T | null> {
    const o = this.op("get", name);
    if (!o) return this.never();
    let bytes: Uint8Array | null;
    if (o.row) bytes = o.row.value;
    else {
      bytes = this.state.get(name) ?? null;
      this.put({ seq: o.seq, kind: "get", name, done: true, value: bytes });
    }
    const leaf = new Leaf<T | null>(this, o.seq, "get");
    leaf.resolve(bytes === null ? null : ((s ?? this.defaultSerde).deserialize(bytes) as T));
    return leaf;
  }

  private stateKeys(): Durable<string[]> {
    const o = this.op("keys", "");
    if (!o) return this.never();
    let keys: string[];
    if (o.row?.value) keys = JSON.parse(Buffer.from(o.row.value).toString()) as string[];
    else {
      keys = [...this.state.keys()].sort();
      this.put({
        seq: o.seq,
        kind: "keys",
        name: "",
        done: true,
        value: Buffer.from(JSON.stringify(keys)),
      });
    }
    const leaf = new Leaf<string[]>(this, o.seq, "keys");
    leaf.resolve(keys);
    return leaf;
  }

  private setState(name: string, value: unknown, s?: Serde<unknown>) {
    const o = this.op("set", name);
    if (!o) return;
    const bytes = (s ?? this.defaultSerde).serialize(value);
    this.state.set(name, bytes);
    if (o.row) return;
    this.put({ seq: o.seq, kind: "set", name, done: true });
    this.buf.sets.set(name, bytes);
    this.buf.clears.delete(name);
  }

  private clearState(name: string) {
    const o = this.op("clear", name);
    if (!o) return;
    this.state.delete(name);
    if (o.row) return;
    this.put({ seq: o.seq, kind: "clear", name, done: true });
    this.buf.sets.delete(name);
    this.buf.clears.add(name);
  }

  private clearAll() {
    const o = this.op("clearAll", "");
    if (!o) return;
    this.state.clear();
    if (o.row) return;
    this.put({ seq: o.seq, kind: "clearAll", name: "", done: true });
    this.buf.sets.clear();
    this.buf.clears.clear();
    this.buf.clearAll = true;
  }

  // ── the Context object handlers see ────────────────────────────────────────────────────────

  private proxy(
    def: Def,
    key: string | undefined,
    send: boolean,
    sendDefaults?: Record<string, unknown>,
  ) {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== "string" || prop === "then") return undefined;
          return (...args: unknown[]) => {
            const { parameter, opts } = unpackOpts(args);
            const o = { ...(sendDefaults ?? {}), ...(opts ?? {}) } as Record<string, unknown>;
            const d = def._handlers?.[prop];
            const call: CallArgs = {
              service: def.name,
              method: prop,
              parameter,
              key,
              headers: o.headers as Record<string, string> | undefined,
              inputSerde: (o.input as Serde<unknown>) ?? d?._inputSerde ?? this.defaultSerde,
              outputSerde: (o.output as Serde<unknown>) ?? d?._outputSerde ?? this.defaultSerde,
              idempotencyKey: o.idempotencyKey as string | undefined,
              delay: o.delay as Duration | number | undefined,
            };
            return send ? this.genericSend(call) : this.genericCall(call);
          };
        },
      },
    );
  }

  /** Every key of the SDK's contexts, or tsc fails: an SDK upgrade can't add a method pg lacks. */
  private buildContext(): Record<keyof ObjectContext | keyof WorkflowContext, unknown> &
    Record<string, unknown> {
    const inv = this.loaded.inv;
    const rand = new Rand(inv.id);
    const turn = this;
    const unsupported = (what: string) => () => {
      throw new TerminalError(`${what} is not supported by the Postgres runtime`, {
        errorCode: 501,
      });
    };
    return {
      defaultSerde: this.defaultSerde,
      get key() {
        return turn.key;
      },
      rand,
      console: globalThis.console,
      date: {
        now: () => this.run(() => Date.now()),
        toJSON: () => this.run(() => new Date().toJSON()),
      },
      request: () => ({
        id: inv.id,
        headers: new Map(Object.entries(inv.headers)),
        attemptHeaders: new Map<string, string>(),
        body: inv.input,
        extraArgs: [],
        attemptCompletedSignal: new AbortController().signal,
      }),
      run: (a: never, b?: unknown, c?: RunOptions) => this.run(a, b, c),
      sleep: (d: Duration | number, name?: string) => this.sleep(d, name),
      awakeable: <T>(s?: Serde<T>) => this.awakeable(s),
      resolveAwakeable: <T>(id: string, payload?: T, s?: Serde<T>) =>
        this.settleAwakeable(
          id,
          ((s ?? this.defaultSerde) as Serde<T | undefined>).serialize(payload),
          null,
          "resolve",
        ),
      rejectAwakeable: (id: string, reason: string | TerminalError) =>
        this.settleAwakeable(
          id,
          null,
          typeof reason === "string" ? { message: reason, code: 500 } : toErrorJson(reason),
          "reject",
        ),
      get: <T>(name: string, s?: Serde<T>) => this.getState(name, s),
      stateKeys: () => this.stateKeys(),
      set: <T>(name: string, value: T, s?: Serde<T>) =>
        this.setState(name, value, s as Serde<unknown>),
      clear: (name: string) => this.clearState(name),
      clearAll: () => this.clearAll(),
      serviceClient: (def: Def) => this.proxy(def, undefined, false),
      objectClient: (def: Def, key: string) => this.proxy(def, key, false),
      serviceSendClient: (def: Def, opts?: Record<string, unknown>) =>
        this.proxy(def, undefined, true, opts),
      objectSendClient: (def: Def, key: string, opts?: Record<string, unknown>) =>
        this.proxy(def, key, true, opts),
      workflowClient: unsupported("workflowClient"),
      workflowSendClient: unsupported("workflowSendClient"),
      genericCall: <T>(c: CallArgs) => this.genericCall<T>(c),
      genericSend: (c: CallArgs) => this.genericSend(c),
      cancel: (id: string) => this.cancel(id),
      attach: <T>(id: string, s?: Serde<T>) => this.attach(id, s),
      invocation: (id: string) => ({
        cancel: () => this.cancel(id),
        attach: <T>(s?: Serde<T>) => this.attach(id, s),
      }),
      // SDK 1.17 descriptor clients, scopes and named signals: no wren service uses them
      client: unsupported("client(descriptor)"),
      sendClient: unsupported("sendClient(descriptor)"),
      scope: unsupported("scope()"),
      signal: unsupported("signal()"),
      promise: unsupported("workflow promises"),
      cancellation: unsupported("cancellation()"),
    };
  }
}
