/**
 * Files a run needs, on whichever machine runs it. `autobrowse run` hands a
 * plan to Restate, and the prod box runs it: a path on this Mac means
 * nothing there. So the CLI ships each local file the plan names to the
 * `inputs/` prefix of the shots bucket (`inputs/owners/<owner>/` for an
 * owner, src/owner.ts) and puts an `s3://` ref in its place. The box may
 * read only its prefix, and objects there expire after a week
 * (deploy/terraform/shots.tf): it sees the files a plan named, nothing else.
 * `resolveFile` turns a ref (or a signed https URL) back into a local file, cached by
 * content per owner: the one way every upload act and site route reads a plan's file.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { type AwsConfig, awsConfigFromEnv, operator, ownerKeys } from "../owner.js";

export const INPUTS_PREFIX = ownerKeys(operator()).inputs;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
};

const looksLikePath = (s: string) => /^(\/|~\/|\.\.?\/)/.test(s) && !s.includes("\n");
const expand = (s: string) => (s.startsWith("~/") ? join(homedir(), s.slice(2)) : resolve(s));

export interface InputStore {
  /** Store the file under `key` (streamed: a video never sits in memory); the ref the box reads it back by. */
  put(key: string, path: string, size: number, contentType: string): Promise<string>;
}

/**
 * Every string in the plan that names a file on this machine, shipped and
 * swapped for its ref. Keys are content hashes, so the same file ships once.
 */
export async function shipPlanFiles(
  plan: unknown,
  store: InputStore,
  prefix: string = INPUTS_PREFIX,
): Promise<{ plan: unknown; shipped: string[] }> {
  const shipped: string[] = [];
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") {
      if (!looksLikePath(v)) return v;
      const path = expand(v);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) return v;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      const ext = extname(path).toLowerCase();
      const key = `${prefix}${hash.digest("hex").slice(0, 24)}${ext}`;
      shipped.push(v);
      return store.put(key, path, st.size, TYPES[ext] ?? "application/octet-stream");
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    }
    return v;
  };
  return { plan: await walk(plan), shipped };
}

export interface RemoteReaders {
  /** An `s3://bucket/key` ref as a byte stream. */
  s3?: (bucket: string, key: string) => Promise<ReadableStream<Uint8Array>>;
  fetch?: typeof fetch;
  /** Where fetched files stay; `FILE_CACHE` unless a test gives its own. */
  cache?: string;
}

const s3Read = async (bucket: string, key: string) => {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  // The worker's owner reads with its own session: the box role may not read another owner's inputs.
  const s3 = new S3Client({ ...awsConfigFromEnv(), followRegionRedirects: true });
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!got.Body) throw new Error(`s3://${bucket}/${key}: empty`);
  return got.Body.transformToWebStream() as ReadableStream<Uint8Array>;
};

/** A plan's file: an `s3://` ref, an https URL (a signed one is a bearer), or a path on this machine. */
const isRemote = (f: string) => /^(s3|https?):\/\//i.test(f);

/** One field type for every workflow's file input (designs/2026-11-02-typed-inputs-files-undo.md §2). */
export const fileField = (what?: string) => {
  const f = z
    .string()
    .min(1)
    .refine((v) => isRemote(v) || !v.includes("://"), "an s3:// ref, an https URL or a path");
  return what ? f.describe(what) : f;
};

/** Fetched inputs, per owner, named by content: a retry or a later step reads the same file. `FILE_CACHE_DIR` moves it. */
export const FILE_CACHE = process.env.FILE_CACHE_DIR || join(tmpdir(), "autobrowse-files");
/** A cached file unused this long goes; so does the oldest past the owner's cap. */
export const CACHE_MAX_AGE_MS = 24 * 3600_000;
export const CACHE_MAX_BYTES = 20e9;
const SWEEP_EVERY_MS = 3600_000;
let sweptAt = 0;

/**
 * The local path for a plan's file. A path stays as is. An `s3://` ref or a URL streams once
 * into `<cache>/<owner>/<name>` and is read from there after; a key named by its content
 * hash (`shipPlanFiles`) is checked against the bytes. A URL is keyed whole (a new signature is a
 * new download: the bytes behind a path may change) and is never put in an error.
 */
export async function resolveFile(f: string, r: RemoteReaders = {}): Promise<string> {
  if (!isRemote(f)) return expand(f);
  const cache = r.cache ?? FILE_CACHE;
  const s3 = f.match(/^s3:\/\/([^/]+)\/(.+)$/i);
  const owner = s3?.[2]?.match(/owners\/([^/]+)\//)?.[1] || (s3 ? "_" : "_url");
  const name = s3
    ? basename(s3[2] as string)
    : `${createHash("sha256").update(f).digest("hex").slice(0, 24)}${extname(new URL(f).pathname).toLowerCase()}`;
  const dest = join(cache, owner, name);
  const now = new Date();
  if (
    await utimes(dest, now, now).then(
      () => true,
      () => false,
    )
  )
    return dest;
  await mkdir(join(cache, owner), { recursive: true });
  let body: ReadableStream<Uint8Array>;
  if (s3) body = await (r.s3 ?? s3Read)(s3[1] as string, s3[2] as string);
  else {
    const res = await (r.fetch ?? fetch)(f);
    if (!res.ok || !res.body) throw new Error(`a file URL answered ${res.status}`);
    body = res.body;
  }
  const part = `${dest}.part-${randomUUID().slice(0, 8)}`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(body as never),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) {
          hash.update(c);
          yield c;
        }
      },
      createWriteStream(part),
    );
    const named = name.match(/^([0-9a-f]{24})\./)?.[1];
    if (s3 && named && !hash.digest("hex").startsWith(named))
      throw new Error(`${s3[2]}: the bytes do not match the name's sha256`);
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  if (Date.now() - sweptAt > SWEEP_EVERY_MS) {
    sweptAt = Date.now();
    void sweepFileCache({ cache }).catch(() => {});
  }
  return dest;
}

/**
 * Drops cached files unused for `maxAgeMs` (and stale partial downloads), then each owner's
 * oldest past `maxBytes`. Answers how many went.
 */
export async function sweepFileCache(
  o: { cache?: string; now?: number; maxAgeMs?: number; maxBytes?: number } = {},
): Promise<number> {
  const cache = o.cache ?? FILE_CACHE;
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? CACHE_MAX_AGE_MS;
  const maxBytes = o.maxBytes ?? CACHE_MAX_BYTES;
  let gone = 0;
  const owners = await readdir(cache).catch(() => [] as string[]);
  for (const owner of owners) {
    const dir = join(cache, owner);
    const files = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const st = await stat(join(dir, name)).catch(() => null);
      if (st?.isFile()) files.push({ path: join(dir, name), at: st.mtimeMs, size: st.size });
    }
    files.sort((a, b) => b.at - a.at);
    let kept = 0;
    for (const f of files) {
      const stale = now - f.at > maxAge || kept + f.size > maxBytes;
      if (
        stale &&
        (await rm(f.path).then(
          () => true,
          () => false,
        ))
      )
        gone++;
      else if (!stale) kept += f.size;
    }
  }
  return gone;
}

/** The shots bucket as the input store: refs are `s3://<bucket>/inputs/…`. */
export function s3InputStore(bucket: string, aws: AwsConfig): InputStore {
  const client = import("@aws-sdk/client-s3").then(({ S3Client, PutObjectCommand }) => ({
    s3: new S3Client(aws),
    PutObjectCommand,
  }));
  return {
    async put(key, path, size, contentType) {
      const { s3, PutObjectCommand } = await client;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return `s3://${bucket}/${key}`;
    },
  };
}
