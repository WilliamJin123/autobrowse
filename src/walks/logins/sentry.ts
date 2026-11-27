/**
 * Sentry: the org was made 2026-09-21 with "Register with Google" (no
 * password); the login page's "Sign in with Google" link signs it in.
 * Signed-in pages live on the org's subdomain, the login page on the bare host.
 */

import type { WalkSpecInput } from "../spec.js";

const GOOGLE = { role: "link", name: "Sign in with Google" };

export default {
  site: "sentry",
  name: "login",
  goal: "signed in to Sentry",
  start: "https://sentry.io/auth/login/",
  home: "https://wren-automation.sentry.io/issues/",
  ask: "Your Sentry account (sentry.io), where the DSN lives",
  screens: [
    {
      name: "signed-in",
      looks: "a page on the org's subdomain",
      at: "/^https:\\/\\/[a-z0-9-]+\\.sentry\\.io\\//",
      goal: true,
    },
    {
      name: "google",
      looks: 'the login page\'s "Sign in with Google"',
      shows: [GOOGLE],
      ops: [{ kind: "provider", goal: "sign in with Google", provider: "google", button: GOOGLE }],
    },
  ],
} satisfies WalkSpecInput;
