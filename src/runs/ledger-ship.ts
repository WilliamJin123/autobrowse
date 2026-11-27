/**
 * The run ledgers to wren's lake (wren designs/2026-10-11-lake.md, "autobrowse ledgers"): each
 * month file of `calls/`, `flows/` and `engine/` goes gzipped to the track bucket as
 * `ledgers/<kind>/<file>.gz`, and again whenever it grew. The bodies ledger stays here: it holds
 * inputs and answers. A line half written when read is dropped by the lake and lands next time.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const LEDGERS = ["calls", "flows", "engine"] as const;

const MONTH_FILE = /^[a-z]+-\d{4}-\d{2}\.jsonl$/;

export async function shipLedgers(o: {
  /** The stats dir (`statsDir()`): the ledgers' folders are in it. */
  dir: string;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Each file's size when last shipped; the caller keeps it between runs. */
  sent: Map<string, number>;
}): Promise<string[]> {
  const shipped: string[] = [];
  for (const kind of LEDGERS) {
    const d = join(o.dir, kind);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)
      .filter((f) => MONTH_FILE.test(f))
      .sort()) {
      const p = join(d, f);
      const size = statSync(p).size;
      if (o.sent.get(p) === size) continue;
      await o.put(`ledgers/${kind}/${f}.gz`, gzipSync(readFileSync(p)), "application/gzip");
      o.sent.set(p, size);
      shipped.push(`${kind}/${f}`);
    }
  }
  return shipped;
}
