/**
 * A browser whose owner died keeps running: a crashed CLI, a killed worker.
 * It holds its profile (the next launch into it fails) and memory. Such a
 * browser is an orphan: its root process was handed to init (ppid 1). This
 * finds the orphans on our own profiles and stops them. A browser whose
 * owner is alive is never touched, however old: the owner closes it (an
 * explore session closes itself when idle).
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
  /** Memory, KB: resident, or the footprint where `withFootprint` read it. */
  rss?: number;
  /** Seconds since it started. */
  age?: number;
}

export interface Orphan {
  pid: number;
  profile: string;
}

/** Root browser processes (not helpers) on a profile under `profilesDir`, whoever owns them. */
export function browserRoots(procs: Proc[], profilesDir: string): Array<Proc & Orphan> {
  const prefix = `--user-data-dir=${profilesDir.replace(/\/$/, "")}/`;
  const out: Array<Proc & Orphan> = [];
  for (const p of procs) {
    if (p.command.includes("--type=")) continue;
    const at = p.command.indexOf(prefix);
    if (at < 0) continue;
    const dir = p.command.slice(at + "--user-data-dir=".length).split(" --")[0] ?? "";
    out.push({ ...p, profile: basename(dir.trim()) });
  }
  return out;
}

/** Root browser processes (not helpers) on a profile under `profilesDir`, owned by init. */
export function orphanBrowsers(procs: Proc[], profilesDir: string, self = process.pid): Orphan[] {
  // In a container the worker can be init itself: ppid 1 is then our own live browser.
  if (self === 1) return [];
  return browserRoots(procs, profilesDir)
    .filter((p) => p.ppid === 1)
    .map((p) => ({ pid: p.pid, profile: p.profile }));
}

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, clock = ""] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return clock.split(":").reduce((s, n) => s * 60 + Number(n), 0) + Number(days) * 86_400;
}

export async function listProcs(): Promise<Proc[]> {
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m)
      procs.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rss: Number(m[3]),
        age: etimeSeconds(m[4] ?? "0"),
        command: m[5] ?? "",
      });
  }
  return procs;
}

/**
 * macOS: each pid's footprint in KB, compressed and swapped pages too. Under swap `ps` shows a
 * tenth of it (measured 11-05: a browser at 100 MB resident held 1.5 GB). Empty off macOS or on failure.
 */
export async function footprintKb(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (process.platform !== "darwin" || pids.length === 0) return out;
  const { stdout } = await promisify(execFile)("footprint", pids.map(String), {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" })); // a pid gone mid-read: the rest still print
  const unit: Record<string, number> = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 * 1024 };
  for (const m of stdout.matchAll(/\[(\d+)\]: \S+\s+Footprint: ([\d.]+) (B|KB|MB|GB)\b/g))
    out.set(Number(m[1]), Math.round(Number(m[2]) * (unit[m[3] as string] ?? 1)));
  return out;
}

/** Stop every orphan on our profiles; `dry` only names them. Never throws: a sweep is best effort. */
export async function reapOrphans(
  profilesDir: string,
  o: { dry?: boolean; procs?: () => Promise<Proc[]>; kill?: (pid: number) => void } = {},
): Promise<Orphan[]> {
  const procs = await (o.procs ?? listProcs)().catch(() => []);
  const orphans = orphanBrowsers(procs, profilesDir);
  if (o.dry) return orphans;
  const kill = o.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  return orphans.filter((x) => {
    try {
      kill(x.pid);
      return true;
    } catch {
      return false; // gone already
    }
  });
}

/**
 * macOS Chrome copies its app per headed launch (code_sign_clone) and removes the copy on a
 * clean exit. A signal or a crash leaves it: 62 by 11-08 (WA-1218). Copies share blocks with
 * Chrome.app until an update; then each pins the old version.
 */
export const chromeCloneDir = (): string =>
  join(dirname(tmpdir()), "X", "com.google.Chrome.code_sign_clone");

/** Copies some process holds open: a running Chrome's. Null when lsof cannot say. */
async function heldClones(dir: string): Promise<Set<string> | null> {
  const r = await promisify(execFile)("lsof", ["-Fn", "+D", dir], { timeout: 20_000 }).then(
    (x) => x.stdout,
    // exit 1 with no stderr: nothing open
    (e: { code?: unknown; stdout?: string; stderr?: string }) =>
      e.code === 1 && !e.stderr?.trim() ? (e.stdout ?? "") : null,
  );
  if (r === null) return null;
  return new Set([...r.matchAll(/code_sign_clone\.[A-Za-z0-9]+/g)].map((m) => m[0]));
}

/** Is any Google Chrome running? It then holds at least one copy. */
async function chromeRunning(): Promise<boolean> {
  return promisify(execFile)("pgrep", ["-x", "Google Chrome"]).then(
    () => true,
    () => false,
  );
}

/**
 * Remove Chrome's app copies that no process holds and older than `olderThanMs`.
 * Removes none when lsof fails, or when it sees none held while a Chrome runs (lsof missed it).
 * Returns how many went. Never throws.
 */
export async function reapChromeClones(
  o: {
    dir?: string;
    held?: (dir: string) => Promise<Set<string> | null>;
    running?: () => Promise<boolean>;
    olderThanMs?: number;
    now?: number;
  } = {},
): Promise<number> {
  if (!o.dir && process.platform !== "darwin") return 0;
  const { readdir, rm, stat } = await import("node:fs/promises");
  const dir = o.dir ?? chromeCloneDir();
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    n.startsWith("code_sign_clone."),
  );
  if (!names.length) return 0;
  const held = await (o.held ?? heldClones)(dir).catch(() => null);
  if (!held || (!held.size && (await (o.running ?? chromeRunning)()))) return 0;
  const cutoff = (o.now ?? Date.now()) - (o.olderThanMs ?? 10 * 60_000);
  let gone = 0;
  for (const name of names) {
    if (held.has(name)) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory() || st.mtimeMs > cutoff) continue;
    await rm(path, { recursive: true, force: true }).then(
      () => gone++,
      () => {},
    );
  }
  return gone;
}

/** Temp dirs a file-handling step makes and removes; one a crash left behind is only ever seconds old when in use. */
export const TEMP_PREFIXES = ["run-files-", "upload-", "passwords-"] as const;

/**
 * Remove our temp dirs older than `olderThanMs` (a crash mid-upload leaves a
 * copy of the file; a crashed Passwords import leaves logins on disk).
 * Returns how many went. Never throws.
 */
export async function reapTempDirs(
  o: { dir?: string; olderThanMs?: number; now?: number } = {},
): Promise<number> {
  const { readdir, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = o.dir ?? tmpdir();
  const cutoff = (o.now ?? Date.now()) - (o.olderThanMs ?? 60 * 60_000);
  let gone = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory() || st.mtimeMs > cutoff) continue;
    await rm(path, { recursive: true, force: true }).then(
      () => gone++,
      () => {},
    );
  }
  return gone;
}
