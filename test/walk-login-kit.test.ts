import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { totpSource } from "../src/auth/codes.js";
import {
  isPassword,
  LoginFailed,
  loginProvider,
  type SignInContext,
  type SignInHealAsk,
} from "../src/auth/login.js";
import { CODES_PER_TRY, enterCode, signInState } from "../src/auth/sign-in-kit.js";
import type { FlowPage } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";
import { walkFlow } from "../src/walks/flow.js";
import { repoWalkLogins, walkLogin } from "../src/walks/login.js";
import {
  addHealScreen,
  HEAL_EVERY_MS,
  type HealProposal,
  type HealWriter,
  healLog,
  healScreenOf,
  healSignIn,
  withHeal,
} from "../src/walks/login-heal.js";
import { LOGIN_WALK_FILES } from "../src/walks/logins/index.js";
import { regexOf, screenSpecSchema, type WalkSpec, walkSpecSchema } from "../src/walks/spec.js";
import { fakeSite, type State } from "./site-fakes.js";

const USER = { role: "textbox", name: "/username|email/i" };
const PASS = { role: "textbox", name: "/^password$/i" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/security code/i" };

/** A login walk as a repo file writes it: data only, defaults filled by the schema. */
const instagramLike = (more: object[] = []): WalkSpec =>
  walkSpecSchema.parse({
    site: "gram",
    name: "login",
    goal: "signed in to gram",
    start: "https://gram.test/accounts/login/",
    screens: [
      {
        name: "home",
        looks: "the feed",
        at: "/^https:\\/\\/gram\\.test\\/(?!accounts|challenge)/",
        goal: true,
      },
      {
        name: "login-form",
        looks: "username and password boxes",
        shows: [USER, PASS],
        ops: [
          { kind: "username", goal: "type username", field: USER },
          { kind: "password", goal: "type password", field: PASS, submit: LOG_IN },
        ],
      },
      {
        name: "rejected",
        looks: "the form says the password is wrong",
        says: "/password was incorrect/i",
        refused: { says: "password rejected", case: "password" },
      },
      {
        name: "locked",
        looks: "the account is locked",
        says: "/account (is )?locked/i",
        refused: { says: "account locked", case: "account" },
      },
      {
        name: "code",
        looks: "a security code box",
        at: "/two_factor/",
        ops: [
          {
            kind: "one-time-code",
            goal: "type the code",
            kinds: ["sms", "totp"],
            field: CODE,
            submit: { role: "button", name: "Confirm" },
            send: { role: "button", name: "Send code" },
          },
        ],
      },
      {
        name: "selfie",
        looks: "a video selfie check",
        says: "/video selfie/i",
        person: { why: "a check only a person can pass" },
      },
      ...more,
    ],
  });

const LOGIN: State = {
  url: "https://gram.test/accounts/login/",
  has: ["textbox:Username", "textbox:Password", "button:Log in"],
  on: { "click button:Log in": "code" },
};

function ctxFor(fp: FlowPage, cred: Partial<SignInContext["cred"]> = {}) {
  const asked: string[] = [];
  const steps: string[] = [];
  const ctx = {
    fp,
    cred: { username: "user-a", password: "pw-a-1", passkeys: [], recoveryCodes: [], ...cred },
    code: async (kind: string, _hint?: string, after?: Date) => {
      asked.push(`${kind}${after ? " newer" : ""}`);
      return "246810";
    },
    offers: (kind: string) => kind === "totp",
    inbox: () => null,
    steps,
  } as unknown as SignInContext;
  return { ctx, asked, steps };
}

describe("a login walk on the kit", () => {
  it("types the username, the password through passwordOf, then the code it can get; logs each screen", async () => {
    const s = fakeSite(
      {
        login: LOGIN,
        code: {
          url: "https://gram.test/accounts/login/two_factor/",
          has: ["button:Send code", "textbox:Security code", "button:Confirm"],
          on: { "click button:Confirm": "home" },
        },
        home: { url: "https://gram.test/", has: [] },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const { ctx, asked, steps } = ctxFor(s.fp);
    await walkLogin(instagramLike()).signIn(ctx);
    expect(s.acts).toEqual([
      "fill Username=user-a",
      "fill Password=pw-a-1",
      "click Log in",
      "click Send code",
      "fill Security code=246810",
      "click Confirm",
    ]);
    // sms is not offered: the next kind the box takes
    expect(asked).toEqual(["totp"]);
    expect(steps).toEqual(["login-form", "code"]);
    expect(isPassword("pw-a-1")).toBe(true);
  });

  it("a goal page before any secret is not the goal: the walk signs in first", async () => {
    const s = fakeSite(
      {
        // gram.test/ shows a login wall: it matches the goal's URL, but nothing was typed
        wall: { url: "https://gram.test/", has: LOGIN.has, on: { "click button:Log in": "home" } },
        home: { url: "https://gram.test/feed", has: [] },
      },
      "wall",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    await walkLogin(instagramLike()).signIn(ctxFor(s.fp).ctx);
    expect(s.acts).toContain("click Log in");
  });

  it("a rejected password: the previous one once, then a refusal with case password", async () => {
    const states = {
      login: { ...LOGIN, on: { "click button:Log in": "wrong" } },
      wrong: {
        ...LOGIN,
        text: "Sorry, your password was incorrect.",
        on: { "click button:Log in": "wrong" },
      },
    };
    const s = fakeSite(states, "login");
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const err = await walkLogin(instagramLike())
      .signIn(ctxFor(s.fp, { previousPassword: "pw-a-0" }).ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailed);
    expect(err).toMatchObject({ refused: true, case: "password" });
    expect(s.acts.filter((a) => a.startsWith("fill Password"))).toEqual([
      "fill Password=pw-a-1",
      "fill Password=pw-a-0",
    ]);

    const t = fakeSite(states, "login");
    t.fp.page = { url: t.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    await expect(walkLogin(instagramLike()).signIn(ctxFor(t.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    expect(t.acts.filter((a) => a.startsWith("fill Password"))).toEqual(["fill Password=pw-a-1"]);
  });

  it("a locked account is refused with case account", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "locked" } },
        locked: { has: [], text: "Your account is locked." },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    await expect(walkLogin(instagramLike()).signIn(ctxFor(s.fp).ctx)).rejects.toMatchObject({
      name: "LoginFailed",
      refused: true,
      case: "account",
    });
  });

  it("a page no screen knows fails the try (LoginFailed), never a person", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "odd" } },
        odd: { url: "https://gram.test/accounts/odd", has: ["button:Something new"] },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const err = await walkLogin(instagramLike())
      .signIn(ctxFor(s.fp).ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailed);
    expect((err as LoginFailed).message).toMatch(/does not know/);
    expect((err as LoginFailed).refused).toBe(false);
  });

  it("an op that breaks (a box gone) reaches the caller as LoginFailed", async () => {
    const s = fakeSite(
      // the username box shows, but the button was renamed: the click finds nothing
      { login: { ...LOGIN, has: ["textbox:Username", "textbox:Password", "button:Sign in"] } },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const err = await walkLogin(instagramLike())
      .signIn(ctxFor(s.fp).ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailed);
    expect((err as LoginFailed).refused).toBe(false);
    expect((err as LoginFailed).message).toMatch(/nothing matches/);
  });

  it("a person's screen asks a person and never fails the try", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "selfie" } },
        selfie: { has: [], text: "Take a video selfie" },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    await expect(walkLogin(instagramLike()).signIn(ctxFor(s.fp).ctx)).rejects.toThrow(NeedsHuman);
  });

  it("login walks keep file order: the site's screen before a later one that also matches", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "wrong" } },
        // both "rejected" and a later kit-like screen match; the file's first wins
        wrong: { ...LOGIN, text: "Sorry, your password was incorrect." },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const later = {
      name: "try-again",
      looks: "a try-again button",
      says: "/incorrect/i",
      landmarks: [],
      shows: [{ role: "button", name: "/^log in$/i" }],
      ops: [{ kind: "click", goal: "try again", hints: LOG_IN, irreversible: false }],
    };
    await expect(walkLogin(instagramLike([later])).signIn(ctxFor(s.fp).ctx)).rejects.toMatchObject({
      case: "password",
    });
  });
});

