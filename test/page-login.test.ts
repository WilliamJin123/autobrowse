import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials } from "credvault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loginProvider, totpSource } from "../src/auth/index.js";
import { type PageField, signInFields } from "../src/auth/page-login.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { HUMAN_PACE } from "../src/browser/human/index.js";
import { loginAccounts } from "../src/workflows/toolkit.js";

const field = (i: number, f: Partial<PageField>): PageField => ({
  i,
  name: null,
  placeholder: null,
  id: null,
  inputType: "text",
  autocomplete: "",
  form: 0,
  ...f,
});

describe("sign-in boxes on a page", () => {
  it("finds the name and password of one form", () => {
    const got = signInFields([
      field(0, { name: "q", inputType: "search", form: -1 }),
      field(1, { name: "email", inputType: "email", form: 1 }),
      field(2, { name: "pass", inputType: "password", form: 1 }),
    ]);
    expect(got).toMatchObject({ name: { i: 1 }, password: { i: 2 }, code: null });
  });
  it("takes autocomplete over words", () => {
    const got = signInFields([
      field(0, { id: "f1", autocomplete: "username" }),
      field(1, { id: "f2", inputType: "password", autocomplete: "current-password" }),
    ]);
    expect(got).toMatchObject({ name: { i: 0 }, password: { i: 1 } });
  });
  it("refuses a sign-up or a password change", () => {
    expect(
      signInFields([
        field(0, { name: "email", inputType: "email" }),
        field(1, { name: "password", inputType: "password" }),
        field(2, { name: "confirm", inputType: "password" }),
      ]),
    ).toEqual({ not: expect.stringContaining("new password") });
    expect(
      signInFields([field(0, { inputType: "password", autocomplete: "new-password" })]),
    ).toHaveProperty("not");
  });
  it("a code box is not a password", () => {
    const got = signInFields([field(0, { name: "otp", autocomplete: "one-time-code" })]);
    expect(got).toMatchObject({ password: null, code: { i: 0 } });
  });
});

describe("loginAccounts with no spec", () => {
  it("the session's own name is its profile's account", () => {
    const rows = [
      { name: "acme", username: "a@x.test", roles: [] },
      { name: "acme@two", username: "b@x.test", roles: [] },
    ];
    expect(loginAccounts("acme", "acme", [], rows)).toEqual([
      { account: "acme", user: "a@x.test", roles: [], profile: true },
      { account: "acme@two", user: "b@x.test", roles: [] },
    ]);
  });
});

// a site with no login spec: two-page and one-page forms, a wrong password, a decoy
describe("page-login on a real page", () => {
  let signedIn = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const html = (b: string) => res.writeHead(200, { "content-type": "text/html" }).end(b);
      const form = new URLSearchParams(body);
      if (req.url === "/login")
        return html(`<form method=post action=/session><label>Email <input name=email type=email></label>
          <label>Password <input name=password type=password></label><button>Sign in</button></form>
          <form action=/news><input name=newsletter placeholder="Your email"></form>`);
      if (req.url === "/start")
        return html(`<form method=post action=/next><input name=username autocomplete=username>
          <button>Next</button></form>`);
      if (req.url === "/next")
        return html(`<form method=post action=/session><input type=hidden name=email value="${form.get("username")}">
          <input name=pw type=password><button type=submit>Log in</button></form>`);
      if (req.url === "/session") {
        if (
          form.get("email") === "me@acme.test" &&
          (form.get("password") ?? form.get("pw")) === "s3cret"
        ) {
          signedIn = true;
          return res.writeHead(302, { location: "/home" }).end();
        }
        return res.writeHead(302, { location: "/login" }).end();
      }
      return html(signedIn ? "<p>Your dashboard</p>" : "<p>Welcome</p>");
    });
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const runnerWith = (password: string) => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-page-login-"));
    return flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      {
        pace: HUMAN_PACE,
        login: loginProvider([], {
          credentials: memoryCredentials({
            acme: { username: "me@acme.test", password, url: `${base}/login` },
          }),
          codes: totpSource(),
        }),
      },
    );
  };
  const signsIn = (path: string) =>
    defineFlow<undefined, string>({
      site: "acme",
      name: "sign-in",
      async run(fp) {
        await fp.open(`${base}${path}`, { allowWall: true });
        await fp.signIn("acme");
        return new URL(fp.url()).pathname;
      },
    });

  it("one-page form: types both boxes, never the decoy, and lands signed in", async () => {
    signedIn = false;
    expect(await runnerWith("s3cret").run(signsIn("/login"), undefined)).toBe("/home");
    expect(signedIn).toBe(true);
  }, 60_000);

  it("two-page form: the name, then the password", async () => {
    signedIn = false;
    expect(await runnerWith("s3cret").run(signsIn("/start"), undefined)).toBe("/home");
    expect(signedIn).toBe(true);
  }, 60_000);

  it("a wrong password fails once, no retype", async () => {
    signedIn = false;
    const err = await runnerWith("wrong")
      .run(signsIn("/login"), undefined)
      .catch((e: unknown) => e);
    // the runner wraps it: FlowFailed "acme/sign-in: acme: the form came back …"
    expect(String(err)).toContain("acme: the form came back after the password");
    expect(signedIn).toBe(false);
  }, 60_000);
});
