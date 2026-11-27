/** The repo's sign-in walks (`src/walks/logins/`): one shared runner, one block per site. */
import { afterEach, describe, expect, it } from "vitest";
import type { CodeKind } from "../src/auth/codes.js";
import { LoginFailed, passwordDomains, type SignInContext } from "../src/auth/login.js";
import { isProvider, providerOf, registerProvider } from "../src/auth/providers.js";
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

function ctxFor(
  fp: SignInContext["fp"],
  kinds: CodeKind[] = [],
  over: Partial<SignInContext["cred"]> = {},
) {
  const asked: string[] = [];
  /** `credFor` calls: which provider, as which account. */
  const providers: string[] = [];
  // a `via` credential holds no password (`methodsOf` splits one that has both)
  const cred = {
    username: "wren",
    ...(over.via ? {} : { password: "pw-ig-1" }),
    recoveryCodes: [],
    passkeys: [],
    ...over,
  } as SignInContext["cred"];
  const ctx = {
    fp,
    cred,
    credFor: async (site: string, account?: string) => {
      providers.push(`${site}:${account ?? "default"}`);
      return { username: account ?? `${site}-default`, recoveryCodes: [], passkeys: [] };
    },
    as: (c: SignInContext["cred"]) => ({ ...ctx, cred: c }),
    code: async (kind: CodeKind) => {
      asked.push(kind);
      return "123456";
    },
    offers: (kind: CodeKind) => kinds.includes(kind),
    inbox: () => null,
    steps: [] as string[],
  } as unknown as SignInContext;
  return { ctx, asked, providers };
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

describe("one-page form walks", () => {
  // site, start URL, the form's controls, its submit, the URL past it
  const FORMS = [
    [
      "instantly",
      "https://app.instantly.ai/auth/login",
      ["textbox:Email", "textbox:Password", "button:Log in"],
      "button:Log in",
      "https://app.instantly.ai/app/campaigns",
    ],
    [
      "intuit",
      "https://accounts.intuit.com/app/sign-in",
      ["textbox:Email or user ID", "textbox:Password", "button:Sign in"],
      "button:Sign in",
      "https://developer.intuit.com/app/developer/dashboard",
    ],
    [
      "npm",
      "https://www.npmjs.com/login",
      ["textbox:Username", "textbox:Password", "button:Sign In"],
      "button:Sign In",
      "https://www.npmjs.com/",
    ],
    [
      "discord",
      "https://discord.com/login",
      ["textbox:Email or Phone Number", "textbox:Password", "button:Log In"],
      "button:Log In",
      "https://discord.com/channels/@me",
    ],
    [
      "reddit",
      "https://www.reddit.com/login/",
      ["textbox:Email or username", "textbox:Password", "button:Log In"],
      "button:Log In",
      "https://www.reddit.com/",
    ],
    [
      "costco",
      "https://www.costco.com/LogonForm",
      ["css:#signInName", "css:#password", "css:#next"],
      "css:#next",
      "https://www.costco.com/",
    ],
  ] as const;

  for (const [site, url, has, submit, home] of FORMS)
    it(`${site}: opens the login, types both, lands signed in`, async () => {
      const s = siteOf(
        {
          login: { url, has: [...has], on: { [`click ${submit}`]: "home" } },
          home: { url: home, has: [] },
        },
        "login",
      );
      await loginOf(site).signIn(ctxFor(s.fp).ctx);
      expect(s.opened).toHaveLength(1);
      expect(s.acts.filter((a) => a.startsWith("fill"))).toEqual([
        `fill ${has[0].slice(has[0].indexOf(":") + 1)}=wren`,
        `fill ${has[1].slice(has[1].indexOf(":") + 1)}=pw-ig-1`,
      ]);
      expect(s.acts.at(-1)).toBe(`click ${submit.slice(submit.indexOf(":") + 1)}`);
      expect(await loginOf(site).loggedIn(s.fp)).toBe(true);
    });

  it("costco ticks Keep me signed in before the submit", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://www.costco.com/LogonForm",
          has: ["css:#signInName", "css:#password", "css:#rememberMe", "css:#next"],
          on: { "click css:#next": "home" },
        },
        home: { url: "https://www.costco.com/", has: [] },
      },
      "login",
    );
    await loginOf("costco").signIn(ctxFor(s.fp).ctx);
    expect(s.acts.slice(-2)).toEqual(["script #rememberMe", "click #next"]);
  });

  it("signed out is not signed in: the login link or the form still shows", async () => {
    const npm = siteOf({ home: { url: "https://www.npmjs.com/", has: ["link:Sign In"] } }, "home");
    expect(await loginOf("npm").loggedIn(npm.fp)).toBe(false);
    const reddit = siteOf(
      { login: { url: "https://www.reddit.com/login/", has: ["textbox:Password"] } },
      "login",
    );
    expect(await loginOf("reddit").loggedIn(reddit.fp)).toBe(false);
  });

  for (const [site, code, kind, says, submit] of [
    [
      "instantly",
      "textbox:Code",
      "email",
      "Check your email for a verification code",
      "button:Verify",
    ],
    ["intuit", "textbox:Verification code", "email", "Enter the code we sent", "button:Continue"],
    [
      "reddit",
      "textbox:Verification code",
      "email",
      "Check your inbox for a code",
      "button:Continue",
    ],
    [
      "discord",
      "textbox:6-digit authentication code",
      "totp",
      "Multi-Factor Authentication",
      "button:Confirm",
    ],
  ] as const)
    it(`${site}: takes the ${kind} code`, async () => {
      const form = FORMS.find((f) => f[0] === site) as (typeof FORMS)[number];
      const s = siteOf(
        {
          login: { url: form[1], has: [...form[2]], on: { [`click ${form[3]}`]: "code" } },
          code: {
            url: form[1],
            text: says,
            has: [code, submit],
            on: { [`click ${submit}`]: "home" },
          },
          home: { url: form[4], has: [] },
        },
        "login",
      );
      const { ctx, asked } = ctxFor(s.fp, [kind]);
      await loginOf(site).signIn(ctx);
      expect(asked).toEqual([kind]);
      expect(s.acts.slice(-2)).toEqual([
        `fill ${code.slice(code.indexOf(":") + 1)}=123456`,
        `click ${submit.slice(submit.indexOf(":") + 1)}`,
      ]);
    });

  it("a rejected password is refused", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://www.reddit.com/login/",
          has: ["textbox:Email or username", "textbox:Password", "button:Log In"],
          on: { "click button:Log In": "wrong" },
        },
        wrong: {
          url: "https://www.reddit.com/login/",
          has: ["textbox:Email or username", "textbox:Password", "button:Log In"],
          text: "Invalid username or password.",
        },
      },
      "login",
    );
    await expect(loginOf("reddit").signIn(ctxFor(s.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
  });
});

