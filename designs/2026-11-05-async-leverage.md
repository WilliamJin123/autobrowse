# Async leverage: parallel reads, jobs, batch judgments

William, 11-05, after a reel on "code mode" (the agent writes one script; tools run in code, not one model trip each): `code` already does that. Where can work run at the same time?

A step waits for the model only when its answer can change a decision. Reads that only collect data can run together. Acts stay serial.

## Target

1. **Parallel reads in `code`.** A pool of read tabs, max N (setting, default 3). Each worker owns one tab and reuses it for its next items. Acts that change a site never run in the pool.
2. **Jobs.** A long call starts and returns an id at once. The agent does other work, then collects. Durable: a job lives past the session.
3. **Batch judgments.** A judgment nobody waits for goes through a provider's batch API: half the price, results within 24 h.

## 1. Parallel reads (`fp.each`)

```js
const pages = await fp.each(plan.urls.split(" "), async (tab, url, i) => {
  await tab.open(url);
  return tab.records(spec);
});
rows.push(...pages.flat());
```

- `each` returns `fn`'s results in item order: the order tabs finish in never shows.
- `tab` has `open`, `read`, `has`, `records`, `wait`, and `act` for hover or a click/press marked `{view: true}`. Any other act (fill, select, upload, script, an effect click) throws: do it on `fp`, one at a time.
- A call on `fp` (or the main `records`) while items run throws: the main page waits for `each`.
- The pool: `READ_TABS` (setting, default 3), `{tabs}` per call for less, never over the setting.
  A queue: item N+1 starts when a tab is free. Each tab start waits 0.3–1.2 s after the last start, as a person opens links one by one.
- Tabs share the session's context: same profile, same sign-in. Opened in the background (CDP `Target.createTarget {background: true}`; else `newPage` and the main tab back to the front), so the headed window and the overlay stay on the main tab.
- Each worker opens its tab at its first live call and keeps it for its next items. Items all in the store open no tab.
- The gap is between navigations across all tabs, not tab starts: the pool never opens two pages at once.
- A wall in a tab throws ("sign in on fp first"): sign-in and captcha stay on the main page, one at a time.
- Results are saved per item: the key carries `each#k` (k-th `each` in the run) and the item's index, so the order tabs finish in never changes a key. A rerun replays every saved item and runs only the rest.
- A failed item fails the call with its index; the rows of the items before it are kept. The fix and resend go on from the store, as `code` does now.
- Every tab is closed at the end, also on a throw.
- The money gate never meets a tab: a tab has no act it gates (fill, select, an effect click).

Built (WA-1087): `browser/code.ts` (a cursor per page: the main one and one per item; `fp.each`), `browser/flow.ts` (`ReadTab`, `openReadTab`, `fp.readTab`, `fp.readTabs`), `READ_TABS` in `app/config.ts`.

Measured 2026-11-05:
- Lazy rows load in a background tab, headless and headed (a test page with an IntersectionObserver: 20 → 160 rows). Playwright's launch flags keep a background tab visible to the page.
- 6 Hacker News pages, `records` each: 180 rows in 6.0 s with 3 tabs, 6.5 s with 1. A rerun: 0.1 s, all from the store. Fast pages gain little: the gap between opens is most of the time.
- 6 dev.to tag feeds, `records` with `max: 60` (scrolled): 56 s with 3 tabs, 81 s with 1. Rows past the first 15 loaded in background tabs (javascript, rust: 45).

## 2. Jobs (`autobrowse job`)

- `job start <service> <handler> [json] [--key k]`: a Restate send, with `k` as the idempotency key (default: hash of the call). It prints `{id}` at once.
- `job wait <id...> [--timeout s]`: attaches; prints each result as it lands. `job peek <id>`: done or not, never waits.
- `job list`: the ledger, `~/.config/autobrowse/jobs.jsonl` (id, service, handler, key, by, why, at).
- Any handler of the desk, the box or the sites facade can be a job. wren's services are on the same Restate, so later the CLI can start a wren job by its service name too.

## 3. Batch judgments

- In `@wrenautomation/models` (engine), beside the one-call path: `batch(requests)` → `{id}`, `batchResults(id)`. Anthropic Message Batches first.
- Callers: judgments with no one waiting (nightly scores, labels, the learn scorer). Each caller moves only when its result can wait 24 h.
- Engine work goes to the birdwatch dev session.

## Options

### Where read tabs come from

| Option | Verdict |
|---|---|
| A. Tabs in the session's context, a pool of N | **Chosen**. Same sign-in; a tab costs ~100 MB, not a browser |
| A1. One tab per item, closed after it | No: N opens and closes for N items, each a CDP round trip and a tab strip change a person sees |
| B. A browser context per worker | No: no sign-in; a context per tab costs more memory |
| C. A process per worker | No: 16 GB Mac; each process is a whole Chrome |
| D. HTTP fetch, no browser | Already the read layer's first rung; this is for pages that need a browser |

### The pool

| Option | Verdict |
|---|---|
| A. N workers, each with its own tab, taking the next index | **Chosen**. ~30 lines; a worker owns a tab |
| B. `p-limit` | No: it gives a task no worker identity, so no tab per worker; a tab pool beside it is the same code again |
| C. `p-queue` | No: same gap; its interval cap is per start, not per navigation |

### What a job runs on

| Option | Verdict |
|---|---|
| A. Restate send and attach, with an idempotency key | **Chosen**. Already prod; durable; the client has `send` and `result` |
| B. Claude Code's background shell | No: dies with the session; one agent only |
| C. A queue library (BullMQ, pg-boss) | No: a second durable system beside Restate |

### Pool size

| Option | Verdict |
|---|---|
| A. One setting, default 3 | **Chosen** (William: "3 or 4 or 5 for now") |
| B. Per-site sizes | Later, if a site needs fewer |
| C. Sized by free memory | Later; the setting first, measured |

## Decision log

- 2026-11-05: Reads go in parallel, acts never (William: parallel acts "would look like a bot").
- 2026-11-05: The pool is a queue with a max N (William).
- 2026-11-05: Jobs are Restate sends with idempotency keys, not a new queue.
- 2026-11-05: Batch lives in the engine's models package; birdwatch dev builds it.
- 2026-11-05: A worker reuses its tab across items (my call): fewer tab opens a person would see.
- 2026-11-05: Tabs do no fill or select: the money gate is explore's, per `fp.act`; a read has no need of it (search by URL).
- 2026-11-05: `fp` throws while `each` runs: one cursor per page keeps every key clear of the order tabs finish in.
