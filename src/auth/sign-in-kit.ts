/**
 * Steps every sign-in shares (designs/2026-11-26-branching-sign-ins.md):
 * `formWalk`'s screens and a login walk's ops call these, so what crosses
 * screens (a password went in, the previous one was tried) lives in one
 * place and both paths keep the same rules.
 */
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import type { CodeKind } from "./codes.js";
import {
  LoginFailed,
  personStep,
  previousPasswordOf,
  type SignInContext,
  serially,
} from "./login.js";

/** What one sign-in try carries across its screens. */
export interface SignInState {
  site: string;
  /** A password went in: the goal counts only from here. */
  submitted: boolean;
  /** The previous password went in, once, after a rejection. */
  typedPrevious: boolean;
  /** The username went in on a page of its own. */
  typedUsername: boolean;
  /** When the last code was asked for: the next ask takes only a newer one. */
  codeAsked: Date | null;
  /** The form the password last went into: a refusal types the previous one there. */
  form: PasswordForm | null;
}

export const signInState = (site: string): SignInState => ({
  site,
  submitted: false,
  typedPrevious: false,
  typedUsername: false,
  codeAsked: null,
  form: null,
});

/** The try fails; with `failCase`, the site refused it and that case's hold follows. */
export function failSignIn(
  st: Pick<SignInState, "site">,
  why: string,
  failCase?: "password" | "code" | "account",
): never {
  throw new LoginFailed(st.site, why, failCase ? true : undefined, failCase);
}

/** The tick that keeps a profile signed in, by the words sites use. */
export const KEEP_SIGNED_IN = {
  role: "checkbox",
  name: "/keep me (signed|logged) in|stay (signed|logged) in|remember me|keep me signed/i",
} as const;

/** Ticks the keep-signed-in box when the form has one and it is off; no box, no act. */
async function keepSignedIn(fp: FlowPage, hints: Hints): Promise<void> {
  if (!(await fp.has(hints, 500))) return;
  await fp.act({ kind: "script", js: "(el) => { if (!el.checked) el.click(); }" }, hints, {
    goal: "keep me signed in",
  });
}

export interface PasswordForm {
  field: Hints;
  submit: Hints;
  keepSignedIn?: Hints | undefined;
}

/**
 * Types a password and submits. The form back after the password, saying
 * nothing known, fails: never a retype (the previous password is the one
 * exception, through `retypePrevious`).
 */
export async function typePassword(
  st: SignInState,
  fp: FlowPage,
  form: PasswordForm,
  value: string,
  goal = "type password",
  previous = false,
): Promise<void> {
  if (!previous && st.submitted && !st.typedPrevious)
    failSignIn(st, `the form came back after the password, saying nothing known: ${fp.url()}`);
  await fp.act({ kind: "fill", value }, form.field, { goal });
  await keepSignedIn(fp, form.keepSignedIn ?? KEEP_SIGNED_IN);
  await fp.act({ kind: "click" }, form.submit, { goal: "submit login form" });
  st.submitted = true;
  st.form = form;
}

/** A rejected password: the one before the last rotation, once; else the try fails. */
export async function retypePrevious(
  st: SignInState,
  { fp, cred }: SignInContext,
  form: PasswordForm,
  why = "password rejected",
): Promise<void> {
  // A rotation the site took without saying so: the one before still works once.
  const previous = previousPasswordOf(cred);
  if (!previous || st.typedPrevious) failSignIn(st, why, "password");
  st.typedPrevious = true;
  await typePassword(st, fp, form, previous as string, "type the previous password", true);
}

export interface CodeBox {
  /** Kinds this box takes, in the order tried: the first the credential can get is asked. */
  kinds: readonly CodeKind[];
  field: Hints;
  submit: Hints;
  /** The "send code" button, pressed first when it shows. */
  send?: Hints | undefined;
  /** Words that tell which number or address the site sent to. */
  hint?: string | undefined;
}

/**
 * Asks for a code and types it. A second ask (a wrong code, a resend) takes
 * only a code newer than the last ask. One sign-in at a time asks an inbox.
 */
export async function enterCode(st: SignInState, ctx: SignInContext, box: CodeBox): Promise<void> {
  const kind =
    box.kinds.length === 1 ? box.kinds[0] : (box.kinds.find((k) => ctx.offers(k)) ?? box.kinds[0]);
  if (!kind) failSignIn(st, "a code box with no code kind");
  const { fp } = ctx;
  await serially(ctx, kind as CodeKind, async () => {
    if (box.send && (await fp.has(box.send, 1_000)))
      await fp.act({ kind: "click" }, box.send, { goal: `send the ${kind} code` });
    const asked = new Date();
    const code = await ctx.code(kind as CodeKind, box.hint, st.codeAsked ?? undefined);
    st.codeAsked = asked;
    await fp.act({ kind: "fill", value: code }, box.field, { goal: "type verification code" });
    await fp.act({ kind: "click" }, box.submit, { goal: "submit verification code" });
  });
}

/** A captcha: solved here, else a person's, done when its box is gone. */
export async function solveCaptcha(st: SignInState, ctx: SignInContext, box: Hints): Promise<void> {
  const got = await ctx.fp.captcha();
  if (!got.solved)
    await personStep(
      ctx,
      `${st.site}: the sign-in captcha is a person's (${got.reason})`,
      async () => !(await ctx.fp.has(box)),
    );
}

/** Our authenticator holds the key: the ceremony completes on the click. */
export const signInWithPasskey = (fp: FlowPage, start: Hints): Promise<void> =>
  fp.act({ kind: "click" }, start, { goal: "verify with our passkey" });

/** A step only a person's device or eyes can answer: they act in the window. */
export const askPerson = (st: SignInState, ctx: SignInContext, why: string): Promise<void> =>
  personStep(ctx, `${st.site}: ${why}`);
