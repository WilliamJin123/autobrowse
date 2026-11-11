/**
 * `autobrowse do "<goal>"`: the one verb from the terminal. A goal is routed
 * to the site route, workflow or flow that does it and run; with nothing
 * ready, the agent explores and what it achieved is compiled for next time.
 */
import type { Command } from "commander";
import { type AbilityKind, fieldLine } from "../do/catalog.js";
import { listAbilities } from "../do/list.js";
import type { LocalBackend } from "./backend.js";

export function registerDoCommands(program: Command, local: LocalBackend): void {
  program
    .command("do <goal>")
    .description(
      'One verb: "upload this to youtube", "list my linkedin posts". Routes to what does it, or the agent builds it',
    )
    .option("--input <k=v...>", "named values the goal may use (file=…, title=…)")
    .option("--site <site>", "the site profile to work in (found from the goal when absent)")
    .option("--url <url>", "where the agent starts when it explores")
    .option("--dry-run", "say what would run, run nothing")
    .action(
      async (
        goal: string,
        o: { input?: string[]; site?: string; url?: string; dryRun?: boolean },
      ) => {
        const { backend } = local();
        const out = await backend.do.do({
          goal,
          inputs: Object.fromEntries(
            (o.input ?? []).map((kv) => {
              const i = kv.indexOf("=");
              return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
            }),
          ),
          site: o.site ?? null,
          url: o.url ?? null,
          dryRun: o.dryRun ?? false,
        });
        console.log(
          `${out.status} via ${out.via}${out.name ? ` ${out.name}` : ""}: ${out.summary}`,
        );
        if (Object.keys(out.input).length) console.log(`input ${JSON.stringify(out.input)}`);
        if (out.output !== null && out.output !== undefined)
          console.log(
            typeof out.output === "string" ? out.output : JSON.stringify(out.output, null, 2),
          );
        if (out.session) console.log(`session ${out.session}`);
        // Nobody resumes a CLI run: a paused session would hold the process open forever.
        if (out.status === "needs-human" && out.session) {
          await backend.agent?.close(out.session).catch(() => undefined);
          console.log(
            "closed, journal kept: drive it headed from a chat (the browser subagent), or rerun with --site <a site with a login>",
          );
        }
        if (out.status === "failed" || out.status === "needs-human") process.exitCode = 1;
      },
    );
  program
    .command("list [query...]")
    .alias("abilities")
    .description(
      "Everything this worker can do (site routes, workflows, flows, tools), found by words; each with the command that uses it",
    )
    .option("--kind <kind>", "site | workflow | flow | tool")
    .option("--site <site>", "one site's only")
    .option("--limit <n>", "a page's size", (v) => Number.parseInt(v, 10))
    .option("--offset <n>", "skip this many", (v) => Number.parseInt(v, 10))
    .option("--json", "the page as JSON, with `next` for the following page")
    .action(
      async (
        words: string[],
        o: { kind?: AbilityKind; site?: string; limit?: number; offset?: number; json?: boolean },
      ) => {
        const page = listAbilities(await local().backend.abilities(), {
          query: words.join(" "),
          ...(o.kind ? { kind: o.kind } : {}),
          ...(o.site ? { site: o.site } : {}),
          ...(o.limit ? { limit: o.limit } : {}),
          ...(o.offset ? { offset: o.offset } : {}),
        });
        if (o.json) return console.log(JSON.stringify(page));
        for (const a of page.items)
          console.log(
            `${a.kind.padEnd(8)} ${a.name.padEnd(48)} ${a.ready ? "ready" : `not ready: ${a.missing}`}${a.irreversible ? "  !" : ""}\n         ${a.summary}${a.inputs.length ? `\n         ${a.inputs.map(fieldLine).join(", ")}` : ""}\n         ${a.use}`,
          );
        console.log(
          `\n${page.offset + 1}-${page.offset + page.items.length} of ${page.total}${page.next ? `; next: ${page.next.replace(/ --json$/, "")}` : ""}`,
        );
      },
    );
}