describe("npm walk", () => {
  const FORM = ["textbox:Username", "textbox:Password", "button:Sign In"];
  const LOGIN = "https://www.npmjs.com/login";
  const keySite = () =>
    siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign In": "key" } },
        key: {
          url: "https://www.npmjs.com/login/webauthn",
          text: "Click the button below when you are ready to authenticate",
          has: ["button:Use security key"],
          on: { "click button:Use security key": "home" },
        },
        home: { url: "https://www.npmjs.com/", has: [] },
      },
      "login",
    );

  it("our stored passkey answers the security key ask", async () => {
    const s = keySite();
    const { ctx } = ctxFor(s.fp);
    (ctx.cred as { passkeys: unknown[] }).passkeys = [{ rpId: "npmjs.com" }];
    await loginOf("npm").signIn(ctx);
    expect(s.acts.at(-1)).toBe("click Use security key");
  });

  it("no stored passkey: a person answers, never a click that hangs", async () => {
    const s = keySite();
    await expect(loginOf("npm").signIn(ctxFor(s.fp).ctx)).rejects.toBeInstanceOf(NeedsHuman);
    expect(s.acts).not.toContain("click Use security key");
  });

  it("the emailed one-time password, then the authenticator box alone takes a totp", async () => {
    const emailed = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign In": "otp" } },
        otp: {
          url: "https://www.npmjs.com/login/otp",
          text: "We sent a one-time password to your email",
          has: ["textbox:One-Time Password", "button:Login"],
          on: { "click button:Login": "home" },
        },
        home: { url: "https://www.npmjs.com/", has: [] },
      },
      "login",
    );
    const one = ctxFor(emailed.fp, ["email", "totp"]);
    await loginOf("npm").signIn(one.ctx);
    expect(one.asked).toEqual(["email"]);
    const app = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign In": "otp" } },
        otp: {
          url: "https://www.npmjs.com/login/otp",
          text: "Two-factor authentication",
          has: ["textbox:Authentication code", "button:Verify"],
          on: { "click button:Verify": "home" },
        },
        home: { url: "https://www.npmjs.com/", has: [] },
      },
      "login",
    );
    const two = ctxFor(app.fp, ["totp"]);
    await loginOf("npm").signIn(two.ctx);
    expect(two.asked).toEqual(["totp"]);
  });

  it("keeps its account chores: passkey setup and recovery codes", () => {
    expect(loginOf("npm").passkeySetup).toBeDefined();
    expect(loginOf("npm").recoveryCodes?.unlock).toEqual({
      role: "button",
      name: "Use security key",
    });
    expect(loginOf("discord").reauth?.submit).toEqual({ role: "button", name: "/^submit$/i" });
  });
});

