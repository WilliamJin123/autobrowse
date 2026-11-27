/**
 * A sign-in walk as a site's `SiteLogin` (designs/2026-10-23-cut-runs.md).
 * `walks cut` builds the walk `login` from the sign-in acts of a run; this
 * runs it with the site's credential and second factors, so a sign-in a run
 * did once needs no hand-written `signIn`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodeKind } from "../auth/codes.js";
import {
  LoginFailed,
  passwordOf,
  type SignInContext,
  SignInHeld,
  type SiteLogin,
} from "../auth/login.js";
import { failSignIn, signInState } from "../auth/sign-in-kit.js";
import { ACCOUNT_CHORES, WALK_APPS, type WalkApp } from "../auth/sites.js";
import { NeedsHuman } from "../browser/session.js";
import { onScreen, walkFlow } from "./flow.js";
import { logHealTries, withHeal } from "./login-heal.js";
import { LOGIN_WALK_FILES } from "./logins/index.js";
import { loadWalk, regexOf, type WalkSpec, type WalkSpecInput, walkSpecSchema } from "./spec.js";

/** Second factors in the order a sign-in tries them, when the site does not say. */
const CODES: readonly CodeKind[] = ["totp", "sms", "email"];

export function walkLogin(
  spec: WalkSpec,
  o: {
    /** The site it signs in to; default: the walk's. */
    site?: string;
    /** The stored credential; default: the site. */
    credential?: string;
    /** The code the page sends (a text for a Duo passcode); default: the first one the credential can get. */
    code?: CodeKind;
    /** Domains the password may be typed on beside home's (an SSO host). */
    origins?: readonly string[];
    /** The state dir's walks: heal screens (`login-heal.json`) join each try, read fresh. */
    healDir?: string;
  } = {},
): SiteLogin {
  if (!spec.start)
    throw new Error(
      `${spec.site}/walk-${spec.name}: a sign-in walk needs a start (the page it lands on)`,
    );
  const goal = spec.screens.find((s) => s.goal);
  // The credential its secrets name (`outlook@uw.password`), when not given.
  const named = spec.secrets.map((x) => x.key).find((k) => /\.(username|password)$/.test(k));
  const credential = o.credential ?? named?.slice(0, named.lastIndexOf("."));
  const totp = spec.screens.some((s) =>
    s.ops.some((op) => op.kind === "one-time-code" && op.kinds.includes("totp")),
  );
  const origins = o.origins ?? spec.origins;
  const via = [
    ...new Set(
      spec.screens.flatMap((s) =>
        s.ops.flatMap((op) => (op.kind === "provider" ? [op.provider] : [])),
      ),
    ),
  ];
  // the sign-in surface: a pattern, or `{at, past}` with a page there past the sign-in
  const here =
    spec.signInHere === undefined
      ? null
      : typeof spec.signInHere === "string"
        ? { at: spec.signInHere, past: undefined }
        : spec.signInHere;
  return {
    site: o.site ?? spec.site,
    home: spec.home ?? spec.start,
    // setup's prompt
    ask:
      spec.ask ??
      `Your ${spec.site} login (username, password${totp ? ", authenticator key if set" : ""})`,
    ...(via.length ? { via } : {}),
    ...(credential ? { credential } : {}),
    ...(origins ? { origins } : {}),
    ...(o.healDir ? { heal: { spec, dir: o.healDir } } : {}),
    // Signed in: the page the sign-in landed on, by every check its goal names.
    loggedIn: async (fp) => !!goal && (await onScreen(fp, goal)),
    signIn: (ctx) => signIn(ctx, false),
    ...(spec.properties ? { properties: spec.properties } : {}),
    ...(here
      ? {
          signInHere: {
            at: regexOf(here.at),
            run: (ctx) => signIn(ctx, true),
            ...(here.past ? { past: regexOf(here.past) } : {}),
          },
        }
      : {}),
  };

  /** One try; `here`: on the site's sign-in page already, so no open. */
  async function signIn(ctx: SignInContext, here: boolean): Promise<void> {
    const site = o.site ?? spec.site;
    const state = signInState(site);
    const healed = o.healDir ? withHeal(spec, o.healDir) : null;
    for (const w of healed?.warnings ?? []) console.warn(`${spec.site}/login: ${w}`);
    const healedSpec = healed?.spec ?? spec;
    const walk = here ? { ...healedSpec, start: null } : healedSpec;
    const steps = ctx.steps ?? [];
    const c = ctx.steps ? ctx : { ...ctx, steps };
    // trial screens this try went through: a pass keeps them, its own failure drops them
    const tried = (outcome: "passed" | "failed") => {
      const went = (healed?.trial ?? []).filter((n) => steps.includes(n));
      if (o.healDir) logHealTries(o.healDir, spec.site, went, outcome);
    };
    let asked = new Date();
    const kind = o.code ?? CODES.find((k) => ctx.offers(k));
    // `<cred>.username` and `.password` from the credential; any other secret is the code the page sent.
    const run = () =>
      walkFlow(walk, {
        secrets: async (key) => {
          const field = key.slice(key.lastIndexOf(".") + 1);
          if (field === "username") return ctx.cred.username;
          // held as a secret: the host guard, the audit row and the hold rule see it
          if (field === "password")
            return ctx.cred.password ? passwordOf(spec.site, ctx.cred) : null;
          if (!kind) return null;
          const code = await ctx.code(kind, undefined, asked);
          // A retry (a wrong-code screen sends a new one) waits for a text after this one.
          asked = new Date();
          return code;
        },
        signIn: { ctx: c, state },
        fail: (why) => failSignIn(state, why),
      }).run(ctx.fp, {});
    // A walk with a code op takes the inbox lock per code; an old one holds it the whole walk.
    const codeOp = walk.screens.some((s) => s.ops.some((op) => op.kind === "one-time-code"));
    try {
      await (kind && ctx.serial && !codeOp ? ctx.serial(kind, run) : run());
    } catch (err) {
      // A person's step and a hold stay what they are; any other break is a failed try.
      if (err instanceof NeedsHuman || err instanceof SignInHeld) throw err;
      const failed =
        err instanceof LoginFailed
          ? err
          : new LoginFailed(site, err instanceof Error ? err.message : String(err), false);
      // the site refusing the secret is no fault of a screen
      if (!failed.refused) tried("failed");
      throw failed;
    }
    tried("passed");
  }
}

