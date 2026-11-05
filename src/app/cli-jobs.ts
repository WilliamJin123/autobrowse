/** `autobrowse job …`: start a handler, do other work, collect (designs/2026-11-05-async-leverage.md §2). */
import type { Command } from "commander";
import { expandHome } from "../google/auth.js";
import { ingress } from "./client.js";
import type { Settings } from "./config.js";
import { type JobState, jobs } from "./jobs.js";

const out = (v: unknown) => console.log(JSON.stringify(v));

export function registerJobCommands(program: Command, settings: Settings): void {
  const client = () =>
    jobs({
      door: ingress({
        url: settings.restateIngressUrl,
        authToken: settings.restateAuthToken ?? null,
        owner: settings.owner,
      }).job,
      ledger: expandHome(settings.jobsFile),
    });
  const job = program
    .command("job")
    .description("Start a worker handler now, collect its result later: a Restate send by key");

  job
    .command("start <service> <handler> [json]")
    .description(
      "Start it; prints {id} at once. The same call twice is one job unless --key differs",
    )
    .option("--key <key>", "idempotency key (default: a hash of service, handler and input)")
    .option("--by <id>", "who starts it (a session or agent id)")
    .option("--why <text>", "why, one line")
    .option("--delay <s>", "start it this many seconds from now")
    .action(async (service: string, handler: string, json: string | undefined, o) => {
      const input = json === undefined ? undefined : (JSON.parse(json) as unknown);
      const { delay, ...rest } = o as { delay?: string; key?: string; by?: string; why?: string };
      out(
        await client().start(service, handler, input, {
          ...rest,
          ...(delay ? { delayMs: Number(delay) * 1000 } : {}),
        }),
      );
      process.exit(0);
    });

  job
    .command("wait <ids...>")
    .description(
      "Attach; prints each result as it lands, {done:false} for one still running at the timeout",
    )
    .option("--timeout <s>", "seconds", "600")
    .action(async (ids: string[], o: { timeout: string }) => {
      const c = client();
      const ms = Number(o.timeout) * 1000;
      const states = await Promise.all(
        ids.map((id) =>
          c.wait(id, ms).then((s) => {
            out(s);
            return s;
          }),
        ),
      );
      process.exit(states.some((s: JobState) => s.done && !s.ok) ? 1 : 0);
    });

  job
    .command("peek <id>")
    .description("Done or not; never waits")
    .action(async (id: string) => out(await client().peek(id)));

  job
    .command("list")
    .description("The jobs started here, newest last")
    .option("--last <n>", "only the last n", "20")
    .action(async (o: { last: string }) => {
      for (const r of (await client().list()).slice(-Number(o.last))) out(r);
    });
}
