import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials, totp } from "credvault";
import { describe, expect, it } from "vitest";
import type { Settings } from "../src/app/config.js";
import { credentialsFor } from "../src/app/services.js";
import {
  codeSources,
  credentialFor,
  extractCode,
  formLogin,
  inboxLock,
  LoginFailed,
  landAfterOauth,
  loginProvider,
  type Message,
  messageSource,
  passwordOf,
  resolveLogin,
  type SignInContext,
  SignInHeld,
  type SignInHolds,
  type SignInTry,
  type SiteLogin,
  totpSource,
  viaLogin,
} from "../src/auth/index.js";
import { EMAIL_CODE, EMAIL_CODE_PAGE, type Hold, liftHolds, nextHold } from "../src/auth/login.js";
import { DAY_MS } from "../src/auth/sign-in-holds.js";
import type { FlowPage } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import { fakePage } from "./auth-fakes.js";
import { fakeSite } from "./site-fakes.js";

// RFC 6238 test vector: secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("autobrowse's names in the vault", () => {
  it("reads credentials from AUTOBROWSE_CRED_* env ahead of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-creds-"));
    const settings = {
      credentialsCipher: "none",
      credentialsFile: join(dir, "c.json"),
    } as Settings;
    const env = { AUTOBROWSE_CRED_X_USERNAME: "u", AUTOBROWSE_CRED_X_PASSWORD: "p" };
    Object.assign(process.env, env);
    try {
      const store = credentialsFor(settings, { armed: false });
      expect((await store.get("x"))?.username).toBe("u");
      expect(await store.list()).toContain("x");
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
});

