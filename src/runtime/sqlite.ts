/**
 * The runner's store on one SQLite file (designs/2026-11-16-local-runner.md). Tables and columns:
 * a subset of wren's `rt.*` (`packages/runtime/src/pg/schema.ts`); the SQL of each verb follows
 * wren's `store.ts`. Times are epoch ms. Every write is one `BEGIN IMMEDIATE` transaction.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { RetryPolicy } from "./core/registry.js";
import type { ErrorJson, Invocation, Loaded, Row, Writes } from "./core/turn.js";
import {
  type Awake,
  type Claim,
  Fenced,
  type FinalOutcome,
  type HandlerRow,
  type Lane,
  type Result,
  type RuntimeStore,
  retryDelay,
  SERVER_RETRY,
  type Status,
  type Submit,
} from "./store.js";

/** wren's `'infinity'`: a suspended row no timer wakes. */
const NEVER = Number.MAX_SAFE_INTEGER;
const KILLED: ErrorJson = { message: "killed", code: 409 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  handler TEXT NOT NULL,
  key TEXT,
  exclusive INTEGER NOT NULL DEFAULT 0,
  holds INTEGER NOT NULL DEFAULT 0,
  input BLOB NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'suspended', 'done', 'paused', 'killed')),
  run_at INTEGER NOT NULL,
  wake INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  cancel INTEGER NOT NULL DEFAULT 0,
  idem_key TEXT,
  parent_id TEXT,
  parent_seq INTEGER,
  caller_waits INTEGER NOT NULL DEFAULT 0,
  result BLOB,
  error TEXT,
  last_failure TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS invocations_idem
  ON invocations (service, handler, coalesce(key, ''), idem_key) WHERE idem_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invocations_holder ON invocations (service, key) WHERE holds;
CREATE INDEX IF NOT EXISTS invocations_due ON invocations (status, run_at);
CREATE INDEX IF NOT EXISTS invocations_key_queue ON invocations (service, key, created_at)
  WHERE exclusive AND status = 'pending' AND NOT holds;
