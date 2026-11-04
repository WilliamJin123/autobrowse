# Facets: each platform's own sort and filters, on routes, workflows and live views

2026-11-03. William: "rich sort ability based on whatever filter logic all these platforms provide … leverage their existing UIs", then: compiled workflows take rich configurations; an API covers it, use the API; a UI of ours later sends filter events to an open page ("an open LinkedIn search where we can filter back and forth, or an open Amazon category where we apply filters dynamically").

## Goal

- Every search or listing surface we read takes the filters its platform offers, by the platform's own names and values.
- One declaration per surface (a facet set) says what each filter is, what the platform's UI calls it, and how it is applied: a URL parameter, an API parameter, or a click on the page's own control.
- Routes, compiled workflows and live views read that one declaration. A future UI lists it to draw its own controls.
- An API leg wherever an API covers the surface; the browser only where none does.

## Target state

```
facet set (src/sites/facets/<site>.ts)
  ├─ route input   : zod built from the set (optional fields, today's defaults)
  ├─ workflow plan : the same fields as plan inputs; a ui facet is a sub-step (open the control, pick the value)
  ├─ live view     : view open → page held (SessionPark, pinned) → set {facet: value} → apply → read
  └─ catalog       : `autobrowse facets [site]` JSON: surface, facets, labels, values, how applied
```

Applying a change on a live view: a `url` facet reloads the page with the new URL (one page load); a `ui` facet clicks the control in place (no reload); an `api` facet is a new API call (no page).

## Options

### How filters reach a surface

| Option | Verdict |
|---|---|
| A. Zod fields per route, hand-written per flow | No: the workflows and a live view would each copy the same knowledge |
| B. A declared facet set per surface (name, UI label, values, url / api / ui applier), the route schema, the workflow inputs and the view's events all built from it | **Chosen**. One source; a UI reads the catalog; adding a filter is one entry |
| C. No declaration: an agent finds and clicks filters by their label each time | No: a model call per filter change, slow, not repeatable; kept as the fallback for an unmapped site |
| D. Each filter recorded as its own compiled workflow, composed | No: N workflows per site, and no URL shortcut where the URL carries the filter |

Ranked by: one source for every caller (routes, workflows, views, a UI), the fewest page loads per change, then repeatability.

### Presets (William: "defaults for the config … presets for common search filters … shorthands")

| Option | Verdict |
|---|---|
| A. One grammar on every surface: `latest` or `top`, `day`/`week`/`month`/`year`, or paired (`top-week`); a surface lists only what it honors exactly; explicit facets beat the preset | **Chosen**. The agent learns one line; never lossy; a 400 names what a surface takes |
| B. Shared abstract params (`sort`, `since`) mapped per platform | No: two names for one thing, lossy where a platform lacks it (Threads has no time) |
| C. Preset names per site | No: learned again per site |
| D. No presets; native facets each call | No: more tokens and more mistakes per call |

Ranked by: tokens the agent spends per call, then exactness, then one vocabulary.

