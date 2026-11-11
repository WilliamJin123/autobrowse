import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunJson } from "../src/agent/run-json.js";
import { readTasks, reportLines, scoreRun, summarize } from "../src/evals/suite.js";
import { fakeLlm } from "../src/llm/fake.js";

const run = (summary: string | null, steps = 2): RunJson => ({
  goal: "g",
  achieved: summary !== null,
  summary,
  steps: Array.from({ length: steps }, (_, i) => ({
    n: i + 1,
    thought: null,
    cmd: "read",
    error: null,
    url: "https://x",
    ms: 1,
    line: `Step ${i + 1}`,
  })),
  shots: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  ms: 100,
});

describe("evals (U22)", () => {
  it("reads the committed tasks: both splits, every task checkable", () => {
    const tasks = readTasks();
    expect(tasks.filter((t) => t.split === "train").length).toBeGreaterThan(0);
    expect(tasks.filter((t) => t.split === "test").length).toBeGreaterThan(0);
  });

  it("refuses a task with neither a pattern nor a rubric, and a duplicate id", () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    const t = { id: "a", split: "train", site: "x", url: "https://x.test/", goal: "g" };
    writeFileSync(join(dir, "bad.jsonl"), JSON.stringify(t));
    expect(() => readTasks(join(dir, "bad.jsonl"))).toThrow(/expect or rubric/);
    const ok = JSON.stringify({ ...t, expect: ["x"] });
    writeFileSync(join(dir, "dup.jsonl"), `${ok}\n${ok}`);
    expect(() => readTasks(join(dir, "dup.jsonl"))).toThrow(/duplicate/);
  });

  const pick = (f: (t: ReturnType<typeof readTasks>[number]) => boolean) => {
    const t = readTasks().find(f);
    if (!t) throw new Error("no such task");
    return t;
  };
  const task = pick((t) => t.id === "quotes-first-author");
  const judged = pick((t) => Boolean(t.rubric));

  it("scores by the answer, not by what a read saw", async () => {
    expect((await scoreRun(task, run("It was Albert Einstein."), null)).pass).toBe(true);
    const r = await scoreRun(task, run("I could not tell"), null);
    expect(r).toMatchObject({ pass: false, by: "pattern" });
    expect(await scoreRun(task, null, null)).toMatchObject({ pass: false, by: "no-run" });
  });

  it("asks the judge for a rubric task", async () => {
    const llm = fakeLlm([JSON.stringify({ pass: true, why: "names a title" })]);
    const r = await scoreRun(judged, run("Show HN: a thing"), llm);
    expect(r).toMatchObject({ pass: true, by: "judge", why: "names a title" });
  });

  it("reports regressions against the baseline and flags a train-only gain", () => {
    const base = summarize(
      [
        {
          id: "a",
          split: "train",
          pass: false,
          by: "pattern",
          why: "",
          achieved: null,
          steps: 0,
          ms: 0,
          tokens: 0,
        },
        {
          id: "b",
          split: "test",
          pass: true,
          by: "pattern",
          why: "",
          achieved: null,
          steps: 0,
          ms: 0,
          tokens: 0,
        },
      ],
      "m",
      "t0",
    );
    const now = summarize(
      [
        {
          id: "a",
          split: "train",
          pass: true,
          by: "pattern",
          why: "",
          achieved: null,
          steps: 0,
          ms: 0,
          tokens: 0,
        },
        {
          id: "b",
          split: "test",
          pass: false,
          by: "pattern",
          why: "",
          achieved: null,
          steps: 0,
          ms: 0,
          tokens: 0,
        },
      ],
      "m",
      "t1",
    );
    const lines = reportLines(now, base).join("\n");
    expect(lines).toMatch(/fixed {5}a/);
    expect(lines).toMatch(/regressed b/);
    expect(lines).toMatch(/fit the train tasks only/);
    expect(reportLines(now, null).join("\n")).toMatch(/no baseline yet/);
  });
});