CREATE INDEX IF NOT EXISTS invocations_parent ON invocations (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal (
  invocation_id TEXT NOT NULL REFERENCES invocations (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  value BLOB,
  error TEXT,
  wake_at INTEGER,
  ref TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (invocation_id, seq)
);
CREATE INDEX IF NOT EXISTS journal_attach ON journal (ref) WHERE kind = 'attach' AND NOT done;

CREATE TABLE IF NOT EXISTS state (
  service TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  value BLOB NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (service, key, name)
);

CREATE TABLE IF NOT EXISTS awakeables (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  value BLOB,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS awakeables_invocation ON awakeables (invocation_id);

CREATE TABLE IF NOT EXISTS handlers (
  service TEXT NOT NULL,
  handler TEXT NOT NULL,
  object INTEGER NOT NULL,
  exclusive INTEGER NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (service, handler)
);

-- the one dispatcher per name (a lane); its pid
CREATE TABLE IF NOT EXISTS runners (
  name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

/** node:sqlite warns it is experimental on first load: dropped, so the CLI's stderr stays clean. */
function openDatabase(file: string): DatabaseSync {
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(typeof w === "string" ? w : w?.message).includes("SQLite")) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync: Db } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    return new Db(file);
  } finally {
    process.emitWarning = emit;
  }
}

const bool = (b: boolean) => (b ? 1 : 0);
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = <T>(s: unknown): T | null => (typeof s === "string" ? (JSON.parse(s) as T) : null);
const bytes = (v: unknown): Uint8Array | null =>
  v === null || v === undefined ? null : new Uint8Array(v as Uint8Array);
const list = (xs: Iterable<string>) => JSON.stringify([...xs]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Params = Record<string, SQLInputValue>;

export interface SqliteStoreOptions {
  /** Test clock for due times and leases; default `Date.now`. */
  now?: () => number;
}

export function sqliteStore(file: string, o: SqliteStoreOptions = {}): RuntimeStore {
  const db = openDatabase(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // a kept `ctx.run` result must survive a power cut: else its act runs again
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const clock = o.now ?? Date.now;

  const cache = new Map<string, StatementSync>();
  const st = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const run = (sql: string, p: Params = {}) => Number(st(sql).run(p).changes);
  const get = <T>(sql: string, p: Params = {}) => st(sql).get(p) as T | undefined;
  const all = <T>(sql: string, p: Params = {}) => st(sql).all(p) as T[];

  const listeners = new Set<() => void>();
  const ping = () => {
    for (const f of [...listeners]) f();
  };
  let depth = 0;
  /** One `BEGIN IMMEDIATE` transaction; listeners hear of it after commit, unless `quiet`. */
  const tx = <T>(f: () => T, quiet = false): T => {
    if (depth > 0) return f();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const out = f();
      db.exec("COMMIT");
      depth--;
      if (!quiet) queueMicrotask(ping);
      return out;
    } catch (e) {
      depth--;
      db.exec("ROLLBACK");
      throw e;
    }
  };

  // ── wren's rt.wake, rt.cancel, rt.fence ─────────────────────────────────────────────────────
  const wake = (id: string, now: number) =>
    run(
      `UPDATE invocations SET wake = 1,
         status = CASE WHEN status = 'suspended' THEN 'pending' ELSE status END,
         run_at = CASE WHEN status = 'suspended' THEN $now ELSE run_at END
       WHERE id = $id AND status IN ('pending', 'running', 'suspended')`,
      { id, now },
    );
  const cancelRow = (id: string, now: number) => {
    const n = run(
      `UPDATE invocations SET cancel = 1 WHERE id = $id AND status NOT IN ('done', 'killed')`,
      { id },
    );
    wake(id, now);
    return n > 0;
  };
  const fence = (id: string, attempt: number, leaseMs: number) => {
    const n = run(
      `UPDATE invocations SET lease_until = $until
       WHERE id = $id AND attempt = $attempt AND status = 'running'`,
      { id, attempt, until: clock() + leaseMs },
    );
    if (n === 0) throw new Fenced(`rt fenced: ${id} attempt ${attempt}`);
  };

  const laneSql = (l: Lane) =>
    `${l.only ? "AND i.service IN (SELECT value FROM json_each($only))" : ""}
     ${l.skip?.size ? "AND i.id NOT IN (SELECT value FROM json_each($skip))" : ""}`;
  const laneParams = (l: Lane): Params => ({
    ...(l.only ? { only: list(l.only) } : {}),
    ...(l.skip?.size ? { skip: list(l.skip) } : {}),
  });

  /** End a row: wren `finish`'s `end`. */
  const end = (
    inv: Pick<Invocation, "id" | "parent_id" | "parent_seq">,
    status: "done" | "killed",
    result: Uint8Array | null,
    error: ErrorJson | null,
    now: number,
  ) => {
    run(
      `UPDATE invocations SET status = $status, result = $result, error = $error, holds = 0,
         lease_until = NULL, completed_at = $now WHERE id = $id`,
      { id: inv.id, status, result, error: json(error), now },
    );
    const attached = all<{ invocation_id: string }>(
      `UPDATE journal SET done = 1, value = $result, error = $error, at = $now
       WHERE kind = 'attach' AND ref = $id AND NOT done RETURNING invocation_id`,
      { id: inv.id, result, error: json(error), now },
    );
    for (const w of new Set(attached.map((a) => a.invocation_id))) wake(w, now);
    if (inv.parent_id && inv.parent_seq !== null) {
      run(
        `UPDATE journal SET done = 1, value = $result, error = $error, at = $now
         WHERE invocation_id = $parent AND seq = $seq AND NOT done`,
        { parent: inv.parent_id, seq: inv.parent_seq, result, error: json(error), now },
      );
      wake(inv.parent_id, now);
    }
  };

  /** One flush's rows: wren `writes`, run inside the fenced transaction. */
  const writes = (inv: Invocation, w: Writes, now: number) => {
    for (const r of w.journal.values())
      run(
        `INSERT INTO journal (invocation_id, seq, kind, name, done, value, error, wake_at, ref, tries, first_at, at)
         VALUES ($inv, $seq, $kind, $name, $done, $value, $error, $wake_at, $ref, $tries, $first_at, $now)
         ON CONFLICT (invocation_id, seq) DO UPDATE SET done = excluded.done, value = excluded.value,
           error = excluded.error, tries = excluded.tries, first_at = excluded.first_at, at = excluded.at
         WHERE NOT journal.done`,
        {
          inv: inv.id,
          seq: r.seq,
          kind: r.kind,
          name: r.name,
          done: bool(r.done),
          value: r.value,
          error: json(r.error),
          wake_at: r.wake_at?.getTime() ?? null,
          ref: r.ref,
          tries: r.tries,
          first_at: r.first_at?.getTime() ?? null,
          now,
        },
      );
    if (inv.key !== null) {
      const at = { service: inv.service, key: inv.key };
      if (w.clearAll)
        run(
          `DELETE FROM state WHERE service = $service AND key = $key
             AND name NOT IN (SELECT value FROM json_each($keep))`,
          { ...at, keep: list(w.sets.keys()) },
        );
      if (w.clears.size)
        run(
          `DELETE FROM state WHERE service = $service AND key = $key
             AND name IN (SELECT value FROM json_each($names))`,
          { ...at, names: list(w.clears) },
        );
      for (const [name, value] of w.sets)
        run(
          `INSERT INTO state (service, key, name, value, at) VALUES ($service, $key, $name, coalesce($value, X''), $now)
           ON CONFLICT (service, key, name) DO UPDATE SET value = excluded.value, at = excluded.at`,
          { ...at, name, value, now },
        );
    }
    for (const c of w.children)
      run(
        `INSERT INTO invocations (id, service, handler, key, exclusive, input, headers,
           parent_id, parent_seq, run_at, idem_key, caller_waits, created_at)
         VALUES ($id, $service, $handler, $key,
           coalesce((SELECT exclusive FROM handlers WHERE service = $service AND handler = $handler),
             $key IS NOT NULL),
           coalesce($input, X''), $headers, $parent, $seq, $run_at, $idem, $waits, $now)
         ON CONFLICT DO NOTHING`,
        {
          id: c.id,
          service: c.service,
          handler: c.handler,
          key: c.key,
          input: c.input,
          headers: JSON.stringify(c.headers ?? {}),
          parent: c.parent_id,
          seq: c.parent_seq,
          run_at: c.run_at.getTime(),
          idem: c.idem_key,
          waits: bool(c.caller_waits ?? false),
          now,
        },
      );
    for (const a of w.awakes) awake(a, now);
    for (const id of w.cancels) cancelRow(id, now);
    if (w.uncancel) run(`UPDATE invocations SET cancel = 0 WHERE id = $id`, { id: inv.id });
    // last, so a child sent in this flush exists: an attach whose target already ended settles now
    if ([...w.journal.values()].some((r) => r.kind === "attach" && !r.done)) {
      const open = all<{ seq: number; ref: string }>(
        `SELECT seq, ref FROM journal WHERE invocation_id = $id AND kind = 'attach' AND NOT done`,
        { id: inv.id },
      );
      let settled = false;
      for (const a of open) {
        const t = get<{ status: string; result: Uint8Array | null; error: string | null }>(
          `SELECT status, result, error FROM invocations WHERE id = $id`,
          { id: a.ref },
        );
        if (t && t.status !== "done" && t.status !== "killed") continue;
        run(
          `UPDATE journal SET done = 1, value = $value, error = $error, at = $now
           WHERE invocation_id = $id AND seq = $seq`,
          {
            id: inv.id,
            seq: a.seq,
            value: t?.result ?? null,
            error: t ? t.error : json({ message: "invocation not found", code: 404 }),
            now,
          },
        );
        settled = true;
      }
      if (settled) wake(inv.id, now);
    }
  };

  const awake = (a: Awake, now: number) => {
    const n = run(
      `INSERT INTO awakeables (id, invocation_id, seq, value, error, at)
       VALUES ($id, $inv, $seq, $value, $error, $now)
       ON CONFLICT DO NOTHING`,
      { id: a.id, inv: a.invocation, seq: a.seq, value: a.value, error: json(a.error), now },
    );
    if (n > 0) wake(a.invocation, now);
  };

  return {
    async register(defs: readonly HandlerRow[]) {
      const now = clock();
      tx(() => {
        for (const h of defs)
          run(
            `INSERT INTO handlers (service, handler, object, exclusive, private, at)
             VALUES ($service, $handler, $object, $exclusive, $private, $now)
             ON CONFLICT (service, handler) DO UPDATE SET object = excluded.object,
               exclusive = excluded.exclusive, private = excluded.private, at = excluded.at`,
            {
              service: h.service,
              handler: h.handler,
              object: bool(h.object),
              exclusive: bool(h.exclusive),
              private: bool(h.private),
              now,
            },
          );
      });
    },

    async handlers() {
      return all<Record<string, unknown>>(
        `SELECT service, handler, object, exclusive, private FROM handlers`,
      ).map((r) => ({
        service: String(r.service),
        handler: String(r.handler),
        object: r.object === 1,
        exclusive: r.exclusive === 1,
        private: r.private === 1,
      }));
    },

    async submit(s: Submit) {
      const now = clock();
      const fresh = tx(() =>
        run(
          `INSERT INTO invocations (id, service, handler, key, exclusive, input, headers,
             idem_key, run_at, caller_waits, created_at)
           VALUES ($id, $service, $handler, $key,
             coalesce((SELECT exclusive FROM handlers WHERE service = $service AND handler = $handler),
               $key IS NOT NULL),
             coalesce($input, X''), $headers, $idem, $run_at, $waits, $now)
           ON CONFLICT DO NOTHING`,
          {
            id: s.id,
            service: s.service,
            handler: s.handler,
            key: s.key,
            input: s.input,
            headers: JSON.stringify(s.headers),
            idem: s.idemKey,
            run_at: s.runAt.getTime(),
            waits: bool(s.callerWaits ?? false),
            now,
          },
        ),
      );
      if (fresh) return { id: s.id, fresh: true };
      if (s.idemKey === null) return { id: s.id, fresh: false };
      const old = await this.byIdempotencyKey(s.service, s.handler, s.key, s.idemKey);
      if (!old) throw new Error(`rt: submit of ${s.service}/${s.handler} lost its row`);
      return { id: old, fresh: false };
    },

    async claim(n: number, leaseMs: number, now: number, lane: Lane = {}): Promise<Claim[]> {
      if (lane.only?.length === 0 || n <= 0) return [];
      return tx(() => {
        const ids = all<{ id: string }>(
          `SELECT i.id FROM invocations i
           WHERE ((i.status IN ('pending', 'suspended') AND i.run_at <= $at)
                  OR (i.status = 'running' AND i.lease_until < $at))
             ${laneSql(lane)}
             AND (NOT i.exclusive OR i.holds OR (
               NOT EXISTS (SELECT 1 FROM invocations h WHERE h.service = i.service AND h.key = i.key AND h.holds)
               AND i.id = (
                 SELECT o.id FROM invocations o
                 WHERE o.service = i.service AND o.key = i.key AND o.exclusive AND o.status = 'pending'
                   AND NOT o.holds AND o.run_at <= $at
                 ORDER BY o.created_at, o.rowid LIMIT 1)))
           ORDER BY i.run_at LIMIT $n`,
          { at: now, n, ...laneParams(lane) },
        );
        return ids.map(
          ({ id }) =>
            get<Claim>(
              `UPDATE invocations SET status = 'running', attempt = attempt + 1, wake = 0,
                 holds = exclusive, lease_until = $until, started_at = coalesce(started_at, $now)
               WHERE id = $id RETURNING id, attempt, service, handler`,
              { id, until: clock() + leaseMs, now: clock() },
            ) as Claim,
        );
      }, true);
    },

    async nextDue(lane: Lane = {}) {
      if (lane.only?.length === 0) return null;
      const now = clock();
      const r = get<{ at: number | null }>(
        `SELECT min(t) AS at FROM (
           SELECT min(run_at) AS t FROM invocations i
             WHERE status IN ('pending', 'suspended') AND run_at > $now AND run_at < $never ${laneSql(lane)}
           UNION ALL
           SELECT min(lease_until) FROM invocations i WHERE status = 'running' ${laneSql(lane)})`,
        { now, never: NEVER, ...laneParams(lane) },
      );
      return r?.at == null ? null : new Date(r.at);
    },

    async load(id: string, attempt: number): Promise<Loaded | undefined> {
      const r = get<Record<string, unknown>>(
        `SELECT id, service, handler, key, input, headers, attempt, failures, cancel, parent_id,
           parent_seq, caller_waits
         FROM invocations WHERE id = $id AND attempt = $attempt AND status = 'running'`,
        { id, attempt },
      );
      if (!r) return undefined;
      const inv: Invocation = {
        id: String(r.id),
        service: String(r.service),
        handler: String(r.handler),
        key: (r.key as string | null) ?? null,
        input: bytes(r.input) ?? new Uint8Array(),
        headers: parse<Record<string, string>>(r.headers) ?? {},
        attempt: Number(r.attempt),
        failures: Number(r.failures),
        cancel: r.cancel === 1,
        parent_id: (r.parent_id as string | null) ?? null,
        parent_seq: (r.parent_seq as number | null) ?? null,
        caller_waits: r.caller_waits === 1,
      };
      const journal = all<Record<string, unknown>>(
        `SELECT seq, kind, name, done, value, error, wake_at, ref, tries, first_at
         FROM journal WHERE invocation_id = $id ORDER BY seq`,
        { id },
      ).map(
        (j): Row => ({
          seq: Number(j.seq),
          kind: String(j.kind),
          name: String(j.name),
          done: j.done === 1,
          value: bytes(j.value),
          error: parse<ErrorJson>(j.error),
          wake_at: j.wake_at == null ? null : new Date(Number(j.wake_at)),
          ref: (j.ref as string | null) ?? null,
          tries: Number(j.tries),
          first_at: j.first_at == null ? null : new Date(Number(j.first_at)),
        }),
      );
      const state =
        inv.key === null
          ? []
          : all<{ name: string; value: Uint8Array }>(
              `SELECT name, value FROM state WHERE service = $service AND key = $key`,
              { service: inv.service, key: inv.key },
            );
      const awk = all<{ seq: number; value: Uint8Array | null; error: string | null }>(
        `SELECT seq, value, error FROM awakeables WHERE invocation_id = $id`,
        { id },
      );
      return {
        inv,
        journal,
        state: new Map(state.map((s) => [s.name, bytes(s.value) as Uint8Array])),
        awakeables: new Map(
          awk.map((a) => [a.seq, { value: bytes(a.value), error: parse<ErrorJson>(a.error) }]),
        ),
      };
    },

    async renew(id: string, attempt: number, leaseMs: number) {
      tx(() => fence(id, attempt, leaseMs), true);
    },

    async release(id: string, attempt: number, delayMs: number) {
      return (
        tx(() =>
          run(
            `UPDATE invocations SET status = 'pending', lease_until = NULL, run_at = $at
             WHERE id = $id AND attempt = $attempt AND status = 'running'`,
            { id, attempt, at: clock() + delayMs },
          ),
        ) === 1
      );
    },

    async flush(inv: Invocation, w: Writes, leaseMs: number) {
      tx(() => {
        fence(inv.id, inv.attempt, leaseMs);
        writes(inv, w, clock());
      });
    },

    async finish(
      inv: Invocation,
      w: Writes | null,
      outcome: FinalOutcome,
      policy: RetryPolicy | undefined,
      leaseMs: number,
      now = clock(),
    ) {
      try {
        tx(() => {
          fence(inv.id, inv.attempt, leaseMs);
          if (w) writes(inv, w, now);
          const failure = (status: Status, e: ErrorJson, extra = "", p: Params = {}) =>
            run(
              `UPDATE invocations SET status = $status, last_failure = $e, lease_until = NULL ${extra}
               WHERE id = $id`,
              { id: inv.id, status, e: json(e), ...p },
            );
          switch (outcome.type) {
            case "done":
              if ("value" in outcome) end(inv, "done", outcome.value, null, now);
              else end(inv, "done", null, outcome.error, now);
              break;
            case "failed": {
              const failures = inv.failures + 1;
              const max = policy?.maxAttempts ?? SERVER_RETRY.maxAttempts;
              if (failures >= max) {
                if ((policy?.onMaxAttempts ?? SERVER_RETRY.onMaxAttempts) === "kill")
                  end(inv, "killed", null, { message: outcome.error.message, code: 500 }, now);
                else failure("paused", outcome.error, ", failures = $failures", { failures });
              } else
                failure("pending", outcome.error, ", failures = $failures, run_at = $at", {
                  failures,
                  at: now + (outcome.retryAfterMs ?? retryDelay(policy, failures)),
                });
              break;
            }
            case "later":
              failure("pending", outcome.error, ", run_at = $at", { at: now + outcome.delayMs });
              break;
            case "paused":
              failure("paused", outcome.error);
              break;
            case "suspended":
              run(
                `UPDATE invocations SET
                   status = CASE WHEN wake THEN 'pending' ELSE 'suspended' END,
                   run_at = CASE WHEN wake THEN $now ELSE $at END,
                   lease_until = NULL
                 WHERE id = $id`,
                { id: inv.id, now, at: outcome.wakeAt ?? NEVER },
              );
              break;
          }
        });
      } catch (e) {
        if (e instanceof Fenced) return; // another turn owns it now; ours never happened
        throw e;
      }
    },

    async result(id: string): Promise<Result | undefined> {
      const r = get<{ status: Status; result: Uint8Array | null; error: string | null }>(
        `SELECT status, result, error FROM invocations WHERE id = $id`,
        { id },
      );
      return r ? { status: r.status, result: bytes(r.result), error: parse(r.error) } : undefined;
    },

    async byIdempotencyKey(service: string, handler: string, key: string | null, idem: string) {
      return get<{ id: string }>(
        `SELECT id FROM invocations WHERE service = $service AND handler = $handler
           AND coalesce(key, '') = $key AND idem_key = $idem`,
        { service, handler, key: key ?? "", idem },
      )?.id;
    },

    async retrying(id: string) {
      const r = get<{ failures: number; message: string }>(
        `WITH RECURSIVE tree AS (
           SELECT id, failures, last_failure, run_at, 0 AS depth FROM invocations WHERE id = $id
           UNION ALL
           SELECT c.id, c.failures, c.last_failure, c.run_at, t.depth + 1
           FROM invocations c JOIN tree t ON c.parent_id = t.id
           WHERE t.depth < 3 AND c.status NOT IN ('done', 'killed'))
         SELECT failures, json_extract(last_failure, '$.message') AS message FROM tree
         WHERE failures > 0 AND json_extract(last_failure, '$.message') IS NOT NULL
         ORDER BY depth DESC, run_at DESC LIMIT 1`,
        { id },
      );
      return r ? { count: r.failures, reason: r.message } : undefined;
    },

    async resolveAwakeable(a: Awake, now = clock()) {
      tx(() => awake(a, now));
    },

    async cancel(id: string, now = clock()) {
      return tx(() => cancelRow(id, now));
    },

    async kill(id: string) {
      const now = clock();
      return tx(() => {
        const ended = all<{ id: string; parent_id: string | null; parent_seq: number | null }>(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM invocations WHERE id = $id
             UNION SELECT c.id FROM invocations c JOIN tree t ON c.parent_id = t.id)
           SELECT i.id, i.parent_id, i.parent_seq FROM invocations i
           WHERE i.id IN (SELECT id FROM tree) AND i.status NOT IN ('done', 'killed')`,
          { id },
        );
        for (const r of ended) end(r, "killed", null, KILLED, now);
        return ended.length > 0;
      });
    },

    async resume(id: string) {
      return (
        tx(() =>
          run(
            `UPDATE invocations SET status = 'pending', failures = 0, run_at = $now
             WHERE id = $id AND status = 'paused'`,
            { id, now: clock() },
          ),
        ) > 0
      );
    },

    async open(services?: readonly string[]) {
      const r = get<{ n: number }>(
        `SELECT count(*) AS n FROM invocations i WHERE status NOT IN ('done', 'killed')
           ${services ? "AND i.service IN (SELECT value FROM json_each($only))" : ""}`,
        services ? { only: list(services) } : {},
      );
      return r?.n ?? 0;
    },

    async due(services?: readonly string[], now = clock()) {
      const r = get<{ n: number }>(
        `SELECT count(*) AS n FROM invocations i
         WHERE (status = 'running' OR (status IN ('pending', 'suspended') AND run_at <= $now))
           ${services ? "AND i.service IN (SELECT value FROM json_each($only))" : ""}`,
        services ? { only: list(services), now } : { now },
      );
      return r?.n ?? 0;
    },

    changed(_id: string, ms: number) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          listeners.delete(done);
          resolve();
        };
        const t = setTimeout(done, ms);
        listeners.add(done);
      });
    },

    onWake(f: () => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },

    async takeOver(name: string, lane: Lane = {}) {
      return tx(() => {
        const held = get<{ pid: number }>(`SELECT pid FROM runners WHERE name = $name`, { name });
        if (held && held.pid !== process.pid && alive(held.pid)) return false;
        run(
          `INSERT INTO runners (name, pid, at) VALUES ($name, $pid, $now)
           ON CONFLICT (name) DO UPDATE SET pid = excluded.pid, at = excluded.at`,
          { name, pid: process.pid, now: clock() },
        );
        run(
          `UPDATE invocations AS i SET status = 'pending', lease_until = NULL, run_at = $now
           WHERE status = 'running' ${laneSql(lane)}`,
          { now: clock(), ...laneParams(lane) },
        );
        return true;
      });
    },

    async close() {
      try {
        run(`DELETE FROM runners WHERE pid = $pid`, { pid: process.pid });
      } catch {}
      db.close();
    },
  };
}
