/**
 * X's own login, one field at a time: username, on an unfamiliar login the
 * handle again, then the password, then a code (the authenticator, a text,
 * else an email). The OAuth authorize page shows it first: `signInHere`.
 * Two pages, same steps: /i/jf/onboarding/web since 2026-09 ("Email or
 * username", "Continue"; proven as wren_automation 2026-09-27) and the
 * older /i/flow/login ("Phone, email, or username", "Next", "Log in").
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = {
  role: "textbox",
  name: "/phone, email,? (address,)? ?or username|^email or username$/i",
};
/** The unusual-activity check asks for the handle again. */
const AGAIN = { role: "textbox", name: "/phone number or username/i" };
/** The new page names it "Password Show password" (the eye button sits in the label). */
const PASSWORD = { role: "textbox", name: "/^password( show password)?$/i" };
const NEXT = { role: "button", name: "/^(next|continue)$/i" };
const LOG_IN = { role: "button", name: "/^(log in|continue)$/i" };
const CODE = { role: "textbox", name: "/verification code|^code$/i" };

const codeScreen = (name: string, looks: string, says: string, kind: "totp" | "sms" | "email") => ({
  name,
  looks,
  says,
  shows: [CODE],
  once: false,
  ops: [
    { kind: "one-time-code" as const, goal: `type the ${kind} code`, kinds: [kind], field: CODE, submit: NEXT },
  ],
});

export default {
  site: "x",
  name: "login",
  goal: "signed in to X",
  start: "https://x.com/i/flow/login",
  home: "https://x.com/home",
  origins: ["x.com", "twitter.com"],
  signInHere: "/(x|twitter)\\.com\\/(i\\/flow\\/login|i\\/jf\\/onboarding|login|account\\/access)/",
  screens: [
    {
      name: "signed-in",
      looks: "any X page past the login flow, the OAuth authorize page among them",
      at: "/^https:\\/\\/(x|twitter)\\.com\\/(?!i\\/flow\\/login|i\\/jf\\/onboarding|login|account\\/access)/",
      hides: [PASSWORD, USERNAME],
      goal: true,
    },
    {
      name: "rejected",
      looks: "X says the password is wrong or the account is unknown",
      says: "/wrong password|password is incorrect|could not find your account|we couldn.t find/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "code-rejected",
      looks: "X says the code is wrong",
      says: "/code (is|was) (incorrect|invalid)|incorrect code/i",
      refused: { says: "code rejected", case: "code" },
    },
    {
      name: "person-check",
      looks: "the Arkose puzzle or a lock, with no code box",
      says: "/puzzle|arkose|suspicious|locked|verify your identity/i",
      hides: [CODE],
      person: { why: "X wants a check only a person can pass" },
    },
    {
      name: "password-form",
      looks: "the password box",
      shows: [PASSWORD],
      ops: [{ kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN }],
    },
    {
      name: "handle-again",
      looks: "\"Enter your phone number or username\" on an unusual login",
      shows: [AGAIN],
      ops: [
        { kind: "username", goal: "type the username again", field: AGAIN },
        { kind: "click", goal: "next", hints: NEXT, irreversible: false },
      ],
    },
    {
      name: "username-form",
      looks: "the username box alone",
      shows: [USERNAME],
      hides: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "click", goal: "next", hints: NEXT, irreversible: false },
      ],
    },
    codeScreen("app-code", "X asks for the authenticator code", "/authentication app|authenticator/i", "totp"),
    codeScreen("texted-code", "X asks for the code it texted", "/\\btext(ed)?\\b|sms|phone/i", "sms"),
    codeScreen("emailed-code", "X asks for the code it emailed", "/verification code|confirmation code/i", "email"),
  ],
} satisfies WalkSpecInput;
