/**
 * Google's own sign-in (accounts.google.com): the `google` account, the Google
 * apps and google-admin (`WALK_APPS`), and the provider behind every "Sign in
 * with Google" button (`src/auth/google.ts`, in place until the page leaves).
 * The pages come in any order: a chooser, One Tap, a passkey, the list of
 * second steps, a consent, a Workspace account's terms.
 *
 * Second step, by what this system can answer (mapped 2026-09-19): our
 * passkey, then the authenticator code, then a text to our phone (matched by
 * its last two digits), then a person's Yes on their phone.
 */

import type { WalkSpecInput } from "../spec.js";

const ACCOUNTS = "/^https:\\/\\/accounts\\.google\\.com\\//";
const SELECTION = "/challenge\\/selection/";
const PASSKEY = "/accounts\\.google\\.com\\/.*challenge\\/pk/";
const CHALLENGE = "/accounts\\.google\\.com\\/.*\\/challenge\\//";
const OAUTH = "/^https:\\/\\/accounts\\.google\\.com\\/signin\\/oauth/";

const EMAIL = { role: "textbox", name: "/email or phone/i" };
const PASSWORD = { role: "textbox", name: "/password/i" };
const NEXT = { role: "button", name: "/^next$/i" };
const CODE = { role: "textbox", name: "/code/i" };
const PHONE = { role: "textbox", name: "/^phone number$/i" };
const CONTINUE = { role: "button", name: "/^continue$/i" };
/** "Try another way" on a sign-in, "More ways to verify" on a re-auth. */
const OTHER_WAY = { text: "/try another way|more ways to verify/i" };
const MINE = { text: "/{username}/i" };

/** A step on the list: a link on some accounts, a button on others; a greyed one does not count. */
const choice = (text: string) => ({
  css: `:is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("${text}")`,
});
/** Google masks each phone to its last two digits and greys one it got minutes ago. */
const SMS_TAIL = {
  css: `${choice("verification code at").css}:has-text("••{phoneTail}")`,
};
const SMS = {
  field: CODE,
  submit: NEXT,
  hint: "google",
  // a Workspace user with no phone of its own is asked for one first: ours
  phone: { field: PHONE, submit: NEXT },
} as const;
const PERSON = "Google asks a second step only a person can answer: a phone tap or a check";