describe("apple walk", () => {
  const LOGIN = "https://appstoreconnect.apple.com/login";
  const USER = "textbox:Email or Phone Number";

  it("the Apple ID, Continue, the password under it (never retyped), the person's code, Trust", async () => {
    const s = siteOf(
      {
        user: { url: LOGIN, has: [USER, "button:Continue"], on: { "click button:Continue": "pw" } },
        pw: {
          url: LOGIN,
          has: [USER, "textbox:Password", "button:Sign In"],
          on: { "click button:Sign In": "trust" },
        },
        trust: {
          url: LOGIN,
          text: "Trust this browser?",
          has: ["button:Trust", "button:Not Now"],
          on: { "click button:Trust": "apps" },
        },
        apps: { url: "https://appstoreconnect.apple.com/apps", has: [] },
      },
      "user",
    );
    await loginOf("apple").signIn(ctxFor(s.fp).ctx);
    expect(s.acts).toEqual([
      "fill Email or Phone Number=wren",
      "click Continue",
      "fill Password=pw-ig-1",
      "click Sign In",
      "click Trust",
    ]);
  });

  it("the code on William's devices is a person's", async () => {
    const s = siteOf(
      {
        pw: {
          url: LOGIN,
          has: [USER, "textbox:Password", "button:Sign In"],
          on: { "click button:Sign In": "code" },
        },
        code: {
          url: LOGIN,
          text: "Two-Factor Authentication: enter the verification code",
          has: [],
        },
      },
      "pw",
    );
    await expect(loginOf("apple").signIn(ctxFor(s.fp).ctx)).rejects.toBeInstanceOf(NeedsHuman);
  });
});

describe("discord walk", () => {
  const LOGIN = "https://discord.com/login";
  const FORM = ["textbox:Email or Phone Number", "textbox:Password", "button:Log In"];

  it("a captcha it cannot solve is a person's", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Log In": "captcha" } },
        captcha: { url: LOGIN, has: ['css:iframe[src*="hcaptcha"]'] },
      },
      "login",
    );
    await expect(loginOf("discord").signIn(ctxFor(s.fp).ctx)).rejects.toBeInstanceOf(NeedsHuman);
  });

  it("a captcha the runner solves: the walk goes on to the code", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Log In": "captcha" } },
        captcha: { url: LOGIN, has: ['css:iframe[src*="hcaptcha"]'] },
        code: {
          url: LOGIN,
          text: "Multi-Factor Authentication",
          has: ["textbox:6-digit authentication code", "button:Confirm"],
          on: { "click button:Confirm": "home" },
        },
        home: { url: "https://discord.com/channels/@me", has: [] },
      },
      "login",
    );
    s.fp.captcha = async () => {
      s.go("code");
      return { solved: true, kind: "hcaptcha", vendor: null, reason: null } as never;
    };
    const { ctx, asked } = ctxFor(s.fp, ["totp"]);
    await loginOf("discord").signIn(ctx);
    expect(asked).toEqual(["totp"]);
  });
});

/** A stand-in for Google: its page is a fake state; signing in there moves the site on. */
const GOOGLE_PAGE = "https://accounts.google.com/v3/signin/identifier";
function fakeGoogle(back: () => void) {
  const signedAs: string[] = [];
  registerProvider({
    site: "google",
    host: /accounts\.google\.com/,
    buttons: [{ role: "button", name: "/google/i" }],
    signIn: async (c) => {
      signedAs.push(c.cred.username);
      back();
    },
  });
  return signedAs;
}
const realGoogle = providerOf("google");
afterEach(() => registerProvider(realGoogle));

