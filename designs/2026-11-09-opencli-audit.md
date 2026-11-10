# OpenCLI audit: what to take, what to leave (2026-11-09, WA-1251)

William, 11-09: "OpenCLI is almost just a better version of autobrowse", "do a full audit and
explain what we should take from them, what they have we shouldn't take, what's more mature
about their ecosystem and design". Also: "opencli driving our chrome is also nice", "should we
also do cdp support for autobrowse".

Source: github.com/jackwener/opencli 2.0.3 (Apache-2.0), read 11-09. Refs `R/` are its repo.

## The answer

OpenCLI is not a better autobrowse. It is a better **catalog of reads**. The two tools solve
different halves of one problem:

- **OpenCLI:** about 1,000 commands on 170 sites. Each command knows one site's internal JSON
  endpoint, and runs it in a browser where a person already signed in. 31k stars and 30
  contributors find and fix site changes every week (LinkedIn 16 adapter commits in 90 days,
  X 18, Instagram 7).
- **autobrowse:** runs accounts safely and unattended. It signs in by itself (credvault, 2FA),
  keeps one Chrome profile per account, holds caps and a human pace per site, writes a ledger,
  gates money and posts, and compiles an agent's browse into a durable workflow.

OpenCLI has none of the second half. autobrowse has only a small part of the first half
(about 100 browser legs on 8 sites, reads and writes; 4 flows call a site's JSON in-page). So: take their catalog and a few design parts.
Keep our runtime.

## Point by point

| Point | OpenCLI | autobrowse | Better |
|---|---|---|---|
| Browser | The person's own Chrome through an extension + daemon (`R/src/daemon.ts`); or one CDP endpoint (`OPENCLI_CDP_ENDPOINT`, `R/src/browser/cdp.ts`). Launches no Chrome | One Chrome profile per account, launched and owned (`browser/session.ts`); also attaches by CDP (`BROWSER=cdp`), Browserbase, the person's own browser (`own.ts`) | autobrowse for unattended work; OpenCLI for "use what I am signed in to" |
| Sign-in | None. Waits up to 300 s while a person signs in (`R/clis/_shared/site-auth.js:47`) | Stored logins, TOTP, SMS and mail codes, passkeys, sign-in providers | autobrowse |
| API before UI | A fixed `strategy` label per command (PUBLIC, LOCAL, COOKIE, INTERCEPT, UI). No fallback at run time: "execution never reads `cmd.strategy`" (`R/src/registry.ts:173`) | Per route: the official API leg, then a `browser` leg; `standing` says why a browser leg is final or what the API waits on | autobrowse's rule; OpenCLI's label is a good word for the browser leg's kind |
| Endpoint knowledge | 576 COOKIE commands: the site's own JSON endpoint called by `fetch` inside the signed-in page | The same pattern in 4 flows (reddit `.json`, instagram-act, linkedin-reach, learn); most browser legs read the DOM | **OpenCLI, by far** |
| Pace and caps | None by default. Opt-in `OPENCLI_SITE_SLOTS` (a queue with spacing); no daily caps; typing is instant `Input.insertText` | Daily caps per site and account, gap + jitter per site (`limits.json`), keystrokes at 65–95 ms, mouse paths | autobrowse |
| Anti-detection | A JS patch per page (`R/src/browser/stealth.ts`: webdriver, plugins, `cdc_` globals, stack traces) | Patchright (patched at the driver, not in page JS), a fingerprint per profile, human hands | autobrowse: a page can detect a JS patch; it cannot see a driver patch |
| Writes | `access: read|write` label; a 45 s write lease per tab (`R/src/session-lease.ts`); nothing stops a read command from writing | Payment gate, send/post gates, verdicts, a send journal, caps on every write | autobrowse |
| Compiled flows | JS `cli({func})` or a `pipeline: [...]` of steps; YAML adapters are no longer loaded (`R/src/discovery.ts:299`). An agent writes the file by hand | Explore journals every act; compile renders a typed workflow; durable reruns (`code`); heal patches one step | autobrowse |
| Repair | `opencli-autofix` skill: trace, classify, patch one file, max 3 rounds, then draft an upstream issue. No automatic trigger | Repairer + `fixes.json` at run time; heal re-renders the broken step, proves it | autobrowse in mechanism; **OpenCLI in the write-up** (error classes, "empty is not broken", never loosen a fixture) |
| Health | `doctor` checks daemon + extension; `adapter test` runs a command against a saved fixture (row count, columns, types, patterns); weekly live smoke in CI | `doctor` makes one live call per site; proof shots; no per-route status | **OpenCLI**, on per-command fixtures. Neither has a status with `checked_at` per route |
| Agent contract | `{ok,data}` / `{ok:false,error{code,message,hint}}`, 13 error codes, exit codes by class (66 empty, 75 busy, 77 auth, 78 config) | JSON out, exit 1 on failure, error text | **OpenCLI**: an agent can branch on a code |
| Tests | Mocked `page` per command (`R/clis/instagram/user.test.js`), weekly live smoke, daily headed E2E | Fixture pages, live tests by hand | **OpenCLI** on coverage per command |
| Data | Rows cut for a terminal table: Instagram caption to 100 chars, no media id, URL or play count (`R/clis/instagram/user.js`) | Keep every field a call returns (rule, 11-08) | autobrowse |
| Ecosystem | Plugins from git (`R/src/plugin.ts`), user overrides, a lock file, hooks; skills for agents; `llms.txt`; 100+ releases | One repo, our sites only | **OpenCLI** |

## What is more mature in OpenCLI

1. **Breadth with upkeep.** 170 sites, fixed by many users. A site change on LinkedIn reaches
   them within days. We find ours only when a run fails.
2. **One small page interface.** Every command takes one `IPage` (`R/src/types.ts:72`). Most use
   four methods: `evaluate` (1,175 uses), `wait`, `goto`, `getCookies`. A command is portable to
   any browser that gives those.
3. **Typed errors with hints and exit codes.** `AUTH_REQUIRED` says "sign in", `EMPTY_RESULT`
   says "nothing, not broken", `outcome:"unknown"` marks a write that may or may not have
   landed. Our errors are text.
4. **Fixtures per command.** `adapter test` checks shape, not values: row count, columns,
   types, patterns. That survives content change and still catches a site change.
5. **The skills.** adapter-author and autofix are short, concrete procedures. Their evidence
   ladder (public API, then in-page fetch, then captured responses, then page state, then UI)
   is the same as our rule, written better.
6. **Help for agents.** `llms.txt`, `[read]`/`[write]` in help, `--format json` on every command.

## How their commands are made, and are they compiled

- **Written by an agent, not compiled.** The `opencli-adapter-author` skill has an agent
  (Claude Code and others) collect evidence with `opencli browser open|state|network`, find the
  endpoint, then write the JS file. `adapter init` writes only a stub. Help for the agent:
  `src/browser/discover.ts` reads the page's script bundles for endpoints (never runs them),
  and a 24 h cache of captured calls.
- **They had a compiler and removed it.** `explore`, `synthesize`, `generate`, `cascade` and
  `record` (a live recorder that captured calls) were deleted in #1094: "agent-facing
  scaffolding that the new skill handles more flexibly". Recording was too rigid for them.
- **Deterministic when run, not when made.** A saved command runs the same code each time. But
  two agents asked for the same command write different code; nothing ties the file to a
  recording. No journal, no durable rerun (a failure at item 37 starts over), no step-level heal.
- **Site memory.** The skill keeps `~/.opencli/sites/<site>/` per machine: endpoints, a field
  map, notes, fixtures, added to on every run. Worth taking (see T7).
- **Ours:** explore journals every act, compile renders it into a typed workflow, a rerun skips
  saved calls, heal re-renders the one broken step. Ours is the stronger build system. Theirs
  is the stronger **discovery**: their skill finds the JSON behind a page (network, then
  `__INITIAL_STATE__`, then the script bundle, then the token, then an interceptor) where our
  explore mostly records clicks and reads the DOM.

## Their write commands

Good knowledge, risky execution.

- **Knowledge, good:** the endpoints and selectors are current, and each write checks for
  proof it landed (Instagram follow fails on "no success evidence"; `outcome:"unknown"` when
  it cannot tell). LinkedIn `safe-send` opens the exact thread and checks it first.
- **Execution, risky for Wren's accounts:**
  - Clicks are `element.click()` inside page JS (`clis/twitter/follow.js:48`,
    `clis/linkedin/connect.js:303`). The event has `isTrusted: false` and no mouse path: a site
    can tell it from a person.
  - Text goes in at once (`Input.insertText`, `execCommand`): no keystrokes.
  - Many writes skip the UI entirely: Instagram follow is a `POST /api/v1/friendships/create/`
    with no page action before it. Easy for a site to flag at volume.
  - No caps; a 0.45–1.15 s jitter in a few LinkedIn commands; pace otherwise up to the caller.
- **So:** take the endpoints, selectors and success checks; run every write through our
  Hands, caps, gates and send journal.

## B or C, again (William leans B: "we can own the code")

| | B. Port, own the code | C. Shim, run theirs |
|---|---|---|
| Code | Ours: our types, our style, full fields | Theirs, vendored; their row mapping cuts fields (we keep raw JSON from network capture) |
| Their fixes | Lost, unless we watch for them | A version bump |
| Writes | Run through our Hands | Their `element.click()`: not safe to shim |
| Breadth | One route per port (an agent ports one in minutes) | All reads at once |
| Upkeep | Our routes only | Facade (about 25 methods) + vendored files |
| Debugging | One code base | Two styles, their errors inside ours |

**Recommendation, revised: B, with an upstream watch.** Each ported route records the
upstream file and commit it came from (`ported: "instagram/user.js@9bc5f5c"`). A weekly job
diffs those files against upstream main and opens a task when one changes, with the diff. We
own the code and still learn of their fixes within a week. That removes B's main cost. C's
breadth is worth little: Wren needs about 40 of their reads, not 1,000, and writes cannot be
shimmed at all.

## Take

| # | What | Where it goes | Size |
|---|---|---|---|
| T1 | Their endpoint knowledge for reads: in-page `fetch` against the site's JSON | A route kind for site routes (see the options below) | Large |
| T2 | Typed errors: `code`, `hint`, exit codes by class, `outcome:"unknown"` for an unsure write | `src/sites/facade.ts` answers and the CLI | Medium |
| T3 | Shape fixtures per route (rows, columns, types, patterns), run live on a schedule | `autobrowse sites check`; a desk job weekly | Medium |
| T4 | A status per route: `ready / needs_login / cooldown / needs_person / broken / unchecked` + `checked_at` (Agent-Reach's form) | `doctor` and `sites status` | Small, after T3 |
| T5 | The `strategy` word on each browser leg (`cookie`, `intercept`, `ui`) | `SiteRoute.browser`; shown in route lists | Small |
| T6 | Autofix's rules in our heal skill: classify first, "empty is not broken", never loosen a fixture, 3 rounds | `.claude/skills/autobrowse/explore.md` | Small |
| T7 | Their discovery: the 5-layer search for the JSON behind a page, `discover` over script bundles, site memory (endpoints, field map) per site | explore skill + an explore command | Medium |
| T8 | Agent-facing surface: one shape per command (`site cmd --format json`), `[read]`/`[write]` in help, `llms.txt`, short skills | CLI help, README, skill | Medium |
| T9 | Their write knowledge (endpoints, selectors, success checks), run through our Hands | our write routes | Per route |

## Do not take

| What | Why |
|---|---|
| The extension + daemon in William's own Chrome | His personal accounts; one profile for everything; a second browser stack beside ours |
| Their stealth script | A page can find a JS patch. Patchright is stronger, and two layers can conflict |
| Instant typing, no caps, no pace | The fastest way to get Wren's accounts flagged |
| Their write commands as they are | No gates, no caps, no send journal. Our write routes stay ours; their code is a reference only |
| Their row mapping | It throws away fields. We keep the raw JSON |
| Plugins from any git URL | Code from a stranger runs in-process with no sandbox. Our flows touch signed-in accounts and cards |
| YAML pipelines | They dropped them too |
| One flat `site/command` name space | Our routes are HTTP-shaped (`GET /web/...`) behind one facade with caps per bucket; keep that |

## How to get their reads: options

Priorities, in order: no ban risk to a Wren account; no secret leaves autobrowse; keep every
field; the most sites for the least upkeep.

| Option | How | For | Against |
|---|---|---|---|
| A. Run OpenCLI as is | Their CLI, extension in William's Chrome | All of it at once | Personal accounts, no caps or pace, second stack. **Rejected** |
| B. Port by hand | Read their command, write our route with the same endpoint | Full data, our style, our tests | One route at a time; their fixes do not reach us; we track 170 sites by hand |
| C. Adapter shim | Vendor their read commands at a pinned version. A site route leg runs a command's `func(page, args)` against our Chrome through an `IPage` facade over our `FlowPage`. Our network capture keeps the raw JSON each in-page `fetch` gets, so no field is lost. Caps, pace, ledger, account choice: ours, as for every route | Breadth at once; their fixes come in by a version bump we review as a diff; Apache-2.0 allows it (keep their NOTICE) | Facade upkeep (about 25 methods, 4 used most); their code runs in our pages (we read every file we vendor; reads only); a bump can break a route (shape fixtures catch it) |
| D. OpenCLI over CDP to our Chrome | Our Chrome opens a debugging port; their CLI attaches by `OPENCLI_CDP_ENDPOINT` | Their CLI unchanged, in our profiles | The port gives any local process every cookie in the profile; their calls skip our caps, pace and ledger. Only for an explore session a person watches |

**Recommendation: C for reads, B for the routes Wren leans on, D only as an explore flag.**

- C gives the catalog with our safety. The raw-JSON capture answers the data rule.
- B where a route matters enough to own it (Instagram profile feed for WA-1250, LinkedIn
  search): full fields, our tests, no vendored code on the hot path.
- D: `autobrowse explore --cdp-port` binds 127.0.0.1 for one session, off by default, never on
  the desk. Useful to try a command of theirs live before we shim it.

On "CDP support for autobrowse": attaching to a CDP endpoint is built (`BROWSER=cdp`,
Browserbase, `own.ts`). Serving one from our Chrome is option D, and stays explore-only.

## Sites useful to Wren (reads first)

| Site | Their reads worth having | We have |
|---|---|---|
| Instagram | user (feed by username), profile, followers, following, search, explore, saved | Graph API own account; web posts, comments |
| LinkedIn | people-search, company, profile-read/-experience, posts, post-analytics, profile-analytics, connections, inbox, timeline, salesnav-search/-thread/-inbox | posts, activity, analytics, notifications, audience flows |
| TikTok | user, creator-videos, following, friends, notifications, explore, search | official API own account; web posts, following, search, comments, analytics |
| X | search, profile, tweets, thread, timeline, followers, following, likes, lists, trending, bookmarks | official API v2 |
| Reddit | search, subreddit, read, user, user-posts/-comments, subreddit-info | most of these as browser legs |
| YouTube | search, video, channel, comments, transcript, playlist | Data API |
| Facebook | search, feed, groups, events, marketplace | public group posts signed out |
| Upwork | search, feed, detail | none |
| Product Hunt, Hacker News, Bluesky, Substack, Medium, dev.to, Indeed, Pinterest | public or cookie reads | HN search only |

Account rules hold: LinkedIn signed-in reads only as `linkedin@wren`, under its caps, and a
LinkedIn profile reader still needs William's yes (10-28 design). Facebook stays signed out
(the ad account). Writes stay on our routes.

## Full upgrade list (nine facets)

Facet reports: `2026-11-09-opencli-audit/` (runtime, primitives, discovery, catalog, reliability,
testing, agentux, stealth, code-quality). Merged and deduped here. None of these waits on B vs C.

| # | Upgrade | Facets | T | Size |
|---|---|---|---|---|
| **Wave 1: contracts (every route gains)** |||||
| U1 | One error contract `{code, message, hint, retryable, outcome, exitCode, artifacts}` in a new `src/errors.ts`, mapped from `SiteError`, `AccessRefused`, `FlowFailed`, gate refusals at the facade edge. CLI answers `{ok, data\|error}` as JSON by default, with an exit-code table. Today 40 error classes have no common base | code-quality, reliability, agentux | T2 | M |
| U2 | A zod `response` schema on `SiteRoute`, checked in the facade for both legs; remove the type erasure in `route()` (`types.ts:341`) | code-quality | T3 | M |
| U3 | Hand-written `BrowserFlow` gets a zod `input` and `summary`; a committed `catalog.json` with a test that fails on a dropped route, flow or workflow; one paged `autobrowse list [query]` and `--help --json` with `next` hints, in place of four finder commands | catalog, agentux | T8 | M |
| U4 | Convention audit for routes and flows in the gates; a route scaffold command | code-quality | | S |
| U5 | The `strategy` word on each browser leg | | T5 | S |
| **Wave 2: correctness and account safety** |||||
| U6 | Command ids on the explore loopback: a retried `click` or submit runs once; `outcome: "unknown"` when the browser dies mid-act | runtime | T2 | M |
| U7 | Dialog handling: today an unhandled `confirm` or `beforeunload` is dismissed silently | primitives | | S |
| U8 | Ban-signal table per site (suspended, restricted, checkpoint, "unusual activity", 429) wired into `caps.hold` and the 1/3/8/12 h steps | stealth | | M |
| U9 | Warm-up ramp by account age (`firstSeen`), per-hour and quiet-hour limits, a cap guard on explore, no `instantHands` on acts for capped sites (WA-1148) | stealth | | M |
| U10 | Own-browser tab hygiene: a background window, a `{pid, targetId}` ledger, stale-tab reap | runtime | | M |
| **Wave 3: reads and discovery** |||||
| U11 | An `api` op in the compiler and the `code` runtime, on one in-page `pageJson` helper (sign-in wall check, named headers, cursor loop, repeated-cursor error). Replaces the hand-written in-page fetches in five flows (reddit, instagram-act, instagram-reels, linkedin-reach, learn) | discovery | T1 | M |
| U12 | `discover` in explore: response shapes with types keyed by operation, a field filter, a scan of the page's scripts; network capture on by default in explore | discovery | T7 | M |
| U13 | Per-site `endpoints.json` and `field-map.json` (redacted), written from kept sessions, read by explore and heal | discovery | T7 | S |
| U14 | A numbered `state` read (scroll-aware, hidden nodes out, stale marks matched again); `wait` barriers; download capture after a click | primitives | | M |
| U15 | A read-only tab pool per profile with a bounded queue: parallel reads, serial writes | runtime | | M |
| **Wave 4: health** |||||
| U16 | Proof `expect` fixtures (`rowCount`, `types`, `patterns`, `notEmpty`, `mustNotContain`), seeded from the first good proof | testing | T3 | S |
| U17 | Weekly `site-probe` and a re-proof of every compiled workflow, with typed failures, into `autobrowse success` | testing | T3 | M |
| U18 | `autobrowse auth status` per profile with no sign-in; status per route (`ready / needs_login / cooldown / needs_person / broken / unchecked`); `doctor` gives `issues[]` and exits nonzero | reliability | T4 | S |
| U19 | An artifact link on each flow-run and site-call row and on the error; trace retention caps | reliability | T6 | S |
| U20 | Heal rules from their autofix: classify first, empty is not broken, never loosen a fixture, 3 rounds | | T6 | S |
| **Wave 5: agent surface and later** |||||
| U21 | The skill and a generated `llms.txt` in the npm package; `autobrowse skills list\|read\|install` | agentux | T8 | S |
| U22 | An `evals/` suite with a judge, a train/test split and a baseline, run through `agent --json` | testing | | L |
| U23 | Before/after-call hooks; a mod may add a `SiteApi` (today `SITES` is closed), under the sha256 `--trust` model | catalog | | M |

Small fixes to batch in: explore version in `ExploreInfo` with a skew warning; the holder's op and
age in `ProfileBusy`; split `flow.ts` (1457 lines) and `facade.ts` (1144); the stray doc comment
near `types.ts:178`.

Order: U1 first. Its shape is a hard-to-change contract (every caller, wren included), so it
gets its own options section before the build. U2, U4, U5 next; U7 and U8 before any new write
route.

## Build (William's go, 2026-11-09)

Tasks: WA-1251.1 to .6.

### Error contract (WA-1251.1)

Priorities: no change on the wren seam; an agent branches on one field; least churn.

| Option | How | For | Against |
|---|---|---|---|
| **A. Extend what exists** | `ErrorCode` (HTTP) and `ACCESS_CODES` (the wren seam) stay. A new `src/errors.ts` maps any thrown error to `{code, message, hint, retryable, outcome?, status}`. The CLI prints it as one JSON line and exits by class | wren and weaver see no change; one mapper | 40 error classes stay as they are |
| B. One base class | Every error extends `AutobrowseError` | Types carry the code | 40 classes touched; the wire is the same as A |
| C. OpenCLI's codes | Their code list | Matches their docs | Breaks the wren seam |

**Chosen: A.** B can follow class by class, when a class is touched.

Exit codes (sysexits): 0 ok; 1 other; 2 bad input (`bad_request`, `invalid_*`); 66 not found;
69 the site failed (`upstream_error`, `upstream_broken`, `unavailable`); 75 try later
(`rate_limited`, `conflict`); 77 no access (`need_login`, `platform_blocked`, `unauthorized`,
`forbidden`, a refused gate); 78 not set up (`not_configured`). `outcome: "unknown"` when a write
may have gone through (`MAY_HAVE_GONE`, a verdict of `unknown`).

### Strategy ladder (WA-1251.2)

Priorities: account safety, keep every field, uptime, upkeep.

| Option | How | For | Against |
|---|---|---|---|
| **A. Rungs inside one flow** | `ladder(fp, rungs)` in `src/browser/ladder.ts`. Each rung has a strategy (`cookie`, `intercept`, `ui`) and a run. The flow declares `strategies`; route lists show them | One page, one profile lock, one pace slot: no extra traffic to drop a rung | The facade sees a rung only through the run log |
| B. One flow per rung, in the facade | `browser: BrowserLeg[]` | The facade logs each leg | Each drop opens the page again and takes another pace slot: more traffic on the account |

**Chosen: A.** A rung falls to the next only on `RungBroke`: a 404, a body that is not JSON, a
shape check that fails. A 429, a ban or block signal, a cap, a sign-in wall or a captcha throws at
once and holds the route (William: "early exits on 429 warnings"). Each fall is kept on the flow
run row (`fell: [{strategy, why}]`) and the answering strategy as `via`.

`public` JSON (no session) is an `api` leg on an open site, not a rung: it needs no browser.

Each route gets `access: "read" | "write"`: GET is read, any other method is write unless the
route says `access: "read"` (a POST search). A label only: no gate, explore unchanged.

### In-page JSON and intercept (WA-1251.3)

- `pageJson(fp, {url, headers, cursor})` in `src/browser/page-json.ts`: the site's own JSON with
  the session's cookies. A sign-in wall in the body is `need_login`; 429 is `rate_limited`; 404 or
  HTML is `RungBroke`. A cursor that repeats stops the loop.
- `captureJson(fp, {match, open, more})`: open a page, keep every JSON response whose URL matches,
  scroll for more. Whole bodies, no field dropped.
- The five hand-written in-page fetches move onto `pageJson`. The reels route gets an intercept
  rung, so a personal account's reels come back as whole items, not only links.

### Explore sees the JSON (WA-1251.4)

Capture was turned off on 10-09 because failed flows dumped logs and HTML into the agent's
context. The cost was the dump, not the capture.

- Explore sessions capture by default (`AUTOBROWSE_NETWORK=0` turns it off). Flows outside
  explore stay off by default.
- `network` shows JSON calls grouped by URL shape: count, status, size, top keys. Pages, scripts
  and images are left out unless `all`.
- `network {find: "<text>"}` names the calls whose body holds the text, with the key path: the
  text on the page leads to its JSON in one command.
- `network {id, pick: "<path>"}` gives one part of a body.

### Ports (WA-1251.5) and the upstream watch (WA-1251.6)

Port by hand (B). Each ported route says `ported: "clis/<site>/<file>@<sha>"`. All reads go
through the autobrowse facade (William: one source of truth). Public JSON sites are open sites
with `api` legs; signed-in sites get flows with rungs. Each route gets one live test.

`autobrowse sites upstream` lists each ported file whose upstream copy changed since its sha;
`--task` opens a backlog task for each. It runs weekly.

## Plan once William picks

1. Wave 1 (U1 with its options first).
2. ~~WA-1250~~ done (d35159a): `meta GET /instagram/{username}/reels` (Graph) and
   `instagram GET /web/{username}/reels` (feed call, then the Reels grid).
3. B: port the reads in the table above, each with a shape fixture (U16) and one live test,
   each marked `ported: "<file>@<sha>"` for the upstream watch.
4. Waves 2 to 4.

## Decision log

- 2026-11-09: OpenCLI is a read catalog, not a runtime to adopt. Its runtime lacks sign-in,
  caps, pace, gates and per-account profiles (table above).
- 2026-11-09: Port vs shim: first recommended C + B + D-explore-only; settled below.
- 2026-11-09: William picked T1–T6 plus friendlier agent skills (T8) and step labels (T5); writes
  fine to study; personal Chrome out. Recommendation revised to B + upstream watch: he wants to
  own the code, writes cannot be shimmed, and the watch brings their fixes.
- 2026-11-09: WA-1250 proof: their Instagram feed endpoint answers 404 (a signed-out page) from
  our signed-in profile, with or without the page's CSRF, claim and ASBD headers. Their endpoint
  knowledge is a lead, not a working route: every port gets a live test, and a shim (C) would
  have failed the same way. One more point for B.
- 2026-11-09 (William): B, by hand, my call on the balance of upkeep and breadth. Ladder B with
  early exits on 429. A read/write label. Explore gets JSON and network calls by default, token-lean.
  Every listed site wanted, search and AI answer engines too. All reads through the autobrowse
  facade. Workflows for design-reference and catalog sites later.
- 2026-11-09: Error contract A (extend the codes in place); ladder A (rungs in one flow).
- 2026-11-09: Built .1–.4. Reels live: cookie fell (404), intercept answered 20 whole reels from
  the Reels tab's GraphQL (12 a load, 3 a scroll, `clips_connection`). A RungBroke outside a
  ladder is `flow_broken`. GraphQL query names and doc ids are kept unredacted: a long name read
  as a token and a doc id as a card run, which hid the one thing a reader looks for.
- 2026-11-09: The network view groups by URL shape and query name instead of one line per call:
  a page fires 30+ calls to one `/api/graphql`, alike by URL. `rowLine` is gone (no user left).
