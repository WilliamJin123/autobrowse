# Local runner (WA-1415)

The engine (run objects, the Runs registry, `browser`, `do`, `sites`) runs on this Mac, durable, with no server. One SQLite file holds the queue, the journal and the object state. The turn code is wren's, copied with one change of form (below), so a later move to a shared pg runtime swaps the store, not the handlers.

## Today

- Prod is the desk only (`desk`, `claude`, `studio`, `calls`). It pulls its calls from wren's door (`src/app/door-pull.ts`).
- The engine has had no server since 11-09. `restateIngressUrl` points at wren's door, which does not serve run objects. `autobrowse run` cannot run.
- `sites/service.ts` keyRotate sends to a run object. The desk's `plainContext` refuses that call.
- The gate needs Docker for 3 testcontainer tests.

## Target

- `autobrowse run <workflow> <key>` from any shell: the CLI writes the call to the file, the desk runs it, the CLI reads the result.
- A run survives a crash, a restart and a sleeping Mac. Each `ctx.run` result is kept, so a rerun never repeats a finished act.
- Calls to `desk`, `claude`, `studio` and `calls` still go to wren's door.
- The gate runs the engine tests with no Docker.

## Options

### Where the engine runs

| | How | For | Against |
|---|---|---|---|
| **A. Local runner (picked)** | wren's turn code + a SQLite store, in the desk process | Standalone; no server, no pg, no Docker | One machine only |
| B. One shared runtime now | `@wren/runtime` as a package with a store interface | One set of tests | Refactors wren's prod runtime; ties the two releases. Phase 5 rejected it 11-09 |
| C. Copy wren's pg adapter | The 3.4k lines with pg | Proven | Brings pg in before autobrowse moves to a server |
| D. Run the engine on wren's door | Grow the pull protocol with state and steps | wren's store | autobrowse depends on wren's prod and the internet |
| E. Keep Restate | A local restate-server or Restate Cloud | No code | An always-on server on a 16 GB Mac; the service wren just left |

Ranked by: no lost or doubled acts, then autobrowse on its own, then the least new infrastructure, then one runtime.

### Frameworks

DBOS, Temporal, Inngest and graphile-worker each need a server or Postgres. None runs on one SQLite file inside our process. So the runner is our code, and the turn half is wren's code we already test.

### The SQLite driver

| | For | Against |
|---|---|---|
| **`node:sqlite` (picked)** | Built into Node (≥ 22.5; we need ≥ 24); no native build for npm users | Prints an ExperimentalWarning: dropped once at open |
| better-sqlite3 | Mature | A native module in an npm product: a build step on every install |

### The ingress

| | How | For | Against |
|---|---|---|---|
| **A. A `fetch` door over the store (picked)** | `clients.connect({url, fetch})`; the fetch speaks wren's door routes | The real client: serde, opts, send handles, 470; wren's conformance suite runs as written | A request object per call, in process |
| B. A hand-built proxy | Our own `objectClient` | No HTTP shapes | Copies the client's serde and opts rules |
| C. A local HTTP port | wren's `serveDoor` over the store | Any process can call | A port to keep up; the CLI fails while the desk is down |

## Design

Files, `src/runtime/`:

| File | Is |
|---|---|
| `core/turn.ts`, `core/promise.ts`, `core/registry.ts`, `core/ids.ts` | wren `packages/runtime/src/pg/` at dc80ecd28; the header names the commit. `turn.ts` and `promise.ts` declare constructor parameter properties as plain fields: our `erasableSyntaxOnly` refuses them (TS1294). Same behavior |
| `sdk.ts` | wren `src/promise.ts` + `src/index.ts`: the SDK with `RestatePromise` that also takes our promises |
| `store.ts` | `RuntimeStore`: wren's `store.ts` verbs and shapes (`Loaded`, `Writes`, `Outcome`), plus two of ours: `takeOver` (the pid lock) and `due` (the idle check) |
| `sqlite.ts` | `sqliteStore(file)` |
| `executor.ts` | `runTurn`: wren's, minus Lambda |
| `dispatcher.ts` | claims and runs turns |
| `door.ts` | `doorFetch(store)`: wren's door routes as a `fetch` |
| `index.ts` | `startRunner`, `localIngress`, `ingressOf` |

