/**
 * Microsoft: the sign-in behind Outlook on the web and "Sign in with Microsoft"
 * (login.microsoftonline.com, login.live.com). The pages come in an order that
 * depends on the account and the browser: a picker or not, a passwordless prompt,
 * a phone prompt or a code, "Stay signed in?", an app's permissions the first time.
 * As a provider it runs in place on Microsoft's host until the page leaves it.
 * `outlook` signs in with this walk and the `microsoft` credential (`repoWalkLogins`).
 */

import type { WalkSpecInput } from "../spec.js";

const MS = "/^https:\\/\\/login\\.(microsoftonline|live|microsoft)\\.com\\//";
const EMAIL = { role: "textbox", name: "/email|phone|skype|sign in/i" };
const PASSWORD = { role: "textbox", name: "/password/i" };
const CODE = { role: "textbox", name: "/code/i" };
const VERIFY = { role: "button", name: "/^verify$/i" };
/** On the phone-prompt page: the way to the list of other ways. */
const OTHER_WAY = {
  text: "/use a verification code|i can.t use my microsoft authenticator|sign in another way/i",
};
const VIA_CODE = { text: "/verification code/i" };
const USE_PASSWORD = { text: "/use your password/i" };
const PUSH = {
  way: "push",
  ask: "approve it in the Authenticator app",
  // the number to tap
  note: "/\\b(\\d{2})\\b/",
  // off Microsoft's host, or on to "Stay signed in?" or an app's permissions
  until: "/^(?!https:\\/\\/login\\.(microsoftonline|live|microsoft)\\.com\\/)|kmsi|consent/",
} as const;
/** The list's "Text +X XXXXXXX12": our phone by its last two digits. */
const SMS = {
  way: "sms",
  choice: { text: "/^text .*{phoneTail}\\b/i" },
  field: CODE,
  submit: VERIFY,
  hint: "Microsoft",
} as const;

export default {
  site: "microsoft",
  name: "login",
  goal: "signed in with Microsoft",
  start: "https://outlook.live.com/mail/0/",
  home: "https://outlook.live.com/mail/0/",
  signInHere: MS,
  ask: "Your Microsoft account, personal or work (username, password, authenticator key if set)",
  // the password goes in on Microsoft's sign-in hosts, not on outlook.live.com
  origins: ["live.com", "microsoftonline.com", "microsoft.com"],
  // products the account names, for a labelled site on this surface
  properties: ["office.com", "azure.com", "microsoft365.com"],
  screens: [
    {
      name: "mailbox",
      looks: "Outlook's mailbox",
      at: "/^https:\\/\\/outlook\\.(live|office)\\.com\\/mail\\//",
      goal: true,
    },
    {
      name: "left",
      looks: "the app the sign-in was for, off Microsoft's sign-in host",
      // Outlook counts only at its mailbox: its own pages before the sign-in are not an app
      at: "/^https?:\\/\\/(?!login\\.(microsoftonline|live|microsoft)\\.com|outlook\\.)/",
      goal: true,
    },
    {
      name: "unknown-account",
      looks: "Microsoft saying it has no such account",
      at: MS,
      says: "/couldn.t find an account|that microsoft account doesn.t exist/i",
      refused: { says: "unknown account", case: "account" },
    },
    {
      name: "rejected",
      looks: "Microsoft saying the password is wrong",
      at: MS,
      says: "/password is incorrect|account or password is incorrect/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "wrong-code",
      looks: "Microsoft saying the code is wrong",
      at: MS,
      says: "/code (you entered )?(didn.t work|is incorrect|isn.t right)|wrong code/i",
      refused: { says: "Microsoft refused the code", case: "code" },
    },
    {
      name: "stay-signed-in",
      looks: "'Stay signed in?' with Yes and No",
      at: MS,
      says: "/stay signed in/i",
      // keeps the profile's session
      ops: [
        {
          kind: "click",
          goal: "stay signed in",
          hints: { role: "button", name: "/^yes$/i" },
          irreversible: false,
        },
      ],
    },
    {
      name: "permissions",
      looks: "an app's 'Permissions requested' page, the first time through it",
      at: MS,
      says: "/permissions requested/i",
      ops: [
        {
          kind: "click",
          goal: "accept the app's permissions",
          hints: { role: "button", name: "/^accept$/i" },
          irreversible: false,
        },
      ],
    },
    {
      name: "pick-account",
      looks: "a picker of accounts the browser knows, and 'Use another account'",
      at: MS,
      says: "/pick an account/i",
      ops: [
        {
          kind: "pick-account",
          goal: "pick the account",
          tile: { text: "/{username}/i" },
          other: { text: "/use another account/i" },
        },
      ],
    },
    {
      name: "code",
      looks: "a box for the authenticator app's code",
      at: MS,
      shows: [CODE],
      ops: [
        {
          kind: "one-time-code",
          goal: "type the authenticator code",
          kinds: ["totp"],
          field: CODE,
          submit: VERIFY,
        },
      ],
    },
    {
      name: "passwordless",
      // a prompt, then the list; the kit stops a third list
      once: false,
      looks: "a passwordless prompt (approve on the phone, or a code) offering 'Use your password'",
      at: MS,
      shows: [USE_PASSWORD],
      hides: [PASSWORD],
      ops: [
        {
          kind: "second-step",
          goal: "answer the passwordless prompt",
          // the password needs no person; the phone does
          ways: [
            { way: "password", choice: USE_PASSWORD },
            { way: "totp", choice: OTHER_WAY },
            PUSH,
          ],
        },
      ],
    },
    {
      name: "second-step",
      // a prompt, then the list; the kit stops a third list
      once: false,
      looks: "a second step: verify your identity, or approve on the phone",
      at: MS,
      says: "/verify your identity|approve sign in request|approve a request|open your authenticator app/i",
      ops: [
        {
          kind: "second-step",
          goal: "answer the second step",
          // an authenticator code when the account has one; else a text, else the phone
          ways: [{ way: "totp", choice: VIA_CODE }, { way: "totp", choice: OTHER_WAY }, SMS, PUSH],
        },
      ],
    },
    {
      name: "password",
      looks: "the password box",
      at: MS,
      shows: [PASSWORD],
      ops: [
        {
          kind: "password",
          goal: "type the password",
          field: PASSWORD,
          submit: { role: "button", name: "/^sign in$/i" },
        },
      ],
    },
    {
      name: "email",
      looks: "the email, phone or Skype box",
      at: MS,
      shows: [EMAIL],
      hides: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: EMAIL },
        {
          kind: "click",
          goal: "continue past the email",
          hints: { role: "button", name: "/^next$/i" },
          irreversible: false,
        },
      ],
    },
  ],
} satisfies WalkSpecInput;
