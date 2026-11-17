/**
 * The desktop engine: the `agent-desktop` CLI (npm, pinned exact), one
 * process per command, one JSON envelope out:
 * `{version, ok, command, data}` or `{…, ok:false, error{code, message, disposition}}`.
 * Never its MCP server. Typed text always goes by stdin: argv shows in `ps`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  Bounds,
  ControlTarget,
  Desktop,
  DesktopWindow,
  Display,
  InputMode,
  Permissions,
  SnapNode,
  Snapshot,
} from "./types.js";

export interface AdDisposition {
  /** "delivered_unverified", "not_delivered", … */
  delivery: string;
  /** "safe" | "unsafe": may the same command run again */
  retry: string;
}

export interface AdEnvelope {
  version: string;
  ok: boolean;
  command: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
    disposition?: AdDisposition;
  };
}

/** A refused or failed engine command; `code` is agent-desktop's (POLICY_DENIED, STALE_REF, …). */
export class DesktopError extends Error {
  readonly code: string;
  readonly command: string;
  readonly disposition: AdDisposition | null;
  readonly suggestion: string | null;
  constructor(
    code: string,
    message: string,
    command: string,
    disposition: AdDisposition | null = null,
    suggestion: string | null = null,
  ) {
    super(`${command}: ${code}: ${message}`);
    this.name = "DesktopError";
    this.code = code;
    this.command = command;
    this.disposition = disposition;
    this.suggestion = suggestion;
  }
  /** Sent nowhere: safe to try again, headed or after a fresh snapshot. */
  get notDelivered(): boolean {
    return this.disposition?.delivery === "not_delivered";
  }
}

export type AdRun = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The platform binary the npm package fetched (postinstall, sha256-checked); null when absent. */
export function adBinary(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve("agent-desktop/package.json");
    const bin = join(dirname(pkg), "bin", "agent-desktop");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export function spawnRun(bin: string, timeoutMs = 120_000): AdRun {
  return (args, stdin) =>
    new Promise((resolve) => {
      const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (b) => {
        stdout += b;
      });
      p.stderr.on("data", (b) => {
        stderr += b;
      });
      p.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
      p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      p.stdin.end(stdin ?? "");
    });
}

/** The envelope's data, or a `DesktopError` from its error. Exit codes are ignored: the envelope is the answer. */
export async function adCall<T>(run: AdRun, args: string[], stdin?: string): Promise<T> {
  const r = await run(args, stdin);
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  let env: AdEnvelope;
  try {
    env = JSON.parse(line) as AdEnvelope;
  } catch {
    throw new DesktopError(
      "NO_ENVELOPE",
      (r.stderr.trim() || line || `exit ${r.code}`).slice(0, 500),
      args[0] ?? "?",
    );
  }
  if (!env.ok) {
    const e = env.error ?? { code: "UNKNOWN", message: "no error in envelope" };
    throw new DesktopError(
      e.code,
      e.message,
      env.command,
      e.disposition ?? null,
      e.suggestion ?? null,
    );
  }
  return env.data as T;
}

interface AdBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface AdWindow {
  id: string;
  app_name: string;
  pid: number;
  title: string;
  bounds: AdBounds;
  is_focused: boolean;
  minimized: boolean;
  visible: boolean;
}
interface AdNode {
  role: string;
  name?: string;
  value?: string | null;
  ref_id?: string;
  native_id?: { kind: string; value: string };
  states?: string[];
  bounds?: AdBounds;
  children?: AdNode[];
}
interface AdMatch {
  ref_id: string;
  role: string;
  name?: string;
}

const bounds = (b: AdBounds): Bounds => ({ x: b.x, y: b.y, w: b.width, h: b.height });

export const toWindow = (w: AdWindow): DesktopWindow => ({
  id: w.id,
  app: w.app_name,
  pid: w.pid,
  title: w.title,
  bounds: bounds(w.bounds),
  focused: w.is_focused,
  minimized: w.minimized,
});

/** The tree, depth-first, as rows; unnamed containers with no ref are dropped but still deepen. */
export function flatten(tree: AdNode): SnapNode[] {
  const out: SnapNode[] = [];
  const walk = (n: AdNode, depth: number) => {
    const value = n.value === undefined || n.value === null ? null : String(n.value);
    const keep = n.ref_id || n.name || value;
    if (keep)
      out.push({
        ref: n.ref_id ?? null,
        role: n.role,
        name: n.name ?? "",
        value,
        nativeId: n.native_id?.value ?? null,
        states: n.states ?? [],
        bounds: n.bounds ? bounds(n.bounds) : null,
        depth,
      });
    for (const c of n.children ?? []) walk(c, keep ? depth + 1 : depth);
  };
  walk(tree, 0);
  return out;
}

const headedFlag = (mode: InputMode | undefined) => (mode === "headed" ? ["--headed"] : []);

