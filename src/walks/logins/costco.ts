/**
 * Costco.com (grocery orders): one form on signin.costco.com, email and
 * password (ids from the 11-09 snapshot) and a "Keep me signed in" tick.
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { css: "#signInName" };
const PASSWORD = { css: "#password" };
const SIGN_IN_LINK = { role: "link", name: "/^sign in/i" };

export default {
  site: "costco",
  name: "login",
  goal: "signed in to Costco.com",
  start: "https://www.costco.com/LogonForm",
  home: "https://www.costco.com/",
  screens: [
    {
      name: "signed-in",
      looks: "costco.com past the sign-in, no Sign In link",
      at: "/^https:\\/\\/www\\.costco\\.com\\/(?!LogonForm)/",
      hides: [PASSWORD, SIGN_IN_LINK],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the email or password is wrong",
      says: "/incorrect|invalid|not recognized|doesn.t match/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "login-form",
      looks: "the email and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the email", field: EMAIL },
        {
          kind: "password",
          goal: "type the password",
          field: PASSWORD,
          submit: { css: "#next" },
          keepSignedIn: { css: "#rememberMe" },
        },
      ],
    },
  ],
} satisfies WalkSpecInput;