export default {
  site: "google",
  name: "login",
  goal: "signed in to Google",
  start: "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/",
  home: "https://myaccount.google.com/",
  // Google re-asks for the password on security pages; a re-verify inside a consent ends on the scope grant
  signInHere: { at: ACCOUNTS, past: OAUTH },
  ask: 'Your Google account: the one behind every "Sign in with Google" button',
  origins: ["google.com"],
  // products off google.com: their pages take google's tools and sign-in (WA-1036)
  properties: ["youtube.com", "blogger.com", "withgoogle.com", "google.dev"],
  // chooser, email, password, passkey, list, code, passkey again, list, code, two consents
  maxSteps: 16,
  screens: [
    {
      name: "account",
      looks: "a Google Account page, not its signed-out /intro/ twin",
      at: "/^https:\\/\\/myaccount\\.google\\.com\\/(?!intro(\\/|\\?|$))/",
      goal: true,
    },
    {
      // the consent's own flow grants it; a sign-in grants nothing
      name: "scope-grant",
      looks: "'<app> wants access to your Google Account', with Allow",
      at: OAUTH,
      shows: [{ role: "button", name: "/^allow$/i" }],
      goal: true,
    },
    {
      name: "left",
      looks: "the site that asked, off accounts.google.com",
      at: "/^https?:\\/\\/(?!accounts\\.google\\.com\\/)/",
      goal: true,
    },
    {
      // wrong codes lock the account's texts for hours: never guess on
      name: "locked",
      looks: "'Too many failed attempts'",
      shows: [{ text: "/too many failed attempts/i" }],
      refused: {
        says: "Google: too many failed attempts on this account; try again in a few hours",
        case: "account",
      },
    },
    {
      name: "refused-browser",
      looks: "'This browser or app may not be secure'",
      at: ACCOUNTS,
      says: "/browser or app may not be secure/i",
      refused: { says: "Google refused this browser", case: "account" },
    },
    {
      name: "unknown-account",
      looks: "'Couldn't find your Google Account' under the email box",
      at: ACCOUNTS,
      says: "/couldn.t find your google account/i",
      refused: { says: "unknown account", case: "account" },
    },
    {
      name: "rejected",
      looks: "the password box with 'Wrong password. Try again'",
      at: ACCOUNTS,
      shows: [PASSWORD],
      says: "/wrong password/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "wrong-code",
      looks: "Google saying the code is wrong",
      at: ACCOUNTS,
      says: "/wrong code/i",
      refused: { says: "Google said the code was wrong", case: "code" },
    },
    // One Tap (gsi/select) confirms an account the profile is signed in as: no password.
    // Its channel to the opener dies if the opener navigates (mapped 2026-09-22 on LinkedIn).
    {
      name: "one-tap-confirm",
      looks: "Google One Tap asking to confirm the signed-in account",
      at: "/\\/gsi\\/select/",
      shows: [{ css: "#confirm_yes" }],
      ops: [
        {
          kind: "click",
          goal: "confirm the sign-in",
          hints: { css: "#confirm_yes" },
          irreversible: false,
        },
      ],
    },
    {
      name: "one-tap-account",
      looks: "Google One Tap listing the account to pick",
      at: "/\\/gsi\\/select/",
      shows: [MINE],
      ops: [{ kind: "pick-account", goal: "pick the account", tile: MINE }],
    },
    {
      name: "someone-else",
      looks: "a page for another account, with '<other> selected. Switch account'",
      at: ACCOUNTS,
      shows: [{ role: "link", name: "/switch account/i" }],
      hides: [MINE],
      ops: [
        {
          kind: "click",
          goal: "switch account",
          hints: { role: "link", name: "/switch account/i" },
          irreversible: false,
        },
      ],
    },
    {
      name: "chooser",
      looks: "'Choose an account': the profile's accounts and 'Use another account'",
      at: ACCOUNTS,
      says: "/choose an account/i",
      ops: [
        {
          kind: "pick-account",
          goal: "pick the account",
          tile: MINE,
          other: { text: "/use another account/i" },
        },
      ],
    },
    {
      // a Workspace user's first sign-in (speedbump/gaplustos)
      name: "new-account-terms",
      looks: "'Welcome to your new account' and the terms, with 'I understand'",
      at: ACCOUNTS,
      shows: [{ role: "button", name: "/i understand/i" }],
      ops: [
        {
          kind: "click",
          goal: "accept the new account's terms",
          hints: { role: "button", name: "/i understand/i" },
          irreversible: false,
        },
      ],
    },
    {
      // "Google will allow x.com to access this info about you": Continue. A site that asks for
      // more (Cal.com: the calendar) shows a second one. It renders late, so the button decides.
      name: "consent",
      once: false,
      looks: "the OAuth consent: what the site gets, and 'Continue'",
      at: OAUTH,
      shows: [CONTINUE],
      ops: [
        { kind: "click", goal: "consent to the sign-in", hints: CONTINUE, irreversible: false },
      ],
    },
    {
      // before the password and after it; the kit stops a third list
      name: "selection",
      once: false,
      looks: "'Choose how you want to sign in' / 'Choose a way to verify': the second steps",
      at: SELECTION,
      ops: [
        {
          kind: "second-step",
          goal: "choose the second step",
          ways: [
            // an account with a passkey is asked for it first; the list offers the password
            { way: "password", choice: choice("Enter your password") },
            { way: "passkey", choice: choice("Use your passkey") },
            { way: "totp", choice: choice("authenticator app") },
            { way: "sms", choice: SMS_TAIL, ...SMS },
            // a Workspace user on a new browser: one phone step and no digits (mapped 2026-09-25)
            { way: "sms", choice: choice("verification code sent to your phone"), ...SMS },
            {
              way: "push",
              choice: choice("Tap Yes on your phone"),
              ask: "tap Yes on your phone",
              // where the prompt went: "Open the YouTube app on Apple iPhone 12"
              note: "/(open the .{1,60}? app on [^\\n.]{1,60})/i",
              until: "/^(?!https:\\/\\/accounts\\.google\\.com\\/.*\\/challenge\\/)/",
            },
          ],
        },
      ],
    },
    {
      // before the password, after it (admin.google.com), or twice (Langfuse, 2026-09-22)
      name: "passkey",
      once: false,
      looks: "Google asking for the account's passkey",
      at: PASSKEY,
      ops: [
        {
          kind: "passkey",
          goal: "verify with our passkey",
          // a "presend" page first: "Your device will ask for your fingerprint… Continue"
          start: CONTINUE,
          leaves: "/challenge\\/pk/",
          other: OTHER_WAY,
        },
      ],
    },
    {
      name: "passkey-confirm",
      once: false,
      looks: "'Use your passkey to confirm it's really you' off the passkey URL",
      at: ACCOUNTS,
      says: "/using your passkey|use your passkey to confirm/i",
      ops: [
        {
          kind: "passkey",
          goal: "verify with our passkey",
          start: CONTINUE,
          leaves: "/challenge\\/pk/",
          other: OTHER_WAY,
        },
      ],
    },
    {
      name: "authenticator-code",
      looks: "the box for the authenticator app's code",
      at: "/challenge\\/totp/",
      shows: [CODE],
      needs: "totp",
      ops: [
        {
          kind: "one-time-code",
          goal: "type the authenticator code",
          kinds: ["totp"],
          field: CODE,
          submit: NEXT,
        },
      ],
    },
    {
      name: "phone",
      looks: "'Enter a phone number to get a text message with a verification code'",
      at: ACCOUNTS,
      shows: [PHONE],
      needs: "sms",
      ops: [{ kind: "one-time-code", goal: "type the texted code", kinds: ["sms"], ...SMS }],
    },
    {
      name: "password",
      looks: "'Hi <name>' and the password box",
      at: ACCOUNTS,
      shows: [PASSWORD],
      ops: [{ kind: "password", goal: "type the Google password", field: PASSWORD, submit: NEXT }],
    },
    {
      name: "email",
      looks: "'Sign in' with the 'Email or phone' box",
      at: ACCOUNTS,
      shows: [EMAIL],
      hides: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the Google email", field: EMAIL },
        { kind: "click", goal: "continue past the email", hints: NEXT, irreversible: false },
      ],
    },
    {
      // a step this system did not choose (a code box it cannot answer, a phone box): the list
      name: "other-way",
      once: false,
      looks: "a second step this system cannot answer, with 'Try another way'",
      at: ACCOUNTS,
      shows: [OTHER_WAY],
      ops: [
        {
          kind: "click",
          goal: "see the other second steps",
          hints: OTHER_WAY,
          irreversible: false,
        },
      ],
    },
    // a person's step (a phone tap, "Verify it's you"), not a refusal: no hold (WA-1028)
    {
      name: "person-challenge",
      looks: "a challenge page with no other way: a recovery question, a phone tap",
      at: CHALLENGE,
      person: { why: PERSON },
    },
    {
      name: "person-check",
      looks: "'Verify it's you', 'Confirm your recovery email', 'Tap Yes on your phone'",
      at: ACCOUNTS,
      says: "/2-step verification|verification code|enter the code|verify it.s you|confirm your recovery|tap yes on your/i",
      person: { why: PERSON },
    },
  ],
} satisfies WalkSpecInput;
