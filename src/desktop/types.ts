/**
 * The desktop leg: what a person does outside the browser. Apps, windows and
 * controls through the OS accessibility tree (refs from a snapshot, like the
 * browser's aria), never by pixel. Engine: agent-desktop (`agent-desktop.ts`).
 * A shell command that needs root goes through `sudo -n` with a rule set up
 * once (`mac.ts`). A host without a desktop (the prod box) says so.
 *
 * Two shapes: the agent's act (`desktopActSchema`, refs and window ids, one
 * session) and the journaled op (`desktopOpSchema`, targets found again at
 * replay). `hands.ts` turns one into the other.
 */
import { z } from "zod";
import type { ShellResult } from "../deps/shell.js";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen points, origin top-left of the primary display. */
export interface DesktopWindow {
  /** Lives one run: `w-233741`. */
  id: string;
  app: string;
  pid: number;
  title: string;
  bounds: Bounds;
  /** agent-desktop's flag; within one pid it can name a sibling (spike), so the guard checks more. */
  focused: boolean;
  minimized: boolean;
}

export interface Display {
  id: string;
  bounds: Bounds;
  scale: number;
  primary: boolean;
}

/** One snapshot row. `ref` lives as long as its snapshot. */
export interface SnapNode {
  ref: string | null;
  role: string;
  name: string;
  value: string | null;
  nativeId: string | null;
  states: string[];
  bounds: Bounds | null;
  depth: number;
}

export interface Snapshot {
  id: string;
  app: string;
  windowId: string;
  nodes: SnapNode[];
}

/** headless: no pointer, no focus taken. headed: real keys and clicks into the front window. */
export type InputMode = "headless" | "headed";

/** A window found again at replay: its app plus a piece of its title. */
export const windowTargetSchema = z.object({ app: z.string(), title: z.string() });
export type WindowTarget = z.infer<typeof windowTargetSchema>;

/** A control found again at replay: native id first (names change), else role + exact name. */
export const controlTargetSchema = z.object({
  role: z.string(),
  name: z.string(),
  nativeId: z.string().optional(),
});
export type ControlTarget = z.infer<typeof controlTargetSchema>;

/** The agent names a window by id from `windows`, or by app plus title piece. */
export const windowRefSchema = z.union([z.string().regex(/^w-/), windowTargetSchema]);
export type WindowRef = z.infer<typeof windowRefSchema>;

const boundsSchema = {
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
};
/** Most an agent's `wait` holds the socket: under the explore client's 900 s resend. */
export const WAIT_MAX_S = 600;
const timeoutS = z.number().positive().max(WAIT_MAX_S).optional();
/** A replay has no socket: a recorded or hand-set wait may run longer (a whole inner run). */
const replayTimeoutS = z.number().positive().optional();
/** `secret` names a stored value (`profile.phone`, `<site>.<detail>`): typed by stdin, never seen. */
const typed = { text: z.string().optional(), secret: z.string().optional() };
/** Key by key at a person's pace (runs, beats, slips fixed), behind the focus lease. Not with `secret`. */
const human = { human: z.boolean().optional() };

/** One act, as the agent sends it (explore `os`, autocomp `send`). */
export const desktopActSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("windows"), app: z.string().optional() }),
  z.object({ op: z.literal("snapshot"), window: windowRefSchema }),
  /** `fresh`: a new instance with its own pid, the only safe target for headed keys. */
  z.object({
    op: z.literal("launch"),
    app: z.string(),
    fresh: z.boolean().optional(),
    args: z.array(z.string()).optional(),
  }),
  z.object({ op: z.literal("click"), ref: z.string() }),
  /** No `ref`: the window's focused control (a terminal's prompt). */
  z.object({
    op: z.literal("type"),
    ref: z.string().optional(),
    window: windowRefSchema.optional(),
    ...typed,
    ...human,
  }),
  /** "cmd+shift+4", "return", "escape"… to the window's process, or the front app's. */
  z.object({ op: z.literal("key"), combo: z.string(), window: windowRefSchema.optional() }),
  z.object({ op: z.literal("place"), window: windowRefSchema, ...boundsSchema }),
  z.object({ op: z.literal("focus"), window: windowRefSchema }),
  /** Text in the window's tree, or a file on disk. Answers found or not, never the text. */
  z.object({ op: z.literal("wait"), window: windowRefSchema, text: z.string(), timeoutS }),
  z.object({ op: z.literal("waitFile"), file: z.string(), timeoutS }),
  z.object({ op: z.literal("sleep"), ms: z.number().int().positive().max(60_000) }),
  z.object({ op: z.literal("shot") }),
  z.object({ op: z.literal("shell"), command: z.string(), root: z.boolean().optional() }),
]);
export type DesktopAct = z.infer<typeof desktopActSchema>;

