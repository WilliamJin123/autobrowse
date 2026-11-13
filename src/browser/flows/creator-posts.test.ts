import { describe, expect, it } from "vitest";
import { gridMedia, ownedBy, postsOf, postUrl } from "./instagram-posts.js";
import { threadsPostsOf, threadsUserOf } from "./threads-posts.js";
import { entitiesOf, userNamed } from "./x-graph.js";

// WA-1362: shapes as mapped live 2026-11-12.

const tweet = (id: string, by: string) => ({
  tweet_results: {
    result: {
      __typename: "Tweet",
      rest_id: id,
      core: {
        user_results: {
          result: { rest_id: by === "Creator" ? "11" : `u-${by}`, core: { screen_name: by } },
        },
      },
      legacy: { favorite_count: 3, reply_count: 1, retweet_count: 2 },
      views: { count: "90" },
    },
  },
});

describe("X user posts", () => {
  const byName = {
    data: {
      user: {
        result: {
          rest_id: "11",
          core: { screen_name: "Creator" },
          legacy: { followers_count: 500 },
        },
      },
    },
  };
  const timeline = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: { instructions: [{ entries: [tweet("1", "Creator"), tweet("2", "other")] }] },
          },
        },
      },
    },
  };

  it("finds the profile user by handle, any case, with or without @", () => {
    const u = userNamed([timeline, byName], "@creator");
    expect(u?.rest_id).toBe("11");
    expect(u?.legacy).toEqual({ followers_count: 500 });
    expect(userNamed([timeline], "nobody")).toBeNull();
  });

  it("keeps each tweet whole with its counts", () => {
    const got = [...entitiesOf(timeline, "tweet").values()];
    expect(got.map((t) => t.rest_id)).toEqual(["1", "2"]);
    expect(got[0]?.views).toEqual({ count: "90" });
  });
});

const media = (code: string, owner: string, extra: Record<string, unknown> = {}) => ({
  code,
  pk: `p${code}`,
  taken_at: 1794076541,
  media_type: 1,
  product_type: "feed",
  like_count: 10,
  user: { pk: owner },
  ...extra,
});

describe("Instagram posts", () => {
  const grid = (nodes: unknown[]) => ({
    data: { xdt_profile_connection: { edges: nodes.map((node) => ({ node })) } },
  });

  it("reads any data connection whose nodes are media; not the home timeline's media-in-node", () => {
    expect(gridMedia(grid([media("A", "1")])).map((m) => m.code)).toEqual(["A"]);
    expect(
      gridMedia({
        data: {
          xdt_api__v1__feed__timeline__connection: {
            edges: [{ node: { media: media("H", "9") } }],
          },
        },
      }),
    ).toEqual([]);
    expect(gridMedia("x")).toEqual([]);
  });

  it("keeps every kind, once, owned by the account or co-authored", () => {
    const got = postsOf(
      [
        grid([
          media("A", "1"),
          media("B", "1", { media_type: 8, product_type: "carousel_container" }),
          media("C", "1", { media_type: 2, product_type: "clips" }),
          media("D", "2"),
          media("E", "2", { coauthor_producers: [{ pk: "1" }] }),
        ]),
        grid([media("A", "1")]),
      ],
      "1",
    );
    expect(got.map((m) => m.code)).toEqual(["A", "B", "C", "E"]);
    expect(ownedBy(media("D", "2"), null)).toBe(true);
  });

  it("links a reel as /reel/, every other kind as /p/", () => {
    expect(postUrl({ code: "C", product_type: "clips" })).toBe("https://www.instagram.com/reel/C/");
    expect(postUrl({ code: "A", product_type: "feed" })).toBe("https://www.instagram.com/p/A/");
  });
});

describe("Threads posts", () => {
  const post = (code: string, by: string) => ({
    pk: `p${code}`,
    code,
    taken_at: 1794009544,
    like_count: 800,
    user: { username: by },
    text_post_app_info: { direct_reply_count: 14, repost_count: 28, quote_count: 4 },
  });
  const html = {
    require: [
      [
        "x",
        "y",
        null,
        [
          {
            __bbox: {
              result: {
                data: {
                  mediaData: {
                    edges: [
                      {
                        node: {
                          thread_items: [
                            { post: post("A", "Creator") },
                            { post: post("A2", "creator") },
                          ],
                        },
                      },
                    ],
                  },
                  user: { username: "creator", pk: "77", full_name: "C", follower_count: 12 },
                  suggestedUsers: { users: [{ username: "other", follower_count: 1 }] },
                },
              },
            },
          },
        ],
      ],
    ],
  };
  const page2 = {
    data: {
      mediaData: {
        edges: [
          { node: { thread_items: [{ post: post("B", "creator") }] } },
          {
            node: {
              thread_items: [{ post: post("A", "creator") }, { post: post("X", "someone") }],
            },
          },
        ],
      },
    },
  };

  it("keeps the account's posts whole, a thread's chain too, once each, in order", () => {
    const got = threadsPostsOf([html, page2], "@creator".replace("@", ""));
    expect(got.map((p) => p.code)).toEqual(["A", "A2", "B"]);
    expect(got[0]?.text_post_app_info).toEqual({
      direct_reply_count: 14,
      repost_count: 28,
      quote_count: 4,
    });
  });

  it("finds the profile user, not a suggested one", () => {
    expect(threadsUserOf([html], "Creator")?.pk).toBe("77");
    expect(threadsUserOf([html], "other")).toBeNull();
    expect(threadsUserOf([page2], "creator")).toBeNull();
  });
});
