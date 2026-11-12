/**
 * Looks that answer only what changed (`aria`/`snapshot` `since`, `screenshot` `ifChanged`):
 * agent-browser's diff idea, so a re-look after an act costs the change, not the page.
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Last rows per look key; a new URL, a first look or a change past the cap answers whole. */
export function sinceStore<D extends { more?: number }>(
  diff: (before: string[], after: string[]) => D,
) {
  const last = new Map<string, { url: string; rows: string[] }>();
  return {
    /** Records `rows`; the change since the last look when `since` and it is worth sending. */
    look(key: string, url: string, rows: string[], since: boolean | undefined): D | null {
      const prev = last.get(key);
      last.set(key, { url, rows });
      if (!since || !prev || prev.url !== url) return null;
      const d = diff(prev.rows, rows);
      return d.more ? null : d;
    },
  };
}

/** Share of pixels that differ between two PNGs; 1 when the sizes differ (a resize is a change). */
export function shotDiff(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 1;
  const n = pixelmatch(x.data, y.data, null, x.width, x.height, { threshold: 0.1 });
  return n / (x.width * x.height);
}
