/**
 * The agent's own evals (OpenCLI audit U22): fixed tasks on stable public pages, each run as
 * `autobrowse agent --json` in its own empty profile, scored by an answer pattern or a judge.
 * `train` tasks are what prompts get tuned on; `test` tasks stay held out, so a gain that only
 * shows on train is overfit. A run is compared with the committed `evals/baseline.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunJson } from "../agent/run-json.js";
import { completeJson, type Llm } from "../llm/types.js";

export const EVALS_DIR = join(import.meta.dirname, "..", "..", "evals");
export const TASKS_FILE = join(EVALS_DIR, "tasks.jsonl");
export const BASELINE_FILE = join(EVALS_DIR, "baseline.json");

export const EvalTask = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    split: z.enum(["train", "test"]),
    site: z.string(),
    url: z.string().url(),
    goal: z.string(),
    /** Regexes (case-insensitive); any one in the answer passes. */
    expect: z.array(z.string()).optional(),
    /** For an answer no pattern can pin: the judge reads the run against it. */
    rubric: z.string().optional(),
    maxSteps: z.number().int().positive().default(15),
  })
  .refine((t) => t.expect?.length || t.rubric, "a task needs expect or rubric");
export type EvalTask = z.infer<typeof EvalTask>;

export function readTasks(file = TASKS_FILE): EvalTask[] {
  const tasks = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = EvalTask.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`${file}:${i + 1}: ${r.error.issues[0]?.message}`);
      return r.data;
    });
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate eval id ${t.id}`);
    ids.add(t.id);
  }
  return tasks;
}

export interface EvalResult {
  id: string;
  split: EvalTask["split"];
  pass: boolean;
  /** `pattern`, `judge`, or `no-run` when the agent left no run file. */
  by: "pattern" | "judge" | "no-run";
  why: string;
  /** The agent's own verdict. */
  achieved: boolean | null;
  steps: number;
  ms: number;
  tokens: number;
}

export function byPattern(task: EvalTask, run: RunJson): { pass: boolean; why: string } {
  // The summary first: a match only in a read is the page, not the answer.
  const said = run.summary ?? "";
  const hit = task.expect?.find((p) => new RegExp(p, "i").test(said));
  return hit
    ? { pass: true, why: `answer matches /${hit}/` }
    : {
        pass: false,
        why: `answer "${said.slice(0, 160)}" matches none of ${task.expect?.join(", ")}`,
      };
}

const Verdict = z.object({ pass: z.boolean(), why: z.string() });

export async function byJudge(
  llm: Llm,
  task: EvalTask,
  run: RunJson,
): Promise<{ pass: boolean; why: string; tokens: number }> {
  const steps = run.steps
    .map((s) => s.line)
    .join("\n")
    .slice(-12_000);
  const { value, usage } = await completeJson(llm, Verdict, {
    system:
      'You grade one browser agent run. Pass only if the final answer meets the rubric and the steps support it. A claim the steps do not show fails. Reply as JSON: {"pass": boolean, "why": one sentence}.',
    prompt: `Task: ${task.goal}\nRubric: ${task.rubric}\n\nFinal answer: ${run.summary ?? "(none)"}\nAgent's verdict: ${run.achieved}\n\nSteps:\n${steps}`,
  });
  return { ...value, tokens: usage.inputTokens + usage.outputTokens };
}

export async function scoreRun(
  task: EvalTask,
  run: RunJson | null,
  llm: Llm | null,
): Promise<EvalResult> {
  const base = { id: task.id, split: task.split };
  if (!run)
    return {
      ...base,
      pass: false,
      by: "no-run",
      why: "no run file",
      achieved: null,
      steps: 0,
      ms: 0,
      tokens: 0,
    };
  const own = {
    achieved: run.achieved,
    steps: run.steps.length,
    ms: run.ms,
    tokens: run.usage.inputTokens + run.usage.outputTokens,
  };
  if (task.expect?.length) return { ...base, ...own, by: "pattern", ...byPattern(task, run) };
  if (!llm) return { ...base, ...own, pass: false, by: "judge", why: "no model for the judge" };
  const v = await byJudge(llm, task, run);
  return { ...base, ...own, by: "judge", pass: v.pass, why: v.why, tokens: own.tokens + v.tokens };
}

export interface EvalSummary {
  at: string;
  /** The agent's model, as the run used it. */
  model: string;
  split: Record<EvalTask["split"], { n: number; pass: number }>;
  /** Id → pass, for a task-by-task diff. */
  tasks: Record<string, boolean>;
}

export function summarize(results: readonly EvalResult[], model: string, at: string): EvalSummary {
  const split: EvalSummary["split"] = { train: { n: 0, pass: 0 }, test: { n: 0, pass: 0 } };
  const tasks: Record<string, boolean> = {};
  for (const r of results) {
    split[r.split].n++;
    if (r.pass) split[r.split].pass++;
    tasks[r.id] = r.pass;
  }
  return { at, model, split, tasks };
}

export function readBaseline(file = BASELINE_FILE): EvalSummary | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as EvalSummary) : null;
}

const pct = (s: { n: number; pass: number }) =>
  s.n ? `${s.pass}/${s.n} (${Math.round((100 * s.pass) / s.n)}%)` : "0/0";

/** Lines for a person: score per split, then each task that moved against the baseline. */
export function reportLines(now: EvalSummary, base: EvalSummary | null): string[] {
  const lines = (["train", "test"] as const).map((k) => {
    const was = base ? `  (baseline ${pct(base.split[k])})` : "";
    return `${k.padEnd(5)} ${pct(now.split[k])}${was}`;
  });
  if (!base) return [...lines, "no baseline yet: `autobrowse evals baseline <run>`"];
  for (const [id, pass] of Object.entries(now.tasks)) {
    const was = base.tasks[id];
    if (was === undefined) lines.push(`  new       ${id}: ${pass ? "pass" : "fail"}`);
    else if (was && !pass) lines.push(`  regressed ${id}`);
    else if (!was && pass) lines.push(`  fixed     ${id}`);
  }
  const trainGain = now.split.train.pass - base.split.train.pass;
  const testGain = now.split.test.pass - base.split.test.pass;
  if (trainGain > 0 && testGain <= 0)
    lines.push("train went up and test did not: the change may fit the train tasks only");
  return lines;
}
