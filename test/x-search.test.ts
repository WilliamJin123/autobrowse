import { describe, expect, it } from "vitest";
import { entitiesOf, xSearchPosts } from "../src/browser/flows/x-graph.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { x } from "../src/sites/x.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const cell = (id: string, extra: Record<string, unknown> = {}) => ({
  itemContent: { tweet_results: { result: { rest_id: id, legacy: {} } }, ...extra },
});

describe("x search", () => {
  it("leaves out ads: a cell with promotedMetadata", () => {
    const body = {
      entries: [cell("1"), cell("2", { promotedMetadata: { advertiser: {} } }), cell("3")],
    };
    expect([...entitiesOf(body, "tweet").keys()]).toEqual(["1", "3"]);
  });

  it("GET /web/search runs x/search-posts as x@wren only, under web_search", async () => {
    const seen: unknown[] = [];
    const browser = fakeBrowser([]);
    browser.on(xSearchPosts, async (i) => {
      seen.push(i);
      return { q: i.q, product: i.product ?? "top", found: true, items: [], calls: 1, seen: [] };
    });
    // the cap and the account, not the pace, are under test
    const { pace: _pace, ...unpaced } = x;
    const sites = siteFacade([unpaced], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      caps: memoryCaps(() => Date.UTC(2026, 10, 15, 12)),
    });
    const ask = { q: "filter:native_video min_faves:500", product: "latest", max: "20" };
    await expect(sites.call("x", "GET", "/web/search", ask)).rejects.toMatchObject({ status: 400 });
    await expect(sites.call("x", "GET", "/web/search", ask, "william")).rejects.toThrow(
      /x@wren only/,
    );
    expect(seen).toHaveLength(0);
    expect(await sites.call("x", "GET", "/web/search", ask, "wren")).toMatchObject({ found: true });
    expect(seen).toEqual([{ q: ask.q, product: "latest", max: 20 }]);
    await expect(
      sites.call("x", "GET", "/web/search", { q: "a", max: "201" }, "wren"),
    ).rejects.toThrow();
    const r = x.routes.find((y) => y.method === "GET" && y.path === "/web/search");
    expect(r?.meter?.({} as never)).toEqual({ web_search: 1 });
    expect(r?.browser).toEqual({ flow: "x/search-posts" });
    expect(x.caps?.web_search).toBe(60);
    expect(BROWSER_FLOWS["x/search-posts"]).toBe(xSearchPosts);
  });
});
