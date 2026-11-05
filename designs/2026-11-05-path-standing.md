# Path standing: which way each route answers, and whether a better way waits (WA-1104)

## Goal

One command says, for every route: the API answers (done), the browser answers for good (done), or the browser answers for now and names what it waits on. A person never keeps this in their head. The code states it, and a test holds it.

## What the code knows now

264 routes on 21 sites (11-05).

| Routes | Count | Known | Not known |
|---|---|---|---|
| API only | 131 | The API answers | Whether a better gated way exists (a webhook in review) |
| API and browser | 28 | `site status` gives `via` per account: the API when a token and its grants are held. 11 name grants (`needs`) | Nothing |
| Browser only | 105 | The browser answers | Whether no API exists, or one waits on an approval |
| `prefer: "browser"` | 4 | The page is chosen over the API | The reason is a comment, not data |

The call ledger (`calls-YYYY-MM.jsonl`) does not record which leg ran.

## Options

| Option | Verdict |
|---|---|
| A. Each route states its standing in code; a report and a test read it | **Chosen**. One source, beside the route. A new route cannot skip it |
| B. A table beside the code (markdown or YAML) | No: it drifts the day a route changes |
| C. A sidecar service or a database | No: the facts are fixed statements plus the grants held. Nothing to run |
| D. Read only the call ledger | No: it shows which leg ran, not why, and not what we wait on |

Priorities, in order: cannot drift, costs a person nothing to keep, answers "what do we wait on" in a few lines.

## Shape

- `SiteRoute.standing?: { final: string } | { waits: string }`.
  - `final`: the browser is the best way there will ever be. Two reasons only: no API has the call at any tier (it is the site's internal one), or we can never hold the API (academics only; an API for our own content, asked about someone else's).
  - Never `final`: a call some API gives or could give us. After a review, an audit or a beta; by paying; on an enterprise or partner program, however far off; by a leg of ours not built. That route `waits`, asked for or not (William, 11-05). A `final` reason that names a review, a price or a partner program fails the test.
  - Cost is never a reason for `final`. Why (William, 11-05): the browser meets 403 and 429, and past about 20 users it needs proxies, many IPs and more machines. The API is direct and its failures say what failed. The browser is right for a few users, not the top choice.
  - `final` may carry a note: where an API gives a shallow part of the answer, the reason names it as a first pass (LinkedIn company lookup).
  - `waits`: a blocker's id. The route is a stand-in for now. On an API route: a better way is gated (a webhook).
- `SiteApi.blockers?: Record<string, { what; task?; since; grants? }>`: the short list of things a site waits on: a review, a grant, a beta, a paid or partner API, a leg of ours not built. One blocker covers many routes. The entries live in `src/sites/blockers.ts`; an id is wren's review id where one exists (`meta-app`, `tiktok-direct-post`, `linkedin-pages`).
- `grants`: the grants a blocker gives when it clears. It ties a route's `needs` to the blocker.
- Derived, never stated (`standingOf`): an API leg whose grant is not held waits on the blocker that gives the grant; a route with both legs and no token waits on `connect` (a setup step, ours to run).

### The rule the test holds

| Route | Must state |
|---|---|
| Browser only | `final` or `waits` |
| `prefer: "browser"` | `waits` (what holds the API leg back) or `final` |
| API and browser | nothing (derived); never `final`; `waits` only when a better gated way exists |
| API only | nothing; `waits` only when a better gated way exists |
| Any `waits` | names a blocker the site lists |
| A fixed `needs` grant | a blocker of the site gives it |
| A blocker | a route waits on it, or it gives grants |
| Any `final` | a reason that names no review, audit, approval, beta, price, tier, enterprise or partner program |

Code: `standingFaults` in `src/sites/standing.ts`; `test/standing.test.ts` runs it on every site.

## Report

`autobrowse site paths [site] [--waiting] [--final] [--check] [--json]`:

- Settled: counts per site (API; browser for good).
- Waiting: grouped by blocker, with its task, its date and the routes it holds. Each route shows what answers now: the browser, the API, or nothing.
- `--final`: each browser-for-good route and its reason.
- No leg now: a route nothing answers and no blocker explains (a flow to record).
- Drift (`--check`, last 7 days of the ledger): a route whose real leg differs from its stated one; exit 1. The ledger row gains `via` and `template` (the route path with its `{param}` names), set where the facade picks the leg.

When a blocker clears: delete it from `blockers.ts`. The test then names each route to move.

## State on 2026-11-05

185 routes settled (41 of them the browser for good), 80 waiting, 0 with no leg (WA-1110).

