import { describe, expect, it } from "vitest";
import { SITE_LOGINS } from "../src/auth/sites.js";
import type { FlowRunner } from "../src/browser/flow.js";
import { memoryEffects } from "../src/engine/memory.js";
import { advance } from "../src/engine/run.js";
import {
  builtinWorkflow,
  LEG_WORKFLOWS,
  withLegs,
  workflowCatalog,
} from "../src/workflows/legs.js";
import { LOGIN_WORKFLOWS, loginFlow, loginName, loginWorkflow } from "../src/workflows/logins.js";
import { sitesTree, toolkitFor, toolsOf } from "../src/workflows/toolkit.js";

const runner = (answer: string, loggedIn = false) => {
  const seen: unknown[] = [];
  const typed: string[] = [];
  const answers: string[] = [];
  const browser = {
    run: async (flow: { name: string; site: string }, input: unknown) => {
      seen.push([flow.site, flow.name, input]);
      // the runner's own sign-in answers; the flow turns a miss into an error
      const fp = {
        signIn: async (site: string) => {
          typed.push(site);
          return answer;
        },
      } as never;
      const out = await loginFlow({ site: flow.site, loggedIn: async () => loggedIn }).run(
        fp,
        input as { account?: string },
      );
      answers.push(out);
      return out;
    },
  } as unknown as FlowRunner;
  return { browser, seen, typed, answers };
};
const spec = (site: string, via?: ("google" | "microsoft")[]) => ({
  site,
  loggedIn: async () => false,
  ...(via ? { via } : {}),
});

const run = async (w: ReturnType<typeof loginWorkflow>, browser: FlowRunner, plan: unknown) => {
  const parsed = w.plan.parse(plan);
  const fx = memoryEffects().fx;
  let a = await advance(fx, w, { browser }, parsed);
  while (a.kind === "continue") a = await advance(fx, w, { browser }, parsed);
  return a;
};

describe("a site's sign-in is a workflow", () => {
  it("every site login is in the catalog as <site>-login, and no leg has that name", () => {
    expect(LOGIN_WORKFLOWS.size).toBe(SITE_LOGINS.length);
    for (const l of SITE_LOGINS) {
      expect(LOGIN_WORKFLOWS.has(loginName(l.site))).toBe(true);
      expect(LEG_WORKFLOWS.has(loginName(l.site))).toBe(false);
    }
    expect(builtinWorkflow("perplexity-login")?.site).toBe("perplexity");
    const w = LOGIN_WORKFLOWS.get("perplexity-login");
    expect(w?.description).toMatch(/google button/);
    expect(w?.steps[0]).toMatchObject({ name: "sign-in", irreversible: true });
  });

  it("the step runs the runner's sign-in on the site; a second account passes through", async () => {
    const w = loginWorkflow(spec("perplexity", ["google"]));
    const { browser, seen, typed } = runner("signed-in");
    const a = await run(w, browser, {});
    expect(a).toMatchObject({ kind: "finished", status: "done" });
    expect(seen).toEqual([["perplexity", "login", {}]]);
    await run(w, browser, { account: "second" });
    expect(seen[1]).toEqual(["perplexity", "login", { account: "second" }]);
    expect(typed).toEqual(["perplexity", "perplexity"]);
  });

  it("a page already signed in types nothing", async () => {
    const w = loginWorkflow(spec("perplexity"));
    const { browser, typed, answers } = runner("signed-in", true);
    const a = await run(w, browser, {});
    expect(a).toMatchObject({ kind: "finished", status: "done" });
    expect(answers).toEqual(["already signed in"]);
    expect(typed).toEqual([]);
  });

  it("no credential, no sign-in: the run fails with the fix in its words", async () => {
    const w = loginWorkflow(spec("perplexity"));
    const none = await run(w, runner("no-credential").browser, {});
    expect(none).toMatchObject({ kind: "finished", status: "failed" });
    expect(JSON.stringify(none)).toMatch(/autobrowse creds set perplexity/);
    const signup = await run(w, runner("no-login").browser, {});
    expect(JSON.stringify(signup)).toMatch(/--signup/);
  });

  it("a dry run stops before the password is typed", async () => {
    const w = loginWorkflow(spec("perplexity"));
    const { browser, seen } = runner("signed-in");
    const a = await run(w, browser, { dryRun: true });
    expect(a.kind).toBe("finished");
    expect(seen).toEqual([]);
  });

  it("the toolkit on a site's host lists its login; a compiled workflow may shadow it", async () => {
    const tools = toolsOf(withLegs([]));
    const kit = toolkitFor("www.perplexity.ai", SITE_LOGINS, tools, 50);
    expect(kit?.tools.map((t) => t.name)).toContain("perplexity-login");
    // the tree counts the login beside the site's legs
    const legs = [...LEG_WORKFLOWS.values()].filter((w) => w.site === "perplexity").length;
    expect(sitesTree(tools).find((s) => s.site === "perplexity")?.tools).toBe(legs + 1);
    const shadow = { name: "perplexity-login" };
    expect(withLegs([shadow]).filter((w) => w.name === "perplexity-login")).toEqual([shadow]);
    const catalog = workflowCatalog({ get: async () => null } as never);
    expect((await catalog.get("perplexity-login"))?.name).toBe("perplexity-login");
    expect(await catalog.get("nowhere-login")).toBeNull();
  });
});