/** One journaled act: no refs, no window ids. `headed` set once a headless try was refused. */
export const desktopOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("launch"),
    app: z.string(),
    fresh: z.boolean().optional(),
    args: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("click"),
    window: windowTargetSchema,
    control: controlTargetSchema,
    headed: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("type"),
    window: windowTargetSchema,
    /** Absent: the window's focused control. */
    control: controlTargetSchema.optional(),
    ...typed,
    ...human,
    headed: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("key"),
    combo: z.string(),
    window: windowTargetSchema.optional(),
    headed: z.boolean().optional(),
  }),
  z.object({ op: z.literal("place"), window: windowTargetSchema, ...boundsSchema }),
  z.object({ op: z.literal("focus"), window: windowTargetSchema }),
  z.object({
    op: z.literal("wait"),
    window: windowTargetSchema,
    text: z.string(),
    timeoutS: replayTimeoutS,
  }),
  z.object({ op: z.literal("waitFile"), file: z.string(), timeoutS: replayTimeoutS }),
  z.object({ op: z.literal("sleep"), ms: z.number().int().positive() }),
  z.object({ op: z.literal("shell"), command: z.string(), root: z.boolean().optional() }),
]);
export type DesktopOp = z.infer<typeof desktopOpSchema>;

export interface Permissions {
  /** System Settings → Privacy & Security → Accessibility, for the process running node. */
  accessibility: boolean;
  /** `sudo -n` works: a sudoers rule for this user, or root already. */
  root: boolean;
}

/** The engine: one call per OS act. Policy (targets, guard, waits) lives in `hands.ts`. */
export interface Desktop {
  readonly id: string;
  windows(app?: string): Promise<DesktopWindow[]>;
  displays(): Promise<Display[]>;
  snapshot(windowId: string): Promise<Snapshot>;
  /** Refs of every control matching the target, from a fresh look. */
  find(windowId: string, target: ControlTarget): Promise<string[]>;
  /** The focused control's ref, or the window's first text row; null when neither. */
  focused(windowId: string): Promise<string | null>;
  /** A ref's screen rect, points; null when the control is gone. Optional: the overlay aims with it. */
  bounds?(ref: string): Promise<Bounds | null>;
  click(ref: string, mode?: InputMode): Promise<void>;
  type(ref: string, text: string, mode?: InputMode): Promise<void>;
  press(
    combo: string,
    where?: { windowId?: string; app?: string },
    mode?: InputMode,
  ): Promise<void>;
  /** Start or bring forward; `fresh` starts another instance. */
  launch(
    app: string,
    o?: { fresh?: boolean; args?: string[] },
  ): Promise<{ pid: number; window: DesktopWindow | null }>;
  focusWindow(windowId: string): Promise<void>;
  /** Ms since the last keyboard or mouse input (a person's or ours). Absent: never waits. */
  idleMs?(): Promise<number>;
  /** The front app's pid. Absent: the focused window's, from `windows()`. */
  frontPid?(): Promise<number | null>;
  place(windowId: string, b: Bounds): Promise<void>;
  screenshot(file: string): Promise<void>;
  shell(command: string, root?: boolean): Promise<ShellResult>;
  /** A file on this desktop's host (file waits). */
  exists(file: string): Promise<boolean>;
  rootReady(): Promise<boolean>;
  permissions(): Promise<Permissions>;
}