- No input runs the platform's default search, as before. Zod fields are all optional; `resolve` fills explicit, then the preset's, then the default, at the call (a window preset's time is relative to now).
- Context: the route summary carries one `preset` line (`presetWords`); the skill one section; `autobrowse facets <site>` the full table. Nothing more in every call's context.
- Engine: birdwatch passes `preset` through; its own `sort`/`since` plan is dropped.

### Names

| Option | Verdict |
|---|---|
| A. The platform's own names and values (LinkedIn `contentType`, Reddit `t`, X API `sort_order`) | **Chosen**. Full coverage, no lossy mapping; a value the platform lacks is a 400 |
| B. One shared vocabulary (`sort: top|recent`, `since`) | No on routes: lossy (LinkedIn `postedBy`, Reddit `comments` have no shared word). It belongs one level up, in birdwatch's query |

## Inventory

How each platform's search offers filters. "API" wins where it covers the surface.

| Platform, surface | Filters | Reach | State |
|---|---|---|---|
| LinkedIn posts search | sort latest/relevance (`sortBy`); date 24h/week/month (`datePosted`, route `since`); content type (`contentType`); posted by 1st/me/following (`postedBy`); author job title (`authorJobTitle`, route `authorTitle`); author company, industry, from member, mentions (ids) | URL; no API (LinkedIn has no search API for us) | phase 1 |
| X search | Top/Latest (`f`), time (`since_time:`/`until_time:`), the rest by operators (min_faves, lang, filter:media, from:, -filter:replies) | URL. The API bills every read, so the page stays | phase 1, as the API's names `sort_order`, `start_time`, `end_time` |
| Threads search | Top/Recent (`filter=recent`) | URL. The keyword API finds only our own posts until Meta's review | phase 1, as the API's `search_type` |
| Reddit search | sort relevance/hot/top/new/comments, time `t` | URL (old.reddit). Reddit refused us an API client | had; phase 1 declares it |
| Google | time `tbs=qdr:h|d|w|m|y` | URL | phase 1. `tbm` news/videos: phase 2 (other layouts) |
| YouTube search | order, publishedAfter/Before, videoDuration, videoDefinition, type, regionCode, relevanceLanguage, eventType, channelId | Data API (`GET /youtube/v3/search`, already through `/youtube/v3/{resource}`) | phase 1 declares it, api facets |
| Instagram search | none on the web (Top only). Graph `ig_hashtag_search` + `top_media`/`recent_media` needs Meta's Public Content Access review | - | phase 2: ask for the review |
| TikTok search | date posted, sort relevance/most liked | the filter panel (the page's signed call carries `publish_time`, `sort_type`; a changed URL breaks the signature) | phase 2: map the panel live, ui facets |
| YouTube web, Amazon, Google Maps, others | their filter rails | ui or URL | phase 2: audit live, one facet set each |

## Phases

1. The facet core (`facets.ts`: set, zod, URL and API appliers, catalog CLI). Sets for LinkedIn posts, X, Threads, Reddit, Google, YouTube. Route schemas built from them. One live read per new LinkedIn filter.
2. A live audit of each UI's filter rail (explore, one site at a time, reads only): TikTok, Instagram, YouTube web, Amazon, Google Maps. `ui` facets (control hints, option hints) and their sub-step in compiled workflows.
3. Live views: `view open|set|read|close` on the desk (Restate, keyed by view id), a parked pinned page per view, idle close. A UI sends `set` events.

## Rules

- Defaults never move: each route keeps today's order (LinkedIn and Threads newest first, X Latest, Reddit new) unless the caller asks.
- No drifted names (William, 11-03): LinkedIn `since` and `authorTitle` became `datePosted` and `authorJobTitle` in autobrowse, wren (setting, CLI, reads, a key-rename migration) and birdwatch. The LinkedIn search schema is strict: an old name is a 400, never a silent unfiltered search.
- An id filter takes the platform's ids, checked by shape: LinkedIn company and industry numeric, a member `ACoA…`.
- Bot safety: a filter change on a view is a person's change (one reload or one click at hand pace), never a burst.

## Then

- birdwatch (engine, birdwatch dev session): `Query.preset` passed to each source's route as `preset`; a source whose route lacks it says so.
- Instagram hashtag Graph route `meta GET /instagram/tags/{tag}` is built; Meta answers code 10 until the Public Content Access review (proven 2026-11-03). Threads `keyword_search` returned only our own posts (7 of 7, 2026-11-03).
- LinkedIn id filters (author company, industry, from member, mentions) and people filters (geo, industry, past company, language) wait for the live panel audit: the desk held linkedin@wren.

## Decision log

- 2026-11-03: Facet sets, one per surface, feed routes, workflows, views and a UI (option B). Native names (William: "leverage their existing UIs"; my ranking above).
- 2026-11-03: X and Threads web routes take their API's names (`sort_order`, `start_time`, `search_type`), so a caller switching legs changes nothing.
- 2026-11-03: LinkedIn id filters take ids only; a name-to-id typeahead waits for a need.
- 2026-11-03: Instagram hashtag Graph search waits on Meta's review; until then the web search (no filters).
- 2026-11-03: Presets, one grammar (option A above). Defaults leave zod for `resolve`, so a preset can override one and an explicit value a preset.
- 2026-11-03: No drifted names: the LinkedIn rename runs through wren and birdwatch (William: "no unnecessary drifted old names").
- 2026-11-03: YouTube search gets its own route before the generic read: typed facets and presets; other `search.list` params still pass (`.loose()`).
