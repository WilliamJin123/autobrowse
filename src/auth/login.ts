/**
 * Signing in as code. A `SiteLogin` knows one site's login page: how to
 * tell a signed-in page from a wall, and the gestures from the sign-in
 * button to the dashboard. Passwords come from the credential store,
 * second factors from the code sources; the flow only sees `fp.act`.
 *
 * `formLogin` covers the common shape (username, maybe a Next, password,
 * submit, maybe a code). Sites that differ write `signIn` by hand; a
 * branching one is a walk of screens (`google.ts`).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Credential, CredentialStore, SecretAudit } from "credvault";
import { banHit } from "../browser/ban-signals.js";
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { pageState, untilLoaded } from "../browser/page-state.js";
import { snapshotPage } from "../browser/repair.js";
import { isUnknownPage, type Screen, type Walk, walk } from "../browser/screens.js";
import { holdsSecret, secret } from "../browser/secrets.js";
import { NeedsHuman, wallOf } from "../browser/session.js";
import { safeUrls } from "../clients/http.js";
import type { WalkSpec } from "../walks/spec.js";
import { type CodeKind, type CodeSource, inboxLock } from "./codes.js";
import { guardedPage, hostNamed, hostUnder, registrable } from "./guard.js";
import { pageLogin } from "./page-login.js";
import { type IdentityProvider, type Provider, providerOf } from "./providers.js";
import { claims, MAIN, siteOf } from "./roles.js";
import {
  type FailCase,
  nextHold,
  type SignInHolds,
  type SignInLog,
  type SignInTry,
} from "./sign-in-holds.js";
import {
  askPerson,
  enterCode,
  failSignIn,
  type PasswordForm,
  retypePrevious,
  signInState,
  signInWithPasskey,
  solveCaptcha,
  typePassword,
} from "./sign-in-kit.js";

export {
  type FailCase,
  fileSignInHolds,
  fileSignInLog,
  type Hold,
  nextHold,
  type SignInHolds,
  type SignInLog,
  type SignInTry,
} from "./sign-in-holds.js";

/** The page left the address it was at: a person's step is past. */
export const movedOn = (fp: FlowPage): (() => Promise<boolean>) => {
  const at = fp.url();
  return async () => fp.url() !== at;
};

/**
 * A sign-in step only a person can answer on the page (a phone tap's number, a puzzle, an
 * identity check). In a window: the person is told, the window comes forward and the sign-in
 * waits till `gone`. Headless: the runner runs the flow again in a window (`fp.person`). Not a
 * refused sign-in: no hold follows (WA-1028).
 */
export async function personStep(
  ctx: Pick<SignInContext, "fp" | "notify" | "cred">,
  reason: string,
  gone: () => Promise<boolean> = movedOn(ctx.fp),
): Promise<void> {
  const { fp } = ctx;
  if (!fp.person) return fp.human(reason);
  let told = false;
  await fp.person(reason, async () => {
    // told once the window is up, not on the headless try that only asks for one
    if (!told) {
      told = true;
      await ctx
        .notify?.(`Sign-in for ${ctx.cred.username} waits for you in a browser window: ${reason}`)
        .catch(() => undefined);
    }
    return gone();
  });
}

export interface SignInContext {
  fp: FlowPage;
  cred: Credential;
  /**
   * A second-factor code of this kind, or throws when none can be had.
   * `after`: only one that arrived after this (the moment it was asked for),
   * so a text meant for another account on the same phone is never taken.
   */
  code(kind: CodeKind, hint?: string, after?: Date): Promise<string>;
  /**
   * Run `fn` (ask for a code, read it, type it) while no other sign-in on
   * this machine asks the same inbox: codes that look alike stay apart.
   * Absent: `fn` runs at once (`serially`).
   */
  serial?<T>(kind: CodeKind, fn: () => Promise<T>): Promise<T>;
  /** Whether a code of this kind can be had, so the sign-in picks that step on the page. */
  offers(kind: CodeKind): boolean;
  /** Where that code would land, to match against a page that masks numbers ("•••-••82"). */
  inbox(kind: CodeKind): string | null;
  /**
   * A note to the person's phone, for a step only a device can answer
   * ("Tap Yes on your phone"). Absent when no phone is linked.
   */
  notify?: (text: string) => Promise<void>;
  /**
   * Another site's credential (the identity provider behind an OAuth button),
   * or throws. With `account`, the one for that username: the site's own when
   * it matches, else a `<site>@<label>` (or `<site>-<label>`) credential whose username is it.
   */
  credFor(site: string, account?: string): Promise<Credential>;
  /** This context signing in as another credential: its codes come from that one. */
  as(cred: Credential): SignInContext;
  /** Screens a login walk passed, in order, for the try log; shared with `as`. */
  steps?: string[];
}

export interface SiteLogin {
  site: string;
  home: string;
  /**
   * Which stored credential signs in here; default = `site`. Sites behind
   * the same identity provider name it once: `google` for the admin
   * console and for every "Sign in with Google" button.
   */
  credential?: string;
  /**
   * What setup says when it asks for this credential, in the site's own
   * terms ("A Google Workspace admin for your domains"). Default: the site name.
   */
  ask?: string;
  /** Identity providers whose button this site's `signIn` can use instead of a password. */
  via?: readonly Provider[];
  /** A walk sign-in: its spec and the walks dir a heal screen goes to (`healSignIn`). */
  heal?: { spec: WalkSpec; dir: string };
  /** True when the page shows a signed-in state (avatar, dashboard, no sign-in form). */
  loggedIn(fp: FlowPage): Promise<boolean>;
  signIn(ctx: SignInContext): Promise<void>;
  /**
   * The site's own sign-in surface (accounts.google.com). A wall there is
   * answered where the page is: a security page asks for the password
   * again even though `home` is signed in, so `signIn` would find nothing to do.
   */
  signInHere?: {
    at: RegExp;
    run(ctx: SignInContext): Promise<void>;
    /** A page on that surface that is past the sign-in (Google's scope grant, mid-consent). */
    past?: RegExp;
  };
  /**
   * The password asked again in place, signed in (Discord's box before a
   * bot token reset): filled where it shows, no navigation, so the dialog
   * and what waits behind it survive.
   */
  reauth?: { field: Hints; submit: Hints };
  /** How this site's authenticator setup page walks, when it is known; `mfa totp` guesses otherwise. */
  totpSetup?: TotpSetupSpec;
  /** How this site's change-password page walks, for `creds rotate`. */
  passwordChange?: PasswordChangeSpec;
  /** How this site's passkey page walks, for `mfa passkey`. */
  passkeySetup?: PasskeySetupSpec;
  /** Where this site shows the account's recovery codes, for `mfa codes` and after an enrollment. */
  recoveryCodes?: RecoveryCodesSpec;
  /**
   * Registrable domains the credential's password may be typed on, beside
   * `home`'s own (Google signs in on accounts.google.com, Microsoft on
   * live.com and microsoftonline.com). Anywhere else is a leak.
   */
  origins?: readonly string[];
  /**
   * Registrable domains of this provider's other products (youtube.com for
   * google): a page there takes this login's tools and sign-in. The password
   * is never typed there; that boundary is `origins`.
   */
  properties?: readonly string[];
}

