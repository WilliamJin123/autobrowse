/**
 * Apple (App Store Connect, the developer account): one Apple ID widget in an
 * iframe; the address, Continue, then the password shows late on the same
 * form, the address still up (typed again, the widget drops the password).
 * 2FA is a code on William's own devices: a person's step. Verified live
 * 2026-10-28 (William).
 */

import type { WalkSpecInput } from "../spec.js";

const WIDGET = "iframe#aid-auth-widget-iFrame";
const USERNAME = {
  frame: WIDGET,
  role: "textbox",
  name: "/email|phone|apple id|apple account/i",
};
const PASSWORD = { frame: WIDGET, role: "textbox", name: "Password" };
const CONTINUE = { frame: WIDGET, role: "button", name: "Continue" };
const SIGN_IN = { frame: WIDGET, role: "button", name: "Sign In" };
const TRUST = { role: "button", name: "Trust" };

export default {
  site: "apple",
  name: "login",
  goal: "signed in to App Store Connect",
  start: "https://appstoreconnect.apple.com/login",
  home: "https://appstoreconnect.apple.com/apps",
  screens: [
    {
      name: "signed-in",
      looks: "App Store Connect or the developer site, no Apple ID widget",
      at: "/^https:\\/\\/(appstoreconnect|developer)\\.apple\\.com\\/(?!login)/",
      hides: [USERNAME],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the widget says the Apple ID or password is wrong",
      says: "/check the account information you entered/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "trust-browser",
      looks: '"Trust this browser?" after the code',
      shows: [TRUST],
      ops: [{ kind: "click", goal: "trust this browser", hints: TRUST, irreversible: false }],
    },
    {
      name: "device-code",
      looks: "Apple sent a code to William's devices",
      says: "/verification code|two-factor authentication/i",
      person: { why: "Apple sent a code to William's devices; type it in the window" },
    },
    {
      name: "password-form",
      looks: "the password box, under the address typed before",
      shows: [PASSWORD],
      ops: [{ kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN }],
    },
    {
      name: "username-form",
      looks: "the Apple ID box alone",
      shows: [USERNAME],
      hides: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the Apple ID", field: USERNAME },
        { kind: "click", goal: "continue", hints: CONTINUE, irreversible: false },
      ],
    },
  ],
} satisfies WalkSpecInput;
