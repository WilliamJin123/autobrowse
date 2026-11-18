/**
 * A reserved profile: the desk opens no browser on it until the reserve ends (a film take, a person
 * at the account). The desk meets it as `ProfileBusy` with opener `reserved`, so its watcher pauses
 * and its calls wait (`browser/profile-wait`). Explore and CLI sessions still open it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../google/auth.js";
import { ProfileBusy } from "./browsers.js";

export const RESERVE_FILE = "~/.config/autobrowse/reserved.json";

export interface Reserve {
  until: string;
  by: string;
  why: string;
}
type Reserves = Record<string, Reserve>;

/** Live reserves only: an ended one drops out on read. */
export function reserves(file = RESERVE_FILE, now = Date.now()): Reserves {
  let all: Reserves = {};
  try {
    all = JSON.parse(readFileSync(expandHome(file), "utf8")) as Reserves;
  } catch {
    // none yet, or unreadable: nothing reserved
  }
  return Object.fromEntries(Object.entries(all).filter(([, p]) => Date.parse(p.until) > now));
}

function save(file: string, all: Reserves): void {
  const path = expandHome(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function reserve(
  profile: string,
  minutes: number,
  who: { by: string; why: string },
  file = RESERVE_FILE,
  now = Date.now(),
): Reserve {
  const p = { until: new Date(now + minutes * 60_000).toISOString(), ...who };
  save(file, { ...reserves(file, now), [profile]: p });
  return p;
}

/** True when it was reserved. */
export function unreserve(profile: string, file = RESERVE_FILE, now = Date.now()): boolean {
  const all = reserves(file, now);
  if (!all[profile]) return false;
  delete all[profile];
  save(file, all);
  return true;
}

/** This process is the desk worker (`src/app/desk.ts`): only it honours reserves. */
export const isDesk = (argv = process.argv) => argv.some((a) => /app\/desk\.[jt]s$/.test(a));

/** Throws `ProfileBusy` (opener `reserved`) when the desk may not open `profile` now. */
export function assertNotReserved(profile: string, profileDir: string, file = RESERVE_FILE): void {
  const p = reserves(file)[profile];
  if (!p) return;
  throw new ProfileBusy(profile, process.pid, "reserved", profileDir, {
    op: `until ${p.until} by ${p.by}: ${p.why}`,
  });
}
