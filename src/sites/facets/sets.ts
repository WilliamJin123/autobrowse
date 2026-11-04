/**
 * Each surface's facets, in its platform's names and values; labels are its UI's words.
 * Audits behind each: designs/2026-11-03-search-filters.md (Inventory).
 */
import { ago, facetSet, grid, ids, many, one, text, time } from "./core.js";

/** unix seconds of an ISO instant, as X's `since_time:` operator takes it */
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const addToQ = (u: URL, words: string) =>
  u.searchParams.set("q", `${u.searchParams.get("q") ?? ""} ${words}`.trim());

/** LinkedIn writes every filter as JSON: `datePosted="past-week"`, `postedBy=["first"]`. */
export const LINKEDIN_JSON = (v: unknown) => JSON.stringify(v);

export const LINKEDIN_POSTS = facetSet({
  site: "linkedin",
  routes: ["linkedin GET /search/results/content"],
  label: "Posts search",
  facets: {
    datePosted: one(
      "Date posted",
      { "past-24h": "Past 24 hours", "past-week": "Past week", "past-month": "Past month" },
      { default: "past-week" },
    ),
    sortBy: one(
      "Sort by",
      { date_posted: "Latest", relevance: "Top match" },
      { default: "date_posted" },
    ),
    contentType: one("Content type", {
      videos: "Videos",
      photos: "Images",
      jobs: "Jobs",
      liveVideos: "Live videos",
      documents: "Documents",
    }),
    postedBy: many("Posted by", {
      first: "1st connections",
      me: "Me",
      following: "People you follow",
    }),
    authorJobTitle: text("Author job title", 100),
  },
  presets: grid(
    { latest: { sortBy: "date_posted" }, top: { sortBy: "relevance" } },
    {
      day: { datePosted: "past-24h" },
      week: { datePosted: "past-week" },
      month: { datePosted: "past-month" },
    },
  ),
});

export const LINKEDIN_PEOPLE = facetSet({
  site: "linkedin",
  routes: ["linkedin GET /search/results/people"],
  label: "People search",
  facets: {
    network: many("Connections", { F: "1st", S: "2nd", O: "3rd+" }),
    currentCompany: ids("Current company", "company", /^\d{1,12}$/),
  },
});

export const X_SEARCH = facetSet({
  site: "x",
  routes: ["x GET /2/tweets/search/recent"],
  label: "Search",
  facets: {
    sort_order: one(
      "Sort",
      { recency: "Latest", relevancy: "Top" },
      {
        default: "recency",
        put: (u, v) => u.searchParams.set("f", v === "recency" ? "live" : "top"),
      },
    ),
    start_time: time("From", {
      note: "the page: `since_time:` in the query",
      put: (u, v) => addToQ(u, `since_time:${unix(v)}`),
    }),
    end_time: time("To", {
      note: "the page: `until_time:` in the query",
      put: (u, v) => addToQ(u, `until_time:${unix(v)}`),
    }),
  },
  // The API's recent search holds 7 days: no month or year.
  presets: grid(
    { latest: { sort_order: "recency" }, top: { sort_order: "relevancy" } },
    { day: (now) => ({ start_time: ago(1)(now) }), week: (now) => ({ start_time: ago(7)(now) }) },
  ),
});

export const THREADS_SEARCH = facetSet({
  site: "instagram",
  routes: ["instagram GET /web/threads/search"],
  label: "Threads search",
  facets: {
    search_type: one(
      "Sort",
      { TOP: "Top", RECENT: "Recent" },
      {
        default: "RECENT",
        note: "the API's name; the page: `filter=recent`",
        put: (u, v) => {
          if (v === "RECENT") u.searchParams.set("filter", "recent");
        },
      },
    ),
  },
  presets: grid({ latest: { search_type: "RECENT" }, top: { search_type: "TOP" } }, {}),
});

