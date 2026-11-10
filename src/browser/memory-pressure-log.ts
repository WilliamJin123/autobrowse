/**
 * A record of what holds memory while the OS reports pressure (11-09 incident: the Force Quit
 * panel showed each Chrome at ~19 GB, a 22 s old one too, so its numbers named no holder).
 * Each minute under pressure the desk writes one row: the top holders by footprint (top's MEM,
 * compressed pages too), grouped by app, each Chrome by its profile. Under no pressure: nothing.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { memoryNow } from "./browsers.js";
import { listProcs, type Proc } from "./reap.js";

export const PRESSURE_LOG_DIR = join(homedir(), ".config/autobrowse/memory");
const EVERY_MS = 60_000;
const TOP = 20;

export interface Holder {
  pid: number;
  mb: number;
  compressedMb: number;
  /** `chrome x@wren`, `claude`, `node desk.ts`, or top's name. */
  app: string;
}

const UNIT: Record<string, number> = { B: 1 / 2 ** 20, K: 1 / 1024, M: 1, G: 1024 };
const mbOf = (s: string) => {
  const m = /^([\d.]+)([BKMG])/.exec(s);
  return m ? Math.round(Number(m[1]) * (UNIT[m[2] as string] ?? 1)) : 0;
};

/** `top -l 1 -stats pid,ppid,mem,cmprs,command` rows: pid, MB, compressed MB. */
export function topRows(text: string): Array<{ pid: number; mb: number; compressedMb: number }> {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+)\s+\d+\s+(\S+)\s+(\S+)\s/.exec(line);
    if (m) out.push({ pid: Number(m[1]), mb: mbOf(m[2] ?? ""), compressedMb: mbOf(m[3] ?? "") });
  }
  return out;
}

/** The app a process belongs to: a Chrome helper names its root's profile. */
export function appOf(pid: number, byPid: Map<number, Proc>): string {
  const p = byPid.get(pid);
  if (!p) return "?";
  const cmd = p.command;
  if (/Google Chrome|Chromium|chrome-headless-shell/.test(cmd)) {
    let root: Proc = p;
    for (let i = 0; i < 6 && root.command.includes("--type="); i++) {
      const up = byPid.get(root.ppid);
      if (!up) break;
      root = up;
    }
    const dir = /--user-data-dir=(\S+)/.exec(root.command)?.[1];
    return `chrome ${dir ? (dir.split("/").at(-1) ?? dir) : "(own)"}`;
  }
  if (/\/claude\/versions\/|(^|\/)claude( |$)/.test(cmd)) return "claude";
  const argv0 = cmd.split(" ")[0]?.split("/").at(-1) ?? cmd;
  if (/^node$|^tsx$/.test(argv0)) {
    const script = cmd
      .split(" ")
      .slice(1)
      .find((a) => /\.(m?[jt]s)$/.test(a) && !a.includes("node_modules"));
    return `node ${script?.split("/").slice(-2).join("/") ?? ""}`.trim();
  }
  return argv0;
}

export interface PressureRow {
  at: string;
  level: string;
  freePct: number | null;
  swapUsedMb: number | null;
  /** Each app's total, largest first. */
  apps: Array<{ app: string; mb: number; procs: number }>;
  /** The largest processes. */
  top: Holder[];
}

/** One row from top's text and the process list. */
export function pressureRow(
  topText: string,
  procs: Proc[],
  m: { level: string; freePct: number | null },
  swapUsedMb: number | null,
  at = new Date(),
): PressureRow {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rows = topRows(topText).map((r) => ({ ...r, app: appOf(r.pid, byPid) }));
  const apps = new Map<string, { mb: number; procs: number }>();
  for (const r of rows) {
    const a = apps.get(r.app) ?? { mb: 0, procs: 0 };
    a.mb += r.mb;
    a.procs += 1;
    apps.set(r.app, a);
  }
  return {
    at: at.toISOString(),
    level: m.level,
    freePct: m.freePct,
    swapUsedMb,
    apps: [...apps]
      .map(([app, a]) => ({ app, ...a }))
      .sort((x, y) => y.mb - x.mb)
      .slice(0, TOP),
    top: [...rows].sort((x, y) => y.mb - x.mb).slice(0, TOP),
  };
}

const run = promisify(execFile);

async function swapUsedMb(): Promise<number | null> {
  const { stdout } = await run("sysctl", ["-n", "vm.swapusage"]).catch(() => ({ stdout: "" }));
  const m = /used = ([\d.]+)M/.exec(stdout);
  return m ? Math.round(Number(m[1])) : null;
}

/** Writes a row now when the OS reports pressure; the path, or null when there is none. */
export async function logPressureOnce(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const m = memoryNow();
  if (m.level === "ok") return null;
  const [{ stdout }, procs, swap] = await Promise.all([
    run("top", ["-l", "1", "-o", "mem", "-stats", "pid,ppid,mem,cmprs,command"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    }),
    listProcs(),
    swapUsedMb(),
  ]);
  const row = pressureRow(stdout, procs, m, swap);
  await mkdir(PRESSURE_LOG_DIR, { recursive: true });
  const file = join(PRESSURE_LOG_DIR, `pressure-${row.at.slice(0, 7)}.jsonl`);
  await appendFile(file, `${JSON.stringify(row)}\n`);
  return file;
}

/** The desk's minute timer; a failed read is skipped. */
export function logPressureOnTimer(warn: (e: unknown) => void): void {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    logPressureOnce()
      .catch(warn)
      .finally(() => {
        busy = false;
      });
  }, EVERY_MS).unref();
}