describe("linkedin walk", () => {
  const LOGIN = "https://www.linkedin.com/login";
  const HERE = "https://www.linkedin.com/uas/login?session_redirect=%2Foauth";
  const FORM = ["textbox:Email or phone", "textbox:Password", "button:Sign in"];
  const CHECKPOINT = "https://www.linkedin.com/checkpoint/challenge/1";
  const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization?client_id=1";
  const FEED = "https://www.linkedin.com/feed/";

  it("signInHere covers /login, /uas/login and checkpoints, not the feed or the authorize page", () => {
    const at = loginOf("linkedin").signInHere?.at as RegExp;
    for (const u of [LOGIN, HERE, CHECKPOINT]) expect(at.test(u)).toBe(true);
    expect(at.test(FEED)).toBe(false);
    expect(at.test(AUTHORIZE)).toBe(false);
    expect(loginOf("linkedin").via).toEqual(["google"]);
  });

  it("in place: email, password, the authenticator code; lands on the authorize page", async () => {
    const s = siteOf(
      {
        login: { url: HERE, has: FORM, on: { "click button:Sign in": "checkpoint" } },
        checkpoint: {
          url: CHECKPOINT,
          text: "Enter the code from your authenticator app",
          has: ["textbox:Enter code", "button:Submit"],
          on: { "click button:Submit": "authorize" },
        },
        authorize: { url: AUTHORIZE, has: ["button:Allow"] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["totp", "email"]);
    await loginOf("linkedin").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "fill Email or phone=wren",
      "fill Password=pw-ig-1",
      "click Sign in",
      "fill Enter code=123456",
      "click Submit",
    ]);
    expect(asked).toEqual(["totp"]);
    expect(s.opened).toEqual([]);
  });

  it("signIn: the emailed code when no seed is stored, then the feed", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "checkpoint" } },
        checkpoint: {
          url: CHECKPOINT,
          text: "We sent a verification code to your email",
          has: ["textbox:Enter code", "button:Verify"],
          on: { "click button:Verify": "feed" },
        },
        feed: { url: FEED, has: [] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["email"]);
    await loginOf("linkedin").signIn(ctx);
    expect(asked).toEqual(["email"]);
    expect(s.opened).toEqual([LOGIN]);
  });

  it("a rejected password, a restricted account: refused with their cases", async () => {
    const wrong = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "wrong" } },
        wrong: { url: LOGIN, has: FORM, text: "Wrong email or password. Try again" },
      },
      "login",
    );
    await expect(loginOf("linkedin").signIn(ctxFor(wrong.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    const restricted = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "restricted" } },
        restricted: {
          url: "https://www.linkedin.com/flagship-web/login/login-restriction/",
          has: [],
        },
      },
      "login",
    );
    await expect(loginOf("linkedin").signIn(ctxFor(restricted.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "account",
    });
  });

  it("the security check goes to the solver; solved, the walk goes on", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "check" } },
        check: { url: CHECKPOINT, text: "Let's do a quick security check", has: [] },
        feed: { url: FEED, has: [] },
      },
      "login",
    );
    let solved = 0;
    s.fp.captcha = async () => {
      solved++;
      s.go("feed");
      return { solved: true, kind: "checkbox", vendor: "recaptcha", rounds: 1 } as never;
    };
    await loginOf("linkedin").signIn(ctxFor(s.fp).ctx);
    expect(solved).toBe(1);
  });

  it("via google: past the account chooser, Google's button, the feed; no password typed", async () => {
    const s = siteOf(
      {
        chooser: {
          url: LOGIN,
          has: ["link:Sign in using another account"],
          on: { "click link:Sign in using another account": "login" },
        },
        login: {
          url: LOGIN,
          has: [...FORM, "button:Continue with Google"],
          on: { "click button:Continue with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        feed: { url: FEED, has: [] },
      },
      "chooser",
    );
    const signedAs = fakeGoogle(() => s.go("feed"));
    const { ctx, providers } = ctxFor(s.fp, [], { via: "google", username: "will@wren.test" });
    await loginOf("linkedin").signIn(ctx);
    expect(s.acts).toEqual(["click Sign in using another account", "click Continue with Google"]);
    expect(providers).toEqual(["google:will@wren.test"]);
    expect(signedAs).toEqual(["will@wren.test"]);
  });
});

