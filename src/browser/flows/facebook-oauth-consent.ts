/**
 * Facebook Login's dialog: after the account's sign-in, "Continue as
 * <name>", then the permissions pages (Pages, Instagram accounts, ad
 * accounts to share) each with a Continue/Save/Done. From the docs
 * 2026-09-22; unproven until a Meta app and an account exist.
 */
import facebookLogin from "../../walks/logins/facebook.js";
import { regexOf } from "../../walks/spec.js";
import { consentFlow } from "./consent-walker.js";

export const facebookOauthConsent = consentFlow({
  site: "facebook",
  home: "https://www.facebook.com/",
  // the sign-in walk's own pages
  loginUrl: regexOf(facebookLogin.signInHere),
  allow: { role: "button", name: "/^(continue( as .+)?|save|done|allow|got it|next|ok)$/i" },
  refused: /invalid|not authorized|can.t load url|app not set ?up|error|redirect uri/i,
  rounds: 10,
});
