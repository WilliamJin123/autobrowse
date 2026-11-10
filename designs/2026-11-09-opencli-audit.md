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

## Plan once William picks

1. T2 typed errors and T5 the strategy word (small, every route gains).
2. WA-1250: Instagram, in William's order. Graph `business_discovery`; then the feed endpoint
   (`/api/v1/feed/user/{username}/username/`, paged by `max_id`) as a hand-ported route that
   keeps every item field; then `scroll-collect` as the last leg.
3. The shim (C) with the reads in the table above, each with a shape fixture and one live test.
4. T3 and T4: weekly live checks, a status per route.

## Decision log

- 2026-11-09: OpenCLI is a read catalog, not a runtime to adopt. Its runtime lacks sign-in,
  caps, pace, gates and per-account profiles (table above).
- 2026-11-09: Port vs shim: **open, William's call**. First recommended C + B + D-explore-only.
- 2026-11-09: William picked T1–T6 plus friendlier agent skills (T8) and step labels (T5); writes
  fine to study; personal Chrome out. Recommendation revised to B + upstream watch: he wants to
  own the code, writes cannot be shimmed, and the watch brings their fixes.
