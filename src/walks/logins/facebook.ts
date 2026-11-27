/**
 * Facebook's own login (the person behind the Meta app). Its OAuth dialog
 * shows the login under the authorize URL: `signInHere` runs there in place.
 * Code kind from the page: the authenticator, a text, else an email. Mapped
 * from the public pages 2026-09-22; unproven live.
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "/email( address)? or phone( number)?|^email$/i" };
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/^code$|login code|6-digit|security code/i" };
const CONTINUE = { role: "button", name: "/^(continue|submit|next|confirm)$/i" };
const DECLINE = { role: "button", name: "/^(don.t save|not now|skip)$/i" };

const codeScreen = (name: string, looks: string, says: string, kind: "totp" | "sms" | "email") => ({
  name,
  looks,
  says,
  shows: [CODE],
  once: false,
  ops: [
    { kind: "one-time-code" as const, goal: `type the ${kind} code`, kinds: [kind], field: CODE, submit: CONTINUE },
  ],
});

export default {
  site: "facebook",
  name: "login",
  goal: "signed in to Facebook",
  start: "https://www.facebook.com/login/",
  home: "https://www.facebook.com/",
  origins: ["facebook.com", "meta.com", "fb.com"],
  signInHere: "/facebook\\.com\\/(login|checkpoint|two_step_verification|two_factor|recover)/",
  screens: [
    {
      name: "signed-in",
      looks: "any Facebook page past the login and its checks, the OAuth dialog among them",
      at: "/^https:\\/\\/(www\\.|m\\.)?facebook\\.com\\/(?!login|checkpoint|two_step_verification|two_factor|recover)/",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the password or the account is wrong",
      says: "/password (you.ve entered|that you.ve entered) is incorrect|wrong credentials|invalid (username|email)/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "the code page says the code is wrong",
      says: "/code (you entered )?(is|was) (incorrect|invalid)|incorrect code/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "person-check",
      looks: "a selfie, photo or identity check with no code box",
      says: "/confirm your identity|video selfie|upload (a )?photo|locked|suspicious/i",
      hides: [CODE],
      person: { why: "Facebook wants a check only a person can pass" },
    },
    {
      name: "login-form",
      looks: "the email and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: EMAIL },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN },
      ],
    },
    codeScreen("app-code", "the two-factor page asks for the authenticator code", "/authentication app|authenticator/i", "totp"),
    codeScreen("texted-code", "the two-factor page asks for the code it texted", "/\\btext(ed)?\\b|sms|phone/i", "sms"),
    codeScreen("emailed-code", "the two-factor page asks for the code it emailed", "/two-factor|login code|6-digit|email/i", "email"),
    {
      name: "save-browser",
      looks: "\"Save browser?\" or \"Trust this device?\" after the code",
      shows: [DECLINE],
      hides: [CODE, PASSWORD],
      once: false,
      ops: [{ kind: "click", goal: "not now", hints: DECLINE, irreversible: false }],
    },
  ],
} satisfies WalkSpecInput;
