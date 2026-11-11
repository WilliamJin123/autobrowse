import type { BrowserContext, Dialog, Page } from "playwright";

/**
 * Native dialogs (OpenCLI audit U7). Before: Playwright dismissed each one unseen, so a
 * `confirm` said no and nobody knew. Now: leave-page and alert say yes, confirm and prompt
 * say no unless `answerNext` set the answer; each one is logged.
 */
export interface DialogSeen {
  at: string;
  type: string;
  message: string;
  url: string;
  /** true: accepted; false: dismissed; null: a flow's own listener answered it. */
  answered: boolean | null;
  /** The text typed into a prompt. */
  text?: string;
}

export interface DialogAnswer {
  accept: boolean;
  /** A prompt's text. */
  text?: string;
}

export interface Dialogs {
  /** Every dialog, oldest first (last 100). */
  log: DialogSeen[];
  /** The answer for the next confirm or prompt only. */
  answerNext(a: DialogAnswer | null): void;
  /** Dialogs after the first `n` (for a reply: what this act opened). */
  since(n: number): DialogSeen[];
  /** Count so far, including those cut from `log`. */
  count(): number;
}

const KEEP = 100;
const MESSAGE = 500;
const byContext = new WeakMap<BrowserContext, Dialogs>();

/** The default answer: say yes to what only informs or leaves, no to what asks. */
export function defaultAnswer(type: string): boolean {
  return type === "beforeunload" || type === "alert";
}

/**
 * Watch `target`: a whole context (our own browser), or one page (a tab of ours in the
 * person's browser, whose other tabs stay theirs). A page with a flow's own `dialog`
 * listener is the flow's to answer: logged only.
 */
export function watchDialogs(target: BrowserContext | Page): Dialogs {
  const context = "context" in target ? target.context() : target;
  const had = byContext.get(context);
  if (had) return had;
  const log: DialogSeen[] = [];
  let total = 0;
  let next: DialogAnswer | null = null;
  const own = "context" in target ? 1 : 0; // our listener on the page itself
  const seen = async (d: Dialog) => {
    const page = d.page();
    const type = d.type();
    const theirs = page
      ? (page as unknown as { listenerCount(e: string): number }).listenerCount("dialog") > own
      : false;
    let answered: boolean | null = null;
    let text: string | undefined;
    if (!theirs) {
      const asks = type === "confirm" || type === "prompt";
      const a = asks && next ? next : null;
      if (asks) next = null;
      answered = a ? a.accept : defaultAnswer(type);
      text = answered && type === "prompt" ? (a?.text ?? d.defaultValue()) : undefined;
      await (answered ? d.accept(text) : d.dismiss()).catch(() => undefined);
    }
    total++;
    log.push({
      at: new Date().toISOString(),
      type,
      message: d.message().slice(0, MESSAGE),
      url: page?.url() ?? "",
      answered,
      ...(text !== undefined ? { text } : {}),
    });
    if (log.length > KEEP) log.shift();
  };
  (target as Page).on("dialog", (d) => void seen(d));
  const dialogs: Dialogs = {
    log,
    answerNext: (a) => {
      next = a;
    },
    since: (n) => log.slice(Math.max(0, log.length - (total - n))),
    count: () => total,
  };
  byContext.set(context, dialogs);
  return dialogs;
}

/** The watcher on a page's context, if one is set. */
export function dialogsOf(page: Page): Dialogs | null {
  return byContext.get(page.context()) ?? null;
}