describe("a form that comes back after the password", () => {
  const back = (text?: string) =>
    fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "back" } },
        back: { ...LOGIN, ...(text ? { text } : {}), on: { "click button:Log in": "back" } },
      },
      "login",
    );
  const pwFills = (acts: string[]) => acts.filter((a) => a.startsWith("fill Password"));
  const run = (s: ReturnType<typeof fakeSite>, cred = {}) => {
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    return walkLogin(instagramLike())
      .signIn(ctxFor(s.fp, cred).ctx)
      .catch((e: unknown) => e);
  };

  it("with a locked banner: case account, one password, no previous", async () => {
    const s = back("Your account is locked.");
    expect(await run(s, { previousPassword: "pw-a-0" })).toMatchObject({
      refused: true,
      case: "account",
    });
    expect(pwFills(s.acts)).toEqual(["fill Password=pw-a-1"]);
  });

  it("saying nothing, with a previous password on file: no second password, a failed try", async () => {
    const s = back();
    const err = await run(s, { previousPassword: "pw-a-0" });
    expect(err).toBeInstanceOf(LoginFailed);
    expect((err as LoginFailed).refused).toBe(false);
    expect(pwFills(s.acts)).toEqual(["fill Password=pw-a-1"]);
  });
});

describe("a login walk and site calls", () => {
  it("never loads, learns or saves calls, and never listens to the page", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "home" } },
        home: { url: "https://gram.test/feed", has: [] },
      },
      "login",
    );
    const listened: string[] = [];
    s.fp.page = {
      url: s.fp.url,
      evaluate: async () => [],
      isClosed: () => false,
      on: (e: string) => listened.push(e),
      off: () => undefined,
    } as never;
    const used: string[] = [];
    const out = await walkFlow(instagramLike(), {
      signIn: { ctx: ctxFor(s.fp).ctx, state: signInState("gram") },
      calls: {
        load: () => {
          used.push("load");
          return null;
        },
        save: () => {
          used.push("save");
        },
      },
    }).run(s.fp, {});
    expect(out.goal).toBe("home");
    expect(used).toEqual([]);
    expect(listened).toEqual([]);
  });
});

