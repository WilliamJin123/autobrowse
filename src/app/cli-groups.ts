/**
 * Shared top-level groups: several register files add to one (`mfa`, `stats`, `history`), so
 * the first caller makes it and the rest find it.
 */
import type { Command } from "commander";

const ABOUT: Record<string, string> = {
  "cli-login": "Sign a CLI in from the browser: aws, gcloud, wrangler",
  cloudflare: "Cloudflare API tokens",
  mfa: "Second factors: passkeys, authenticator seeds, recovery codes",
  workspace: "Google Workspace: inboxes and the logo",
  inbox: "A Workspace sending inbox: make it, name, picture, free accounts",
  google: "A Google account's own settings",
  warmup: "Instantly warmup settings",
  history: "Past runs: explore runs, watched flows, repairs, screens, walks",
  stats: "Spend and rates: tokens, agent steps, success, evals",
};

/** The subcommand `name` of `parent`, made on first use. */
export function group(parent: Command, name: string): Command {
  return (
    parent.commands.find((c) => c.name() === name) ??
    parent.command(name).description(ABOUT[name] ?? name)
  );
}
