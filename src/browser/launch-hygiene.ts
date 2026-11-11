/**
 * Launch hygiene (PinchTab audit P8–P11, designs/2026-11-10-pinchtab-audit.md).
 * - P8 `readyOrThrow`: a launched browser that never answers is `BrowserNotReady`; nothing reached a site.
 * - P9 `cleanUncleanExit`: a profile Chrome left mid-crash opens without the restore bubble.
 *   Only the exit flags and `Default/Sessions` change; cookies never.
 * - P10 crash ring: the last 20 browser deaths, shown by `browsers` and `doctor`.
 * - P11 `assertOwnTabRoom`: our own tabs in a person's browser stay under a cap. Theirs are never closed.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { readTabs } from "./own-tabs.js";

export const LAUNCH_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 15_000;
export const CRASH_RING = 20;
/** Our live tabs in one person's browser. */
export const OWN_TAB_CAP = 6;

export class BrowserNotReady extends Error {
  constructor(profile: string, why: string) {
    super(`browser on ${profile} launched but never answered (${why}); nothing reached the site`);
    this.name = "BrowserNotReady";
  }
}

export class OwnTabsFull extends Error {
  constructor(browser: string, open: number) {
    super(`${open} tabs of ours already open in ${browser} (cap ${OWN_TAB_CAP}); try again later`);
    this.name = "OwnTabsFull";
  }
}

/** P8: the page answers a trivial evaluate in time, or the launch failed. */
export async function readyOrThrow(page: Page, profile: string, ms = READY_TIMEOUT_MS) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
  });
  try {
    await Promise.race([page.evaluate("1"), late]);
  } catch (err) {
    throw new BrowserNotReady(
      profile,
      err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A launch that timed out or died before its first page: same error as a mute page. */
export function launchFailed(err: unknown, profile: string): unknown {
  const m = err instanceof Error ? err.message : "";
  return /Timeout .*exceeded|Target page, context or browser has been closed|Browser closed/i.test(
    m,
  )
    ? new BrowserNotReady(profile, m.split("\n")[0] as string)
    : err;
}

/** P9: true when the profile was left unclean and is now marked clean. Call only with no browser on it. */
export function cleanUncleanExit(profileDir: string): boolean {
  const file = join(profileDir, "Default", "Preferences");
  let prefs: { profile?: { exit_type?: string; exited_cleanly?: boolean } };
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false; // new profile, or unreadable: Chrome writes its own
  }
  const p = prefs.profile;
  if (!p) return false;
  const unclean =
    (p.exit_type !== undefined && p.exit_type !== "Normal") || p.exited_cleanly === false;
  if (!unclean) return false;
  p.exit_type = "Normal";
  p.exited_cleanly = true;
  writeFileSync(file, JSON.stringify(prefs));
  // tabs to restore; cookies live in Default/Cookies, untouched
  rmSync(join(profileDir, "Default", "Sessions"), { recursive: true, force: true });
  return true;
}

export type CrashReason = "closed" | "unclean-exit" | "memory" | "not-ready";

export interface Crash {
  at: string;
  profile: string;
  /** desk, worker, cli, explore, other: the process that held the browser. */
  opener: string;
  pid: number;
  reason: CrashReason;
  detail?: string;
}

export const crashFile = (env: NodeJS.ProcessEnv = process.env) =>
  join(
    env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse"),
    "browser-crashes.jsonl",
  );

/** This process, named as `browsers` names openers. */
export function selfOpener(argv = process.argv): string {
  const cmd = argv.slice(1).join(" ");
  if (/app\/desk\.[jt]s\b/.test(cmd)) return "desk";
  if (/app\/main\.[jt]s\b/.test(cmd)) return "worker";
  if (/explore\/server\.[jt]s\b/.test(cmd)) return "explore";
  if (/app\/cli\.[jt]s\b|\/autobrowse(\s|$)/.test(cmd)) return "cli";
  return "other";
}

export function readCrashes(file = crashFile()): Crash[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l) as Crash] : [];
      } catch {
        return [];
      }
    });
}

/** Appends one death; keeps the last CRASH_RING. Never throws. */
export function recordCrash(
  c: Omit<Crash, "at" | "opener" | "pid"> & Partial<Pick<Crash, "at" | "opener" | "pid">>,
  file = crashFile(),
): void {
  try {
    const row: Crash = {
      at: c.at ?? new Date().toISOString(),
      profile: c.profile,
      opener: c.opener ?? selfOpener(),
      pid: c.pid ?? process.pid,
      reason: c.reason,
      ...(c.detail ? { detail: c.detail.slice(0, 200) } : {}),
    };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    const all = readCrashes(file);
    if (all.length > CRASH_RING)
      writeFileSync(
        file,
        `${all
          .slice(-CRASH_RING)
          .map((r) => JSON.stringify(r))
          .join("\n")}\n`,
      );
  } catch {}
}

/** Deaths in the last `hours`, newest first. */
export function recentCrashes(hours = 24, file = crashFile(), now = Date.now()): Crash[] {
  return readCrashes(file)
    .filter((c) => now - Date.parse(c.at) < hours * 3_600_000)
    .reverse();
}

/** P11: refuse a new tab of ours past the cap; the ledger was reaped just before. */
export function assertOwnTabRoom(ledger: string, browser: string, cap = OWN_TAB_CAP): void {
  const open = readTabs(ledger).filter((t) => t.browser === browser).length;
  if (open >= cap) throw new OwnTabsFull(browser, open);
}
