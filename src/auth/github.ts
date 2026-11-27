/**
 * GitHub as an identity provider: the sign-in behind "Continue with GitHub"
 * is the repo's GitHub walk (src/walks/logins/github.ts), run in place.
 */
import { registerProvider, walkInPlace } from "./providers.js";

export const signInToGithub = walkInPlace("github", () => import("../walks/logins/github.js"));

registerProvider({
  site: "github",
  host: /github\.com\/(login|sessions?|session)/,
  buttons: [
    { role: "button", name: "/github/i" },
    { role: "link", name: "/github/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with github/i" },
  ],
  signIn: signInToGithub,
});
