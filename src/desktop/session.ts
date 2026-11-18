/**
 * A desktop session (designs/2026-11-16-autocomp-desktop.md D2): explore's loopback protocol, token
 * files and steering over native windows, with no browser. Takes `os` and the session commands;
 * page commands belong to explore. The overlay follows the window of the last act.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { cleanStrings } from "../browser/clean-text.js";
import { codeVersion, skewWatch } from "../explore/code-version.js";
import { type Command, commandSchema } from "../explore/commands.js";
import { type Journaled, readJournal } from "../explore/journal.js";
import { DEFAULT_IDLE_MINUTES, leaseMs } from "../explore/lease.js";
import {
  type Geometry,
  type OverlayDeps,
  overlayFor,
  type Surface,
  traceRow,
} from "../explore/overlay.js";
import type { ExploreInfo } from "../explore/server.js";
import { pageChange, type Scene, steering } from "../explore/steer.js";
import { commandId, SENT_KEEP, withRepeat } from "../explore/wire.js";
import { type Approver, PaymentGate, PendingApprovals, paymentGate } from "../gates/payment.js";
import { looksLikeSecretValue, redactText } from "../recorder/redact.js";
import { saveRecording } from "../recorder/store.js";
import type { Action, Recording } from "../recorder/types.js";
import { desktopAnswer } from "./answer.js";
import { desktopHands } from "./hands.js";
import { localDesktop } from "./mac.js";
import { type Bounds, type Desktop, type DesktopWindow, type Display, snapText } from "./types.js";

/** What the overlay follows: one object per window id (the overlay compares by identity). */
export interface WindowHandle {
  readonly id: string;
}

/** The commands a desktop session takes; the rest work a page. */
export const DESKTOP_COMMANDS: ReadonlySet<Command["cmd"]> = new Set([
  "os",
  "pause",
  "resume",
  "note",
  "goal",
  "done",
  "journal",
  "save",
  "close",
  "url",
  "overlay",
]);

const refusal = (cmd: string) =>
  `${cmd}: a desktop session takes ${[...DESKTOP_COMMANDS].join(", ")}; page commands need explore`;

/** Answer at once, never behind an act (explore's IMMEDIATE, the desktop part). */
const IMMEDIATE: ReadonlySet<Command["cmd"]> = new Set([
  "pause",
  "resume",
  "journal",
  "url",
  "close",
  "goal",
  "overlay",
]);

export interface DesktopSessionOptions {
  /** The session's name: its site shows as `desktop:<name>`. */
  name: string;
  port: number;
  recordingsDir: string;
  desktop?: Desktop;
  /** Explore's token file for the port; the info file sits beside it. */
  tokenFile?: string;
  /** Acts that worked, one JSON row each; a session that finds one resumes it. */
  journalFile?: string;
  /** Asks the person about a click that may spend. */
  approve?: Approver;
  /** A stored secret by name; absent: `secret` is refused. */
  secrets?: (name: string) => Promise<string | null | undefined>;
  /** Draw the overlay; default on. */
  overlay?: boolean;
  overlayDeps?: OverlayDeps<WindowHandle>;
  idleMinutes?: number;
  owner?: { session?: string; alive?: () => boolean };
  now?: () => number;
  holdMs?: number;
  sleep?: (ms: number) => Promise<void>;
  windowTries?: number;
}

export interface DesktopSession {
  port: number;
  token: string;
  exec(c: Command): Promise<unknown>;
  paused(): boolean;
  done: Promise<void>;
  resumedFrom: { acts: number } | null;
}

/** The display a window sits on: the one holding its center, else the primary. */
export function displayOf(ds: readonly Display[], b: Bounds): Display | null {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return (
    ds.find(
      (d) =>
        cx >= d.bounds.x &&
        cx < d.bounds.x + d.bounds.w &&
        cy >= d.bounds.y &&
        cy < d.bounds.y + d.bounds.h,
    ) ??
    ds.find((d) => d.primary) ??
    ds[0] ??
    null
  );
}

/**
 * A screen panel sits bottom right: apps the session drives tend to sit left (the film: Claude).
 * The island sits below the menu bar.
 */
export const SCREEN_PREFS = { corner: "right", top: 40 } as const;

export interface ScreenSurface extends Surface<WindowHandle> {
  /** A box in screen points, made relative to the display its window sits on: the overlay's px. */
  local(box: Bounds, win: Bounds): Promise<Bounds>;
}

/**
 * The overlay over the whole display of the act's window (D7): one panel for every app the session
 * touches, above all of them. Box = points from the display's top-left; dpr = its scale. pid 0: no
 * window to find. A window gone or minimized: the primary display, so the panel stays up.
 */
