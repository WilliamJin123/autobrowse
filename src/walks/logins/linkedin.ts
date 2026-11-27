/**
 * LinkedIn: the member's own login (email, password, authenticator key if set),
 * or "Continue with Google" for an account made that way (`via google`). An
 * OAuth authorize URL shows a signed-out profile /uas/login?session_redirect=…:
 * `signInHere` runs there in place, so the redirect survives. A security check
 * is the captcha solver's, else a person's. Mapped 2026-09-21/22.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "/email or phone/i" };
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const SIGN_IN = { role: "button", name: "/^sign in$/i" };
const CODE = { role: "textbox", name: "/code/i" };
const SUBMIT = { role: "button", name: "/^(submit|verify|continue)$/i" };
/** A profile that once held an account opens on "Choose an account", no Google button. */
const ANOTHER = { role: "link", name: "Sign in using another account" };
const SECURITY_CHECK = "/security check|puzzle|captcha|verify you.re a person/i";

const codeScreen = (name: string, looks: string, says: string, kind: "totp" | "sms" | "email") => ({
  name,
  looks,
  says,
  shows: [CODE],
  once: false,
  ops: [
    {
      kind: "one-time-code" as const,
      goal: `type the ${kind} code`,
      kinds: [kind],
      field: CODE,
      submit: SUBMIT,
    },
  ],
});

export default {
  site: "linkedin",
  name: "login",
  goal: "signed in to LinkedIn",
  start: "https://www.linkedin.com/login",
  home: "https://www.linkedin.com/feed/",
  ask: "Your LinkedIn login (email, password, authenticator key if set)",
  signInHere: "/linkedin\\.com\\/(uas\\/)?login|linkedin\\.com\\/checkpoint\\//",
  screens: [
    {
      name: "signed-in",
      looks: "the feed",
      at: "/linkedin\\.com\\/feed/",
      goal: true,
    },
    {
      name: "past-login",
      looks:
        "in place: any page off the login and its checks (the app's authorize page, the redirect)",
      at: "/^https:\\/\\/(?!(www\\.)?linkedin\\.com\\/[^?#]*(login|checkpoint|authwall|signup))/",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "restricted",
      looks: "the login-restriction page: LinkedIn wants a government ID",
      at: "/login-restriction/",
      refused: { says: "account restricted: LinkedIn asks for a government ID", case: "account" },
    },
    {
      name: "restricted-notice",
      looks: "the page says the account is restricted",
      says: "/account has been (temporarily )?restricted/i",
      refused: { says: "account restricted: LinkedIn asks for a government ID", case: "account" },
    },
    {
      name: "rejected",
      looks: "the form says the email or password is wrong",
      says: "/wrong email or password|not the right password|couldn.t find a linkedin account/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "the checkpoint says the code is wrong",
      says: "/wrong code|incorrect code|code you entered/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "security-check",
      looks: "a security check (reCAPTCHA or a puzzle) with no code box",
      says: SECURITY_CHECK,
      hides: [CODE],
      ops: [{ kind: "captcha", goal: "pass LinkedIn's security check" }],
    },
    {
      name: "login-form",
      looks: "the email and password boxes",
      at: "/linkedin\\.com\\/(uas\\/)?login/",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN },
      ],
    },
    {
      name: "choose-account",
      looks: '"Choose an account": a saved account, no form',
      shows: [ANOTHER],
      hides: [PASSWORD],
      ops: [
        {
          kind: "click",
          goal: "past the saved-account chooser",
          hints: ANOTHER,
          irreversible: false,
        },
      ],
    },
    {
      name: "google",
      looks: 'the login page\'s "Continue with Google" (Google draws it in its own frame)',
      at: "/linkedin\\.com\\/(uas\\/)?login/",
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google" }],
    },
    codeScreen(
      "app-code",
      "the checkpoint asks for the authenticator code",
      "/authenticator app/i",
      "totp",
    ),
    codeScreen(
      "texted-code",
      "the checkpoint asks for the code it texted",
      "/text message|sms|phone number/i",
      "sms",
    ),
    codeScreen(
      "emailed-code",
      "the checkpoint asks for the code it emailed",
      "/verification code|enter the code|email/i",
      "email",
    ),
  ],
} satisfies WalkSpecInput;
