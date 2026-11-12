# Kept reads, API breakers, call bodies (WA-1336)

## Goal

A site call never reaches the site when we already hold the answer, never hammers a site that is down, and leaves its full input and answer on disk.

## Why

The calls ledger for November 2026 (about 8.7k calls):
- Meta `GET /me/accounts` ran 747 times. The answer changes a few times a year.
- One dead Meta post's comments were read 185 times. Each was the same 400.
- A 5xx run spent each caller's retries on a site that was down. Nothing stopped the next caller.
- The ledger kept the row (route, ok, ms) but not the data. "What did the site say?" had no answer.

## Target state

All three sit in `siteFacade.call`, so the CLI, the Hono door and the Restate/desk door get them alike.

1. **Kept reads** (`src/sites/call-cache.ts`). A GET by one account with one input answers from memory for the route's `ttl` (default 60 s; Meta and LinkedIn Pages 3600 s). A hit spends no cap, no pace slot and no token. Lasting refusals (400, 404, 410, 422) are kept like answers. A 5xx or 429 is never kept. A call in flight is shared. Any write by that account clears its kept reads, even a failed write. `fresh` (CLI `--fresh`, HTTP `Cache-Control: no-cache`), `verify` and arm calls skip it. `ttl: 0` turns it off for a route; `cache: false` in `wireSites` turns it off. A hit writes a ledger row with `via: "cache"`, and a hit hands out a copy.
2. **API breakers** (`src/sites/breaker.ts`). Per site and token: 5 upstream faults in a row (5xx, network) open the API leg for 30 s. Then one probe goes through; a failed probe doubles the wait, up to 15 min. While open, a GET with a browser leg reads there; any other call fails fast with 503 and `retryAfter`. A 429 trips the same store: the app's key till UTC midnight (as `quotaSpent` did), the account's quota for 15 min. `breakers()` lists the open ones.
3. **Call bodies** (`src/runs/call-bodies.ts`). Each call's input and answer (or error) goes to `calls/bodies/<day>/<HH>.jsonl.gz`, one gzip member per line, secrets masked (`redactJson`). The ledger row carries the body `id`. A closed hour ships to S3 with the shots. `autobrowse site bodies [site] --day --hour --route` reads them.

## Options

### What to keep, and for how long

| Option | Verdict |
|---|---|
| A. TTL + LRU size bound (`lru-cache`) | **Chosen**. TTL bounds staleness, the only correctness risk. The size bound only caps memory. One vetted library does both, with in-flight sharing on top |
| B. LFU (or W-TinyLFU) | No: it keeps hot keys longer, but the keys repeat in bursts (a loop over one post). Hit rate is the same here, and staleness, not eviction, decides what is right |
| C. No TTL, clear on write only | No: another app (or a person in the site's UI) changes the data and we never see it |
| D. HTTP caching per RFC 9111 (undici cache interceptor) | No: Meta and LinkedIn send `no-store` or nothing. It also misses the browser leg and the 400s |

### Where the breaker comes from

| Option | Verdict |
|---|---|
| A. Own store, about 100 lines | **Chosen**. It shares one store with the 429 day trip and needs keys per token, a probe that goes stale, and `retryAfter` for wren. A library would sit beside the trip, not replace it |
| B. cockatiel | No: good, but its policies wrap one function. Our state is per key and must answer "how long" before the call; we would wrap it in our own map anyway |
| C. opossum | No: event-emitter shape, one breaker per function, no per-key state |

### Where the bodies go

| Option | Verdict |
|---|---|
| A. Inline in the ledger row | No: one Meta answer is 200 KB; the ledger is read whole by drift and caps |
| B. Desk files by hour, gzip, shipped to S3 | **Chosen**. Local first (cheap, fast `site bodies`), S3 after the hour ends (a few cents a month) |
| C. Postgres (`rt.*` on wren-prod-pg) | Later: see the open question below. It couples the desk's every call to a box over the internet |

## Non-goals

- A shared cache across processes. The desk serves every prod call; a restart starts empty.
- Caching browser-only routes' acts. Only GETs are kept.

## Risks

- A read right after another app's write is up to `ttl` old. Callers that must see it pass `fresh`.
- A kept 400 hides a fix on the site's side for `ttl`.
- Bodies hold answers with personal data. They stay on the desk and in our private bucket; secrets are masked.

## Decision log

- 2026-11-12: Build kept reads, breakers and bodies (William: "lru + ttl", the circuit breaker, answer bodies as desk files then S3).
- 2026-11-12: TTL + LRU over LFU; staleness decides correctness, not eviction.
- 2026-11-12: Own breaker over cockatiel or opossum: one store with the 429 trip, keys per token.
- 2026-11-12: Bodies option B: hourly gzip files, S3 after the hour.
- 2026-11-12: Storage stays local for now (William: "is fine for now"). A Postgres adapter is the open question.
- 2026-11-12: Storage path agreed: option C when autobrowse runs on a server (William: "C is probably right… when we scale autobrowse and put it on a server machine"). Postgres holds what two processes must agree on: caps and pace slots, 429 and breaker trips, the jobs ledger. The cache stays per process; bodies stay files + S3; profiles stay local. The server takes API legs; browser legs stay on the home IP. Task WA-1337 (parked).
