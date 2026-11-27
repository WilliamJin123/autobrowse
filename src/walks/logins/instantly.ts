/** Instantly (app.instantly.ai, for warmup): email and password, then an emailed code on a new browser. */

import type { WalkSpecInput } from "../spec.js";

const EMAIL = { role: "textbox", name: "Email" };
const PASSWORD = { role: "textbox", name: "Password" };
const LOG_IN = { role: "button", name: "/^(log|sign) ?in$/i" };
const CODE = { role: "textbox", name: "/code/i" };
const VERIFY = { role: "button", name: "/verify/i" };

export default {
  site: "instantly",
  name: "login",
  goal: "signed in to Instantly",
  start: "https://app.instantly.ai/auth/login",
  home: "https://app.instantly.ai/",
  screens: [
    {
      name: "signed-in",
      looks: "the Instantly app past the login",
      at: "/app\\.instantly\\.ai\\/app/",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the form says the email or password is wrong",
      says: "/invalid email or password/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "emailed-code",
      looks: "Instantly asks for the code it emailed",
      says: "/verification code|check your email/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the emailed code",
          kinds: ["email"],
          field: CODE,
          submit: VERIFY,
          hint: "instantly",
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
