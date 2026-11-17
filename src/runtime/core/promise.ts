// Copied from wren packages/runtime/src/pg/promise.ts at dc80ecd28; parameter properties made plain fields (erasableSyntaxOnly), nothing else: edit there, then copy (designs/2026-11-16-local-runner.md).
/**
 * Durable promises: Restate's `RestatePromise` shape (thenable + `orTimeout` + `map`) over journal
 * entries. Not a `Promise` subclass, as in the SDK. `then` tells the turn the handler waits on it:
 * that is how a turn knows it is blocked and can suspend.
 */
import type { Duration } from "@restatedev/restate-sdk";

export type Variant = "all" | "race" | "any" | "allSettled";

export interface Host {
  awaited(d: Durable<unknown>): void;
  progressed(): void;
  timeout<T>(p: Durable<T>, d: Duration | number): Durable<T>;
  combine(variant: Variant, children: Durable<unknown>[]): Durable<unknown>;
}

export abstract class Durable<T> implements PromiseLike<T> {
  readonly [Symbol.toStringTag] = "DurablePromise";
  settled = false;
  readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  protected abstract promise(): Promise<T>;

  // biome-ignore lint/suspicious/noThenProperty: a thenable by design, as Restate's promises
  then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.host.awaited(this);
    return this.promise().then(onfulfilled, onrejected);
  }
  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, onrejected);
  }
  finally(onfinally?: (() => void) | null): Promise<T> {
    this.host.awaited(this);
    return this.promise().finally(onfinally);
  }
  orTimeout(d: Duration | number): Durable<T> {
    return this.host.timeout(this, d);
  }
  map<U>(mapper: (value?: T, failure?: unknown) => U): Durable<U> {
    return new Mapped(this.host, this, mapper);
  }
}

/** One journal entry's result. `remote` = settles only from outside the turn (child, awakeable,
 *  a timer past the local wait); the turn can suspend on it. */
export class Leaf<T> extends Durable<T> {
  private p = deferred<T>();
  remote = false;
  wakeAt: number | undefined;
  invocationId: Promise<string> | undefined;
  readonly seq: number;
  readonly kind: string;
  constructor(host: Host, seq: number, kind: string) {
    super(host);
    this.seq = seq;
    this.kind = kind;
    this.p.promise.catch(() => {}); // a rejection nobody awaits is not a crash
  }
  protected promise() {
    return this.p.promise;
  }
  resolve(v: T) {
    if (this.settled) return;
    this.settled = true;
    this.p.resolve(v);
    this.host.progressed();
  }
  reject(e: unknown) {
    if (this.settled) return;
    this.settled = true;
    this.p.reject(e);
    this.host.progressed();
  }
}

/** Never settles: what an op returns once the turn has ended. */
export class Never<T> extends Durable<T> {
  protected promise() {
    return new Promise<T>(() => {});
  }
}

export class Mapped<T, U> extends Durable<U> {
  private memo: Promise<U> | undefined;
  private inner: Durable<T>;
  private mapper: (value?: T, failure?: unknown) => U;
  constructor(host: Host, inner: Durable<T>, mapper: (value?: T, failure?: unknown) => U) {
    super(host);
    this.inner = inner;
    this.mapper = mapper;
  }
  protected promise() {
    this.memo ??= Promise.resolve(this.inner)
      .then(
        (v) => this.mapper(v, undefined),
        (e) => this.mapper(undefined, e),
      )
      .finally(() => {
        this.settled = true;
        this.host.progressed();
      });
    return this.memo;
  }
}

/** A combinator's result; the turn builds the inner promise (it journals the deciding index). */
export class Combined<T> extends Durable<T> {
  private inner: Promise<T>;
  constructor(host: Host, inner: Promise<T>) {
    super(host);
    this.inner = inner;
    inner.then(
      () => this.done(),
      () => this.done(),
    );
  }
  private done() {
    this.settled = true;
    this.host.progressed();
  }
  protected promise() {
    return this.inner;
  }
}

/** Promise.withResolvers without the es2024 lib. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