/** The passkeys page: the button that starts the ceremony (our authenticator answers it), what the page says after. */
export interface PasskeySetupSpec {
  url: string | ((cred: Credential) => string);
  /** Clicks before `create`, when present (pick the method, "Continue"). */
  before?: Hints[];
  /** The box the site wants the key's name in, before `create`. */
  name?: Hints;
  create: Hints;
  /** Confirmations after `create`, clicked when present ("Continue passkey enrollment"). */
  confirmations?: Hints[];
  done: RegExp;
}

/**
 * The page that lists the account's recovery codes. Each match of `codes`
 * on it is one code, sealed with the credential and never printed.
 */
export interface RecoveryCodesSpec {
  url: string | ((cred: Credential) => string);
  /** The button a page shows when it wants the key again before it shows them. */
  unlock?: Hints;
  codes: RegExp;
}

/** The change-password page: fields to fill, the submit, what the page says after. */
export interface PasswordChangeSpec {
  url: string | ((cred: Credential) => string);
  /** The current password, when the page asks for it on the form itself. */
  current?: Hints;
  next: Hints;
  confirm?: Hints;
  submit: Hints;
  done: RegExp;
}

/** The clicks from the two-factor page to the seed, then to the code box. */
export interface TotpSetupSpec {
  /** The setup page; a function when the URL must name the account (Google's `authuser=`). */
  url: string | ((cred: Credential) => string);
  /** In order, until the seed is on the page ("Set up authenticator", "Can't scan it?"). */
  reveal: Hints[];
  /** From the seed to the code box ("Next"), if any. */
  toCode?: Hints[];
  code: Hints;
  confirm: Hints;
  /** Text that means the site accepted the code. */
  done: RegExp;
}

/** The step where a code is asked: which field, how to submit, what kind of code. */
export interface CodeStep {
  kind: CodeKind;
  field: Hints;
  submit: Hints;
  /** Text that says the page is asking for a code; absent = the field's presence decides. */
  asks?: RegExp;
  /** Something the message would contain, for email/SMS. */
  hint?: string;
}

export interface FormLoginSpec {
  start: string;
  /** A saved-account chooser that hides the form: pressed first, only when it shows. */
  reveal?: Hints;
  username: Hints;
  /** Two-page forms: press this after the username. */
  next?: Hints;
  password: Hints;
  submit: Hints;
  /** The second step; a list when the site asks differently by account (an emailed code until 2FA, then the authenticator): the first whose page matches answers. */
  code?: CodeStep | CodeStep[];
  /** A second step our enrolled passkey answers: the page asks, one click starts the ceremony. Tried before `code`. */
  passkey?: { asks: RegExp; start: Hints };
  /** Signed in when the page text or URL matches; else when the password field is gone. */
  success?: RegExp;
  /** Text that means the password was rejected: stop, do not lock the account. */
  rejected?: RegExp;
  /** A captcha the site may show after submit (Discord's hCaptcha): solved by the runner, else a person's. */
  captcha?: Hints;
  /** A second step only a person can answer (Apple's code on William's devices): a pause, not a failure. */
  person?: { asks: RegExp; why: string };
  /** The keep-me-signed-in tick, when the site words it unlike the usual; ticked before every submit that shows it. */
  keepSignedIn?: Hints;
  /** "Trust this browser?" after the second step: pressed, so the profile skips it next time. */
  trust?: Hints;
}

/** What a site says when it turns the account away, typed or not (`typedSecret` decides the rest). */
const SITE_REFUSAL =
  /password rejected|code rejected|code was refused|code was wrong|too many failed attempts|refused this browser|unknown account/i;

/** The case a refusal's words name; sites not yet walks say it in words. */
function refusalCase(reason: string): FailCase | undefined {
  if (/password rejected/i.test(reason)) return "password";
  if (/code rejected|code was refused|code was wrong/i.test(reason)) return "code";
  if (/too many failed attempts|refused this browser|unknown account/i.test(reason))
    return "account";
  return undefined;
}

export class LoginFailed extends Error {
  /** The site said it turned the account away (`SITE_REFUSAL`). */
  readonly refused: boolean;
  /** Set by the one who knows (a kit op, a refusal's words); else the hold works it out. */
  readonly case: FailCase | undefined;
  constructor(
    site: string,
    reason: string,
    refused = SITE_REFUSAL.test(reason),
    failCase: FailCase | undefined = refused ? refusalCase(reason) : undefined,
  ) {
    super(safeUrls(`${site}: ${reason}`));
    this.name = "LoginFailed";
    this.refused = refused;
    this.case = failCase;
  }
}

/** A short hold: no sign-in till `until`; the caller tries again then, no person needed. */
export class SignInHeld extends Error {
  readonly until: number;
  readonly failCase: FailCase | undefined;
  constructor(until: number, failCase: FailCase | undefined, message: string) {
    super(message);
    this.name = "SignInHeld";
    this.until = until;
    this.failCase = failCase;
  }
}

const SETTLE_MS = 1_500;

/** Passwords this process read to type (a provider's too): a typed secret in this set is a password, else a code. */
const PASSWORDS = new Set<string>();
export const isPassword = (value: string): boolean => PASSWORDS.has(value);

/** The credential's password, or a clear failure: a `via` credential has none and belongs on the provider path. */
export function passwordOf(site: string, cred: Credential): string {
  if (!cred.password)
    throw new LoginFailed(
      site,
      `the ${site} credential has no password (it signs in via ${cred.via})`,
    );
  PASSWORDS.add(cred.password);
  return secret(cred.password);
}

