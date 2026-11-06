/**
 * Every browser of ours on this machine, who owns it, how old and how big,
 * and the explore servers beside them (`autobrowse browsers`). The doctor
 * reads `warnings` from the same view: a forgotten session, an orphan, a
 * profile two processes fight over. It reports; a person or agent decides.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { hostname, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { ExploreInfo } from "../explore/server.js";
import { browserRoots, footprintKb, listProcs, type Proc } from "./reap.js";

/** An explore server idle this long, not held, is forgotten. */
export const IDLE_WARN_MINUTES = 120;
/** A held session this old is likely forgotten too. */
export const HELD_WARN_HOURS = 12;
/** One browser (its whole process tree) over this. */
export const BROWSER_WARN_MB = 1536;
/** An explore driver (the Node process) over this: it starts near 150 MB and stays under 300 (WA-1118). */
export const DRIVER_WARN_MB = 600;
/** All our browsers over this share of the machine's RAM. */
export const RAM_WARN_SHARE = 0.5;
/** More explore servers than this at once. */
export const EXPLORERS_WARN = 4;
/** What one more browser is counted as before it opens (measured 11-05: 0.8 to 2.4 GB each). */
export const NEW_BROWSER_MB = 1200;
/** Linux: under this share of RAM available, memory is tight. */
const AVAILABLE_TIGHT_SHARE = 0.15;

/** `desk`, `worker`, `explore:<port>`, `agent:<port>`, `teach:<port>`, `cli`, `orphan`, or `other` (launched by none of ours). */
export type Opener = string;

export interface BrowserRow {
  pid: number;
  opener: Opener;
  profile: string;
  /** Seconds. */
  age: number;
  /** Memory of the process tree: the footprint on macOS, resident elsewhere. */
  mb: number;
}

export interface ExplorerRow extends ExploreInfo {
  idleMinutes: number;
  /** Since its last command or page load (the info file's mtime). */
  idleMs: number;
  /** Memory of the driver process alone; its browser is a row of its own. */
  mb: number;
}

/** A profile whose `SingletonLock` names a live browser that is none of the rows. */
export interface Stranger {
  profile: string;
  pid: number;
}

export interface BrowsersView {
  browsers: BrowserRow[];
  explorers: ExplorerRow[];
  strangers: Stranger[];
  totalMb: number;
  ramMb: number;
}

const explorerOpener = (e: ExploreInfo): Opener =>
  `${e.driver === "person" ? "teach" : e.driver.startsWith("agent") ? "agent" : "explore"}:${e.port}`;

/** Who launched the browser `pid`: the first ancestor that is ours, by explore info or command line. */
export function openerOf(
  pid: number,
  profile: string,
  procs: Proc[],
  explorers: ExploreInfo[],
): Opener {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const root = byPid.get(pid);
  if (!root) return "gone";
  for (let p = byPid.get(root.ppid), hops = 0; p && hops < 8; p = byPid.get(p.ppid), hops++) {
    const ex = explorers.find(
      (e) => e.pid === p?.pid && (profile === e.site || profile.startsWith(`${e.site}@`)),
    );
    if (ex) return explorerOpener(ex);
    if (/app\/desk\.[jt]s\b/.test(p.command)) return "desk";
    if (/app\/main\.[jt]s\b/.test(p.command)) return "worker";
    if (/app\/cli\.[jt]s\b|\/autobrowse(\s|$)/.test(p.command)) return "cli";
  }
  // Checked last: in a container the worker is init itself.
  return root.ppid === 1 ? "orphan" : "other";
}

