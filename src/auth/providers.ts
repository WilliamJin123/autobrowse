/**
 * Identity providers behind "Continue with …" buttons. One entry per
 * provider: how its button reads on any site, where its own pages live,
 * and how to sign in there with the stored credential of that name. A
 * site signs in through a provider when its credential says `via`; no
 * per-site code is needed for that, only the provider entry here.
 */
import type { Hints } from "../browser/locate.js";
import type { WalkSpecInput } from "../walks/spec.js";
import type { SignInContext } from "./login.js";

export const PROVIDERS = ["google", "github", "microsoft"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface IdentityProvider {
  site: Provider;
  /** The provider's own sign-in and consent pages. */
  host: RegExp;
  /** How its button reads on a site's login page, most specific first. */
  buttons: readonly Hints[];
  /** Sign in on the provider's page (popup or redirect); consent pages included. */
  signIn(ctx: SignInContext): Promise<void>;
}

/** The registry is filled by login.ts (its sign-ins live there); importing both never cycles at load. */
const registry = new Map<Provider, IdentityProvider>();

export function registerProvider(p: IdentityProvider): void {
  registry.set(p.site, p);
}

export function providerOf(name: Provider): IdentityProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`no identity provider named ${name}`);
  return p;
}

export function isProvider(name: string): name is Provider {
  return (PROVIDERS as readonly string[]).includes(name);
}

/**
 * A provider's sign-in as its repo walk, run in place on whatever page its button
 * opened, so the app's return URL survives. Imported lazily: the walk runner
 * imports the site logins, which register the providers.
 */
export function walkInPlace(
  site: Provider,
  load: () => Promise<{ default: WalkSpecInput }>,
): (ctx: SignInContext) => Promise<void> {
  return async (ctx) => {
    const [{ walkLogin }, { walkSpecSchema }, { default: file }] = await Promise.all([
      import("../walks/login.js"),
      import("../walks/spec.js"),
      load(),
    ]);
    const here = walkLogin(walkSpecSchema.parse(file)).signInHere;
    if (!here) throw new Error(`the ${site} walk has no signInHere`);
    const page = ctx.fp.page;
    try {
      await here.run(ctx);
    } catch (err) {
      // a popup closes once the provider hands back: that is the end, not a failure
      if (page.isClosed()) return;
      throw err;
    }
  };
}