/** The password before the last rotation, held and known as a password like `passwordOf`'s. */
export function previousPasswordOf(cred: Credential): string | null {
  if (!cred.previousPassword) return null;
  PASSWORDS.add(cred.previousPassword);
  return secret(cred.previousPassword);
}

/**
 * A form sign-in as a walk (designs/2026-09-27-screens.md): each page the
 * form can show is a screen, so a saved-account chooser, a two-page form,
 * a captcha or a code page is answered in whatever order the site shows
 * it, and a page it does not know goes down the learned → reader ladder.
 * A password is typed once (the previous one once more on a rejection):
 * the form coming back without saying why is a failure, never a retype.
 */
export function formLogin(site: string, spec: FormLoginSpec): SiteLogin["signIn"] {
  return async (ctx) => {
    const { cred } = ctx;
    const password = passwordOf(site, cred);
    await ctx.fp.open(spec.start, { allowWall: true });
    await walk(ctx, formWalk(site, spec, ctx, password));
  };
}

function formWalk(
  site: string,
  spec: FormLoginSpec,
  { cred }: SignInContext,
  password: string,
): Walk<SignInContext> {
  const st = signInState(site);
  const fail = (why: string): never => failSignIn(st, why);
  const form: PasswordForm = {
    field: spec.password,
    submit: spec.submit,
    keepSignedIn: spec.keepSignedIn,
  };
  const codes = spec.code ? [spec.code].flat() : [];
  const screens: Screen<SignInContext>[] = [
    {
      name: "signed in",
      looks: "the site signed in, past the login form",
      // Only after the password: a start page is never mistaken for the goal.
      async is({ fp }) {
        if (!st.submitted) return false;
        if (spec.success) return spec.success.test(fp.url()) || spec.success.test(await fp.text());
        for (const h of [spec.password, spec.username, ...codes.map((c) => c.field)])
          if (await fp.has(h)) return false;
        return true;
      },
      goal: true,
    },
    ...(spec.captcha
      ? [
          {
            name: "captcha",
            looks: "a captcha challenge on the login form",
            shows: [spec.captcha],
            act: (c: SignInContext) => solveCaptcha(st, c, spec.captcha as Hints),
          },
        ]
      : []),
    ...(spec.rejected
      ? [
          {
            name: "rejected",
            looks: "the login form saying the username or password is wrong",
            says: spec.rejected,
            secret: true,
            act: (c: SignInContext) => retypePrevious(st, c, form),
          },
        ]
      : []),
    ...(spec.passkey && cred.passkeys.length
      ? [
          {
            name: "passkey",
            looks: "a prompt to verify with a security key or passkey",
            says: spec.passkey.asks,
            act: ({ fp }: SignInContext) => signInWithPasskey(fp, spec.passkey?.start as Hints),
          },
        ]
      : []),
    ...codes.map(
      (step): Screen<SignInContext> => ({
        name: `${step.kind} code`,
        looks: `a box asking for a ${step.kind} verification code`,
        // Text that asks decides; else the field showing does.
        ...(step.asks ? { says: step.asks } : { shows: [step.field] }),
        secret: true,
        act: (c) =>
          enterCode(st, c, {
            kinds: [step.kind],
            field: step.field,
            submit: step.submit,
            hint: step.hint,
          }),
      }),
    ),
    ...(spec.person
      ? [
          {
            name: "person's step",
            looks: "a second step only a person's device can answer",
            says: spec.person.asks,
            act: (c: SignInContext) => askPerson(st, c, spec.person?.why as string),
          },
        ]
      : []),
    ...(spec.trust
      ? [
          {
            name: "trust browser",
            looks: "a prompt to trust this browser after the second step",
            shows: [spec.trust],
            act: ({ fp }: SignInContext) =>
              fp.act({ kind: "click" }, spec.trust as Hints, { goal: "trust this browser" }),
          },
        ]
      : []),
    ...(spec.reveal
      ? [
          {
            name: "saved accounts",
            looks: "a saved-account chooser hiding the login form",
            shows: [spec.reveal],
            act: ({ fp }: SignInContext) =>
              fp.act({ kind: "click" }, spec.reveal as Hints, {
                goal: "past the saved-account chooser",
              }),
          },
        ]
      : []),
    {
      name: "login form",
      looks: "the login form: username and password boxes",
      shows: [spec.username, spec.password],
      secret: true,
      async act({ fp }) {
        // retyping the address makes Apple's widget drop the password box again
        if (!st.typedUsername)
          await fp.act({ kind: "fill", value: cred.username }, spec.username, {
            goal: "type username",
          });
        await typePassword(st, fp, form, password);
      },
    },
    {
      name: "username page",
      looks: "the first page of a two-page login: the username box alone",
      shows: [spec.username],
      hides: [spec.password],
      async act({ fp }) {
        await fp.act({ kind: "fill", value: cred.username }, spec.username, {
          goal: "type username",
        });
        await fp.act({ kind: "click" }, spec.next ?? spec.submit, {
          goal: "continue past username",
        });
        st.typedUsername = true;
        // password shows late (Apple); settle before the next screen reads
        if (spec.next) await fp.has(spec.password, 8000);
      },
    },
    {
      name: "password page",
      looks: "the second page of a two-page login: the password box alone",
      shows: [spec.password],
      hides: [spec.username],
      secret: true,
      act: ({ fp }) => typePassword(st, fp, form, password),
    },
  ];
  return { site, name: "sign-in", goal: `signed in to ${site}`, fail, screens };
}

/** `fn` under the context's inbox lock when it has one. */
export function serially<T>(ctx: SignInContext, kind: CodeKind, fn: () => Promise<T>): Promise<T> {
  return ctx.serial ? ctx.serial(kind, fn) : fn();
}

