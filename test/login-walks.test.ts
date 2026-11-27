/** The repo's sign-in walks (`src/walks/logins/`): one shared runner, one block per site. */
import { describe, expect, it } from "vitest";
import type { CodeKind } from "../src/auth/codes.js";
import { LoginFailed, type SignInContext } from "../src/auth/login.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { NeedsHuman } from "../src/browser/session.js";
import { repoWalkLogins } from "../src/walks/login.js";
import { LOGIN_WALK_FILES } from "../src/walks/logins/index.js";
import { fakeSite, type State } from "./site-fakes.js";

const logins = repoWalkLogins();
const loginOf = (site: string) => {
  const l = logins.find((x) => x.site === site);
  if (!l) throw new Error(`no repo walk for ${site}`);
  return l;
};

/** The site as states; `opened` lists every `open`, so a run in place shows none. */
function siteOf(states: Record<string, State>, start: string) {
  const s = fakeSite(states, start);
  const opened: string[] = [];
  s.fp.open = async (url: string) => {
    opened.push(url);
  };
  s.fp.page = { url: s.fp.url, evaluate: async () => [], isClosed: () => false } as never;
  return { ...s, opened };
}

function ctxFor(fp: SignInContext["fp"], kinds: CodeKind[] = []) {
  const asked: string[] = [];
  const cred = { username: "wren", password: "pw-ig-1", recoveryCodes: [], passkeys: [] };
  const ctx = {
    fp,
    cred,
    code: async (kind: CodeKind) => {
      asked.push(kind);
      return "123456";
    },
    offers: (kind: CodeKind) => kinds.includes(kind),
    inbox: () => null,
    steps: [] as string[],
  } as unknown as SignInContext;
  return { ctx, asked };
}

describe("repo sign-in walks", () => {
  it("each file parses as a login walk, and its site has no built-in login left", () => {
    expect(logins.map((l) => l.site)).toEqual(LOGIN_WALK_FILES.map((f) => f.site));
    for (const f of LOGIN_WALK_FILES) {
      expect(f.name).toBe("login");
      expect(SITE_LOGINS.some((l) => l.site === f.site)).toBe(false);
    }
  });
});

describe("instagram walk", () => {
  const LOGIN_URL = "https://www.instagram.com/accounts/login/?next=%2Foauth%2Fauthorize";
  const FORM = ["textbox:Phone number, username, or email", "textbox:Password", "button:Log in"];
  const AUTHORIZE = "https://www.instagram.com/oauth/authorize?client_id=1";

  it("signInHere covers the login, two-factor and challenge pages, not the app's", () => {
    const at = loginOf("instagram").signInHere?.at as RegExp;
    for (const u of [
      LOGIN_URL,
      "https://www.instagram.com/accounts/login/two_factor?next=x",
      "https://www.instagram.com/challenge/action/abc/",
    ])
      expect(at.test(u)).toBe(true);
    expect(at.test("https://www.instagram.com/")).toBe(false);
    expect(at.test(AUTHORIZE)).toBe(false);
  });

  it("in place: username, password, the authenticator code, declines the save prompt; never opens", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "twoFactor" } },
        twoFactor: {
          url: "https://www.instagram.com/accounts/login/two_factor?next=x",
          text: "Enter the code from your authentication app",
          has: ["textbox:Security code", "button:Confirm"],
          on: { "click button:Confirm": "onetap" },
        },
        onetap: {
          url: "https://www.instagram.com/accounts/onetap/?next=x",
          text: "Save your login info?",
          has: ["button:Save info", "button:Not now"],
          on: { "click button:Not now": "authorize" },
        },
        authorize: { url: AUTHORIZE, has: ["button:Allow"] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["totp", "email"]);
    await loginOf("instagram").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "fill Phone number, username, or email=wren",
      "fill Password=pw-ig-1",
      "click Log in",
      "fill Security code=123456",
      "click Confirm",
      "click Not now",
    ]);
    expect(asked).toEqual(["totp"]);
    expect(s.opened).toEqual([]);
    expect(s.fp.url()).toBe(AUTHORIZE);
  });

  it("signIn opens the login page first", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "home" } },
        home: { url: "https://www.instagram.com/", has: [] },
      },
      "login",
    );
    await loginOf("instagram").signIn(ctxFor(s.fp).ctx);
    expect(s.opened).toEqual(["https://www.instagram.com/accounts/login/"]);
  });

  it("an unusual login: sends the emailed code, then types it", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "challenge" } },
        challenge: {
          url: "https://www.instagram.com/challenge/action/1/",
          text: "We detected an unusual login attempt.",
          has: ["button:Send Security Code"],
          on: { "click button:Send Security Code": "emailed" },
        },
        emailed: {
          url: "https://www.instagram.com/challenge/action/1/",
          text: "Enter the security code we emailed",
          has: ["textbox:Security code", "button:Confirm"],
          on: { "click button:Confirm": "home" },
        },
        home: { url: "https://www.instagram.com/", has: [] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["email"]);
    await loginOf("instagram").signInHere?.run(ctx);
    expect(s.acts.slice(3)).toEqual([
      "click Send Security Code",
      "fill Security code=123456",
      "click Confirm",
    ]);
    expect(asked).toEqual(["email"]);
  });

  it("a suspicious-login page with a Send button sends the code; no person is paged", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "challenge" } },
        challenge: {
          url: "https://www.instagram.com/challenge/action/3/",
          text: "We noticed suspicious activity. Confirm it's you with a code.",
          has: ["button:Send Security Code"],
          on: { "click button:Send Security Code": "emailed" },
        },
        emailed: {
          url: "https://www.instagram.com/challenge/action/3/",
          text: "Enter the security code we emailed. We noticed suspicious activity.",
          has: ["textbox:Security code", "button:Confirm"],
          on: { "click button:Confirm": "home" },
        },
        home: { url: "https://www.instagram.com/", has: [] },
      },
      "login",
    );
    await loginOf("instagram").signInHere?.run(ctxFor(s.fp, ["email"]).ctx);
    expect(s.acts.slice(3)).toEqual([
      "click Send Security Code",
      "fill Security code=123456",
      "click Confirm",
    ]);
  });

  it("checks a session on the feed, not the login page", () => {
    expect(loginOf("instagram").home).toBe("https://www.instagram.com/");
  });

  it("a rejected password is refused with case password", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "wrong" } },
        wrong: { url: LOGIN_URL, has: FORM, text: "Sorry, your password was incorrect." },
      },
      "login",
    );
    await expect(loginOf("instagram").signInHere?.run(ctxFor(s.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
  });

  it("a selfie check is a person's step", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "selfie" } },
        selfie: {
          url: "https://www.instagram.com/challenge/action/2/",
          text: "We noticed suspicious activity: confirm it's you",
          has: ["button:Start"],
        },
      },
      "login",
    );
    await expect(
      loginOf("instagram").signInHere?.run(ctxFor(s.fp, ["email"]).ctx),
    ).rejects.toBeInstanceOf(NeedsHuman);
  });

  it("a password box with no username box fails loudly, never skips the username", async () => {
    const s = siteOf(
      { login: { url: LOGIN_URL, has: ["textbox:Password", "button:Log in"] } },
      "login",
    );
    const err = await loginOf("instagram")
      .signInHere?.run(ctxFor(s.fp).ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailed);
    expect(String((err as Error).message)).toMatch(/nothing matches/);
    expect(s.acts).toEqual([]);
  });
});