describe("github walk", () => {
  const LOGIN = "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize";
  const FORM = ["textbox:Username or email address", "textbox:Password", "button:Sign in"];
  const AUTHORIZE = "https://github.com/login/oauth/authorize?client_id=1";
  const BACK = "https://tool.test/callback?code=abc";
  const OTP = "textbox:Authentication code";

  it("is the provider behind Continue with GitHub, with its button readings", () => {
    expect(isProvider("github")).toBe(true);
    const p = providerOf("github");
    expect(p.host.test(LOGIN)).toBe(true);
    expect(p.host.test("https://github.com/octo/repo")).toBe(false);
    expect(p.buttons.some((b) => b.text?.includes("with github"))).toBe(true);
  });

  it("in place: password, the authenticator code, the app's authorize page, back on the app", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "twoFactor" } },
        twoFactor: {
          url: "https://github.com/sessions/two-factor/app",
          has: [OTP, "button:Verify"],
          on: { "click button:Verify": "authorize" },
        },
        authorize: {
          url: AUTHORIZE,
          has: ["button:Authorize new-tool"],
          on: { "click button:Authorize new-tool": "back" },
        },
        back: { url: BACK, has: [] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["totp"]);
    await loginOf("github").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "fill Username or email address=wren",
      "fill Password=pw-ig-1",
      "click Sign in",
      "fill Authentication code=123456",
      "click Verify",
      "click Authorize new-tool",
    ]);
    expect(asked).toEqual(["totp"]);
  });

  it("as a provider: the walk runs on the page the button opened, never opens /login", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "back" } },
        back: { url: BACK, has: [] },
      },
      "login",
    );
    await providerOf("github").signIn(ctxFor(s.fp).ctx);
    expect(s.acts.slice(0, 3)).toEqual([
      "fill Username or email address=wren",
      "fill Password=pw-ig-1",
      "click Sign in",
    ]);
    expect(s.opened).toEqual([]);
    expect(s.fp.url()).toBe(BACK);
  });

  it("a rejected password is refused with case password", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "wrong" } },
        wrong: { url: LOGIN, has: FORM, text: "Incorrect username or password." },
      },
      "login",
    );
    await expect(loginOf("github").signInHere?.run(ctxFor(s.fp).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
  });

  it("never waits on GitHub Mobile: More options, a text code (sent first), then home", async () => {
    const s = siteOf(
      {
        mobile: {
          url: "https://github.com/sessions/two-factor/mobile",
          text: "Two-factor authentication GitHub Mobile",
          has: ["button:More options"],
          on: { "click button:More options": "ways" },
        },
        ways: {
          url: "https://github.com/sessions/two-factor/mobile",
          has: ["link:Use your authenticator app", "link:Send a code via text message"],
          on: { "click link:Send a code via text message": "sms" },
        },
        sms: {
          url: "https://github.com/sessions/two-factor/sms",
          has: [OTP, "button:Send SMS", "button:Verify"],
          on: { "click button:Verify": "home" },
        },
        home: { url: "https://github.com/", has: [] },
      },
      "mobile",
    );
    const { ctx, asked } = ctxFor(s.fp, ["sms"]);
    await loginOf("github").signInHere?.run(ctx);
    expect(s.acts).toEqual([
      "click More options",
      "click Send a code via text message",
      "click Send SMS",
      "fill Authentication code=123456",
      "click Verify",
    ]);
    expect(asked).toEqual(["sms"]);
  });

  it("a device verification code from the inbox; six digits that submit themselves need no Verify", async () => {
    const s = siteOf(
      {
        login: { url: LOGIN, has: FORM, on: { "click button:Sign in": "device" } },
        device: {
          url: "https://github.com/sessions/verified-device",
          text: "Device verification. We just sent your authentication code",
          has: ["textbox:Device verification code"],
          on: { "fill textbox:Device verification code": "home" },
        },
        home: { url: "https://github.com/", has: [] },
      },
      "login",
    );
    const { ctx, asked } = ctxFor(s.fp, ["email"]);
    await loginOf("github").signInHere?.run(ctx);
    expect(s.acts.slice(3)).toEqual(["fill Device verification code=123456"]);
    expect(asked).toEqual(["email"]);
  });

  it("via google: Continue with Google, no password typed", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://github.com/login",
          has: [...FORM, "button:Continue with Google"],
          on: { "click button:Continue with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        home: { url: "https://github.com/settings/profile", has: [] },
      },
      "login",
    );
    fakeGoogle(() => s.go("home"));
    await loginOf("github").signIn(ctxFor(s.fp, [], { via: "google", username: "w@g.test" }).ctx);
    expect(s.acts).toEqual(["click Continue with Google"]);
  });
});

