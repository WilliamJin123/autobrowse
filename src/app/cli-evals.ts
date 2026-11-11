/** `autobrowse evals run|report|baseline` (OpenCLI audit U22): the agent's own evals. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { EVAL_RUNS_DIR, readResults, runEvals } from "../evals/run.js";
import {
  BASELINE_FILE,
  type EvalSummary,
  readBaseline,
  readTasks,
  reportLines,
  summarize,
} from "../evals/suite.js";
import type { Settings } from "./config.js";
import { llmFor } from "./services-browser.js";

/** The model `evals run` wrote into the run's summary. */
const modelOf = (run: string): string => {
  try {
    return (
      JSON.parse(readFileSync(join(EVAL_RUNS_DIR, run, "summary.json"), "utf8")) as EvalSummary
    ).model;
  } catch {
    return "unknown";
  }
};

export function registerEvalsCommands(program: Command, settings: Settings): void {
  const evals = program
    .command("evals")
    .description(
      "The agent's evals: fixed tasks on public pages, train and test, against a baseline",
    );

  evals
    .command("run <run>")
    .description(`Run the tasks not yet scored in <run> (data in ${EVAL_RUNS_DIR}/<run>)`)
    .option("--split <split>", "train, test or all", "all")
    .option("--only <ids>", "comma-separated task ids")
    .option("--provider <p>", "the agent's model provider", "claude-code")
    .option("--model <m>", "the agent's model", "sonnet")
    .option("--headed", "show the browser")
    .action(
      async (
        run: string,
        o: { split: string; only?: string; provider: string; model: string; headed?: boolean },
      ) => {
        const only = o.only?.split(",");
        const tasks = readTasks().filter(
          (t) => (o.split === "all" || t.split === o.split) && (!only || only.includes(t.id)),
        );
        const results = await runEvals(run, tasks, {
          provider: o.provider,
          model: o.model,
          judge: llmFor(settings),
          log: (l) => console.error(l),
          ...(o.headed ? { headed: true } : {}),
        });
        const now = summarize(results, `${o.provider}/${o.model}`, new Date().toISOString());
        writeFileSync(
          join(EVAL_RUNS_DIR, run, "summary.json"),
          `${JSON.stringify(now, null, 2)}\n`,
        );
        for (const l of reportLines(now, readBaseline())) console.log(l);
      },
    );

  evals
    .command("report <run>")
    .description("Score per split, and each task that moved against the baseline")
    .option("--json", "as JSON")
    .action((run: string, o: { json?: boolean }) => {
      const results = readResults(run);
      if (!results.length) throw new Error(`no results in ${run}`);
      const now = summarize(results, modelOf(run), new Date().toISOString());
      if (o.json) {
        console.log(JSON.stringify({ summary: now, baseline: readBaseline(), results }));
        return;
      }
      for (const r of results)
        console.log(`${r.pass ? "pass" : "FAIL"} ${r.split.padEnd(5)} ${r.id}: ${r.why}`);
      for (const l of reportLines(now, readBaseline())) console.log(l);
    });

  evals
    .command("baseline <run>")
    .description("Make <run>'s score the baseline (evals/baseline.json; commit it)")
    .action((run: string) => {
      const results = readResults(run);
      if (!results.length) throw new Error(`no results in ${run}`);
      const s = summarize(results, modelOf(run), new Date().toISOString());
      writeFileSync(BASELINE_FILE, `${JSON.stringify(s, null, 2)}\n`);
      console.log(
        `baseline: train ${s.split.train.pass}/${s.split.train.n}, test ${s.split.test.pass}/${s.split.test.n}`,
      );
    });
}