export interface OauthLoginSpec {
  start: string;
  /** Clicks on `start` that bring the provider's button up (a "Sign In" that opens a modal). */
  before?: Hints[];
  /** A saved-account chooser's way out ("Sign in using another account"): pressed only when it shows. */
  reveal?: Hints;
  /**
   * An email-first page (HubSpot): the account's address goes in `field`, then
   * `next` brings the provider's button up. Skipped when the field is absent.
   */
  email?: { field: Hints; next: Hints };
  /** The provider's button on the site's login page; the provider's own readings when absent. */
  button?: Hints;
  /** Which identity provider (and stored credential) signs in; `google` by default. */
  provider?: Provider;
  /** The site's page after the round trip: a URL pattern, or a check on the page. */
  success: RegExp | ((fp: FlowPage) => Promise<boolean>);
  /**
   * The site's own second step after the provider (Twilio texts a code even
   * to a Google sign-in): answered with the site's credential and inboxes.
   */
  challenge?: { at: RegExp; run(ctx: SignInContext): Promise<void> };
  /** Which account at the provider, when the site's is not the provider's stored one. */
  account?: string;
}

/** The provider's button as this site shows it: the spec's hint, else the first of the provider's readings on the page. */
async function providerButton(fp: FlowPage, p: IdentityProvider, hint?: Hints): Promise<Hints> {
  if (hint) return hint;
  // An app shell paints its buttons late (Notion's "Loading...", 2026-10-02).
  await untilLoaded(fp, LOADING_MS);
  for (const h of p.buttons) if (await fp.has(h, 1_500)) return h;
  throw new LoginFailed(fp.url(), `no "${p.site}" button: ${await pageState(fp)}`);
}

/** How long a site's own spinner may stand between a press and the next page. */
const LOADING_MS = 30_000;

/** Sign in through an identity provider's button: popup or redirect, then back to the site. */
export function oauthLogin(site: string, spec: OauthLoginSpec): SiteLogin["signIn"] {
  const provider = providerOf(spec.provider ?? "google");
  return async (ctx) => {
    const { fp } = ctx;
    const main = fp.page;
    await fp.open(spec.start, { allowWall: true });
    // The load itself may sign in (One Tap's auto_select, a live cookie): no button to find then.
    // A URL pattern can match `start` itself, so only a page check counts; signInWith checks again.
    if (typeof spec.success === "function" && (await spec.success(fp).catch(() => false))) return;
    const opened = () => fp.pages().find((p) => p !== main && provider.host.test(p.url())) ?? null;
    // One Tap opens its own card as the page loads (`auto_select`), before
    // anything is pressed — and the button under that card can then be
    // unclickable. A card that is already there is the sign-in (LinkedIn, 2026-09-22).
    let page = opened();
    if (!page) {
      if (spec.reveal && (await fp.has(spec.reveal, 1_500)))
        await fp.act({ kind: "click" }, spec.reveal, { goal: "past the saved-account chooser" });
      // Absent when the page already shows the method list (or is not the site's: a wall
      // read too early). A 15 s wait on it stalled every open of Perplexity (WA-1022).
      for (const h of spec.before ?? [])
        if (await fp.has(h, 3_000))
          await fp.act({ kind: "click" }, h, { goal: `open ${site}'s sign-in` });
      if (spec.email && (await fp.has(spec.email.field, 3_000))) {
        await fp.act({ kind: "fill", value: ctx.cred.username }, spec.email.field, {
          goal: `${site}'s email first`,
        });
        await fp.act({ kind: "click" }, spec.email.next, { goal: `past ${site}'s email` });
      }
      const button = await providerButton(fp, provider, spec.button);
      const popup = fp.nextPage(8_000);
      const failed = await fp
        .act({ kind: "click" }, button, { goal: `sign in with ${provider.site}` })
        .then(
          () => null,
          (err: unknown) => err,
        );
      page = (await popup) ?? opened();
      if (!page) {
        if (failed) throw failed;
        // The site's own hop (Todoist's /oauth-start spinner) can take its time.
        const reached = async (ms: number) =>
          (await fp.waitForUrl(provider.host, ms)) || provider.host.test(fp.url());
        const spinning = async () => !(await untilLoaded(fp, 0));
        if (!(await reached(15_000)) && !((await spinning()) && (await reached(LOADING_MS))))
          throw new LoginFailed(
            site,
            `pressed the ${provider.site} button but never reached ${provider.site}: ${await pageState(fp)}`,
          );
      }
    }
    if (page) fp.switchTo(page);
    // A site made through the provider's button signs in as its own username
    // there, never as the provider's stored default: that was a person's own
    // account once, its password typed for a Wren site (2026-09-29).
    const account = spec.account ?? (ctx.cred.via ? ctx.cred.username : undefined);
    const cred = await ctx.credFor(provider.site, account);
    await provider.signIn(ctx.as(cred));
    fp.switchTo(main);
    await landAfterOauth(site, spec, ctx);
  };
}

/**
 * Any site whose credential says `via`: its login page is where the wall
 * was met (or the credential's `url`), the provider's button is found by
 * its readings, and "signed in" means the page is no longer a wall. This
 * is what makes a provider sign-in work on a site nobody wrote a spec for.
 */
export function viaLogin(site: string, cred: Credential): SiteLogin {
  if (cred.via === EMAIL_CODE) return emailCodeLogin(site, cred);
  const provider = providerOf(cred.via as Provider);
  // A page that still holds a password field is a sign-in form under some other URL (Telnyx, 2026-09-29).
  // A spinner is neither signed in nor out: wait it out before judging.
  const signedIn = async (fp: FlowPage) =>
    (await untilLoaded(fp, LOADING_MS)) &&
    !provider.host.test(fp.url()) &&
    wallOf(fp.url(), (await fp.text()).slice(0, 4000)) === null &&
    !(await fp.has({ css: "input[type=password]" }, 500));
  return {
    site,
    home: cred.url ?? "",
    loggedIn: signedIn,
    signIn: async (ctx) => {
      const start = cred.url ?? ctx.fp.url();
      if (!/^https?:/.test(start))
        throw new LoginFailed(site, "no sign-in page known: store the credential with a url");
      await oauthLogin(site, {
        start,
        provider: provider.site,
        success: signedIn,
        account: cred.username,
      })(ctx);
    },
  };
}

/** `via: "email"`: no password and no provider; the site emails a code to the address each time. */
export const EMAIL_CODE = "email";

