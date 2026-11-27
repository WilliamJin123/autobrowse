/**
 * HubSpot's developer account was made with Google: the login page asks the
 * email first, then shows "Sign in with Google" (mapped 2026-10-09).
 */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "Email" };
const GOOGLE = { role: "button", name: "/sign in with google/i" };

export default {
  site: "hubspot",
  name: "login",
  goal: "signed in to HubSpot",
  start: "https://app.hubspot.com/login",
  home: "https://app.hubspot.com/",
  ask: "Your HubSpot account (app.hubspot.com)",
  screens: [
    {
      name: "signed-in",
      looks: "an app page off the login and sign-up",
      at: "/app(-[a-z0-9]+)?\\.hubspot\\.com\\/(?!login|signup)/",
      goal: true,
    },
    {
      name: "email-first",
      looks: "the login page's email box, before the methods",
      shows: [EMAIL],
      hides: [GOOGLE],
      ops: [
        { kind: "username", goal: "the email first", field: EMAIL },
        {
          kind: "click",
          goal: "past the email",
          hints: { role: "button", name: "Continue" },
          irreversible: false,
        },
      ],
    },
    {
      name: "google",
      looks: 'the methods after the email: "Sign in with Google"',
      shows: [GOOGLE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
  ],
} satisfies WalkSpecInput;
