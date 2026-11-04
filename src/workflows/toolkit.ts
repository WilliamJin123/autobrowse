/**
 * The toolkit (designs/2026-10-29-one-workflow-system.md §1): every workflow an agent can run,
 * by site. A page's host picks the site's tools; search and the tree find the rest.
 */
import { hostNamed, registrable } from "../auth/guard.js";
import { resolveLogin, type SiteLogin } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { inputsOf } from "../engine/inputs.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Findable } from "./find.js";
import { withLegs } from "./legs.js";

export interface Tool {
  name: string;
  site: string | null;
  aim: string;
  /** `q, max = 20, account?`: as code reads it (`signature`). */
  inputs: string;
  /** The plan's top-level fields; `account` on any site's tool (every workflow takes one). */
  fields: ToolField[];
  steps: string[];
  irreversible: boolean;
  hosts: readonly string[];
}

/** At most this many tools in an answer; the rest are a count. */
export const TOOLKIT_MAX = 20;

const RECORDED = /^Recorded \d{4}-\d\d-\d\d on /;

export interface ToolField {
  name: string;
  required: boolean;
  default?: unknown;
}

const VALUE_MAX = 40;

/**
 * Inputs as code shows them: `q, max = 20, account = "google@wren"`. `given` (a saved plan, the
 * profile's account) over the schema's defaults; required bare, optional with none `?`.
 */
export function signature(
  fields: readonly ToolField[],
  given: Record<string, unknown> = {},
): string {
  return fields
    .map((f) => {
      const v = f.name in given && given[f.name] !== undefined ? given[f.name] : f.default;
      if (v === undefined) return f.required ? f.name : `${f.name}?`;
      const shown = JSON.stringify(v) ?? String(v);
      return `${f.name} = ${shown.length > VALUE_MAX ? `${shown.slice(0, VALUE_MAX - 1)}…` : shown}`;
    })
    .join(", ");
}

export function toolOf(w: AnyWorkflow): Tool {
  const steps = w.steps.map((s) => s.name);
  let fields: ToolField[] = [];
  try {
    fields = inputsOf(w.plan)
      // top-level fields only: `workflows <name>` has the nested rows
      .filter((f) => !/[.[]/.test(f.name))
      .map((f) => ({
        name: f.name,
        required: f.required,
        ...(f.default !== undefined ? { default: f.default } : {}),
      }));
  } catch {
    // a plan JSON Schema can't hold (a RegExp field): the tree's detail still has the steps
  }
  // a site that signs in: plan.account picks whose profile its legs run in
  if (w.site && resolveLogin(SITE_LOGINS, w.site) && !fields.some((f) => f.name === "account"))
    fields.push({ name: "account", required: false });
  return {
    name: w.name,
    site: w.site ?? null,
    // A recording's description is its date; the step names say what it does.
    aim: RECORDED.test(w.description) ? steps.join(" → ") : w.description,
    inputs: signature(fields),
    fields,
    steps,
    irreversible: w.steps.some((s) => Boolean(s.irreversible)),
    hosts: w.hosts ?? [],
  };
}

/** The catalog's workflows, then every leg no workflow shadows by name. */
export function toolsOf(workflows: readonly AnyWorkflow[]): Tool[] {
  return withLegs(workflows).map((w) => toolOf(w as AnyWorkflow));
}

/**
 * The sites a host belongs to. A login's `home` host or registrable domain (its `origins`, its
 * `properties`: youtube.com → google); a workflow's own hosts; a site named by the domain
 * (`loom.com` → loom). Exact home host first.
 */
export function sitesOfHost(
  host: string,
  logins: readonly Pick<SiteLogin, "site" | "home" | "origins" | "properties">[],
  tools: readonly Tool[],
): string[] {
  const h = host.toLowerCase();
  if (!h) return [];
  const reg = registrable(h);
  const hostOf = (u: string) => (URL.canParse(u) ? new URL(u).host : "");
  const exact: string[] = [];
  const near: string[] = [];
  for (const l of logins) {
    const home = hostOf(l.home);
    if (home === h) exact.push(l.site);
    else if (
      (home && registrable(home) === reg) ||
      [...(l.origins ?? []), ...(l.properties ?? [])].some((o) => registrable(o) === reg)
    )
      near.push(l.site);
  }
  for (const t of tools) {
    if (!t.site) continue;
    if (t.hosts.includes(h)) exact.push(t.site);
    else if (t.hosts.some((x) => registrable(x) === reg) || hostNamed(h, t.site)) near.push(t.site);
  }
  return [...new Set([...exact, ...near])];
}

export interface Toolkit {
  sites: string[];
  tools: Pick<Tool, "name" | "aim" | "inputs">[];
  /** Tools past the cap: `{"cmd":"tools","site":…}` lists them. */
  more: number;
}

/** The tools for a page's host, the first site's first; null when no site matches. */
export function toolkitFor(
  host: string,
  logins: readonly Pick<SiteLogin, "site" | "home" | "origins">[],
  tools: readonly Tool[],
  max = TOOLKIT_MAX,
): Toolkit | null {
  const sites = sitesOfHost(host, logins, tools);
  const rank = (t: Tool) => sites.indexOf(t.site ?? "");
  const mine = tools
    .filter((t) => rank(t) >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!mine.length) return null;
  return {
    sites: sites.filter((s) => mine.some((t) => t.site === s)),
    tools: mine.slice(0, max).map(({ name, aim, inputs }) => ({ name, aim, inputs })),
    more: Math.max(0, mine.length - max),
  };
}

/** One stored account a `<site>-login` can sign in as; `account` is what `plan.account` takes. */
export interface LoginAccount {
  account: string;
  user: string;
  roles: readonly string[];
  /** The account this browser profile is for: another one puts its cookies in this profile. */
  profile?: true;
}

/**
 * The accounts a login lists to an agent, this profile's own marked. `session` is the
 * explore profile: `gmail` owns `google`, `youtube@wren` owns `google@wren`, bare `youtube` none.
 */
export function loginAccounts(
  session: string,
  platform: string,
  logins: readonly SiteLogin[],
  rows: readonly { name: string; username: string; roles: readonly string[] }[],
): LoginAccount[] {
  const cred = resolveLogin(logins, session)?.credential ?? null;
  const at = session.indexOf("@");
  const own =
    cred && cred.split("@")[0] === platform
      ? cred
      : resolveLogin(logins, session)?.site.split("@")[0] === platform
        ? session
        : at >= 0
          ? `${platform}${session.slice(at)}`
          : null;
  return rows.map((r) => ({
    account: r.name,
    user: r.username,
    roles: r.roles,
    ...(r.name === own ? { profile: true as const } : {}),
  }));
}

/** A tool as search reads it. */
export const findable = (t: Tool): Tool & Findable => ({
  ...t,
  words: `${t.fields.map((f) => f.name).join(" ")} ${t.steps.join(" ")}`,
});

/** The tree's root: each site and how many tools it has; multi-site workflows under `(any)`. */
export function sitesTree(tools: readonly Tool[]): { site: string; tools: number }[] {
  const n = new Map<string, number>();
  for (const t of tools) n.set(t.site ?? "(any)", (n.get(t.site ?? "(any)") ?? 0) + 1);
  return [...n]
    .map(([site, c]) => ({ site, tools: c }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export { type Findable, find } from "./find.js";
