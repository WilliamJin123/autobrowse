# PinchTab audit: what to take, what to leave (2026-11-10)

William, 11-10: "pinchtab autobrowse audit of the repo. Kind of similar, almost the other half of opencli?"
Source: github.com/pinchtab/pinchtab a626620 (MIT, Go, 121k lines), read 11-10. `P/` is its repo.

## The answer

Not the other half of OpenCLI. OpenCLI is a catalog of site reads. PinchTab is a generic browser
server for anonymous agents: a Chrome per instance behind HTTP, an accessibility-tree page view,
and a security posture for an operator who exposes it. It has no sign-in, no caps, no pace, no
gates. autobrowse already does its job for one signed-in account per profile.

So it is a third source, smaller than OpenCLI. Take its page-view craft, its launch hygiene and
its navigation guards. Leave its server, scheduler and stealth.

The facet table states autobrowse as of 11-10, before any take. Status lives in the Take table.

Terms: a *hint* is how a journaled act names its element (role, name, text, `nth`, `frame`); the *journal* records each act with its hints; *compile* turns a journal into a workflow that replays the hints (`map/objects/browser/hints.md`). *own tier*: a person's own browser, attached; *cdp tier*: an app's browser over CDP. Size: S is a day or less, M a few days.

| Facet | PinchTab | autobrowse | Better |
|---|---|---|---|
| Page view | AX tree, `eN` refs bound to a node per document, `maxTokens` cut by tier | `aria`, `snapshot` rows, `marks`, hints; caps in chars and rows | PinchTab for the view; ours for flows (hints compile, refs do not) |
| Diff after an act | Opt-in; added, changed (value, checked), removed | Automatic; added rows and a count of gone rows | Ours, with their changed fields |
| Text | Article mode (their own 103-line heuristic, not Mozilla Readability), raw, markdown | Layout text (tables, columns) | Both; add an article mode |
| Process | Server + bridge child per instance, HTTP hops | One process, browser per profile, Chrome's `SingletonLock` (not `flock`), park | Ours for one Mac |
| Launch hygiene | Health poll at launch, crash ring, unclean-exit cleanup, tab budget | 3 s probe on park take, stray-tab sweep | PinchTab |
| Scheduler | In-memory queue, per-agent fairness, no pace | wren's Postgres runtime (the door) queues and retries desk calls; caps, pace and the send journal are files on the Mac; `ProfilePool` FIFO per profile | Ours |
| Injection | Domain allowlist (off by default), regex scan, advisory wrap | Secrets never shown, gates | Ours structurally; take their allowlist |
| Network guard | Scheme + private-IP check after DNS | None | PinchTab |
| Stealth | JS patches, or CloakBrowser | Patchright, real fingerprint | Ours |
| Captcha | Cloudflare click, paid solver stubs | Vision vote, human hands | Ours |
| Agent surface | CLI over HTTP, MCP (45 tools), `errors` channel, remedy line | JSON socket, error contract, `changed` | Ours, plus their `errors` channel |
| Health / QA | `audit` (vitals, broken assets, a11y), `compare --fail-on-diff` | None (`proof-shot` is comment evidence, `workflows/proof.ts` a workflow's run) | PinchTab |
| Tests | Census tests, skill token budget, e2e tiers with a path map | Vitest, `LIVE=1` | PinchTab on the meta-tests |

Their benchmark is honest on cost (real `usage`, 10–20 % lower than agent-browser) but the saving is
fewer turns, not a smaller page. The "800 tokens a page" line is not measured anywhere in the repo.

## Take

| # | What | Where | Size | Status |
|---|---|---|---|---|
| P1 | Navigation guard: http/https only; private, loopback, link-local, CGNAT refused after DNS (`P/internal/netguard/netguard.go:70-100`) | `fp.open`, explore `open` | S | Built: `src/reach/net-guard.ts` |
| P2 | Page text to the agent: strip bidi, zero-width and control characters (`P/internal/sanitize/text.go`) | `src/agent/digest.ts`, explore reads | S | Built: `src/browser/clean-text.ts` |
| P3 | `errors` channel: uncaught page errors (`pageerror`) kept per session | explore `{"cmd":"errors"}`, skill line | S | Built: `src/browser/page-errors.ts` |
| P4 | Sparse stable refs on `snapshot`: `eN` per node, new numbers on a new document; `hints:{ref}` resolves to hints, the journal keeps hints. `marks` already does this for the viewport (`hints:{mark:n}`) | `src/browser/repair.ts`, `src/explore/server.ts` | M | Not built: D chosen (count `ambiguous` misses first) |
| P5 | Page-view budget by tier: controls, then headings, then prose, in page order; skip an oversized row | `aria` via `fitText` (`server.ts`), `compact.ts` | S | Not built: D chosen |
| P6 | Diff fields: value, checked, disabled changes in `pageChange`. Our rows carry none of these yet, so the rows change first | `server.ts` | S | Built as B: `repair.ts` row state, `changed` in `pageChange` |
| P7 | `text` article mode (Readability-style main text) beside layout text | `src/browser/layout.ts` | S | Built: `src/browser/article.ts`, `text` `article:true` |
| P8 | Readiness probe at launch: fail fast as not sent | `openSession` | S | Built: `launch-hygiene.ts` |
| P9 | Unclean-exit marker: clear Chrome's session-restore files only, never cookies | `session.ts` | S | Built: `launch-hygiene.ts` |
| P10 | Crash ring: last 20 browser deaths with profile, opener, reason, in `browsers` and `doctor` | `browsers.ts` | S | Built: `launch-hygiene.ts` |
| P11 | Tab budget at open: past a cap on our own ledger tabs, refuse the open (`tabs_full`, cap 6); never close a tab we do not own (own tier) | `session.ts` | S | Built: `launch-hygiene.ts` |
| P12 | Skill size budget test over `.claude/skills/autobrowse/*.md` | `test/` | S | Built: `test/skill-budget.test.ts` |
| P13 | `proof` at widths with overflow, page errors, broken assets; compare rules (identity diff, masked host, drop statusless failures) | explore + `shots/` | M | Built: `src/browser/page-proof.ts` |

## Discuss first

William's call on each. Priorities, in order: the compiled flow stays hint-based and replays; fewer
agent turns and tokens; no page-visible change (Patchright's stealth); vetted libraries before ours.

### P4–P6 refs, page-view budget, changed fields (one decision)

P5 and P6 A only make sense with P4 A, so they are one choice.

| Option | For | Against |
|---|---|---|
| D. No refs. Count find misses first (`missed()` in `src/explore/marks.ts:49` already sorts strict-mode, zero-match and stale) for two weeks; build A only if they matter. P6 as B: add value, checked, disabled to `snapshot` rows | No new state; nothing the background measure can break | The agent keeps writing role+name; misses on twin controls stay |
| A. Playwright's AI snapshot: `ariaSnapshot({mode:"ai"})` gives `[ref=eN]` on controls; the `aria-ref=eN` locator acts on it (Playwright and Patchright 1.63.0, both pinned). P5: their tier budget on it. P6: diff two AI snapshots | Maintained by Playwright; frames and shadow roots handled; no CDP domain (no `getFullAXTree` in the bundle) | Each injected script keeps one ref table, the last snapshot's. Explore's background `wholePage` measure (`server.ts:943`, `frames.ts:110`), `watch.ts:107` and `flow.ts:905` take default snapshots and wipe it, so every snapshot must pass through one helper with `mode:"ai"`, and an act by a stale ref fails with its own error. A frame ref (`f<seq>e<n>`) needs a map to the `frame` hint chain. AI lines carry `[active]`, refs and indentation: strip them before a diff; measure snapshot time on a long page |
| B. Widen `marks` to the whole page | Already resolves to hints (own hints, role, tag, `nth`) and journals hints; tested | Writes a `data-m…` attribute on every control (`marks.ts:104`): a page-visible change on the whole page; our walker, not the accessibility tree |
| C. PinchTab's way: `Accessibility.getFullAXTree`, refs bound to backend node ids | Most exact | Turns on a CDP domain on every page; Patchright keeps Runtime off for the same reason (unmeasured for Accessibility); most code |

Recommend D. A ref saves turns only when role+name misses, and no count says it does. Under any option an act by ref resolves to hints before the journal.

### P7 article text

| Option | For | Against |
|---|---|---|
| A. `@mozilla/readability` (Apache 2.0, Firefox's reader view) run in Playwright's utility world | Vetted; the page cannot see it | A bundle to inject per read |
| B. Port their 103-line heuristic | Small | Ours to maintain; weaker than A |
| C. Layout text only, as now | No change | Long articles cost the agent tokens on nav and footers |

Recommend A as `{"cmd":"text","mode":"article"}`, with their fallback: when the article's chars are under 25 % of the page's `innerText` chars and `innerText` is 400+ chars, answer layout text and say so. Cost: Readability.js is ~90 KB unminified, injected once per read.

### Server process

| Option | For | Against |
|---|---|---|
| A. As now: the desk holds its pool; each CLI call or explore session opens its own browser; `profile_busy` waits | Simple; a crash takes one call | A CLI call pays a 3 s launch; two processes on one profile wait |
| B. One local daemon owns every browser; CLI calls and explore talk to it | One pool across processes; no launch cost | A new long-lived process to supervise; its crash takes every session |
| C. PinchTab's server + bridge per instance | Isolation | ~300 MB a child, an HTTP hop, an auth layer, for one Mac |

Recommend A. Revisit B if `profile_busy` errors pass about 5 a day in the call ledger.

### Scheduler

| Option | For | Against |
|---|---|---|
| A. As now: the door's Postgres runtime queues, retries and times desk calls; caps, pace, send journal stay files in autobrowse | autobrowse runs alone (npm users); wren and autobrowse import nothing from each other | Caps live per machine, not in wren's store |
| B. Caps and pace in wren's Postgres | One store with the rest | Couples the repos; autobrowse on npm loses its caps |
| C. Add per-caller fairness to `ProfilePool` (theirs) | One busy caller cannot starve others | No starvation seen; FIFO already stops write starvation |

Recommend A.

### JSON vs CLI (never MCP)

| Option | For | Against |
|---|---|---|
| A. As now: JSON commands over the socket (`cmd.sh`, `autobrowse cmd`), the zod union is the contract | One contract; `batch` and `id` work; errors already JSON | Shell quoting of nested JSON is an agent error source |
| B. CLI verbs per command, generated from the zod union (`autobrowse x click role=button name=Create`) | No quoting; no drift (generated) | Two spellings of one command in the skill |
| C. Hand-written CLI verbs (PinchTab's) | Readable | Drifts from the union |

Recommend A. Measure first: count quoting errors (Q: a JSON parse failure may not reach `counted()`; log it there first); build B only if they matter.

### Success envelope (from OpenCLI U1)

OpenCLI U1 (`designs/2026-11-09-opencli-audit.md`) asked for a success envelope, `{ok:true,data}` on every CLI answer. Only the error side was built (`{ok:false,error}`, exit codes). Options: (a) add the envelope to every `--json` answer, breaking each `jq` path in skills and scripts; (b) leave success as each command's own JSON, as now. Recommend (b): the exit code and the error JSON already let an agent branch.

## Leave

| What | Why |
|---|---|
| Server + bridge per instance, HTTP proxy hops | ~300 MB a child and an auth hop for one Mac, one trust domain |
| Their scheduler | In memory, lost on restart; no pace or caps. Ours: the door's Postgres queue, caps files, the send journal |
| Quarantine a corrupt profile and relaunch fresh | Signs a Wren account out unattended; a person looks instead |
| Stealth JS bundle, CloakBrowser | A page can see a JS patch; Patchright already patches the driver |
| Paid captcha solvers | Sends Wren's sign-in pages to a third party |
| Hash-embedding `find`, schema `extract` | The agent already picks from rows; `read`/`records` replay, `extract` does not |
| MCP server, dashboard auth, tab-lock TTL | CLI + skills policy; no multi-user exposure; a TTL can expire under a live writer |
| Regex injection scan as a block | Detection only; a paraphrase passes. The allowlist and our gates are the real controls |

## Decision log

- 2026-11-10: PinchTab is a third source, not OpenCLI's other half (my read, from the code).
- 2026-11-10: Refs resolve to hints before the journal: compiled flows stay hint-based (my call).
- 2026-11-10: No per-run domain allowlist yet: explore crosses sites by design (sign-in providers, OAuth). The scheme and private-IP guard ships first (my call).
- 2026-11-10: William: "Pinchtab we should discuss first get the opencli stuff done prior". P4–P7 wait on that talk; the rest was built 11-11 under "get the opencli stuff done" (P1–P3, P8–P13 are safety and hygiene, no choice of William's in them).
- 2026-11-11: P3 reads errors through the recorder's observer (a main-world `error` and `unhandledrejection` listener over the binding), not Playwright's `pageerror`: Patchright keeps CDP Runtime off, so `pageerror`, `console` and `Log.entryAdded` never fire. Turning Runtime on is a known bot signal. Built: `src/browser/page-errors.ts`, `pageErrors` on act answers, `{"cmd":"errors"}`.
- 2026-11-11: P11 changed from the plan (my call): it refuses a new tab of ours past 6 in one person's browser, as `tabs_full` (first `profile_busy`; its hint named the wrong remedy, goldfish F9). It never closes a page the session does not own: in the own and cdp tiers those are the person's or an app's tabs, and closing them loses their work. The cdp tier gets no cap: the app owns its tabs.
- 2026-11-11: P8–P10 built in `src/browser/launch-hygiene.ts` (map card `browser/launch-hygiene`). P9 clears only the exit flags and `Default/Sessions`; no quarantine (Leave table). P12: `test/skill-budget.test.ts`.
- 2026-11-11: P13 built as explore `{"cmd":"proof"}` (`src/browser/page-proof.ts`), with PinchTab's compare rules (`P/internal/audit/compare.go`): errors by first line with the origin masked, assets only with an HTTP status, a swap is a change. No pixel diff (my call): William turned screenshot compare off on 10-18; the shots are for reading.
- 2026-11-11: P1 built: `src/reach/net-guard.ts`, code `url_refused` (403), hooked into the fetch ladder, renderer, settle, watchers and recorder (map card `reach/net-guard`). P2 built: `src/browser/clean-text.ts`, used by explore answers and the digest.
- 2026-11-11: P4–P6 merged into one decision; option D (no refs, count misses first) added and recommended. A's refs are wiped by any default snapshot in the same page (goldfish F1).
- 2026-11-11: goldfish review: 32 findings, 21 applied, 11 rejected (F9 fixed in code as `tabs_full`; shapes and tests for P4–P7 wait for William's pick; per-priority tags; sources for the 300 MB figure). Open: P4–P6 (D or A), P7, server, scheduler, JSON vs CLI, the success envelope.
- 2026-11-11: William picked: P4–P6 D ("D makes sense"); P7 yes, with a deterministic skip on non-articles ("most sites aren't articles"); server as is; scheduler stays the Postgres door; JSON socket; no success envelope (exit code and error JSON suffice).
- 2026-11-11: D built: a strict-mode error is now a target miss of cause `ambiguous` (`runs/success.ts`, explore's run log), so the success report counts the misses refs would fix. Revisit P4 A when `ambiguous` misses show up there.
- 2026-11-11: P6 B built: `snapshot` rows end in state tokens (`[checked]`, `[disabled]`, `[expanded]`, `[selected]`, a select's `[value=…]`, `[filled]`/`[empty]`). A text field's value never shows: `place` may have typed a secret there. `pageChange` pairs a gone and an added row alike but for state as `changed`.
- 2026-11-11: P7 built: `@mozilla/readability` 0.6.0 in Patchright's isolated world; `isProbablyReaderable` skips a non-article before any extraction (20 ms on an app page, 42 ms to extract an article); PinchTab's 25 % fallback to layout text.
