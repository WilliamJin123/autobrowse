/**
 * A public API read from inside the site's own page (WA-1251.5): for hosts that answer a
 * bot check to any plain client (dblp's Anubis, OpenReview's challenge, 11-09). The browser
 * passes the check on its own; its cookie then lets the page's fetch read the API.
 * From OpenCLI clis/dblp/browser.js@9bc5f5c. One flow per site, so each keeps its profile.
 */
import { type BrowserFlow, defineFlow, type FlowPage } from "../flow.js";
import { classify, type Fetched, pageFetch } from "../page-json.js";
import { AccessRefused } from "../session.js";

const CHECK =
  /making sure.*not a bot|anubis|access denied|security verification|just a moment|verify(ing)? you are human|challenge/i;
/** A proof of work takes 1–5 s on this Mac; past 30 s it is not passing. */
const PASS_MS = 30_000;

export interface PageApiInput {
  /** The API URL, whole: `https://dblp.org/search/publ/api?…`. */
  url: string;
}

export interface PageApiAnswer {
  url: string;
  status: number;
  /** JSON as parsed; null for XML or a 404. */
  json: unknown;
  /** The text as sent, for XML answers. */
  xml: string | null;
}

async function pastCheck(
  fp: FlowPage,
  home: string,
  onCheck: (fp: FlowPage) => boolean,
): Promise<void> {
  if (!fp.url().startsWith(new URL(home).origin)) await fp.open(home);
  const until = Date.now() + PASS_MS;
  // a blank title is the check page still loading; it reloads itself once passed
  while (onCheck(fp) || CHECK.test(await titleOf(fp)) || !(await titleOf(fp))) {
    if (Date.now() > until)
      throw new AccessRefused(
        "platform_blocked",
        `${new URL(home).host}: the bot check did not pass in 30 s`,
      );
    await fp.wait(1_000);
  }
  await fp.page.waitForLoadState("load").catch(() => {});
}

/** Waits for the page to leave the challenge's path (its pass redirects). */
async function leaveChallenge(fp: FlowPage, path: string): Promise<void> {
  const until = Date.now() + PASS_MS;
  while (new URL(fp.url()).pathname === path) {
    if (Date.now() > until)
      throw new AccessRefused(
        "platform_blocked",
        `${new URL(fp.url()).host}: the challenge did not pass in 30 s`,
      );
    await fp.wait(1_000);
  }
  await fp.page.waitForLoadState("load").catch(() => {});
}

/** The title, or "" while a navigation swaps the page. */
const titleOf = (fp: FlowPage) => fp.page.title().catch(() => "");

const MOVED = /execution context was destroyed|navigat/i;

/** The fetch, once more if the page moved under it (a check's own reload). */
async function fetchSettled(fp: FlowPage, url: string) {
  try {
    return await pageFetch(fp, url, { credentials: "include" });
  } catch (e) {
    if (!MOVED.test(String(e))) throw e;
    await fp.page.waitForLoadState("load").catch(() => {});
    return pageFetch(fp, url, { credentials: "include" });
  }
}

/** A challenge answer's page to pass: `details.challengeUrl`. */
export function challengeUrlOf(text: string): string | null {
  try {
    const u = (JSON.parse(text) as { details?: { challengeUrl?: unknown } }).details?.challengeUrl;
    return typeof u === "string" && /^https:\/\//.test(u) ? u : null;
  } catch {
    return null;
  }
}

function answerOf(url: string, f: Fetched, what: string): PageApiAnswer {
  if (f.status === 404) return { url, status: 404, json: null, xml: null };
  if (/xml/.test(f.contentType) || /^\s*<\?xml/.test(f.text)) {
    if (f.status !== 200) throw new AccessRefused("platform_blocked", `${what}: HTTP ${f.status}`);
    return { url, status: f.status, json: null, xml: f.text };
  }
  return { url, status: f.status, json: classify(f, what), xml: null };
}

/** A flow `<site>/api` that opens `home`, waits out its check, then fetches `url` in the page. */
export function pageApiFlow(
  site: string,
  home: string,
  o: { hosts: RegExp; onCheck?: (fp: FlowPage) => boolean },
): BrowserFlow<PageApiInput, PageApiAnswer> {
  return defineFlow<PageApiInput, PageApiAnswer>({
    site,
    name: "api",
    offscreen: true,
    async run(fp, { url }) {
      if (!o.hosts.test(new URL(url).host))
        throw new Error(`${site}/api: not a ${site} url: ${url}`);
      await pastCheck(fp, home, o.onCheck ?? (() => false));
      const f = await fetchSettled(fp, url);
      const what = `${site} ${url.replace(/\?.*/, "")}`;
      if (f.status === 403 && /challenge/i.test(f.text.slice(0, 400))) {
        // OpenReview: a Turnstile per API, at `details.challengeUrl`; passed, it lands on the
        // API URL, and the page's fetch then answers
        const at = challengeUrlOf(f.text);
        if (!at) throw new AccessRefused("platform_blocked", `${what}: a challenge with no page`);
        await fp.open(at);
        await leaveChallenge(fp, new URL(at).pathname);
        const again = await fetchSettled(fp, url);
        if (again.status === 403 && /challenge/i.test(again.text.slice(0, 400)))
          throw new AccessRefused(
            "platform_blocked",
            `${what}: the challenge came back after passing`,
          );
        return answerOf(url, again, what);
      }
      return answerOf(url, f, what);
    },
  });
}

export const dblpApi = pageApiFlow("dblp", "https://dblp.org/", { hosts: /^dblp\.org$/ });

export const openreviewApi = pageApiFlow("openreview", "https://openreview.net/", {
  hosts: /^api2?\.openreview\.net$/,
  onCheck: (fp) => /\/challenge\b/.test(fp.url()),
});
