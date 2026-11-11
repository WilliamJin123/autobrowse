/**
 * Small moves the hand-written flows share. Each was copied between two or three flows
 * before it lived here; a flow passes in what differs (its page's words, its selectors).
 */
import type { Response } from "playwright";
import { markLimited } from "../attempt.js";
import type { FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

/** How long a page gets to render, and how often it is looked at meanwhile. */
export const RENDER_MS = 15_000;
export const SETTLE_MS = 1_000;

/** Which of `hints` shows first within the render time; "missing" when the page says so (`missing`). */
export async function firstShown(
  fp: FlowPage,
  hints: Hints[],
  missing: RegExp,
): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of hints.entries()) if (await fp.has(h)) return n;
    if (missing.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

/** A captcha in `frame` is solved before the click it guards; one a solver cannot pass goes to a person. */
export async function passCaptcha(fp: FlowPage, frame: Hints, what: string): Promise<void> {
  if (!(await fp.has(frame, 2_000))) return;
  const got = await fp.captcha();
  if (!got.solved) fp.human(`${what} is a person's (${got.reason})`);
}

/** Scroll the list `script` finds to its end (it answers whether it moved one); else the page. */
export async function scrollList(fp: FlowPage, script: string): Promise<void> {
  const moved = await fp.page.evaluate<boolean>(script).catch(() => false);
  if (!moved) await fp.scroll(1_500);
}

/** The links the page's HTML holds, as `url` makes them from each match's first group, each once. */
export async function linksOn(
  fp: { html(): Promise<string> },
  href: RegExp,
  url: (path: string) => string,
): Promise<string[]> {
  const html = await fp.html();
  const out: string[] = [];
  for (const m of html.matchAll(href)) {
    const u = url(m[1] ?? "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** The state `on` (true) or `off` (false) shows; null when neither shows. */
export const stateOf =
  (fp: FlowPage, on: Hints, off: Hints, missing: RegExp) => async (): Promise<boolean | null> => {
    const n = await firstShown(fp, [on, off], missing);
    return n === 0 ? true : n === 1 ? false : null;
  };

/** The site's answer to an act's own call: kept, refused, or none seen. */
export type ActAnswer = { kept: true } | { refused: string } | null;

/** A 2xx with no `errors` keeps the act; a 4xx/5xx or an `errors` list refuses it. */
export function actAnswerOf(status: number, body: string): Exclude<ActAnswer, null> {
  if (status >= 400) return { refused: `HTTP ${status}` };
  try {
    const j = JSON.parse(body) as { errors?: Array<{ message?: string }> } | null;
    if (j?.errors?.length)
      return {
        refused: j.errors
          .map((e) => e.message ?? "?")
          .join("; ")
          .slice(0, 200),
      };
  } catch {
    // an empty or non-JSON 2xx: kept
  }
  return { kept: true };
}

/**
 * Click, then prove the act (designs/2026-10-29-cap-tries.md): the page flips its button before
 * the server answers. Proof is the site's answer to the act's own call (`call`, any non-GET);
 * none seen, the page loaded again (`reload.open`) must show the wanted state. A refusal or a lost act marks the
 * account limited (its buckets are held) and goes to a person.
 */
export async function actAndProve(
  fp: FlowPage,
  o: {
    click: () => Promise<unknown>;
    call: RegExp;
    what: string;
    /** The page to load again, and how to read the act's state on it (true: done). */
    reload: { open: () => Promise<unknown>; state: () => Promise<boolean | null> };
    want: boolean;
  },
): Promise<"answer" | "reload"> {
  let answer: ActAnswer = null;
  const onResponse = async (r: Response) => {
    const req = r.request();
    if (answer || req.method() === "GET" || !o.call.test(r.url())) return;
    answer = actAnswerOf(r.status(), (await r.text().catch(() => "")) ?? "");
  };
  fp.page.on("response", onResponse);
  try {
    await o.click();
    for (let i = 0; i < RENDER_MS / SETTLE_MS && !answer; i++) await fp.wait(SETTLE_MS);
  } finally {
    fp.page.off("response", onResponse);
  }
  const got = answer as ActAnswer;
  if (got && "refused" in got) {
    markLimited();
    return fp.human(`the site refused the ${o.what}: ${got.refused}`);
  }
  if (got) return "answer";
  await o.reload.open();
  if ((await o.reload.state()) !== o.want) {
    markLimited();
    return fp.human(`the site did not keep the ${o.what}: the account may be limited`);
  }
  return "reload";
}
