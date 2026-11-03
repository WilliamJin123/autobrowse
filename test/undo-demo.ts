import { z } from "zod";
import { NeedsHuman } from "../src/browser/session.js";
import { Unrecoverable } from "../src/engine/effects.js";
import { defineWorkflow, done, type StepDef } from "../src/engine/workflow.js";

/** A post in three steps: a draft and its media are private until `post`. */
export interface Deps {
  log: string[];
  fail: Partial<Record<"media" | "post" | "undo-media", "error" | "human">>;
}
export interface Memo {
  draft: string | null;
}
export const plan = z.object({ dryRun: z.boolean().default(false), text: z.string() });
export type Plan = z.infer<typeof plan>;

export const steps: StepDef<Plan, Deps, Memo, "draft" | "media" | "post">[] = [
  {
    name: "draft",
    async run({ fx, deps, memo }) {
      memo.draft ??= await fx.run("draft", async () => {
        deps.log.push("draft");
        return "d1";
      });
      return done(memo.draft);
    },
    async undo({ fx, deps, memo }) {
      await fx.run("drop draft", async () => void deps.log.push(`drop ${memo.draft}`));
      memo.draft = null;
      return "draft dropped";
    },
  },
  {
    name: "media",
    async run({ fx, deps }) {
      await fx.run("media", async () => {
        if (deps.fail.media === "error") throw new Unrecoverable("upload refused");
        deps.log.push("media");
      });
      return done("m1");
    },
    async undo({ fx, deps }) {
      await fx.run("drop media", async () => {
        if (deps.fail["undo-media"]) throw new Unrecoverable("media API down");
        deps.log.push("drop media");
      });
      return "media dropped";
    },
  },
  {
    name: "post",
    irreversible: true,
    async run({ fx, deps, gate }) {
      if (deps.fail.post === "human") throw new NeedsHuman("captcha after submit");
      const a = gate("send", "post it?");
      if (!a.approved) return done("not sent");
      await fx.run("post", async () => {
        if (deps.fail.post === "error") throw new Unrecoverable("socket closed after submit");
        deps.log.push("post");
      });
      return done("posted");
    },
  },
];
export const workflow = defineWorkflow<Deps, Memo>()({
  name: "undo-demo",
  description: "posts with a draft",
  plan,
  steps,
  emptyMemo: () => ({ draft: null }),
});
