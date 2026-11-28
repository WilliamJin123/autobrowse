/**
 * The job that owns a browser (wren designs/2026-11-27-central-queue.md, "Browser owner"):
 * `AUTOBROWSE_JOB` (a runner sets it for its children: `job:<name>/<run>`), else launchd's
 * `XPC_SERVICE_NAME` (every launchd job has it; children inherit it).
 * - autobrowse's own Chrome launches carry it as `--autobrowse-job=<job>`: it shows in `ps` and
 *   outlives the launcher (an orphan still names its job)
 * - any other browser (bare Playwright, a script): read from the env of its nearest launcher.
 *   Chrome rewrites its own argv area, so its env is unreadable; its parent's is not
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Proc } from "./reap.js";

export const JOB_FLAG = "--autobrowse-job";
const JOB_RE = new RegExp(`${JOB_FLAG}=(\\S+)`);

/** The job this process runs for, from its env; null for a shell or a GUI app. */
export function jobOfEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.AUTOBROWSE_JOB?.trim();
  if (own) return own.replace(/\s+/g, "_");
  const xpc = env.XPC_SERVICE_NAME?.trim();
  // "0": no launchd job; "application.*": an app (Terminal, an IDE), not a job
  if (!xpc || xpc === "0" || xpc.startsWith("application.")) return null;
  return xpc.replace(/\s+/g, "_");
}

/** The flag for a Chrome launch from this process; [] when it runs for no job. */
export function jobArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const job = jobOfEnv(env);
  return job ? [`${JOB_FLAG}=${job}`] : [];
}

export function jobOfCommand(command: string): string | null {
  return JOB_RE.exec(command)?.[1] ?? null;
}

/** `ps eww` output: `<pid> <command> KEY=value ...` → pid → the job its env names. */
export function jobsOfEnvLines(out: string): Map<number, string> {
  const jobs = new Map<number, string>();
  for (const line of out.split("\n")) {
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
    if (!pid) continue;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["AUTOBROWSE_JOB", "XPC_SERVICE_NAME"]) {
      // the env follows the command: the last match is the env's, not an argument's
      const all = [...line.matchAll(new RegExp(`(?:^|\\s)${key}=(\\S*)`, "g"))];
      const v = all.at(-1)?.[1];
      if (v !== undefined) env[key] = v;
    }
    const job = jobOfEnv(env);
    if (job) jobs.set(pid, job);
  }
  return jobs;
}

async function envJobs(pids: number[]): Promise<Map<number, string>> {
  if (!pids.length || process.platform === "win32") return new Map();
  const { stdout } = await promisify(execFile)(
    "ps",
    ["eww", "-o", "pid=,command=", "-p", pids.join(",")],
    { maxBuffer: 16 * 1024 * 1024 },
  ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" })); // a pid gone: ps exits 1
  return jobsOfEnvLines(stdout);
}

/**
 * Browser pid → its job, for each of `roots`: the flag on its command line, else the nearest
 * launcher (up to 8 parents) whose env names one. A root with neither is left out.
 */
export async function jobsOf(
  roots: number[],
  procs: Proc[],
  readEnv: (pids: number[]) => Promise<Map<number, string>> = envJobs,
): Promise<Map<number, string>> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Map<number, string>();
  const chains = new Map<number, number[]>();
  for (const pid of roots) {
    const flag = jobOfCommand(byPid.get(pid)?.command ?? "");
    if (flag) {
      out.set(pid, flag);
      continue;
    }
    const chain: number[] = [];
    for (let p = byPid.get(byPid.get(pid)?.ppid ?? 0); p && p.pid > 1 && chain.length < 8; ) {
      chain.push(p.pid);
      p = byPid.get(p.ppid);
    }
    chains.set(pid, chain);
  }
  const env = await readEnv([...new Set([...chains.values()].flat())]).catch(
    () => new Map<number, string>(),
  );
  for (const [pid, chain] of chains) {
    const job = chain.map((p) => env.get(p)).find(Boolean);
    if (job) out.set(pid, job);
  }
  return out;
}