describe("provider walks (Google-made accounts)", () => {
  const google = { via: "google" as const, username: "william@wren.test" };

  it("anthropic: Continue with Google, as the site's own Google address", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://platform.claude.com/login",
          has: ["button:Continue with Google"],
          on: { "click button:Continue with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        home: { url: "https://platform.claude.com/dashboard", has: [] },
      },
      "login",
    );
    const signedAs = fakeGoogle(() => s.go("home"));
    const { ctx, providers } = ctxFor(s.fp, [], google);
    await loginOf("anthropic").signIn(ctx);
    expect(providers).toEqual(["google:william@wren.test"]);
    expect(signedAs).toEqual(["william@wren.test"]);
    expect(loginOf("anthropic").ask).toMatch(/Claude Console/);
  });

  it("an older credential with no via and no password still takes the button, as the default account", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://sentry.io/auth/login/",
          has: ["link:Sign in with Google"],
          on: { "click link:Sign in with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        home: { url: "https://wren-automation.sentry.io/issues/", has: [] },
      },
      "login",
    );
    fakeGoogle(() => s.go("home"));
    const { ctx, providers } = ctxFor(s.fp, [], { username: "x", password: "" });
    await loginOf("sentry").signIn(ctx);
    expect(providers).toEqual(["google:default"]);
  });

  it("a password credential never presses a provider's button", async () => {
    const s = siteOf(
      {
        login: {
          url: "https://platform.claude.com/login",
          has: ["button:Continue with Google"],
          on: { "click button:Continue with Google": "google" },
        },
      },
      "login",
    );
    fakeGoogle(() => {});
    await expect(loginOf("anthropic").signIn(ctxFor(s.fp).ctx)).rejects.toBeInstanceOf(LoginFailed);
    expect(s.acts).toEqual([]);
  });

  it("twilio: Google, then the texted code: remember, a fresh text, the code, Continue", async () => {
    const s = siteOf(
      {
        signup: {
          url: "https://www.twilio.com/try-twilio",
          has: ["button:Sign up with Google"],
          on: { "click button:Sign up with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        sms: {
          url: "https://login.twilio.com/u/mfa-sms-challenge?state=1",
          has: ["id:code", "id:rememberBrowser", "button:Resend", "button:Continue"],
          on: { "click button:Continue": "home" },
        },
        home: { url: "https://console.twilio.com/account/AC1/home", has: [] },
      },
      "signup",
    );
    fakeGoogle(() => s.go("sms"));
    const { ctx, asked } = ctxFor(s.fp, ["sms"], google);
    await loginOf("twilio").signIn(ctx);
    expect(s.acts).toEqual([
      "click Sign up with Google",
      "click rememberBrowser",
      "click Resend",
      "fill code=123456",
      "click Continue",
    ]);
    expect(asked).toEqual(["sms"]);
  });

  it("hubspot: the email first, then Sign in with Google", async () => {
    const s = siteOf(
      {
        email: {
          url: "https://app.hubspot.com/login",
          has: ["textbox:Email", "button:Continue"],
          on: { "click button:Continue": "methods" },
        },
        methods: {
          url: "https://app.hubspot.com/login",
          has: ["button:Sign in with Google"],
          on: { "click button:Sign in with Google": "google" },
        },
        google: { url: GOOGLE_PAGE, has: [] },
        home: { url: "https://app.hubspot.com/home", has: [] },
      },
      "email",
    );
    fakeGoogle(() => s.go("home"));
    await loginOf("hubspot").signIn(ctxFor(s.fp, [], google).ctx);
    expect(s.acts).toEqual([
      "fill Email=william@wren.test",
      "click Continue",
      "click Sign in with Google",
    ]);
  });

  it("perplexity: Sign In opens the modal; the popup signs in and the modal goes, URL unchanged", async () => {
    const HOME = "https://www.perplexity.ai/";
    const s = siteOf(
      {
        out: { url: HOME, has: ["button:Sign In"], on: { "click button:Sign In": "modal" } },
        modal: { url: HOME, has: ["button:Sign In", "button:Continue with Google"] },
        in: { url: HOME, has: [] },
      },
      "out",
    );
    // a popup: the provider's page opens beside the site's
    const popup = { url: () => GOOGLE_PAGE } as never;
    s.fp.nextPage = async () => popup;
    fakeGoogle(() => s.go("in"));
    await loginOf("perplexity").signIn(ctxFor(s.fp, [], google).ctx);
    expect(s.acts).toEqual(["click Sign In", "click Continue with Google"]);
  });
});