describe("the walk schema's login rules", () => {
  const base = {
    site: "gram",
    goal: "x",
    start: "https://gram.test/",
    screens: [{ name: "home", looks: "home", at: "/home/", goal: true }],
  };
  const issues = (w: object) =>
    walkSpecSchema.safeParse(w).error?.issues.map((i) => i.message) ?? [];

  it("login ops run only in a walk named login", () => {
    const form = {
      name: "form",
      looks: "a form",
      shows: [PASS],
      ops: [{ kind: "password", goal: "pw", field: PASS, submit: LOG_IN }],
    };
    expect(issues({ ...base, name: "setup", screens: [...base.screens, form] })).toContain(
      "a password op runs only in a walk named login",
    );
    expect(issues({ ...base, name: "login", screens: [...base.screens, form] })).toEqual([]);
  });

  it("a login screen with nothing to check is refused: it would match every page", () => {
    const bare = {
      name: "any",
      looks: "any page",
      ops: [{ kind: "username", goal: "u", field: USER }],
    };
    expect(issues({ ...base, name: "login", screens: [...base.screens, bare] })).toContain(
      "a login screen needs url, landmarks, at, shows or says",
    );
  });

  it("refused is a login walk's, ends the step, and is one ending", () => {
    const refused = (more: object) => ({
      name: "no",
      looks: "no",
      says: "/no/",
      refused: { says: "no", case: "account" },
      ...more,
    });
    expect(issues({ ...base, name: "setup", screens: [...base.screens, refused({})] })).toContain(
      "refused is for a login walk",
    );
    expect(
      issues({
        ...base,
        name: "login",
        screens: [
          ...base.screens,
          refused({ ops: [{ kind: "click", goal: "c", hints: LOG_IN, irreversible: false }] }),
        ],
      }),
    ).toContain("it ends the step: no ops");
    expect(
      issues({
        ...base,
        name: "login",
        screens: [...base.screens, refused({ person: { why: "x" } })],
      }),
    ).toContain("one of goal, refused and person");
  });
});

