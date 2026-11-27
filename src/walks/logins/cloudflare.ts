/**
 * Cloudflare (dash.cloudflare.com): the `cloudflare` credential, by password or
 * through Google (`via: "google"`, or no password). Verified via Google 2026-09-19.
 * A returning browser shows a saved profile, "Continue as <email> using Google"
 * (seen 2026-09-28): ours rides the browser's live Google session and types no
 * secret; if Google then wants a password the session is gone and the try stops
 * (the account is personal: a rejected personal password is never retried).
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "Email" };
const PASSWORD = { role: "textbox", name: "Password" };
const LOG_IN = { role: "button", name: "/^(log|sign) ?in$/i" };
const CODE = { role: "textbox", name: "/code/i" };
const SAVED_PROFILE = { role: "button", name: "/^continue as .+ using google$/i" };

export default {
  site: "cloudflare",
  name: "login",
  goal: "signed in to the Cloudflare dashboard",
  start: "https://dash.cloudflare.com/login",
  home: "https://dash.cloudflare.com/",
  ask: "Your Cloudflare account (dash.cloudflare.com), where the domains get registered",
  screens: [
    {
      name: "dashboard",
      looks: "the Cloudflare dashboard, signed in",
      // a signed-in URL carries the 32-hex account id; the bare host is the pre-redirect state
      at: "/dash\\.cloudflare\\.com\\/[0-9a-f]{32}/",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "saved-profile",
      looks: "'Continue as <email> using Google', with 'Sign in with another profile'",
      shows: [SAVED_PROFILE],
      ops: [
        {
          kind: "pick-account",
          goal: "continue with the saved Google profile",
          tile: SAVED_PROFILE,
          // a long address is cut short: "jinwi…@gmail.com", "jinwi…"
          shows: "/continue as (.+?) using google/i",
          other: { role: "button", name: "Sign in with another profile" },
          ride: {
            // Google's chooser: the tile of an account the profile is signed in as
            pick: { text: "{address}" },
            stop: { role: "textbox", name: "/password/i" },
            why: "the saved Google session is gone and Google wants a password: sign in to Google once in the cloudflare profile",
          },
        },
      ],
    },
    {
      name: "rejected",
      looks: "the login form saying the email or password is wrong",
      shows: [PASSWORD],
      says: "/incorrect email or password|invalid credentials/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code",
      looks: "a box asking for an authenticator or two-factor code",
      shows: [CODE],
      says: "/authenticator|verification code|two-factor|2fa/i",
      ops: [
        {
          kind: "one-time-code",
          goal: "type the verification code",
          kinds: ["totp"],
          field: CODE,
          submit: { role: "button", name: "/continue|verify/i" },
        },
      ],
    },
    {
      name: "login-google",
      looks: "the login form, for an account made through Google",
      shows: [EMAIL],
      ops: [
        {
          kind: "provider",
          goal: "sign in with Google",
          provider: "google",
          button: { role: "button", name: "/google/i" },
        },
      ],
    },
    {
      name: "login-form",
      looks: "the Cloudflare login form: email and password boxes, and 'Sign in with Google'",
      shows: [EMAIL, PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: EMAIL },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN },
      ],
    },
  ],
} satisfies WalkSpecInput;