describe("aws walk", () => {
  const SIGN_IN = "https://us-east-1.signin.aws.amazon.com/oauth?client_id=arn";
  const CONSOLE = "https://us-east-1.console.aws.amazon.com/console/home";
  const IAM_FORM = [
    "textbox:Account ID or alias",
    "textbox:IAM username",
    "textbox:Password",
    "button:Sign in",
    "button:Sign in using root user email",
  ];
  const MFA = {
    url: SIGN_IN,
    has: ["textbox:MFA code", "button:Submit"],
    on: { "click button:Submit": "console" },
  };

  it("an IAM user: the account and user from <account>/<user>, the password, the MFA code", async () => {
    const s = siteOf(
      {
        form: { url: SIGN_IN, has: IAM_FORM, on: { "click button:Sign in": "mfa" } },
        mfa: MFA,
        console: { url: CONSOLE, has: [] },
      },
      "form",
    );
    const { ctx, asked } = ctxFor(s.fp, ["totp"], { username: "123456789012/william" });
    await loginOf("aws").signIn(ctx);
    expect(s.acts).toEqual([
      "fill Account ID or alias=123456789012",
      "fill IAM username=william",
      "fill Password=pw-ig-1",
      "click Sign in",
      "fill MFA code=123456",
      "click Submit",
    ]);
    expect(asked).toEqual(["totp"]);
    expect(s.opened).toEqual(["https://console.aws.amazon.com/"]);
  });

  it("waits on a form that renders late; a form that never renders fails the try", async () => {
    const s = siteOf(
      {
        loading: { url: SIGN_IN, has: [] },
        form: { url: SIGN_IN, has: IAM_FORM, on: { "click button:Sign in": "console" } },
        console: { url: CONSOLE, has: [] },
      },
      "loading",
    );
    const has = s.fp.has;
    const waits: number[] = [];
    s.fp.has = async (h, ms) => {
      if (h.role === "textbox" && !h.name && ms) {
        waits.push(ms);
        s.go("form");
      }
      return has(h, ms);
    };
    await loginOf("aws").signIn(ctxFor(s.fp, [], { username: "acme/w" }).ctx);
    expect(waits).toEqual([45_000]);
    expect(s.acts[0]).toBe("fill Account ID or alias=acme");
    const never = siteOf({ loading: { url: SIGN_IN, has: [] } }, "loading");
    await expect(
      loginOf("aws").signIn(ctxFor(never.fp, [], { username: "acme/w" }).ctx),
    ).rejects.toMatchObject({ refused: false, message: expect.stringMatching(/sign-in form/) });
  });

  it("the root user: the root button, the email, Next, the password", async () => {
    const s = siteOf(
      {
        form: {
          url: SIGN_IN,
          has: IAM_FORM,
          on: { "click button:Sign in using root user email": "email" },
        },
        email: {
          url: SIGN_IN,
          has: ["textbox:Root user email address", "button:Next"],
          on: { "click button:Next": "password" },
        },
        password: {
          url: SIGN_IN,
          has: ["textbox:Password", "button:Sign in"],
          on: { "click button:Sign in": "mfa" },
        },
        mfa: MFA,
        console: { url: CONSOLE, has: [] },
      },
      "form",
    );
    await loginOf("aws").signIn(ctxFor(s.fp, ["totp"], { username: "ops@wren.test" }).ctx);
    expect(s.acts.slice(0, 5)).toEqual([
      "click Sign in using root user email",
      "fill Root user email address=ops@wren.test",
      "click Next",
      "fill Password=pw-ig-1",
      "click Sign in",
    ]);
  });

  it("`aws login`: Allow on the confirmation page ends the walk", async () => {
    const CONFIRM = "https://signin.aws.amazon.com/v1/sessions/confirmation?x=1";
    const s = siteOf(
      {
        form: { url: SIGN_IN, has: IAM_FORM, on: { "click button:Sign in": "allow" } },
        allow: {
          url: CONFIRM,
          has: ["button:Allow access"],
          on: { "click button:Allow access": "done" },
        },
        done: { url: CONFIRM, has: ["button:Copy verification code"] },
      },
      "form",
    );
    await loginOf("aws").signIn(ctxFor(s.fp, [], { username: "acme/william" }).ctx);
    expect(s.acts.at(-1)).toBe("click Allow access");
  });

  it("refuses a wrong password, a wrong MFA code and a malformed username", async () => {
    const wrong = siteOf(
      {
        form: { url: SIGN_IN, has: IAM_FORM, on: { "click button:Sign in": "wrong" } },
        wrong: {
          url: SIGN_IN,
          has: IAM_FORM,
          text: "Your authentication information is incorrect.",
        },
      },
      "form",
    );
    await expect(
      loginOf("aws").signIn(ctxFor(wrong.fp, [], { username: "acme/w" }).ctx),
    ).rejects.toMatchObject({ refused: true, case: "password" });
    const code = siteOf(
      {
        mfa: {
          url: SIGN_IN,
          has: ["textbox:MFA code", "button:Submit"],
          on: { "click button:Submit": "bad" },
        },
        bad: { url: SIGN_IN, has: ["textbox:MFA code"], text: "The MFA code is not valid." },
      },
      "mfa",
    );
    await expect(
      loginOf("aws").signIn(ctxFor(code.fp, ["totp"], { username: "acme/w" }).ctx),
    ).rejects.toMatchObject({ refused: true, case: "code" });
    const bad = siteOf({ form: { url: SIGN_IN, has: IAM_FORM } }, "form");
    await expect(
      loginOf("aws").signIn(ctxFor(bad.fp, [], { username: "william" }).ctx),
    ).rejects.toMatchObject({ refused: true, case: "account" });
  });
});

