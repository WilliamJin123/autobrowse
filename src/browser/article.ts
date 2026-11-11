/**
 * Article text (PinchTab audit P7): Mozilla Readability (Firefox's reader view, Apache 2.0), run
 * in an isolated world so the page never sees it. Opt-in: most pages are apps, not articles.
 * - `isProbablyReaderable` first: a cheap, deterministic skip, no extraction on a non-article.
 * - PinchTab's fallback: an article under 25 % of the page's `innerText` chars, on a page of
 *   400+ chars, is a bad cut; the caller answers layout text instead.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const MIN_SHARE = 0.25;
const MIN_PAGE_CHARS = 400;

let bundle: string | null = null;
/** Both library files, read once; each ends in a guarded `module.exports`, inert in a page. */
function library(): string {
  if (bundle) return bundle;
  const req = createRequire(import.meta.url);
  const dir = req.resolve("@mozilla/readability/package.json").replace(/package\.json$/, "");
  bundle = ["Readability-readerable.js", "Readability.js"]
    .map((f) => readFileSync(dir + f, "utf8"))
    .join("\n;\n");
  return bundle;
}

export type Article =
  | {
      article: true;
      title: string | null;
      byline: string | null;
      site: string | null;
      text: string;
    }
  /** No article: the caller falls back to layout text. */
  | { article: false; why: string };

interface Parsed {
  skip?: string;
  title?: string | null;
  byline?: string | null;
  site?: string | null;
  text?: string;
  pageChars: number;
}

const script = () => `(() => {
  const module = undefined;
  ${library()}
  const pageChars = (document.body && document.body.innerText || "").length;
  if (!isProbablyReaderable(document)) return { skip: "not an article (Readability's pre-check)", pageChars };
  const a = new Readability(document.cloneNode(true)).parse();
  if (!a || !a.textContent) return { skip: "Readability found no article", pageChars };
  return { title: a.title || null, byline: a.byline || null, site: a.siteName || null, text: a.textContent, pageChars };
})()`;

/** Judges a parse: kept, or why not (pure, for tests). */
export function judge(p: Parsed): Article {
  if (p.skip) return { article: false, why: p.skip };
  const text = (p.text ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (p.pageChars >= MIN_PAGE_CHARS && text.length < p.pageChars * MIN_SHARE)
    return {
      article: false,
      why: `article was ${text.length} of ${p.pageChars} page chars (under 25 %)`,
    };
  return {
    article: true,
    title: p.title ?? null,
    byline: p.byline ?? null,
    site: p.site ?? null,
    text,
  };
}

export async function articleText(page: Page): Promise<Article> {
  // Patchright evaluates in an isolated world by default (`in-page.ts`)
  const p = (await page.evaluate(script())) as Parsed;
  return judge(p);
}
