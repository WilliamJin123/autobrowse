import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { type Fault, scrubHar } from "../src/browser/har.js";
import type { BrowserOptions } from "../src/browser/session.js";

// WA-1350: a walk recorded once, then tested with no site; faults on the same walk.
describe("HAR record, replay, faults", () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/api/items") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=live-cookie-1" });
      return res.end(JSON.stringify({ items: ["alpha", "beta"] }));
    }
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=live-cookie-1" });
    res.end(`<ul id="list"></ul><p id="state">loading</p><script>
      fetch('/api/items', { headers: { authorization: 'Bearer live-' + 'token-123456' } })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error('status ' + r.status)))
        .then((j) => { list.innerHTML = j.items.map((x) => '<li>' + x + '</li>').join(''); state.textContent = 'ok'; })
        .catch((e) => { state.textContent = 'failed: ' + e.message; });
    </script>`);
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const dir = mkdtempSync(join(tmpdir(), "autobrowse-har-"));
  const har = join(dir, "walk.har");
  const runWith = (extra: Partial<BrowserOptions>, n: number) =>
    flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, `profiles-${n}`),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
        ...extra,
      },
      { pace: null },
    ).run(
      defineFlow<undefined, { state: string; list: string }>({
        site: "scratch",
        name: "list",
        async run(fp) {
          await fp.open(`${base}/`);
          for (let i = 0; i < 40 && (await fp.read({ css: "#state" })) === "loading"; i++)
            await fp.wait(100);
          return { state: await fp.read({ css: "#state" }), list: await fp.read({ css: "#list" }) };
        },
      }),
      undefined,
    );

  it("records a scrubbed HAR, then replays it with the site gone quiet", async () => {
    expect(await runWith({ har: { record: har } }, 1)).toEqual({
      state: "ok",
      list: "alpha\nbeta",
    });
    const text = readFileSync(har, "utf8");
    expect(text).toContain("alpha");
    expect(text).not.toContain("live-cookie-1");
    expect(text).not.toContain("live-token-123456");

    const before = hits;
    expect(await runWith({ har: { replay: har } }, 2)).toEqual({
      state: "ok",
      list: "alpha\nbeta",
    });
    expect(hits).toBe(before);
  }, 60_000);

  it("a 500, a dropped call and a slow call, on the replayed walk", async () => {
    const run = (faults: Fault[], n: number) => runWith({ har: { replay: har }, faults }, n);
    expect((await run([{ url: "**/api/items", status: 500 }], 3)).state).toBe("failed: status 500");
    expect((await run([{ url: "**/api/items", abort: true }], 4)).state).toMatch(/^failed: /);
    const t = Date.now();
    expect((await run([{ url: "**/api/items", delayMs: 1_500 }], 5)).state).toBe("ok");
    expect(Date.now() - t).toBeGreaterThanOrEqual(1_500);
  }, 60_000);
});

describe("scrubHar", () => {
  it("drops cookies and credential headers, masks a held secret in every spelling", () => {
    const file = join(mkdtempSync(join(tmpdir(), "autobrowse-har-")), "x.har");
    const secret = "hunter 2&secret";
    writeFileSync(
      file,
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                url: `https://a.test/s?pw=${encodeURIComponent(secret)}`,
                headers: [
                  { name: "Cookie", value: "sid=1" },
                  { name: "X-CSRF-Token", value: "t" },
                  { name: "Accept", value: "*/*" },
                ],
                cookies: [{ name: "sid", value: "1" }],
                postData: {
                  text: `user=me&password=${encodeURIComponent(secret).replace(/%20/g, "+")}&csrf=keep-me`,
                  params: [{ name: "password", value: secret }],
                },
              },
              response: {
                headers: [{ name: "Set-Cookie", value: "sid=2" }],
                cookies: [{ name: "sid", value: "2" }],
                content: { text: `{"echo":"${secret}"}` },
              },
            },
          ],
        },
      }),
    );
    expect(scrubHar(file, [secret])).toBe(1);
    const out = readFileSync(file, "utf8");
    expect(out).not.toContain("hunter");
    expect(out).not.toContain("sid=");
    expect(out).not.toContain("X-CSRF-Token");
    expect(out).toContain('"Accept"');
    // a page's csrf token stays: a replayed form posts the same body
    expect(out).toContain("csrf=keep-me");
  });
});
