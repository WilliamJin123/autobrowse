/** One claimed turn end to end: load, replay, outcome. wren `src/pg/executor.ts` `runTurn`, minus Lambda. */
import { CancelledError } from "@restatedev/restate-sdk";
import type { Registry } from "./core/registry.js";
import { Crash, Turn, type TurnOptions, toErrorJson } from "./core/turn.js";
import { type Claim, isFenced, type RuntimeStore } from "./store.js";

export interface ExecutorOptions extends TurnOptions {
  store: RuntimeStore;
  registry: Registry;
  leaseMs?: number;
  log?: (msg: string, err?: unknown) => void;
  /**
   * Restate's `alwaysReplay`: each attempt ends after its first new `ctx.run` is journaled, and
   * the next attempt replays it. Tests only.
   */
  replay?: boolean;
}

export const DEFAULT_LEASE_MS = 60_000;

/** Ends one replay attempt; never a real crash. */
class ReplayStop extends Crash {}

export async function runTurn(
  o: ExecutorOptions,
  c: Pick<Claim, "id" | "attempt">,
): Promise<string> {
  const leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
  const log = o.log ?? ((m, e) => console.error(`runner: ${m}`, e ?? ""));
  const loaded = await o.store.load(c.id, c.attempt);
  if (!loaded) return "gone";
  const inv = loaded.inv;
  const end = o.store.finish.bind(o.store);
  const h = o.registry.get(inv.service, inv.handler);
  if (!h) {
    const message = `no handler ${inv.service}/${inv.handler} here`;
    await end(inv, null, { type: "failed", error: { message } }, undefined, leaseMs);
    return "failed";
  }
  if (inv.cancel && loaded.journal.length === 0) {
    await end(
      inv,
      null,
      { type: "done", error: toErrorJson(new CancelledError()) },
      h.retry,
      leaseMs,
    );
    return "done";
  }
  let stopped = false;
  const crash =
    o.replay || o.crash
      ? (point: string) => {
          o.crash?.(point);
          if (o.replay && !stopped && point.endsWith(":after-journal")) {
            stopped = true;
            throw new ReplayStop(point);
          }
        }
      : undefined;
  const turn = new Turn(
    loaded,
    h,
    { flush: (w) => o.store.flush(inv, w, leaseMs) },
    { ...o, crash },
  );
  const beat = setInterval(() => {
    o.store.renew(inv.id, inv.attempt, leaseMs).catch((e: unknown) => {
      if (isFenced(e)) turn.finish({ type: "fenced" });
    });
  }, leaseMs / 3);
  beat.unref();
  try {
    const outcome = await turn.execute();
    await turn.idle();
    if (stopped) {
      await o.store.release(inv.id, inv.attempt, 0);
      return "replay";
    }
    if (outcome.type === "fenced") return "fenced";
    try {
      o.crash?.("finish:before");
    } catch {
      return "fenced";
    }
    await end(inv, turn.leftover(), outcome, h.retry, leaseMs);
    return outcome.type;
  } catch (e) {
    if (e instanceof ReplayStop) {
      await o.store.release(inv.id, inv.attempt, 0);
      return "replay";
    }
    if (e instanceof Crash) return "fenced";
    // the lease runs out and a later turn replays it
    log(`turn ${inv.id} #${inv.attempt} ended without an outcome`, e);
    return "lost";
  } finally {
    clearInterval(beat);
  }
}