/** The boxes a passwordless sign-in page shows, by the attributes such pages use. */
export const EMAIL_CODE_PAGE = {
  email: {
    css: "input[type=email], input[autocomplete=email], input[autocomplete=username], input[name*=email i]",
  },
  code: {
    css: "input[autocomplete=one-time-code], input[name*=code i], input[inputmode=numeric], input[name*=otp i]",
  },
  submit: { css: "button[type=submit], form button:not([type=button])" },
  /** A code page's button outside any form (Cap's "Verify Code"): found by its words. */
  verify: {
    role: "button",
    name: "/^\\s*(verify|continue|confirm|submit|sign ?in|log ?in|next)/i",
  },
} satisfies Record<string, Hints>;
const { email: EMAIL_FIELD, code: CODE_FIELD, submit: CONTINUE } = EMAIL_CODE_PAGE;

/**
 * A passwordless sign-in: type the address, submit, read the emailed code from its inbox
 * (`codesInbox`, else the username), type it. A walk, so a page it doesn't know goes down
 * the learned → reader ladder like any form.
 */
export function emailCodeLogin(site: string, cred: Credential): SiteLogin {
  const signedIn = async (fp: FlowPage) =>
    (await untilLoaded(fp, LOADING_MS)) &&
    wallOf(fp.url(), (await fp.text()).slice(0, 4000)) === null &&
    !(await fp.has(EMAIL_FIELD, 500)) &&
    !(await fp.has(CODE_FIELD, 500));
  return {
    site,
    home: cred.url ?? "",
    loggedIn: signedIn,
    signIn: async (ctx) => {
      if (!cred.url) throw new LoginFailed(site, "no sign-in page known: store it with --url");
      await ctx.fp.open(cred.url, { allowWall: true });
      let sent: Date | null = null;
      let typed = false;
      const fail = (why: string): never => {
        throw new LoginFailed(site, why);
      };
      await walk(ctx, {
        site,
        name: "email-code sign-in",
        goal: `signed in to ${site}`,
        fail,
        screens: [
          {
            name: "signed in",
            looks: "the site signed in, past the email and code boxes",
            is: async ({ fp }) => typed && (await signedIn(fp)),
            goal: true,
          },
          {
            name: "code page",
            looks: "a box asking for the code the site just emailed",
            shows: [CODE_FIELD],
            async act({ fp, code }) {
              if (typed) fail(`the code page came back after the code: ${fp.url()}`);
              const c = await code("email", site, sent ?? undefined);
              await fp.act({ kind: "fill", value: c }, CODE_FIELD, {
                goal: "type the emailed code",
              });
              const at = fp.url();
              // Many code boxes submit themselves on the last digit; else the form's button, else one by its words.
              if (!(await fp.waitForUrl((u) => u !== at, 2_000))) {
                const go = (await fp.has(CONTINUE, 500)) ? CONTINUE : EMAIL_CODE_PAGE.verify;
                if (await fp.has(go, 500))
                  await fp.act({ kind: "click" }, go, { goal: "submit the code" });
              }
              typed = true;
              // Checking the code takes a round trip: let the page move before the walk judges it.
              await fp.waitForUrl((u) => u !== at, 20_000);
            },
          },
          {
            name: "email page",
            looks: "the sign-in page asking for an email address",
            shows: [EMAIL_FIELD],
            hides: [CODE_FIELD],
            async act({ fp }) {
              if (sent) fail(`the email page came back after sending: ${fp.url()}`);
              await fp.act({ kind: "fill", value: cred.username }, EMAIL_FIELD, {
                goal: "type the email",
              });
              sent = new Date();
              await fp.act({ kind: "click" }, CONTINUE, { goal: "ask for a code" });
            },
          },
        ],
      });
    },
  };
}

/** Back from the provider: the site's own challenge if it shows one, then its signed-in page. */
export async function landAfterOauth(
  site: string,
  spec: Pick<OauthLoginSpec, "success" | "challenge" | "provider">,
  ctx: SignInContext,
): Promise<void> {
  const { fp } = ctx;
  const provider = spec.provider ?? "google";
  const fail = async () =>
    new LoginFailed(site, `not signed in after the ${provider} round trip: ${await pageState(fp)}`);
  const challenge = spec.challenge;
  const success = spec.success;
  if (challenge) {
    const at = (u: string) =>
      (success instanceof RegExp && success.test(u)) || challenge.at.test(u);
    if (!(await fp.waitForUrl(at, 30_000)) && !at(fp.url())) throw await fail();
    if (challenge.at.test(fp.url())) await challenge.run(ctx);
  }
  if (success instanceof RegExp) {
    if (!(await fp.waitForUrl(success, 30_000)) && !success.test(fp.url())) throw await fail();
    return;
  }
  // A check on the page rather than a URL: let the app shell load, then ask a few times.
  await untilLoaded(fp, LOADING_MS);
  for (let i = 0; i < 10; i++) {
    if (await success(fp)) return;
    await fp.wait(SETTLE_MS);
  }
  throw await fail();
}

const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The page a walk sign-in failed on, caught before anything leaves it. */
export interface SignInHealAsk {
  spec: WalkSpec;
  dir: string;
  url: string;
  snapshot: string;
  error: string;
  steps: readonly string[];
}

export interface LoginOptions {
  credentials: CredentialStore;
  codes: CodeSource;
  notify?: (text: string) => Promise<void>;
  /** Where every password use is recorded (allowed or refused). */
  audit?: SecretAudit;
  /** Failed sign-ins and how long each name waits (`fileSignInHolds`). */
  holds?: SignInHolds;
  /** Every try, kept (`fileSignInLog`). */
  tries?: SignInLog;
  /** For the hold's jitter; default `Math.random`. */
  random?: () => number;
  /** Where a "signed in after all" page is shot: the page our flow misread. */
  shots?: string;
  /** A walk failed on a page it does not know: write a screen for it. Not awaited. */
  heal?: (ask: SignInHealAsk) => Promise<unknown>;
  now?: () => Date;
}

/**
 * After a failure past a typed secret: signed in anyway (our flow misread the next page)?
 * The site's home with its own check; a wall, a ban page or any error is no.
 */
async function signedInAnyway(fp: FlowPage, login: SiteLogin): Promise<boolean> {
  if (!/^https?:/.test(login.home)) return false;
  try {
    await fp.open(login.home, { allowWall: true });
    const text = (await fp.text()).slice(0, 4000);
    if (banHit(login.site, fp.url(), text) || wallOf(fp.url(), text)) return false;
    return await login.loggedIn(fp);
  } catch {
    return false;
  }
}

