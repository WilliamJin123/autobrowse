/**
 * Loopback ports for every autobrowse process that listens: one picker.
 * A pick is claimed with an O_EXCL file (`port-<n>.claim`, the claimer's pid), so two starters
 * never pick the same port in the seconds before either listens. The session drops the claim
 * once it listens; a crashed claimer's file is taken over under a lock dir.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Explore, desktop and agent sessions count up from here. */
export const SESSION_PORT_FROM = 9090;
/** The token, info and claim files of loopback sessions. */
export const PORTS_DIR = join(tmpdir(), "autobrowse");
const SPAN = 1000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Nobody listens on 127.0.0.1:<port> now. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

/** The OS's pick: for a child told its port by flag (ttyd, an eval's agent). */
export function anyPort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? ok(a.port) : fail(new Error("no port"))));
    });
  });
}

export const claimFile = (port: number, dir = PORTS_DIR): string => join(dir, `port-${port}.claim`);

export interface ClaimOptions {
  from?: number;
  /** Who holds the claim; it lapses when this pid dies. */
  pid?: number;
  dir?: string;
  /** Ports to pass over (a journal to resume, the caller's own sessions). */
  skip?: (port: number) => boolean;
  free?: (port: number) => Promise<boolean>;
  alive?: (pid: number) => boolean;
}

/** The first port from `from` up that is unclaimed, not skipped and free; claimed for `pid`. */
export async function claimPort(o: ClaimOptions = {}): Promise<number> {
  const from = o.from ?? SESSION_PORT_FROM;
  const dir = o.dir ?? PORTS_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let port = from; port < from + SPAN; port++) {
    if (o.skip?.(port)) continue;
    if (!takeClaim(claimFile(port, dir), o.pid ?? process.pid, o.alive ?? pidAlive)) continue;
    if (await (o.free ?? portFree)(port)) return port;
    rmSync(claimFile(port, dir), { force: true });
  }
  throw new Error(`no free loopback port in ${from}-${from + SPAN - 1}`);
}

export function releasePort(port: number, dir = PORTS_DIR): void {
  rmSync(claimFile(port, dir), { force: true });
}

/** A live port claim: its pid, or null. */
export function claimHolder(port: number, dir = PORTS_DIR, alive = pidAlive): number | null {
  try {
    const pid = Number(readFileSync(claimFile(port, dir), "utf8"));
    return pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The claimer's own child names the port; it passes the claim check. */
export const CLAIM_ENV = "AUTOBROWSE_PORT_CLAIM";

/** A port named by hand that another starter claimed: that starter's pid. */
export function claimedByOther(port: number, dir = PORTS_DIR, alive = pidAlive): number | null {
  const pid = claimHolder(port, dir, alive);
  if (pid === null || pid === process.pid || String(pid) === process.env[CLAIM_ENV]) return null;
  return pid;
}

const create = (file: string, pid: number): boolean => {
  try {
    const fd = openSync(file, "wx", 0o600);
    writeSync(fd, String(pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
};

const holder = (file: string): number | null => {
  try {
    return Number(readFileSync(file, "utf8")) || null;
  } catch {
    return null;
  }
};

/** A lock dir older than this is a taker that crashed mid-takeover. */
const LOCK_STALE_MS = 10_000;

function takeClaim(file: string, pid: number, alive: (pid: number) => boolean): boolean {
  if (create(file, pid)) return true;
  const held = holder(file);
  // empty: a claimer between open and write
  if (held === null || alive(held)) return false;
  // a dead claimer's file: one taker at a time, else two could both rm and re-create
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmdirSync(lock);
      mkdirSync(lock);
    } catch {
      return false;
    }
  }
  try {
    if (holder(file) !== held) return false; // someone took it first
    rmSync(file, { force: true });
    return create(file, pid);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
