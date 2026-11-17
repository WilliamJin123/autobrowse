/**
 * One loop: claim due invocations, run each turn in this process. wren `src/pg/dispatcher.ts`,
 * minus NOTIFY and lanes by caller: woken in process by the store, else polls.
 */
import { deferred } from "./core/promise.js";
import { type Claim, isFenced, type Lane, type RuntimeStore } from "./store.js";

export interface DispatcherOptions {
  store: RuntimeStore;
  run: (c: Claim) => Promise<unknown>;
  lane?: Lane;
  concurrency?: number;
  leaseMs?: number;
  /** Longest sleep between claims: another process's submit has no wake here. */
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export class Dispatcher {
  /** Turns running now, id → attempt. */
  private readonly active = new Map<string, number>();
  private kicked = false;
  private stopped = false;
  private wakeUp: (() => void) | undefined;
  private unwake: (() => void) | undefined;
  private looping: Promise<void> | undefined;
  private readonly idle = deferred<void>();
  private readonly o: DispatcherOptions;

  constructor(o: DispatcherOptions) {
    this.o = o;
  }

  start() {
    this.unwake = this.o.store.onWake(() => this.kick());
    this.looping = this.loop();
  }

  kick() {
    this.kicked = true;
    this.wakeUp?.();
  }

  async stop() {
    this.stopped = true;
    this.unwake?.();
    this.kick();
    await this.looping;
    if (this.active.size > 0) await this.idle.promise;
  }

  private async loop() {
    const conc = this.o.concurrency ?? 8;
    const leaseMs = this.o.leaseMs ?? 60_000;
    const pollMs = this.o.pollMs ?? 250;
    const log = this.o.log ?? ((m, e) => console.error(`runner: ${m}`, e ?? ""));
    const store = this.o.store;
    while (!this.stopped) {
      this.kicked = false;
      const free = conc - this.active.size;
      let got = 0;
      // a Mac that slept past a lease: ours are renewed before any claim can see them lapsed
      for (const [id, attempt] of [...this.active])
        await store.renew(id, attempt, leaseMs).catch((e: unknown) => {
          if (!isFenced(e)) log(`renew ${id} failed`, e);
        });
      if (free > 0) {
        try {
          const lane = { ...this.o.lane, skip: new Set(this.active.keys()) };
          for (const c of await store.claim(free, leaseMs, Date.now(), lane)) {
            this.active.set(c.id, c.attempt);
            got++;
            this.o
              .run(c)
              .catch((e: unknown) => log(`turn ${c.id} threw`, e))
              .finally(() => {
                if (this.active.get(c.id) === c.attempt) this.active.delete(c.id);
                if (this.active.size === 0 && this.stopped) this.idle.resolve();
                this.kick();
              });
          }
        } catch (e) {
          log("claim failed", e);
        }
      }
      if (this.stopped) break;
      if (got > 0 && got === free) continue;
      if (this.kicked) continue;
      let wait = pollMs;
      try {
        const due = await store.nextDue(this.o.lane);
        if (due) wait = Math.max(0, Math.min(pollMs, due.getTime() - Date.now()));
      } catch {}
      if (this.kicked || this.stopped) continue;
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        this.wakeUp = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wakeUp = undefined;
    }
  }
}
