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

## A browser's memory cap (2026-11-09)

Incident, 11-10 02:06–02:46 UTC: explore 9302 (another session's) drove Meta Business Suite's composer for 40 minutes (21 opens, 8 uploads). Its headed Chrome grew until macOS ran out of memory. William force-quit it at 02:45:48 and his session crashed. Swap was full (8 GB) with gates and other sessions running. Nothing of ours acted: `autobrowse browsers` warns only when asked.

Ruled out: the desk's renders (full Chrome in `--headless`, not the headless shell; one at a time per profile; 82 MB at 02:46), the internships `mail.mjs` job (closes its Chrome; pid 73229 was a live run), weaver (launches no browser), the explore network capture (Playwright keeps Chrome's default buffers; our log is capped at 32 MB in Node).

| Option | Verdict |
|---|---|
| A. A guard per session in `openSession`: reads its own tree's footprint every 30 s, closes it past the cap | **Chosen**. Every opener gets it (desk, explore, CLI, jobs on `flowRunner`); it knows its pages' URLs |
| B. One watchdog in the desk over every browser root | No: it cannot see another process's pages, and it stops when the desk does |
| C. Warn only, as before | No: it failed on 11-09 |
| D. Chrome flags (`--js-flags=--max-old-space-size`) | No: caps the JS heap of one renderer only; images, DOM and GPU memory pass it |

Cap: a quarter of RAM, 2 to 6 GB (4 GB here); `AUTOBROWSE_BROWSER_CAP_MB` sets it. Half the cap is enough under the OS's critical level. Past 60% it warns once. Each warn and close is a line in `~/.config/autobrowse/browser-memory.jsonl` with the pages' URLs. A close that hangs 10 s is a kill. Explore restarts the browser and resumes its journal; a flow fails retryable; the park drops a dead browser.

### What the 19 GB was (found later on 11-09)

William: an "out of application memory" panel, a Chrome at about 19 GB; once he killed it, two more 19 GB Chromes appeared. The system log (`log show`, loginwindow and runningboardd) gives the facts:

- He force-quit Chrome 25851 at 21:45:42 EST. It started at 21:06:29: the Business Suite explore browser.
- The two that appeared were Chrome 73984 and 74029, started 21:46:28 and 21:46:30, force-quit together at 21:46:50. One was that session's agent starting its explore again ("browser died, restarting"); one was my explore 9322. Each was about 20 s old.
- A 20 s old Chrome cannot hold 19 GB. So the panel's number per Chrome row is not that process's memory. Each explore start in the window measured all our browsers at 2 to 6 GB by footprint: the Business Suite explore 1.5 GB, the desk's LinkedIn watch 2.6 GB, its X watch 1.1 GB.
- About 30 Chromes started and stopped between 21:36 and 21:50 (CLI and desk fetches, explore restarts).
- William's own browser is Opera. Every Google Chrome on this Mac is ours.

So the Mac ran out because many things were large at once: Claude sessions (6.5 GB at 22:30 for 8), the Docker VM (2 GB), gates (`tsc` about 2.8 GB each), and our browsers. No single process held 19 GB.

What changed:

- The cap per browser above.
- The desk writes what holds memory each minute while the OS reports pressure: `~/.config/autobrowse/memory/pressure-<YYYY-MM>.jsonl`, the top 20 apps and processes by top's MEM (compressed pages too), each Chrome by its profile. The next incident names its holders.
- A watch tab renews each hour (a new tab, then the old one closes) instead of a reload every 3 h. A reload keeps the renderer, and the LinkedIn watch reached 2.6 GB on a page meant to be light.

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
- 2026-11-09: A cap per browser, closed past it (my call, after William's "how did it get to 18gb in the first place is the bug to fix"). This reverses "no heap cap" for the browser only: a lost page beats a crashed Mac. The driver stays uncapped.
- 2026-11-09: Under pressure the desk logs the top holders each minute (my call): the Force Quit panel gave one number for every Chrome, and nothing of ours kept a record. `top -l 1` costs 0.7 s; `footprint` over every process costs 7 s and 2.5 cores, so it is not used.
- 2026-11-09: A watch renews its tab hourly instead of a reload every 3 h (my call): a fresh renderer frees what a reload keeps.
