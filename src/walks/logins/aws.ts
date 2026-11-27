/**
 * AWS console: the root user (username = the account email) or an IAM user
 * (username = `<account id or alias>/<iam user>`), then the authenticator code.
 * `aws login` ends on a confirmation page: Allow shows the code the CLI waits for.
 * The form renders 10–40 s after load (slow-walked), so a bare sign-in page waits.
 * The bare /signin URL answers 400 since the 2026 update: start at the console.
 */

import type { WalkSpecInput } from "../spec.js";

const ROOT = "/@/";
const IAM = "/^[^@]+\\/[^/]+$/";
const PASSWORD = { role: "textbox", name: "/^password$/i" };
const ROOT_EMAIL = { role: "textbox", name: "/root user email/i" };
const ROOT_CHOICE = { role: "button", name: "/root user email/i" };
const ACCOUNT = { role: "textbox", name: "/account id or alias/i" };
const IAM_USER = { role: "textbox", name: "/iam username/i" };
const SIGN_IN = { role: "button", name: "/^sign in$/i" };
const NEXT = { role: "button", name: "/^next$/i" };
const MFA = { role: "textbox", name: "/mfa code|authentication code/i" };
const MFA_SUBMIT = { role: "button", name: "/^(submit|sign in)$/i" };
const ALLOW = { role: "button", name: "/^allow/i" };
const SIGN_IN_PAGE = "/signin\\.aws\\.amazon\\.com|\\.signin\\.aws\\//";

export default {
  site: "aws",
  name: "login",
  goal: "signed in to the AWS console",
  start: "https://console.aws.amazon.com/",
  home: "https://console.aws.amazon.com/",
  ask: "Your AWS console sign-in (root email, or <account>/<iam user>), for `aws login`",
  screens: [
    {
      name: "console",
      looks: "the console, off the sign-in host",
      at: "/^https:\\/\\/([a-z0-9-]+\\.)?console\\.aws\\.amazon\\.com\\//",
      hides: [PASSWORD],
      goal: true,
    },
    {
      name: "cli-allowed",
      looks: "`aws login`'s confirmation page after Allow",
      at: "/signin\\.aws\\.amazon\\.com\\/v1\\/sessions\\/confirmation/",
      hides: [ALLOW],
      goal: true,
    },
    {
      name: "code-rejected",
      looks: "the MFA page says the code is wrong",
      shows: [MFA],
      says: "/(code|mfa)[^.]{0,40}(incorrect|invalid|not valid)|authentication failed/i",
      refused: { says: "MFA code rejected", case: "code" },
    },
    {
      name: "rejected",
      looks: "the form says the sign-in failed",
      at: SIGN_IN_PAGE,
      says: "/your authentication information is incorrect|authentication failed|incorrect (email|password)/i",
      refused: { says: "password rejected", case: "password" },
    },
    {
      name: "bad-username",
      looks: "any sign-in page, with a username that is neither an email nor <account>/<user>",
      at: SIGN_IN_PAGE,
      forUsername: "/^[^@/]*$|^[^@]*\\/$|^\\//",
      refused: {
        says: "username must be <account id or alias>/<iam user>, or the root email",
        case: "account",
      },
    },
    {
      name: "allow-cli",
      looks: "`aws login` asks to allow the CLI session",
      shows: [ALLOW],
      ops: [{ kind: "click", goal: "allow the CLI session", hints: ALLOW, irreversible: false }],
    },
    {
      name: "mfa",
      looks: "the authenticator code box",
      shows: [MFA],
      ops: [
        {
          kind: "one-time-code",
          goal: "type the MFA code",
          kinds: ["totp"],
          field: MFA,
          submit: MFA_SUBMIT,
        },
      ],
    },
    {
      name: "iam-form",
      looks: "account, IAM username and password",
      forUsername: IAM,
      shows: [ACCOUNT, PASSWORD],
      ops: [
        { kind: "username", goal: "type the account", field: ACCOUNT, part: "/^([^/]+)\\//" },
        { kind: "username", goal: "type the IAM username", field: IAM_USER, part: "/\\/(.+)$/" },
        { kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN },
      ],
    },
    {
      name: "root-password",
      looks: "the root user's password, after the email",
      forUsername: ROOT,
      shows: [PASSWORD],
      hides: [ACCOUNT],
      ops: [{ kind: "password", goal: "type the password", field: PASSWORD, submit: SIGN_IN }],
    },
    {
      name: "root-email",
      looks: "the root user email box",
      forUsername: ROOT,
      shows: [ROOT_EMAIL],
      ops: [
        { kind: "username", goal: "type the root email", field: ROOT_EMAIL },
        { kind: "click", goal: "past the email", hints: NEXT, irreversible: false },
      ],
    },
    {
      name: "root-choice",
      looks: 'the IAM form with a "root user email" button',
      forUsername: ROOT,
      shows: [ROOT_CHOICE],
      ops: [{ kind: "click", goal: "root user sign-in", hints: ROOT_CHOICE, irreversible: false }],
    },
    {
      name: "loading",
      looks: "the sign-in page before its form renders",
      at: SIGN_IN_PAGE,
      hides: [PASSWORD, ROOT_EMAIL, ROOT_CHOICE, MFA, ALLOW],
      ops: [
        { kind: "see", goal: "wait for the sign-in form", hints: { role: "textbox" }, ms: 45_000 },
      ],
    },
  ],
} satisfies WalkSpecInput;