export function screenSurface(d: Pick<Desktop, "windows" | "displays">): ScreenSurface {
  let ds: Display[] = [];
  const displays = async () => {
    ds = await d.displays().catch(() => ds);
    return ds;
  };
  const on = (all: Display[], win: Bounds | null) =>
    win ? displayOf(all, win) : (all.find((x) => x.primary) ?? all[0] ?? null);
  return {
    async geometry(h): Promise<Geometry | null> {
      const [ws, all] = await Promise.all([d.windows(), displays()]);
      const w = ws.find((x) => x.id === h.id);
      const disp = on(all, w && !w.minimized ? w.bounds : null);
      if (!disp) return null;
      const { w: width, h: height } = disp.bounds;
      return {
        pid: 0,
        windowId: all.indexOf(disp) + 1,
        bounds: { ...disp.bounds },
        view: { outerW: width, outerH: height, innerW: width, innerH: height, dpr: disp.scale },
        screen: true,
      };
    },
    async local(box, win) {
      const disp = on(ds.length ? ds : await displays(), win);
      const o = disp?.bounds ?? { x: 0, y: 0 };
      return { x: box.x - o.x, y: box.y - o.y, w: box.w, h: box.h };
    },
    // boxes come from snapshots (`aim`), never from page hints
    box: async () => null,
    watch: () => undefined,
    gone: () => undefined,
  };
}

