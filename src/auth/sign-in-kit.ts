/**
 * Steps every sign-in shares (designs/2026-11-26-branching-sign-ins.md):
 * `formWalk`'s screens and a login walk's ops call these, so what crosses
 * screens (a password went in, the previous one was tried) lives in one
 * place and both paths keep the same rules.
 */
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { backFrom, clickOpening } from "../browser/screens.js";
import { regexOf, type SecondWay } from "../walks/spec.js";
import type { CodeKind } from "./codes.js";
import {
  addressOf,
  LoginFailed,
  movedOn,
  personStep,
  previousPasswordOf,
  type SignInContext,
  serially,
} from "./login.js";

/** What one sign-in try carries across its screens. */
export interface SignInState {
  site: string;
  /** A secret went in, or a saved session or a second step answered: the goal counts only from here. */
  submitted: boolean;
  /** A password went in: the form back after it fails. */
  passwordTyped: boolean;
  /** Our passkey was tried once this try. */
  passkeyTried: boolean;
  /** Why a way was turned down (our passkey refused): added to the failure. */
  note: string | null;
  /** Times on a list of second steps: a third is a loop, a person's. */
  listed: number;
  /** The previous password went in, once, after a rejection. */
  typedPrevious: boolean;
  /** The username went in on a page of its own. */
  typedUsername: boolean;
  /** When the last code was asked for: the next ask takes only a newer one. */
  codeAsked: Date | null;
  /** Codes typed this try (`CODES_PER_TRY`). */
  codes: number;
  /** The form the password last went into: a refusal types the previous one there. */
  form: PasswordForm | null;
}

export const signInState = (site: string): SignInState => ({
  site,
  submitted: false,
  passwordTyped: false,
  passkeyTried: false,
  note: null,
  listed: 0,
  typedPrevious: false,
  typedUsername: false,
  codeAsked: null,
  codes: 0,
  form: null,
});

/** A code screen may come back (a wrong code, a resend); one try types at most this many. */
export const CODES_PER_TRY = 3;

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
  if (!previous && st.passwordTyped && !st.typedPrevious)
    failSignIn(st, `the form came back after the password, saying nothing known: ${fp.url()}`);
  await fp.act({ kind: "fill", value, into: "password" }, form.field, { goal });
  await keepSignedIn(fp, form.keepSignedIn ?? KEEP_SIGNED_IN);
  await fp.act({ kind: "click" }, form.submit, { goal: "submit login form" });
  st.submitted = true;
  st.passwordTyped = true;
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
  /** A box that asks which phone to text first: ours (the sms inbox), then its button. */
  phone?: { field: Hints; submit: Hints } | undefined;
}

/** The texts inbox, when it is a phone number. */
const phoneOf = (ctx: SignInContext): string | null => {
  const n = ctx.inbox("sms");
  return n && /^\+?\d[\d\s().-]{6,}$/.test(n) ? n : null;
};

/** How long a page gets to render a control before it counts as absent. */
const RENDER_MS = 8_000;

/** How long a code's submit button gets to show after the fill. */
const SUBMIT_MS = 3_000;

/**
 * Asks for a code and types it. A second ask (a wrong code, a resend) takes
 * only a code newer than the last ask. One sign-in at a time asks an inbox.
 */
export async function enterCode(st: SignInState, ctx: SignInContext, box: CodeBox): Promise<void> {
  const kind =
    box.kinds.length === 1 ? box.kinds[0] : (box.kinds.find((k) => ctx.offers(k)) ?? box.kinds[0]);
  if (!kind) failSignIn(st, "a code box with no code kind");
  const { fp } = ctx;
  if (st.codes >= CODES_PER_TRY)
    failSignIn(st, `the site took none of ${CODES_PER_TRY} codes`, "code");
  st.codes += 1;
  await serially(ctx, kind as CodeKind, async () => {
    const asked = new Date();
    if (box.send && (await fp.has(box.send, 1_000)))
      await fp.act({ kind: "click" }, box.send, { goal: `send the ${kind} code` });
    // a user with no phone of its own is asked for one first (Google Workspace): ours
    const phone = box.phone ? phoneOf(ctx) : null;
    if (box.phone && phone && (await fp.has(box.phone.field, box.send ? RENDER_MS : 1_000))) {
      await fp.act({ kind: "fill", value: phone }, box.phone.field, { goal: "give our phone" });
      await fp.act({ kind: "click" }, box.phone.submit, { goal: "send the text" });
    }
    const code = await ctx.code(kind as CodeKind, box.hint, st.codeAsked ?? undefined);
    st.codeAsked = asked;
    await fp.act({ kind: "fill", value: code, into: "code" }, box.field, {
      goal: "type verification code",
    });
    // six digits submit themselves on some pages (GitHub): the button is gone by then
    if (await fp.has(box.submit, SUBMIT_MS))
      await fp.act({ kind: "click" }, box.submit, { goal: "submit verification code" });
  });
}

