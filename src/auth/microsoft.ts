/**
 * Microsoft as an identity provider: the sign-in behind "Sign in with
 * Microsoft" is the repo's Microsoft walk (src/walks/logins/microsoft.ts),
 * run in place until the page leaves Microsoft's host.
 */
import { registerProvider, walkInPlace } from "./providers.js";

export const signInToMicrosoft = walkInPlace(
  "microsoft",
  () => import("../walks/logins/microsoft.js"),
);

registerProvider({
  site: "microsoft",
  host: /login\.(microsoftonline|live|microsoft)\.com/,
  buttons: [
    { role: "button", name: "/microsoft/i" },
    { role: "link", name: "/microsoft/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with microsoft/i" },
  ],
  signIn: signInToMicrosoft,
});
