import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionHosts } from "../src/auth/signup.js";
import { fenceNavigations, urlAllowed } from "../src/browser/nav-fence.js";
import { startExplore } from "../src/explore/server.js";

// WA-1351: an injected page cannot send the agent's session off its sites.
describe("navigation fence", () => {
  const hits: string[] = [];
  let base = "";
  let away = "";
  const server = createServer((req, res) => {
    hits.push(`${req.headers.host?.split(":")[0]}${req.url}`);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    if (req.url === "/hop") {
      res.writeHead(302, { location: `${away}/leak?hop` });
      return res.end();
    }
    if (req.url === "/js") return html(`<script>location = '${away}/leak?js'</script>`);
    if (req.url === "/frame") return html("<p>framed</p>");
    if (req.url?.startsWith("/leak")) return html("<p>leaked</p>");
    html(
      `<a href="${away}/leak?link">Go</a><iframe src="${away}/frame"></iframe><form action="${away}/leak?form" method="post"><button>Send</button></form>`,
    );
  });

  let dir: string;
  let port: number;
  let done: Promise<void>;
  let token: string;
  const send = async (cmd: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return (await r.json()) as Record<string, unknown>;
  };
  const leaks = () => hits.filter((h) => h.startsWith("localhost/leak"));

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const p = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${p}`;
    away = `http://localhost:${p}`;
    dir = await mkdtemp(join(tmpdir(), "nav-fence-"));
    port = 9800 + Math.floor(Math.random() * 100);
    ({ done, token } = await startExplore({
      site: "scratch",
      port,
      allowHosts: (h) => h === "127.0.0.1",
      tokenFile: join(dir, "explore.token"),
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    }));
  }, 30_000);
  afterAll(async () => {
    await send({ cmd: "close" }).catch(() => undefined);
    await done;
    expect(existsSync(join(dir, "explore.token"))).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("refuses an open off the sites before anything is sent", async () => {
    expect(JSON.stringify(await send({ cmd: "open", url: `${away}/leak?open` }))).toMatch(
      /localhost is outside this session's sites/,
    );
    expect(leaks()).toEqual([]);
  });

  it("stops a link, a form post, a script redirect and a redirect hop", async () => {
    await send({ cmd: "open", url: `${base}/` });
    await send({ cmd: "click", hints: { role: "link", name: "Go" } });
    await send({ cmd: "open", url: `${base}/` });
    await send({ cmd: "click", hints: { role: "button", name: "Send" } });
    await send({ cmd: "open", url: `${base}/js` }).catch(() => undefined);
    await send({ cmd: "open", url: `${base}/hop` }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(leaks()).toEqual([]);
    expect(hits).toContain("127.0.0.1/hop");
    const { url } = (await send({ cmd: "url" })) as { url: string };
    expect(url).not.toMatch(/localhost/);
  }, 60_000);
});

// The same server, a plain browser: what the fence lets through.
describe("fenceNavigations", () => {
  it("passes an iframe off the sites; blanks a popup that lands off them", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.headers.host?.split(":")[0]}${req.url}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        req.url === "/"
          ? `<iframe src="${away}/frame"></iframe><a target="_blank" href="${away}/leak?popup">Pop</a>`
          : "<p>x</p>",
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const p = (server.address() as AddressInfo).port;
    const away = `http://localhost:${p}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const refused: string[] = [];
      await fenceNavigations(
        context,
        (h) => h === "127.0.0.1",
        (u) => refused.push(u),
      );
      await page.goto(`http://127.0.0.1:${p}/`);
      await page.frameLocator("iframe").locator("p").waitFor();
      expect(hits).toContain("localhost/frame");
      const popup = context.waitForEvent("page");
      await page.getByRole("link", { name: "Pop" }).click();
      const opened = await popup;
      await opened.waitForTimeout(500);
      expect(opened.url()).not.toMatch(/localhost/);
      expect(refused.some((u) => u.includes("leak?popup"))).toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("sessionHosts", () => {
  it("the site's own hosts, the start domain, its parent sign-in and the providers; nothing else", () => {
    const ok = sessionHosts("trello@wren", "https://www.example.co.uk/start", ["cdn.test"]);
    for (const h of [
      "trello.com",
      "www.trello.com",
      "shop.example.co.uk",
      "id.atlassian.com",
      "accounts.google.com",
      "a.cdn.test",
    ])
      expect(ok(h), h).toBe(true);
    for (const h of ["trello.evil.com", "google.com", "evil.example", "example.co.uk.evil.io"])
      expect(ok(h), h).toBe(false);
  });

  it("lets about:, data: and error pages through; judges http(s) by host", () => {
    const only = (h: string) => h === "a.test";
    expect(urlAllowed("about:blank", only)).toBe(true);
    expect(urlAllowed("data:text/html,x", only)).toBe(true);
    expect(urlAllowed("https://a.test/x", only)).toBe(true);
    expect(urlAllowed("https://b.test/x", only)).toBe(false);
    expect(urlAllowed("not a url", only)).toBe(false);
  });
});
