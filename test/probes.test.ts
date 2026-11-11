import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  latestProbes,
  probeDue,
  probeLines,
  readProbes,
  recordProbes,
  siteProbeRow,
  workflowProbeRow,
} from "../src/runs/probes.js";
import { SiteError } from "../src/sites/types.js";

describe("probe ledger (U17)", () => {
  const dir = mkdtempSync(join(tmpdir(), "probes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("types site checks by their error code", () => {
    const at = "2026-11-10T00:00:00.000Z";
    expect(siteProbeRow({ site: "a", ok: true, ms: 5 }, at).state).toBe("ready");
    expect(siteProbeRow({ site: "b", ok: false, why: "no probe" }, at).state).toBe("unchecked");
    expect(siteProbeRow({ site: "c", ok: false, code: "unauthorized", why: "401" }, at).state).toBe(
      "needs_login",
    );
    expect(siteProbeRow({ site: "d", ok: false, code: "rate_limited", why: "429" }, at).state).toBe(
      "cooldown",
    );
    expect(siteProbeRow({ site: "e", ok: false, why: "no token kept" }, at).state).toBe(
      "needs_login",
    );
    expect(
      siteProbeRow({ site: "f", ok: false, code: "upstream_error", why: "500" }, at).state,
    ).toBe("broken");
  });

  it("types proofs: off its fixture, failed, thrown", () => {
    const p = {
      at: "2026-11-10T00:00:00.000Z",
      status: "done",
      steps: [{ name: "read", status: "done", detail: "{}" }],
      output: { rows: "[]" },
      expect: { ok: false, failed: ["rows: empty"] },
    };
    expect(workflowProbeRow("w", p, 9)).toMatchObject({ state: "off_fixture", why: "rows: empty" });
    expect(workflowProbeRow("w", { ...p, status: "failed", expect: undefined }, 9)).toMatchObject({
      state: "broken",
      why: "failed at read: {}",
    });
    const thrown = workflowProbeRow("w", new SiteError(401, "token refused"), 9);
    expect(thrown.kind).toBe("workflow");
    expect(thrown.state).not.toBe("ready");
  });

  it("keeps rows by month, newest per name first when broken, due weekly", () => {
    const now = Date.parse("2026-11-10T12:00:00.000Z");
    expect(probeDue(dir, now)).toBe(true);
    recordProbes(dir, [
      { at: "2026-10-30T00:00:00.000Z", kind: "site", name: "x", state: "ready" },
      { at: "2026-11-09T00:00:00.000Z", kind: "site", name: "x", state: "needs_login", why: "401" },
      { at: "2026-11-09T00:00:00.000Z", kind: "workflow", name: "hn-search", state: "ready" },
    ]);
    expect(probeDue(dir, now)).toBe(false);
    expect(probeDue(dir, now + 7 * 86_400_000)).toBe(true);
    const latest = latestProbes(readProbes(dir, "2026-10-01T00:00:00.000Z"));
    expect(latest.map((r) => [r.name, r.state, r.lastReady])).toEqual([
      ["x", "needs_login", "2026-10-30T00:00:00.000Z"],
      ["hn-search", "ready", "2026-11-09T00:00:00.000Z"],
    ]);
    expect(probeLines(latest)[0]).toBe("probes: 1 needs_login, 1 ready");
    expect(readProbes(dir, "2026-11-01T00:00:00.000Z")).toHaveLength(2);
  });
});
