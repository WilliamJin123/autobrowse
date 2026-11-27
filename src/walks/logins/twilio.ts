/**
 * Twilio Console: made with "Sign up with Google" (no password exists); the
 * same button on the sign-up page signs the Google-linked account in. After
 * the round trip Twilio texts a code; "remember this browser" keeps the
 * profile clear of it for a while. Mapped 2026-09-21.
 */

import type { WalkSpecInput } from "../spec.js";

const GOOGLE = { role: "button", name: "/google/i" };
const CODE = { id: "code" };
const REMEMBER = { id: "rememberBrowser" };

export default {
  site: "twilio",
  name: "login",
  goal: "signed in to the Twilio Console",
  start: "https://www.twilio.com/try-twilio",
  home: "https://console.twilio.com/",
  ask: "Your Twilio account (console.twilio.com), for the rented number",
  screens: [
    {
      name: "signed-in",
      looks: "a Console account page",
      at: "/console\\.twilio\\.com\\/account\\//",
      goal: true,
    },
    {
      name: "texted-code",
      looks: "the SMS challenge after the Google round trip",
      at: "/login\\.twilio\\.com\\/u\\/mfa-sms-challenge/",
      shows: [CODE],
      ops: [
        { kind: "click", goal: "remember this browser", hints: REMEMBER, irreversible: false },
        {
          kind: "one-time-code",
          goal: "type the texted code",
          kinds: ["sms"],
          field: CODE,
          submit: { role: "button", name: "/^continue$/i" },
          // a code sent for an earlier try is older than this one: a fresh text
          send: { role: "button", name: "/^resend$/i" },
        },
      ],
    },
    {
      name: "google",
      looks: 'the sign-up page\'s "Sign up with Google"',
      shows: [GOOGLE],
      hides: [CODE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
  ],
} satisfies WalkSpecInput;