export const REDDIT_SEARCH = facetSet({
  site: "reddit",
  routes: ["reddit GET /r/{subreddit}/search", "reddit GET /search", "reddit-public GET /search"],
  label: "Search",
  facets: {
    sort: one(
      "Sort",
      { relevance: "Relevance", hot: "Hot", top: "Top", new: "New", comments: "Comments" },
      { default: "new" },
    ),
    t: one(
      "Time",
      {
        hour: "Past hour",
        day: "Past 24 hours",
        week: "Past week",
        month: "Past month",
        year: "Past year",
        all: "All time",
      },
      { default: "month" },
    ),
  },
  presets: grid(
    { latest: { sort: "new" }, top: { sort: "top" } },
    { day: { t: "day" }, week: { t: "week" }, month: { t: "month" }, year: { t: "year" } },
  ),
});

export const GOOGLE_SEARCH = facetSet({
  site: "web",
  routes: ["web GET /google"],
  label: "Google search",
  facets: {
    qdr: one(
      "Any time",
      { h: "Past hour", d: "Past 24 hours", w: "Past week", m: "Past month", y: "Past year" },
      {
        note: "Tools → Any time; `tbs=qdr:`",
        put: (u, v) => u.searchParams.set("tbs", `qdr:${v}`),
      },
    ),
  },
  presets: grid(
    {},
    { day: { qdr: "d" }, week: { qdr: "w" }, month: { qdr: "m" }, year: { qdr: "y" } },
  ),
});

const api = { via: "api" } as const;

export const YOUTUBE_SEARCH = facetSet({
  site: "youtube",
  routes: ["youtube GET /youtube/v3/search"],
  label: "Search",
  facets: {
    type: one("Type", { video: "Video", channel: "Channel", playlist: "Playlist" }, api),
    order: one(
      "Sort by",
      {
        relevance: "Relevance",
        date: "Upload date",
        viewCount: "View count",
        rating: "Rating",
        title: "Title",
        videoCount: "Video count",
      },
      api,
    ),
    publishedAfter: time("Uploaded after", api),
    publishedBefore: time("Uploaded before", api),
    videoDuration: one(
      "Duration",
      { any: "Any", short: "Under 4 minutes", medium: "4-20 minutes", long: "Over 20 minutes" },
      api,
    ),
    videoDefinition: one("Quality", { any: "Any", high: "HD", standard: "SD" }, api),
    videoCaption: one(
      "Subtitles",
      { any: "Any", closedCaption: "Subtitles/CC", none: "None" },
      api,
    ),
    videoLicense: one(
      "License",
      { any: "Any", creativeCommon: "Creative Commons", youtube: "Standard" },
      api,
    ),
    videoType: one("Video type", { any: "Any", episode: "Episode", movie: "Movie" }, api),
    eventType: one("Live", { completed: "Ended", live: "Live now", upcoming: "Upcoming" }, api),
    regionCode: text("Region", 2, api),
    relevanceLanguage: text("Language", 8, api),
    channelId: text("Channel", 64, api),
    safeSearch: one("Safe search", { moderate: "Moderate", none: "None", strict: "Strict" }, api),
  },
  presets: grid(
    { latest: { order: "date" }, top: { order: "viewCount" } },
    {
      day: (now) => ({ publishedAfter: ago(1)(now) }),
      week: (now) => ({ publishedAfter: ago(7)(now) }),
      month: (now) => ({ publishedAfter: ago(30)(now) }),
      year: (now) => ({ publishedAfter: ago(365)(now) }),
    },
  ),
});

export const INSTAGRAM_TAGS = facetSet({
  site: "meta",
  routes: ["meta GET /instagram/tags/{tag}"],
  label: "Hashtag",
  facets: {
    edge: one(
      "Tab",
      { recent_media: "Recent", top_media: "Top" },
      { ...api, default: "recent_media", note: "Meta's Public Content Access review first" },
    ),
  },
  presets: grid({ latest: { edge: "recent_media" }, top: { edge: "top_media" } }, {}),
});

export const FACET_SETS = [
  LINKEDIN_POSTS,
  LINKEDIN_PEOPLE,
  X_SEARCH,
  THREADS_SEARCH,
  REDDIT_SEARCH,
  GOOGLE_SEARCH,
  YOUTUBE_SEARCH,
  INSTAGRAM_TAGS,
] as const;
