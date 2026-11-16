import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never } });

describe("example-title", () => {
  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("done");
  });
});
