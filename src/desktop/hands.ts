/**
 * Desktop policy over the engine. One path for record and replay:
 * - record (`act`): the agent's refs and window ids → targets, checked
 *   unique in the snapshot they came from, so the journaled op replays;
 * - replay (`run`): targets → fresh refs by `find`; none or two fail, never a guess.
 * Input is headless; a headless refusal (POLICY_DENIED, not delivered) runs
 * again headed once, behind the focus lease. Waits answer found or not, never text.
 *
 * Focus lease (headed input goes to whatever has focus): wait until the person
 * is idle, take focus, check it before every key, stop when the person takes
 * it back and go on from the same key once they are idle, then give focus back.
 */
import { join } from "node:path";
import { drawMs, freshSeed, type Random, seeded } from "../browser/human/draw.js";
import { HUMAN_PACE } from "../browser/human/index.js";
import { aimPoint, mousePath, type PathStep } from "../browser/human/mouse.js";
import { BACKSPACE, typingPlan } from "../browser/human/typing.js";
import {
  type Bounds,
  type ControlTarget,
  type Desktop,
  type DesktopAct,
  type DesktopOp,
  type DesktopWindow,
  type InputMode,
  type SnapNode,
  type Snapshot,
  snapText,
  type WindowRef,
  type WindowTarget,
} from "./types.js";

export interface HandsOptions {
  /** A stored secret by name (`profile.phone`); absent: `secret` is refused. */
  secret?: (name: string) => Promise<string>;
  /** Plain text that looks like a key or password is refused: it belongs in `secret`. */
  looksSecret?: (text: string) => boolean;
  /** A click that may spend waits here for a person (payment gate). */
  gateClick?: (app: string, control: ControlTarget) => Promise<void>;
  shotsDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  exists?: (file: string) => Promise<boolean>;
  /** Tries for a window a target names (a just-launched app is slow to show it). */
  windowTries?: number;
  /** Around real input (the guard and the headed send): the overlay hides so it takes no click or key. */
  headed?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Draws for human typing; absent: a fresh seed per act. */
  random?: Random;
  /** After a headed act, focus goes back to the app that had it (default true). */
  giveFocusBack?: boolean;
}

/** What one act did: the agent's answer, the row to journal, where it happened (for the overlay). */
export interface ActResult {
  answer: Record<string, unknown>;
  op: DesktopOp | null;
  window: DesktopWindow | null;
  /** The control's rect, screen points. */
  box: Bounds | null;
}

const WAIT_DEFAULT_S = 120;
/** Never poll faster than this, nor faster than a snapshot takes (Ghostty: about 2.4 s). */
const POLL_MIN_MS = 1500;

/** No input from the person this long, ms, before a headed act takes focus. */
export const IDLE_MS = 2_000;
/** After a focus switch: the app's first key raced it live (one key lost in 3 runs). */
const FOCUS_SETTLE_MS = 150;
/** Most a headed act waits for the person to stop, ms. */
const IDLE_WAIT_MS = 120_000;
/** Most times the person may take focus back during one act. */
const MAX_TAKEBACKS = 20;
/** Human typing on film: a key every 35 ms inside a run, a run ends at a plan pause past 250 ms. */
export const RUN_INTERVAL_MS = 35;
const RUN_BREAK_MS = 250;
const MAX_PAUSE_MS = 300;

/** Headless input the target refused, nothing sent: a terminal, or a key to a window not in front. */
const refused = (e: unknown): boolean => {
  const x = e as { code?: string; notDelivered?: boolean; message?: string };
  if (x?.notDelivered !== true) return false;
  return x.code === "POLICY_DENIED" || /focus/i.test(x.message ?? "");
};

