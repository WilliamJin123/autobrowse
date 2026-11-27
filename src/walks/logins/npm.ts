/**
 * npm: username and password, then our passkey when it asks for a security
 * key, an emailed one-time password on a new browser, or the authenticator.
 * Its account chores (passkey setup, recovery codes) stay in `ACCOUNT_CHORES`.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "Username" };
const PASSWORD = { role: "textbox", name: "Password" };
const SIGN_IN = { role: "button", name: "Sign In" };
const SIGN_IN_LINK = { role: "link", name: "Sign In" };
const USE_KEY = { role: "button", name: "Use security key" };
const EMAIL_CODE = { role: "textbox", name: "One-Time Password" };
const APP_CODE = { role: "textbox", name: "/code|one-time password/i" };

export default {
  site: "npm",
  name: "login",
  goal: "signed in to npm",
  start: "https://www.npmjs.com/login",
  home: "https://www.npmjs.com/",
  screens: [
    {
      name: "signed-in",
      looks: "an npm page with no Sign In link",
      at: "/npmjs\\.com\\/(?!login)/",
      hides: [PASSWORD, SIGN_IN_LINK],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the username or password is wrong",
      says: "/incorrect username or password|invalid credentials/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "security-key",
      looks: "npm asks for the security key",
      says: "/security key|ready to authenticate/i",
      shows: [USE_KEY],
      ops: [{ kind: "passkey", goal: "verify with our passkey", start: USE_KEY }],
    },
    {
      name: "emailed-code",
      looks: "npm says it emailed a one-time password",
      says: "/sent a one-time password to your email/i",
      shows: [EMAIL_CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the emailed code",
          kinds: ["email"],
          field: EMAIL_CODE,
          submit: { role: "button", name: "Login" },
          hint: "npm",
        },
      ],
    },
    {
      // no `says`: the sign-in page's own banner can say "2FA" (10-26), so only the box decides
      name: "app-code",
      looks: "the authenticator code box",
      shows: [APP_CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the authenticator code",
          kinds: ["totp"],
          field: APP_CODE,
          submit: { role: "button", name: "/verify|submit|continue|login/i" },
        },
      ],
    },
    {
      name: "login-form",
      looks: "the username and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN },
      ],
    },
  ],
} satisfies WalkSpecInput;
