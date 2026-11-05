import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type JobsOptions, jobKey, jobs } from "../src/app/jobs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ledger = () => {
  const d = mkdtempSync(join(tmpdir(), "jobs-"));
  dirs.push(d);
  return join(d, "jobs.jsonl");
};
const door = (output: Awaited<ReturnType<JobsOptions["door"]["output"]>>): JobsOptions["door"] => ({
  send: async () => ({ invocationId: "inv_1", status: "Accepted", attachable: true }),
  result: () => new Promise(() => undefined),
  output: async () => output,
});

describe("jobs", () => {
  it("one key per call: same input, same key; other input, other key", () => {
    expect(jobKey("desk", "status", { site: "x" })).toBe(jobKey("desk", "status", { site: "x" }));
    expect(jobKey("desk", "status", { site: "x" })).not.toBe(
      jobKey("desk", "status", { site: "y" }),
    );
  });

  it("peek: 470 is still running, 200 the value, else the error", async () => {
    const at = (status: number, body: string) =>
      jobs({ door: door({ done: true, status, body }), ledger: ledger() }).peek("inv_1");
    expect(await jobs({ door: door({ done: false }), ledger: ledger() }).peek("inv_1")).toEqual({
      id: "inv_1",
      done: false,
    });
    expect(await at(200, '{"a":1}')).toEqual({
      id: "inv_1",
      done: true,
      ok: true,
      value: { a: 1 },
    });
    expect(await at(500, "boom")).toMatchObject({ done: true, ok: false, error: "HTTP 500: boom" });
  });

  it("list reads the ledger and skips a cut line", async () => {
    const file = ledger();
    const row = {
      id: "inv_1",
      service: "desk",
      handler: "status",
      key: "k",
      by: null,
      why: null,
      at: "t",
    };
    writeFileSync(file, `${JSON.stringify(row)}\n{"id":"inv_2","ser`);
    expect(await jobs({ door: door({ done: false }), ledger: file }).list()).toEqual([row]);
  });

  it("a repeat start is one ledger row; wait gives up at the timeout", async () => {
    const j = jobs({ door: door({ done: false }), ledger: ledger() });
    await j.start("desk", "status", { site: "x" }, { by: "s1" });
    const again = await j.start("desk", "status", { site: "x" });
    expect(again.key).toBe(jobKey("desk", "status", { site: "x" }));
    expect(await j.list()).toHaveLength(1);
    expect(await j.wait("inv_1", 10)).toEqual({ id: "inv_1", done: false });
  });
});
