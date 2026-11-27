/**
 * GitHub: its own password, then the authenticator, a text or an emailed code
 * (never GitHub Mobile, William 09-27), a device code by email on a new
 * profile, and an OAuth app's authorize page the first time. Or "Continue with
 * Google" (`via google`). Also the sign-in behind "Continue with GitHub" on
 * other sites (src/auth/github.ts): it runs in place on whatever GitHub page
 * the button opened, so the `return_to` survives.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "/username or email/i" };
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const SIGN_IN = { role: "button", name: "/^sign in$/i" };
const SIGN_IN_LINK = { role: "link", name: "/^sign in$/i" };
const GOOGLE = { text: "/continue with google/i" };
const OTP = { role: "textbox", name: "/code|xxxxxx/i" };
const DEVICE_CODE = { role: "textbox", name: "/verification code|device verification/i" };
const VERIFY = { role: "button", name: "/^verify$/i" };
const SEND = { role: "button", name: "/send|resend/i" };
const MORE = { role: "button", name: "/more options/i" };
const AUTHORIZE = { role: "button", name: "/^authorize/i" };

const WAYS = [
  { kind: "totp", path: "(\\/app)?(\\?|$)", choice: { text: "/authenticator app/i" } },
  { kind: "sms", path: "\\/sms", choice: { text: "/text message|sms/i" } },
  { kind: "email", path: "\\/email", choice: { text: "/email/i" } },
] as const;

export default {
  site: "github",
  name: "login",
  goal: "signed in to GitHub",
  start: "https://github.com/login",
  // The public home page is no wall; settings is, so opening it starts the sign-in.
  home: "https://github.com/settings/profile",
  ask: "Your GitHub login (username, password, authenticator key if set)",
  signInHere: "/github\\.com\\/(login|session)/",
  screens: [
    {
      name: "signed-in",
      looks: "any page off GitHub's login and its checks, with no sign-in form or link",
      at: "/^https:\\/\\/(?!github\\.com\\/(login|session))/",
      hides: [PASSWORD, SIGN_IN_LINK],
      goal: true,
    },
    {
      name: "left-github",
      looks: 'as "Continue with GitHub": back on the site that asked',
      at: "/^https:\\/\\/(?!([a-z0-9-]+\\.)?github\\.com)/",
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the username or password is wrong",
      says: "/incorrect username or password/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "the two-factor page says the code failed",
      says: "/two-factor authentication failed|incorrect (verification )?code/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "login-form",
      looks: "the username and password boxes",
      at: "/github\\.com\\/(login|session)/",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN },
      ],
    },
    {
      name: "google",
      looks: 'the login page\'s "Continue with Google"',
      at: "/github\\.com\\/(login|session)/",
      shows: [GOOGLE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
    ...WAYS.map((w) => ({
      name: `${w.kind}-code`,
      looks: `the two-factor page for a ${w.kind} code`,
      at: `/github\\.com\\/sessions\\/two-factor${w.path}/`,
      shows: [OTP],
      needs: w.kind,
      once: false,
      ops: [
        {
          kind: "one-time-code" as const,
          goal: `type the ${w.kind} code`,
          kinds: [w.kind],
          field: OTP,
          submit: VERIFY,
          ...(w.kind === "totp" ? {} : { send: SEND }),
        },
      ],
    })),
    ...WAYS.map((w) => ({
      name: `pick-${w.kind}`,
      looks: `the two-factor ways, ${w.kind} among them`,
      at: "/github\\.com\\/sessions\\/two-factor/",
      shows: [w.choice],
      hides: [OTP],
      needs: w.kind,
      ops: [
        {
          kind: "click" as const,
          goal: `use a ${w.kind} code`,
          hints: w.choice,
          irreversible: false,
        },
      ],
    })),
    {
      name: "more-options",
      looks: "a two-factor page with no way we answer (GitHub Mobile): More options",
      at: "/github\\.com\\/sessions\\/two-factor/",
      shows: [MORE],
      ops: [
        { kind: "click", goal: "show the other two-factor ways", hints: MORE, irreversible: false },
      ],
    },
    {
      name: "device-code",
      looks: "device verification: GitHub emailed a code to a new profile",
      says: "/device verification/i",
      shows: [DEVICE_CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the device verification code",
          kinds: ["email"],
          field: DEVICE_CODE,
          submit: VERIFY,
        },
      ],
    },
    {
      name: "authorize",
      looks: "an OAuth app's authorize page, the first time through",
      at: "/github\\.com\\/login\\/oauth\\/authorize/",
      shows: [AUTHORIZE],
      ops: [{ kind: "click", goal: "authorize the app", hints: AUTHORIZE, irreversible: false }],
    },
  ],
} satisfies WalkSpecInput;
