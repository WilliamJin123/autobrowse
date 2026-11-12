/**
 * Sign-in as a tool (designs/2026-10-29-one-workflow-system.md §4): every site login
 * (`auth/sites.ts`) as a one-step workflow `<site>-login`, beside the legs. An explore session
 * signs in when the agent says so (`flow perplexity-login`): the runner's login hook types the
 * stored credential on the site's own hosts, audited, and nothing passes through `place`.
 * The sign-in itself is the site's `SiteLogin` spec; this only names it in the catalog.
 */
import { z } from "zod";
import type { SiteLogin } from "../auth/login.js";
import { pageSignedIn } from "../auth/page-login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { type BrowserFlow, defineFlow } from "../browser/flow.js";
import { done, type Workflow } from "../engine/workflow.js";
import type { LegDeps } from "./legs.js";

const PLAN = z.object({
  dryRun: z.boolean().default(false),
  /** A second account at the site (`<site>@<label>`'s address); the site's default credential otherwise. */
  account: z.string().optional(),
  /** `page-login` only: whose stored credential; explore gives its own site. */
  site: z.string().optional(),
});
type Plan = z.infer<typeof PLAN>;

export type LoginWorkflow = Workflow<Plan, LegDeps, Record<string, never>>;

export const loginName = (site: string) => `${site}-login`;

/** The leg: the runner's own sign-in, so the credential never meets the workflow's page wrapper. */
export function loginFlow(
  login: Pick<SiteLogin, "site" | "loggedIn">,
): BrowserFlow<{ account?: string }, string> {
  const { site } = login;
  return defineFlow({
    site,
    name: "login",
    async run(fp, input) {
      // Idempotent: a second run, or a session that signed in on `open`, types nothing.
      if (!input.account && (await login.loggedIn(fp).catch(() => false)))
        return "already signed in";
      const got = await fp.signIn(site, input.account);
      if (got === "signed-in") return "signed in";
      if (got === "no-login")
        throw new Error(
          `${site}: this session has no sign-in (it started with --signup); open explore on ${site} without it`,
        );
      if (got === "no-credential")
        throw new Error(
          `${site}: no stored credential${input.account ? ` for ${input.account}` : ""} (autobrowse creds set ${site})`,
        );
      throw new Error(`${site}: no known sign-in`);
    },
  });
}

export function loginWorkflow(login: Pick<SiteLogin, "site" | "via" | "loggedIn">): LoginWorkflow {
  const via = login.via?.length ? ` or its ${login.via.join("/")} button` : "";
  return {
    name: loginName(login.site),
    description: `Sign in to ${login.site} with the stored credential${via}; the runner types it, nothing is shown`,
    site: login.site,
    plan: PLAN,
    emptyMemo: () => ({}),
    steps: [
      {
        name: "sign-in",
        // Typing a password is the act: a dry run stops before it.
        irreversible: true,
        async run({ deps, plan }) {
          const input = plan.account ? { account: plan.account } : {};
          return done(await deps.browser.run(loginFlow(login), input));
        },
      },
    ],
  };
}

/** A site with a stored password and no `<site>-login`: its name and password boxes, found on the page (WA-1349). */
export const PAGE_LOGIN = "page-login";

export const pageLoginWorkflow: LoginWorkflow = {
  name: PAGE_LOGIN,
  description:
    "Sign in on this page with the site's stored credential, for a site with no <site>-login: finds the name and password boxes, types both, submits; nothing is shown",
  plan: PLAN,
  emptyMemo: () => ({}),
  steps: [
    {
      name: "sign-in",
      irreversible: true,
      async run({ deps, plan }) {
        if (!plan.site) throw new Error(`${PAGE_LOGIN}: plan.site names the stored credential`);
        const input = plan.account ? { account: plan.account } : {};
        return done(
          await deps.browser.run(loginFlow({ site: plan.site, loggedIn: pageSignedIn }), input),
        );
      },
    },
  ],
};

/** Every site login as a workflow, by name, and the page's own. */
export const LOGIN_WORKFLOWS: ReadonlyMap<string, LoginWorkflow> = new Map([
  ...SITE_LOGINS.map((l) => [loginName(l.site), loginWorkflow(l)] as const),
  [PAGE_LOGIN, pageLoginWorkflow] as const,
]);
