/**
 * TikTok's own login: the email/username tab, password, "Log in"; then the
 * code TikTok emails on a new device. Its slider puzzle is a person's.
 * Mapped from the public pages 2026-09-21; unproven live.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "/email or username/i" };
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/6-digit code|verification code|enter code/i" };
const SUBMIT = { role: "button", name: "/^(next|confirm|submit|verify|continue)$/i" };
const USE_EMAIL = { text: "/use phone \\/ email \\/ username/i" };
const EMAIL_TAB = { role: "link", name: "/log in with email or username/i" };
const SLIDER = "/drag the slider|verify to continue|slide to verify|captcha/i";

export default {
  site: "tiktok",
  name: "login",
  goal: "signed in to TikTok",
  start: "https://www.tiktok.com/login/phone-or-email/email",
  home: "https://www.tiktok.com/foryou",
  signInHere: "/tiktok\\.com\\/login/",
  screens: [
    {
      name: "signed-in",
      looks: "a TikTok page past the login with no Log in button",
      at: "/^https:\\/\\/(www\\.)?tiktok\\.com\\/(?!login)/",
      hides: [LOG_IN, PASSWORD],
      goal: true,
    },
    {
      name: "rejected",
      looks: "TikTok says the password or the account is wrong",
      says: "/doesn.t match our records|incorrect (account|password)|password is incorrect/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "TikTok says the code is wrong or old",
      says: "/code (is )?(incorrect|invalid|expired)/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "slider",
      looks: "the slider puzzle",
      says: SLIDER,
      person: { why: "TikTok wants its slider puzzle solved" },
    },
    {
      name: "login-form",
      looks: "the email-or-username and password boxes",
      shows: [USERNAME],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN },
      ],
    },
    {
      name: "app-code",
      looks: "a new device: the authenticator code",
      says: "/authenticator/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the totp code",
          kinds: ["totp"],
          field: CODE,
          submit: SUBMIT,
        },
      ],
    },
    {
      name: "emailed-code",
      looks: "a new device: the 6-digit code TikTok emails",
      says: "/verification code|6-digit code|verify your account/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the email code",
          kinds: ["email"],
          field: CODE,
          submit: SUBMIT,
        },
      ],
    },
    {
      name: "chooser",
      looks: '"Use phone / email / username" among the ways in',
      shows: [USE_EMAIL],
      ops: [{ kind: "click", goal: "email sign-in", hints: USE_EMAIL, irreversible: false }],
    },
    {
      name: "phone-tab",
      looks: "the phone tab with its link to the email tab",
      shows: [EMAIL_TAB],
      ops: [{ kind: "click", goal: "the email tab", hints: EMAIL_TAB, irreversible: false }],
    },
    {
      name: "other-login-page",
      looks: "a login page with no email box and no link to it",
      at: "/tiktok\\.com\\/login/",
      hides: [USERNAME, EMAIL_TAB, USE_EMAIL],
      ops: [
        {
          kind: "open",
          goal: "the email tab",
          url: "https://www.tiktok.com/login/phone-or-email/email",
        },
      ],
    },
  ],
} satisfies WalkSpecInput;
