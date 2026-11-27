/**
 * Login pages we know. Locators are visible labels, so a redesign fails
 * loudly and the repairer gets a chance. Every one is UNVERIFIED against
 * the live page until its first run; the memory layer keeps what worked.
 * Verified: cloudflare via Google (2026-09-19). Public login forms read
 * live on 2026-09-21 (headless explore): github, microsoft (first page), linkedin.
 */

import type { FlowPage } from "../browser/flow.js";
import { backFrom, clickOpening, type Walk, walk } from "../browser/screens.js";
// registers GitHub as an identity provider
import "./github.js";
import { signInToGoogle } from "./google.js";
import {
  addressOf,
  LoginFailed,
  type PasskeySetupSpec,
  type PasswordChangeSpec,
  passwordOf,
  type SignInContext,
  type SiteLogin,
  type TotpSetupSpec,
} from "./login.js";
import "./microsoft.js";
import { providerOf } from "./providers.js";

const CLOUDFLARE_HOME = /dash\.cloudflare\.com\/[0-9a-f]{32}/;
const CLOUDFLARE_LOGIN = "https://dash.cloudflare.com/login";
const GOOGLE_ACCOUNTS = /^https:\/\/accounts\.google\.com\//;

/** A returning browser's saved profile: "Continue as <email> using Google". Seen 2026-09-28. */
const SAVED_PROFILE = { role: "button", name: "/^continue as .+ using google$/i" } as const;
const OTHER_PROFILE = { role: "button", name: "Sign in with another profile" } as const;
const EMAIL = { role: "textbox", name: "Email" } as const;
const PASSWORD = { role: "textbox", name: "Password" } as const;
const LOG_IN = { role: "button", name: "/^(log|sign) ?in$/i" } as const;
const CODE = { role: "textbox", name: "/code/i" } as const;

/**
 * Whether a saved profile's label names this address. Cloudflare cuts a
 * long one short ("jinwi…@gmail.com", "jinwi…"): the shown parts, in order.
 */
export function savedProfileIs(label: string, address: string): boolean {
  const shown = label
    .match(/continue as (.+?) using google/i)?.[1]
    ?.trim()
    .toLowerCase();
  if (!shown || !address) return false;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cut = /(…|\.\.\.)$/.test(shown);
  const parts = shown.split(/…|\.\.\./).map(esc);
  return new RegExp(`^${parts.join(".*")}${cut ? "" : "$"}`).test(address.trim().toLowerCase());
}

/**
 * Cloudflare's sign-in as screens: whichever way the page comes (the form,
 * a saved profile, Google in a popup or a redirect, a code), the walk
 * does the right thing there and looks again.
 *
 * - A saved profile for this account rides the browser's live Google
 *   session: no secret typed. If Google then wants a password the session
 *   is gone, and the walk stops rather than type one (the account is
 *   personal; a rejected personal password is never retried).
 * - A saved profile for someone else: "Sign in with another profile".
 * - The form: the password, or the Google button when the account signs
 *   in via Google (the credential's `via`, or no password).
 */