describe("code sources", () => {
  const cred = { username: "u@x.co", password: "p", totpSecret: RFC_SECRET, recoveryCodes: [] };
  it("extracts the code near the word code", () => {
    expect(extractCode("Your Instantly code is 482913. Expires in 10 minutes (600 seconds).")).toBe(
      "482913",
    );
    expect(extractCode("Order 12345678 shipped")).toBe("12345678");
    expect(extractCode("nothing")).toBeNull();
    expect(extractCode("FB-48291 is your Facebook confirmation code")).toBe("48291");
    expect(extractCode("Your confirmation code: 48291")).toBe("48291");
    expect(extractCode("Welcome, member since 2026")).toBeNull();
    expect(extractCode("Here is the pin that you requested: A1B2C3 The team")).toBe("A1B2C3");
    expect(extractCode("If you didn't request this PIN, no action is needed")).toBeNull();
  });
  it("totp waits out a code about to expire", async () => {
    const waits: number[] = [];
    let t = 58_000;
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
    };
    const src = totpSource({ now: () => t, sleep });
    const code = await src.get({ site: "s", kind: "totp", since: new Date(0) }, cred);
    expect(waits).toEqual([2_000]);
    expect(code).toBe(totp(RFC_SECRET, { at: 60_000 }));
    expect(await src.get({ site: "s", kind: "email", since: new Date(0) }, cred)).toBeNull();
  });
  it("email polls until a fresh message with the hint carries a code", async () => {
    const inbox: Message[] = [
      { from: "old@x", subject: "code 111111", text: "", at: new Date(1_000) },
    ];
    let polls = 0;
    const reader = {
      async recent(_inbox: string, since: Date) {
        polls++;
        if (polls === 2)
          inbox.push({
            from: "no-reply@instantly.ai",
            subject: "Your code",
            text: "code: 222222",
            at: new Date(5_000),
          });
        return inbox.filter((m) => m.at >= since);
      },
    };
    let t = 10_000;
    const src = messageSource({
      kind: "email",
      reader,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 1_000,
    });
    const code = await src.get(
      { site: "instantly", kind: "email", since: new Date(2_000), hint: "instantly" },
      cred,
    );
    expect(code).toBe("222222");
    expect(polls).toBe(2);
  });
  it("email gives up at the deadline", async () => {
    let t = 0;
    const src = messageSource({
      kind: "email",
      reader: { recent: async () => [] },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(await src.get({ site: "s", kind: "email", since: new Date(0) }, cred)).toBeNull();
  });
  it("a code typed once is never handed to the next sign-in on the same phone", async () => {
    let t = 0;
    const src = messageSource({
      kind: "sms",
      inbox: "+15555550182",
      reader: {
        recent: async () => [{ from: "Google", subject: "", text: "G-111111", at: new Date(1) }],
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 2_000,
    });
    const req = { site: "google", kind: "sms" as const, since: new Date(0) };
    expect(await src.get(req, cred)).toBe("111111");
    expect(await src.get(req, cred)).toBeNull();
  });
  it("asks on one inbox queue: the second waits for the first to let go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "locks-"));
    const order: string[] = [];
    const first = await inboxLock("+15555550182", { dir, pollMs: 5 });
    const second = inboxLock("+1 555 555 0182".replace(/ /g, ""), { dir, pollMs: 5 }).then(
      (release) => {
        order.push("second");
        return release;
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    order.push("first done");
    await first();
    await (await second)();
    expect(order).toEqual(["first done", "second"]);
    // A holder that died long ago is taken over.
    await inboxLock("+15555550182", { dir });
    const again = await inboxLock("+15555550182", { dir, staleMs: -1 });
    await again();
  });
  it("first source with an answer wins", async () => {
    const src = codeSources(
      { get: async () => null, offers: () => false, inbox: () => null },
      { get: async () => "9", offers: () => true, inbox: () => "x" },
    );
    expect(await src.get({ site: "s", kind: "sms", since: new Date(0) }, cred)).toBe("9");
  });
});

/** A page as a script: what `text()` says after each act, and which hints exist. */
const spec = {
  start: "https://site.test/login",
  username: { role: "textbox", name: "Email" },
  password: { role: "textbox", name: "Password" },
  submit: { role: "button", name: "Log in" },
  code: {
    kind: "totp" as const,
    asks: /authenticator/i,
    field: { role: "textbox", name: "Code" },
    submit: { role: "button", name: "Continue" },
  },
  rejected: /incorrect/i,
  success: /dashboard/i,
};

describe("formLogin", () => {
  const cred = { username: "u", password: "p", totpSecret: RFC_SECRET, recoveryCodes: [] };
  it("fills username and password, then the code when asked, and checks success", async () => {
    const { fp, acts } = fakePage({
      text: ["login", "Enter the code from your authenticator", "Dashboard"],
      present: () => true,
    });
    const asked: string[] = [];
    const code = async (k: string) => {
      asked.push(k);
      return "123456";
    };
    await formLogin("s", spec)({ fp, cred, code });
    expect(asked).toEqual(["totp"]);
    expect(acts.map((a) => a.op)).toEqual([
      { kind: "fill", value: "u" },
      { kind: "fill", value: "p", into: "password" },
      { kind: "script", js: "(el) => { if (!el.checked) el.click(); }" }, // keep me signed in
      { kind: "click" },
      { kind: "fill", value: "123456", into: "code" },
      { kind: "click" },
    ]);
  });
  it("stops on a rejected password instead of retrying into a lockout", async () => {
    const { fp } = fakePage({
      text: ["login", "Incorrect email or password"],
      present: () => true,
    });
    await expect(formLogin("s", spec)({ fp, cred, code: async () => "1" })).rejects.toThrow(
      LoginFailed,
    );
  });
  it("answers a key prompt with our passkey, and then asks for no code", async () => {
    const withKey = {
      ...spec,
      passkey: { asks: /security key/i, start: { role: "button", name: "Use security key" } },
    };
    const { fp, acts } = fakePage({
      text: ["login", "Security key: ready to authenticate (2FA)", "Dashboard 2FA banner"],
      present: () => true,
    });
    const asked: string[] = [];
    const passkeys = [
      {
        rpId: "site.test",
        credentialId: "c",
        privateKey: "k",
        signCount: 1,
        isResidentCredential: false,
      },
    ];
    await formLogin("s", { ...withKey, code: { ...spec.code, asks: /2fa/i } })({
      fp,
      cred: { ...cred, passkeys },
      code: async (k) => {
        asked.push(k);
        return "1";
      },
    });
    expect(asked).toEqual([]);
    expect(acts.at(-1)?.hints).toEqual({ role: "button", name: "Use security key" });
  });
  it("fails loudly when the page is still not signed in", async () => {
    const { fp } = fakePage({ text: ["login", "something else"], present: () => true });
    await expect(formLogin("s", spec)({ fp, cred, code: async () => "1" })).rejects.toThrow(
      /the form came back after the password/,
    );
  });
  it("answers the pages in the order the site shows them: a remembered user opens on the password", async () => {
    const site = fakeSite(
      {
        password: {
          has: ["textbox:Password", "button:Log in"],
          text: "Welcome back, u",
          on: { "click button:Log in": "code" },
        },
        code: {
          has: ["textbox:Code", "button:Continue"],
          text: "Enter the code from your authenticator",
          on: { "click button:Continue": "home" },
        },
        home: { url: "https://site.test/home", has: [], text: "Dashboard" },
      },
      "password",
    );
    await formLogin("s", spec)({ fp: site.fp, cred, code: async () => "123456" });
    expect(site.acts).toEqual([
      "fill Password=p",
      "click Log in",
      "fill Code=123456",
      "click Continue",
    ]);
  });
});

describe("loginProvider", () => {
  const site: SiteLogin = {
    site: "s",
    home: "https://site.test/",
    loggedIn: async () => true,
    async signIn({ code }) {
      await code("totp");
    },
  };
  it("signs in with the stored credential and a code from the sources", async () => {
    const login = loginProvider([site], {
      credentials: memoryCredentials({
        s: { username: "u", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("signed-in");
    expect(await login(fakePage({ text: [], present: () => true }).fp, "other")).toBe(
      "unknown-site",
    );
  });
  it("a site with no login, on a provider's sign-in surface, signs in as the provider (youtube → google)", async () => {
    const ran: string[] = [];
    const provider: SiteLogin = {
      site: "p",
      home: "https://p.test/",
      properties: ["prod.test"],
      loggedIn: async () => true,
      signIn: async () => {
        ran.push("signIn");
      },
      signInHere: {
        at: /^https:\/\/id\.p\.test\//,
        run: async ({ cred }) => {
          ran.push(`here as ${cred.username}`);
        },
      },
    };
    // an app on the same surface, named first: the provider (it names products) still wins
    const app: SiteLogin = { ...provider, site: "papp", credential: "p", properties: [] };
    const login = loginProvider([app, provider], {
      credentials: memoryCredentials({
        p: { username: "u", password: "p" },
        "p@two": { username: "u2", password: "p2" },
      }),
      codes: totpSource(),
    });
    const at = (url: string) => fakePage({ text: [], present: () => true, url }).fp;
    expect(await login(at("https://id.p.test/signin"), "prod@two")).toBe("signed-in");
    expect(ran).toEqual(["here as u2"]);
    // bare: never the provider's main account on its own
    expect(await login(at("https://id.p.test/signin"), "prod")).toBe("unknown-site");
    expect(await login(at("https://prod.test/"), "prod@two")).toBe("unknown-site");
    // the account the agent picked, by stored name or role, as explore lists them
    ran.length = 0;
    expect(await login(at("https://id.p.test/signin"), "p", "p@two")).toBe("signed-in");
    expect(await login(at("https://id.p.test/signin"), "papp", "two")).toBe("signed-in");
    expect(await login(at("https://id.p.test/signin"), "p", "p")).toBe("signed-in");
    expect(ran).toEqual(["here as u2", "here as u2", "here as u"]);
  });
  const memHolds = () => {
    const marks: Record<string, Hold> = {};
    const holds: SignInHolds = {
      get: (n) => marks[n] ?? null,
      set: (n, h) => {
        marks[n] = h;
      },
      clear: (n) => {
        delete marks[n];
      },
    };
    return { marks, holds };
  };
  const MIN = 60_000;
  it.each([
    ["password rejected", false, "password", DAY_MS, true],
    ["too many failed attempts", false, "account", DAY_MS, true],
    ["code rejected", false, "code", MIN, false],
    ["still on the login page", false, "ours", MIN, false],
    ["still on the login page", true, "unproven", 10 * MIN, false],
    ["still on the login page", "missed", "ours", MIN, false],
  ] as const)(
    "a failed sign-in (%s, typed a password: %s) is case %s: no try till the hold ends; only a strict hold needs a person",
    async (why, types, failCase, ms, strict) => {
      let tries = 0;
      const refusing: SiteLogin = {
        site: "s",
        home: "https://site.test/",
        // the check after a typed secret finds no session: a real failure
        loggedIn: async () => false,
        async signIn(c) {
          tries++;
          if (types)
            await c.fp
              .act(
                { kind: "fill", value: passwordOf("s", c.cred) },
                { role: "textbox" },
                { goal: "g" },
              )
              .catch(() => undefined);
          throw new LoginFailed("s", why);
        },
      };
      const { marks, holds } = memHolds();
      let t = Date.parse("2026-10-29T00:00:00Z");
      const notes: string[] = [];
      const rows: SignInTry[] = [];
      const login = loginProvider([refusing], {
        credentials: memoryCredentials({ s: { username: "u", password: "pass-1" } }),
        codes: totpSource(),
        holds,
        tries: { add: (r) => rows.push(r) },
        random: () => 0.5,
        notify: async (n) => {
          notes.push(n);
        },
        now: () => new Date(t),
      });
      const page = () => {
        const { fp } = fakePage({ text: [], present: () => true });
        // a locate miss throws before anything is typed
        if (types === "missed")
          fp.act = async () => {
            throw new Error("textbox not visible after 15 s");
          };
        return fp;
      };
      await expect(login(page(), "s")).rejects.toThrow(why);
      expect(marks.s).toMatchObject({ case: failCase, fails: 1, strict, until: t + ms });
      t += ms - 1;
      const held = login(page(), "s");
      await expect(held).rejects.toThrow(/no sign-in till/);
      await expect(held).rejects.toBeInstanceOf(strict ? NeedsHuman : SignInHeld);
      expect(tries).toBe(1);
      expect(notes).toEqual(strict ? [expect.stringMatching(`\\(${failCase}\\)`)] : []);
      expect(rows.map((r) => [r.outcome, r.case])).toEqual([
        ["failed", failCase],
        ["held", failCase],
      ]);
      expect(rows[0]?.typed).toEqual({ password: types === true ? 1 : 0, code: 0 });
      t += 2;
      await expect(login(page(), "s")).rejects.toThrow(why);
      expect(tries).toBe(2);
      expect(marks.s?.fails).toBe(2);
    },
  );
  it("the ladder climbs 1, 3, 5, 10, 30, 60 min and stays; jitter is ±20 %; a sign-in that works resets it", async () => {
    let ok = false;
    const flaky: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => ok,
      async signIn() {
        if (!ok) throw new LoginFailed("s", "no form on the page");
      },
    };
    const { marks, holds } = memHolds();
    let t = Date.parse("2026-11-26T00:00:00Z");
    const login = loginProvider([flaky], {
      credentials: memoryCredentials({ s: { username: "u", password: "pass-1" } }),
      codes: totpSource(),
      holds,
      random: () => 0.5,
      now: () => new Date(t),
    });
    const fp = () => fakePage({ text: [], present: () => true }).fp;
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await expect(login(fp(), "s")).rejects.toThrow(/no form/);
      const h = marks.s as Hold;
      waits.push((h.until - t) / MIN);
      t = h.until;
    }
    expect(waits).toEqual([1, 3, 5, 10, 30, 60, 60]);
    expect(marks.s?.strict).toBe(false);
    ok = true;
    expect(await login(fp(), "s")).toBe("signed-in");
    expect(marks.s).toBeUndefined();
    expect(nextHold("ours", "e", null, 0, () => 0).until).toBe(0.8 * MIN);
    expect(nextHold("ours", "e", null, 0, () => 0.999999).until).toBe(1.2 * MIN);
  });
  it("caps per 24 h: the third unproven password and the sixth code failure hold 24 h for a person", () => {
    let h: Hold | null = null;
    const t0 = Date.parse("2026-11-26T00:00:00Z");
    const seen: [string, boolean | undefined][] = [];
    for (let i = 0; i < 3; i++) {
      h = nextHold("unproven", "e", h, t0 + i * 2 * 60 * MIN, () => 0.5);
      seen.push([`${(h.until - (t0 + i * 2 * 60 * MIN)) / MIN}`, h.strict]);
    }
    expect(seen).toEqual([
      ["10", false],
      ["30", false],
      [`${DAY_MS / MIN}`, true],
    ]);
    // a day later the old ones age out
    expect(nextHold("unproven", "e", h, t0 + DAY_MS + 5 * 60 * MIN, () => 0.5).strict).toBe(false);
    let c: Hold | null = null;
    for (let i = 0; i < 6; i++) c = nextHold("code", "e", c, t0 + i * MIN * 90, () => 0.5);
    expect(c?.strict).toBe(true);
    // nothing typed: no cap, ever
    let o: Hold | null = null;
    for (let i = 0; i < 20; i++) o = nextHold("ours", "e", o, t0 + i * MIN * 61, () => 0.5);
    expect(o?.strict).toBe(false);
  });
  it("a password then an act on another page proves it: a failure after is `later`, not `unproven`", async () => {
    let url = "https://site.test/login";
    const later: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => false,
      async signIn(c) {
        await c.fp.act(
          { kind: "fill", value: passwordOf("s", c.cred) },
          { role: "textbox" },
          { goal: "g" },
        );
        url = "https://site.test/choose-account";
        await c.fp.act({ kind: "click" }, { role: "button", name: "Personal" }, { goal: "g" });
        throw new LoginFailed("s", "a page no screen knows");
      },
    };
    const { marks, holds } = memHolds();
    const login = loginProvider([later], {
      credentials: memoryCredentials({ s: { username: "u", password: "pass-1" } }),
      codes: totpSource(),
      holds,
      random: () => 0.5,
      now: () => new Date(0),
    });
    const { fp } = fakePage({ text: [], present: () => true, url: () => url });
    fp.open = async (u) => {
      url = u;
    };
    await expect(login(fp, "s")).rejects.toThrow(/no screen knows/);
    expect(marks.s).toMatchObject({ case: "later", until: MIN, strict: false });
  });
  it("a provider's password counts as a password, a code as a code", async () => {
    const both: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => false,
      async signIn(c) {
        const g = await c.credFor("p");
        await c.fp.act(
          { kind: "fill", value: passwordOf("p", g) },
          { role: "textbox" },
          { goal: "g" },
        );
        await c.fp.act(
          { kind: "fill", value: await c.code("totp") },
          { role: "textbox" },
          { goal: "g" },
        );
        throw new LoginFailed("s", "still on the code page");
      },
    };
    const { marks, holds } = memHolds();
    const rows: SignInTry[] = [];
    const login = loginProvider([both], {
      credentials: memoryCredentials({
        s: { username: "u", password: "pass-1", totpSecret: "JBSWY3DPEHPK3PXP" },
        p: { username: "pu", password: "provider-pass" },
      }),
      codes: totpSource(),
      holds,
      tries: { add: (r) => rows.push(r) },
      random: () => 0.5,
      now: () => new Date(0),
    });
    await expect(login(fakePage({ text: [], present: () => true }).fp, "s")).rejects.toThrow();
    expect(rows[0]?.typed).toEqual({ password: 1, code: 1 });
    expect(marks.s?.case).toBe("code");
  });
  it.each([
    [
      "signed in after all",
      async () => true,
      "signed-in",
      null,
      [/flow bug after a good password: .*account\/access/],
    ],
    ["not signed in", async () => false, "throws", 10 * MIN, []],
    [
      "the check fails",
      async () => {
        throw new Error("page crashed");
      },
      "throws",
      10 * MIN,
      [],
    ],
  ] as const)(
    "a failure past a typed password checks the session first (%s)",
    async (_why, loggedIn, outcome, ms, note) => {
      let url = "https://x.test/account/access";
      const opened: string[] = [];
      const misreads: SiteLogin = {
        site: "s",
        home: "https://x.test/home",
        loggedIn,
        async signIn(c) {
          await c.fp.act(
            { kind: "fill", value: passwordOf("s", c.cred) },
            { role: "textbox" },
            { goal: "g" },
          );
          throw new LoginFailed("s", "no code box on the next page");
        },
      };
      const { marks, holds } = memHolds();
      const t = Date.parse("2026-11-26T00:00:00Z");
      const notes: string[] = [];
      const login = loginProvider([misreads], {
        credentials: memoryCredentials({ s: { username: "u", password: "pass-1" } }),
        codes: totpSource(),
        holds,
        random: () => 0.5,
        notify: async (n) => {
          notes.push(n);
        },
        now: () => new Date(t),
      });
      const { fp } = fakePage({ text: [], present: () => true, url: () => url });
      fp.open = async (u) => {
        opened.push(u);
        url = u;
      };
      const run = login(fp, "s");
      if (outcome === "signed-in") await expect(run).resolves.toBe("signed-in");
      else await expect(run).rejects.toThrow(/no code box/);
      expect(opened).toEqual(["https://x.test/home"]);
      expect(marks.s?.until ?? null).toBe(ms === null ? null : t + ms);
      expect(notes).toEqual(note.map((n) => expect.stringMatching(n)));
    },
  );
  it("a refusal the site said is held with no session check", async () => {
    let checked = false;
    const refused: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => {
        checked = true;
        return true;
      },
      async signIn(c) {
        await c.fp.act(
          { kind: "fill", value: passwordOf("s", c.cred) },
          { role: "textbox" },
          { goal: "g" },
        );
        throw new LoginFailed("s", "password rejected", true);
      },
    };
    const login = loginProvider([refused], {
      credentials: memoryCredentials({ s: { username: "u", password: "pass-1" } }),
      codes: totpSource(),
    });
    await expect(login(fakePage({ text: [], present: () => true }).fp, "s")).rejects.toThrow(
      /password rejected/,
    );
    expect(checked).toBe(false);
  });
  it("a changed login lifts its holds under every name that reaches it, not another account's", () => {
    const hold = { until: Date.parse("2026-11-18T16:00:00Z"), error: "x: password rejected" };
    const marks: Record<string, typeof hold> = {
      "x@main": hold,
      "x@old_handle": hold,
      "x@lana": hold,
      gmail: hold,
    };
    const holds: SignInHolds = {
      get: (n) => marks[n] ?? null,
      set: (n, h) => {
        marks[n] = h;
      },
      clear: (n) => {
        delete marks[n];
      },
    };
    const lifted = liftHolds(
      holds,
      "x@wren",
      { username: "new_handle", roles: ["main"] },
      "old_handle",
    );
    expect(lifted.sort()).toEqual(["x@main", "x@old_handle"]);
    expect(Object.keys(marks).sort()).toEqual(["gmail", "x@lana"]);
    expect(liftHolds(holds, "x@wren", { username: "new_handle", roles: ["main"] })).toEqual([]);
  });
  it("answers codes for the credential an OAuth sign-in swaps in, not the site's own", async () => {
    const viaGoogle: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        const sub = ctx.as(await ctx.credFor("google"));
        expect(sub.offers("totp")).toBe(true);
        expect(ctx.offers("totp")).toBe(false);
        await sub.code("totp");
      },
    };
    const login = loginProvider([viaGoogle], {
      credentials: memoryCredentials({
        s: { username: "u", password: "-", via: "google" },
        google: { username: "g", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("signed-in");
  });
  it("hands the provider credential for the account the site names: the stored one, a second `google@ops`, or a clear miss", async () => {
    const seen: string[] = [];
    const viaGoogle: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        seen.push((await ctx.credFor("google", ctx.cred.username)).password ?? "");
      },
    };
    const store = memoryCredentials({
      s: { username: "Ops@x.com ", via: "google" },
      t: { username: "g@x.com", via: "google" },
      u: { username: "nobody@x.com", via: "google" },
      google: { username: "g@x.com", password: "main" },
      "google@ops": { username: "ops@x.com", password: "second" },
    });
    const login = loginProvider(
      [viaGoogle, { ...viaGoogle, site: "t" }, { ...viaGoogle, site: "u" }],
      {
        credentials: store,
        codes: totpSource(),
      },
    );
    const page = () => fakePage({ text: [], present: () => true }).fp;
    expect(await login(page(), "s")).toBe("signed-in");
    expect(await login(page(), "t")).toBe("signed-in");
    expect(seen).toEqual(["second", "main"]);
    await expect(login(page(), "u")).rejects.toThrow(/no google credential for nobody@x.com/);
  });
  it("one account, several ways in: the password first, the provider when it is refused", async () => {
    const tried: string[] = [];
    let refuse = false;
    const both: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        tried.push(ctx.cred.via ? `via ${ctx.cred.username}` : `password ${ctx.cred.username}`);
        if (refuse && !ctx.cred.via) throw new LoginFailed("s", "password rejected");
      },
    };
    const login = loginProvider([both], {
      credentials: memoryCredentials({
        s: { username: "handle", password: "p", via: "google", codesInbox: "me@x.com" },
      }),
      codes: totpSource(),
    });
    const page = () => fakePage({ text: [], present: () => true }).fp;
    expect(await login(page(), "s")).toBe("signed-in");
    refuse = true;
    expect(await login(page(), "s")).toBe("signed-in");
    expect(tried).toEqual(["password handle", "password handle", "via me@x.com"]);
    // The provider route finds the account by its address too.
    expect(await login(page(), "s", "me@x.com")).toBe("signed-in");
  });
  it("reports a missing credential and a missing code", async () => {
    const login = loginProvider([site], {
      credentials: memoryCredentials(),
      codes: { get: async () => null, offers: () => false, inbox: () => null },
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("no-credential");
    const withCred = loginProvider([site], {
      credentials: memoryCredentials({ s: { username: "u", password: "p" } }),
      codes: { get: async () => null, offers: () => false, inbox: () => null },
    });
    await expect(withCred(fakePage({ text: [], present: () => true }).fp, "s")).rejects.toThrow(
      /no totp code/,
    );
  });
});

describe("sign in via a provider on a site nobody wrote a spec for", () => {
  /** A site login page, then the provider's page, then the site signed in; `present` answers the button and the consent. */
  function viaPage(urls: string[]) {
    let at = 0;
    const acts: Hints[] = [];
    const fp: FlowPage = {
      captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
      page: {} as FlowPage["page"],
      async open() {},
      url: () => urls[Math.min(at, urls.length - 1)] as string,
      text: async () => "Your workspace", // a page with words; a blank one is a spinner
      html: async () => "",
      has: async (h) => h.name === "/google/i" || h.name === "/^continue$/i",
      // Time passes: the page moves on one step per wait, as a real round trip would.
      wait: async () => {
        at++;
      },
      answer: async () => {},
      waitForUrl: async () => {
        at++;
        return true;
      },
      nextPage: async () => null,
      pages: () => [],
      switchTo() {},
      async act(_op, hints) {
        acts.push(hints);
      },
      human(reason) {
        throw new NeedsHuman(reason);
      },
    };
    return { fp, acts };
  }

  it("takes the provider path when the credential says via, presses its button, signs in there, lands", async () => {
    const { fp, acts } = viaPage([
      "https://new.test/login",
      "https://accounts.google.com/o/oauth2/auth",
      "https://new.test/app",
    ]);
    const login = loginProvider([], {
      credentials: memoryCredentials({
        "new.test": { username: "me@x.test", via: "google" },
        google: { username: "me@x.test", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fp, "new.test")).toBe("signed-in");
    expect(acts[0]).toEqual({ role: "button", name: "/google/i" });
  });

  it("a password-less credential is refused by a form login, in words", async () => {
    const { fp } = fakePage({ text: [], present: () => true });
    await expect(
      formLogin(
        "s",
        spec,
      )({
        fp,
        cred: { username: "u", via: "google", recoveryCodes: [], passkeys: [] },
        code: async () => "1",
        offers: () => false,
        inbox: () => null,
        credFor: async () => {
          throw new Error("x");
        },
        as: () => {
          throw new Error("x");
        },
      }),
    ).rejects.toThrow(/no password .*via google/);
  });
});

describe("sign in by an emailed code, no password", () => {
  const E = `css:${EMAIL_CODE_PAGE.email.css}`;
  const C = `css:${EMAIL_CODE_PAGE.code.css}`;
  const GO = `css:${EMAIL_CODE_PAGE.submit.css}`;
  const cred = {
    username: "me@x.test",
    via: EMAIL_CODE,
    url: "https://cap.test/login",
    recoveryCodes: [],
    passkeys: [],
  };
  const home = { url: "https://cap.test/dashboard", has: [], text: "Your recordings" };

  it("types the address, reads the code sent after it, types it, lands", async () => {
    const site = fakeSite(
      {
        email: { has: [E, GO], text: "Sign in", on: { [`click ${GO}`]: "code" } },
        // The boxes submit on the last digit: no button.
        code: { has: [C], text: "Check your email", on: { [`fill ${C}`]: "home" } },
        home,
      },
      "email",
    );
    const asked: { kind: string; after?: Date }[] = [];
    const login = viaLogin("cap", cred);
    await login.signIn({
      fp: site.fp,
      cred,
      code: async (kind, _hint, after) => {
        asked.push({ kind, ...(after ? { after } : {}) });
        return "424242";
      },
    } as never);
    expect(site.at()).toBe("home");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("email");
    expect(asked[0]?.after).toBeInstanceOf(Date);
    expect(site.acts[0]).toMatch(/^fill .*=me@x\.test$/);
    expect(site.acts[2]).toMatch(/=424242$/);
  });

  it("presses a Verify button that sits outside any form", async () => {
    const site = fakeSite(
      {
        email: { has: [E, GO], text: "Sign in", on: { [`click ${GO}`]: "code" } },
        code: {
          has: [C, "button:Verify Code"],
          text: "We sent a 6-digit code",
          on: { "click button:Verify Code": "home" },
        },
        home,
      },
      "email",
    );
    await viaLogin("cap", cred).signIn({ fp: site.fp, cred, code: async () => "424242" } as never);
    expect(site.at()).toBe("home");
    expect(site.acts.at(-1)).toBe("click Verify Code");
  });

  it("a code the site refuses is a failure, never a second code", async () => {
    const site = fakeSite(
      {
        email: { has: [E, GO], text: "Sign in", on: { [`click ${GO}`]: "code" } },
        code: { has: [C, GO], text: "Wrong code", on: {} },
      },
      "email",
    );
    let codes = 0;
    await expect(
      viaLogin("cap", cred).signIn({
        fp: site.fp,
        cred,
        code: async () => {
          codes++;
          return "1";
        },
      } as never),
    ).rejects.toThrow(LoginFailed);
    expect(codes).toBe(1);
  });
});

describe("loginProvider on the site's own sign-in page", () => {
  it("answers in place instead of opening home", async () => {
    const calls: string[] = [];
    const site: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => true,
      async signIn() {
        calls.push("signIn");
      },
      signInHere: {
        at: /accounts\.site\.test/,
        async run() {
          calls.push("here");
        },
      },
    };
    const login = loginProvider([site], {
      credentials: memoryCredentials({ s: { username: "u", password: "p" } }),
      codes: totpSource(),
    });
    const onWall = fakePage({
      text: [],
      present: () => true,
      url: "https://accounts.site.test/pwd",
    });
    onWall.fp.waitForUrl = async () => false; // the page never leaves the sign-in surface
    await expect(login(onWall.fp, "s")).rejects.toThrow(
      /not signed in 30s after the form: https:\/\/accounts\.site\.test\/pwd/,
    );
    expect(calls).toEqual(["here"]);
    const elsewhere = fakePage({ text: [], present: () => true, url: "https://site.test/x" });
    expect(await login(elsewhere.fp, "s")).toBe("signed-in");
    expect(calls).toEqual(["here", "signIn"]);
  });

  it("a page past the sign-in on that surface counts as signed in", async () => {
    const site: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => true,
      async signIn() {},
      signInHere: {
        at: /accounts\.site\.test/,
        past: /accounts\.site\.test\/grant/,
        async run() {},
      },
    };
    const login = loginProvider([site], {
      credentials: memoryCredentials({ s: { username: "u", password: "p" } }),
      codes: totpSource(),
    });
    const url = "https://accounts.site.test/grant";
    const grant = fakePage({ text: [], present: () => true, url });
    grant.fp.waitForUrl = async (want) => (typeof want === "function" ? want(url) : false);
    expect(await login(grant.fp, "s")).toBe("signed-in");
  });
});

describe("landAfterOauth", () => {
  const spec = {
    success: /console\.x\.test\//,
    challenge: {
      at: /login\.x\.test\/mfa/,
      async run(ctx: SignInContext) {
        await ctx.fp.act({ kind: "fill", value: await ctx.code("sms") }, { id: "code" });
      },
    },
  };
  const at = (urls: string[]) => {
    const { fp, acts } = fakePage({ text: [], present: () => true });
    let i = 0;
    fp.url = () => urls[Math.min(i, urls.length - 1)] ?? "";
    fp.waitForUrl = async (p) => {
      i = Math.min(i + 1, urls.length - 1);
      return p instanceof RegExp ? p.test(fp.url()) : p(fp.url());
    };
    const ctx = {
      fp,
      cred: { username: "u", password: "p" },
      code: async () => "424242",
      offers: () => true,
      inbox: () => null,
      credFor: async () => ({ username: "g", password: "p" }),
      as: () => ctx,
    } as SignInContext;
    return { ctx, acts };
  };
  it("answers the site's challenge with the site's code, then reaches home", async () => {
    const { ctx, acts } = at([
      "https://accounts.google.test/",
      "https://login.x.test/mfa?s=1",
      "https://console.x.test/account/",
    ]);
    await landAfterOauth("x", spec, ctx);
    expect(acts).toEqual([{ op: { kind: "fill", value: "424242" }, hints: { id: "code" } }]);
  });
  it("skips the challenge when the site goes straight home, and fails when it goes nowhere", async () => {
    const home = at(["https://accounts.google.test/", "https://console.x.test/account/"]);
    await landAfterOauth("x", spec, home.ctx);
    expect(home.acts).toEqual([]);
    const stuck = at(["https://accounts.google.test/", "https://login.x.test/error"]);
    await expect(landAfterOauth("x", spec, stuck.ctx)).rejects.toThrow(
      /round trip: https:\/\/login\.x\.test\/error/,
    );
  });
});

describe("resolveLogin", () => {
  const sites = [
    { site: "google", home: "https://g", loggedIn: async () => true, signIn: async () => {} },
    {
      site: "cf",
      home: "https://c",
      credential: "google",
      loggedIn: async () => true,
      signIn: async () => {},
    },
  ] as const;
  it("a bare name is the spec itself", () => {
    expect(resolveLogin(sites, "google")).toBe(sites[0]);
    expect(credentialFor(sites, "cf")).toBe("google");
    expect(credentialFor(sites, "other")).toBe("other");
  });
  it("site@account is the same walk with its own credential and profile", () => {
    const l = resolveLogin(sites, "google@ops");
    expect(l).toMatchObject({ site: "google@ops", credential: "google@ops", home: "https://g" });
    expect(resolveLogin(sites, "nope@x")).toBeNull();
  });
  it("an app of a provider signs in as the provider, second accounts too", async () => {
    expect(resolveLogin(sites, "cf@ops")).toMatchObject({
      site: "cf@ops",
      credential: "google@ops",
    });
    const { SITE_LOGINS } = await import("../src/auth/sites.js");
    const { repoWalkLogins } = await import("../src/walks/login.js");
    const walks = [...SITE_LOGINS, ...repoWalkLogins()];
    for (const app of ["gmail", "drive", "calendar", "docs", "sheets"])
      expect(credentialFor(walks, app)).toBe("google");
    // the admin console runs on the Workspace admin account
    expect(credentialFor(walks, "google-admin")).toBe("google@admin");
    expect(credentialFor(walks, "gmail@will")).toBe("google@will");
    expect(credentialFor(walks, "outlook@work")).toBe("microsoft@work");
  });
});
