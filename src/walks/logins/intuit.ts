/**
 * Intuit (the developer portal behind QuickBooks apps): email and password on
 * one page, an emailed code when Intuit is unsure of the browser (2026-10-09).
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "Email or user ID" };
const PASSWORD = { role: "textbox", name: "Password" };
const SIGN_IN = { role: "button", name: "Sign in" };
const CODE = { role: "textbox", name: "/code/i" };
const CONTINUE = { role: "button", name: "/continue|verify|confirm/i" };

export default {
  site: "intuit",
  name: "login",
  goal: "signed in to the Intuit developer portal",
  start:
    "https://accounts.intuit.com/app/sign-in?app_group=ExternalDeveloperPortal&asset_alias=Intuit.devx.devx",
  home: "https://developer.intuit.com/app/developer/dashboard",
  screens: [
    {
      name: "signed-in",
      looks: "the developer portal past the sign-in",
      at: "/developer\\.intuit\\.com\\//",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the password is wrong",
      says: "/incorrect|doesn't match|try again/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "emailed-code",
      looks: "Intuit asks for the code it emailed",
      says: "/verification code|enter the code|we sent|check your email/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the emailed code",
          kinds: ["email"],
          field: CODE,
          submit: CONTINUE,
          hint: "intuit",
        },
      ],
    },
    {
      name: "login-form",
      looks: "the email and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: EMAIL },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN },
      ],
    },
  ],
} satisfies WalkSpecInput;
