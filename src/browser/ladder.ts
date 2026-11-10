/**
 * A browser read's ways to the same answer, cheapest to the page first: the site's own JSON
 * with the session (`cookie`), the JSON the page fetches as it loads (`intercept`), then the
 * page itself (`ui`). A rung falls to the next only when its way broke (`RungBroke`: a 404, a
 * body that is not JSON, a shape that does not fit). A 429, a block, a cap, a sign-in wall or
 * a captcha throws at once: dropping to clicks after a block looks more like a bot, not less.
 * All rungs run in one flow, so a fall costs no new page lock or pace slot.
 * Design: designs/2026-11-09-opencli-audit.md (WA-1251.2).
 */
import { AccessRefused } from "./session.js";

export const STRATEGIES = ["cookie", "intercept", "ui"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** This rung's way to the data broke; the next rung may still work. */
export class RungBroke extends Error {
  constructor(why: string) {
    super(why);
    this.name = "RungBroke";
  }
}

export interface Rung<O> {
  strategy: Strategy;
  run(): Promise<O>;
}

export interface Fell {
  strategy: Strategy;
  why: string;
}

/** The answer, the rung that gave it, and each rung that fell before it. */
export interface Climbed<O> {
  value: O;
  via: Strategy;
  fell: Fell[];
}

export async function ladder<O>(rungs: readonly Rung<O>[]): Promise<Climbed<O>> {
  const fell: Fell[] = [];
  for (const rung of rungs) {
    try {
      return { value: await rung.run(), via: rung.strategy, fell };
    } catch (e) {
      if (!(e instanceof RungBroke)) throw e;
      fell.push({ strategy: rung.strategy, why: e.message });
    }
  }
  throw new AccessRefused(
    "upstream_broken",
    `every way failed: ${fell.map((f) => `${f.strategy}: ${f.why}`).join("; ")}`,
  );
}
