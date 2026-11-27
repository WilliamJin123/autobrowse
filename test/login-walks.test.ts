/** The repo's sign-in walks (`src/walks/logins/`): one shared runner, one block per site. */
import { describe, expect, it } from "vitest";
import type { CodeKind } from "../src/auth/codes.js";
import { LoginFailed, passwordDomains, type SignInContext } from "../src/auth/login.js";
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

describe("facebook walk", () => {
  const LOGIN_URL = "https://www.facebook.com/login/?next=x";
  const FORM = ["textbox:Email or phone number", "textbox:Password", "button:Log in"];
  const DIALOG = "https://www.facebook.com/v23.0/dialog/oauth?client_id=1";

  it("types only on Meta's hosts; signInHere covers the login and its checkpoints", () => {
    const login = loginOf("facebook");
    expect(passwordDomains(logins, "facebook", {} as never)).toEqual([
      "facebook.com",
      "meta.com",
      "fb.com",
    ]);
    const at = login.signInHere?.at as RegExp;
    for (const u of [
      LOGIN_URL,
      "https://www.facebook.com/checkpoint/?next=x",
      "https://www.facebook.com/two_step_verification/authentication/?next=x",
    ])
      expect(at.test(u)).toBe(true);
    expect(at.test("https://www.facebook.com/")).toBe(false);
    expect(at.test(DIALOG)).toBe(false);
  });

  it("email, password, the authenticator code, then declines both prompts", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "twoFactor" } },
        twoFactor: {
          url: "https://www.facebook.com/two_step_verification/two_factor/?next=x",
          text: "Enter the 6-digit code from your authentication app",
          has: ["textbox:Code", "button:Continue"],
          on: { "click button:Continue": "save" },
        },
        save: {
          url: "https://www.facebook.com/checkpoint/remember_browser/?next=x",
          text: "Save browser?",
          has: ["button:Save", "button:Don't save"],
          on: { "click button:Don't save": "trust" },
        },
        trust: {
          url: "https://www.facebook.com/checkpoint/trust/?next=x",
          text: "Trust this device?",
          has: ["button:Trust", "button:Not now"],
          on: { "click button:Not now": "dialog" },
        },
        dialog: { url: DIALOG, has: ["button:Continue as Wren"] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["totp", "sms"]);
    await loginOf("facebook").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "fill Email or phone number=wren",
      "fill Password=pw-ig-1",
      "click Log in",
      "fill Code=123456",
      "click Continue",
      "click Don't save",
      "click Not now",
    ]);
    expect(asked).toEqual(["totp"]);
    expect(s.opened).toEqual([]);
  });

  it("a texted code takes an sms code", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "texted" } },
        texted: {
          url: "https://www.facebook.com/checkpoint/?next=x",
          text: "We texted a 6-digit code to your phone",
          has: ["textbox:Code", "button:Continue"],
          on: { "click button:Continue": "home" },
        },
        home: { url: "https://www.facebook.com/", has: [] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["sms", "email"]);
    await loginOf("facebook").signInHere?.run(ctx);
    expect(asked).toEqual(["sms"]);
  });

  it("a rejected password is refused; a photo check is a person's", async () => {
    const wrong = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "wrong" } },
        wrong: { url: LOGIN_URL, has: FORM, text: "The password you've entered is incorrect." },
      },
      "login",
    );
    await expect(loginOf("facebook").signInHere?.run(ctxFor(wrong.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    const selfie = siteOf(
      {
        login: { url: LOGIN_URL, has: FORM, on: { "click button:Log in": "check" } },
        check: {
          url: "https://www.facebook.com/checkpoint/1/",
          text: "Confirm your identity: upload a photo of yourself",
          has: ["button:Upload"],
        },
      },
      "login",
    );
    await expect(
      loginOf("facebook").signInHere?.run(ctxFor(selfie.fp, ["sms"]).ctx),
    ).rejects.toBeInstanceOf(NeedsHuman);
  });
});

