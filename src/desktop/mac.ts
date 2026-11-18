/**
 * This Mac's desktop: agent-desktop for the accessibility work, and our own
 * `shell`, `screencapture` and root helper (not accessibility). macOS grants
 * Accessibility to the process running node once, by hand, in System
 * Settings; `permissions()` says whether that happened.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { ShellResult } from "../deps/shell.js";
import { adBinary, agentDesktop } from "./agent-desktop.js";
import { type Desktop, noDesktop } from "./types.js";

export type RunFile = (file: string, args: string[]) => Promise<ShellResult>;

function defaultRun(file: string, args: string[]): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const POINTER_JXA =
  'ObjC.import("AppKit");var p=$.NSEvent.mouseLocation;var h=$.NSScreen.screens.objectAtIndex(0).frame.size.height;JSON.stringify({x:p.x,y:h-p.y})';

/** The non-accessibility half: shell, root, the screen picture, idle time, the front app. */
export function macBase(
  run: RunFile = defaultRun,
): Pick<
  Desktop,
  "shell" | "screenshot" | "exists" | "rootReady" | "idleMs" | "frontPid" | "pointer"
> {
  return {
    async idleMs() {
      // HIDIdleTime, ns: any keyboard or mouse event resets it, ours included
      const r = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
      const ns = /"HIDIdleTime" = (\d+)/.exec(r.stdout)?.[1];
      return ns ? Math.floor(Number(ns) / 1e6) : Number.POSITIVE_INFINITY;
    },
    async frontPid() {
      // lsappinfo: ~5 ms, against ~150 ms for an agent-desktop window list
      const asn = (await run("/usr/bin/lsappinfo", ["front"])).stdout.trim();
      if (!asn) return null;
      const r = await run("/usr/bin/lsappinfo", ["info", "-only", "pid", asn]);
      const pid = /"pid"=(\d+)/.exec(r.stdout)?.[1];
      return pid ? Number(pid) : null;
    },
    async pointer() {
      // AppKit's origin is the main screen's bottom left; agent-desktop's is its top left
      const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", POINTER_JXA]);
      try {
        const p = JSON.parse(r.stdout) as { x: number; y: number };
        return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
      } catch {
        return null;
      }
    },
    async shell(command, root = false) {
      // Root goes through one audited helper, never a bare `sudo sh`: see `rootHelper()`.
      return root ? run("sudo", ["-n", ROOT_HELPER, command]) : run("/bin/sh", ["-c", command]);
    },
    async screenshot(file) {
      const r = await run("screencapture", ["-x", file]);
      if (r.code !== 0) throw new Error(`screencapture: ${r.stderr.trim() || r.code}`);
    },
    exists: async (file) => existsSync(file),
    rootReady: async () => (await run("sudo", ["-n", "true"])).code === 0,
  };
}

export function macDesktop(run?: RunFile): Desktop {
  return agentDesktop(macBase(run));
}

/** This host's desktop: the Mac's when the binary is there, else one that says why not. */
export function localDesktop(): Desktop {
  if (process.platform !== "darwin") return noDesktop();
  if (!adBinary()) return noDesktop("agent-desktop binary missing: run pnpm install");
  return macDesktop();
}

/**
 * Root, the careful way: sudoers lets this user run one root-owned helper
 * without a password, and the helper appends the command to a root-owned
 * log before running it. Revoking root is deleting one file; every root
 * command it ever ran is in the log.
 */
export const ROOT_HELPER = "/usr/local/libexec/autobrowse-root";
export const ROOT_LOG = "/var/log/autobrowse-root.log";

export function rootHelper(): string {
  return `#!/bin/sh
# autobrowse: run one command as root and log it. Installed by \`autobrowse desktop setup\`.
[ "$#" -eq 1 ] || { echo "usage: autobrowse-root <command>" >&2; exit 64; }
printf '%s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SUDO_USER" "$1" >> ${ROOT_LOG}
exec /bin/sh -c "$1"
`;
}

export function sudoersLine(user: string): string {
  return `${user} ALL=(root) NOPASSWD: ${ROOT_HELPER}`;
}

/** What a person runs once (it asks for their password) to install the helper and the rule. */
export function rootSetupCommands(user: string, helperFile: string): string[] {
  return [
    `sudo install -o root -g wheel -m 755 ${helperFile} ${ROOT_HELPER}`,
    `sudo touch ${ROOT_LOG} && sudo chmod 600 ${ROOT_LOG}`,
    `echo '${sudoersLine(user)}' | sudo tee /etc/sudoers.d/autobrowse >/dev/null && sudo chmod 440 /etc/sudoers.d/autobrowse`,
  ];
}