Store. Tables are a subset of wren's `rt.invocations`, `journal`, `state`, `awakeables` and `handlers`, same column names. Every write is one `BEGIN IMMEDIATE` transaction with WAL and a 5 s busy timeout.

- Fence: a flush or finish writes only while the row is `running` at the turn's attempt.
- One holder per object key for exclusive handlers; FIFO per key.
- Idempotency key: unique per service, handler and key. The insert is `ON CONFLICT DO NOTHING`, then a read of the row: `INSERT OR IGNORE` also hid a failed insert (a 404 "no invocation").
- `handlers` decides exclusive at submit. The dispatching process writes it; the CLI only reads it.

Dispatch.

- One dispatcher per file. It holds a lock row with its pid; a second process whose holder is alive does not dispatch. That process only calls, and tries the lock again every 5 s (`takeOverMs`): when the holder exits, it takes over and runs what is queued.
- Claim and lease renewal write quietly: they do not wake the dispatcher, which would then spin.
- At start the holder takes every `running` row back to `pending`: the process that ran it is gone.
- It never claims a row it runs. It renews its turns' leases before each claim. A sleeping Mac then never doubles a live turn.
- No NOTIFY across processes: the dispatcher polls (250 ms) and a caller polls for its result (100 ms). In one process a submit wakes the dispatcher at once.

Routing.

- `client.ts`: `desk`, `claude`, `studio` and `calls` go to wren's door; every other name goes to the local store.
- A job id is looked up in the store first, then at the door.
- The desk's `plainContext` sends local names to the store (keyRotate).
- The desk and `main.ts` both serve `app.services` through the runner. Only one dispatches. On the desk, `do` has no doer and ends with 503 ("do is not wired here"); `autobrowse worker` serves it.
- The worker's idle stop counts the file's due rows (`due`: running, or pending or suspended and due now). A row due in an hour does not keep it up.
- A service no worker has registered in the file yet answers 404 with its name and "start the desk or `autobrowse worker` once".

Removed: the Restate endpoint, the tunnel, self-registration, the `restate*` keys other than the door's (`restateIngressUrl` and `restateAuthToken` stay), testcontainers, and the run history's Restate backfill (`fromRestate`, `finishedCalls`). A retired key in an old `settings.json` is skipped, not refused; an env key is ignored.

## Merge to a shared pg runtime

`core/` is wren's code, with only the field change above. `RuntimeStore` names wren's `store.ts` verbs. A pg store is wren's `store.ts` behind this interface. The merge is: one package holds `core/` and the interface; wren's pg store and this SQLite store implement it; both repos import it.

## Tests

- wren's conformance `scenarios.ts`, on SQLite, without replay mode: two scenarios count handler-body runs, which a replay repeats.
- `restate.test.ts`, `profile-wait-restate.test.ts`, `send-verdicts-restate.test.ts` move to the runner. Replay mode ends every turn after each step, as `alwaysReplay`.
- Crash points: a crash before a step, after its effect and after its journal row; the result equals the run with no crash.
- A Mac that sleeps past the lease mid-`ctx.run`: no second attempt.
- The pid lock: a caller does not dispatch while the holder lives; it takes over once the holder dies, and runs its queued call.
- `due` counts running and due rows, never a later one.
- The desk's `plainContext`: a keyRotate send with the same key twice is one invocation on the runner; a door name still goes to the door.
- Live (11-16): a worker on a scratch file dispatched; a second shell ran `autobrowse status` and a `sites caps` job through it.

## Decision log

- 2026-11-16: Option A (William: "A i agree. skipping wren adapter sure"). The code must make "the merge to a shared decoupled runtime using pg" smooth: wren's turn code is copied unchanged and the store is an interface.
- 2026-11-16: The SDK stays a type and serde library, as in wren. Handlers keep `restate.object` and `ctx`.
- 2026-11-16: The ingress is a `fetch` over the store, not a port: the CLI runs while the desk is down, and the client stays the official one.
- 2026-11-16: One dispatcher per file by pid. Leases alone double a live turn after the Mac sleeps past them.
- 2026-11-16: `takeOver` and `due` are ours, not wren's verbs. wren runs one dispatcher per Lambda and has no idle stop.
- 2026-11-16: The Restate backfill of the run history is removed, not ported: the engine has had no Restate since 11-09.
