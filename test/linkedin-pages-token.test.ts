import { describe, expect, it } from "vitest";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { linkedin, linkedinPages, siteFacade } from "../src/sites/index.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const org = "urn:li:organization:42";
const post = "urn:li:share:7";

/** `linkedin` with the member token, and the Pages app's token when `pages` is set. */
const stats = defineFlow<{ urn: string }, { $read: string }>({
  site: "linkedin",
  name: "post-stats",
  async run() {
    return { $read: "page" };
  },
});

function facade(pages: boolean, quota = Infinity) {
  let left = quota;
  const api = fakeFetch(({ url, headers }) => {
    const bearer = headers.get("authorization");
    if (left-- <= 0)
      return { status: 429, body: { message: "Resource level throttle APPLICATION DAY limit" } };
    if (url.pathname === "/rest/posts") return { body: { elements: [], bearer } };
    if (url.pathname.startsWith("/rest/socialActions/")) return { body: { bearer } };
    return { status: 404 };
  });
  const env: Record<string, string> = {
    LINKEDIN_ACCESS_TOKEN: "member",
    ...(pages ? { LINKEDIN_PAGES_ACCESS_TOKEN: "page" } : {}),
  };
  const browser = fakeBrowser([]);
  browser.on(stats, async () => ({ $read: "page" }));
  const sites = siteFacade([linkedin, linkedinPages], {
    http: httpClient({ fetch: api.fetch }),
    env: (n) => env[n],
    sink: memorySink(),
    runner: browser,
    flow: (n) => (n === "linkedin/post-stats" ? (stats as never) : null),
  });
  return { sites, api };
}

describe("linkedin Page routes on the Pages app's token (WA-1311)", () => {
  it("a Page's posts and counts go by the API with the Pages token", async () => {
    const { sites } = facade(true);
    expect(
      await sites.call("linkedin", "GET", "/rest/posts", { author: org, count: "5" }),
    ).toMatchObject({ bearer: "Bearer page" });
    expect(
      await sites.call("linkedin", "GET", `/rest/socialActions/${encodeURIComponent(post)}`, {}),
    ).toEqual({ bearer: "Bearer page" });
    const row = await sites.status("linkedin");
    expect(
      row.routes.find((r) => r.method === "GET" && r.path === "/rest/socialActions/{urn}"),
    ).toMatchObject({ via: "api" });
  });

  it("a member's own posts still lack r_member_social: no API call with either token", async () => {
    const { sites, api } = facade(true);
    await sites
      .call("linkedin", "GET", "/rest/posts", { author: "urn:li:person:abc" })
      .catch(() => null);
    expect(api.calls).toEqual([]);
  });

  it("no Pages token: the member token is never sent for a Page grant", async () => {
    const { sites, api } = facade(false);
    await sites.call("linkedin", "GET", "/rest/posts", { author: org }).catch(() => null);
    expect(api.calls).toEqual([]);
  });

  it("a 429 (the app's day spent) reads by the browser, and the API rests till UTC midnight", async () => {
    const { sites, api } = facade(true, 0);
    const path = `/rest/socialActions/${encodeURIComponent(post)}`;
    expect(await sites.call("linkedin", "GET", path, {})).toEqual({ $read: "page" });
    const first = api.calls.length; // the client's own 429 retries
    expect(await sites.call("linkedin", "GET", path, {})).toEqual({ $read: "page" });
    expect(api.calls.length).toBe(first);
  });
});