/**
 * The repo's sign-in walks (`src/walks/logins/`), as `SiteLogin`s. A file the
 * schema refuses throws: it is repo code, and its test catches it first.
 */
export function repoWalkLogins(
  files: readonly WalkSpecInput[] = LOGIN_WALK_FILES,
  walksDir?: string,
): SiteLogin[] {
  return files.flatMap((file) => {
    const spec = walkSpecSchema.parse(file);
    if (spec.name !== "login")
      throw new Error(`${spec.site}/walk-${spec.name}: a repo sign-in walk is named login`);
    const heal = walksDir ? { healDir: walksDir } : {};
    const chores = ACCOUNT_CHORES[spec.site];
    // an app on the walk's credential: the provider's products stay the provider's
    const apps = (WALK_APPS[spec.site] ?? []).map((app): SiteLogin => {
      const { properties: _, ...login } = walkLogin(appSpec(file, app), {
        ...heal,
        site: app.site,
        credential: app.credential ?? spec.site,
      });
      return { ...login, ask: app.ask, ...chores };
    });
    return [{ ...walkLogin(spec, heal), ...chores }, ...apps];
  });
}

/** The walk as one app signs in with it: the app's pages, its refusals, its signed-in page as the goal. */
function appSpec(file: WalkSpecInput, app: WalkApp): WalkSpec {
  if (!app.signedIn && !app.screens && !app.start && !app.home) return walkSpecSchema.parse(file);
  const screens = app.signedIn ? file.screens.filter((s) => !s.goal) : file.screens;
  return walkSpecSchema.parse({
    ...file,
    ...(app.start ? { start: app.start } : {}),
    ...(app.home ? { home: app.home } : {}),
    screens: [...(app.signedIn ? [app.signedIn] : []), ...(app.screens ?? []), ...screens],
  });
}

/**
 * Every site's `login` walk in the owner's walks, as its `SiteLogin`. Added
 * after the built-in and data logins, so a hand login wins: a walk replaces
 * one only after it passes the same screens (a wrong code: `again` in the cut).
 */
export function walkLogins(walksDir: string): SiteLogin[] {
  if (!existsSync(walksDir)) return [];
  return readdirSync(walksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(walksDir, d.name, "login.json")))
    .flatMap((d) => {
      try {
        return walkLoginAt(walksDir, d.name, { healDir: walksDir }) ?? [];
      } catch {
        // A walk file the schema refuses: no login, as with no file.
        return [];
      }
    });
}

/** The site's `login` walk as its `SiteLogin`, when `walks cut` built one; else null. */
export function walkLoginAt(
  walksDir: string,
  site: string,
  o: Parameters<typeof walkLogin>[1] = {},
): SiteLogin | null {
  const spec = loadWalk(walksDir, site, "login");
  return spec?.start ? walkLogin(spec, o) : null;
}
