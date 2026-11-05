/**
 * Jobs (designs/2026-11-05-async-leverage.md §2): a long handler call starts and returns its
 * invocation id at once; the agent does other work, then collects. A job is a Restate send with
 * an idempotency key, so its result is kept and attachable, and the same call twice is one job.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Ingress } from "./client.js";

export interface JobRow {
  id: string;
  /** The base name (`desk`); the owner suffix is added on the call. */
  service: string;
  handler: string;
  key: string;
  /** Who started it: a session or agent id. */
  by: string | null;
  why: string | null;
  at: string;
}

export type JobState =
  | { id: string; done: true; ok: true; value: unknown }
  | { id: string; done: true; ok: false; error: string }
  | { id: string; done: false };

export interface JobsOptions {
  door: Pick<Ingress["job"], "send" | "result" | "output">;
  ledger: string;
  now?: () => Date;
}

/** Same call, same key: a second start is the first job (`PreviouslyAccepted`). */
export const jobKey = (service: string, handler: string, input: unknown): string =>
  `job:${createHash("sha256")
    .update(JSON.stringify([service, handler, input ?? null]))
    .digest("hex")
    .slice(0, 24)}`;

const errorOf = (id: string, err: unknown): JobState => ({
  id,
  done: true,
  ok: false,
  error: ((err as Error).message ?? String(err)).split("\n").slice(0, 3).join(" "),
});

export function jobs(o: JobsOptions) {
  const now = o.now ?? (() => new Date());
  const list = async (): Promise<JobRow[]> => {
    const text = await readFile(o.ledger, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as JobRow];
        } catch {
          return [];
        }
      });
  };

  return {
    async start(
      service: string,
      handler: string,
      input: unknown,
      a: { key?: string; by?: string | null; why?: string | null; delayMs?: number } = {},
    ): Promise<JobRow & { status: string }> {
      const key = a.key ?? jobKey(service, handler, input);
      const got = await o.door.send(service, handler, input, {
        key,
        ...(a.delayMs ? { delayMs: a.delayMs } : {}),
      });
      const row: JobRow = {
        id: got.invocationId,
        service,
        handler,
        key,
        by: a.by ?? null,
        why: a.why ?? null,
        at: now().toISOString(),
      };
      // A repeat start is the same job: one ledger row.
      if (!(await list()).some((r) => r.id === row.id)) {
        await mkdir(dirname(o.ledger), { recursive: true });
        await appendFile(o.ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      }
      return { ...row, status: got.status };
    },

    /** Done or not; never waits. */
    async peek(id: string): Promise<JobState> {
      const r = await o.door.output(id);
      if (!r.done) return { id, done: false };
      if (r.status >= 300) return errorOf(id, new Error(`HTTP ${r.status}: ${r.body}`));
      return { id, done: true, ok: true, value: r.body ? JSON.parse(r.body) : null };
    },

    /** Attach until done, or `{done: false}` at the timeout; the job runs on either way. */
    async wait(id: string, timeoutMs: number): Promise<JobState> {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<JobState>((ok) => {
        timer = setTimeout(() => ok({ id, done: false }), timeoutMs);
      });
      const attached = o.door.result(id).then(
        (value): JobState => ({ id, done: true, ok: true, value }),
        (err) => errorOf(id, err),
      );
      try {
        return await Promise.race([attached, late]);
      } finally {
        clearTimeout(timer);
      }
    },

    list,
  };
}