const PLAIN_KEY: Record<string, string> = {
  " ": "space",
  "\n": "shift+return",
  "\t": "tab",
  "`": "grave",
  "-": "minus",
  "=": "equal",
  "[": "leftbracket",
  "]": "rightbracket",
  "\\": "backslash",
  ";": "semicolon",
  "'": "quote",
  ",": "comma",
  ".": "period",
  "/": "slash",
};
const SHIFTED_KEY: Record<string, string> = {
  "~": "grave",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "minus",
  "+": "equal",
  "{": "leftbracket",
  "}": "rightbracket",
  "|": "backslash",
  ":": "semicolon",
  '"': "quote",
  "<": "comma",
  ">": "period",
  "?": "slash",
};

/** The key combo that types one character on a US layout. */
/** One real pointer move per this many ms: each is a ~15 ms agent-desktop call. */
export const MOVE_MS = 30;

/** A path at ~70 fps cut to one point per `every` ms; the waits add up the same. */
export function coarsePath(path: PathStep[], every = MOVE_MS): PathStep[] {
  const out: PathStep[] = [];
  let wait = 0;
  path.forEach((s, i) => {
    wait += s.after;
    if (wait >= every || i === path.length - 1) {
      out.push({ x: s.x, y: s.y, after: wait });
      wait = 0;
    }
  });
  return out;
}

export function keyOf(ch: string): string {
  if (/^[a-z0-9]$/.test(ch)) return ch;
  if (/^[A-Z]$/.test(ch)) return `shift+${ch.toLowerCase()}`;
  const plain = PLAIN_KEY[ch];
  if (plain) return plain;
  const shifted = SHIFTED_KEY[ch];
  if (shifted) return `shift+${shifted}`;
  throw new Error(`type human: no US key types "${ch}"; drop human for this text`);
}

/** Keys that send text in a shell command: a side door past the focus lease. */
const SHELL_KEYS = /\bkeystroke\b|\bkey code\b|cliclick\s/;

/** What a replay can find again; null when the control has neither a name nor an id. */
export function controlOf(n: SnapNode): ControlTarget | null {
  if (!n.name && !n.nativeId) return null;
  return { role: n.role, name: n.name, ...(n.nativeId ? { nativeId: n.nativeId } : {}) };
}

/** The same rule `find` applies: native id with role, else role plus exact name (any case). */
export function matches(n: SnapNode, t: ControlTarget): boolean {
  if (n.role !== t.role) return false;
  if (t.nativeId) return n.nativeId === t.nativeId;
  return n.name.toLowerCase() === t.name.toLowerCase();
}

const describeWindow = (t: WindowTarget) => `${t.app} window "${t.title}"`;

