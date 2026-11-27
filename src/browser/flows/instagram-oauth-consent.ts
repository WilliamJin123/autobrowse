/**
 * Instagram's OAuth dialog (Instagram Login): after the account's sign-in,
 * "<app> wants to access your Instagram account" with Allow. From the docs
 * 2026-09-21; unproven until an app and a professional account exist.
 */
import instagramLogin from "../../walks/logins/instagram.js";
import { regexOf } from "../../walks/spec.js";
import { consentFlow } from "./consent-walker.js";

export const instagramOauthConsent = consentFlow({
  site: "instagram",
  home: "https://www.instagram.com/",
  // the sign-in walk's own pages
  loginUrl: regexOf(instagramLogin.signInHere),
  allow: { role: "button", name: "/^(allow|continue)$/i" },
  refused: /invalid|not authorized|something went wrong|error|app is not set up/i,
});
