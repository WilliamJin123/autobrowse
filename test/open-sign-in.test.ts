import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { wallOf } from "../src/browser/session.js";
import { wallAnswer } from "../src/explore/server.js";

// WA-1022's cause: a page whose text looks like a sign-in started one nobody asked for.
describe("who signs in on open", () => {
  let signedIn = false;
  const server = createServer((req, res) => {
    if (req.url === "/login" && signedIn) {
      res.writeHead(302, { location: "/home" }).end();
      return;
    }
    const body =
      req.url === "/login" || (req.url === "/page" && !signedIn)
        ? "<p>Welcome</p><button>Continue with Google</button>"
        : "<p>Your feed</p>";
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const dir = mkdtempSync(join(tmpdir(), "autobrowse-open-"));
  const logins: string[] = [];
  const runner = flowRunner(
    {
      tier: "local",
      channel: "chromium",
      profilesDir: join(dir, "profiles"),
      artifactsDir: join(dir, "artifacts"),
      headless: true,
    },
    {
      pace: null,
      login: async (_fp, site) => {
        logins.push(site);
        signedIn = true;
        return "signed-in";
      },
    },
  );
  const opens = (path: string, o?: { signIn?: "url" }) =>
    defineFlow<undefined, string>({
      site: "scratch",
      name: "open",
      async run(fp) {
        await fp.open(`${base}${path}`, o);
        return new URL(fp.url()).pathname;
      },
    });

  it("a text-only wall is left to the caller under signIn:url; a leg still signs in on it; a login URL signs in", async () => {
    signedIn = false;
    logins.length = 0;
    expect(await runner.run(opens("/page", { signIn: "url" }), undefined)).toBe("/page");
    expect(logins).toEqual([]);
    expect(await runner.run(opens("/page"), undefined)).toBe("/page");
    expect(logins).toEqual(["scratch"]);
    signedIn = false;
    expect(await runner.run(opens("/login", { signIn: "url" }), undefined)).toBe("/home");
    expect(logins).toEqual(["scratch", "scratch"]);
  }, 60_000);

  it("the wall says how it was seen; a guessed sign-in wall names the site's login tool", () => {
    expect(wallOf("https://app.x.com/login", "")?.by).toBe("url");
    const guess = wallOf("https://www.perplexity.ai/", "Continue with Google");
    expect(guess).toMatchObject({ kind: "login", by: "text" });
    expect(wallAnswer(guess, "https://www.perplexity.ai/")).toMatchObject({
      signIn: "perplexity-login",
    });
    // a provider's product names the provider's login (WA-1036)
    const onProduct = { kind: "login", detail: "signed out", by: "text" } as const;
    expect(wallAnswer(onProduct, "https://studio.youtube.com/")).toMatchObject({
      signIn: "google-login",
    });
    // a URL wall names it too: open no longer signs in, the agent picks the account
    const sure = wallOf("https://www.linkedin.com/authwall?x=1", "");
    expect(wallAnswer(sure, "https://www.linkedin.com/authwall?x=1")).toMatchObject({
      signIn: "linkedin-login",
    });
    expect(wallAnswer(null, "https://x.com/")).toBeNull();
  });
});
