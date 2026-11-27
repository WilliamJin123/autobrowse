/**
 * LEARN (learn.uwaterloo.ca, D2L Brightspace) behind the University of
 * Waterloo's sign-in: the `outlook@uw` credential (the WatIAM account).
 * Mapped 2026-10-23 in explore: LEARN sends a signed-out browser to
 * adfs.uwaterloo.ca (SAML): "User Account" → Next → "Password" → "Sign in",
 * then Duo's Universal Prompt (*.duosecurity.com): "Send a passcode" texts the
 * phone, "Passcode" → "Verify", then "Yes, this is my device".
 */

import type { WalkSpecInput } from "../spec.js";

const ADFS = "/adfs\\.uwaterloo\\.ca\\/adfs\\//";
const DUO = "/\\.duosecurity\\.com\\//";
const USER = { role: "textbox", name: "User Account" };
const PASSWORD = { role: "textbox", name: "Password" };
const SEND = { role: "button", name: "/^send a passcode/i" };
const PASSCODE = { role: "textbox", name: "Passcode" };
const OTHER_OPTIONS = { text: "/^other options$/i" };
const TRUST = { role: "button", name: "/^yes, this is my device$/i" };

export default {
  site: "learn",
  name: "login",
  goal: "signed in to LEARN",
  start: "https://learn.uwaterloo.ca/d2l/home",
  // adfs.uwaterloo.ca shares the home's registrable name; the password is never typed on Duo
  signInHere: ADFS,
  ask: "Your University of Waterloo account (WatIAM), for LEARN",
  // names the credential: `outlook@uw`
  secrets: [{ key: "outlook@uw.password", label: "WatIAM password" }],
  screens: [
    {
      name: "signed-in",
      looks: "a LEARN page past the sign-in",
      at: "/^https:\\/\\/learn\\.uwaterloo\\.ca\\/d2l\\/(?!login)/",
      goal: true,
    },
    {
      name: "rejected",
      looks: "the university's sign-in says the account or password is wrong",
      at: ADFS,
      says: "/incorrect user id or password|incorrect user name or password/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "wrong-passcode",
      looks: "Duo says the passcode is wrong",
      at: DUO,
      says: "/incorrect passcode|invalid passcode/i",
      refused: { says: "Duo refused the texted passcode", case: "code" },
    },
    {
      name: "password",
      looks: "the university's sign-in asks for the password",
      at: ADFS,
      shows: [PASSWORD],
      ops: [
        {
          kind: "password",
          goal: "type the password",
          field: PASSWORD,
          submit: { role: "button", name: "Sign in" },
        },
      ],
    },
    {
      name: "user",
      looks: "the university's sign-in asks for the user account",
      at: ADFS,
      shows: [USER],
      hides: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the account", field: USER },
        {
          kind: "click",
          goal: "past the account",
          hints: { role: "button", name: "Next" },
          irreversible: false,
        },
      ],
    },
    {
      name: "trust-device",
      looks: "Duo asks 'Is this your device?'",
      at: DUO,
      shows: [TRUST],
      ops: [{ kind: "click", goal: "trust this browser", hints: TRUST, irreversible: false }],
    },
    {
      name: "methods",
      looks: "Duo's list of ways to verify, with 'Send a passcode'",
      at: DUO,
      shows: [SEND],
      ops: [
        {
          kind: "one-time-code",
          goal: "type the texted passcode",
          kinds: ["sms"],
          field: PASSCODE,
          submit: { role: "button", name: "Verify" },
          send: SEND,
          hint: "passcode",
        },
      ],
    },
    {
      name: "push",
      looks: "Duo waits on a push to the phone, with 'Other options'",
      at: DUO,
      // the passcode page has "Other options" too: only the push page names the push
      says: "/duo push/i",
      shows: [OTHER_OPTIONS],
      hides: [SEND, PASSCODE, TRUST],
      ops: [
        {
          kind: "click",
          goal: "another way to verify",
          hints: OTHER_OPTIONS,
          irreversible: false,
        },
      ],
    },
  ],
} satisfies WalkSpecInput;
