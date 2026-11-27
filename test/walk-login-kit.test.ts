import { describe, expect, it } from "vitest";
import { isPassword, LoginFailed, type SignInContext } from "../src/auth/login.js";
import type { FlowPage } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";
import { repoWalkLogins, walkLogin } from "../src/walks/login.js";
import { LOGIN_WALK_FILES } from "../src/walks/logins/index.js";
import { type WalkSpec, walkSpecSchema } from "../src/walks/spec.js";
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
