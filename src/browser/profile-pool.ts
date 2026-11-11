/**
 * One browser per Chrome profile, shared by reads (OpenCLI audit U15). Reads run side by side,
 * each in its own tab, up to `readers`; a write waits until the profile is idle and runs alone.
 * The queue is bounded: past `queue` waiters a call fails at once with `PoolFull` (429 shape),
 * so a burst never stacks hours of work behind one profile.
 * Order is FIFO: a read never jumps a queued write, so writes do not starve.
 * The first user takes the parked browser (or opens one) and keeps its main page; later reads
 * join with a background tab. The last one out closes stray tabs and parks the browser.
 * Flows and the page renderer share one pool: they share the profile's one browser.
 * Design: designs/2026-11-09-opencli-audit.md (U15).
 */
import type { Page } from "playwright";
import type { SessionPark } from "./park.js";
import type { Session } from "./session.js";

export type PoolMode = "read" | "write";

export const POOL_READERS = 3;
export const POOL_QUEUE = 16;

export class PoolFull extends Error {
  readonly key: string;
  readonly waiting: number;
  constructor(key: string, waiting: number) {
    super(`profile ${key}: ${waiting} calls already wait for its browser; try again later`);
    this.name = "PoolFull";
    this.key = key;
    this.waiting = waiting;
  }
}

interface Waiter {
  mode: PoolMode;
  grant: () => void;
}

interface KeyState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

/** The reader-writer scheduler alone: no browser. */
export class ProfileGate {
  private readonly keys = new Map<string, KeyState>();
  private readonly o: { readers: number; queue: number };
  constructor(o: { readers: number; queue: number }) {
    this.o = o;
  }

  /** Resolves once `key` is ours in `mode`; call the returned function to let go. */
  async acquire(key: string, mode: PoolMode): Promise<() => void> {
    const k = this.keys.get(key) ?? { readers: 0, writer: false, queue: [] };
    this.keys.set(key, k);
    if (!k.queue.length && this.fits(k, mode)) this.take(k, mode);
    else {
      if (k.queue.length >= this.o.queue) throw new PoolFull(key, k.queue.length);
      await new Promise<void>((grant) => k.queue.push({ mode, grant }));
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (mode === "write") k.writer = false;
      else k.readers--;
      this.pump(key, k);
    };
  }

  /** Holders and waiters per busy key. */
  state(key: string): { readers: number; writer: boolean; waiting: number } {
    const k = this.keys.get(key);
    return { readers: k?.readers ?? 0, writer: k?.writer ?? false, waiting: k?.queue.length ?? 0 };
  }

  private fits(k: KeyState, mode: PoolMode): boolean {
    if (k.writer) return false;
    return mode === "write" ? k.readers === 0 : k.readers < this.o.readers;
  }

  private take(k: KeyState, mode: PoolMode): void {
    if (mode === "write") k.writer = true;
    else k.readers++;
  }

  private pump(key: string, k: KeyState): void {
    // FIFO: stop at the first waiter that does not fit.
    while (k.queue.length && this.fits(k, (k.queue[0] as Waiter).mode)) {
      const w = k.queue.shift() as Waiter;
      this.take(k, w.mode);
      w.grant();
    }
    if (!k.readers && !k.writer && !k.queue.length) this.keys.delete(key);
  }
}

/** What a user of the pool gets. */
export interface Lease {
  session: Session;
  /** The first user: owns the main page and the browser's window state. False: a joined read. */
  owner: boolean;
  /** A joined read's own tab; the owner's is `session.page`. */
  page: Page;
  /** The browser came from the park: its page is where the last run left it. */
  reused: boolean;
}

export interface LeaveOptions {
  /** The browser broke, or a person's run used it: close it, never park it. */
  discard?: boolean;
  /** Keep every tab (a run waiting on a person, a person's own browser). */
  keepTabs?: boolean;
}

interface Live {
  session: Session;
  users: number;
  discard: boolean;
  keepTabs: boolean;
}

/** Tabs a joined read opened: a run's `nextPage` skips them, `closeStrayTabs` may close them. */
export const poolTabs = new WeakSet<Page>();

export interface PoolOptions {
  park?: SessionPark | undefined;
  readers?: number;
  queue?: number;
  /** Opens a background tab in the shared browser; tests swap it. */
  newTab?: (s: Session) => Promise<Page>;
  /** The last user's clean-up before the browser parks (stray tabs, routes). */
  tidy?: (s: Session, o: { keepTabs: boolean }) => Promise<void>;
}

export class ProfilePool {
  readonly gate: ProfileGate;
  readonly park: SessionPark | undefined;
  private readonly live = new Map<string, Live>();
  private readonly o: PoolOptions;

  constructor(o: PoolOptions = {}) {
    this.o = o;
    this.park = o.park;
    this.gate = new ProfileGate({
      readers: o.readers ?? POOL_READERS,
      queue: o.queue ?? POOL_QUEUE,
    });
  }

  /**
   * Runs `fn` with the profile's browser. `open` makes one when none is live or parked.
   * `fresh`: a write that must have its own browser (a person's headed window): the parked one closes.
   */
  async use<T>(
    key: string,
    mode: PoolMode,
    open: () => Promise<Session>,
    fn: (lease: Lease, leave: (o: LeaveOptions) => void) => Promise<T>,
    o: { fresh?: boolean } = {},
  ): Promise<T> {
    const release = await this.gate.acquire(key, mode);
    let live = this.live.get(key);
    let lease: Lease;
    try {
      if (live) {
        // Only a read gets here with a live browser: a write waits for an idle profile.
        const page = await (this.o.newTab ?? ((s) => s.context.newPage()))(live.session);
        poolTabs.add(page);
        live.users++;
        lease = { session: live.session, owner: false, page, reused: false };
      } else {
        let parked = (await this.park?.take(key)) ?? null;
        if (o.fresh && parked) {
          await parked.close().catch(() => undefined);
          parked = null;
        }
        const session = parked ?? (await open());
        live = { session, users: 1, discard: false, keepTabs: false };
        this.live.set(key, live);
        lease = { session, owner: true, page: session.page, reused: parked !== null };
      }
    } catch (err) {
      release();
      throw err;
    }
    const mine = live;
    let said: LeaveOptions = {};
    try {
      return await fn(lease, (l) => {
        said = l;
      });
    } finally {
      if (said.discard) mine.discard = true;
      if (said.keepTabs) mine.keepTabs = true;
      if (!lease.owner) await lease.page.close().catch(() => undefined);
      mine.users--;
      if (mine.users === 0) {
        this.live.delete(key);
        await this.settle(key, mine);
      }
      release();
    }
  }

  /** Users of `key`'s live browser now. */
  users(key: string): number {
    return this.live.get(key)?.users ?? 0;
  }

  private async settle(key: string, l: Live): Promise<void> {
    if (l.discard || !this.park) {
      await l.session.close().catch(() => undefined);
      return;
    }
    await this.o.tidy?.(l.session, { keepTabs: l.keepTabs }).catch(() => undefined);
    await this.park.put(key, l.session);
  }
}
