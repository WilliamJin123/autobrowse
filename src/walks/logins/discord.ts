/**
 * Discord: email (or phone) and password on one page, then hCaptcha when it
 * doubts the device, then the authenticator when 2FA is on. A new location is
 * confirmed by a link Discord emails: that wall is a person's. Unproven live.
 * Its password re-check (`reauth`) stays in `ACCOUNT_CHORES`.
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "/email or phone/i" };
const PASSWORD = { role: "textbox", name: "/^password/i" };
const LOG_IN = { role: "button", name: "/^log ?in$/i" };
const CAPTCHA = { css: 'iframe[src*="hcaptcha"]' };
const CODE = { role: "textbox", name: "/code/i" };

export default {
  site: "discord",
  name: "login",
  goal: "signed in to Discord",
  start: "https://discord.com/login",
  home: "https://discord.com/channels/@me",
  screens: [
    {
      name: "signed-in",
      looks: "the Discord app, no Log In button",
      at: "/discord\\.com\\/(app|channels|developers|oauth2)/",
      hides: [PASSWORD, LOG_IN],
      goal: true,
    },
    {
      name: "captcha",
      looks: "hCaptcha on the login form",
      shows: [CAPTCHA],
      once: false,
      ops: [{ kind: "captcha", goal: "solve the captcha", box: CAPTCHA }],
    },
    {
      name: "rejected",
      looks: "the form says the login or password is invalid",
      says: "/login or password is invalid|invalid login/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "app-code",
      looks: "Discord asks for the authenticator code",
      says: "/multi-factor|auth(entication)? code|two-factor/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the authenticator code",
          kinds: ["totp"],
          field: CODE,
          submit: { role: "button", name: "/confirm|log ?in|verify/i" },
        },
      ],
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
  ],
} satisfies WalkSpecInput;
