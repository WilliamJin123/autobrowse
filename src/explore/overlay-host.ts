/**
 * The overlay's native window (designs/2026-11-04-overlay-out-of-page.md): `assets/overlay/host.swift`,
 * compiled once per source hash, one process per session, JSON lines both ways. macOS only.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
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

const SOURCE = fileURLToPath(new URL("../../assets/overlay/host.swift", import.meta.url));

/** The compiled binary; built on first use, shared by every session and version with this source. */
let built: Promise<string> | null = null;
export function hostBinary(): Promise<string> {
  built ??= (async () => {
    if (process.platform !== "darwin") throw new Error("the overlay draws on macOS only");
    const src = readFileSync(SOURCE);
    const dir = join(homedir(), "Library", "Caches", "autobrowse");
    const bin = join(
      dir,
      `overlay-host-${createHash("sha256").update(src).digest("hex").slice(0, 12)}`,
    );
    if (existsSync(bin)) return bin;
    mkdirSync(dir, { recursive: true });
    // per-pid temp, then rename: two sessions building at once never see half a binary
    const tmp = `${bin}.${process.pid}`;
    await run("swiftc", ["-O", "-o", tmp, SOURCE], { timeout: 180_000 }).catch((e: Error) => {
      throw new Error(
        `the overlay needs swiftc (Xcode command line tools): ${e.message.split("\n")[0]}`,
      );
    });
    renameSync(tmp, bin);
    return bin;
  })();
  built.catch(() => {
    built = null;
  });
  return built;
}

/** A host process; null when this machine cannot draw one (the reason in `why`). */
export async function nativeHost(why: (reason: string) => void): Promise<OverlayHost | null> {
  let bin: string;
  try {
    bin = await hostBinary();
  } catch (e) {
    why((e as Error).message);
    return null;
  }
  const child: ChildProcess = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
  child.unref();
  const fns: Array<(e: HostEvent) => void> = [];
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
  (child.stdout as unknown as { unref?: () => void })?.unref?.();
  (child.stdin as unknown as { unref?: () => void })?.unref?.();
  child.stdin?.on("error", () => undefined);
  let open = true;
  child.on("exit", () => {
    open = false;
  });
  return {
    send(o) {
      if (open && child.stdin?.writable) child.stdin.write(`${JSON.stringify(o)}\n`);
    },
    on(fn) {
      fns.push(fn);
    },
    close() {
      if (!open) return;
      open = false;
      child.stdin?.end();
      // stdin's end is the host's exit; a hung one goes anyway
      setTimeout(() => child.kill(), 1_000).unref();
    },
  };
}
