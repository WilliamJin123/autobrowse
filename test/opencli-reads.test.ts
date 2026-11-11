import { describe, expect, it } from "vitest";
import { listingsOf } from "../src/browser/flows/fb-marketplace.js";
import {
  headerCounts,
  mediaOf,
  pkOf,
  profileUserOf,
} from "../src/browser/flows/instagram-people.js";
import { boardFeedUrl, pageOf, rowsOf, searchUrl } from "../src/browser/flows/pinterest.js";
import { itemsOf, noticesOf, userInfoOf } from "../src/browser/flows/tiktok-reads.js";
import { entitiesOf, opsMatch } from "../src/browser/flows/x-graph.js";
import { clockMs, json3Lines } from "../src/browser/flows/youtube-transcript.js";
import { foldPath, scanScripts } from "../src/explore/script-scan.js";
import { bestRoute } from "../src/sites/facade-checks.js";

describe("x GraphQL entities", () => {
  const body = {
    data: {
      timeline: {
        instructions: [
          {
            entries: [
              {
                content: {
                  itemContent: {
                    tweet_results: { result: { rest_id: "1", legacy: { full_text: "a" } } },
                  },
                },
              },
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: { __typename: "TweetWithVisibilityResults", tweet: { rest_id: "2" } },
                    },
                  },
                },
              },
              { content: { itemContent: { tweet_results: { result: { rest_id: "1" } } } } },
              {
                content: {
                  itemContent: { user_results: { result: { rest_id: "9", legacy: {} } } },
                },
              },
            ],
          },
        ],
      },
    },
  };

  it("keeps each tweet whole, once, unwrapping visibility results", () => {
    const m = entitiesOf(body, "tweet");
    expect([...m.keys()]).toEqual(["1", "2"]);
    expect(m.get("1")).toEqual({ rest_id: "1", legacy: { full_text: "a" } });
  });

  it("finds users, lists and trends by their own ids", () => {
    expect([...entitiesOf(body, "user").keys()]).toEqual(["9"]);
    expect([...entitiesOf({ a: [{ list: { id_str: "L1" } }] }, "list").keys()]).toEqual(["L1"]);
    expect([...entitiesOf({ t: { trend: { name: "#x" } } }, "trend").keys()]).toEqual(["#x"]);
  });

  it("matches only the named operations", () => {
    const re = opsMatch(["Followers", "Following"]);
    expect(re.test("https://x.com/i/api/graphql/abc-1/Followers?variables=1")).toBe(true);
    expect(re.test("https://x.com/i/api/graphql/abc-1/FollowersYouKnow?v")).toBe(false);
  });
});

describe("instagram readers", () => {
  it("takes the profile query's user only for that username", () => {
    const b = { data: { user: { username: "Nasa", pk: "528817151" } } };
    expect(profileUserOf(b, "nasa")).toEqual(b.data.user);
    expect(profileUserOf(b, "other")).toBeNull();
    expect(pkOf({ id: 5 })).toBe("5");
  });

  it("finds media by shape, each once", () => {
    const m = mediaOf({
      sections: [
        { medias: [{ media: { code: "A", taken_at: 1 } }, { media: { code: "A", taken_at: 1 } }] },
      ],
    });
    expect([...m.keys()]).toEqual(["A"]);
  });

  it("reads the header counts from the meta description", () => {
    expect(headerCounts("104M Followers, 91 Following, 5,008 Posts - See photos")).toEqual({
      followers: "104M",
      following: "91",
      posts: "5,008",
    });
    expect(headerCounts("no counts")).toBeNull();
  });
});

describe("tiktok readers", () => {
  it("reads userInfo, and a status for a missing user", () => {
    const ok = {
      __DEFAULT_SCOPE__: {
        "webapp.user-detail": { statusCode: 0, userInfo: { user: { id: "1" }, stats: {} } },
      },
    };
    expect(userInfoOf(ok).info).toEqual({ user: { id: "1" }, stats: {} });
    const gone = {
      __DEFAULT_SCOPE__: { "webapp.user-detail": { statusCode: 10202, userInfo: {} } },
    };
    expect(userInfoOf(gone)).toEqual({ info: null, status: 10202 });
    expect(userInfoOf(null)).toEqual({ info: null, status: null });
  });

  it("keeps items and notices whole by id", () => {
    expect([...itemsOf({ itemList: [{ id: "1" }, { id: "1" }, { id: 2 }] }).keys()]).toEqual([
      "1",
      "2",
    ]);
    const n = noticesOf({
      notice_lists: [{ notice_list: [{ nid_str: "7", type: 1 }, { nid: 8 }] }],
    });
    expect([...n.keys()]).toEqual(["7", "8"]);
  });
});