describe("repo sign-in walks", () => {
  it("every file in the index loads through the schema as a SiteLogin", () => {
    const logins = repoWalkLogins();
    expect(logins.map((l) => l.site)).toEqual(LOGIN_WALK_FILES.map((f) => f.site));
  });

  it("a file the schema refuses, or one not named login, throws", () => {
    const ok = {
      site: "gram",
      name: "login",
      goal: "in",
      start: "https://gram.test/",
      screens: [{ name: "home", looks: "home", at: "/feed/", goal: true }],
    };
    expect(repoWalkLogins([ok]).map((l) => [l.site, l.home])).toEqual([
      ["gram", "https://gram.test/"],
    ]);
    expect(() => repoWalkLogins([{ ...ok, name: "setup" }])).toThrow(/is named login/);
    expect(() => repoWalkLogins([{ ...ok, start: 7 } as never])).toThrow();
  });
});

describe("heal screens on a sign-in", () => {
  const CONTINUE = { role: "button", name: "Continue to app" };
  const healScreen = (name = "heal-interstitial") => ({
    name,
    looks: "a new page after the password",
    shows: [CONTINUE],
    ops: [{ kind: "click", goal: "continue", hints: CONTINUE, irreversible: false }],
  });
  const dir = () => mkdtempSync(join(tmpdir(), "login-heal-"));
  const page = (s: ReturnType<typeof fakeSite>) => {
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    return s;
  };
  // a new page between the password and the feed: no repo screen knows it
  const site = (after: string) =>
    page(
      fakeSite(
        {
          login: { ...LOGIN, on: { "click button:Log in": "inter" } },
          inter: {
            url: "https://gram.test/accounts/interstitial",
            has: ["button:Continue to app"],
            on: { "click button:Continue to app": after },
          },
          home: { url: "https://gram.test/feed", has: [] },
          odd: { url: "https://gram.test/accounts/odd", has: ["button:Something"] },
          wrong: { has: [], text: "Sorry, your password was incorrect." },
        },
        "login",
      ),
    );
  const outcomes = (d: string) =>
    readFileSync(healLog(d, "gram"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).outcome);

  it("with no heal screen the try fails; a trial screen gets it through and is kept", async () => {
    const d = dir();
    await expect(
      walkLogin(instagramLike(), { healDir: d }).signIn(ctxFor(site("home").fp).ctx),
    ).rejects.toThrow(/does not know/);
    expect(addHealScreen(d, "gram", screenSpecSchema.parse(healScreen()))).toBe(
      "heal-interstitial",
    );
    const s = site("home");
    await walkLogin(instagramLike(), { healDir: d }).signIn(ctxFor(s.fp).ctx);
    expect(s.acts.at(-1)).toBe("click Continue to app");
    expect(outcomes(d)).toEqual(["passed"]);
    expect(withHeal(instagramLike(), d)).toMatchObject({ kept: ["heal-interstitial"], trial: [] });
  });

  it("a trial screen on a try that fails on its own is dropped; a refusal drops nothing", async () => {
    const d = dir();
    addHealScreen(d, "gram", screenSpecSchema.parse(healScreen()));
    await expect(
      walkLogin(instagramLike(), { healDir: d }).signIn(ctxFor(site("wrong").fp).ctx),
    ).rejects.toMatchObject({ case: "password" });
    expect(withHeal(instagramLike(), d).trial).toEqual(["heal-interstitial"]);
    await expect(
      walkLogin(instagramLike(), { healDir: d }).signIn(ctxFor(site("odd").fp).ctx),
    ).rejects.toThrow(LoginFailed);
    expect(outcomes(d)).toEqual(["failed"]);
    const after = withHeal(instagramLike(), d);
    expect([after.trial, after.kept]).toEqual([[], []]);
    expect(after.spec.screens.map((x) => x.name)).not.toContain("heal-interstitial");
  });

  it("loads newest first, after the repo screens; a bad or clashing screen drops alone", () => {
    const d = dir();
    mkdirSync(join(d, "gram"), { recursive: true });
    writeFileSync(
      join(d, "gram", "login-heal.json"),
      JSON.stringify({
        screens: [
          healScreen("heal-old"),
          { ...healScreen("heal-bad"), after: ["renamed-screen"] },
          { ...healScreen("login-form") },
          healScreen("heal-new"),
        ],
      }),
    );
    const h = withHeal(instagramLike(), d);
    const names = h.spec.screens.map((x) => x.name);
    expect(names.slice(-2)).toEqual(["heal-new", "heal-old"]);
    expect(names.indexOf("selfie")).toBeLessThan(names.indexOf("heal-new"));
    expect(h.trial).toEqual(["heal-new", "heal-old"]);
    expect(h.warnings.join("\n")).toMatch(/heal-bad/);
    expect(h.warnings.join("\n")).toMatch(/login-form: the walk already has/);
  });
});

