/**
 * Runs eval tasks (U22) as the bench does (designs/2026-10-27-bench.md): one `autobrowse agent
 * --json` process per task, its own empty profile and recordings, a free port, a hard timeout.
 * Run data stays in the cache dir; a rerun skips tasks already scored.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunJson } from "../agent/run-json.js";
import type { Llm } from "../llm/types.js";
import { type EvalResult, type EvalTask, scoreRun } from "./suite.js";

export const EVAL_RUNS_DIR = join(homedir(), "Library", "Caches", "autobrowse", "evals");
const TASK_TIMEOUT_MS = 15 * 60_000;

export const resultsFile = (run: string) => join(EVAL_RUNS_DIR, run, "results.jsonl");

export function readResults(run: string): EvalResult[] {
  const f = resultsFile(run);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalResult);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? ok(a.port) : fail(new Error("no port"))));
    });
  });
}

export interface EvalRunOptions {
  provider: string;
  model: string;
  headed?: boolean;
  /** The judge, for rubric tasks. */
  judge: Llm | null;
  log?: (line: string) => void;
}

/** This CLI, as it was started (repo or package). */
const selfArgv = () => [...process.execArgv, process.argv[1] as string];

async function runAgent(task: EvalTask, work: string, o: EvalRunOptions): Promise<RunJson | null> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const out = join(work, "run.json");
  const argv = [
    ...selfArgv(),
    "agent",
    task.site,
    task.goal,
    "--url",
    task.url,
    "--json",
    out,
    "--no-sign-in",
    "--no-os",
    "--max-steps",
    String(task.maxSteps),
    "--port",
    String(await freePort()),
    "--save",
    `eval-${task.id}`,
    ...(o.headed ? ["--headed"] : []),
  ];
  const env = {
    ...process.env,
    LLM_PROVIDER: o.provider,
    LLM_MODEL: o.model,
    EYES_PROVIDER: o.provider,
    EYES_MODEL: o.model,
    // no cookie or account of ours near a task
    PROFILES_DIR: join(work, "profiles"),
    RECORDINGS_DIR: join(work, "recordings"),
    BROWSER_HEADLESS: o.headed ? "false" : "true",
  };
  const logFile = join(work, "agent.log");
  await new Promise<void>((done) => {
    const p = spawn(process.execPath, argv, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (b: Buffer) => appendFileSync(logFile, b);
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    const timer = setTimeout(() => {
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, TASK_TIMEOUT_MS);
    p.on("close", () => {
      clearTimeout(timer);
      done();
    });
  });
  rmSync(join(work, "profiles"), { recursive: true, force: true });
  try {
    return JSON.parse(readFileSync(out, "utf8")) as RunJson;
  } catch {
    return null;
  }
}

/** Runs each task not yet scored in `run`, scoring as it goes. */
export async function runEvals(
  run: string,
  tasks: readonly EvalTask[],
  o: EvalRunOptions,
): Promise<EvalResult[]> {
  const dir = join(EVAL_RUNS_DIR, run);
  mkdirSync(dir, { recursive: true });
  const done = new Set(readResults(run).map((r) => r.id));
  for (const task of tasks) {
    if (done.has(task.id)) continue;
    o.log?.(`${task.id} (${task.split}) …`);
    const result = await runAgent(task, join(dir, "work", task.id), o).then((r) =>
      scoreRun(task, r, o.judge),
    );
    appendFileSync(resultsFile(run), `${JSON.stringify(result)}\n`);
    o.log?.(`${task.id}: ${result.pass ? "pass" : "fail"} (${result.by}) ${result.why}`);
  }
  return readResults(run);
}
