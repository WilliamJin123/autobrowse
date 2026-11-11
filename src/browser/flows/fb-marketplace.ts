/**
 * Facebook Marketplace search, signed out (OpenCLI port, `clis/facebook/marketplace-listings.js`
 * reads signed in). Mapped live 2026-11-10: the search page answers signed out with its first 15
 * listings whole in a `script[type="application/json"]` (`marketplace_search.feed_units`); it
 * loads no more on scroll, and a listing page and `/search/top` show nothing signed out.
 */

import { defineFlow } from "../flow.js";
import { RungBroke } from "../ladder.js";

const WEB = "https://www.facebook.com";

/** Every listing (`marketplace_listing_title` + `id`) in the page's JSON scripts, whole, by id. */
export function listingsOf(
  roots: readonly unknown[],
  into = new Map<string, Record<string, unknown>>(),
): Map<string, Record<string, unknown>> {
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 80) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.marketplace_listing_title === "string" && typeof o.id === "string") {
      if (!into.has(o.id)) into.set(o.id, o);
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return into;
}

const SCRIPTS = `[...document.querySelectorAll('script[type="application/json"]')]
  .map((s) => s.textContent || "")
  .filter((t) => t.includes("marketplace_listing_title"))
  .map((t) => { try { return JSON.parse(t); } catch { return null; } })
  .filter(Boolean)`;

export interface MarketplaceInput {
  q: string;
  /** Marketplace's city slug (`nyc`, `la`, `chicago`) or numeric place id. */
  city?: string;
}

export interface Marketplace {
  q: string;
  city: string;
  /** Each listing whole: title, price, location, photo, seller, delivery types. */
  listings: Record<string, unknown>[];
}

export const fbMarketplace = defineFlow<MarketplaceInput, Marketplace>({
  site: "fb-public",
  name: "marketplace",
  strategies: ["cookie"],
  async run(fp, { q, city }) {
    const at = city ?? "nyc";
    // Signed out, a "Log In" bar sits over every page: not a wall here.
    await fp.open(
      `${WEB}/marketplace/${encodeURIComponent(at)}/search?query=${encodeURIComponent(q)}`,
      { allowWall: true },
    );
    let roots: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      roots = ((await fp.page.evaluate(SCRIPTS).catch(() => [])) as unknown[]) ?? [];
      if (roots.length) break;
      await fp.wait(1_000);
    }
    const listings = [...listingsOf(roots).values()];
    if (!listings.length && !/no results|didn.t find/i.test(await fp.text().catch(() => "")))
      throw new RungBroke("no Marketplace listings in the page's data");
    return { q, city: at, listings };
  },
});
