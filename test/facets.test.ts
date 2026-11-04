import { describe, expect, it } from "vitest";
import { z } from "zod";
import { searchUrl as googleUrl } from "../src/browser/flows/google-search.js";
import { postsSearchUrl } from "../src/browser/flows/linkedin-posts.js";
import { searchUrl as peopleUrl } from "../src/browser/flows/linkedin-reach.js";
import { threadsSearchUrl } from "../src/browser/flows/threads-act.js";
import { apply, catalogOf, fields, presetWords, resolve } from "../src/sites/facets/core.js";
import {
  FACET_SETS,
  GOOGLE_SEARCH,
  LINKEDIN_POSTS,
  REDDIT_SEARCH,
  THREADS_SEARCH,
  X_SEARCH,
  YOUTUBE_SEARCH,
} from "../src/sites/facets/sets.js";

const WEB = "https://www.linkedin.com";
const NOW = Date.parse("2026-11-03T12:00:00Z");

describe("facets", () => {
  it("zod from a set: defaults, a comma list, a value the platform lacks", () => {
    const s = z.object(fields(LINKEDIN_POSTS));
    expect(s.parse({})).toEqual({});
    expect(resolve(LINKEDIN_POSTS, {})).toEqual({ datePosted: "past-week", sortBy: "date_posted" });
    expect(s.parse({ postedBy: "first,following" }).postedBy).toEqual(["first", "following"]);
    expect(s.safeParse({ contentType: "podcasts" }).success).toBe(false);
    expect(s.safeParse({ datePosted: "past-year" }).success).toBe(false);
  });

  it("defaults keep today's urls", () => {
    expect(postsSearchUrl({ keywords: "staffing agency" })).toBe(
      `${WEB}/search/results/content/?keywords=staffing+agency&datePosted=%22past-week%22&sortBy=%22date_posted%22`,
    );
    expect(threadsSearchUrl("ai tools")).toBe(
      "https://www.threads.com/search?q=ai+tools&serp_type=default&filter=recent",
    );
    expect(new URL(googleUrl({ q: "x" })).searchParams.has("tbs")).toBe(false);
    expect(resolve(REDDIT_SEARCH, { q: "x" })).toEqual({ q: "x", sort: "new", t: "month" });
  });

  it("LinkedIn writes its filters as JSON", () => {
    const u = new URL(
      postsSearchUrl({
        keywords: "ai",
        sortBy: "relevance",
        contentType: "videos",
        postedBy: ["first", "following"],
      }),
    );
    expect(u.searchParams.get("sortBy")).toBe('"relevance"');
    expect(u.searchParams.get("contentType")).toBe('"videos"');
    expect(u.searchParams.get("postedBy")).toBe('["first","following"]');
    const p = new URL(peopleUrl({ keywords: "cfo", network: ["S"], currentCompany: ["1441"] }, 2));
    expect(p.searchParams.get("currentCompany")).toBe('["1441"]');
    expect(p.searchParams.get("network")).toBe('["S"]');
  });

  it("Threads Top drops the Recent tab; Google's time filter is tbs", () => {
    expect(new URL(threadsSearchUrl("ai", { search_type: "TOP" })).searchParams.has("filter")).toBe(
      false,
    );
    expect(new URL(googleUrl({ q: "x", qdr: "w" })).searchParams.get("tbs")).toBe("qdr:w");
  });

  it("api facets reach the API query, url ones are skipped", () => {
    const u = apply(
      new URL("https://www.googleapis.com/youtube/v3/search"),
      YOUTUBE_SEARCH,
      { order: "viewCount", videoDuration: "long" },
      { via: "api" },
    );
    expect(Object.fromEntries(u.searchParams)).toEqual({
      order: "viewCount",
      videoDuration: "long",
    });
    expect(apply(new URL("https://x.test/"), YOUTUBE_SEARCH, { order: "date" }).search).toBe("");
  });

  it("the catalog is plain data with the UI's labels", () => {
    const rows = FACET_SETS.map((s) => catalogOf(s, NOW));
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
    const sort = catalogOf(LINKEDIN_POSTS).facets.find((f) => f.name === "sortBy");
    expect(sort).toMatchObject({
      label: "Sort by",
      kind: "one",
      via: "url",
      default: "date_posted",
      values: [
        { value: "date_posted", label: "Latest" },
        { value: "relevance", label: "Top match" },
      ],
    });
  });

  it("presets: one grammar, each surface its own values; explicit beats preset beats default", () => {
    const top = new URL(postsSearchUrl({ keywords: "ai", preset: "top-month" }));
    expect(top.searchParams.get("sortBy")).toBe('"relevance"');
    expect(top.searchParams.get("datePosted")).toBe('"past-month"');
    const mixed = resolve(LINKEDIN_POSTS, { preset: "top-month", datePosted: "past-24h" });
    expect(mixed).toEqual({ sortBy: "relevance", datePosted: "past-24h" });
    expect(resolve(X_SEARCH, { preset: "top-day" }, NOW)).toEqual({
      sort_order: "relevancy",
      start_time: "2026-11-02T12:00:00.000Z",
    });
    expect(resolve(REDDIT_SEARCH, { preset: "week" })).toEqual({ sort: "new", t: "week" });
    expect(new URL(googleUrl({ q: "x", preset: "week" })).searchParams.get("tbs")).toBe("qdr:w");
    expect(resolve(THREADS_SEARCH, { preset: "top" })).toEqual({ search_type: "TOP" });
  });

  it("a preset a surface cannot honor is refused, naming the ones it can", () => {
    const x = z.object(fields(X_SEARCH)).safeParse({ preset: "top-month" });
    expect(x.success).toBe(false);
    expect(JSON.stringify(x.error?.issues)).toMatch(/latest, top, day, week/);
    expect(z.object(fields(GOOGLE_SEARCH)).safeParse({ preset: "top" }).success).toBe(false);
    expect(() => resolve(X_SEARCH, { preset: "year" })).toThrow(/no preset year/);
  });

  it("the summary line says the grammar", () => {
    expect(presetWords(LINKEDIN_POSTS)).toBe(
      "`preset` latest|top, day|week|month or paired (`top-day`)",
    );
    expect(presetWords(THREADS_SEARCH)).toBe("`preset` latest|top");
  });
});