/** A captcha: solved here, else a person's, done when its box is gone (no box: when the page moves on). */
export async function solveCaptcha(
  st: SignInState,
  ctx: SignInContext,
  box?: Hints,
): Promise<void> {
  const got = await ctx.fp.captcha();
  if (!got.solved)
    await personStep(
      ctx,
      `${st.site}: the sign-in captcha is a person's (${got.reason})`,
      box ? async () => !(await ctx.fp.has(box)) : undefined,
    );
}

/** Our authenticator holds the key: the ceremony completes on the click. */
export const signInWithPasskey = (fp: FlowPage, start: Hints): Promise<void> =>
  fp.act({ kind: "click" }, start, { goal: "verify with our passkey" });

/** A step only a person's device or eyes can answer: they act in the window. */
export const askPerson = (st: SignInState, ctx: SignInContext, why: string): Promise<void> =>
  personStep(ctx, `${st.site}: ${why}`);

/** The credential's values a login walk's hints may name (`SIGN_IN_VARS`); absent: none. */
export function signInVars(ctx: SignInContext): Record<string, string> {
  const phone = phoneOf(ctx);
  return {
    username: ctx.cred.username,
    address: addressOf(ctx.cred),
    ...(phone ? { phoneTail: phone.replace(/\D/g, "").slice(-2) } : {}),
  };
}

const VAR = /\{(username|address|phoneTail)\}/g;
const escRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Hints with `{username}`, `{address}` and `{phoneTail}` filled in: escaped inside a
 * `/regex/` or a css string. A value it names that is absent: null, a hint that never matches.
 */
export function fillVars(h: Hints, vars: Readonly<Record<string, string>>): Hints | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v !== "string" || !v.match(VAR)) {
      out[k] = v;
      continue;
    }
    const regex = /^\/.*\/[a-z]*$/s.test(v);
    let missing = false;
    out[k] = v.replace(VAR, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        missing = true;
        return "";
      }
      if (regex) return escRegex(value);
      return k === "css" ? value.replace(/["\\]/g, "\\$&") : value;
    });
    if (missing) return null;
  }
  return out as Hints;
}

/**
 * Whether a tile's label names this account: `shows`' group is the shown account, cut
 * short with `…` or `...` ("jinwi…@gmail.com", "jinwi…"); the shown parts, in order.
 */
export function tileNames(label: string, shows: RegExp, account: string): boolean {
  const shown = label.match(shows)?.[1]?.trim().toLowerCase();
  if (!shown || !account) return false;
  const cut = /(…|\.\.\.)$/.test(shown);
  const parts = shown.split(/…|\.\.\./).map(escRegex);
  return new RegExp(`^${parts.join(".*")}${cut ? "" : "$"}`).test(account.trim().toLowerCase());
}

const click = (fp: FlowPage, hints: Hints, goal: string) =>
  fp.act({ kind: "click" }, hints, { goal });

/** A saved-account tile: ours is picked (riding a provider's live session with `ride`), else `other`. */
export async function pickAccount(
  st: SignInState,
  ctx: SignInContext,
  o: {
    goal: string;
    tile: Hints;
    shows?: RegExp | undefined;
    other?: Hints | undefined;
    ride?: { pick: Hints; stop: Hints; why: string } | undefined;
  },
): Promise<void> {
  const { fp, cred } = ctx;
  const vars = signInVars(ctx);
  const tile = fillVars(o.tile, vars);
  const ours = async (t: Hints) => {
    if (!o.shows) return true;
    const label = await fp.read(t);
    return [addressOf(cred), cred.username].some((a) => tileNames(label, o.shows as RegExp, a));
  };
  if (tile && (await fp.has(tile, 3_000)) && (await ours(tile))) {
    // a saved session answers for the secret
    st.submitted = true;
    if (!o.ride) return click(fp, tile, o.goal);
    const main = fp.page;
    await clickOpening(fp, tile, o.goal);
    const pick = fillVars(o.ride.pick, vars);
    const at = fp.url();
    if (pick && (await fp.has(pick, 3_000))) await click(fp, pick, "pick the account");
    // the live session is gone: never a secret on a ride
    else if (await fp.has(o.ride.stop)) failSignIn(st, o.ride.why);
    await backFrom(fp, main);
    await fp.waitForUrl((u) => u !== at, 30_000);
    return;
  }
  if (o.other && (await fp.has(o.other))) return click(fp, o.other, "use another account");
  failSignIn(st, `${o.goal}: no tile for ${cred.username} and no other way`);
}

