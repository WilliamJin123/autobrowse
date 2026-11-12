import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { type Hints, locate } from "../src/browser/locate.js";
import {
  ineligible,
  nextCalls,
  OFF_MS,
  type SeenCall,
  sameCall,
  traceLegs,
  type WalkCalls,
} from "../src/walks/calls.js";
import { walkFlow } from "../src/walks/flow.js";
import { type WalkSpec, walkSpecSchema } from "../src/walks/spec.js";

/** The shop's search: a button that fetches JSON with a CSRF header off a cookie, then draws rows. */
const SHOP = `<html><body><h1>Shop</h1>
<input aria-label="Search" id="q"><button>Search</button><p id="count"></p><ul id="res"></ul>
<script>
const search = async (t) => {
  const q = document.querySelector("#q").value;
  const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)[1];
  const h = { "x-requested-with": "XMLHttpRequest", "csrf-token": csrf, "x-restli-protocol-version": "2.0.0" };
  if (window.SIGN) h["x-sig"] = String(Math.random());
  const j = await (await fetch("/api/search?q=" + encodeURIComponent(q) + "&v=1" + (t ? "&t=" + t : ""), { headers: h })).json();
  const items = j.data ? j.data.items.map((i) => ({ t: i.title, u: i.url })) : j.results.map((i) => ({ t: i.name, u: i.href }));
  document.querySelector("#count").textContent = j.data ? j.data.summary : j.summary;
  document.querySelector("#res").innerHTML = items.map((i) => '<li><b>' + i.t + '</b> <a href="' + i.u + '">open</a></li>').join("");
  document.body.insertAdjacentHTML("beforeend", "<h2>Results</h2>");
};
document.querySelector("button").onclick = () => search();
// The results page searches as it loads, with a cache buster.
if (location.pathname === "/s") {
  document.querySelector("#q").value = new URLSearchParams(location.search).get("q");
  search(Date.now());
}
</script></body></html>`;

const CATALOG = ["Trail Boot", "Road Shoe", "Track Spike", "Hiking Boot"];

interface Shop {
  base: string;
  shape: "v1" | "v2";
  sign: boolean;
  limit: boolean;
  /** Each API call's query. */
  asked: string[];
}

