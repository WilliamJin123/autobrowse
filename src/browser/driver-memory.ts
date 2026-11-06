/**
 * Keeps a long-lived driver's heap flat (WA-1118, designs/2026-11-05-driver-memory.md).
 * Two things grew it: Playwright keeps each Request, with its Route and Response, until 10,000
 * exist (27 KB each measured, 270 MB a driver), and V8 leaves garbage for a collection it is
 * in no hurry to run (130 MB after ten page opens).
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { BrowserContext } from "playwright";

/** Requests a context keeps; a page load is a few hundred. */
export const KEEP_REQUESTS = 1_000;
/** Heap growth since the last collection that is worth the next one (a collection takes 0.1 to 0.4 s). */
const GROWN_BYTES = 48 * 2 ** 20;

/** Playwright's server side of an in-process connection; private names, read with care. */
interface Dispatchers {
  _dispatchersByBucket: Map<string, Set<string>>;
  _dispatcherByGuid: Map<string, { _dispose(reason: string): void }>;
}

/** Null when the shape is not the one we know (a new Playwright): the bound is off, nothing breaks. */
export function dispatchersOf(context: BrowserContext): Dispatchers | null {
  const conn = (context as unknown as { _connection?: { toImpl?(x: unknown): unknown } })
    ._connection;
  const d = conn?.toImpl?.(conn) as Partial<Dispatchers> | undefined;
  return d?._dispatchersByBucket instanceof Map && d._dispatcherByGuid instanceof Map
    ? (d as Dispatchers)
    : null;
}

/**
 * Drops the oldest Request objects past `keep`, as Playwright does at 10,000 (reason `gc`): a
 * Request takes its Route and Response with it. A late event for a dropped one makes a new object.
 */
export function trimRequests(d: Dispatchers, keep = KEEP_REQUESTS): number {
  const list = d._dispatchersByBucket.get("Request");
  if (!list || list.size <= keep) return 0;
  const old = [...list].slice(0, list.size - keep);
  for (const guid of old) {
    list.delete(guid);
    d._dispatcherByGuid.get(guid)?._dispose("gc");
  }
  return old.length;
}

/** Trims on every 200th request, for the context's life. */
export function boundRequests(context: BrowserContext, keep = KEEP_REQUESTS): void {
  const d = dispatchersOf(context);
  if (!d) return;
  let n = 0;
  context.on("request", () => {
    if (++n % 200 === 0) trimRequests(d, keep);
  });
}

let gc: (() => void) | null | undefined;
/** `gc` with no launch flag: the flag set at run time shows it to a new context. */
function collector(): (() => void) | null {
  if (gc !== undefined) return gc;
  try {
    setFlagsFromString("--expose-gc");
    gc = runInNewContext("gc") as () => void;
  } catch {
    gc = null;
  }
  return gc;
}

let timer: NodeJS.Timeout | null = null;
let floor = 0;

/** Work ended: collect `idleMs` later if no work came and the heap grew. Returns nothing; never throws. */
export function collectWhenIdle(idleMs = 3_000): void {
  holdCollect();
  timer = setTimeout(() => {
    timer = null;
    if (process.memoryUsage().heapUsed - floor < GROWN_BYTES) return;
    collector()?.();
    floor = process.memoryUsage().heapUsed;
  }, idleMs);
  timer.unref();
}

/** Work started: no collection pauses it. */
export function holdCollect(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