/** The failure's words with what turned a way down, when something did. */
const noted = (st: SignInState, why: string) => (st.note ? `${why}; ${st.note}` : why);

/** How long a person gets to approve on their phone. */
const PUSH_MS = 180_000;

/**
 * A list of second steps: the first way this credential can answer whose choice
 * shows. A code way sends and types under the inbox lock (`enterCode`); push
 * notifies and waits for the phone's yes. The third list in a try is a person's.
 */
export async function secondStep(
  st: SignInState,
  ctx: SignInContext,
  ways: readonly SecondWay[],
): Promise<void> {
  const { fp, cred } = ctx;
  // twice is a real sign-in (before the password, then after it); a third is a loop
  if (++st.listed > 2) {
    st.listed = 0;
    return personStep(
      ctx,
      `${st.site}: ${noted(st, "keeps asking for a second step only a person can answer")}`,
      movedOn(fp),
    );
  }
  const vars = signInVars(ctx);
  const can = (w: SecondWay): boolean => {
    if (w.way === "passkey") return cred.passkeys.length > 0 && !st.passkeyTried;
    if (w.way === "password") return !st.passwordTyped && !!cred.password;
    if (w.way === "push") return !!ctx.notify;
    return ctx.offers(w.way);
  };
  type Open = { w: SecondWay; choice: Hints | null };
  const open = ways.flatMap((w): Open[] => {
    if (!can(w)) return [];
    if (!w.choice) return [{ w, choice: null }];
    const choice = fillVars(w.choice as Hints, vars);
    return choice ? [{ w, choice }] : [];
  });
  // the list renders late: each answerable way gets looked for until one shows
  let taken: Open | undefined;
  for (let t = 0; !taken && open.length && t < RENDER_MS; t += 500) {
    for (const o of open)
      if (!o.choice || (await fp.has(o.choice, 0))) {
        taken = o;
        break;
      }
    if (!taken) await fp.wait(500);
  }
  if (!taken)
    failSignIn(
      st,
      noted(
        st,
        "wants a second step and none is set up: enroll TOTP, link a phone, or configure Twilio",
      ),
    );
  const { w, choice } = taken as Open;
  st.submitted = true;
  if (w.way === "sms" || w.way === "email")
    return enterCode(st, ctx, {
      kinds: [w.way],
      field: w.field as Hints,
      submit: w.submit as Hints,
      send: choice ?? undefined,
      hint: w.hint,
      phone: w.phone as CodeBox["phone"],
    });
  if (w.way !== "push") return click(fp, choice as Hints, `second step: ${w.way}`);
  if (choice) await click(fp, choice, "ask the phone");
  await fp.wait(1_500);
  const extra = w.note ? (await fp.text()).match(regexOf(w.note))?.[1] : undefined;
  await ctx.notify?.(
    `${st.site} sign-in for ${cred.username}: ${w.ask}${extra ? ` (${extra})` : ""}`,
  );
  const ms = w.waitMs ?? PUSH_MS;
  if (!(await fp.waitForUrl(regexOf(w.until), ms)))
    failSignIn(st, `no yes from the phone within ${Math.round(ms / 60_000)} minutes`);
}

/**
 * Our passkey: the click starts the ceremony our authenticator completes. With
 * `leaves` it is tried once; still on that page after 20 s, the site refused our
 * key and `other` is clicked. No key of ours: `other`, else a person's key.
 */
export async function tryPasskey(
  st: SignInState,
  ctx: SignInContext,
  o: { start: Hints; leaves?: RegExp | undefined; other?: Hints | undefined },
): Promise<void> {
  const { fp, cred } = ctx;
  if (!cred.passkeys.length || st.passkeyTried) {
    if (o.other) return click(fp, o.other, "another way");
    // no key of ours: the ceremony would hang; a person answers with theirs
    if (!cred.passkeys.length)
      return personStep(ctx, `${st.site}: the site asks for a security key; none is stored`);
    failSignIn(st, noted(st, "the site asks for our passkey again"));
  }
  if (!o.leaves) {
    st.submitted = true;
    return signInWithPasskey(fp, o.start);
  }
  st.passkeyTried = true;
  // a "presend" page first on some ("Your device will ask for your fingerprint… Continue")
  if (await fp.has(o.start, 3_000)) await signInWithPasskey(fp, o.start);
  const on = o.leaves;
  if (await fp.waitForUrl((u) => !on.test(u), 20_000)) {
    st.submitted = true;
    return;
  }
  st.note = `our passkey was refused (${fp.url().replace(/\?.*/, "")})`;
  if (o.other) return click(fp, o.other, "another way");
  failSignIn(st, st.note);
}