| Blocker | Waits on | Asked for | Routes |
|---|---|---|---|
| `reddit-commercial` | Reddit's Data API under a commercial agreement: reads of others, search, messages, joins | No: far off | 23 |
| `reddit-devvit` | Reddit's external-endpoints beta: our own posts, replies and inbox only | Filed 10-24 (WA-fdxh) | 13 |
| `linkedin-partner` | LinkedIn partner programs: closed to new partners now. Cover per route not verified | No: far off | 10 |
| `linkedin-pages` | Community Management review | Filed 10-09 (WA-1032) | 6 |
| `meta-app` | Meta App Review, after business verification | Parked (WA-1048) | 6 |
| `x-paid-reads` | X's pay-per-use API. The API leg answers now; William's cost call of 11-03 holds it back | Ours to flip | 5 |
| `x-enterprise` | X Enterprise: follow, like. Profile edit not verified at any tier | No: far off | 3 |
| `tiktok-business` | TikTok API for Business, Accounts API | Not filed (WA-1030) | 3 |
| `tiktok-direct-post` | Direct Post audit | Not filed | 1 |
| `google-places` | Google Places API, billed per call | Ours to set up | 1 |
| `npm-trust-cli` | Our API leg on `npm trust` | Ours to build (WA-1111) | 1 |
| `instagram-local-upload` | Our API leg on resumable upload | Ours to build (WA-1112) | 1 |
| `connect` | our own setup: no Outlook token | Ours to run | 7 |

The 41 `final` routes: `autobrowse site paths --final`. Each says no API has the call. Three carry a first-pass note: LinkedIn `/company/{company}` (WA-1113), Instagram `/web/p/{shortcode}`, Google `/place/reviews`; Meta `/ads` names the EU-only API.

Not counted as an API: a scraper a vendor runs (SerpApi and the like). It is a browser on another party's machines.

## Decision log

- 2026-11-05: Standing lives on the route, checked by a test (William: "some deterministic way of tracking these two buckets").
- 2026-11-05: Grants and missing tokens are derived from `needs` and `site status`, not stated twice.
- 2026-11-05: The command is `site paths`, beside `site status` and `site check`. `sites` is one command with no group.
- 2026-11-05: A blocker names the grants it gives. A route gated by a grant then needs no stated standing, and a grant with no blocker fails the test.
- 2026-11-05: A route with both legs may state `waits`: the API leg works, and a better way is gated (Instagram comments: a webhook after review).
- 2026-11-05: The ledger records `template` beside `via`. A row's route holds real ids, so drift could not match it to a route without the template.
- 2026-11-05: X's paid-tier routes state `final` (William's cost call of 11-03). A changed call moves them by an edit of one line each.
- 2026-11-05 (WA-1109, William): "for any things that exist after review … they should not be stated final". Instagram search moved to `meta-app` (hashtag search comes with Instagram Public Content Access).
- 2026-11-05 (WA-1109): the docs check found one gated API the 11-03 audit missed: TikTok's Accounts API reads and answers comments on our own videos and gives video insights. 3 routes wait on `tiktok-business`.
- 2026-11-05 (WA-1109): Reddit split. The Devvit app posts, answers and reads our own posts and inbox, so 13 routes wait. Subreddit and search reads, other users, messages and joins are `final`: the Data API is refused for good and the app does none of them. All of `reddit-public` is `final`.
- 2026-11-05 (WA-1109): cost and a closed program stay `final`. **Reversed the same day (WA-1110).**
- 2026-11-05 (WA-1110, William): "Final is like, look, we are using the best option and there is no better option at any point in the future. Or it's just impossible for us to get." Cost is no reason; an enterprise API is one we could hold in the far future. 44 routes moved from `final` to `waits`: X (8), LinkedIn partner (10), Reddit (10) and `reddit-public` (13) on a commercial agreement, Google Places, npm trust, Instagram local upload.
- 2026-11-05 (WA-1110): the WA-1109 Reddit mark was wrong. Devvit still exists and its beta request stands; the app never covered those routes, but a commercial Data API does, so they wait.
- 2026-11-05 (WA-1110): `prefer: "browser"` may state `waits`. X's reads have a live API leg held back by a cost call: a wait whose blocker is ours to lift.
- 2026-11-05 (WA-1110): a blocker may be a paid or partner API or a leg of ours not built, not only a review. One list then answers "what would move this route to the API".
- 2026-11-05 (WA-1110, William): LinkedIn `/company/{company}` stays `final` with a note: the API's shallow lookup (name, website, logo, locations) is a first pass before the page read (WA-1113).
- 2026-11-05 (WA-1110, my call): a vendor's scraper API is not an API here. William may overrule: then `/google` and `/place/reviews` wait.
