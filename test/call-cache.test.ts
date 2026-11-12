import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type LegTaken, withLeg } from "../src/browser/attempt.js";
import { defineFlow } from "../src/browser/flow.js";
import { HttpError } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { appendBody, closedHour, readBodies } from "../src/runs/call-bodies.js";
import { bodiesDirOf, fileSiteCalls } from "../src/runs/calls.js";
import { breakers } from "../src/sites/breaker.js";
import { callCache, callKey, replay } from "../src/sites/call-cache.js";
import { type SiteApi, type SiteRoute, siteFacade } from "../src/sites/index.js";
import { fakeBrowser } from "./fakes.js";

describe("callCache", () => {
  it("keeps an answer for its ttl, then reads again", async () => {
    let t = 1; // lru-cache reads start 0 as unset
    const c = callCache({ now: () => t });
    let n = 0;
    await c.run("k", 1000, async () => ++n);
    expect(c.get("k")).toEqual({ ok: true, value: 1 });
    t = 1002;
    expect(c.get("k")).toBeUndefined();
  });

  it("keeps a lasting refusal, not an outage", async () => {
    const c = callCache();
    await c.run("dead", 1000, async () => {
      throw new HttpError("GET", "https://x.test/p", 400);
    });
    await c.run("down", 1000, async () => {
      throw new HttpError("GET", "https://x.test/p", 503);
    });
    expect(c.get("dead")?.ok).toBe(false);
    expect(c.get("down")).toBeUndefined();
  });

  it("shares a call in flight and drops the oldest past its size", async () => {
    const c = callCache({ max: 2 });
    let n = 0;
    const p = c.run("a", 1000, async () => ++n);
    expect(c.flying("a")).toBeDefined();
    await p;
    await c.run("b", 1000, async () => 2);
    await c.run("c", 1000, async () => 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.size()).toBe(2);
  });

  it("clears one account's keys", async () => {
    const c = callCache();
    await c.run(callKey("x", "me", "GET /a", {}), 1000, async () => 1);
    await c.run(callKey("x", "you", "GET /a", {}), 1000, async () => 1);
    c.clear("x|me|");
    expect(c.size()).toBe(1);
  });

  it("a hit hands out a copy", async () => {
    const c = callCache();
    const k = await c.run("k", 1000, async () => ({ rows: [1] }));
    (replay(k) as { rows: number[] }).rows.push(2);
    expect(replay(c.get("k") as never)).toEqual({ rows: [1] });
  });

  it("keys ignore field order", () => {
    expect(callKey("s", null, "GET /a", { b: 1, a: { d: 1, c: 2 } })).toBe(
      callKey("s", null, "GET /a", { a: { c: 2, d: 1 }, b: 1 }),
    );
  });
});

describe("breakers", () => {
  it("opens after faults in a row, lets one probe through, doubles on a failed probe", () => {
    let t = 0;
    const b = breakers({ now: () => t, after: 3, firstMs: 1000, maxMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      expect(b.blocked("k")).toBeNull();
      b.fault("k", "503");
    }
    expect(b.blocked("k")).toBe(1000);
    t = 1000;
    expect(b.blocked("k")).toBeNull(); // the probe
    expect(b.blocked("k")).toBe(5000); // others wait on it
    b.fault("k", "503");
    expect(b.blocked("k")).toBe(2000);
    t = 3000;
    expect(b.blocked("k")).toBeNull();
    b.ok("k");
    expect(b.blocked("k")).toBeNull();
    expect(b.states()).toEqual([]);
  });

  it("an answer resets the count; a trip holds till its time", () => {
    let t = 0;
    const b = breakers({ now: () => t, after: 2 });
    b.fault("k", "503");
    b.ok("k");
    b.fault("k", "503");
    expect(b.blocked("k")).toBeNull();
    b.trip("q", 50_000, "429");
    t = 49_999;
    expect(b.blocked("q")).toBe(1);
  });
});

describe("call bodies", () => {
  it("keeps input and answer, masks secrets, reads back by day", () => {
    const dir = mkdtempSync(join(tmpdir(), "bodies-"));
    const at = "2026-11-12T05:10:00.000Z";
    const base = { service: "desk", site: "meta", route: "GET /me/accounts", caller: "t" };
    appendBody(dir, {
      ...base,
      at,
      account: "a@x",
      ok: true,
      input: { q: 1 },
      answer: { data: [{ id: "1", access_token: "EAAsecret" }] },
    });
    appendBody(dir, { ...base, at, account: "a@x", ok: false, input: {}, error: "HTTP 400" });
    const got = readBodies(dir, "2026-11-12");
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ input: { q: 1 }, answer: { data: [{ id: "1" }] } });
    expect(JSON.stringify(got)).not.toContain("EAAsecret");
    expect(got[1]).toMatchObject({ ok: false, error: "HTTP 400" });
  });

  it("the calls ledger row carries its body's id", () => {
    const dir = mkdtempSync(join(tmpdir(), "calls-"));
    const at = new Date().toISOString();
    fileSiteCalls(dir).record(
      {
        at,
        service: "desk",
        site: "x",
        route: "GET /a",
        caller: null,
        invocation: null,
        attempt: 1,
        ok: true,
        status: null,
        terminal: false,
        error: null,
        ms: 1,
      },
      { account: null, input: { a: 1 }, answer: { b: 2 } },
    );
    const row = JSON.parse(
      readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string), "utf8"),
    );
    const [body] = readBodies(bodiesDirOf(dir), at.slice(0, 10));
    expect(row.body).toBe(body?.id);
    expect(body).toMatchObject({ input: { a: 1 }, answer: { b: 2 } });
  });

  it("an hour ships once it has ended", () => {
    const now = Date.parse("2026-11-12T06:00:00Z");
    expect(closedHour("2026-11-12/05.jsonl.gz", now)).toBe(true);
    expect(closedHour("2026-11-12/06.jsonl.gz", now)).toBe(false);
    expect(closedHour("2026-11-12/notes.txt", now)).toBe(false);
  });
});