describe("writing a heal screen", () => {
  const CONTINUE = { role: "button", name: "Continue to app" };
  const URL_AT = "https://gram.test/accounts/interstitial?next=%2F";
  const proposal = (ops: object[] = [{ kind: "click", goal: "continue", hints: CONTINUE }]) => ({
    name: "interstitial",
    looks: "a continue page after the password",
    ops,
  });
  const writer = (p: HealProposal | null, seen: unknown[] = []): HealWriter => ({
    id: "fake",
    propose: async (req) => {
      seen.push(req);
      return p;
    },
  });
  const askFor = (dir: string): SignInHealAsk => ({
    spec: instagramLike(),
    dir,
    url: URL_AT,
    snapshot: 'button "Continue to app"',
    error: "gram: a page login does not know: https://gram.test/accounts/interstitial",
    steps: ["login-form"],
  });
  const dir = () => mkdtempSync(join(tmpdir(), "login-heal-write-"));

  it("the code sets at from the URL (no query) and shows from the first op's control", () => {
    const s = healScreenOf(proposal(), URL_AT);
    expect(s).toMatchObject({ name: "heal-interstitial", shows: [CONTINUE] });
    const at = regexOf((s as { at: string }).at);
    expect(at.test("https://gram.test/accounts/interstitial")).toBe(true);
    expect(at.test("https://gram.test/accounts/login/")).toBe(false);
  });

  it("refuses a click that buys or deletes, an op that is not a heal op, and no ops", () => {
    const buy = { kind: "click", goal: "buy", hints: { role: "button", name: "Buy now" } };
    expect(healScreenOf(proposal([buy]), URL_AT)).toMatch(/never clicks/);
    const open = { kind: "open", goal: "leave", url: "https://elsewhere.test/" };
    expect(healScreenOf(proposal([open]), URL_AT)).toMatch(/never holds a open/);
    expect(healScreenOf(proposal([]), URL_AT)).toMatch(/no ops/);
  });

  it("adds a trial screen once per site per day; the model sees the page and the known screens", async () => {
    const d = dir();
    const seen: { known: { name: string }[]; snapshot: string }[] = [];
    const now = new Date("2026-11-27T00:00:00Z");
    expect(await healSignIn(writer(proposal(), seen), askFor(d), now)).toEqual({
      status: "added",
      screen: "heal-interstitial",
    });
    expect(seen[0]?.snapshot).toMatch(/Continue to app/);
    expect(seen[0]?.known.map((k) => k.name)).toContain("login-form");
    expect(withHeal(instagramLike(), d).trial).toEqual(["heal-interstitial"]);
    const soon = new Date(now.getTime() + HEAL_EVERY_MS - 1);
    expect(await healSignIn(writer(proposal()), askFor(d), soon)).toMatchObject({
      status: "skipped",
    });
    const later = new Date(now.getTime() + HEAL_EVERY_MS);
    expect(await healSignIn(writer(null), askFor(d), later)).toMatchObject({ status: "none" });
  });

  it("two failed heals in 7 days stop heal for the site, with one note's worth of result", async () => {
    const d = dir();
    const day = (n: number) => new Date(Date.parse("2026-11-27T00:00:00Z") + n * HEAL_EVERY_MS);
    expect(await healSignIn(writer(null), askFor(d), day(0))).toMatchObject({ status: "none" });
    const buy = { kind: "click", goal: "buy", hints: { role: "button", name: "Buy now" } };
    expect(await healSignIn(writer(proposal([buy])), askFor(d), day(1))).toMatchObject({
      status: "refused",
    });
    const seen: unknown[] = [];
    expect(await healSignIn(writer(proposal(), seen), askFor(d), day(2))).toMatchObject({
      status: "stopped",
    });
    expect(seen).toEqual([]);
    expect(await healSignIn(writer(proposal()), askFor(d), day(3))).toMatchObject({
      status: "skipped",
    });
    // the failures age out after 7 days
    expect(await healSignIn(writer(proposal()), askFor(d), day(9))).toMatchObject({
      status: "added",
    });
  });

  it("a sign-in lost on a new page heals itself: fail, write the screen, then pass", async () => {
    const d = dir();
    const site = (stateDir: string) => {
      const s = fakeSite(
        {
          login: { ...LOGIN, on: { "click button:Log in": "inter" } },
          inter: {
            url: URL_AT,
            has: ["button:Continue to app"],
            on: { "click button:Continue to app": "home" },
          },
          home: { url: "https://gram.test/feed", has: [] },
        },
        "login",
      );
      s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
      return { s, walk: walkLogin(instagramLike(), { healDir: stateDir }) };
    };
    const asks: Promise<unknown>[] = [];
    const opts = (healed: SignInHealAsk[]) => ({
      credentials: memoryCredentials({ gram: { username: "user-a", password: "pw-a-1" } }),
      codes: totpSource(),
      heal: (ask: SignInHealAsk) => {
        healed.push(ask);
        const p = healSignIn(writer(proposal()), ask);
        asks.push(p);
        return p;
      },
    });
    const healed: SignInHealAsk[] = [];
    const one = site(d);
    await expect(loginProvider([one.walk], opts(healed))(one.s.fp, "gram")).rejects.toThrow(
      /does not know/,
    );
    await Promise.all(asks);
    expect(healed).toHaveLength(1);
    expect(healed[0]).toMatchObject({ url: URL_AT, steps: ["login-form"] });
    expect(withHeal(instagramLike(), d).trial).toEqual(["heal-interstitial"]);
    const two = site(d);
    expect(await loginProvider([two.walk], opts([]))(two.s.fp, "gram")).toBe("signed-in");
    expect(two.s.acts.at(-1)).toBe("click Continue to app");
    expect(withHeal(instagramLike(), d).kept).toEqual(["heal-interstitial"]);
  });

  it("a refused sign-in asks for no heal", async () => {
    const s = fakeSite(
      {
        login: { ...LOGIN, on: { "click button:Log in": "wrong" } },
        wrong: { has: [], text: "Sorry, your password was incorrect." },
      },
      "login",
    );
    s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
    const healed: unknown[] = [];
    await expect(
      loginProvider([walkLogin(instagramLike(), { healDir: dir() })], {
        credentials: memoryCredentials({ gram: { username: "user-a", password: "pw-a-1" } }),
        codes: totpSource(),
        heal: async (ask) => healed.push(ask),
      })(s.fp, "gram"),
    ).rejects.toThrow(LoginFailed);
    expect(healed).toEqual([]);
  });
});

describe("codes per try", () => {
  it("a code box that keeps coming back takes at most CODES_PER_TRY codes, then case code", async () => {
    const acts: string[] = [];
    const fp = {
      has: async () => false,
      act: async (op: { kind: string }) => {
        acts.push(op.kind);
      },
    } as unknown as FlowPage;
    const ctx = { fp, offers: () => true, code: async () => "000000" } as unknown as SignInContext;
    const st = signInState("gram");
    const box = { kinds: ["totp"] as const, field: CODE, submit: LOG_IN };
    for (let i = 0; i < CODES_PER_TRY; i++) await enterCode(st, ctx, box);
    await expect(enterCode(st, ctx, box)).rejects.toMatchObject({ case: "code" });
    expect(acts.filter((a) => a === "fill")).toHaveLength(CODES_PER_TRY);
  });
});
