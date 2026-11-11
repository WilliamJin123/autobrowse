import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NetRow } from "../src/browser/network.js";
import { deepKeys, readMemory, recall, rememberCalls } from "../src/browser/site-memory.js";

const row = (o: Partial<NetRow>): NetRow => ({
  id: 1,
  t: 0,
  method: "GET",
  url: "https://api.example.com/users/12345/posts",
  status: 200,
  type: "fetch",
  size: 10,
  ...o,
});

describe("site memory (U13)", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-memory-"));
  const env = { AUTOBROWSE_STATS_DIR: dir };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("walks keys deep, arrays as []", () => {
    expect(deepKeys({ data: { user: { edges: [{ node: { caption: { text: "x" } } }] } } })).toEqual(
      [
        "data",
        "data.user",
        "data.user.edges",
        "data.user.edges[].node",
        "data.user.edges[].node.caption",
        "data.user.edges[].node.caption.text",
      ],
    );
  });

  it("folds sessions per base site, keys only, and finds calls and fields", () => {
    const secret = "value-that-must-not-be-kept";
    rememberCalls(
      "ex@wren",
      [
        row({ body: { items: [{ title: secret, followers_count: 3 }] } }),
        row({ id: 2, url: "https://example.com/page", type: "document" }),
        row({
          id: 3,
          method: "POST",
          url: "https://example.com/api/graphql",
          reqBody: { fb_api_req_friendly_name: "ProfileQuery", variables: "{}" },
          body: { data: { user: { followers_count: 9 } } },
        }),
      ],
      env,
      "2026-11-10T01:00:00.000Z",
    );
    rememberCalls(
      "ex",
      [row({ url: "https://api.example.com/users/999/posts", status: 404 })],
      env,
      "2026-11-10T02:00:00.000Z",
    );
    const files = ["endpoints.json", "field-map.json"].map((f) =>
      readFileSync(join(dir, "sites", "ex", f), "utf8"),
    );
    expect(files.join("")).not.toContain(secret);
    const m = readMemory("ex@other", env);
    expect(Object.keys(m.endpoints)).toEqual([
      "GET api.example.com/users/*/posts",
      "POST example.com/api/graphql ProfileQuery",
    ]);
    const posts = m.endpoints["GET api.example.com/users/*/posts"];
    expect(posts?.seen).toBe(2);
    expect(posts?.statuses).toEqual([200, 404]);
    expect(posts?.first).toBe("2026-11-10T01:00:00.000Z");
    expect(m.endpoints["POST example.com/api/graphql ProfileQuery"]?.sends).toEqual([
      "fb_api_req_friendly_name",
      "variables",
    ]);
    expect(m.fields.followers_count).toEqual([
      "POST example.com/api/graphql ProfileQuery :: data.user.followers_count",
      "GET api.example.com/users/*/posts :: items[].followers_count",
    ]);
    const found = recall(m, "FOLLOWERS");
    expect(found.calls).toEqual([]);
    expect(Object.keys(found.fields ?? {})).toEqual(["followers_count"]);
    expect(recall(m, "profilequery").calls).toHaveLength(1);
    expect(recall(m).calls[0]).toMatch(/^GET api\.example\.com\/users\/\*\/posts ×2 200\/404/);
  });

  it("writes nothing for a session with no calls", () => {
    expect(rememberCalls("none", [row({ type: "document" })], env)).toBeNull();
  });
});
