/**
 * What the pages threw that nothing caught (PinchTab audit P3), every tab,
 * newest last. Fed by the recorder's observer (`window` error and
 * unhandledrejection listeners): Patchright keeps CDP Runtime off, so
 * Playwright's `pageerror` and `console` events never fire. console.error is
 * not kept: catching it means patching the page's console, which a page sees.
 */
export interface PageError {
  at: string;
  message: string;
  /** Top frames of the stack, when the error had one. */
  stack?: string;
  url: string;
}

export interface PageErrors {
  log: PageError[];
  push: (e: { message: string; stack?: string }, url: string) => void;
  /** All seen, cut ones too: `since(count())` later reads only what came after. */
  count: () => number;
  since: (n: number) => PageError[];
  clear: () => void;
}

const KEEP = 200;

export function pageErrorLog(now: () => Date = () => new Date()): PageErrors {
  const log: PageError[] = [];
  let total = 0;
  return {
    log,
    push: (e, url) => {
      total++;
      log.push({
        at: now().toISOString(),
        message: e.message,
        ...(e.stack ? { stack: e.stack } : {}),
        url,
      });
      if (log.length > KEEP) log.shift();
    },
    count: () => total,
    since: (n) => log.slice(Math.max(0, log.length - (total - n))),
    clear: () => {
      log.length = 0;
    },
  };
}
