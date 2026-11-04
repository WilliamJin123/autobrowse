/**
 * Disk trim for closed browser profiles (WA-1056). Two moves, both safe to repeat:
 * - a cache folder over the cap goes whole; Chrome builds it again on the next launch.
 * - the component files Chrome copies into every profile (models, TTS, crx) become APFS
 *   clones of one copy: same bytes, one set of blocks, still copy-on-write per profile.
 * Identity data (cookies, storage, history, logins) is never touched.
 * A profile whose lock holder is alive is skipped, whatever host the lock names.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import {
  appendFile,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// clonefile(2); Node's COPYFILE_FICLONE copies in full on macOS (measured 2026-11-04)
const clone = (src: string, to: string) => promisify(execFile)("/bin/cp", ["-c", src, to]);

/** HTTP cache cap per profile, as a launch flag and as the trim's line: Chrome's own grew to 1.6 GB. */
export const DISK_CACHE_BYTES = 200 * 1024 * 1024;
/** The flag is a soft cap: a trim line above it keeps a cache at 210 MB from going every day. */
const TRIM_LINE_BYTES = 1.5 * DISK_CACHE_BYTES;

/** Rebuilt by Chrome on demand; never identity. */
export const CACHE_DIRS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "GraphiteDawnCache",
  "GPUPersistentCache",
  "ShaderCache",
  "GrShaderCache",
];

/** Per-profile copies of the same downloads (measured: 3.8 GB, 0.26 GB unique, 83 profiles). */
export const SHARED_DIRS = ["component_crx_cache", "WasmTtsEngine", "OnDeviceHeadSuggestModel"];
const MIN_CLONE_BYTES = 100 * 1024;

export interface TrimReport {
  profiles: number;
  /** Skipped: a live browser holds them. */
  open: string[];
  removed: Array<{ path: string; bytes: number }>;
  freedBytes: number;
  cloned: number;
  clonedBytes: number;
  /** Why cloning stopped (not APFS, a refused clone). */
  cloneError: string | null;
}

