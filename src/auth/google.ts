/**
 * Google as an identity provider: the sign-in behind "Sign in with Google" is
 * the repo's Google walk (src/walks/logins/google.ts), run in place until the
 * page leaves accounts.google.com (a popup that closed itself counts).
 */
import { registerProvider, walkInPlace } from "./providers.js";

export const signInToGoogle = walkInPlace("google", () => import("../walks/logins/google.js"));

registerProvider({
  site: "google",
  host: /accounts\.google\.com/,
  buttons: [
    { role: "button", name: "/google/i" },
    { role: "link", name: "/google/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with google/i" },
    // Google Identity Services renders the button itself, cross-origin, so the
    // page's own locators never see it (LinkedIn, mapped 2026-09-22).
    { frame: 'iframe[src*="accounts.google.com/gsi/button"]', css: "div[role=button]" },
  ],
  signIn: signInToGoogle,
});