export function cloudflareWalk(ctx: SignInContext): Walk<SignInContext> {
  const { cred } = ctx;
  const main = ctx.fp.page;
  const byGoogle = cred.via === "google" || !cred.password;
  const ours = (label: string) =>
    savedProfileIs(label, addressOf(cred)) || savedProfileIs(label, cred.username);
  let riding = false;
  let typedPrevious = false;
  const fail = (why: string): never => {
    throw new LoginFailed("cloudflare", why);
  };
  return {
    site: "cloudflare",
    name: "sign-in",
    goal: "signed in to the Cloudflare dashboard",
    fail,
    screens: [
      {
        name: "dashboard",
        looks: "the Cloudflare dashboard, signed in",
        at: CLOUDFLARE_HOME,
        hides: [PASSWORD],
        goal: true,
      },
      {
        name: "google",
        looks: "Google's own sign-in: account chooser, email, password or 2-step",
        at: GOOGLE_ACCOUNTS,
        async act(c) {
          const { fp } = c;
          if (riding) {
            // A tile for an account the profile is signed in as needs no password.
            const tile = { text: addressOf(cred) } as const;
            if (await fp.has(tile, 3_000))
              await fp.act({ kind: "click" }, tile, { goal: "pick the account" });
            else if (await fp.has({ role: "textbox", name: "/password/i" }))
              fail(
                "the saved Google session is gone and Google wants a password: sign in to Google once in the cloudflare profile",
              );
          } else {
            const google = await c.credFor(
              "google",
              cred.via === "google" ? cred.username : undefined,
            );
            await providerOf("google").signIn(c.as(google));
          }
          await backFrom(fp, main);
          await fp.waitForUrl(CLOUDFLARE_HOME, 30_000);
        },
      },
      {
        name: "saved profile",
        looks: "'Continue as <email> using Google', with 'Sign in with another profile'",
        shows: [SAVED_PROFILE],
        async act({ fp }) {
          if (ours(await fp.read(SAVED_PROFILE))) {
            riding = true;
            return clickOpening(fp, SAVED_PROFILE, "continue with the saved Google profile");
          }
          await fp.act({ kind: "click" }, OTHER_PROFILE, { goal: "sign in with another profile" });
        },
      },
      {
        name: "rejected",
        looks: "the login form saying the email or password is wrong",
        shows: [PASSWORD],
        says: /incorrect email or password|invalid credentials/i,
        async act({ fp }) {
          // A rotation the site took without saying so: the one before still works once.
          if (!cred.previousPassword || typedPrevious) fail("password rejected");
          typedPrevious = true;
          await fp.act({ kind: "fill", value: cred.previousPassword as string }, PASSWORD, {
            goal: "type the previous password",
          });
          await fp.act({ kind: "click" }, LOG_IN, { goal: "submit login form" });
        },
      },
      {
        name: "code",
        looks: "a box asking for an authenticator or two-factor code",
        shows: [CODE],
        says: /authenticator|verification code|two-factor|2fa/i,
        async act(c) {
          const code = await c.code("totp");
          await c.fp.act({ kind: "fill", value: code }, CODE, { goal: "type verification code" });
          await c.fp.act(
            { kind: "click" },
            { role: "button", name: "/continue|verify/i" },
            {
              goal: "submit verification code",
            },
          );
        },
      },
      {
        name: "login form",
        looks: "the Cloudflare login form: email and password boxes, and 'Sign in with Google'",
        shows: [EMAIL],
        async act({ fp }) {
          if (byGoogle)
            return clickOpening(fp, { role: "button", name: "/google/i" }, "sign in with google");
          await fp.act({ kind: "fill", value: cred.username }, EMAIL, { goal: "type username" });
          await fp.act({ kind: "fill", value: passwordOf("cloudflare", cred) }, PASSWORD, {
            goal: "type password",
          });
          await fp.act({ kind: "click" }, LOG_IN, { goal: "submit login form" });
        },
      },
    ],
  };
}

/**
 * Cloudflare: the stored `cloudflare` credential, by password or through
 * Google (`via: "google"`, or no password). One account can hold both;
 * the password goes first (`methodsOf`).
 */
const cloudflare: SiteLogin = {
  site: "cloudflare",
  home: "https://dash.cloudflare.com/",
  ask: "Your Cloudflare account (dash.cloudflare.com), where the domains get registered",
  via: ["google"],
  // A signed-in dashboard URL carries the 32-hex account id; the bare host is the pre-redirect state.
  loggedIn: async (fp) =>
    CLOUDFLARE_HOME.test(fp.url()) && !(await fp.has({ role: "textbox", name: "Password" })),
  async signIn(ctx: SignInContext) {
    await ctx.fp.open(CLOUDFLARE_LOGIN, { allowWall: true });
    await walk(ctx, cloudflareWalk(ctx));
  },
};

/** Where any Google account turns on an authenticator app. Mapped 2026-09-19 in explore mode. */
const GOOGLE_TOTP_SETUP: TotpSetupSpec = {
  // authuser= names the account: a profile with two Google accounts would otherwise get the first.
  url: (cred) =>
    `https://myaccount.google.com/two-step-verification/authenticator?authuser=${encodeURIComponent(cred.username)}`,
  reveal: [
    { role: "button", name: "Set up authenticator" },
    { role: "button", name: "/can.t scan it/i" },
  ],
  toCode: [{ role: "button", name: "Next" }],
  code: { role: "textbox", name: "/enter code/i" },
  confirm: { role: "button", name: "Verify" },
  done: /authenticator app added|authenticator app.*(on|set up)|turned on/i,
};

/** Mapped 2026-09-19: re-auth happens on the way in (signInHere), then two boxes and a button. */
const GOOGLE_PASSWORD_CHANGE: PasswordChangeSpec = {
  url: (cred) =>
    `https://myaccount.google.com/signinoptions/password?authuser=${encodeURIComponent(cred.username)}`,
  next: { role: "textbox", name: "New password" },
  confirm: { role: "textbox", name: "Confirm new password" },
  submit: { role: "button", name: "Change password" },
  done: /password changed|password was changed|your password has been changed|sign in with your new password|security checkup|myaccount\.google\.com\/(security|signinoptions\/password\?)/i,
};

/** Mapped 2026-09-19: "Create a passkey" runs the WebAuthn ceremony; the virtual authenticator answers it. */
const GOOGLE_PASSKEY_SETUP: PasskeySetupSpec = {
  url: (cred) =>
    `https://myaccount.google.com/signinoptions/passkeys?authuser=${encodeURIComponent(cred.username)}`,
  create: { role: "button", name: "/create a passkey|create passkey/i" },
  confirmations: [{ role: "button", name: "/^continue passkey enrollment$/i" }],
  done: /passkey created|you can now use your passkey|passkeys? you created|created (a )?passkey/i,
};