export interface TrimOptions {
  profilesDir: string;
  /** `hash<TAB>path<TAB>size<TAB>mtimeMs`: files already one shared copy, so a rerun hashes only new ones. */
  ledgerFile: string;
  dry?: boolean;
  /** APFS clones: macOS only. */
  clone?: boolean;
  alive?: (pid: number) => boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Host ignored on purpose: a rename (Mac → MacMiller) leaves live locks under the old name. */
async function lockedBy(
  profileDir: string,
  alive: (pid: number) => boolean,
): Promise<number | null> {
  const link = await readlink(join(profileDir, "SingletonLock")).catch(() => "");
  const m = /-(\d+)$/.exec(link);
  if (!m) return null;
  const pid = Number(m[1]);
  return alive(pid) ? pid : null;
}

async function* files(dir: string): AsyncGenerator<string> {
  const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

async function sizeOf(dir: string): Promise<number> {
  let n = 0;
  for await (const f of files(dir)) n += (await stat(f).catch(() => null))?.size ?? 0;
  return n;
}

function sha256(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

interface Seen {
  hash: string;
  /** Its profile folder; none for a ledger line. */
  profile?: string;
  path: string;
  size: number;
  mtime: number;
}

async function ledger(file: string): Promise<Map<string, Seen>> {
  const text = await readFile(file, "utf8").catch(() => "");
  const out = new Map<string, Seen>();
  for (const line of text.split("\n")) {
    const [hash, path, size, mtime] = line.split("\t");
    if (hash && path) out.set(path, { hash, path, size: Number(size), mtime: Number(mtime) });
  }
  return out;
}

export async function trimProfiles(o: TrimOptions): Promise<TrimReport> {
  const alive = o.alive ?? isAlive;
  const r: TrimReport = {
    profiles: 0,
    open: [],
    removed: [],
    freedBytes: 0,
    cloned: 0,
    clonedBytes: 0,
    cloneError: null,
  };
  const dirs = (await readdir(o.profilesDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const closed: string[] = [];
  // the lock is read again right before each write: the desk opens browsers at any time
  const open = async (dir: string) => (await lockedBy(dir, alive)) !== null;
  for (const name of dirs) {
    const dir = join(o.profilesDir, name);
    r.profiles++;
    if (await open(dir)) {
      r.open.push(name);
      continue;
    }
    closed.push(dir);
    for (const c of CACHE_DIRS) {
      const p = join(dir, c);
      const bytes = await sizeOf(p);
      if (bytes <= TRIM_LINE_BYTES) continue;
      if (!o.dry) {
        if (await open(dir)) break;
        await rm(p, { recursive: true, force: true });
      }
      r.removed.push({ path: p, bytes });
      r.freedBytes += bytes;
    }
  }

  if (o.clone) await cloneShared(closed, o, r, open);
  return r;
}

/** One copy per content; the rest become clones of it. mtime kept, so Chrome sees the same file. */
async function cloneShared(
  closed: string[],
  o: TrimOptions,
  r: TrimReport,
  open: (dir: string) => Promise<boolean>,
): Promise<void> {
  const known = await ledger(o.ledgerFile);
  const byHash = new Map<string, Seen[]>();
  for (const dir of closed)
    for (const d of SHARED_DIRS)
      for await (const path of files(join(dir, d))) {
        const s = await stat(path).catch(() => null);
        if (!s || s.size < MIN_CLONE_BYTES) continue;
        const mtime = Math.trunc(s.mtimeMs);
        const k = known.get(path);
        const hash =
          k && k.size === s.size && k.mtime === mtime ? k.hash : await sha256(path).catch(() => "");
        if (!hash) continue;
        const seen = { hash, path, size: s.size, mtime, profile: dir };
        byHash.set(hash, [...(byHash.get(hash) ?? []), seen]);
      }
  for (const group of byHash.values()) {
    // a file already in the ledger is already shared: the source of choice
    group.sort((a, b) => Number(!isShared(known, a)) - Number(!isShared(known, b)));
    const [src, ...rest] = group as [Seen, ...Seen[]];
    const lines: string[] = [];
    if (!isShared(known, src)) lines.push(line(src));
    for (const f of rest) {
      if (isShared(known, f)) continue;
      if (!o.dry) {
        if (f.profile && (await open(f.profile))) continue;
        const tmp = `${f.path}.clone-tmp`;
        try {
          await clone(src.path, tmp);
          const at = new Date(f.mtime);
          await utimes(tmp, at, at);
          await rename(tmp, f.path);
        } catch (err) {
          await rm(tmp, { force: true });
          r.cloneError = (err as Error).message;
          return;
        }
        lines.push(line(f));
      }
      r.cloned++;
      r.clonedBytes += f.size;
    }
    if (!o.dry && lines.length) await appendFile(o.ledgerFile, lines.join(""));
  }
}

const isShared = (known: Map<string, Seen>, f: Seen) => {
  const k = known.get(f.path);
  return !!k && k.hash === f.hash && k.size === f.size && k.mtime === f.mtime;
};
const line = (f: Seen) => `${f.hash}\t${f.path}\t${f.size}\t${f.mtime}\n`;

export function trimWording(r: TrimReport, dry: boolean): string[] {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
  const verb = dry ? "would free" : "freed";
  const lines = [
    `${r.profiles} profiles, ${r.open.length} open (skipped)`,
    `caches over ${TRIM_LINE_BYTES / 1024 ** 2} MB: ${r.removed.length}, ${verb} ${gb(r.freedBytes)}`,
  ];
  if (r.cloned)
    lines.push(`${dry ? "would clone" : "cloned"} ${r.cloned} shared files (${gb(r.clonedBytes)})`);
  if (r.cloneError) lines.push(`cloning stopped: ${r.cloneError}`);
  return lines;
}
