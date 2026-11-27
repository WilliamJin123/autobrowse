/**
 * Reddit: the account's own login, a "Log In" dialog at /login/ (mapped
 * 2026-09-29): "Email or username", "Password", "Log In" (disabled until both
 * are filled). A new device may be asked for an emailed code: unproven. The
 * front page is public, so `home` is settings: signed out, it is a wall.
 * Headless, Reddit's bot check refuses the right password as "Invalid
 * username or password": sign in headed once (2026-09-29); the session then
 * serves headless legs.
 */

import type { WalkSpecInput } from "../spec.js";

const USERNAME = { role: "textbox", name: "Email or username" };
const PASSWORD = { role: "textbox", name: "Password" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const LOG_IN_LINK = { role: "link", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/code/i" };

export default {
  site: "reddit",
  name: "login",
  goal: "signed in to Reddit",
  start: "https://www.reddit.com/login/",
  home: "https://www.reddit.com/settings/",
  screens: [
    {
      name: "signed-in",
      looks: "a Reddit page past the login, no Log In link",
      at: "/reddit\\.com\\/(?!login|account\\/login)/",
      hides: [PASSWORD, LOG_IN_LINK],
      goal: true,
    },
    {
      name: "rejected",
      looks: "the dialog says the username or password is wrong",
      says: "/incorrect username or password|invalid username or password/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "emailed-code",
      looks: "Reddit asks for the code it emailed",
      says: "/verification code|check your (email|inbox)|enter the code/i",
      shows: [CODE],
      once: false,
      ops: [
        {
          kind: "one-time-code",
          goal: "type the emailed code",
          kinds: ["email"],
          field: CODE,
          submit: { role: "button", name: "/continue|verify|log in/i" },
          hint: "reddit",
        },
      ],
    },
    {
      name: "login-form",
      looks: "the username and password boxes",
      shows: [PASSWORD],
      ops: [
        { kind: "username", goal: "type the username", field: USERNAME },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: LOG_IN },
      ],
    },
  ],
} satisfies WalkSpecInput;
