/**
 * A scroll and its wait, for explore and flows alike: the browser smooth-scrolls after each
 * wheel event, and a lazy page loads rows after that. Answers what moved and whether the
 * page grew, so a recording knows a scroll that loaded rows from one that only looked.
 */
import type { Locator, Page } from "playwright";

export interface Scrolled {
  /** px the pane moved: down plus, up minus; short of the ask at an edge. null: not measured. */
  moved: number | null;
  /** The pane grew or gained elements: rows loaded on the way (a feed, a lazy list). */
  loaded: boolean;
}

interface Measure {
  top: number;
  height: number;
  nodes: number;
}

/** The pane that scrolls for `el` (itself or its nearest scrolling parent), else the page. */
const MEASURE = `(el) => {
  let pane = document.scrollingElement ?? document.documentElement;
  for (let e = el; e; e = e.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) {
      pane = e;
      break;
    }
  }
  return { top: pane.scrollTop, height: pane.scrollHeight, nodes: document.getElementsByTagName("*").length };
}`;
const measureEl = new Function("el", `return (${MEASURE})(el);`) as (el: unknown) => Measure;

const POLL_MS = 50;
const POLLS = 30;
/** Unmoved this many polls from the start: at an edge, nothing to wait for. */
const EDGE_POLLS = 7;
/** More elements than this after the scroll counts as loaded (a tooltip or two does not). */
const LOADED_NODES = 20;

export async function scrollAndSettle(
  page: Page,
  scroll: () => Promise<void>,
  o: { over?: Locator | undefined; settle?: () => Promise<void> } = {},
): Promise<Scrolled> {
  const measure = (): Promise<Measure | null> =>
    (o.over
      ? o.over.first().evaluate(measureEl)
      : page.evaluate<Measure>(`(${MEASURE})(null)`)
    ).catch(() => null);
  const before = await measure();
  await scroll();
  const start = before?.top ?? 0;
  let last = (await measure())?.top ?? start;
  for (let i = 0, still = 0; i < POLLS && still < 2; i++) {
    await page.waitForTimeout(POLL_MS);
    const now = (await measure())?.top ?? last;
    still = now === last && (now !== start || i >= EDGE_POLLS) ? still + 1 : 0;
    last = now;
  }
  await o.settle?.();
  const after = await measure();
  if (!before || !after) return { moved: null, loaded: false };
  return {
    moved: Math.round(after.top - before.top),
    loaded: after.height > before.height || after.nodes - before.nodes > LOADED_NODES,
  };
}
