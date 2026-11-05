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
  - `final`: why the browser is the answer for good (no API has this call; the API bills what the page shows free; a program closed to new apps).
  - Never `final`: a call an API gives after a review, an audit or a beta we can ask for. That route `waits`, filed or not (William, 11-05). A `final` reason that names a review fails the test.
  - `waits`: a blocker's id. The route is a fallback for now. On an API route: a better way is gated (a webhook).
- `SiteApi.blockers?: Record<string, { what; task?; since; grants? }>`: the short list of things a site waits on. One blocker covers many routes. The entries live in `src/sites/blockers.ts`; an id is wren's review id where one exists (`meta-app`, `tiktok-direct-post`, `linkedin-pages`).
- `grants`: the grants a blocker gives when it clears. It ties a route's `needs` to the blocker.
- Derived, never stated (`standingOf`): an API leg whose grant is not held waits on the blocker that gives the grant; a route with both legs and no token waits on `connect` (a setup step, ours to run).

### The rule the test holds

| Route | Must state |
|---|---|
| Browser only | `final` or `waits` |
| `prefer: "browser"` | `final` |
| API and browser | nothing (derived); never `final`; `waits` only when a better gated way exists |
| API only | nothing; `waits` only when a better gated way exists |
| Any `waits` | names a blocker the site lists |
| A fixed `needs` grant | a blocker of the site gives it |
| A blocker | a route waits on it, or it gives grants |
| Any `final` | a reason that names no review, audit, approval or beta |

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

229 routes settled (85 of them the browser for good), 36 waiting, 0 with no leg. Each `final` was checked against the site's API docs on 11-05 (WA-1109).

| Blocker | Waits on | Routes |
|---|---|---|
| `reddit-devvit` | Reddit's external-endpoints beta (WA-fdxh, filed 10-24): our own posts, replies and inbox only | 13 |
| `linkedin-pages` | Community Management review (WA-1032, filed 10-09) | 6 |
| `meta-app` | Meta App Review, after business verification (WA-1048) | 6 |
| `tiktok-business` | TikTok API for Business, Accounts API: not filed (WA-1030) | 3 |
| `tiktok-direct-post` | Direct Post audit, not filed | 1 |
| `connect` | our own setup: no Outlook token | 7 |

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
- 2026-11-05 (WA-1109): cost and a closed program stay `final`: X reads (billed), X follow and like (off every self-serve tier since 2026-04-16), Google Places (billed), LinkedIn partner programs (closed to new apps).
