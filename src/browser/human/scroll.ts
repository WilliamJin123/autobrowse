/**
 * How a hand scrolls. One device per session:
 * - wheel: notches of about one size; a flick is a few quick notches, then a look.
 * - trackpad: a swipe is a short push (deltas rise for a few frames), then momentum
 *   (each frame a share of the last), with a little sideways drift from the finger's angle.
 * Reading adds a small look back up now and then. A long move may carry past and come back.
 * The net move lands within a notch of `dy`, so a caller that needs the exact spot
 * (a control in view) finishes it.
 *
 * Pure like the other plans: a distance in, wheel events with timings out.
 */
import { chance, drawInt, drawLog, drawMs, type Random } from "./draw.js";

export interface ScrollStyle {
  /** Pixels one wheel notch moves. */
  notch: [number, number];
  /** Notches in one flick, and ms between them. */
  flick: [number, number];
  gap: [number, number];
  /** A look between flicks or swipes, ms. */
  look: [number, number];
  /** Past this many px, a reach for a control jumps instead (nobody wheels a mile). */
  most: number;
  /** Odds a session scrolls by trackpad, not wheel; drawn once per hands. */
  trackpad: number;
  /** One swipe's distance, px. */
  swipe: [number, number];
  /** ms between a swipe's events: a trackpad reports about once a frame. */
  frame: [number, number];
  /** Per look while reading: odds of a small look back up of `back` px, then on. */
  backOdds: number;
  back: [number, number];
  /** Odds a move of two screens or more carries past by `over` px and comes back. */
  overOdds: number;
  over: [number, number];
}

export type ScrollDevice = "wheel" | "trackpad";

export interface WheelStep {
  dy: number;
  /** Sideways drift, px: a trackpad finger is never quite straight. */
  dx?: number;
  after: number;
}

export interface ScrollPlanOptions {
  device: ScrollDevice;
  /** A read (a feed, a page): looks back up now and then. A reach for a control does not. */
  reading: boolean;
}

/** Moves of at least this many px may carry past. */
const OVER_FROM = 1_200;
/** Finger frames of a swipe, before momentum. */
const PUSH: [number, number] = [2, 5];
/** Momentum: each frame keeps this share of the last. */
const DECAY: [number, number] = [0.88, 0.94];
/** Momentum ends below this share of the peak; a reader often stops it early with a touch. */
const TAIL = 0.03;
const CATCH_ODDS = 0.3;
const CATCH_AT = 0.2;
/** The finger's angle off vertical, at most, as dx/dy. */
const DRIFT = 0.07;

export function scrollPlan(
  dy: number,
  s: ScrollStyle,
  random: Random,
  o: ScrollPlanOptions,
): WheelStep[] {
  const sign = Math.sign(dy);
  const steps: WheelStep[] = [];
  // One burst toward `px` (signed); answers the px it moved.
  const burst = (px: number): number => {
    const made = o.device === "trackpad" ? swipe(px, s, random) : flick(px, s, random);
    steps.push(...made);
    return made.reduce((n, m) => n + m.dy, 0);
  };
  const look = (ms: [number, number]) => {
    const last = steps.at(-1);
    if (last) last.after += drawMs(ms, random);
  };
  const size = () =>
    o.device === "trackpad" ? drawLog(s.swipe, random) : Number.POSITIVE_INFINITY;

  let left = Math.abs(dy);
  while (left > 0) {
    left -= Math.abs(burst(sign * Math.min(left, Math.round(size()))));
    if (left <= 0) break;
    look(s.look);
    if (o.reading && chance(s.backOdds, random)) {
      // a line reread: up a little, a look, then on (the way back is added to what is left)
      left += Math.abs(burst(-sign * drawInt(s.back, random)));
      look(s.look);
    }
  }
  if (Math.abs(dy) >= OVER_FROM && chance(s.overOdds, random)) {
    let past = Math.abs(burst(sign * drawInt(s.over, random)));
    look([s.look[0] / 2, s.look[1] / 2]);
    while (past > 0) {
      past -= Math.abs(burst(-sign * past));
      if (past > 0) look(s.gap);
    }
  }
  return steps;
}

/** Wheel notches toward `px`: a few quick ones, the last cut to what is left. */
function flick(px: number, s: ScrollStyle, random: Random): WheelStep[] {
  const sign = Math.sign(px);
  let left = Math.abs(px);
  const out: WheelStep[] = [];
  // A flick toward a far target is one flick; the caller loops for the rest.
  const n = drawInt(s.flick, random);
  for (let i = 0; i < n && left > 0; i++) {
    const move = Math.min(left, Math.round(drawLog(s.notch, random)));
    left -= move;
    out.push({ dy: sign * move, after: drawMs(s.gap, random) });
  }
  return out;
}

/**
 * One trackpad swipe of about `px`: rising push frames, then momentum that fades frame by
 * frame. Shares are drawn first, then scaled to `px`; whole pixels, rounding carried on.
 */
function swipe(px: number, s: ScrollStyle, random: Random): WheelStep[] {
  const sign = Math.sign(px);
  const push = drawInt(PUSH, random);
  const decay = DECAY[0] + random() * (DECAY[1] - DECAY[0]);
  const tail = chance(CATCH_ODDS, random) ? CATCH_AT : TAIL;
  const shares: number[] = [];
  for (let i = 1; i <= push; i++) shares.push((i / push) * (0.85 + random() * 0.3));
  for (let v = shares.at(-1) as number; v * decay >= tail; ) {
    v *= decay;
    shares.push(v);
  }
  const total = shares.reduce((n, v) => n + v, 0);
  const drift = (random() * 2 - 1) * DRIFT;
  const out: WheelStep[] = [];
  let carry = 0;
  let carryX = 0;
  let left = Math.abs(px);
  for (const share of shares) {
    const want = (share / total) * Math.abs(px) + carry;
    const move = Math.min(left, Math.round(want));
    carry = want - move;
    const wantX = move * drift + carryX;
    const dx = Math.round(wantX);
    carryX = wantX - dx;
    const after = drawMs(s.frame, random);
    // a frame too small to move a pixel: its time joins the frame before
    if (move === 0) {
      const last = out.at(-1);
      if (last) last.after += after;
      continue;
    }
    left -= move;
    out.push({ dy: sign * move, ...(dx ? { dx } : {}), after });
  }
  // rounding short: the last frame takes the rest
  const last = out.at(-1);
  if (last && left > 0) last.dy += sign * left;
  return out;
}
