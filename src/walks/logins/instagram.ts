/**
 * Instagram's own login (the professional account). Its OAuth dialog shows the
 * login under the authorize URL: `signInHere` runs there in place, so the
 * `next` survives. Code: the authenticator when the page names it, else the
 * code Instagram emails on an unfamiliar login. Mapped from the public pages
 * 2026-09-21; unverified until a credential exists.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "/(phone|mobile) number, username,? or email/i" };
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/security code|confirmation code|^code$/i" };
const CONFIRM = { role: "button", name: "/^(confirm|submit|next|continue)$/i" };
const SEND = { role: "button", name: "/send (security )?code/i" };
const NOT_NOW = { role: "button", name: "/^not now$/i" };

export default {
  site: "instagram",
  name: "login",
  goal: "signed in to Instagram",
  start: "https://www.instagram.com/accounts/login/",
  signInHere: "/instagram\\.com\\/accounts\\/login|instagram\\.com\\/challenge/",
  screens: [
    {
      name: "signed-in",
      looks: "any Instagram page past the login, with no sign-in form",
      at: "/^https:\\/\\/(www\\.)?instagram\\.com\\/(?!accounts\\/(login|onetap)|challenge)/",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the password or the account is wrong",
      says: "/password was incorrect|incorrect password|user not found|couldn.t find your account/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "the code page says the code is wrong",
      says: "/code you entered|incorrect code|check the code/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "person-check",
      looks: "a selfie, captcha or suspicious-login check with no code box",
      says: "/suspicious|confirm it.s you|video selfie|captcha/i",
      hides: [CODE],
      person: { why: "Instagram wants a check only a person can pass" },
    },
    {
      name: "login-form",
      looks: "the username and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN },
      ],
    },
    {
      name: "app-code",
      looks: "the two-factor page asks for the authenticator code",
      says: "/authentication app|authenticator/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the authenticator code",
          kinds: ["totp"],
          field: CODE,
          submit: CONFIRM,
        },
      ],
    },
    {
      name: "emailed-code",
      looks: "an unusual-login check: send the code, then type it",
      at: "/two_factor|challenge/",
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the emailed code",
          kinds: ["email"],
          field: CODE,
          submit: CONFIRM,
          send: SEND,
        },
      ],
    },
    {
      name: "save-login",
      looks: '"Save your login info?" after the sign-in',
      at: "/instagram\\.com\\/accounts\\/onetap/",
      shows: [NOT_NOW],
      ops: [{ kind: "click", goal: "not now", hints: NOT_NOW, irreversible: false }],
    },
  ],
} satisfies WalkSpecInput;
