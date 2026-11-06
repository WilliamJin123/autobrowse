# Driver memory and a stop that returns (WA-1118)

## Goal

A driver (the Node process of one explore session) holds the same memory after 8 hours as after 8 minutes. `stop` returns in seconds. The Mac (16 GB) has room for the desk, a person's sessions and the checks.

## What was there (measured 2026-11-05)

Probe: the live discord driver over its inspector, then a headless `scratch` session that opened the same ten heavy pages before and after each change. Memory by `footprint`, never `ps`: under swap, `ps` RSS shows about a tenth.

| Cause | Size | Proof |
|---|---|---|
| The Playwright trace. Explore is one flow, and every flow started a trace. The trace keeps each response body until the flow ends | 207 MB of live buffers after ten pages; no bound | off: 7 MB |
| Playwright keeps each Request, with its Route and Response, until 10,000 exist | 27 KB each: 50 MB at 1,814, 270 MB at the cap, per context | dropped all but 100: heap 135 → 85 MB (start 81) |
| V8 leaves garbage until a collection it does not hurry to run | about 130 MB after ten pages | one collection: footprint 461 → 218 MB |
| `stop` packed the observation file with sync zstd level 19 on the main thread | a 538 MB file held the process for about 15 minutes; `stop` said "already closed" and the browser stayed | stream pack: worst loop lag 64 ms |

## Options

### The trace

| Option | Verdict |
|---|---|
| A. No trace for explore (`BrowserFlow.trace: false`) | **Chosen**. Explore has its own record: the journal, the observation file, the film. Nobody opened an explore trace |
| B. Trace in chunks, drop each chunk | No: the bodies stay until the chunk ends, and a chunk per command costs a zip per command |
| C. Trace with no snapshots | No: screenshots and bodies still grow |

Compiled flows keep their trace: they are short and the trace is their failure record.

### The Request objects

| Option | Verdict |
|---|---|
| A. Trim to the newest 1,000 on every 200th request, by Playwright's own drop (`_dispose("gc")`) | **Chosen**. Same path Playwright takes at 10,000; a late event for a dropped Request makes a new object |
| B. A heap cap (`--max-old-space-size`) | No: at the cap the driver dies and a live session goes with it |
| C. Restart the driver every N hours | No: the pages and a long poll go with it (William keeps waiting browsers open) |
| D. Patch the constant in patchright | No: a patch to keep at each upgrade |

A uses private names. `dispatchersOf` returns null when the shape changes: the bound goes off and nothing breaks. `test/driver-memory.test.ts` fails then.

### The pack

| Option | Verdict |
|---|---|
| A. Stream pack on zlib's threads, level 6, long matches, after the browser closed | **Chosen**. 538 MB → 213 MB in 19 CPU-seconds, loop free |
| B. Level 19 in a worker | No: 15 minutes of one core for 13 MB less |
| C. A child process | No: one more process to end |

Level 9 gives 200 MB for 32 s; level 3 gives 239 MB for 15 s.

## Shape

- `src/browser/driver-memory.ts`: `boundRequests(context)` (called in `openSession` and `openOwn`), `collectWhenIdle()`, `holdCollect()`.
- Collection: 3 s after the last command, only when the heap grew 48 MB since the last one. A command start cancels it. It takes 0.1 to 0.4 s.
- `capture.close()` is async. `endRun` does not wait for it; the process waits for all packs before it exits. A pack that fails leaves the text file; `packStale` (the shipper) packs it a day later.
- `stop`:
  - reads the live session first. A session whose process is gone is "already closed"; a live process that does not answer is ended (SIGTERM, 5 s, SIGKILL, then its browser) and `stop` says so.
  - after a good `close` it waits up to 30 s for the process, then ends it.
  - `browsers stop <port>` uses the same path: it returns in seconds.
  - a start on a port whose process lives and does not answer fails with "End it: autobrowse stop <port>". Before, it removed the token and left the old process.
- `autobrowse browsers`: memory by `footprint`; each explore row shows its driver's MB; a driver over 600 MB gets a warning line. `admit` uses the same numbers.
- Typing: the cmd row holds `typed {keys, plannedMs, ms}`. The pace is not changed.

## Result (same ten pages, headless)

| | Before | After |
|---|---|---|
| Live response buffers | 207 MB | 7 MB |
| Request objects | 1,814 and growing to 10,000 | 1,035 |
| Heap used | 135 MB and growing | 120 MB, flat |
| `stop` | 34 s, then about 45 s to exit | 3.3 s, process gone |

## Stray tabs

Measured on the desk's two browsers: the big second renderer in each is the watcher tab (the long poll), kept on purpose. The small ones (24 to 81 MB) are the page's own frames. No stray tab was open. So this is a guard, not a saving.

- Explore: a tab a command opened (a `target=_blank` link, a popup) closes when the agent sends `open` or `page main`. The answer holds `closedTabs`. A tab a person opened stays.
- Flows: at a run's end, before the browser parks, each tab beside the main page closes (`closeStrayTabs`). Kept: a watcher's tab, every tab of a run that waits for a person, every tab of a person's own browser.

## The shared reader: not built

Plan was one Chrome for all signed-out reads, many tabs. The flow ledger says it saves almost nothing now.

| 7 days to 2026-11-05 | |
|---|---|
| Browser runs | 1,842 |
| Signed-out runs (`reddit-public`, `web`, `scratch`, `learn`, `perplexity`, `reviewer-fresh`) | 207, 128 minutes of run time |
| Minutes with two or more signed-out browsers open (each kept 15 minutes after its run) | 84 of 10,080 (0.8%) |

- The memory is in the signed-in sessions (`linkedin`, `x`, `instagram`, `apple`, `google`): signed-out runs are 5% of the run time (128 of 2,630 minutes). Each signed-in session needs its own profile.
- The build is not small: flows on one context at once need page-level routes, no trace, a host limit and a crash retry.
- Build it when signed-out reads overlap for more than an hour a day. The shape is ready: a flow as a tab in a shared context is how a person's own browser already works (`openOwn`, `session.shared`).

## Decision log

- 2026-11-05: Fix the driver growth first (William: "a low hanging fruit").
- 2026-11-05: Waiting browsers stay open (William: "i like the long polling so im willing to eat that cost"). No blanking of idle pages (William: "drop blanking").
- 2026-11-05: Typing pace stays (William: "we don't want it too fast to be clearly superhuman"). Log planned against actual time.
- 2026-11-05: No heap cap (my call): a crash loses a live session. A warning over 600 MB instead.
- 2026-11-05: Collect only when no command runs (my call): a collection never pauses an act.
- 2026-11-05: Keep 1,000 Requests (my call): a page load is a few hundred, and `waitForResponse` reads only new ones.
- 2026-11-05: The network log is off by default (`AUTOBROWSE_NETWORK`), so its bounds wait.
- 2026-11-05: Stray tabs close when the agent moves on, never a watcher's tab and never a tab of a run that waits for a person (my call).
- 2026-11-05: The shared reader waits (my recommendation; William agreed to the reader on 11-05 before these numbers): two signed-out browsers were open together 0.8% of the week.
- 2026-11-06: The memory gate warns and opens (William, through the onlyfeet session: an agent's start was refused twice while three desk browsers held about 2 GB, and it had no `--force`). The warning gives the free share and each browser's MB. A stop stays at the OS's critical level only (my call): there the kernel kills processes, and the next one may be the desk's. WA-1132.