export interface AgentDesktopOptions {
  run?: AdRun;
  /** Keystroke spacing for headed typing: terminals drop a paste-speed burst. */
  typeIntervalMs?: number;
  /** Waits before a read's second try (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `Desktop` over agent-desktop. `shell`, `screenshot` and root stay ours
 * (`mac.ts`): they are not accessibility.
 */
/** Codes a read tries once more. */
const READ_RETRY = new Set(["APP_UNRESPONSIVE"]);
const READ_RETRY_MS = 300;

export function agentDesktop(
  base: Pick<Desktop, "shell" | "screenshot" | "exists" | "rootReady" | "idleMs" | "frontPid">,
  opts: AgentDesktopOptions = {},
): Desktop {
  const bin = adBinary();
  const run = opts.run ?? (bin ? spawnRun(bin) : null);
  if (!run) throw new Error("agent-desktop binary missing: pnpm install");
  const call = <T>(args: string[], stdin?: string) => adCall<T>(run, args, stdin);
  const pause = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // reads only: AX reads of a busy app fail now and then (live: 2 in 5 first snapshots of Calculator)
  const read = <T>(args: string[]): Promise<T> =>
    call<T>(args).catch(async (e: unknown) => {
      if (!(e instanceof DesktopError) || !READ_RETRY.has(e.code)) throw e;
      await pause(READ_RETRY_MS);
      return call<T>(args);
    });
  return {
    id: "agent-desktop",
    async windows(app) {
      const ws = await read<AdWindow[]>(["list-windows", ...(app ? ["--app", app] : [])]);
      return ws.filter((w) => w.visible || w.minimized).map(toWindow);
    },
    async displays() {
      const ds = await read<{ id: string; bounds: AdBounds; scale: number; is_primary: boolean }[]>(
        ["list-displays"],
      );
      return ds.map(
        (d): Display => ({
          id: d.id,
          bounds: bounds(d.bounds),
          scale: d.scale,
          primary: d.is_primary,
        }),
      );
    },
    async snapshot(windowId) {
      // depth 40: Electron apps (Claude, Slack) nest controls past agent-desktop's default 10
      const d = await read<{
        app: string;
        snapshot_id: string;
        window?: { id: string; title: string };
        tree: AdNode;
      }>([
        "snapshot",
        "--window-id",
        windowId,
        "--include-bounds",
        "--compact",
        "--max-depth",
        "40",
      ]);
      return { id: d.snapshot_id, app: d.app, windowId, nodes: flatten(d.tree) } satisfies Snapshot;
    },
    async find(windowId, t: ControlTarget) {
      const d = await read<{ matches: AdMatch[]; total_matches: number }>([
        "find",
        "--window-id",
        windowId,
        ...(t.role ? ["--role", t.role] : []),
        ...(t.nativeId ? ["--native-id", t.nativeId] : []),
        ...(t.name ? ["--name", t.name, "--exact"] : []),
        "--limit",
        "0",
      ]);
      return d.matches.map((m) => m.ref_id);
    },
    async focused(windowId) {
      // `--last` answers `{match}`; a terminal has no focused control, so its first text row stands in.
      const f = await read<{ match: AdMatch | null }>([
        "find",
        "--window-id",
        windowId,
        "--state",
        "focused=true",
        "--last",
      ]);
      if (f.match) return f.match.ref_id;
      const t = await read<{ match: AdMatch | null }>([
        "find",
        "--window-id",
        windowId,
        "--role",
        "textfield",
        "--first",
      ]);
      return t.match?.ref_id ?? null;
    },
    async bounds(ref) {
      const g = await read<{ value: AdBounds | null }>(["get", ref, "--property", "bounds"]).catch(
        () => null,
      );
      return g?.value ? bounds(g.value) : null;
    },
    async click(ref, mode) {
      await call(["click", ref, ...headedFlag(mode)]);
    },
    async type(ref, text, mode) {
      const spacing = mode === "headed" ? ["--interval-ms", String(opts.typeIntervalMs ?? 40)] : [];
      await call(["type", ref, "--stdin", ...spacing, ...headedFlag(mode)], text);
    },
    async press(combo, where, mode) {
      await call([
        "press",
        combo,
        ...(where?.windowId ? ["--window-id", where.windowId] : []),
        ...(where?.app && !where.windowId ? ["--app", where.app] : []),
        ...headedFlag(mode),
      ]);
    },
    async launch(app, o) {
      const d = await call<{ app: string; pid: number; window?: AdWindow }>([
        "launch",
        app,
        ...(o?.fresh ? ["--no-attach"] : []),
        ...(o?.args ?? []).map((a) => `--arg=${a}`),
        "--activate",
      ]);
      return {
        pid: d.pid,
        window: d.window && d.window.bounds.width > 0 ? toWindow(d.window) : null,
      };
    },
    async focusWindow(windowId) {
      await call(["focus-window", "--window-id", windowId]);
    },
    async place(windowId, b) {
      await call(["move-window", "--window-id", windowId, `--x=${b.x}`, `--y=${b.y}`]);
      await call([
        "resize-window",
        "--window-id",
        windowId,
        "--width",
        String(b.w),
        "--height",
        String(b.h),
      ]);
    },
    shell: base.shell,
    screenshot: base.screenshot,
    exists: base.exists,
    rootReady: base.rootReady,
    ...(base.idleMs ? { idleMs: base.idleMs } : {}),
    ...(base.frontPid ? { frontPid: base.frontPid } : {}),
    async permissions(): Promise<Permissions> {
      const p = await call<{ accessibility?: { state?: string } }>(["permissions"]).catch(
        () => ({}) as { accessibility?: { state?: string } },
      );
      return { accessibility: p.accessibility?.state === "granted", root: await base.rootReady() };
    },
  };
}
