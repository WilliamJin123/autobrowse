/**
 * Which recorded scrolls a replay needs. An act on a control scrolls to it, so most scrolls are
 * looking around; a scroll stays when a read follows it (the read sees what the scroll showed)
 * or when it loaded rows the next act needs (a feed, a lazy list). Back-to-back scrolls merge
 * into one move. Pure: outline compile and walk build both run it on their own rows.
 */
import type { Action } from "../recorder/types.js";

type ScrollAction = Extract<Action, { kind: "scroll" }>;

/** A read sees the page as the scroll left it. */
const READS = new Set(["read", "records", "code", "keep", "eval", "download"]);
/** Each scrolls its control into view itself. */
const CONTROLS = new Set(["click", "input", "select", "press", "hover", "upload"]);
/** Never an act a scroll prepares. */
const PASS = new Set(["submit", "note"]);
/** A remainder under this after the deepest point is a person's overshoot: not replayed. */
const REMAINDER_MIN = 100;

const sameTarget = (a: ScrollAction, b: ScrollAction) =>
  JSON.stringify(a.target ?? null) === JSON.stringify(b.target ?? null);

/** One run of scrolls as the moves a replay makes: to the deepest point, then back if far. */
export function mergeScrolls(run: readonly ScrollAction[]): ScrollAction[] {
  const last = run.at(-1);
  if (!last) return [];
  let at = 0;
  let deepest = 0;
  for (const s of run) {
    at += s.moved ?? s.dy;
    if (Math.abs(at) > Math.abs(deepest)) deepest = at;
  }
  const loaded = run.some((s) => s.loaded);
  const move = (dy: number, l: boolean): ScrollAction => {
    const { loaded: _, moved: __, ...rest } = last;
    return { ...rest, dy, moved: dy, ...(l ? { loaded: true } : {}) };
  };
  if (!loaded) return at === 0 ? [] : [move(at, false)];
  const back = at - deepest;
  return Math.abs(back) >= REMAINDER_MIN
    ? [move(deepest, true), move(back, false)]
    : [move(deepest, true)];
}

/**
 * `items` with each run of scrolls kept (merged) or dropped by the act after it. `breaks`:
 * kinds that end a run and drop it (a note that starts a new step); notes pass otherwise.
 */
export function keepScrolls<T>(
  items: readonly T[],
  actOf: (t: T) => Action,
  remake: (t: T, a: ScrollAction) => T,
  o: { breaks?: readonly string[] } = {},
): T[] {
  const breaks = new Set(o.breaks ?? []);
  const passes = (k: string) => PASS.has(k) && !breaks.has(k);
  const out: T[] = [];
  for (let i = 0; i < items.length; ) {
    const first = items[i] as T;
    const a = actOf(first);
    if (a.kind !== "scroll") {
      out.push(first);
      i++;
      continue;
    }
    // the run: scrolls of one pane, notes and submits between them carried along
    const run: { item: T; act: ScrollAction }[] = [{ item: first, act: a }];
    const between: T[] = [];
    let j = i + 1;
    for (; j < items.length; j++) {
      const b = actOf(items[j] as T);
      if (b.kind === "scroll" && sameTarget(a, b)) run.push({ item: items[j] as T, act: b });
      else if (passes(b.kind)) between.push(items[j] as T);
      else break;
    }
    const next = j < items.length ? actOf(items[j] as T).kind : "end";
    const moves = mergeScrolls(run.map((r) => r.act));
    const keep = READS.has(next) || (CONTROLS.has(next) && moves.some((m) => m.loaded));
    out.push(...between);
    const tail = run.at(-1)?.item as T;
    if (keep) for (const m of moves) out.push(remake(tail, m));
    i = j;
  }
  return out;
}