describe("youtube transcript", () => {
  it("joins json3 segments into lines and skips empty events", () => {
    const body = {
      events: [
        { tStartMs: 0, dDurationMs: 100, id: 1 },
        { tStartMs: 4220, dDurationMs: 1180, segs: [{ utf8: "This" }, { utf8: " is\na 3." }] },
        { tStartMs: 5000, segs: [{ utf8: "\n" }] },
      ],
    };
    expect(json3Lines(body)).toEqual([{ startMs: 4220, durMs: 1180, text: "This is a 3." }]);
    expect(json3Lines({ nope: 1 })).toBeNull();
  });

  it("reads panel clocks", () => {
    expect(clockMs("0:04")).toBe(4000);
    expect(clockMs("1:02:03")).toBe(3_723_000);
  });
});

describe("script scan", () => {
  it("finds API paths and GraphQL operations, ids folded", () => {
    const r = scanScripts([
      {
        src: "inline #1",
        text: `fetch("/api/v1/users/123456/info/"); x("/api/v1/users/99999/info/"); y('/api/');
          e={queryId:"Abc123xyz",operationName:"UserByScreenName"}; q="query FeedQuery($id: ID) {"`,
      },
    ]);
    expect(r.endpoints).toEqual([
      { path: "/api/v1/users/{id}/info/", count: 2, in: ["inline #1"] },
    ]);
    expect(r.operations).toEqual([
      { name: "FeedQuery", kind: "query", in: ["inline #1"] },
      { name: "UserByScreenName", kind: "op", queryId: "Abc123xyz", in: ["inline #1"] },
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a script's own template text
    expect(foldPath("/api/x/${id}/y")).toBe("/api/x/{var}/y");
  });
});

describe("route matching", () => {
  it("the most literal route wins, whatever the order", () => {
    const routes = [
      { method: "GET", path: "/web/{username}" },
      { method: "GET", path: "/web/explore" },
    ] as const;
    expect(bestRoute(routes, "GET", "/web/explore")?.r.path).toBe("/web/explore");
    expect(bestRoute(routes, "GET", "/web/nasa")?.params).toEqual({ username: "nasa" });
    expect(bestRoute(routes, "POST", "/web/nasa")).toBeNull();
  });
});

describe("pinterest resources", () => {
  it("reads rows by id and the next bookmark", () => {
    const rows = rowsOf({ results: [{ id: "1" }, { id: "2" }, { id: "1" }, { x: 1 }] });
    expect([...rows.keys()]).toEqual(["1", "2"]);
    expect([...rowsOf([{ id: 3 }]).keys()]).toEqual(["3"]);
    expect(pageOf({ resource_response: { data: [], bookmark: "Y2" } }).bookmark).toBe("Y2");
    expect(pageOf({ resource_response: { data: [], bookmark: "-end-" } }).bookmark).toBeNull();
    expect(pageOf(null)).toEqual({ data: null, bookmark: null });
  });

  it("builds the page's own calls", () => {
    const data = (u: string) =>
      JSON.parse(new URL(u, "https://x.test").searchParams.get("data") as string).options;
    expect(data(searchUrl("desk setup", null))).toEqual({
      query: "desk setup",
      scope: "pins",
      page_size: 25,
    });
    expect(data(searchUrl("a", "B")).bookmarks).toEqual(["B"]);
    const u = boardFeedUrl("/p/b/", "42", "/p/b/", "M");
    expect(new URL(u, "https://x.test").searchParams.get("source_url")).toBe("/p/b/");
    expect(data(u)).toEqual({
      board_id: "42",
      board_url: "/p/b/",
      page_size: 25,
      bookmarks: ["M"],
    });
  });
});

describe("facebook marketplace", () => {
  it("finds listings whole, each once", () => {
    const a = { id: "1", marketplace_listing_title: "Desk", listing_price: { amount: "10.00" } };
    const roots = [
      { x: { feed_units: { edges: [{ node: { listing: a } }, { node: { listing: a } }] } } },
      { id: "2" },
    ];
    expect([...listingsOf(roots).values()]).toEqual([a]);
  });
});