describe("facade: kept reads and API breakers", () => {
  const read = defineFlow<{ id: string }, { from: string }>({
    site: "demo",
    name: "read",
    async run() {
      return { from: "browser" };
    },
  });

  function facade(o: { fail?: () => unknown; withBrowser?: boolean } = {}) {
    let n = 0;
    const api = async (q: { id: string }) => {
      n++;
      const f = o.fail?.();
      if (f) throw f;
      return { id: q.id, n };
    };
    const item = z.object({ id: z.string() });
    const routes = [
      {
        method: "GET",
        path: "/items/{id}",
        summary: "an item",
        request: item,
        api,
        ...(o.withBrowser ? { browser: { flow: "demo/read" } } : {}),
      },
      { method: "GET", path: "/live/{id}", summary: "never kept", request: item, ttl: 0, api },
      {
        method: "POST",
        path: "/items",
        summary: "make one",
        request: z.object({}),
        api: async () => ({ made: true }),
      },
    ] as unknown as SiteRoute<never, unknown>[];
    const demo = {
      site: "demo",
      origin: "https://demo.test",
      auth: { token: "DEMO_TOKEN" },
      routes,
      setup: [],
    } as unknown as SiteApi;
    const browser = fakeBrowser([]);
    browser.on(read, async () => ({ from: "browser" }));
    const sites = siteFacade([demo], {
      http: { json: async () => ({ ok: true, status: 200, body: {} }) } as never,
      env: (k) => (k === "DEMO_TOKEN" ? "t" : undefined),
      sink: memorySink(),
      runner: browser,
      flow: (name) => (name === "demo/read" ? (read as never) : null),
      cache: callCache(),
    });
    return { sites, calls: () => n };
  }

  it("the same GET answers from memory, marked as the cache leg", async () => {
    const { sites, calls } = facade();
    await sites.call("demo", "GET", "/items/1", {});
    const leg: LegTaken = {};
    const again = await withLeg(leg, () => sites.call("demo", "GET", "/items/1", {}));
    expect(again).toEqual({ id: "1", n: 1 });
    expect(calls()).toBe(1);
    expect(leg.via).toBe("cache");
    await sites.call("demo", "GET", "/items/2", {});
    expect(calls()).toBe(2);
  });

  it("fresh, verify and ttl 0 read the site; a write clears the account's reads", async () => {
    const { sites, calls } = facade();
    await sites.call("demo", "GET", "/items/1", {});
    await sites.call("demo", "GET", "/items/1", {}, null, { fresh: true });
    await sites.call("demo", "GET", "/items/1", {}, null, { verify: true });
    expect(calls()).toBe(3);
    await sites.call("demo", "GET", "/live/1", {});
    await sites.call("demo", "GET", "/live/1", {});
    expect(calls()).toBe(5);
    await sites.call("demo", "POST", "/items", {});
    await sites.call("demo", "GET", "/items/1", {});
    expect(calls()).toBe(6);
  });

  it("upstream faults in a row open the API leg: fail fast, then a GET with a browser leg reads there", async () => {
    const down = () => new HttpError("GET", "https://demo.test/items", 503);
    const plain = facade({ fail: down });
    for (let i = 0; i < 5; i++)
      await plain.sites.call("demo", "GET", `/items/${i}`, {}).catch(() => null);
    expect(plain.calls()).toBe(5);
    await expect(plain.sites.call("demo", "GET", "/items/9", {})).rejects.toMatchObject({
      status: 503,
    });
    expect(plain.calls()).toBe(5);
    expect(plain.sites.breakers?.()[0]).toMatchObject({ open: true, fails: 5 });

    const both = facade({ fail: down, withBrowser: true });
    for (let i = 0; i < 5; i++)
      await both.sites.call("demo", "GET", `/items/${i}`, {}).catch(() => null);
    expect(await both.sites.call("demo", "GET", "/items/9", {})).toEqual({ from: "browser" });
    expect(both.calls()).toBe(5);
  });
});
