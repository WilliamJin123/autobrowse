import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandStyles } from "../src/browser/brand.js";
import type { ApiLeg } from "../src/sites/types.js";
import { web } from "../src/sites/web.js";

/** A page whose colours come from script and custom properties, as a built site's do. */
const PAGE = `<!doctype html><html><head>
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#5e6ad2">
<style>
  :root { --bg: #fbfbfb; --ink: rgb(20, 20, 30); }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --ink: #fff; } }
  body { background: var(--bg); color: var(--ink); font-family: "Inter Variable", system-ui, sans-serif; margin: 0; }
  h1 { font-family: "Tiempos Headline", serif; color: oklch(0.3 0.1 270); }
  .cta { background: #5e6ad2; color: #fff; padding: 10px 24px; display: inline-block; }
  .grad { background-image: linear-gradient(90deg, rgb(255, 0, 80), rgb(0, 0, 255)); border: 0; width: 100px; height: 40px; }
  .ghost { background: rgba(255, 255, 255, 0.04); border: 0; }
  nav a { color: rgb(94, 106, 210); }
  .gone { display: none; }
</style></head><body>
<header><nav>
  <a href="/"><svg width="80" height="20" viewBox="0 0 80 20"><rect width="80" height="20"/></svg></a>
  <a href="/pricing">Pricing</a>
  <a href="/docs">Docs</a>
  <a class="cta" href="/signup">Start</a>
</nav></header>
<h1>One</h1><h2 class="gone">Hidden</h2><h2>Two</h2>
<button class="grad">Go</button><button class="ghost">Quiet</button>
<img class="partner-logo" src="https://cdn.example/partner.png" width="50" height="20" alt="">
<img src="https://cdn.example/hero.png" width="300" height="200" alt="A hero">
<svg width="10" height="10"><use href="#sprite-logo"></use></svg>
</body></html>`;

describe("brand styles", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  it("reads what the light scheme shows", async () => {
    const page = await browser.newPage({ colorScheme: "light" });
    // The images never load: the reader must not need them.
    await page.route("https://cdn.example/**", (r) => r.abort());
    // A real origin: the home link is found by it.
    await page.route("https://acme.example/", (r) =>
      r.fulfill({ contentType: "text/html", body: PAGE }),
    );
    await page.goto("https://acme.example/");
    const b = await brandStyles(page);
    expect(b.themeColor).toBe("#5e6ad2");
    expect(b.body).toEqual({
      background: "rgb(251, 251, 251)",
      color: "rgb(20, 20, 30)",
      font: '"Inter Variable", system-ui, sans-serif',
    });
    // The hidden h2 is left out.
    expect(b.headings).toEqual([
      { font: '"Tiempos Headline", serif', color: "oklch(0.3 0.1 270)" },
      { font: '"Inter Variable", system-ui, sans-serif', color: "rgb(20, 20, 30)" },
    ]);
    // A fill, or a gradient's first stop; a fill under half opaque is no fill.
    expect(b.buttons.map((x) => x.background)).toEqual(["rgb(94, 106, 210)", "rgb(255, 0, 80)"]);
    expect(b.buttons[1]?.area).toBe(4000);
    // Text links only: the logo's link and the filled one are not link colours.
    expect(b.links).toEqual([{ color: "rgb(94, 106, 210)" }, { color: "rgb(94, 106, 210)" }]);
    // The home link's SVG and the image named logo; not the hero, not the sprite reference.
    expect(b.logos.map((l) => [l.src, !!l.svg, l.named, l.top])).toEqual([
      [null, true, false, true],
      ["https://cdn.example/partner.png", false, true, false],
    ]);
    expect(b.logos[0]?.svg).toContain("<rect");
    await page.close();
  });

  it("a page with no fill is white", async () => {
    const page = await browser.newPage({ colorScheme: "light" });
    await page.setContent("<p>plain</p>");
    const b = await brandStyles(page);
    expect(b.body.background).toBe("rgb(255, 255, 255)");
    expect(b.themeColor).toBeNull();
    expect(b.buttons).toEqual([]);
    await page.close();
  });
});

describe("web GET /brand", () => {
  const route = web.routes.find((r) => r.path === "/brand");
  const styles = {
    themeColor: null,
    body: { background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", font: "serif" },
    headings: [],
    buttons: [],
    links: [],
    logos: [],
  };
  const call = (leg: Partial<ApiLeg>) =>
    route?.api?.(route.request.parse({ url: "https://acme.example" }), leg as ApiLeg);

  it("asks the render browser for the light scheme and adds the page's facts", async () => {
    const asked: unknown[] = [];
    const got = await call({
      render: async (url, o) => {
        asked.push([url, o.profile, o.scheme, typeof o.probe]);
        return {
          finalUrl: "https://www.acme.example/",
          status: 200,
          type: "text/html",
          html: `<html><body>${"<p>Real words on a real page.</p>".repeat(80)}</body></html>`,
          probed: styles as never,
        };
      },
    });
    expect(asked).toEqual([["https://acme.example", "fetch", "light", "function"]]);
    expect(got).toEqual({
      finalUrl: "https://www.acme.example/",
      status: 200,
      block: null,
      ...styles,
    });
  });

  it("a wall is data: the block is named beside what the page showed", async () => {
    const got = (await call({
      render: async () => ({
        finalUrl: "https://acme.example/",
        status: 403,
        type: "text/html",
        html: "<html><title>Just a moment...</title></html>",
        probed: styles as never,
      }),
    })) as { block: string | null };
    expect(got.block).toBe("cloudflare");
  });

  it("no browser on the worker is a 501", async () => {
    await expect(call({})).rejects.toMatchObject({ status: 501 });
  });

  it("costs one of the fetch budget", () => {
    expect(route?.meter?.({ url: "https://acme.example" } as never)).toEqual({ fetch: 1 });
  });
});
