/**
 * The overlay's native window (designs/2026-11-04-overlay-out-of-page.md): `native/overlay` (Rust,
 * wry), one process per session, JSON lines both ways. The package carries a prebuilt binary
 * per platform in `assets/overlay/bin/<platform>-<arch>/`; a checkout without one builds it with cargo.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Lines from the host: `ready`, `found`/`lost` (the Chrome window), `moved` (its size), `js` (the panel's posts). */
export type HostEvent = { t: string; [k: string]: unknown };

export interface OverlayHost {
  send(o: { t: string; [k: string]: unknown }): void;
  on(fn: (e: HostEvent) => void): void;
  close(): void;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXE = process.platform === "win32" ? "overlay-host.exe" : "overlay-host";
const CRATE = join(ROOT, "native", "overlay");

function cacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "autobrowse");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "autobrowse");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "autobrowse");
}

/** Every file cargo reads for the binary: an edit is a new hash, so a new build. */
function crateHash(): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(e.name).update(readFileSync(p));
    }
  };
  for (const f of ["Cargo.toml", "Cargo.lock"]) h.update(f).update(readFileSync(join(CRATE, f)));
  walk(join(CRATE, "src"));
  return h.digest("hex").slice(0, 12);
}

/** Why this machine cannot draw one, before any binary is looked for; null when it can. */
function unsupported(): string | null {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    return `the overlay has no window host for ${process.platform}`;
  if (process.platform === "linux" && !process.env.DISPLAY)
    return "the overlay needs X11 (DISPLAY is unset; Wayland cannot place a window over Chrome's)";
  return null;
}

let built: Promise<string> | null = null;
/** The binary: the package's prebuilt one, else (a checkout) a cargo build cached per source hash. */
export function hostBinary(): Promise<string> {
  built ??= (async () => {
    const no = unsupported();
    if (no) throw new Error(no);
    const key = `${process.platform}-${process.arch}`;
    const shipped = join(ROOT, "assets", "overlay", "bin", key, EXE);
    if (existsSync(shipped)) return shipped;
    if (!existsSync(join(CRATE, "Cargo.toml")))
      throw new Error(`the overlay has no prebuilt host for ${key}`);
    const dir = cacheDir();
    const bin = join(
      dir,
      `overlay-host-${crateHash()}${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (existsSync(bin)) return bin;
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "overlay-target");
    // cold wry builds take minutes
    await run(
      "cargo",
      ["build", "--release", "--manifest-path", join(CRATE, "Cargo.toml"), "--target-dir", target],
      { timeout: 900_000 },
    ).catch((e: Error) => {
      throw new Error(`the overlay host needs cargo to build here: ${e.message.split("\n")[0]}`);
    });
    // per-pid temp, then rename: two sessions building at once never see half a binary
    const tmp = `${bin}.${process.pid}`;
    copyFileSync(join(target, "release", EXE), tmp);
    renameSync(tmp, bin);
    return bin;
  })();
  built.catch(() => {
    built = null;
  });
  return built;
}

/** A host that never says `ready` in this time is dead (a missing system library, no display). */
const READY_MS = 15_000;

/** A host process; null when this machine cannot draw one (the reason in `why`). */
export async function nativeHost(why: (reason: string) => void): Promise<OverlayHost | null> {
  let bin: string;
  try {
    bin = await hostBinary();
  } catch (e) {
    why((e as Error).message);
    return null;
  }
  // X11 only on Linux: under Wayland the window cannot be placed or stacked
  const env = process.platform === "linux" ? { ...process.env, GDK_BACKEND: "x11" } : process.env;
  const child: ChildProcess = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env });
  child.unref();
  const fns: Array<(e: HostEvent) => void> = [];
  let open = true;
  let err = "";
  const ready = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve("the overlay host never started"), READY_MS);
    timer.unref();
    const done = (r: string | null) => {
      clearTimeout(timer);
      resolve(r);
    };
    fns.push((e) => {
      if (e.t === "ready") done(null);
    });
    child.on("error", (e) => done(`the overlay host failed: ${e.message}`));
    child.on("exit", (code) => {
      open = false;
      done(`the overlay host exited (${code}): ${err.split("\n")[0] || "no message"}`);
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    // the first lines say why it died; keep no more
    if (err.length < 2_000) err += d;
  });
  let rest = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    rest += d;
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      try {
        const e = JSON.parse(line) as HostEvent;
        for (const fn of fns) fn(e);
      } catch {
        // not a line of ours
      }
    }
  });
  // the session's event loop never waits on the host
  for (const s of [child.stdout, child.stdin, child.stderr])
    (s as unknown as { unref?: () => void })?.unref?.();
  child.stdin?.on("error", () => undefined);
  const close = () => {
    if (!open) return;
    open = false;
    child.stdin?.end();
    // stdin's end is the host's exit; a hung one goes anyway
    setTimeout(() => child.kill(), 1_000).unref();
  };
  const failed = await ready;
  if (failed) {
    close();
    why(failed);
    return null;
  }
  return {
    send(o) {
      if (open && child.stdin?.writable) child.stdin.write(`${JSON.stringify(o)}\n`);
    },
    on(fn) {
      fns.push(fn);
    },
    close,
  };
}