/** Google re-asks for the password on security pages; answer on the spot. */
const GOOGLE_SIGN_IN_HERE = {
  at: /^https:\/\/accounts\.google\.com\//,
  run: signInToGoogle,
  // A re-verify inside a consent ends on the scope grant, still on accounts.google.com.
  past: /^https:\/\/accounts\.google\.com\/signin\/oauth\//,
};

/** A Google Account page, not its signed-out `/intro/` twin. */
const GOOGLE_SIGNED_IN = /^https:\/\/myaccount\.google\.com\/(?!intro(\/|\?|$))/;

/** The personal Google account: what "Sign in with Google" buttons use. */
const google: SiteLogin = {
  site: "google",
  home: "https://myaccount.google.com/",
  origins: ["google.com"],
  // Products off google.com: their pages take google's tools and sign-in (WA-1036). Add one when a run meets it.
  properties: ["youtube.com", "blogger.com", "withgoogle.com", "google.dev"],
  ask: 'Your Google account: the one behind every "Sign in with Google" button',
  loggedIn: async (fp) => GOOGLE_SIGNED_IN.test(fp.url()),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/",
      { allowWall: true },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(GOOGLE_SIGNED_IN, 30_000)))
      throw new LoginFailed("google", `still on ${ctx.fp.url()} after Google sign-in`);
  },
  signInHere: GOOGLE_SIGN_IN_HERE,
  totpSetup: GOOGLE_TOTP_SETUP,
  passwordChange: GOOGLE_PASSWORD_CHANGE,
  passkeySetup: GOOGLE_PASSKEY_SETUP,
};

/**
 * The Workspace admin console: its own credential, a Workspace admin of
 * the domains (a personal Gmail signs in fine and then gets "Sign in with
 * an administrator account").
 */
/**
 * A Google app (Gmail, Drive, …) is not a login of its own: it signs in
 * with the Google account, `google` (or `google@<label>` for `gmail@<label>`).
 * Signed in = the app's own page loads without a detour to accounts.google.com.
 */
function googleApp(site: string, home: string, signedIn: RegExp): SiteLogin {
  return {
    ...google,
    site,
    home,
    credential: "google",
    // google's products are google's: a YouTube page lists google-login, not gmail-login
    properties: [],
    ask: `Your Google account: ${site} signs in with it`,
    loggedIn: async (fp) => signedIn.test(fp.url()),
    async signIn(ctx) {
      await google.signIn(ctx);
      await ctx.fp.open(home, { allowWall: true });
      if (!(await ctx.fp.waitForUrl(signedIn, 30_000)))
        throw new LoginFailed(site, `still on ${ctx.fp.url()} after Google sign-in`);
    },
  };
}

const GOOGLE_APPS: readonly SiteLogin[] = [
  googleApp("gmail", "https://mail.google.com/mail/u/0/", /^https:\/\/mail\.google\.com\/mail\//),
  googleApp(
    "drive",
    "https://drive.google.com/drive/my-drive",
    /^https:\/\/drive\.google\.com\/drive\//,
  ),
  googleApp(
    "calendar",
    "https://calendar.google.com/calendar/r",
    /^https:\/\/calendar\.google\.com\/calendar\//,
  ),
  googleApp(
    "docs",
    "https://docs.google.com/document/u/0/",
    /^https:\/\/docs\.google\.com\/document\//,
  ),
  googleApp(
    "sheets",
    "https://docs.google.com/spreadsheets/u/0/",
    /^https:\/\/docs\.google\.com\/spreadsheets\//,
  ),
];

const googleAdmin: SiteLogin = {
  site: "google-admin",
  // The Workspace admin is a Google account with the `admin` role (`creds role google admin <account>`).
  credential: "google@admin",
  home: "https://admin.google.com/",
  ask: "A Google Workspace admin (admin.google.com) for the mail domains; a personal Gmail is refused there",
  loggedIn: async (fp) =>
    /admin\.google\.com/.test(fp.url()) &&
    !/accounts\.google\.com/.test(fp.url()) &&
    !(await fp.has({ text: "/administrator account/i" })),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://admin.google.com/",
      { allowWall: true },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(/admin\.google\.com/, 30_000)))
      throw new LoginFailed("google-admin", `still on ${ctx.fp.url()} after Google sign-in`);
    await ctx.fp.wait(1_500);
    if (await ctx.fp.has({ text: "/administrator account/i" }))
      throw new LoginFailed(
        "google-admin",
        `${ctx.cred.username} is not a Workspace admin; give the admin account the role: autobrowse creds role google admin <account>`,
      );
  },
  signInHere: GOOGLE_SIGN_IN_HERE,
  totpSetup: GOOGLE_TOTP_SETUP,
  passwordChange: GOOGLE_PASSWORD_CHANGE,
  passkeySetup: GOOGLE_PASSKEY_SETUP,
};