/** The explore servers whose process still lives, from their info files. */
export function readExplorers(
  procs: Proc[],
  dir = join(tmpdir(), "autobrowse"),
  now = Date.now(),
): ExplorerRow[] {
  const live = new Map(procs.map((p) => [p.pid, p]));
  const out: ExplorerRow[] = [];
  for (const name of safe(() => readdirSync(dir), [] as string[])) {
    if (!/^explore-\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    const info = safe(() => JSON.parse(readFileSync(file, "utf8")) as ExploreInfo, null);
    if (!info || !live.has(info.pid)) continue;
    const touched = safe(() => statSync(file).mtimeMs, now);
    const idleMs = Math.max(0, now - touched);
    out.push({
      ...info,
      idleMinutes: Math.floor(idleMs / 60_000),
      idleMs,
      mb: Math.round((live.get(info.pid)?.rss ?? 0) / 1024),
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/** The live pid in a profile's `SingletonLock` (`<host>-<pid>`), when it is this host's. */
export function lockHolder(profileDir: string, alive = isAlive): number | null {
  const link = safe(() => readlinkSync(join(profileDir, "SingletonLock")), "");
  const m = /^(.*)-(\d+)$/.exec(link);
  if (!m || m[1] !== hostname()) return null;
  const pid = Number(m[2]);
  return alive(pid) ? pid : null;
}

/** Everything `browsers` and `doctor` show; never throws. */
export async function browsersNow(profilesDir: string, procs?: Proc[]): Promise<BrowsersView> {
  const ps = procs ?? (await withFootprint(await listProcs().catch(() => []), profilesDir));
  return viewOf(ps, profilesDir, readExplorers(ps), totalmem() / 2 ** 20);
}

/** The same rows, our browsers' trees and explore drivers at their footprint (macOS; resident elsewhere). */
export async function withFootprint(procs: Proc[], profilesDir: string): Promise<Proc[]> {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const pids = new Set(readExplorers(procs).map((e) => e.pid));
  const walk = (p: Proc): void => {
    pids.add(p.pid);
    for (const k of kids.get(p.pid) ?? []) walk(k);
  };
  for (const root of browserRoots(procs, profilesDir)) walk(root);
  const real = await footprintKb([...pids]).catch(() => new Map<number, number>());
  return real.size
    ? procs.map((p) => (real.has(p.pid) ? { ...p, rss: real.get(p.pid) as number } : p))
    : procs;
}

export function viewOf(
  procs: Proc[],
  profilesDir: string,
  explorers: ExplorerRow[],
  ramMb: number,
  locks = (profile: string) => lockHolder(join(profilesDir, profile)),
): BrowsersView {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const treeKb = (p: Proc): number =>
    (p.rss ?? 0) + (kids.get(p.pid) ?? []).reduce((s, k) => s + treeKb(k), 0);
  const browsers = browserRoots(procs, profilesDir).map((p) => ({
    pid: p.pid,
    opener: openerOf(p.pid, p.profile, procs, explorers),
    profile: p.profile,
    age: p.age ?? 0,
    mb: Math.round(treeKb(p) / 1024),
  }));
  const ours = new Set(browsers.map((b) => b.pid));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const strangers: Stranger[] = [];
  for (const profile of safe(() => readdirSync(profilesDir), [] as string[])) {
    const pid = locks(profile);
    // A pid reused by something that is no browser is a stale lock: Chrome clears it.
    if (pid && !ours.has(pid) && /chrom/i.test(byPid.get(pid)?.command ?? ""))
      strangers.push({ profile, pid });
  }
  return {
    browsers,
    explorers,
    strangers,
    totalMb: browsers.reduce((s, b) => s + b.mb, 0),
    ramMb: Math.round(ramMb),
  };
}

/** One line per thing wrong, each naming its fix. */
export function warnings(v: BrowsersView): string[] {
  const out: string[] = [];
  for (const b of v.browsers.filter((x) => x.opener === "orphan"))
    out.push(`orphan browser on ${b.profile} (pid ${b.pid}): autobrowse reap`);
  for (const e of v.explorers) {
    if (!e.held && e.idleMinutes >= IDLE_WARN_MINUTES)
      out.push(
        `explore ${e.port} (${e.site}) idle ${e.idleMinutes} min: autobrowse browsers stop ${e.port}`,
      );
    const hours = (Date.now() - Date.parse(e.startedAt)) / 3_600_000;
    if (e.held && hours >= HELD_WARN_HOURS)
      out.push(
        `explore ${e.port} (${e.site}) held ${Math.floor(hours)} h: stop it (autobrowse browsers stop ${e.port}) or say why it is still needed`,
      );
  }
  const byProfile = new Map<string, BrowserRow[]>();
  for (const b of v.browsers) byProfile.set(b.profile, [...(byProfile.get(b.profile) ?? []), b]);
  for (const [profile, rows] of byProfile)
    if (rows.length > 1)
      out.push(
        `profile ${profile} open twice: ${rows.map((b) => `pid ${b.pid} (${b.opener})`).join(", ")}; stop one`,
      );
  for (const s of v.strangers)
    out.push(`profile ${s.profile} is locked by pid ${s.pid}, not ours: close that Chrome`);
  for (const e of v.explorers.filter((x) => x.mb > DRIVER_WARN_MB))
    out.push(
      `explore ${e.port} (${e.site}) driver uses ${e.mb} MB (it starts near 150): say so on WA-1118, then autobrowse stop ${e.port} and start again (the journal resumes)`,
    );
  for (const b of v.browsers.filter((x) => x.mb > BROWSER_WARN_MB))
    out.push(`${b.profile} (pid ${b.pid}, ${b.opener}) uses ${b.mb} MB: autobrowse browsers`);
  if (v.ramMb && v.totalMb > v.ramMb * RAM_WARN_SHARE)
    out.push(
      `browsers use ${v.totalMb} MB, ${Math.round((100 * v.totalMb) / v.ramMb)}% of RAM: autobrowse browsers`,
    );
  if (v.explorers.length > EXPLORERS_WARN)
    out.push(
      `${v.explorers.length} explore servers open: stop the idle ones (autobrowse browsers stop <port>)`,
    );
  return out;
}

/**
 * A live browser holds the profile: nothing was opened, nothing done. A caller waits for it
 * (`browser/profile-wait`), never calls it a failure of the act it was about to do.
 */
export class ProfileBusy extends Error {
  readonly profile: string;
  readonly pid: number;
  readonly opener: Opener;
  readonly profileDir: string;
  constructor(
    profile: string,
    pid: number,
    /** `explore:<port>`, `desk`, `cli`, … (`openerOf`). */
    opener: Opener,
    /** The profile's directory: where its `SingletonLock` is. */
    profileDir: string,
  ) {
    super(`profile ${profile} is open in pid ${pid} (${opener})`);
    this.profile = profile;
    this.pid = pid;
    this.opener = opener;
    this.profileDir = profileDir;
    this.name = "ProfileBusy";
  }
}

const BUSY_TEXT = /profile (\S+) is open in pid (\d+) \(([^)]+)\)/;

/**
 * The `ProfileBusy` behind `err`: itself, a cause down its chain, or (a wrapper that kept only
 * the words) its message. Null for anything else.
 */
export function profileBusyOf(err: unknown): ProfileBusy | null {
  for (let e: unknown = err, hops = 0; e && hops < 6; hops++) {
    if (e instanceof ProfileBusy) return e;
    e = (e as { cause?: unknown }).cause;
  }
  const m = BUSY_TEXT.exec(err instanceof Error ? err.message : String(err ?? ""));
  return m ? new ProfileBusy(m[1] as string, Number(m[2]), m[3] as string, "") : null;
}

/**
 * Before a launch into `profileDir`: a live browser holding it fails here
 * with who holds it (`ProfileBusy`), not later with Chrome's own error. `reaped` were just
 * told to stop and get a few seconds to let go.
 */
export async function assertProfileFree(
  profileDir: string,
  profile: string,
  reaped: number[] = [],
): Promise<void> {
  let pid = lockHolder(profileDir);
  for (let i = 0; pid && reaped.includes(pid) && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    pid = lockHolder(profileDir);
  }
  if (!pid) return;
  const procs = await listProcs().catch(() => []);
  const holder = procs.find((p) => p.pid === pid);
  if (!holder || !/chrom/i.test(holder.command)) return; // a reused pid: the lock is stale
  throw new ProfileBusy(
    profile,
    pid,
    openerOf(pid, profile, procs, readExplorers(procs)),
    profileDir,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/**
 * Whether the OS says memory is short, apart from our own count: RSS hides what is swapped out.
 * macOS: the kernel's pressure level (1 normal, 2 warn, 4 critical). Linux: MemAvailable.
 */
export function memoryTight(): boolean {
  if (process.platform === "darwin") {
    const level = safe(
      () =>
        Number(
          execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
            encoding: "utf8",
            timeout: 2000,
          }),
        ),
      1,
    );
    return level >= 2;
  }
  const info = safe(() => readFileSync("/proc/meminfo", "utf8"), "");
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
  return kb("MemTotal") > 0 && kb("MemAvailable") < kb("MemTotal") * AVAILABLE_TIGHT_SHARE;
}

/**
 * Admit one more explore browser by memory, not by count: null to open, else why not and what
 * to do. The first browser of ours always opens; the limit scales with the machine's RAM.
 */
export function admit(v: BrowsersView, tight: boolean): string | null {
  if (!v.browsers.length) return null;
  const over = v.ramMb > 0 && v.totalMb + NEW_BROWSER_MB > v.ramMb * RAM_WARN_SHARE;
  if (!tight && !over) return null;
  const why = tight
    ? "the OS reports memory pressure"
    : `one more passes ${Math.round(RAM_WARN_SHARE * 100)}% of ${Math.round(v.ramMb / 1024)} GB RAM`;
  const mbOf = (e: ExplorerRow) => v.browsers.find((b) => b.opener.endsWith(`:${e.port}`))?.mb ?? 0;
  const open = v.explorers.map(
    (e) =>
      `  ${e.port} ${e.site}: ${mbOf(e)} MB, idle ${e.idleMinutes} min${e.held ? ", held" : ""}`,
  );
  return [
    `memory is tight: ${v.browsers.length} browsers of ours hold ${v.totalMb} MB (${why}).`,
    'Use an open session, or stop one that is done (autobrowse stop <port> achieved|failed "why"), then start again.',
    ...(open.length ? ["Open explore sessions:", ...open] : []),
    "Never stop a session that is not yours. `--force` opens anyway: only when a person says so.",
  ].join("\n");
}
