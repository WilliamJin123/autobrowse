import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { baseDomain, sessionOf, sessionStatuses } from "../src/auth/session-status.js";
import type { SiteCallRow } from "../src/runs/calls.js";
import { lastCalls, routeState, siteHeldS } from "../src/sites/route-state.js";

const call = (o: Partial<SiteCallRow>): SiteCallRow => ({
  at: "2026-11-10T00:00:00.000Z",
  service: "desk",
  site: "x",
  route: "GET /2/users/123",
  caller: null,
  invocation: null,
  attempt: 1,
  ok: true,
  status: null,
  terminal: false,
  error: null,
  ms: 5,
  template: "/2/users/{id}",
  ...o,
});

describe("route state (U18)", () => {
  const r = { method: "GET" as const, path: "/2/users/{id}" };
  const none = { refused: false, heldS: 0 };

  it("reads the leg, the token, the hold, then the newest call", () => {
    expect(routeState({ ...r, missing: "no token for x" }, none).state).toBe("needs_login");
    expect(routeState({ ...r, missing: "waiting on app review" }, none).state).toBe("needs_person");
    expect(routeState({ ...r, missing: "workflow x-me not recorded" }, none).state).toBe("broken");
    expect(routeState(r, { ...none, refused: true }).state).toBe("needs_login");
    expect(routeState(r, { ...none, heldS: 600 })).toEqual({
      state: "cooldown",
      why: "held 10 min",
    });
    expect(routeState(r, none).state).toBe("unchecked");
    expect(routeState(r, { ...none, last: call({}) }).state).toBe("ready");
    expect(routeState(r, { ...none, last: call({ ok: false, status: 404 }) }).state).toBe("ready");
    expect(
      routeState(r, { ...none, last: call({ ok: false, status: 401, error: "no" }) }).state,
    ).toBe("needs_login");
    expect(routeState(r, { ...none, last: call({ ok: false, status: 429 }) }).state).toBe(
      "cooldown",
    );
    expect(
      routeState(r, { ...none, last: call({ ok: false, status: 500, error: "boom" }) }),
    ).toEqual({
      state: "broken",
      checkedAt: "2026-11-10T00:00:00.000Z",
      why: "boom",
    });
  });

  it("keeps the newest call per route, skips imports; counts only account holds", () => {
    const m = lastCalls(
      [
        call({ ok: false, status: 500 }),
        call({ at: "2026-11-10T01:00:00.000Z" }),
        call({ at: "2026-11-11T00:00:00.000Z", from: "caps", ok: false }),
        call({ site: "y" }),
      ],
      "x",
    );
    expect([...m.keys()]).toEqual(["GET /2/users/{id}"]);
    expect(m.get("GET /2/users/{id}")?.ok).toBe(true);
    const now = 1_000_000;
    expect(
      siteHeldS({ "x|a|*": { until: now + 60_000 }, "x|a|dm": { until: now + 600_000 } }, "x", now),
    ).toBe(60);
    expect(siteHeldS({ "xy|a|*": { until: now + 60_000 } }, "x", now)).toBe(0);
  });
});

describe("session status (U18)", () => {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Chrome time: µs since 1601.
  const chrome = (ms: number) => BigInt(ms + 11_644_473_600_000) * 1000n;
  const now = Date.parse("2026-11-10T00:00:00.000Z");

  it("names the base domain", () => {
    expect(baseDomain("www.linkedin.com")).toBe("linkedin.com");
    expect(baseDomain(".bbc.co.uk")).toBe("bbc.co.uk");
  });

  it("reads a profile's cookie DB without a browser", () => {
    const make = (profile: string, rows: Array<[string, string, bigint]>) => {
      mkdirSync(join(dir, profile, "Default"), { recursive: true });
      const db = new DatabaseSync(join(dir, profile, "Default", "Cookies"));
      db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER)");
      const ins = db.prepare("INSERT INTO cookies VALUES (?, ?, ?)");
      for (const r of rows) ins.run(...r);
      db.close();
    };
    make("github", [
      [".github.com", "logged_in", chrome(now + 1e9)],
      ["github.com", "user_session", chrome(now + 1e9)],
    ]);
    make("github@old", [
      [".github.com", "logged_in", chrome(now + 1e9)],
      ["github.com", "user_session", chrome(now - 1)],
    ]);
    make("acme", [["app.acme.io", "auth_sess", 0n]]);
    const homes: Record<string, string> = {
      github: "https://github.com/",
      acme: "https://app.acme.io/",
    };
    const rows = sessionStatuses(dir, (s) => homes[s], { now });
    expect(rows.map((r) => [r.profile, r.state])).toEqual([
      ["acme", "maybe"],
      ["github", "signed_in"],
      ["github@old", "signed_out"],
    ]);
    expect(rows[1]?.expires).toBe(new Date(now + 1e9).toISOString());
    expect(sessionOf([], ["x"]).state).toBe("no_cookies");
  });
});