/**
 * npm. The sign-in page is plain and loads headless (mapped 2026-09-22:
 * textbox "Username", textbox "Password", button "Sign In"). The username,
 * not the address, is what npm knows the account by, so `signup --by-hand
 * --handle` stores the handle as the credential's username and keeps the
 * address as `codesInbox`. Signed in, npmjs.com shows
 * the account menu instead of the Sign In link.
 *
 * Second step, mapped 2026-09-22: with no 2FA, npm emails a one-time
 * password on every sign-in (/login/email-otp, textbox "One-Time
 * Password", button "Login"). Once an authenticator is enrolled it asks
 * for that instead — unverified until then.
 */
/**
 * npm 2FA is security keys only for a new enrollment (2026-09-22: the method
 * list offers nothing else). The virtual authenticator is the key; the
 * passkey and the recovery codes npm shows once are sealed with the
 * credential. Mapped live to "Add security key"; past that is unverified.
 */
const NPM_PASSKEY_SETUP: PasskeySetupSpec = {
  url: (cred) => `https://www.npmjs.com/settings/${cred.username}/tfa`,
  before: [{ role: "button", name: "/^continue/i" }],
  name: { role: "textbox", name: "/security key name/i" },
  create: { role: "button", name: "Add security key" },
  done: /recovery codes|manage security keys|two-factor authentication (is )?(enabled|on)|security key (was )?added/i,
};

/** npm's key prompt, at sign-in and before sensitive pages ("Click the button below when you are ready to authenticate"). */
const NPM_USE_KEY = { role: "button", name: "Use security key" } as const;

/** Perplexity's page alone does not say who is signed in; its session endpoint does (perplexity-ask). */
export const perplexitySignedIn = (fp: FlowPage): Promise<boolean> =>
  fp.page.evaluate<boolean>(
    `fetch("/api/auth/session").then((r) => r.json()).then((j) => Boolean(j && j.user)).catch(() => false)`,
  );

/**
 * Account chores of sites whose sign-in is a walk file (src/walks/logins/):
 * not sign-in steps, so they stay code; `repoWalkLogins` merges them in.
 */
export const ACCOUNT_CHORES: Readonly<
  Record<
    string,
    Pick<SiteLogin, "reauth" | "totpSetup" | "passwordChange" | "passkeySetup" | "recoveryCodes">
  >
> = {
  npm: {
    passkeySetup: NPM_PASSKEY_SETUP,
    // Five 64-hex codes, behind the key (mapped 2026-09-22).
    recoveryCodes: {
      url: (cred) => `https://www.npmjs.com/settings/${cred.username}/recovery-codes`,
      unlock: NPM_USE_KEY,
      codes: /\b[0-9a-f]{64}\b/i,
    },
  },
  // Mapped 2026-10-02: a bot token reset opens "Multi-Factor Authentication" with this box.
  discord: {
    reauth: {
      field: { role: "textbox", name: "/enter your password/i" },
      submit: { role: "button", name: "/^submit$/i" },
    },
  },
};

/**
 * Apps a repo walk signs in to with its own credential: the walk's site → each app
 * and its setup prompt. `repoWalkLogins` adds one login per app, after the walk's.
 */
export const WALK_APPS: Readonly<Record<string, readonly { site: string; ask: string }[]>> = {
  // personal at outlook.live.com, work at outlook.office.com; one sign-in host
  microsoft: [
    {
      site: "outlook",
      ask: "The Microsoft account whose mailbox Outlook shows (personal or work)",
    },
  ],
};

export const SITE_LOGINS: readonly SiteLogin[] = [
  cloudflare,
  google,
  // After google: a lookup by credential name finds google itself first.
  ...GOOGLE_APPS,
  googleAdmin,
];

const BUILT_IN = new Set(SITE_LOGINS);

/** A built-in login for this site or credential name, if any (not one added from data). */
export const builtInLogin = (name: string): SiteLogin | undefined =>
  SITE_LOGINS.find((l) => BUILT_IN.has(l) && (l.site === name || l.credential === name));

/**
 * Logins from data (src/mods/login.ts), added at start after every
 * built-in. One whose site or credential name is already taken is skipped:
 * a built-in, then the first added, wins.
 */
export function addSiteLogins(more: readonly SiteLogin[]): void {
  for (const l of more)
    if (!SITE_LOGINS.some((s) => s.site === l.site || (s.credential ?? s.site) === l.site))
      (SITE_LOGINS as SiteLogin[]).push(l);
}
