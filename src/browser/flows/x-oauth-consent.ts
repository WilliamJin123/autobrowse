/**
 * X's OAuth 2.0 authorize page: after the account's sign-in, the app's
 * permissions with "Authorize app". Since 2026-09 an app asking to post
 * shows "Sensitive permissions requested" and keeps Authorize disabled until
 * the "I trust this app" box is ticked (mapped 2026-09-27 as wren_automation).
 */
import xLogin from "../../walks/logins/x.js";
import { regexOf } from "../../walks/spec.js";
import { consentFlow } from "./consent-walker.js";

export const xOauthConsent = consentFlow({
  site: "x",
  home: "https://x.com/home",
  // the sign-in walk's own pages
  loginUrl: regexOf(xLogin.signInHere),
  allow: { role: "button", name: "/^(authorize app|authorize|allow)$/i" },
  confirm: {
    unticked: { css: '[role=checkbox][aria-checked="false"]' },
    tick: { css: '[role=checkbox][aria-checked="false"]' },
  },
  refused: /something went wrong|invalid|unauthorized|not authorized|error|could not authenticate/i,
});