export function desktopHands(d: Desktop, o: HandsOptions = {}) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const exists = o.exists ?? ((f: string) => d.exists(f));
  const tries = o.windowTries ?? 10;
  /** Snapshots by id: a ref names its snapshot (`@<id>:eN`). */
  const snaps = new Map<string, { snap: Snapshot; window: DesktopWindow }>();
  let lastWindow: DesktopWindow | null = null;
  let shotN = 0;

  /** One window by target: title is a piece of the window's title. Retries while none shows. */
  async function windowFor(t: WindowTarget): Promise<DesktopWindow> {
    for (let i = 0; ; i++) {
      const hits = (await d.windows(t.app)).filter((w) => w.title.includes(t.title));
      if (hits.length === 1) return hits[0] as DesktopWindow;
      if (hits.length > 1)
        throw new Error(
          `${hits.length} ${t.app} windows match "${t.title}" (${hits.map((w) => `"${w.title}"`).join(", ")}): name one by a longer title`,
        );
      if (i + 1 >= tries) throw new Error(`no ${describeWindow(t)}`);
      await sleep(1000);
    }
  }

  async function windowOf(ref: WindowRef | undefined): Promise<DesktopWindow> {
    if (ref === undefined) {
      if (!lastWindow) throw new Error("name a window: no act has used one yet");
      return windowFor({ app: lastWindow.app, title: lastWindow.title });
    }
    if (typeof ref !== "string") return windowFor(ref);
    const w = (await d.windows()).find((x) => x.id === ref);
    if (!w) throw new Error(`no window ${ref}: it closed, or ids changed; list windows again`);
    return w;
  }

  /** What the journal keeps: the agent's own title piece, else the whole title. */
  const targetOf = (w: DesktopWindow, given?: WindowRef): WindowTarget => ({
    app: w.app,
    title: given && typeof given !== "string" ? given.title : w.title,
  });

  /**
   * Headed keys go to whatever has focus, so: the target must be its
   * instance's only window (list-windows can name a same-pid sibling as
   * focused, spike 11-16), then focus it, then the front window's pid must match.
   */
  async function onlyWindow(w: DesktopWindow, what: string): Promise<void> {
    const mine = (await d.windows(w.app)).filter((x) => x.pid === w.pid);
    if (mine.length !== 1)
      throw new Error(
        `${what} needs ${w.app} "${w.title}" to be its instance's only window (pid ${w.pid} has ${mine.length}); launch {app, fresh:true} gives one. Nothing was sent.`,
      );
  }
  async function frontPid(): Promise<number | null> {
    if (d.frontPid) return d.frontPid();
    return (await d.windows()).find((x) => x.focused)?.pid ?? null;
  }

  /**
   * A headed click as a hand: a curved, timed reach to a point inside the control
   * (the browser's `mousePath`), a rest, the press. No pointer API: agent-desktop's
   * click, which jumps.
   */
  async function headedClick(ref: string): Promise<void> {
    const box = d.moveTo && d.clickAt && d.bounds ? await d.bounds(ref) : null;
    if (!box || !d.moveTo || !d.clickAt) return d.click(ref, "headed");
    const random = o.random ?? seeded(freshSeed());
    const pace = HUMAN_PACE.mouse;
    const aim = aimPoint({ x: box.x, y: box.y, width: box.w, height: box.h }, random);
    const from = (await d.pointer?.().catch(() => null)) ?? aim;
    const size = Math.max(1, Math.min(box.w, box.h));
    for (const s of coarsePath(mousePath(from, aim, size, pace, random))) {
      const t0 = now();
      await d.moveTo(s.x, s.y);
      await sleep(Math.max(0, s.after - (now() - t0)));
    }
    await sleep(drawMs(pace.hover, random));
    await d.clickAt(aim.x, aim.y);
  }
  const clickBy = (ref: string) => (m: InputMode) =>
    m === "headed" ? headedClick(ref) : d.click(ref, m);

  /** Waits until no keyboard or mouse input for IDLE_MS: never take focus from a person mid-act. */
  async function personIdle(): Promise<void> {
    if (!d.idleMs) return;
    const t0 = now();
    for (;;) {
      const idle = await d.idleMs();
      if (idle >= IDLE_MS) return;
      if (now() - t0 >= IDLE_WAIT_MS)
        throw new Error(
          `a person used the keyboard or mouse for ${IDLE_WAIT_MS / 1000} s; nothing was sent`,
        );
      await sleep(Math.max(IDLE_MS - idle, 250));
    }
  }

  /** The focus lease: wait for the person, take focus, run, give focus back. */
  async function lease<T>(w: DesktopWindow, fn: () => Promise<T>): Promise<T> {
    await personIdle();
    const before = await frontPid();
    await guard(w);
    try {
      return await fn();
    } finally {
      if (o.giveFocusBack !== false && before !== null && before !== w.pid) {
        const back = (await d.windows().catch(() => [])).find(
          (x) => x.pid === before && !x.minimized,
        );
        if (back) await d.focusWindow(back.id).catch(() => undefined);
      }
    }
  }

  /**
   * `typingPlan` played in runs: keys between the plan's pauses go in one headed `type` at
   * RUN_INTERVAL_MS a key, typo fixes inside the run (one call per key cost ~250 ms, and a
   * press after a run was lost once live). Return is a single press. Front app checked before each run; the person takes focus:
   * wait until they are idle, take it again, go on from the same run.
   */
  async function typeHuman(w: DesktopWindow, ref: string | null, text: string): Promise<void> {
    for (const ch of text) keyOf(ch); // every key known before focus moves
    const plan = typingPlan(text, HUMAN_PACE.typing, o.random ?? seeded(freshSeed()));
    const runs: { text?: string; combo?: string; after: number }[] = [];
    let open: { text: string; after: number } | null = null;
    for (const k of plan) {
      const pause = Math.min(k.after, MAX_PAUSE_MS);
      if (k.ch === "\n") {
        // Return in a run would send a chat prompt: shift+return, alone
        open = null;
        runs.push({ combo: keyOf(k.ch), after: pause });
        continue;
      }
      if (!open) {
        open = { text: "", after: 0 };
        runs.push(open);
      }
      open.text += k.ch === BACKSPACE ? "\b" : k.ch; // agent-desktop types \b as Backspace (live)
      open.after = pause;
      if (k.after >= RUN_BREAK_MS) open = null;
    }
    let takebacks = 0;
    const takenBack = async () => {
      if (++takebacks > MAX_TAKEBACKS)
        throw new Error(`type human: focus left ${w.app} ${MAX_TAKEBACKS} times; stopped`);
      await personIdle();
      await guard(w);
    };
    await lease(w, async () => {
      if (ref) await headedClick(ref);
      const target = ref ?? (await d.focused(w.id));
      for (let i = 0; i < runs.length; ) {
        if ((await frontPid()) !== w.pid) {
          await takenBack();
          continue;
        }
        const r = runs[i] as (typeof runs)[number];
        try {
          if (r.text !== undefined && target)
            await d.type(target, r.text, "headed", RUN_INTERVAL_MS);
          else if (r.text !== undefined)
            for (const ch of r.text) await d.press(keyOf(ch), { windowId: w.id }, "headed");
          else await d.press(r.combo as string, { windowId: w.id }, "headed");
        } catch (e) {
          // a refusal before the first key sent nothing: the same run goes again
          if (!refused(e)) throw e;
          await takenBack();
          continue;
        }
        i++;
        await sleep(r.after);
      }
    });
  }

  async function guard(w: DesktopWindow): Promise<void> {
    await onlyWindow(w, "headed input");
    await d.focusWindow(w.id);
    await sleep(FOCUS_SETTLE_MS);
    const front = (await d.windows()).find((x) => x.focused);
    if (front?.pid !== w.pid)
      throw new Error(
        `focus guard: ${front ? `${front.app} "${front.title}"` : "no window"} has focus, not ${w.app} "${w.title}". Nothing was sent.`,
      );
  }

  /** Headless first; headed once on a refusal, or at once when the recording says so. Returns headed. */
  async function deliver(
    w: DesktopWindow,
    headed: boolean,
    send: (mode: InputMode) => Promise<void>,
  ): Promise<boolean> {
    if (!headed) {
      try {
        await send("headless");
        return false;
      } catch (e) {
        if (!refused(e)) throw e;
      }
    }
    const around = o.headed ?? (<T>(fn: () => Promise<T>) => fn());
    await around(() => lease(w, () => send("headed")));
    return true;
  }

  function fromRef(ref: string): { node: SnapNode; window: DesktopWindow; snap: Snapshot } {
    const id = /^@([^:]+):/.exec(ref)?.[1];
    const hit = id ? snaps.get(id) : undefined;
    const node = hit?.snap.nodes.find((n) => n.ref === ref);
    // A window keeps only its newest snapshot: an older ref is gone, not guessed at.
    if (!hit || !node)
      throw new Error(`unknown or stale ref ${ref}: take a snapshot, then use its refs`);
    return { node, window: hit.window, snap: hit.snap };
  }

  /** The ref's target, refused unless it alone matches in its snapshot. */
  function targetFor(ref: string) {
    const { node, window, snap } = fromRef(ref);
    const control = controlOf(node);
    if (!control)
      throw new Error(
        `${node.role} ${ref} has no name and no id, so a workflow cannot find it again: act another way (a key, a named control)`,
      );
    const same = snap.nodes.filter((n) => matches(n, control)).length;
    if (same !== 1)
      throw new Error(
        `${same} controls match ${control.role} "${control.name}"${control.nativeId ? ` (id ${control.nativeId})` : ""}: a workflow could not tell them apart`,
      );
    return { node, window, control };
  }

  /** The one ref a target finds now. */
  async function refFor(w: DesktopWindow, t: ControlTarget): Promise<string> {
    const refs = await d.find(w.id, t);
    if (refs.length !== 1)
      throw new Error(
        `${refs.length} ${t.role} "${t.name}" in ${w.app} "${w.title}": ${refs.length ? "ambiguous" : "not found"}`,
      );
    return refs[0] as string;
  }

  async function textOf(text: string | undefined, secret: string | undefined): Promise<string> {
    if ((text === undefined) === (secret === undefined))
      throw new Error("type: give one of text or secret");
    if (secret !== undefined) {
      if (!o.secret) throw new Error(`type: no secrets in this session (${secret})`);
      return o.secret(secret);
    }
    if (o.looksSecret?.(text as string))
      throw new Error("type: the text looks like a secret; type it by {secret:<name>}");
    return text as string;
  }

  async function waitText(w: DesktopWindow, text: string, timeoutS: number) {
    const t0 = now();
    for (;;) {
      const s0 = now();
      const snap = await d.snapshot(w.id);
      if (snap.nodes.some((n) => n.name.includes(text) || (n.value ?? "").includes(text)))
        return { found: true, afterS: Math.round((now() - t0) / 100) / 10 };
      if (now() - t0 >= timeoutS * 1000) return { found: false, afterS: timeoutS };
      await sleep(Math.max(POLL_MIN_MS - (now() - s0), 0));
    }
  }

  async function waitFile(file: string, timeoutS: number) {
    const t0 = now();
    for (;;) {
      if (await exists(file)) return { found: true, afterS: Math.round((now() - t0) / 100) / 10 };
      if (now() - t0 >= timeoutS * 1000) return { found: false, afterS: timeoutS };
      await sleep(1000);
    }
  }

  const waited = (r: { found: boolean; afterS: number }, what: string) => {
    if (!r.found) throw new Error(`wait: ${what} not seen in ${r.afterS} s`);
    return r;
  };

  const use = (w: DesktopWindow) => {
    lastWindow = w;
    return w;
  };

  /** Record path: the agent's act runs, and comes back with the op a replay can run. */
  async function act(a: DesktopAct): Promise<ActResult> {
    const none = { window: null, box: null };
    switch (a.op) {
      case "windows": {
        const ws = await d.windows(a.app);
        return {
          answer: {
            windows: ws.map((w) => ({
              id: w.id,
              app: w.app,
              title: w.title,
              pid: w.pid,
              bounds: w.bounds,
              focused: w.focused,
            })),
          },
          op: null,
          ...none,
        };
      }
      case "snapshot": {
        const w = use(await windowOf(a.window));
        const snap = await d.snapshot(w.id);
        for (const [k, s] of snaps) if (s.window.id === w.id) snaps.delete(k);
        snaps.set(snap.id, { snap, window: w });
        return {
          answer: { window: { id: w.id, app: w.app, title: w.title }, tree: snapText(snap.nodes) },
          op: null,
          window: w,
          box: null,
        };
      }
      case "launch": {
        const r = await d.launch(a.app, {
          ...(a.fresh ? { fresh: true } : {}),
          ...(a.args ? { args: a.args } : {}),
        });
        let w = r.window;
        for (let i = 0; !w && i < tries; i++) {
          await sleep(1000);
          w = (await d.windows(a.app)).find((x) => x.pid === r.pid) ?? null;
        }
        if (w) use(w);
        const op: DesktopOp = {
          op: "launch",
          app: a.app,
          ...(a.fresh ? { fresh: true } : {}),
          ...(a.args ? { args: a.args } : {}),
        };
        return {
          answer: { pid: r.pid, window: w ? { id: w.id, title: w.title, bounds: w.bounds } : null },
          op,
          window: w,
          box: null,
        };
      }
      case "click": {
        const { node, window, control } = targetFor(a.ref);
        await o.gateClick?.(window.app, control);
        const headed = await deliver(window, false, clickBy(a.ref));
        use(window);
        return {
          answer: { ok: true, ...(headed ? { headed } : {}) },
          op: {
            op: "click",
            window: targetOf(window),
            control,
            ...(headed ? { headed } : {}),
          },
          window,
          box: node.bounds,
        };
      }
      case "type": {
        if (a.human && a.secret !== undefined)
          throw new Error(
            "type: human sends each key as a command line; a secret goes without human",
          );
        const value = await textOf(a.text, a.secret);
        let window: DesktopWindow;
        let control: ControlTarget | undefined;
        let ref: string;
        let box: Bounds | null = null;
        if (a.ref) {
          const t = targetFor(a.ref);
          window = t.window;
          control = t.control;
          ref = a.ref;
          box = t.node.bounds;
        } else {
          window = await windowOf(a.window);
          const f = await d.focused(window.id);
          if (!f) throw new Error(`type: ${window.app} "${window.title}" has no focused control`);
          ref = f;
        }
        let headed: boolean;
        if (a.human) {
          await onlyWindow(window, "type human");
          const around = o.headed ?? (<T>(fn: () => Promise<T>) => fn());
          await around(() => typeHuman(window, a.ref ? ref : null, value));
          headed = true;
        } else headed = await deliver(window, false, (m) => d.type(ref, value, m, a.paceMs));
        use(window);
        return {
          answer: { ok: true, ...(headed ? { headed } : {}) },
          op: {
            op: "type",
            window: targetOf(window, a.ref ? undefined : a.window),
            ...(control ? { control } : {}),
            ...(a.secret !== undefined ? { secret: a.secret } : { text: a.text as string }),
            ...(a.human ? { human: true } : {}),
            ...(headed ? { headed } : {}),
          },
          window,
          box,
        };
      }
      case "key": {
        const window = a.window || lastWindow ? await windowOf(a.window) : null;
        let headed = false;
        // a headless key goes to the pid, not the window (live 11-16): a sibling could take it
        if (window) await onlyWindow(window, "a key");
        if (window)
          headed = await deliver(window, false, (m) =>
            d.press(a.combo, { windowId: window.id }, m),
          );
        else await d.press(a.combo);
        if (window) use(window);
        return {
          answer: { ok: true, ...(headed ? { headed } : {}) },
          op: {
            op: "key",
            combo: a.combo,
            ...(window ? { window: targetOf(window, a.window) } : {}),
            ...(headed ? { headed } : {}),
          },
          window,
          box: null,
        };
      }
      case "place": {
        const w = use(await windowOf(a.window));
        const b = { x: a.x, y: a.y, w: a.w, h: a.h };
        await d.place(w.id, b);
        const moved = { ...w, bounds: b };
        return {
          answer: { ok: true },
          op: { op: "place", window: targetOf(w, a.window), ...b },
          window: use(moved),
          box: null,
        };
      }
      case "focus": {
        const w = use(await windowOf(a.window));
        await d.focusWindow(w.id);
        return {
          answer: { ok: true },
          op: { op: "focus", window: targetOf(w, a.window) },
          window: w,
          box: null,
        };
      }
      case "waitFile": {
        const timeoutS = a.timeoutS ?? WAIT_DEFAULT_S;
        const r = waited(await waitFile(a.file, timeoutS), `file ${a.file}`);
        return {
          answer: r,
          op: { op: "waitFile", file: a.file, ...(a.timeoutS ? { timeoutS } : {}) },
          ...none,
        };
      }
      case "wait": {
        const timeoutS = a.timeoutS ?? WAIT_DEFAULT_S;
        const w = use(await windowOf(a.window));
        const r = waited(await waitText(w, a.text, timeoutS), "the text");
        return {
          answer: r,
          op: {
            op: "wait",
            window: targetOf(w, a.window),
            text: a.text,
            ...(a.timeoutS ? { timeoutS } : {}),
          },
          window: w,
          box: null,
        };
      }
      case "sleep":
        await sleep(a.ms);
        return { answer: { ok: true }, op: { op: "sleep", ms: a.ms }, ...none };
      case "shot": {
        const file = join(o.shotsDir ?? ".", `os-${String(++shotN).padStart(4, "0")}.png`);
        await d.screenshot(file);
        return { answer: { file }, op: null, ...none };
      }
      case "shell": {
        if (SHELL_KEYS.test(a.command))
          throw new Error(
            "shell: keys sent from a shell skip the focus lease; use {op:type, human:true} or {op:key}",
          );
        const r = await d.shell(a.command, a.root ?? false);
        return {
          answer: { code: r.code, stdout: r.stdout, stderr: r.stderr },
          op: { op: "shell", command: a.command, ...(a.root ? { root: true } : {}) },
          ...none,
        };
      }
    }
  }

  /** Replay path: a journaled op runs on the desktop as it is now. */
  async function run(op: DesktopOp): Promise<{ window: DesktopWindow | null; box: Bounds | null }> {
    const none = { window: null, box: null };
    switch (op.op) {
      case "launch": {
        const r = await d.launch(op.app, {
          ...(op.fresh ? { fresh: true } : {}),
          ...(op.args ? { args: op.args } : {}),
        });
        return { window: r.window, box: null };
      }
      case "click": {
        const w = await windowFor(op.window);
        const ref = await refFor(w, op.control);
        await o.gateClick?.(w.app, op.control);
        await deliver(w, op.headed ?? false, clickBy(ref));
        return { window: w, box: null };
      }
      case "type": {
        const value = await textOf(op.text, op.secret);
        const w = await windowFor(op.window);
        const ref = op.control ? await refFor(w, op.control) : await d.focused(w.id);
        if (!ref) throw new Error(`type: ${describeWindow(op.window)} has no focused control`);
        if (op.human) {
          await onlyWindow(w, "type human");
          const around = o.headed ?? (<T>(fn: () => Promise<T>) => fn());
          await around(() => typeHuman(w, op.control ? ref : null, value));
        } else await deliver(w, op.headed ?? false, (m) => d.type(ref, value, m));
        return { window: w, box: null };
      }
      case "key": {
        if (!op.window) {
          await d.press(op.combo);
          return none;
        }
        const w = await windowFor(op.window);
        await onlyWindow(w, "a key");
        await deliver(w, op.headed ?? false, (m) => d.press(op.combo, { windowId: w.id }, m));
        return { window: w, box: null };
      }
      case "place": {
        const w = await windowFor(op.window);
        await d.place(w.id, { x: op.x, y: op.y, w: op.w, h: op.h });
        return { window: w, box: null };
      }
      case "focus": {
        const w = await windowFor(op.window);
        await d.focusWindow(w.id);
        return { window: w, box: null };
      }
      case "waitFile":
        waited(await waitFile(op.file, op.timeoutS ?? WAIT_DEFAULT_S), `file ${op.file}`);
        return none;
      case "wait": {
        const timeoutS = op.timeoutS ?? WAIT_DEFAULT_S;
        const w = await windowFor(op.window);
        waited(await waitText(w, op.text, timeoutS), `"${op.text}"`);
        return { window: w, box: null };
      }
      case "sleep":
        await sleep(op.ms);
        return none;
      case "shell": {
        const r = await d.shell(op.command, op.root ?? false);
        if (r.code !== 0)
          throw new Error(`shell exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
        return none;
      }
    }
  }

  /** Where a ref's control is, before the act (the overlay aims there); null for an unknown ref. */
  function peek(ref: string): { window: DesktopWindow; box: Bounds } | null {
    try {
      const { node, window } = fromRef(ref);
      return node.bounds ? { window, box: node.bounds } : null;
    } catch {
      return null;
    }
  }

  return { act, run, guard, windowFor, peek };
}

export type DesktopHands = ReturnType<typeof desktopHands>;