/** A snapshot as text, the way `aria` prints a page: one row per line, indented, ref last. */
export function snapText(nodes: SnapNode[], valueChars = 200): string {
  return nodes
    .map((n) => {
      const v =
        n.value === null || n.value === n.name
          ? ""
          : `: ${n.value.length > valueChars ? `${n.value.slice(0, valueChars)}…` : n.value}`;
      const st = n.states.filter((s) => s !== "focused" || n.ref).join(",");
      return `${"  ".repeat(n.depth)}- ${n.role}${n.name ? ` "${n.name}"` : ""}${v}${st ? ` [${st}]` : ""}${n.ref ? ` ${n.ref}` : ""}`;
    })
    .join("\n");
}

/** A host with no desktop (a Linux box, CI): every act says so instead of failing oddly. */
export function noDesktop(reason = "this host has no desktop"): Desktop {
  const refuse = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    id: "none",
    windows: refuse,
    displays: refuse,
    snapshot: refuse,
    find: refuse,
    focused: refuse,
    click: refuse,
    type: refuse,
    press: refuse,
    launch: refuse,
    focusWindow: refuse,
    place: refuse,
    screenshot: refuse,
    shell: refuse,
    exists: refuse,
    rootReady: async () => false,
    permissions: async () => ({ accessibility: false, root: false }),
  };
}

/** One window of the fake desktop: its tree, and what typing into it adds. */
export interface FakeWindow extends DesktopWindow {
  nodes: Omit<SnapNode, "ref">[];
}

/** One engine call the fake saw; typed text kept so tests can check secrets went by stdin. */
export type FakeCall =
  | { call: "click"; windowId: string; node: string; mode: InputMode }
  | { call: "type"; windowId: string; node: string; text: string; mode: InputMode }
  | { call: "press"; combo: string; windowId?: string; app?: string; mode: InputMode }
  | { call: "launch"; app: string; fresh: boolean }
  | { call: "focusWindow"; windowId: string }
  | { call: "place"; windowId: string; bounds: Bounds }
  | { call: "shot"; file: string }
  | { call: "shell"; command: string; root: boolean };

export interface FakeDesktopOptions {
  /** Refuse headless input into these apps, as agent-desktop does for terminals. */
  headedOnly?: string[];
  /** The focused window per `windows()`; defaults to whichever `focusWindow` named last. */
  focusedId?: string;
  /** Files `exists` finds. */
  files?: string[];
  /** What `idleMs` answers, call after call (the last repeats); absent: always idle. */
  idle?: number[];
}

/**
 * Scripted desktop for tests: windows with trees, a log of every call.
 * Refs are `@<snapshot>:e<i>`; a snapshot taken later makes older refs stale.
 */
