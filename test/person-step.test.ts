import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { personStep } from "../src/auth/login.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { type BrowserOptions, NeedsHuman } from "../src/browser/session.js";

describe("a person's step in a flow", () => {
  let loads = 0;
  // the "person": from the second load on, the check passes by itself after a moment
  const server = createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    if (q.url !== "/check") return r.end("<title>in</title><h1>Signed in</h1>");
    const answered = ++loads > 1;
    r.end(
      `<title>check</title><h1>Verify it's you</h1>${answered ? "<script>setTimeout(() => (location = '/in'), 1500)</script>" : ""}`,
    );
  });
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  afterAll(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "autobrowse-person-"));
  const opts: BrowserOptions = {
    tier: "local",
    channel: "chromium",
    profilesDir: join(dir, "profiles"),
    artifactsDir: join(dir, "artifacts"),
    headless: true,
  };
  const told: string[] = [];
  const check = (base: string) =>
    defineFlow<undefined, string>({
      site: "scratch",
      name: "check",
      async run(fp) {
        await fp.open(`${base}/check`);
        await personStep(
          {
            fp,
            cred: { username: "a@example.com" } as never,
            notify: async (t) => void told.push(t),
          },
          "a phone tap",
        );
        return fp.url();
      },
    });

  it("headless: runs once more in the window's browser, tells the person once, goes on when the page moves", async () => {
    const base = await ready;
    const windows: BrowserOptions[] = [];
    const runner = flowRunner(opts, {
      pace: null,
      runs: null,
      resume: false,
      // no window in a test: the same headless browser stands in for it
      person: (o) => {
        windows.push(o);
        return o;
      },
    });
    expect(await runner.run(check(base), undefined)).toBe(`${base}/in`);
    expect(loads).toBe(2);
    expect(windows).toHaveLength(1);
    expect(told).toEqual([
      "Sign-in for a@example.com waits for you in a browser window: a phone tap",
    ]);
  }, 60_000);

  it("with no window to open, it is a NeedsHuman marked as a person's", async () => {
    const base = await ready;
    const runner = flowRunner(opts, { pace: null, runs: null, resume: false, person: false });
    const err = await runner.run(check(base), undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHuman);
    expect((err as NeedsHuman).person).toBe(true);
    expect((err as NeedsHuman).message).toBe("scratch: a phone tap");
  }, 60_000);
});
