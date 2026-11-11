/**
 * Files a click starts downloading (OpenCLI audit U14). Before: Playwright held each in a temp
 * dir that went with the context, and nobody was told. Now each is saved to `dir` and logged; an
 * act's reply names those it started. The `download` command (a URL fetched with the page's
 * sign-in) stays the way to fetch a known link.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Download, Page } from "playwright";
import { redactUrl } from "./network.js";

export interface DownloadSeen {
  at: string;
  /** The URL, redacted. */
  url: string;
  /** The name the site gave. */
  name: string;
  state: "saving" | "saved" | "failed";
  /** Where it was saved. */
  file?: string;
  bytes?: number;
  error?: string;
}

export interface Downloads {
  log: DownloadSeen[];
  since(n: number): DownloadSeen[];
  count(): number;
  /** Until every download started so far is saved or failed. */
  settled(): Promise<void>;
}

const KEEP = 100;
const byContext = new WeakMap<BrowserContext, Downloads>();

/** A site's file name as a safe one: no path, no control characters. */
export const safeName = (name: string) =>
  [...name]
    .map((ch) => (ch < " " || "/\\:".includes(ch) ? "_" : ch))
    .join("")
    .replace(/^\.+/, "_")
    .slice(0, 160) || "download";

export function watchDownloads(context: BrowserContext, dir: string): Downloads {
  const had = byContext.get(context);
  if (had) return had;
  const log: DownloadSeen[] = [];
  const saving = new Set<Promise<void>>();
  let total = 0;
  const seen = (d: Download) => {
    const row: DownloadSeen = {
      at: new Date().toISOString(),
      url: redactUrl(d.url()),
      name: d.suggestedFilename(),
      state: "saving",
    };
    total++;
    log.push(row);
    if (log.length > KEEP) log.shift();
    const file = join(dir, `${row.at.replace(/[:.]/g, "-")}-${safeName(row.name)}`);
    const p = (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        await d.saveAs(file);
        row.state = "saved";
        row.file = file;
        row.bytes = statSync(file).size;
      } catch (err) {
        row.state = "failed";
        row.error = (await d.failure().catch(() => null)) ?? String(err).split("\n")[0];
      }
    })();
    saving.add(p);
    void p.finally(() => saving.delete(p));
  };
  const watch = (p: Page) => p.on("download", seen);
  for (const p of context.pages()) watch(p);
  context.on("page", watch);
  const downloads: Downloads = {
    log,
    since: (n) => log.slice(Math.max(0, log.length - (total - n))),
    count: () => total,
    settled: async () => {
      await Promise.all([...saving]);
    },
  };
  byContext.set(context, downloads);
  return downloads;
}