export async function startDesktopSession(opts: DesktopSessionOptions): Promise<DesktopSession> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const site = `desktop:${opts.name}`;
  const infoFile = opts.tokenFile ? `${opts.tokenFile.replace(/\.token$/, "")}.json` : null;
  const shotsDir = join(opts.recordingsDir, `.desktop-${opts.name}`);
  mkdirSync(shotsDir, { recursive: true });
  const actions: Action[] = opts.journalFile ? readJournal(opts.journalFile) : [];
  const carried = actions.at(-1);
  const resumedFrom = carried ? { acts: actions.length } : null;
  const tBase = carried ? carried.t + 1 : 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    finish = r;
  });

  const base = opts.desktop ?? localDesktop();
  // the overlay is a window too: never one the agent lists, targets or compares
  const desktop: Desktop = {
    ...base,
    windows: async (app) =>
      (await base.windows(app)).filter((w) => w.pid !== (overlay.hostPid ?? -1)),
  };
  const surface = screenSurface(desktop);
  const overlay = overlayFor<WindowHandle>(opts.overlay ?? true, {
    surface,
    prefs: SCREEN_PREFS,
    ...opts.overlayDeps,
  });
  overlay.who(opts.name);
  const handles = new Map<string, WindowHandle>();
  const handle = (id: string): WindowHandle => {
    let h = handles.get(id);
    if (!h) {
      h = { id };
      handles.set(id, h);
    }
    return h;
  };
  /** The window of the last act: what the overlay follows and a resume compares. */
  let lastWindow: DesktopWindow | null = null;
  const front = async () => (await desktop.windows().catch(() => [])).find((w) => w.focused);
  /** Where the overlay draws: the last act's window, else the front one. */
  const surfaceNow = async (): Promise<WindowHandle | null> => {
    if (lastWindow) return handle(lastWindow.id);
    const f = await front();
    return f ? handle(f.id) : null;
  };

  const journal = (a: Journaled) => {
    // a desktop row has no page (D8)
    const act = { ...a, t: tBase + now() - t0, url: "" } as Action;
    actions.push(act);
    if (opts.journalFile) appendFileSync(opts.journalFile, `${JSON.stringify(act)}\n`);
  };

  /** Commands in flight. */
  let busy = 0;
  const scene: Scene = {
    async where() {
      const f = await front();
      return f ? `${f.app} ${f.id}` : "no window";
    },
    async rows() {
      if (!lastWindow) return null;
      const s = await desktop.snapshot(lastWindow.id);
      // refs change with every snapshot: rows compare without them
      return snapText(s.nodes.map((n) => ({ ...n, ref: null })))
        .split("\n")
        .filter(Boolean)
        .map((r) => redactText(r));
    },
    short: (w) => w,
    key: "window",
    noun: "window",
    actedBy: "change",
  };
  const steer = steering({
    scene,
    journal: (row) => journal(row),
    held: async (h) => {
      const s = await surfaceNow();
      if (s) await overlay.held(s, h);
    },
    takeNotes: () => overlay.takeNotes(),
    busy: () => busy,
    now,
    change: pageChange,
    redact: redactText,
    ...(opts.holdMs !== undefined ? { holdMs: opts.holdMs } : {}),
  });
  overlay.onSteer((s) => steer.onSteer(s));

  const approvals = opts.approve ? new PendingApprovals(opts.approve) : null;
  /** The `wait` of the `os` command running now: a gate holds or answers pending by it. */
  let osWait = false;
  const secrets = opts.secrets;
  const hands = desktopHands(desktop, {
    ...(secrets
      ? {
          secret: async (name: string) => {
            const v = await secrets(name);
            if (!v) throw new Error(`secret ${name} is not available in this session`);
            return v;
          },
        }
      : {}),
    looksSecret: looksLikeSecretValue,
    shotsDir,
    headed: (fn) => overlay.hidden(fn),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.windowTries !== undefined ? { windowTries: opts.windowTries } : {}),
    async gateClick(app, control) {
      const what = paymentGate("click", { name: control.name, role: control.role });
      if (!what) return;
      if (!approvals) throw new PaymentGate(`${what} in ${app}`, "no-approver");
      await approvals.decide(
        `os click ${app} ${JSON.stringify(control)}`,
        { what: `${what} in ${app}`, url: `app:${app}`, site },
        osWait,
      );
    },
  });

  let saved = false;
  let port = 0;
  const act = async (c: Command, wait: boolean): Promise<unknown> => {
    switch (c.cmd) {
      case "os": {
        const a = c.act;
        osWait = wait;
        // the cursor goes to the control first: the person sees where the act lands
        const at = (a.op === "click" || a.op === "type") && a.ref ? hands.peek(a.ref) : null;
        if (at)
          await overlay.aim(
            handle(at.window.id),
            await surface.local(at.box, at.window.bounds),
            `${a.op} in ${at.window.app}`,
          );
        const r = await hands.act(a);
        if (r.window) lastWindow = r.window;
        // looking (windows, snapshot, shot) journals nothing; a secret is kept by name only
        if (r.op)
          journal({
            kind: "desktop",
            op: r.op,
            redacted: r.op.op === "type" && r.op.secret !== undefined,
          });
        return desktopAnswer(r, shotsDir);
      }
      case "pause":
        return steer.agentPause() ?? { paused: true };
      case "resume":
        return steer.agentResume();
      case "note":
        journal({ kind: "note", text: c.text });
        return { ok: true };
      case "goal": {
        const s = await surfaceNow();
        if (s) await overlay.set(s, { goal: c.text });
        journal({ kind: "note", text: `goal: ${c.text}` });
        return { ok: true };
      }
      case "done":
        journal({
          kind: "note",
          text: `done ${c.outcome}${c.summary ? `: ${c.summary}` : ""}`,
        });
        return { ok: true, close: `autobrowse stop ${port}` };
      case "journal":
        return { total: actions.length, actions: c.last ? actions.slice(-c.last) : actions };
      case "save": {
        const rec: Recording = {
          name: c.name,
          // one site for every desktop recording (autotrack writes the same)
          site: "desktop",
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          actions,
          trace: null,
          terminal: null,
          commands: [],
        };
        const dir = await saveRecording(opts.recordingsDir, rec);
        saved = true;
        return { dir, actions: actions.length };
      }
      case "url": {
        const f = await front();
        return { url: "", window: f ? { id: f.id, app: f.app, title: f.title } : null };
      }
      case "overlay": {
        const { cmd: _, refs, on, name, color, ...fields } = c;
        if (refs) throw new Error("overlay refs mark page controls; a window has none");
        if (name !== undefined || color !== undefined) overlay.who(name, color);
        const s = await surfaceNow();
        if (!s) return { drawn: false, why: "no window to draw over" };
        if (on !== undefined) await overlay.toggle(s, on);
        if (on === false) return { drawn: false };
        return overlay.set(s, fields);
      }
      case "close": {
        if (c.unlessPaused && steer.paused()) return { ok: false, paused: true };
        if (opts.journalFile && !c.keep) rmSync(opts.journalFile, { force: true });
        const s = await surfaceNow();
        if (s) await overlay.remove(s);
        queueMicrotask(() => finish());
        return { ok: true, ...(saved ? {} : { saved: false }) };
      }
      default:
        throw new Error(refusal(c.cmd));
    }
  };

  let chain: Promise<unknown> = Promise.resolve();
  let lastTouch = now();
  const touch = () => {
    lastTouch = now();
    try {
      if (infoFile) utimesSync(infoFile, new Date(), new Date());
    } catch {
      // not written yet, or removed
    }
  };
  const runOne = async (c: Command, wait: boolean, arrived: number): Promise<unknown> => {
    // the person's Pause holds it before it starts
    const held = await steer.heldAnswer(arrived);
    if (held) return held;
    busy++;
    const began = now();
    const s = await surfaceNow();
    if (s) await overlay.begin(s, c.cmd);
    let failed: unknown = null;
    let answer: unknown;
    try {
      answer = await act(c, wait);
      const plain = answer && typeof answer === "object" && !Array.isArray(answer);
      const notes = plain ? overlay.takeNotes() : [];
      return notes.length ? { notes, ...(answer as object) } : answer;
    } catch (err) {
      failed = err;
      throw err;
    } finally {
      const after = (await surfaceNow()) ?? s;
      if (after) {
        await overlay.after(after);
        await overlay.end(after, traceRow(c, failed, now() - began, { from: "", to: "", answer }));
      }
      busy--;
      await steer.afterCommand();
      touch();
    }
  };
  const run = (c: Command, wait = false): Promise<unknown> => {
    touch();
    const arrived = now();
    if (!DESKTOP_COMMANDS.has(c.cmd)) return Promise.reject(new Error(refusal(c.cmd)));
    if (IMMEDIATE.has(c.cmd)) return act(c, wait);
    const next = chain.then(() => runOne(c, wait, arrived));
    chain = next.catch(() => undefined);
    return next;
  };

  const token = randomBytes(16).toString("hex");
  const sent = new Map<string, Promise<{ status: number; body: string }>>();
  const startedCode = codeVersion();
  const skewOf = skewWatch(startedCode);
  const withSkew = (body: string): string => {
    const skew = skewOf();
    return skew && body.startsWith("{") && body !== "{}"
      ? `${body.slice(0, -1)},${JSON.stringify({ skew }).slice(1)}`
      : body;
  };
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end('{"error":"bad or missing bearer token"}');
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      let parsed: Command;
      let id: string | null = null;
      try {
        const raw = JSON.parse(body || "{}") as Record<string, unknown>;
        id = commandId(raw);
        parsed = commandSchema.parse(raw);
        if (!DESKTOP_COMMANDS.has(parsed.cmd)) throw new Error(refusal(parsed.cmd));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      const wait = new URL(req.url ?? "/", "http://x").searchParams.get("wait") === "1";
      // a resend with the same id gets the first answer, never a second act
      const first = id ? sent.get(id) : undefined;
      if (first) {
        const got = await first;
        res.statusCode = got.status;
        res.end(withRepeat(got.body));
        return;
      }
      let settle: (v: { status: number; body: string }) => void = () => undefined;
      if (id) {
        sent.set(
          id,
          new Promise((r) => {
            settle = r;
          }),
        );
        if (sent.size > SENT_KEEP) sent.delete(sent.keys().next().value as string);
      }
      const reply = (out: string) => {
        settle({ status: res.statusCode, body: out });
        // a gate that asked waits on the person: the same command asks again
        if (id && res.statusCode === 202) sent.delete(id);
        res.end(withSkew(out));
      };
      try {
        reply(JSON.stringify(await run(parsed, wait), cleanStrings));
      } catch (err) {
        res.statusCode = err instanceof PaymentGate ? (err.reason === "asked" ? 202 : 403) : 500;
        const error = err instanceof Error ? err.message : String(err);
        reply(
          JSON.stringify(
            {
              error: redactText(error),
              ...(err instanceof PaymentGate ? { gate: err.gate, reason: err.reason } : {}),
            },
            cleanStrings,
          ),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  if (opts.tokenFile) {
    mkdirSync(dirname(opts.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(opts.tokenFile, token, { mode: 0o600 });
  }
  const idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  if (infoFile) {
    const info: ExploreInfo = {
      port,
      pid: process.pid,
      site,
      driver: "console",
      held: idleMs === 0,
      startedAt,
      ...(opts.owner?.session ? { session: opts.owner.session } : {}),
      version: startedCode,
    };
    writeFileSync(infoFile, JSON.stringify(info), { mode: 0o600 });
  }
  const idleCheck =
    idleMs > 0
      ? setInterval(
          () => {
            const paused = steer.paused();
            const gone = !paused && opts.owner?.alive?.() === false;
            if (busy === 0 && now() - lastTouch >= leaseMs(idleMs, { paused, ownerGone: gone }))
              finish();
          },
          Math.min(60_000, idleMs),
        )
      : null;
  idleCheck?.unref();
  const ended = done.then(async () => {
    if (idleCheck) clearInterval(idleCheck);
    server.close();
    server.closeAllConnections();
    if (opts.tokenFile) rmSync(opts.tokenFile, { force: true });
    if (infoFile) rmSync(infoFile, { force: true });
    const s = await surfaceNow().catch(() => null);
    if (s) await overlay.remove(s);
  });
  return {
    port,
    token,
    exec: (c) => run(c, true),
    paused: steer.paused,
    done: ended,
    resumedFrom,
  };
}
