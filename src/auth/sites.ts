/**
 * What sign-in walk files (src/walks/logins/) cannot hold: account chores
 * (authenticator, password change, passkey, recovery codes) and the apps a
 * walk signs in to on its credential (`WALK_APPS`). Locators are visible
 * labels, so a redesign fails loudly and the repairer gets a chance.
 */

import type { FlowPage } from "../browser/flow.js";
// registers GitHub as an identity provider
import "./github.js";
// registers Google as an identity provider
import "./google.js";
import type { PasskeySetupSpec, PasswordChangeSpec, SiteLogin, TotpSetupSpec } from "./login.js";
import "./microsoft.js";
import type { WalkSpecInput } from "../walks/spec.js";

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
  google: {
    totpSetup: GOOGLE_TOTP_SETUP,
    passwordChange: GOOGLE_PASSWORD_CHANGE,
    passkeySetup: GOOGLE_PASSKEY_SETUP,
  },
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

/** One app a repo walk signs in to: its own site name, prompt and, when not the walk's, pages. */
export interface WalkApp {
  site: string;
  ask: string;
  /** Its stored credential; default the walk's site. */
  credential?: string;
  /** Where its sign-in opens and its signed-in page; default the walk's. */
  start?: string;
  home?: string;
  /** Its signed-in page: replaces the walk's goals, so a sign-in ends there. */
  signedIn?: WalkScreen;
  /** Its own refusals, before the walk's screens. */
  screens?: readonly WalkScreen[];
}
type WalkScreen = WalkSpecInput["screens"][number];

/** A Google app (Gmail, Drive, …): the `google` account, ending on the app's own page. */
const googleApp = (site: string, home: string, signedIn: string): WalkApp => ({
  site,
  ask: `Your Google account: ${site} signs in with it`,
  start: `https://accounts.google.com/ServiceLogin?continue=${home}`,
  home,
  signedIn: { name: site, looks: `${site}, signed in`, at: signedIn, goal: true },
});

/** admin.google.com refuses a personal Gmail after its sign-in. */
const NOT_ADMIN = { text: "/administrator account/i" };

/**
 * Apps a repo walk signs in to with its own credential: the walk's site → each app.
 * `repoWalkLogins` adds one login per app, after the walk's.
 */
export const WALK_APPS: Readonly<Record<string, readonly WalkApp[]>> = {
  // personal at outlook.live.com, work at outlook.office.com; one sign-in host
  microsoft: [
    {
      site: "outlook",
      ask: "The Microsoft account whose mailbox Outlook shows (personal or work)",
    },
  ],
  google: [
    googleApp(
      "gmail",
      "https://mail.google.com/mail/u/0/",
      "/^https:\\/\\/mail\\.google\\.com\\/mail\\//",
    ),
    googleApp(
      "drive",
      "https://drive.google.com/drive/my-drive",
      "/^https:\\/\\/drive\\.google\\.com\\/drive\\//",
    ),
    googleApp(
      "calendar",
      "https://calendar.google.com/calendar/r",
      "/^https:\\/\\/calendar\\.google\\.com\\/calendar\\//",
    ),
    googleApp(
      "docs",
      "https://docs.google.com/document/u/0/",
      "/^https:\\/\\/docs\\.google\\.com\\/document\\//",
    ),
    googleApp(
      "sheets",
      "https://docs.google.com/spreadsheets/u/0/",
      "/^https:\\/\\/docs\\.google\\.com\\/spreadsheets\\//",
    ),
    {
      site: "google-admin",
      // a Google account with the `admin` role (`creds role google admin <account>`)
      credential: "google@admin",
      ask: "A Google Workspace admin (admin.google.com) for the mail domains; a personal Gmail is refused there",
      start: "https://accounts.google.com/ServiceLogin?continue=https://admin.google.com/",
      home: "https://admin.google.com/",
      signedIn: {
        name: "admin-console",
        looks: "the Workspace admin console",
        at: "/^https:\\/\\/admin\\.google\\.com\\//",
        hides: [NOT_ADMIN],
        goal: true,
      },
      screens: [
        {
          name: "not-admin",
          looks: "admin.google.com asking to sign in with an administrator account",
          at: "/^https:\\/\\/admin\\.google\\.com\\//",
          shows: [NOT_ADMIN],
          refused: {
            says: "not a Workspace admin; give the admin account the role: autobrowse creds role google admin <account>",
            case: "account",
          },
        },
      ],
    },
  ],
};

/** Every login; filled at boot (`addSiteLogins`): the repo's walks first, then data logins. */
export const SITE_LOGINS: readonly SiteLogin[] = [];

/** The repo's own logins (its sign-in walks): no mod or owner login replaces one. */
const BUILT_IN = new Set<SiteLogin>();

/** A built-in login for this site or credential name, if any (not one added from data). */
export const builtInLogin = (name: string): SiteLogin | undefined =>
  SITE_LOGINS.find((l) => BUILT_IN.has(l) && (l.site === name || l.credential === name));

/**
 * Add logins at start: the repo's walks (`builtIn`), then data logins
 * (src/mods/login.ts). One whose site or credential name is already taken
 * is skipped: a built-in, then the first added, wins.
 */
export function addSiteLogins(more: readonly SiteLogin[], o: { builtIn?: boolean } = {}): void {
  for (const l of more)
    if (!SITE_LOGINS.some((s) => s.site === l.site || (s.credential ?? s.site) === l.site)) {
      (SITE_LOGINS as SiteLogin[]).push(l);
      if (o.builtIn) BUILT_IN.add(l);
    }
}
