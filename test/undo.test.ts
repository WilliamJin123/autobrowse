import { describe, expect, it } from "vitest";
import { render } from "../src/channels/render.js";
import { KEYS, type Results, runFlow, undoRun } from "../src/engine/run.js";
import { defineWorkflow } from "../src/engine/workflow.js";
import { fakeEffects, scriptedAnswers } from "./fakes.js";
import { type Deps, type Memo, plan, steps, workflow } from "./undo-demo.js";

const go = async (fail: Deps["fail"], answers: Parameters<typeof scriptedAnswers>[0] = {}) => {
  const { fx } = fakeEffects();
  const deps: Deps = { log: [], fail };
  const p = plan.parse({ text: "hi" });
  const out = await runFlow(fx, workflow, deps, p, scriptedAnswers(answers).answer);
  return { fx, deps, p, out };
};
const statuses = (r: Results) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v?.status]));

describe("undo steps", () => {
  it("a rejected run undoes its private steps, last first; a rerun makes them again", async () => {
    const { fx, deps, p, out } = await go({}, { send: [{ approved: false }] });
    expect(out.status).toBe("rejected");
    expect(deps.log).toEqual(["draft", "media", "drop media", "drop d1"]);
    expect(statuses(out.results)).toEqual({ draft: "undone", media: "undone", post: "rejected" });
    expect(out.results.pin).toBeUndefined();
    expect(out.memo).toEqual({ draft: null });
    // Undone already: a second pass has nothing left to undo.
    expect(await undoRun(fx, workflow, deps, p)).toEqual([]);
  });

  it("a done run keeps everything", async () => {
    const { deps, out } = await go({}, { send: [{ approved: true }] });
    expect(out.status).toBe("done");
    expect(deps.log).toEqual(["draft", "media", "post", "pin"]);
  });

  it("a failed private step leaves the run to resume; undoRun then clears what is done", async () => {
    const { fx, deps, p, out } = await go({ media: "error" });
    expect(out.status).toBe("failed");
    expect(deps.log).toEqual(["draft"]);
    const undone = await undoRun(fx, workflow, deps, p);
    expect(undone.map((u) => [u.step, u.result.status])).toEqual([["draft", "undone"]]);
    expect(deps.log).toEqual(["draft", "drop d1"]);
  });

  it("never undoes while the public act may have gone out", async () => {
    const failed = await go({ post: "error" }, { send: [{ approved: true }] });
    expect(failed.out.status).toBe("failed");
    expect(await undoRun(failed.fx, workflow, failed.deps, failed.p)).toEqual([]);

    const human = await go({ post: "human" }, { human: [{ approved: false }] });
    expect(human.out.status).toBe("rejected");
    expect(human.out.results.post).toMatchObject({ status: "rejected", gate: "human" });
    expect(human.deps.log).toEqual(["draft", "media"]);
  });

  it("keeps what a public act that went out uses", async () => {
    const { fx, deps, p, out } = await go({ pin: "error" }, { send: [{ approved: true }] });
    expect(out.status).toBe("failed");
    expect(await undoRun(fx, workflow, deps, p)).toEqual([]);
    expect(deps.log).toEqual(["draft", "media", "post"]);
  });

  it("a failed undo is recorded and told to a person; the others still run", async () => {
    const { fx, deps, out } = await go({ "undo-media": "error" }, { send: [{ approved: false }] });
    expect(statuses(out.results)).toMatchObject({ draft: "undone", media: "undo-failed" });
    expect(deps.log).toContain("drop d1");
    const media = (await fx.get<Results>(KEYS.results))?.media;
    expect(media?.detail).toContain("media API down");
    const said = render({
      type: "undone",
      run: { workflow: "undo-demo", key: "k" },
      at: "2026-11-02T00:00:00Z",
      step: "media",
      result: media as NonNullable<typeof media>,
    });
    expect(said?.subject).toBe("undo-demo/k: undo of media failed");
  });

  it("refuses an undo on an irreversible step", () => {
    expect(() =>
      defineWorkflow<Deps, Memo>()({
        ...workflow,
        steps: [{ ...steps[2], undo: async () => "deleted" } as (typeof steps)[number]],
      }),
    ).toThrow(/irreversible and has an undo/);
  });
});
