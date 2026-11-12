/**
 * Walks tested offline (WA-1350; designs/2026-11-12-agent-browser-audit.md, row 10). A run
 * records a HAR (`AUTOBROWSE_HAR`), scrubbed on close; a test replays it with Playwright's
 * `routeFromHAR`: no site hit, no cap spent. Faults: a status, a delay or a dropped call on
 * matching URLs, to test how a walk fails.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { BrowserContext } from "playwright";
import { REDACTED, redactText } from "../recorder/redact.js";
import { secretName } from "./network.js";
import { heldSecrets, MATCH_MIN } from "./secrets.js";

export interface HarOptions {
  /** Record every call of the run here; written and scrubbed when the browser closes. */
  record?: string;
  /** Answer every call from this file; a call it lacks is dropped. */
  replay?: string;
}

/** One rule: calls whose URL matches get a status, a delay, or nothing. */
export interface Fault {
  /** A glob as `context.route` takes it, or a pattern. */
  url: string | RegExp;
  /** Answer with this status (and `body`) instead of the site. */
  status?: number;
  body?: string;
  /** Hold the call this long first; with no status it then goes on as usual. */
  delayMs?: number;
  /** Drop the call: the page sees a network error. */
  abort?: boolean;
  /** Only the first n matching calls; the rest pass. Default: all. */
  times?: number;
}

/** Replays `file` on the context: calls match by URL, method and POST body. */
export async function replayHar(context: BrowserContext, file: string): Promise<void> {
  await context.routeFromHAR(file, { notFound: "abort" });
}

/** Routes each fault on the context; registered last, so they answer before a replay. */
export async function injectFaults(
  context: BrowserContext,
  faults: readonly Fault[],
): Promise<void> {
  for (const f of faults) {
    let n = 0;
    await context.route(f.url, async (route) => {
      if (f.times !== undefined && n >= f.times) return route.fallback();
      n++;
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.abort) return route.abort("failed");
      if (f.status)
        return route.fulfill({ status: f.status, body: f.body ?? "", contentType: "text/plain" });
      return route.fallback();
    });
  }
}

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  request: {
    url: string;
    headers: HarHeader[];
    cookies: unknown[];
    postData?: { text?: string; params?: { name: string; value?: string }[] };
  };
  response: {
    headers: HarHeader[];
    cookies: unknown[];
    content: { text?: string; encoding?: string };
  };
}

/** A held secret as a page sends it: raw, URL-encoded, form-encoded. */
const spellings = (s: string) => [
  ...new Set([s, encodeURIComponent(s), encodeURIComponent(s).replace(/%20/g, "+")]),
];

/** Every held secret, in any spelling, then the known key shapes, masked. */
function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  // a short one would mask common text; the hands never hold one that short
  for (const s of secrets) {
    if (s.length < MATCH_MIN) continue;
    for (const v of spellings(s)) out = out.split(v).join(REDACTED);
  }
  return redactText(out);
}

const kept = (h: HarHeader) => h.name.toLowerCase() !== "set-cookie" && !secretName(h.name);

/**
 * The HAR with no cookies, no credential headers and no held secret: safe as a test fixture.
 * Bodies keep their other values (a page's csrf token), so a replayed form posts the same body.
 */
export function scrubHar(file: string, secrets: readonly string[] = heldSecrets()): number {
  const har = JSON.parse(readFileSync(file, "utf8")) as { log: { entries: HarEntry[] } };
  for (const e of har.log.entries) {
    e.request.headers = e.request.headers.filter(kept);
    e.request.cookies = [];
    e.response.headers = e.response.headers.filter(kept);
    e.response.cookies = [];
    e.request.url = scrubText(e.request.url, secrets);
    const post = e.request.postData;
    if (post?.text !== undefined) post.text = scrubText(post.text, secrets);
    for (const p of post?.params ?? []) if (p.value) p.value = scrubText(p.value, secrets);
    const c = e.response.content;
    if (c.text !== undefined && c.encoding !== "base64") c.text = scrubText(c.text, secrets);
  }
  writeFileSync(file, JSON.stringify(har));
  return har.log.entries.length;
}

/** Scrubs a recorded HAR; one that cannot be read is deleted, never left with its cookies. */
export function scrubOrDrop(file: string): void {
  if (!existsSync(file)) return;
  try {
    scrubHar(file);
  } catch (err) {
    rmSync(file, { force: true });
    console.error(`har: ${file} dropped, not scrubbed: ${(err as Error).message}`);
  }
}
