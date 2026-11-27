/**
 * Claude Console (platform.claude.com): made with "Continue with Google", so
 * the stored `google` credential signs in through that button (a popup).
 * The login form renders under the requested URL (/settings/billing stays), so
 * the URL alone never says signed in. Mapped 2026-09-21.
 */

import type { WalkSpecInput } from "../spec.js";

const GOOGLE = { role: "button", name: "/continue with google/i" };

export default {
  site: "anthropic",
  name: "login",
  goal: "signed in to the Claude Console",
  start: "https://platform.claude.com/login",
  home: "https://platform.claude.com/dashboard",
  ask: "Your Claude Console account (platform.claude.com), where API keys are minted",
  screens: [
    {
      name: "signed-in",
      looks: "a Console page with no Google button",
      at: "/platform\\.claude\\.com\\/(?!login)/",
      hides: [GOOGLE],
      goal: true,
    },
    {
      name: "google",
      looks: 'the login form\'s "Continue with Google"',
      shows: [GOOGLE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
  ],
} satisfies WalkSpecInput;