describe("learn walk", () => {
  const ADFS = "https://adfs.uwaterloo.ca/adfs/ls/?SAMLRequest=x";
  const DUO = "https://api-1234.duosecurity.com/frame/v4/auth/prompt";
  const HOME = "https://learn.uwaterloo.ca/d2l/home";
  const states = {
    user: {
      url: ADFS,
      has: ["textbox:User Account", "button:Next"],
      on: { "click button:Next": "password" },
    },
    password: {
      url: ADFS,
      has: ["textbox:Password", "button:Sign in"],
      on: { "click button:Sign in": "push" },
    },
    push: {
      url: DUO,
      text: "Sent a Duo Push to your phone",
      has: ["text:Other options"],
      on: { "click text:Other options": "methods" },
    },
    methods: {
      url: DUO,
      has: ["button:Send a passcode", "textbox:Passcode", "button:Verify"],
      on: { "click button:Verify": "trust" },
    },
    trust: {
      url: DUO,
      has: ["button:Yes, this is my device"],
      on: { "click button:Yes, this is my device": "home" },
    },
    home: { url: HOME, has: [] },
  } satisfies Record<string, State>;

  it("signs in as outlook@uw; signInHere covers the university's sign-in, not Duo or LEARN", () => {
    const l = loginOf("learn");
    expect(l.credential).toBe("outlook@uw");
    const at = l.signInHere?.at as RegExp;
    expect(at.test(ADFS)).toBe(true);
    expect(at.test(DUO)).toBe(false);
    expect(at.test(HOME)).toBe(false);
  });

  it("account, password, past the push, the texted passcode, trust the device", async () => {
    const s = siteOf(states, "user");
    const { ctx, asked } = ctxFor(s.fp, ["sms"], { username: "wjin" });
    await loginOf("learn").signIn(ctx);
    expect(s.acts).toEqual([
      "fill User Account=wjin",
      "click Next",
      "fill Password=pw-ig-1",
      "click Sign in",
      "click Other options",
      "click Send a passcode",
      "fill Passcode=123456",
      "click Verify",
      "click Yes, this is my device",
    ]);
    expect(asked).toEqual(["sms"]);
    expect(s.opened).toEqual([HOME]);
  });

  it("a rejected password and a wrong passcode: refused with their cases", async () => {
    const wrong = siteOf(
      {
        ...states,
        password: { ...states.password, on: { "click button:Sign in": "rejected" } },
        rejected: { url: ADFS, has: ["textbox:Password"], text: "Incorrect user ID or password." },
      },
      "password",
    );
    await expect(loginOf("learn").signIn(ctxFor(wrong.fp, ["sms"]).ctx)).rejects.toMatchObject({
      refused: true,
      case: "password",
    });
    const code = siteOf(
      {
        ...states,
        methods: { ...states.methods, on: { "click button:Verify": "bad" } },
        bad: { url: DUO, has: ["textbox:Passcode"], text: "Incorrect passcode. Try again." },
      },
      "methods",
    );
    await expect(loginOf("learn").signIn(ctxFor(code.fp, ["sms"]).ctx)).rejects.toMatchObject({
      refused: true,
      case: "code",
    });
  });
});