/** The misread page, before the check leaves it; null when it cannot be shot. */
async function shotOf(fp: FlowPage, dir: string | undefined, name: string, at: Date) {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name.replace(/[^a-z0-9@._-]/gi, "_")}-${at.getTime()}.png`);
    await fp.page.screenshot({ path });
    return path;
  } catch {
    return null;
  }
}

/** What one try typed, and whether a later page proved the password. */
export interface TryTrack {
  password: number;
  code: number;
  last: "password" | "code" | null;
  /** The path the last password went in on. */
  passwordPath: string | null;
  /** A code went in, or an act ran on another path, after the password: the site took it. */
  proven: boolean;
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};

/** The page that notes each typed secret, password or code: a failed sign-in that typed none is ours. */
function typedSecret(fp: FlowPage, track: TryTrack, passwords: () => string[]): FlowPage {
  return {
    ...fp,
    get page() {
      return fp.page;
    },
    async act(op, hints, o) {
      const at = fp.url();
      const done = await fp.act(op, hints, o);
      // after the fill: a fill that throws typed nothing (a locate miss)
      if (op.kind === "fill" && holdsSecret(op.value)) {
        if (isPassword(op.value) || passwords().includes(op.value)) {
          track.password++;
          track.last = "password";
          track.passwordPath = pathOf(at);
          track.proven = false;
        } else {
          track.code++;
          track.last = "code";
          if (track.passwordPath) track.proven = true;
        }
      } else if (track.passwordPath && pathOf(at) !== track.passwordPath) track.proven = true;
      return done;
    },
  };
}

/** The case of a failure: its own, else what the try typed. */
export function caseOf(err: LoginFailed, track: TryTrack): FailCase {
  if (err.case) return err.case;
  if (track.last === "code" || /no \w+ code available|code never came/i.test(err.message))
    return "code";
  if (track.password) return track.proven ? "later" : "unproven";
  return "ours";
}

/**
 * A stored login changed (username, address, password): its refusal holds go, since the refused
 * value is gone. Holds are kept by the name asked (`x@main`, `x@itswilljin`), so each name that
 * reaches the credential is cleared. Answers the names lifted.
 */
export function liftHolds(
  holds: SignInHolds,
  key: string,
  cred: { username: string; roles?: readonly string[] | undefined },
  oldUsername?: string,
): string[] {
  const site = siteOf(key);
  const claimed = claims({ key, username: cred.username, roles: cred.roles ?? [] });
  const names = new Set([
    key,
    ...claimed.map((r) => `${site}@${r}`),
    ...[cred.username, oldUsername].filter((u): u is string => !!u).map((u) => `${site}@${u}`),
    ...(claimed.includes(MAIN) ? [site] : []),
  ]);
  const lifted = [...names].filter((n) => holds.get(n));
  for (const n of lifted) holds.clear(n);
  return lifted;
}

/**
 * The domains a credential's password may be typed on: its site's `home`
 * and `origins`, the credential's own `url`; for a name no spec knows, hosts
 * that carry the name (`instantly` → app.instantly.ai).
 */
export function passwordDomains(
  sites: readonly SiteLogin[],
  name: string,
  cred: Pick<Credential, "url">,
): string[] {
  const base = name.split("@")[0] ?? name;
  const login = sites.find((s) => (s.credential ?? s.site) === base) ?? resolveLogin(sites, base);
  // A login that names this exact credential (`learn` signs in as `outlook@uw`) adds its own.
  const named = name === base ? [] : sites.filter((s) => s.credential === name);
  const out = new Set<string>();
  for (const l of [...(login ? [login] : []), ...named]) {
    out.add(registrable(new URL(l.home).host));
    for (const d of l.origins ?? []) out.add(d);
  }
  if (cred.url) out.add(registrable(new URL(cred.url).host));
  return [...out];
}

export type LoginOutcome = "signed-in" | "no-credential" | "unknown-site";

/**
 * A site name may carry an account: `google@ops` is the google login with
 * the credential and browser profile "google@ops". One profile per
 * identity, so two accounts on one site never meet in a chooser. A bare
 * name keeps the spec's own credential (or the site name) and profile.
 */
export function resolveLogin(sites: readonly SiteLogin[], name: string): SiteLogin | null {
  const at = name.indexOf("@");
  const base = sites.find((s) => s.site === (at < 0 ? name : name.slice(0, at)));
  if (!base) return null;
  if (at < 0) return base;
  // `gmail@will` signs in as `google@will`: an app's second account is its provider's.
  return { ...base, site: name, credential: `${base.credential ?? base.site}${name.slice(at)}` };
}

/**
 * May a secret a compiled workflow of `site` fetched be typed on `host`?
 * A known site: its login origins. Any site: a host whose registrable
 * name IS the site's word (`instantly` → app.instantly.ai, never
 * instantly-help.evil.example). Never a host that is neither.
 */
export function siteAllowsHost(sites: readonly SiteLogin[], site: string, host: string): boolean {
  const word = (site.split("@")[0] ?? site).toLowerCase();
  const h = host.toLowerCase();
  if (hostNamed(h, word)) return true;
  const login = sites.find((s) => (s.credential ?? s.site) === word) ?? resolveLogin(sites, site);
  if (!login) return false;
  const origins = [registrable(new URL(login.home).host), ...(login.origins ?? [])];
  return origins.some((d) => hostUnder(h, d));
}

/** The credential a site name signs in with. */
export function credentialFor(sites: readonly SiteLogin[], name: string): string {
  const login = resolveLogin(sites, name);
  return login?.credential ?? name;
}

export interface SignInParts {
  fp: FlowPage;
  /** The site being signed in to (for messages and code requests). */
  site: string;
  cred: Credential;
  credentials: CredentialStore;
  codes: CodeSource;
  notify?: (text: string) => Promise<void>;
  /** Only codes that arrived after this count; now unless said. */
  since?: Date;
  /** One ask per inbox at a time; `inboxLock` (a lock dir in tmp) unless said. */
  lockInbox?: (inbox: string) => Promise<() => Promise<void>>;
  /** The credential's store name (`google@will`); the site's when absent. */
  credential?: string;
  /** Domains a credential's password may be typed on; the page refuses it elsewhere. Absent: unbound. */
  domainsFor?: (name: string, cred: Credential) => readonly string[];
  audit?: SecretAudit;
  /** Where a login walk notes the screens it passes, for the try log. */
  steps?: string[];
}

/**
 * The context a sign-in runs with, over a page the caller drives and the
 * stores it names: what `loginProvider` builds on a wall, on its own for a
 * caller who wants one login (`signInToGoogle(signInContext({...}))`).
 * Codes belong to the credential: an OAuth sign-in continues as the
 * provider's (`ctx.as(cred)`), and its TOTP must answer, not the site's.
 */
export function signInContext(p: SignInParts): SignInContext {
  const { site } = p;
  const since = p.since ?? new Date();
  // Which store name a credential came from, so its page is bound to that name's origins.
  const names = new WeakMap<Credential, string>();
  names.set(p.cred, p.credential ?? site);
  const pageFor = (cred: Credential): FlowPage => {
    const name = names.get(cred) ?? site;
    const domains = p.domainsFor?.(name, cred);
    if (!domains && !p.audit) return p.fp;
    return guardedPage(p.fp, {
      name,
      cred,
      // No domains known: the name itself must be in the host (`instantly` → app.instantly.ai).
      domains: domains?.length ? domains : [],
      site,
      by: "login",
      ...(p.audit ? { audit: p.audit } : {}),
      ...(domains?.length ? {} : { fallback: name.split("@")[0] ?? name }),
    });
  };
  const contextAs = (cred: Credential): SignInContext => ({
    fp: pageFor(cred),
    cred,
    async code(kind, hint, after) {
      const from = after && after > since ? after : since;
      const req = hint ? { site, kind, since: from, hint } : { site, kind, since: from };
      const c = await p.codes.get(req, cred);
      if (!c) throw new LoginFailed(site, `no ${kind} code available`, false, "code");
      return secret(c);
    },
    offers: (kind) => p.codes.offers(kind, cred),
    inbox: (kind) => p.codes.inbox(kind, cred),
    async serial(kind, fn) {
      const inbox = p.codes.inbox(kind, cred);
      if (!inbox) return fn();
      const release = await (p.lockInbox ?? inboxLock)(inbox);
      try {
        return await fn();
      } finally {
        await release();
      }
    },
    ...(p.notify ? { notify: p.notify } : {}),
    async credFor(other, account) {
      const c = await p.credentials.get(other);
      if (!c) throw new LoginFailed(site, `no credential stored for ${other}`);
      names.set(c, other);
      if (!account || sameUser(c.username, account)) return c;
      // A second account at the provider lives as `<provider>@<label>`.
      for (const name of await p.credentials.list()) {
        if (!name.startsWith(`${other}@`)) continue;
        const alt = await p.credentials.get(name);
        if (alt && sameUser(alt.username, account)) {
          names.set(alt, name);
          return alt;
        }
      }
      throw new LoginFailed(
        site,
        `no ${other} credential for ${account}: autobrowse creds set ${other}@<label> with that username`,
      );
    },
    as: contextAs,
    ...(p.steps ? { steps: p.steps } : {}),
  });
  return contextAs(p.cred);
}

/**
 * The runner's hook: on a login wall for `site`, sign in with what the
 * store has. `LoginFailed` (or a NeedsHuman from inside) propagates.
 */
export function loginProvider(sites: readonly SiteLogin[], opts: LoginOptions) {
  const now = opts.now ?? (() => new Date());
  return async (fp: FlowPage, site: string, account?: string): Promise<LoginOutcome> => {
    let name = site;
    let known = resolveLogin(sites, name);
    // A labelled site with no login (youtube@wren) on a provider's sign-in surface: that label's
    // provider account (google@wren). Bare `youtube` stays unknown: never the provider's main account.
    if (!known && name.includes("@")) {
      const on = sites.filter((s) => s.signInHere?.at.test(fp.url()));
      // the provider itself (it names products), not an app that shares its surface (gmail)
      const surface = on.find((s) => s.properties?.length) ?? on[0];
      if (surface) {
        name = `${surface.site}${name.slice(name.indexOf("@"))}`;
        known = resolveLogin(sites, name);
      }
    }
    // `account` as a stored name (`google@wren`) or role (`wren`), as explore lists them
    if (account) {
      const platform = (known?.credential ?? name).split("@")[0] ?? name;
      for (const key of account.startsWith(`${platform}@`) || account === platform
        ? [account]
        : account.includes("@")
          ? []
          : [`${platform}@${account}`]) {
        if (!(await opts.credentials.get(key))) continue;
        // this site's own spec, that key's label: gmail + google@wren → gmail@wren (credential google@wren)
        const base = name.split("@")[0] ?? name;
        name = key.includes("@") ? `${base}${key.slice(key.indexOf("@"))}` : base;
        known = resolveLogin(sites, name) ?? known;
        account = undefined;
        break;
      }
    }
    let cred = await opts.credentials.get(known?.credential ?? name);
    // The caller knows whose sign-in this is (the account an OAuth consent
    // is for): a second account at the same provider lives as `<site>@<label>`,
    // and that credential — not the site's default one — signs in.
    if (account && !(cred && isUser(cred, account))) {
      const base = known?.credential ?? name;
      for (const other of await opts.credentials.list()) {
        if (!other.startsWith(`${base}@`)) continue;
        const alt = await opts.credentials.get(other);
        if (!alt || !isUser(alt, account)) continue;
        name = other;
        known = resolveLogin(sites, other) ?? known;
        cred = alt;
        break;
      }
    }
    if (!cred) return known ? "no-credential" : "unknown-site";
    const since = now();
    const log = (row: Omit<SignInTry, "at" | "name">) =>
      opts.tries?.add({
        at: since.toISOString(),
        name,
        ...row,
        ms: now().getTime() - since.getTime(),
      });
    const hold = opts.holds?.get(name);
    if (hold && hold.until > since.getTime()) {
      const why = `${name}: no sign-in till ${new Date(hold.until).toISOString()}, the last one failed (${hold.error})`;
      log({ outcome: "held", ...(hold.case ? { case: hold.case } : {}), error: hold.error });
      // a short hold: the caller tries again then; a strict one (old records too) is a person's
      if (hold.strict === false) throw new SignInHeld(hold.until, hold.case, why);
      throw new NeedsHuman(`${why}; sign in by hand`, "login");
    }
    // One account, several ways in: each method in turn until one signs in.
    let first: unknown = null;
    let failedIn: SiteLogin | null = null;
    let failedVia: string | undefined;
    const track: TryTrack = { password: 0, code: 0, last: null, passwordPath: null, proven: false };
    const passwords = [cred.password, cred.previousPassword].filter((p): p is string => !!p);
    const watched = typedSecret(fp, track, () => passwords);
    const typed = () => ({ password: track.password, code: track.code });
    const steps: string[] = [];
    let healAsk: SignInHealAsk | null = null;
    for (const method of methodsOf(cred)) {
      // A method via a provider takes the generic provider path when the
      // site's own spec does not know that provider (or there is no spec at all).
      // No spec, a password: the boxes the page shows (WA-1349).
      const login =
        method.via && !known?.via?.includes(method.via as Provider)
          ? viaLogin(name, method)
          : (known ?? (method.password ? pageLogin(name, method) : null));
      if (!login) continue;
      const ctx = signInContext({
        fp: watched,
        site: name,
        cred: method,
        since,
        credential: known?.credential ?? name,
        credentials: opts.credentials,
        codes: opts.codes,
        domainsFor: (name, c) => passwordDomains(sites, name, c),
        steps,
        ...(opts.audit ? { audit: opts.audit } : {}),
        ...(opts.notify ? { notify: opts.notify } : {}),
      });
      const via = method.via ? `via:${method.via}` : "password";
      try {
        await signInWith(name, login, ctx);
        opts.holds?.clear(name);
        log({
          method: via,
          outcome: "signed-in",
          url: fp.url(),
          typed: typed(),
          ...stepsOf(steps),
        });
        return "signed-in";
      } catch (err) {
        // Only a refused sign-in moves on; a page that needs a person stops here.
        if (!(err instanceof LoginFailed)) {
          log({
            method: via,
            outcome: "failed",
            error: errText(err),
            url: fp.url(),
            typed: typed(),
            ...stepsOf(steps),
          });
          throw err;
        }
        if (!first) {
          failedIn = login;
          failedVia = via;
          // the walk's own failure on a page it does not know: keep that page for a heal
          if (login.heal && !err.refused && isUnknownPage(err.message))
            healAsk = {
              ...login.heal,
              url: fp.url(),
              snapshot: await snapshotPage(fp.page).catch(() => ""),
              error: err.message.slice(0, 300),
              steps: [...steps],
            };
        }
        first ??= err;
      }
    }
    if (!first) return "unknown-site";
    const failed = first as LoginFailed;
    const error = failed.message.slice(0, 300);
    const failCase = caseOf(failed, track);
    // a typed secret and no refusal said: the password may have worked and our flow misread what came next
    if ((track.password || track.code) && !failed.refused && known && failedIn === known) {
      const misread = fp.url();
      const shot = await shotOf(fp, opts.shots, name, now());
      if (await signedInAnyway(fp, known)) {
        opts.holds?.clear(name);
        log({
          ...viaOf(failedVia),
          outcome: "signed-in-anyway",
          case: failCase,
          error,
          url: misread,
          typed: typed(),
          ...stepsOf(steps),
        });
        await opts
          .notify?.(
            `${name}: flow bug after a good password: signed in, but the flow read ${misread} as a failure (${error})${shot ? `; shot ${shot}` : ""}`,
          )
          .catch(() => undefined);
        return "signed-in";
      }
    }
    const next = opts.holds
      ? nextHold(failCase, error, opts.holds.get(name), since.getTime(), opts.random)
      : null;
    if (next && opts.holds) {
      opts.holds.set(name, next);
      // a strict hold is a person's; a short one tries again on its own
      if (next.strict)
        await opts
          .notify?.(
            `${name}: sign-in failed (${failCase}), no more tries till ${new Date(next.until).toISOString()}: ${error}`,
          )
          .catch(() => undefined);
    }
    log({
      ...viaOf(failedVia),
      outcome: "failed",
      case: failCase,
      error,
      url: fp.url(),
      typed: typed(),
      ...stepsOf(steps),
      ...(next
        ? {
            hold: {
              until: new Date(next.until).toISOString(),
              strict: !!next.strict,
              fails: next.fails ?? 1,
            },
          }
        : {}),
    });
    // after the hold: the next try reads the heal screen fresh
    if (healAsk && opts.heal)
      void opts.heal(healAsk).catch((err) => console.warn(`${name}: heal failed: ${errText(err)}`));
    throw first;
  };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const viaOf = (via: string | undefined) => (via ? { method: via } : {});
const stepsOf = (steps: string[]) => (steps.length ? { screens: [...steps] } : {});

async function signInWith(name: string, login: SiteLogin, ctx: SignInContext): Promise<void> {
  const { fp } = ctx;
  if (login.reauth && (await fp.has(login.reauth.field))) {
    await fp.act({ kind: "fill", value: passwordOf(name, ctx.cred) }, login.reauth.field, {
      goal: "type the password again",
    });
    await fp.act({ kind: "click" }, login.reauth.submit, { goal: "confirm with the password" });
    for (let i = 0; i < 15; i++) {
      await fp.wait(1_000);
      if (!(await fp.has(login.reauth.field))) return;
    }
    throw new LoginFailed(name, "the password box stayed up");
  }
  const here = login.signInHere;
  if (here?.at.test(fp.url())) {
    await here.run(ctx);
    if (!(await fp.waitForUrl((u) => !here.at.test(u) || !!here.past?.test(u), 30_000)))
      throw new LoginFailed(name, `not signed in 30s after the form: ${await pageState(fp)}`);
    return;
  }
  await login.signIn(ctx);
  if (!(await login.loggedIn(fp)))
    throw new LoginFailed(name, "sign-in ran but the page is not signed in");
}

/** The account's address: its codes inbox when it signs in with a handle, else the username. */
export const addressOf = (cred: Pick<Credential, "username" | "codesInbox">): string =>
  cred.codesInbox ?? cred.username;

const isUser = (cred: Credential, account: string) =>
  sameUser(cred.username, account) || sameUser(addressOf(cred), account);

/**
 * The ways one account signs in, in the order tried: its own password
 * first, then the provider's button (as the account's address there).
 * A credential with one of them has one method.
 */
export function methodsOf(cred: Credential): Credential[] {
  if (!cred.password || !cred.via) return [cred];
  const { via: _v, ...own } = cred;
  const { password: _p, previousPassword: _pp, ...viaOnly } = cred;
  return [own, { ...viaOnly, username: addressOf(cred) }];
}

export type LoginProvider = ReturnType<typeof loginProvider>;
