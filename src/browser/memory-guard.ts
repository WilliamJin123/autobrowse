/**
 * A cap on one browser's memory (11-09 incident: an explore Chrome on Meta Business Suite grew
 * until macOS ran out of memory and the person's session crashed; nothing of ours acted).
 * Every 30 s it reads the browser's whole process tree at its footprint (swapped pages too).
 * Past `warnShare` of the cap it says so once; past the cap, or past half of it while the OS
 * reports critical pressure, it records the pages' URLs and closes the browser. Its owner sees a
 * dead browser: explore restarts and resumes its journal, a flow fails retryable.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";
import { memoryNow } from "./browsers.js";
import { recordCrash } from "./launch-hygiene.js";
import { footprintKb, listProcs, type Proc } from "./reap.js";

export const GUARD_EVERY_MS = 30_000;
const WARN_SHARE = 0.6;
/** A quarter of RAM, 2 to 6 GB: 4 GB on this 16 GB Mac. A normal session holds under 1.5 GB. */
export const capMbOf = (
  env = process.env.AUTOBROWSE_BROWSER_CAP_MB,
  ramMb = totalmem() / 2 ** 20,
) => {
  const set = Number(env);
  return set > 0 ? set : Math.round(Math.min(6144, Math.max(2048, ramMb / 4)));
};
export const GUARD_LOG = join(homedir(), ".config/autobrowse/browser-memory.jsonl");

/** The tree's pids under the browser launched on `profileDir`: root first. */
export function treeOf(procs: Proc[], profileDir: string): number[] {
  const flag = `--user-data-dir=${profileDir.replace(/\/$/, "")}`;
  const root = procs.find(
    (p) =>
      !p.command.includes("--type=") &&
      (p.command.includes(`${flag} `) || p.command.endsWith(flag)),
  );
  if (!root) return [];
  const kids = new Map<number, number[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const out: number[] = [];
  const walk = (pid: number) => {
    out.push(pid);
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(root.pid);
  return out;
}

export type GuardVerdict = "ok" | "warn" | "close";

/** What one reading means. */
export function verdictOf(
  mb: number,
  capMb: number,
  pressure: "ok" | "tight" | "critical",
): GuardVerdict {
  if (mb > capMb || (pressure === "critical" && mb > capMb / 2)) return "close";
  return mb > capMb * WARN_SHARE ? "warn" : "ok";
}

export interface GuardEvent {
  at: string;
  verdict: Exclude<GuardVerdict, "ok">;
  profile: string;
  pid: number;
  mb: number;
  capMb: number;
  pressure: string;
  urls: string[];
}

export interface GuardDeps {
  procs?: () => Promise<Proc[]>;
  footprint?: (pids: number[]) => Promise<Map<number, number>>;
  pressure?: () => "ok" | "tight" | "critical";
  record?: (e: GuardEvent) => Promise<void>;
  kill?: (pid: number) => void;
  /** The crash ring (`browser/launch-hygiene`). */
  crash?: typeof recordCrash;
  everyMs?: number;
}

const recordLine = async (e: GuardEvent) => {
  await mkdir(dirname(GUARD_LOG), { recursive: true });
  await appendFile(GUARD_LOG, `${JSON.stringify(e)}\n`);
};

/** Watches the browser on `profileDir` until `stop` or the context closes. */
export function guardMemory(
  context: BrowserContext,
  profileDir: string,
  capMb = capMbOf(),
  deps: GuardDeps = {},
): { stop(): void; check(): Promise<GuardVerdict>; fired(): boolean } {
  const procs = deps.procs ?? (() => listProcs());
  const footprint = deps.footprint ?? ((pids: number[]) => footprintKb(pids));
  const pressure = deps.pressure ?? (() => memoryNow().level);
  const record = deps.record ?? recordLine;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const crash = deps.crash ?? recordCrash;
  let fired = false;
  let warned = false;
  let busy = false;
  let done = false;

  const check = async (): Promise<GuardVerdict> => {
    if (busy || done) return "ok";
    busy = true;
    try {
      const pids = treeOf(await procs(), profileDir);
      if (!pids.length) return "ok";
      const kb = await footprint(pids);
      const mb = Math.round([...kb.values()].reduce((s, n) => s + n, 0) / 1024);
      const level = pressure();
      const verdict = verdictOf(mb, capMb, level);
      if (verdict === "ok" || (verdict === "warn" && warned)) return verdict;
      const urls = context.pages().map((p) => p.url());
      const e: GuardEvent = {
        at: new Date().toISOString(),
        verdict,
        profile: profileDir.split("/").at(-1) ?? profileDir,
        pid: pids[0] as number,
        mb,
        capMb,
        pressure: level,
        urls,
      };
      await record(e).catch(() => undefined);
      console.error(
        verdict === "close"
          ? `autobrowse: browser ${e.profile} (pid ${e.pid}) holds ${mb} MB, over its ${capMb} MB cap${level === "critical" ? " under critical memory" : ""}: closing it. Pages: ${urls.join(" ")}`
          : `autobrowse: browser ${e.profile} (pid ${e.pid}) holds ${mb} MB of its ${capMb} MB cap. Pages: ${urls.join(" ")}`,
      );
      if (verdict === "warn") {
        warned = true;
        return verdict;
      }
      fired = true;
      crash({ profile: e.profile, reason: "memory", detail: `${mb} MB over its ${capMb} MB cap` });
      stop();
      // a browser this heavy may not answer a polite close: kill after 10 s
      const forced = setTimeout(() => {
        try {
          kill(pids[0] as number);
        } catch {}
      }, 10_000);
      forced.unref?.();
      await context.close().catch(() => undefined);
      clearTimeout(forced);
      return verdict;
    } catch {
      return "ok"; // a failed read is never a close
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void check(), deps.everyMs ?? GUARD_EVERY_MS);
  timer.unref?.();
  const stop = () => {
    done = true;
    clearInterval(timer);
  };
  context.on("close", stop);
  /** True once the guard closed the browser: that close is no surprise death. */
  return { stop, check, fired: () => fired };
}
