/**
 * Perplexity: made with "Continue with Google" as william@ (2026-09-29), no
 * password. Its session dies with the browser, so the runner signs in each
 * time: "Sign In" opens the modal that holds the Google button. Signed in, the
 * Sign In button is gone (unproven live; `perplexitySignedIn` asks the
 * session endpoint for perplexity-ask).
 */

import type { WalkSpecInput } from "../spec.js";

const SIGN_IN = { role: "button", name: "Sign In" };
const GOOGLE = { role: "button", name: "/continue with google/i" };

export default {
  site: "perplexity",
  name: "login",
  goal: "signed in to Perplexity",
  start: "https://www.perplexity.ai/",
  home: "https://www.perplexity.ai/",
  ask: "Your Perplexity account (perplexity.ai), for answers with their sources",
  screens: [
    {
      name: "signed-in",
      looks: "a Perplexity page with no Sign In button and no sign-in modal",
      at: "/perplexity\\.ai/",
      hides: [SIGN_IN, GOOGLE],
      goal: true,
    },
    {
      name: "open-sign-in",
      looks: "the home page signed out: the Sign In button",
      shows: [SIGN_IN],
      hides: [GOOGLE],
      ops: [{ kind: "click", goal: "open the sign-in modal", hints: SIGN_IN, irreversible: false }],
    },
    {
      name: "google",
      looks: 'the sign-in modal\'s "Continue with Google"',
      shows: [GOOGLE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
  ],
} satisfies WalkSpecInput;
