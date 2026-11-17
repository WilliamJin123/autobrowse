---
type: object
cluster: app
universe: live
status: verified
verified: 2026-11-16 (WA-1415)
entity: src/runtime/index.ts
---

# Local runner

The engine (run objects, `Runs`, `Compiled`, `browser`, `sites`, `do`) runs durably on one SQLite file, with no server. The desk or `autobrowse worker` dispatches; any shell calls through the same file.

## Why this shape

The engine had no server since 11-09 (wren left Restate). wren's turn code is copied into `core/` and the store is an interface, so a later shared pg runtime swaps the store, not the handlers. Handlers keep `restate.object` and `ctx`; the SDK is a type and serde library. Design: `designs/2026-11-16-local-runner.md`.

## Shape

- `startRunner({file|store, services, takeOverMs, replay, ...})` → `{store, ingress, dispatching, stop}`; `ingressOf(store)`, `localIngress(file)` — `src/runtime/index.ts`
- `RuntimeStore` (wren's verbs, plus `takeOver` and `due`) — `src/runtime/store.ts`; `sqliteStore(file, {now})` — `src/runtime/sqlite.ts`
- `runTurn` — `src/runtime/executor.ts`; `Dispatcher` (renews leases before each claim, polls 250 ms) — `src/runtime/dispatcher.ts`
- `doorFetch(store)`, `RUNNER_URL`: wren's door routes as a `fetch` for the official client — `src/runtime/door.ts`
- Routing: `DOOR_SERVICES` (`desk`, `claude`, `studio`, `calls`) go to wren's door, the rest to the file; `ingress({url, authToken, owner, runner})` — `src/app/client.ts`. The desk's `plainContext` sends local names to the runner (`LocalCalls`) — `src/app/door-pull.ts`

## State

- `RUNNER_FILE`, default `~/.config/autobrowse/runner.sqlite`; an owner's is `<ownersDir>/<owner>/runner.sqlite`.
- Tables: `invocations`, `journal`, `state`, `awakeables`, `handlers`, `runners` (the pid lock).

## Connected to

- **owned-by:** the desk (`src/app/desk.ts`) or `autobrowse worker` (`src/app/main.ts`): whichever holds the lock dispatches
- **serves:** [[app]]'s `services`
- **looks-like-but-is-not:** wren's door (`/rt/claim`), which the desk pulls its own calls from

## If you change this

- **Hits:** `test/runtime-sqlite.test.ts` (conformance, crash points, lease, pid lock, `due`), `test/restate.test.ts`, `test/profile-wait-restate.test.ts`, `test/send-verdicts-restate.test.ts`, `test/door-pull.test.ts`.
- `core/` is wren's code: change it in wren first, then copy.

## Live findings (11-16)

- A CLI call on a file no worker has registered answers 404 naming the service.
- A second process only calls; it takes over within `takeOverMs` (5 s) once the holder exits.
