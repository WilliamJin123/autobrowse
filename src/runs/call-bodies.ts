/**
 * Every site call's input and answer (or error), kept: the calls ledger holds the row, this holds
 * the data. One gzip member per line, appended to `<dir>/<YYYY-MM-DD>/<HH>.jsonl.gz` (UTC); gunzip
 * reads the members as one file. Secret-named fields and token-shaped strings are masked
 * (`redactJson`). A closed hour ships to S3 with the shots (services-state.ts, root `calls`).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { redactJson } from "../browser/network.js";

export interface CallBody {
  id: string;
  at: string;
  service: string;
  site: string;
  route: string;
  account: string | null;
  caller: string | null;
  ok: boolean;
  input: unknown;
  answer?: unknown;
  error?: string | null;
}

/** Past this a line keeps its size, not its answer: one S3 object stays under the shipper's 20 MB. */
const MAX_LINE = 16 * 1024 * 1024;

const fileOf = (dir: string, at: string) => ({
  folder: join(dir, at.slice(0, 10)),
  file: join(dir, at.slice(0, 10), `${at.slice(11, 13)}.jsonl.gz`),
});

/** Appends one body; its id, or null when the disk refused (a full disk never fails the call). */
export function appendBody(dir: string, b: Omit<CallBody, "id">): string | null {
  const id = randomUUID();
  const line: CallBody = {
    id,
    ...b,
    input: redactJson(b.input),
    ...(b.answer !== undefined ? { answer: redactJson(b.answer) } : {}),
  };
  let text = JSON.stringify(line);
  if (text.length > MAX_LINE) text = JSON.stringify({ ...line, answer: { tooBig: text.length } });
  try {
    const { folder, file } = fileOf(dir, b.at);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    appendFileSync(file, gzipSync(`${text}\n`), { mode: 0o600 });
    return id;
  } catch {
    return null;
  }
}

/** One UTC day's bodies, oldest first; `hour` narrows to one file. */
export function readBodies(dir: string, day: string, hour?: string): CallBody[] {
  const folder = join(dir, day);
  let files: string[];
  try {
    files = readdirSync(folder)
      .filter(
        (f) => f.endsWith(".jsonl.gz") && (!hour || f === `${hour.padStart(2, "0")}.jsonl.gz`),
      )
      .sort();
  } catch {
    return [];
  }
  const out: CallBody[] = [];
  for (const f of files)
    for (const line of gunzipSync(readFileSync(join(folder, f)))
      .toString("utf8")
      .split("\n"))
      if (line) out.push(JSON.parse(line) as CallBody);
  return out;
}

/** A file whose hour has ended: it no longer grows, so it ships once (`<day>/<HH>.jsonl.gz`). */
export const closedHour = (rel: string, now = Date.now()): boolean => {
  const m = /^(\d{4}-\d{2}-\d{2})[/\\](\d{2})\.jsonl\.gz$/.exec(rel);
  return Boolean(m && Date.parse(`${m[1]}T${m[2]}:00:00Z`) + 3_600_000 <= now);
};