function shopServer(shop: Shop): Server {
  return createServer((req, res) => {
    const u = new URL(req.url ?? "/", shop.base);
    if (u.pathname === "/" || u.pathname === "/s") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": 'JSESSIONID="ajax:5550001234"; Path=/',
      });
      res.end(SHOP.replace("<script>", `<script>window.SIGN=${shop.sign};`));
      return;
    }
    if (u.pathname === "/api/search") {
      const q = u.searchParams.get("q") ?? "";
      shop.asked.push(q);
      if (shop.limit) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.headers["csrf-token"] !== "ajax:5550001234") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"error":"csrf"}');
        return;
      }
      const words = q.toLowerCase().split(" ");
      const hits = CATALOG.map((t, i) => ({ id: 100 + i, t })).filter((x) =>
        words.some((w) => x.t.toLowerCase().includes(w.replace(/s$/, ""))),
      );
      const summary = `${hits.length} results for ${q}`;
      const body =
        shop.shape === "v1"
          ? {
              data: {
                summary,
                items: hits.map((h) => ({ id: h.id, title: h.t, url: `/item/${h.id}` })),
              },
            }
          : {
              summary,
              results: hits.map((h) => ({ uid: h.id, name: h.t, href: `/item/${h.id}` })),
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

class Human extends Error {}

/** A FlowPage over a real page; every act is logged. */
function flowPage(page: Page, acts: string[]): FlowPage {
  return {
    page,
    url: () => page.url(),
    open: async (url: string) => {
      await page.goto(url);
    },
    wait: async (ms: number) => {
      await page.waitForTimeout(Math.min(ms, 50));
    },
    text: () => page.innerText("body"),
    has: (h: Hints, ms = 0) =>
      locate(page, h)
        .first()
        .waitFor({ timeout: ms || 1 })
        .then(
          () => true,
          () => false,
        ),
    read: (h: Hints) => locate(page, h).first().innerText(),
    async act(op: { kind: string; value?: string }, h: Hints, o: { goal: string }) {
      acts.push(o.goal);
      const l = locate(page, h).first();
      if (op.kind === "fill") await l.fill(op.value ?? "");
      else await l.click();
    },
    human(reason: string): never {
      throw new Human(reason);
    },
  } as unknown as FlowPage;
}

const walkOf = (base: string, o: { irreversible?: boolean; onLoad?: boolean } = {}): WalkSpec => {
  const spec = walkSpecSchema.parse({
    version: 2,
    site: "shop",
    name: "search",
    goal: "products for a query",
    built: "2026-11-12T12:00:00.000Z",
    from: [],
    start: `${base}/`,
    fields: [{ key: "q", label: "query", example: null }],
    secrets: [],
    irreversible: false,
    screens: [
      {
        name: "search",
        looks: "the shop",
        url: null,
        landmarks: [],
        once: true,
        seen: 1,
        ops: [
          {
            kind: "fill",
            goal: "type the query",
            hints: { role: "textbox", name: "Search" },
            value: { from: "plan", field: "q" },
          },
          {
            kind: "click",
            goal: "search",
            hints: { role: "button", name: "Search" },
            irreversible: o.irreversible ?? false,
          },
        ],
      },
      {
        name: "results",
        looks: "the results",
        url: null,
        landmarks: [],
        after: ["search"],
        once: true,
        seen: 1,
        ops: [
          { kind: "see", goal: "results shown", hints: { css: "#res li" }, ms: 5_000 },
          {
            kind: "read",
            goal: "how many",
            hints: { css: "#count" },
            as: "count",
            match: "(\\d+) results",
          },
          {
            kind: "records",
            goal: "the products",
            as: "products",
            fields: [
              { key: "title", says: "its name" },
              { key: "link", says: "its page" },
            ],
            key: "link",
            code: `return [...root.querySelectorAll("#res li")].map((li) => ({ title: li.querySelector("b").textContent, link: li.querySelector("a").href }));`,
            min: 1,
            sample: [],
          },
        ],
      },
      {
        name: "done",
        looks: "results read",
        url: null,
        landmarks: [],
        ops: [],
        goal: true,
        after: ["results"],
        seen: 1,
      },
    ],
  });
  if (!o.onLoad) return spec;
  // The results page itself: no search screen.
  spec.start = `${base}/s?q={q}`;
  spec.screens = spec.screens.filter((x) => x.name !== "search");
  for (const x of spec.screens) if (x.after) x.after = x.after.filter((a) => a !== "search");
  return spec;
};

/** Legs kept in memory, as the side file keeps them. */
const memoryCalls = () => {
  const store = {
    now: null as WalkCalls | null,
    saved: [] as (WalkCalls | null)[],
    load: () => store.now,
    save: (c: WalkCalls | null) => {
      store.now = c;
      store.saved.push(c);
    },
  };
  return store;
};
type Calls = ReturnType<typeof memoryCalls>;

describe("walk request tier", () => {
  let browser: Browser;
  let server: Server;
  const shop: Shop = { base: "", shape: "v1", sign: false, limit: false, asked: [] };
  beforeAll(async () => {
    browser = await chromium.launch();
    server = shopServer(shop);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    shop.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser.close();
    await new Promise((r) => server.close(r));
  });

  const run = async (spec: WalkSpec, q: string, calls: Calls = memoryCalls()) => {
    const page = await browser.newPage();
    const acts: string[] = [];
    try {
      const out = await walkFlow(spec, { calls }).run(flowPage(page, acts), { q });
      return { out, acts };
    } finally {
      await page.close();
    }
  };

  it("learns on a UI run, then answers the next run with one call and no acts", async () => {
    Object.assign(shop, { shape: "v1", sign: false, limit: false, asked: [] });
    const spec = walkOf(shop.base);
    const calls = memoryCalls();
    const first = await run(spec, "running shoes", calls);
    expect(first.out.via).toBe("ui");
    expect(first.out.learned).toBe("2 leg(s)");
    expect(first.acts).toEqual(["type the query", "search"]);
    const legs = calls.saved[0]?.legs ?? [];
    // The search ran after a click: the run sends it again.
    expect(legs.map((l) => [l.as, l.kind, l.way, l.path])).toEqual([
      ["count", "read", "cookie", "data.summary"],
      ["products", "records", "cookie", "data.items"],
    ]);
    expect(legs[1]?.url).toBe(`${shop.base}/api/search?q={{q}}&v=1`);
    expect(legs[1]?.headers).toMatchObject({
      "csrf-token": "{{cookie:JSESSIONID}}",
      "x-restli-protocol-version": "2.0.0",
    });
    expect(legs[1]?.fields).toEqual({
      title: { path: "title" },
      link: { path: "url", abs: true },
    });

    shop.asked = [];
    const second = await run(spec, "trail boots", calls);
    expect(second.out.via).toBe("cookie");
    expect(second.acts).toEqual([]);
    // Two outputs of one call: sent once.
    expect(shop.asked).toEqual(["trail boots"]);
    expect(second.out.read.count).toBe("2");
    expect(second.out.records.products).toEqual([
      { title: "Trail Boot", link: `${shop.base}/item/100` },
      { title: "Hiking Boot", link: `${shop.base}/item/103` },
    ]);
    expect(second.out.goal).toBe("done");
  });

  it("a changed answer falls to the UI, which learns the new shape", async () => {
    Object.assign(shop, { shape: "v1", sign: false, limit: false, asked: [] });
    const spec = walkOf(shop.base);
    const calls = memoryCalls();
    await run(spec, "running shoes", calls);
    shop.shape = "v2";
    const out = (await run(spec, "trail boots", calls)).out;
    expect(out.via).toBe("ui");
    expect(out.fell?.[0]).toMatchObject({ strategy: "cookie" });
    expect(out.fell?.[0]?.why).toMatch(/count: nothing at data.summary/);
    expect(out.records.products).toHaveLength(2);
    expect(calls.now?.legs.map((l) => l.path)).toEqual(["summary", "results"]);
    expect(calls.now?.off).toBeUndefined();
  });

  it("a call the start page makes is taken as it loads: no extra request", async () => {
    Object.assign(shop, { shape: "v1", sign: true, limit: false, asked: [] });
    const spec = walkOf(shop.base, { onLoad: true });
    const calls = memoryCalls();
    const first = await run(spec, "running shoes", calls);
    expect(first.out.via).toBe("ui");
    expect(first.out.learned).toBe("2 leg(s)");
    // Signed and with a cache buster, but the page makes it: no headers kept.
    expect(calls.now?.legs.map((l) => [l.way, l.headers])).toEqual([
      ["intercept", {}],
      ["intercept", {}],
    ]);
    shop.asked = [];
    const second = await run(spec, "trail boots", calls);
    expect(second.out.fell).toBeUndefined();
    expect(second.out.via).toBe("intercept");
    expect(second.acts).toEqual([]);
    expect(shop.asked).toEqual(["trail boots"]);
    expect(second.out.records.products).toHaveLength(2);
    expect(second.out.read.count).toBe("2");
  });

  it("legs that are off are neither tried nor learned again", async () => {
    Object.assign(shop, { shape: "v1", sign: false, limit: false, asked: [] });
    const spec = walkOf(shop.base);
    const calls = memoryCalls();
    await run(spec, "running shoes", calls);
    const legs = calls.now?.legs ?? [];
    calls.now = {
      learned: "2026-11-12T00:00:00.000Z",
      legs,
      off: { until: "2999-01-01T00:00:00.000Z", why: "x" },
    };
    calls.saved = [];
    const out = (await run(spec, "trail boots", calls)).out;
    expect(out.via).toBe("ui");
    expect(out.learned).toBeUndefined();
    expect(calls.saved).toEqual([]);
  });

  it("a 429 stops the run: no fall to clicks", async () => {
    Object.assign(shop, { shape: "v1", sign: false, limit: false, asked: [] });
    const spec = walkOf(shop.base);
    const calls = memoryCalls();
    await run(spec, "running shoes", calls);
    expect(calls.now?.legs).toHaveLength(2);
    shop.limit = true;
    const page = await browser.newPage();
    const acts: string[] = [];
    await expect(
      walkFlow(spec, { calls }).run(flowPage(page, acts), { q: "boots" }),
    ).rejects.toThrow(/HTTP 429/);
    expect(acts).toEqual([]);
    await page.close();
  });

  it("a signed call is never learned", async () => {
    Object.assign(shop, { shape: "v1", sign: true, limit: false, asked: [] });
    const calls = memoryCalls();
    const out = (await run(walkOf(shop.base), "running shoes", calls)).out;
    expect(out.learned).toMatch(/signed \(x-sig\)/);
    expect(calls.saved).toEqual([]);
  });

  it("a walk with an irreversible op never learns", async () => {
    Object.assign(shop, { shape: "v1", sign: false, limit: false, asked: [] });
    const spec = walkOf(shop.base, { irreversible: true });
    expect(ineligible(spec)).toBe("search is irreversible");
    const calls = memoryCalls();
    const out = (await run(spec, "running shoes", calls)).out;
    expect(out.learned).toBeUndefined();
    expect(calls.saved).toEqual([]);
  });
});

describe("tracing legs", () => {
  const base = "https://shop.test";
  const spec = walkOf(base);
  const call = (url: string, json: unknown): SeenCall => ({
    method: "GET",
    url,
    body: null,
    headers: {},
    json,
    from: base,
    acts: 1,
  });
  const rows = [
    { title: "Trail Boot", link: `${base}/item/100` },
    { title: "Hiking Boot", link: `${base}/item/103` },
  ];
  const answer = {
    data: {
      summary: "2 results for boots",
      items: [
        { title: "Trail Boot", url: "/item/100" },
        { title: "Hiking Boot", url: "/item/103" },
      ],
    },
  };
  const t = (calls: SeenCall[], used: Record<string, string>) =>
    traceLegs({
      spec,
      read: { count: "2" },
      records: { products: rows },
      calls,
      used,
      cookies: {},
    });

  it("refuses when no call carries a plan value: the answer would not follow it", () => {
    expect(t([call(`${base}/api/all`, answer)], { q: "boots" })).toEqual({
      why: "no call carries plan value q",
    });
  });

  it("refuses a plan value too short to find", () => {
    expect(t([call(`${base}/api/search?q=ab`, answer)], { q: "ab" })).toEqual({
      why: "plan value q is too short to find in a call",
    });
  });

  it("refuses a call that sends back an id an earlier answer gave", () => {
    const list = call(`${base}/api/lists?q=boots`, { list: { id: "list-998877" } });
    const r = t([list, call(`${base}/api/search?q=boots&list=list-998877`, answer)], {
      q: "boots",
    });
    expect(r).toEqual({ why: "count: it sends back 11 chars an earlier answer gave" });
  });

  it("refuses a credential in the query that is no cookie", () => {
    const r = t([call(`${base}/api/search?q=boots&fb_dtsg=AQH123xyz`, answer)], { q: "boots" });
    expect(r).toEqual({ why: "count: it carries a credential (fb_dtsg) that is no cookie" });
  });

  it("a call the start page made keeps no headers and may be signed", () => {
    const r = t(
      [
        {
          ...call(`${base}/api/search?q=boots&fb_dtsg=AQH123xyz`, answer),
          acts: 0,
          headers: { "x-sig": "9" },
        },
      ],
      { q: "boots" },
    );
    expect("legs" in r && r.legs.map((l) => [l.way, l.headers, l.url])).toEqual([
      ["intercept", {}, `${base}/api/search?q={{q}}&fb_dtsg=AQH123xyz`],
      ["intercept", {}, `${base}/api/search?q={{q}}&fb_dtsg=AQH123xyz`],
    ]);
  });

  it("matches the page's call by path, query and plan value; a number may change", () => {
    const leg = (
      t([call(`${base}/api/search?q=boots&v=1&t=1731400000111`, answer)], { q: "boots" }) as {
        legs: WalkCalls["legs"];
      }
    ).legs[0] as WalkCalls["legs"][number];
    const v = (k: string) => (k === "q" ? "trail boots" : "");
    const req = (url: string) => ({ method: "GET", url, body: null });
    expect(sameCall(leg, req(`${base}/api/search?q=trail%20boots&v=1&t=1731400000222`), v)).toBe(
      true,
    );
    expect(sameCall(leg, req(`${base}/api/search?q=boots&v=1&t=1731400000222`), v)).toBe(false);
    expect(sameCall(leg, req(`${base}/api/search?q=trail%20boots&v=2&t=1731400000222`), v)).toBe(
      false,
    );
    expect(sameCall(leg, req(`${base}/api/other?q=trail%20boots&v=1&t=1731400000222`), v)).toBe(
      false,
    );
  });

  it("a leg that broke and came back the same is off for a while", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const legs = (
      t([call(`${base}/api/search?q=boots`, answer)], { q: "boots" }) as {
        legs: WalkCalls["legs"];
      }
    ).legs;
    const old = nextCalls(undefined, legs, null, now);
    expect(old.off).toBeUndefined();
    const again = nextCalls(old, legs, "count: HTTP 404", now);
    expect(again.off).toEqual({
      until: new Date(now.getTime() + OFF_MS).toISOString(),
      why: "count: HTTP 404",
    });
  });
});