describe("x walk", () => {
  const OLD = "https://x.com/i/flow/login";
  const NEW = "https://x.com/i/jf/onboarding/web?mode=login";

  it("types only on x.com and twitter.com; signInHere covers both login pages", () => {
    expect(passwordDomains(logins, "x", {} as never)).toEqual(["x.com", "twitter.com"]);
    const at = loginOf("x").signInHere?.at as RegExp;
    expect(at.test(`${OLD}?redirect_after_login=%2Fi%2Foauth2`)).toBe(true);
    expect(at.test("https://twitter.com/login")).toBe(true);
    expect(at.test(`${NEW}&redirect_after_login=%2F`)).toBe(true);
    expect(at.test("https://x.com/home")).toBe(false);
    expect(at.test("https://x.com/i/oauth2/authorize?x")).toBe(false);
  });

  it("username, Next, the handle again, password, then the texted code", async () => {
    const s = siteOf(
      {
        user: {
          url: OLD,
          has: ["textbox:Phone, email, or username", "button:Next"],
          on: { "click button:Next": "again" },
        },
        again: {
          url: OLD,
          text: "Enter your phone number or username",
          has: ["textbox:Phone number or username", "button:Next"],
          on: { "click button:Next": "password" },
        },
        password: {
          url: OLD,
          has: ["textbox:Password", "button:Log in"],
          on: { "click button:Log in": "code" },
        },
        code: {
          url: OLD,
          text: "We texted you a verification code",
          has: ["textbox:Verification code", "button:Next"],
          on: { "click button:Next": "home" },
        },
        home: { url: "https://x.com/home", has: [] },
      },
      "user",
    );
    const { ctx, asked } = ctxFor(s.fp, ["sms"]);
    await loginOf("x").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "fill Phone, email, or username=wren",
      "click Next",
      "fill Phone number or username=wren",
      "click Next",
      "fill Password=pw-ig-1",
      "click Log in",
      "fill Verification code=123456",
      "click Next",
    ]);
    expect(asked).toEqual(["sms"]);
  });

  it("the 2026-09 page: Email or username, Continue, Password Show password, Continue", async () => {
    const s = siteOf(
      {
        user: {
          url: NEW,
          has: ["textbox:Email or username", "button:Continue"],
          on: { "click button:Continue": "password" },
        },
        password: {
          url: NEW,
          has: ["textbox:Password Show password", "button:Continue"],
          on: { "click button:Continue": "home" },
        },
        home: { url: "https://x.com/home", has: [] },
      },
      "user",
    );
    await loginOf("x").signInHere?.run(ctxFor(s.fp).ctx);
    expect(s.acts).toEqual([
      "fill Email or username=wren",
      "click Continue",
      "fill Password Show password=pw-ig-1",
      "click Continue",
    ]);
  });

  it("a wrong password is refused; the puzzle is a person's", async () => {
    const wrong = siteOf(
      {
        password: {
          url: OLD,
          has: ["textbox:Password", "button:Log in"],
          on: { "click button:Log in": "wrong" },
        },
        wrong: { url: OLD, has: ["textbox:Password", "button:Log in"], text: "Wrong password!" },
      },
      "password",
    );
    await expect(loginOf("x").signInHere?.run(ctxFor(wrong.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    const puzzle = siteOf(
      {
        password: {
          url: OLD,
          has: ["textbox:Password", "button:Log in"],
          on: { "click button:Log in": "puzzle" },
        },
        puzzle: {
          url: OLD,
          text: "Solve this puzzle so we know you're a real person",
          has: ["button:Begin"],
        },
      },
      "password",
    );
    await expect(
      loginOf("x").signInHere?.run(ctxFor(puzzle.fp, ["sms"]).ctx),
    ).rejects.toBeInstanceOf(NeedsHuman);
  });
});

describe("tiktok walk", () => {
  const EMAIL_TAB = "https://www.tiktok.com/login/phone-or-email/email";
  const FORM = ["textbox:Email or username", "textbox:Password", "button:Log in"];

  it("signInHere covers the login pages", () => {
    const at = loginOf("tiktok").signInHere?.at as RegExp;
    expect(at.test("https://www.tiktok.com/login")).toBe(true);
    expect(at.test(EMAIL_TAB)).toBe(true);
    expect(at.test("https://www.tiktok.com/foryou")).toBe(false);
  });

  it("from the chooser to the email tab, signs in, takes the emailed code", async () => {
    const s = siteOf(
      {
        chooser: {
          url: "https://www.tiktok.com/login",
          has: ["text:Use phone / email / username", "button:Log in"],
          on: { "click text:Use phone / email / username": "phone" },
        },
        phone: {
          url: "https://www.tiktok.com/login/phone-or-email/phone",
          has: ["link:Log in with email or username", "button:Log in"],
          on: { "click link:Log in with email or username": "email" },
        },
        email: { url: EMAIL_TAB, has: FORM, on: { "click button:Log in": "code" } },
        code: {
          url: EMAIL_TAB,
          text: "Enter the 6-digit code we sent to your email",
          has: ["textbox:Enter 6-digit code", "button:Next"],
          on: { "click button:Next": "home" },
        },
        home: { url: "https://www.tiktok.com/foryou", has: [] },
      },
      "chooser",
    );
    const { ctx, asked } = ctxFor(s.fp, ["email"]);
    await loginOf("tiktok").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "click Use phone / email / username",
      "click Log in with email or username",
      "fill Email or username=wren",
      "fill Password=pw-ig-1",
      "click Log in",
      "fill Enter 6-digit code=123456",
      "click Next",
    ]);
    expect(asked).toEqual(["email"]);
  });

  it("a login page with no way to the email tab opens it", async () => {
    const s = siteOf(
      {
        other: { url: "https://www.tiktok.com/login/qrcode", has: ["button:Log in"] },
        email: { url: EMAIL_TAB, has: FORM, on: { "click button:Log in": "home" } },
        home: { url: "https://www.tiktok.com/foryou", has: [] },
      },
      "other",
    );
    s.fp.open = async (url: string) => {
      s.opened.push(url);
      if (url === EMAIL_TAB) s.go("email");
    };
    await loginOf("tiktok").signInHere?.run(ctxFor(s.fp).ctx);
    expect(s.opened).toEqual([EMAIL_TAB]);
    expect(s.acts).toContain("click Log in");
  });

  it("a wrong password is refused; the slider is a person's", async () => {
    const wrong = siteOf(
      {
        email: { url: EMAIL_TAB, has: FORM, on: { "click button:Log in": "wrong" } },
        wrong: { url: EMAIL_TAB, has: FORM, text: "Account or password doesn't match our records" },
      },
      "email",
    );
    await expect(loginOf("tiktok").signInHere?.run(ctxFor(wrong.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    const slider = siteOf(
      {
        email: { url: EMAIL_TAB, has: FORM, on: { "click button:Log in": "slider" } },
        slider: { url: EMAIL_TAB, has: [], text: "Drag the slider to fit the puzzle" },
      },
      "email",
    );
    await expect(loginOf("tiktok").signInHere?.run(ctxFor(slider.fp).ctx)).rejects.toBeInstanceOf(
      NeedsHuman,
    );
  });
});
