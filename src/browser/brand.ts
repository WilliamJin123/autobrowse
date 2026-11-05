/**
 * `web GET /brand`: what a person sees of a site's brand, read from one rendered page
 * (designs/2026-11-05-brand-probe.md). Computed styles, so a site whose colours are set by
 * script (no static stylesheet says them) still answers. The shape is `BrandProbe` in
 * `@wrenautomation/read` (`brand/brand.ts`), which votes on it; keep the two alike.
 */
import type { Page } from "playwright";

export interface BrandStyles {
  themeColor: string | null;
  body: { background: string; color: string; font: string };
  /** Visible h1 and h2, first 6. */
  headings: { font: string; color: string }[];
  /** Visible buttons and button-like links with a fill, first 20; `area` in px². */
  buttons: { background: string; color: string; area: number }[];
  /** Visible links' text colours, first 30. */
  links: { color: string }[];
  /** Images and SVGs named logo or brand, or in the home link; `svg` is the markup. */
  logos: { src: string | null; svg: string | null; named: boolean; top: boolean; area: number }[];
}

export const BRAND_CAPS = { headings: 6, buttons: 20, links: 30, logos: 12, svgChars: 20_000 };

/**
 * The page script. Colours stay as the browser gives them (`rgb(…)`, `oklch(…)`): read parses
 * both. A string, not a function: tsx wraps named helpers in `__name`, which the page lacks.
 */
export const READ_BRAND = String.raw`((caps) => {
  const style = (el) => getComputedStyle(el);
  // No colour a person sees: none, or under half opaque (read drops those too; here they would fill the caps).
  const clear = (c) => {
    if (!c || c === "transparent") return true;
    const a = /(?:,|\/)\s*([\d.]+%?)\s*\)$/.exec(c.startsWith("rgb(") ? "" : c);
    if (!a) return false;
    return (a[1].endsWith("%") ? parseFloat(a[1]) / 100 : Number(a[1])) < 0.5;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = style(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.width * r.height);
  };
  // The fill a person sees: a gradient's first stop (it paints over the colour), else the colour.
  const fill = (el) => {
    const s = style(el);
    const m = /gradient\(.*?((?:rgba?|hsla?|lab|lch|oklab|oklch|color)\([^()]*\))/.exec(s.backgroundImage);
    if (m && !clear(m[1])) return m[1];
    return clear(s.backgroundColor) ? null : s.backgroundColor;
  };
  const all = (q) => [...document.querySelectorAll(q)];

  const root = document.documentElement;
  const body = document.body || root;
  // No fill on body or html: the browser's canvas, white in the light scheme.
  const background = fill(body) || fill(root) || "rgb(255, 255, 255)";

  const theme = all('meta[name="theme-color"]').find((m) => !m.media || matchMedia(m.media).matches);

  const headings = all("h1, h2")
    .filter(shown)
    .slice(0, caps.headings)
    .map((h) => ({ font: style(h).fontFamily, color: style(h).color }));

  const buttons = [];
  const plain = [];
  for (const el of all('button, [role="button"], input[type="submit"], input[type="button"], a[href]')) {
    if (!shown(el)) continue;
    const bg = fill(el);
    if (bg && bg !== background) {
      if (buttons.length < caps.buttons) buttons.push({ background: bg, color: style(el).color, area: area(el) });
    } else if (el.tagName === "A" && (el.textContent || "").trim()) plain.push(el); // a link around a picture has no text colour
  }
  const links = plain.slice(0, caps.links).map((a) => ({ color: style(a).color }));

  // The site's root, or a locale root (/en, /en-us).
  const home = (a) => {
    if (!a) return false;
    try {
      const u = new URL(a.href, location.href);
      return u.origin === location.origin && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(u.pathname);
    } catch {
      return false;
    }
  };
  const says = (el) => {
    for (let at = el, n = 0; at && n < 4; at = at.parentElement, n++) {
      const words = [
        at.id,
        at.getAttribute("class") || "",
        at.getAttribute("alt") || "",
        at.getAttribute("aria-label") || "",
        at.getAttribute("title") || "",
        n === 0 ? at.getAttribute("src") || "" : "",
      ].join(" ");
      if (/logo|brand/i.test(words)) return true;
    }
    return false;
  };
  const logos = [];
  const seen = new Set();
  for (const el of all("img, svg")) {
    if (logos.length >= caps.logos) break;
    // An svg inside an svg is part of its parent's picture.
    if ((el.parentElement && el.parentElement.closest("svg")) || !shown(el)) continue;
    const named = says(el);
    if (!named && !home(el.closest("a"))) continue;
    const img = el.tagName === "IMG";
    const src = img ? el.currentSrc || el.src || null : null;
    const svg = img ? null : el.outerHTML;
    // A sprite reference (<use href="#id">) is no picture outside this page.
    if (!img && (svg.length > caps.svgChars || /<use[\s>]/i.test(svg))) continue;
    if (img && !src) continue;
    const key = src || svg;
    if (seen.has(key)) continue;
    seen.add(key);
    logos.push({ src, svg, named, top: !!el.closest('header, nav, [role="banner"]'), area: area(el) });
  }

  return {
    themeColor: (theme && theme.content.trim()) || null,
    body: { background, color: style(body).color, font: style(body).fontFamily },
    headings,
    buttons,
    links,
    logos,
  };
})`;

const SETTLE_MS = 5_000;

/** One loaded page's brand styles; set the light scheme before the page loads. */
export async function brandStyles(page: Page): Promise<BrandStyles> {
  // Script-built styles land after `load`: wait for the network to go quiet, 5 s at most.
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
  return page.evaluate<BrandStyles>(`${READ_BRAND}(${JSON.stringify(BRAND_CAPS)})`);
}
