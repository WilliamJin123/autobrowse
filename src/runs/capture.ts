/**
 * What a run's model saw, for training (designs/2026-10-26-run-observations.md): each answer
 * and page tree, masked, once per hash in `<site>/<run>.obs.jsonl`, zstd at the run's end;
 * pictures as `blobs/<hash>.jpg`. Rows name them by hash. Both ship to the bucket and then
 * leave this disk (`clearShipped`); the run file stays.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, type ZstdOptions } from "node:zlib";
import { redactAria, redactText } from "../recorder/redact.js";
import { baseSite } from "./log.js";

export const BLOBS = "blobs";
/** Sixteen hex: unique enough within a machine's runs, short in every row. */
const hashOf = (b: string | Uint8Array): string =>
  createHash("sha256").update(b).digest("hex").slice(0, 16);

export const obsFile = (dir: string, site: string, run: string): string =>
  join(dir, baseSite(site), `${run}.obs.jsonl`);

/** Masked as a transcript is: secret-shaped values, then filled secret fields. */
export const maskObs = (text: string): string => redactAria(redactText(text));

export interface Capture {
  /** Stores the masked text once; its hash. */
  text(text: string): string;
  /** Stores a picture once; its hash. */
  picture(jpeg: Uint8Array): string;
  /** zstd the text file, so it ships; a later life of the run starts a new one beside it. */
  close(): Promise<void>;
}

/** The hashes a text file holds, read in pieces: a long run's file is hundreds of MB. */
function hashesIn(file: string): Set<string> {
  const seen = new Set<string>();
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    // a row opens with 22 bytes, `{"h":"<16 hex>`; `head` carries them across a piece's edge
    let head = "";
    let atStart = true;
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) {
      const b = buf.subarray(0, n);
      let i = 0;
      while (i < n) {
        const nl = b.indexOf(10, i);
        if (!atStart) {
          if (nl < 0) break;
          i = nl + 1;
          atStart = true;
          continue;
        }
        const end = Math.min(i + 22 - head.length, nl < 0 ? n : nl);
        head += b.toString("latin1", i, end);
        i = end;
        if (head.length === 22) {
          if (head.startsWith('{"h":"')) seen.add(head.slice(6));
          head = "";
          atStart = false;
        } else if (i < n) {
          // a line under 22 bytes: past its newline
          head = "";
          i++;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  return seen;
}

export function captureFor(dir: string, site: string, run: string): Capture {
  const file = obsFile(dir, site, run);
  const blobs = join(dir, BLOBS);
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const seen = existsSync(file) ? hashesIn(file) : new Set<string>();
  return {
    text(raw) {
      const text = maskObs(raw);
      const h = hashOf(text);
      if (!seen.has(h)) {
        seen.add(h);
        appendFileSync(file, `${JSON.stringify({ h, text })}\n`, { mode: 0o600 });
      }
      return h;
    },
    picture(jpeg) {
      const h = hashOf(jpeg);
      const to = join(blobs, `${h}.jpg`);
      if (!existsSync(to)) writeFileSync(to, jpeg, { mode: 0o600 });
      return h;
    },
    async close() {
      if (existsSync(file)) await packObs(file);
    },
  };
}

/**
 * `<run>.obs.jsonl` → `<run>.obs.<mtime>.jsonl.zst`: each life's file ships under its own key.
 * By stream, so zlib's threads do the work: a sync pack of a 538 MB file at level 19 held the
 * driver's main thread 15 minutes (WA-1118). Level 6 with long matches: 213 MB for 19 CPU-seconds;
 * level 9 gives 200 MB for 32, level 3 gives 239 MB for 15.
 * The text file takes its packed name first, so a new life never appends to a file being packed.
 */
export async function packObs(file: string): Promise<string> {
  const packing = /\.obs\.\d+\.jsonl$/.test(file);
  const from = packing
    ? file
    : file.replace(/\.jsonl$/, `.${Math.trunc(statSync(file).mtimeMs)}.jsonl`);
  if (!packing) renameSync(file, from);
  const to = `${from}.zst`;
  const tmp = `${to}.tmp`;
  await pipeline(
    createReadStream(from),
    createZstdCompress({
      params: {
        [constants.ZSTD_c_compressionLevel]: 6,
        [constants.ZSTD_c_enableLongDistanceMatching]: 1,
        // 128 MB: the most a default decoder takes
        [constants.ZSTD_c_windowLog]: 27,
      },
      // the window shrinks to a small file's size; newer than our @types/node
      pledgedSrcSize: statSync(from).size,
    } as ZstdOptions),
    createWriteStream(tmp, { mode: 0o600 }),
  );
  renameSync(tmp, to);
  rmSync(from);
  return to;
}

/** A life that died before its end, or in its pack, leaves its text file: packed once a day has passed. */
export async function packStale(dir: string, now = Date.now()): Promise<number> {
  let n = 0;
  if (!existsSync(dir)) return n;
  for (const site of readdirSync(dir, { withFileTypes: true })) {
    if (!site.isDirectory() || site.name === BLOBS) continue;
    for (const f of readdirSync(join(dir, site.name))) {
      const p = join(dir, site.name, f);
      if (!/\.obs(\.\d+)?\.jsonl$/.test(f) || now - statSync(p).mtimeMs <= 86_400_000) continue;
      // one at a time: each pack holds a 128 MB window
      await packObs(p);
      n++;
    }
  }
  return n;
}

/** What ships from the runs folder: run files, packed texts, pictures. */
export const keepRun = (rel: string): boolean =>
  /\.obs\.\d+\.jsonl\.zst$/.test(rel) ||
  rel.startsWith(`${BLOBS}/`) ||
  /\/\d{8}-\d{6}-[0-9a-f]{4}\.jsonl$/.test(rel) ||
  rel === "index.jsonl";

/** What leaves this disk once the bucket has it: texts and pictures; run files stay. */
export const clearRun = (rel: string): boolean =>
  /\.obs\.\d+\.jsonl\.zst$/.test(rel) || rel.startsWith(`${BLOBS}/`);
