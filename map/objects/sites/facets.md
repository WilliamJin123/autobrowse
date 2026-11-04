---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-11-03 @ 2eadcf2+
entity: src/sites/facets/core.ts
---

# Facets

Each search surface's own sort and filters, declared once (designs/2026-11-03-search-filters.md).

- `src/sites/facets/core.ts`: builders `one`, `many`, `text`, `ids`, `time`; `facetSet`; `fields` (zod, all optional, plus `preset`); `resolve` (explicit, then preset, then default); `apply` (a URL or API query, `put` per facet); `catalogOf`; `presetWords` (the route summary's line); `grid` (presets: `latest|top` × `day|week|month|year`).
- `src/sites/facets/sets.ts`: `LINKEDIN_POSTS`, `LINKEDIN_PEOPLE`, `X_SEARCH`, `THREADS_SEARCH`, `REDDIT_SEARCH`, `GOOGLE_SEARCH`, `YOUTUBE_SEARCH`, `INSTAGRAM_TAGS`; `FACET_SETS`.
- Read by: route schemas (`fields`), flows' URL builders (`apply`), pass-through legs (`resolve`: X API, Reddit, YouTube, Meta tags), `autobrowse facets [site]`.
- A change hits: the route's zod, `inputs.gen.ts` (`pnpm gen:flow-inputs`), `test/facets.test.ts`.