export function fakeDesktop(windows: FakeWindow[] = [], o: FakeDesktopOptions = {}) {
  const calls: FakeCall[] = [];
  const idle = [...(o.idle ?? [])];
  let snapN = 0;
  let focusedId = o.focusedId ?? windows.find((w) => w.focused)?.id ?? null;
  /** ref → [window id, node index]; only the newest snapshot per window is live. */
  const live = new Map<string, [string, number]>();
  const win = (id: string) => {
    const w = windows.find((x) => x.id === id);
    if (!w) throw Object.assign(new Error(`No window with id ${id}`), { code: "WINDOW_NOT_FOUND" });
    return w;
  };
  const deref = (ref: string) => {
    const hit = live.get(ref);
    if (!hit) throw Object.assign(new Error(`stale ref ${ref}`), { code: "STALE_REF" });
    return hit;
  };
  const refuseHeadless = (windowId: string, mode: InputMode) => {
    if (mode === "headless" && o.headedOnly?.includes(win(windowId).app)) throw policyDenied();
  };
  const refsFor = (windowId: string) => {
    for (const [k, [w]] of live) if (w === windowId) live.delete(k);
    const id = `s${++snapN}`;
    return win(windowId).nodes.map((_, i) => {
      const ref = `@${id}:e${i + 1}`;
      live.set(ref, [windowId, i]);
      return ref;
    });
  };
  const d: Desktop & {
    calls: FakeCall[];
    windowsList: FakeWindow[];
    /** A person brings this window forward (tests of the focus lease). */
    focus(id: string | null): void;
  } = {
    id: "fake",
    calls,
    windowsList: windows,
    focus(id) {
      focusedId = id;
    },
    idleMs: async () => (idle.length > 1 ? (idle.shift() as number) : (idle[0] ?? 60_000)),
    frontPid: async () => windows.find((w) => w.id === focusedId)?.pid ?? null,
    async windows(app) {
      return windows
        .filter((w) => !app || w.app.toLowerCase() === app.toLowerCase())
        .map(({ nodes: _n, ...w }) => ({ ...w, focused: w.id === focusedId }));
    },
    displays: async () => [
      { id: "1", bounds: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2, primary: true },
    ],
    async snapshot(windowId) {
      const w = win(windowId);
      const refs = refsFor(windowId);
      return {
        id: `s${snapN}`,
        app: w.app,
        windowId,
        nodes: w.nodes.map((n, i) => ({ ...n, ref: refs[i] ?? null })),
      };
    },
    async find(windowId, t) {
      const refs = refsFor(windowId);
      return win(windowId)
        .nodes.map((n, i) => [n, refs[i] as string] as const)
        .filter(([n]) =>
          t.nativeId
            ? n.nativeId === t.nativeId && n.role === t.role
            : n.role === t.role && n.name.toLowerCase() === t.name.toLowerCase(),
        )
        .map(([, r]) => r);
    },
    async focused(windowId) {
      const refs = refsFor(windowId);
      const nodes = win(windowId).nodes;
      const i = nodes.findIndex((n) => n.states.includes("focused"));
      const j = i >= 0 ? i : nodes.findIndex((n) => n.role === "textfield");
      return j >= 0 ? (refs[j] ?? null) : null;
    },
    async bounds(ref) {
      const [w, i] = deref(ref);
      // node bounds are screen points, as agent-desktop's
      return win(w).nodes[i]?.bounds ?? null;
    },
    async click(ref, mode = "headless") {
      const [w, i] = deref(ref);
      refuseHeadless(w, mode);
      calls.push({ call: "click", windowId: w, node: win(w).nodes[i]?.name ?? "", mode });
    },
    async type(ref, text, mode = "headless") {
      const [w, i] = deref(ref);
      refuseHeadless(w, mode);
      calls.push({ call: "type", windowId: w, node: win(w).nodes[i]?.name ?? "", text, mode });
    },
    async press(combo, where, mode = "headless") {
      calls.push({
        call: "press",
        combo,
        ...(where?.windowId ? { windowId: where.windowId } : {}),
        ...(where?.app ? { app: where.app } : {}),
        mode,
      });
    },
    async launch(app, lo) {
      calls.push({ call: "launch", app, fresh: lo?.fresh ?? false });
      const w = windows.find((x) => x.app === app);
      return { pid: w?.pid ?? 1, window: w ? { ...w, focused: false } : null };
    },
    async focusWindow(windowId) {
      win(windowId);
      calls.push({ call: "focusWindow", windowId });
      if (!o.focusedId) focusedId = windowId;
    },
    async place(windowId, b) {
      win(windowId).bounds = b;
      calls.push({ call: "place", windowId, bounds: b });
    },
    async screenshot(file) {
      calls.push({ call: "shot", file });
    },
    async shell(command, root) {
      calls.push({ call: "shell", command, root: root ?? false });
      return { code: 0, stdout: "", stderr: "" };
    },
    exists: async (file) => o.files?.includes(file) ?? false,
    rootReady: async () => true,
    permissions: async () => ({ accessibility: true, root: true }),
  };
  return d;
}

/** What agent-desktop answers for headless input a target cannot take (terminals). */
function policyDenied(): Error {
  return Object.assign(new Error("Target is not actionable: physical fallback is denied"), {
    code: "POLICY_DENIED",
    notDelivered: true,
  });
}

/** A fake window for tests: app, title, rows as `[role, name, value?]`. */
export function fakeWindow(
  id: string,
  app: string,
  title: string,
  rows: [string, string, string?][],
  extra: Partial<FakeWindow> = {},
): FakeWindow {
  return {
    id,
    app,
    pid: 100 + Number(id.replace(/\D/g, "") || 0),
    title,
    bounds: { x: 0, y: 0, w: 800, h: 600 },
    focused: false,
    minimized: false,
    nodes: rows.map(([role, name, value], depth) => ({
      role,
      name,
      value: value ?? null,
      nativeId: null,
      states: [],
      bounds: { x: 10, y: 10 + depth * 30, w: 100, h: 24 },
      depth: 0,
    })),
    ...extra,
  };
}
