/**
 * The native overlay over a compiled run's desktop steps (`try --overlay`): the run's `Desktop`, with
 * each act drawn as explore draws it (cursor and box on the control, one trace row). A wrapper, not a
 * render change: workflows compiled before it draw too. No Pause or notes: a replay takes no steer.
 */
import { type OverlayDeps, overlayFor, type TraceRow } from "../explore/overlay.js";
import { SCREEN_PREFS, screenSurface, type WindowHandle } from "./session.js";
import type { Bounds, ControlTarget, Desktop, InputMode } from "./types.js";

export interface OverlaidDesktop {
  desktop: Desktop;
  /** Closes the overlay's window. */
  close(): Promise<void>;
}

export function overlaidDesktop(
  base: Desktop,
  o: { name: string; deps?: OverlayDeps<WindowHandle> },
): OverlaidDesktop {
  // the overlay is a window too: never one a step lists or targets
  const windows: Desktop["windows"] = async (app) =>
    (await base.windows(app)).filter((w) => w.pid !== (overlay.hostPid ?? -1));
  const surface = screenSurface({ windows, displays: () => base.displays() });
  const overlay = overlayFor<WindowHandle>(true, {
    surface,
    prefs: SCREEN_PREFS,
    ...o.deps,
  });
  overlay.who(o.name);
  // one object per id: the overlay compares surfaces by identity
  const handles = new Map<string, WindowHandle>();
  const handle = (id: string): WindowHandle => {
    let h = handles.get(id);
    if (!h) {
      h = { id };
      handles.set(id, h);
    }
    return h;
  };
  /** The window the run works in now: a step finds a control in it, then acts by ref. */
  let current: string | null = null;
  /** The control the last `find` looked for: the row's words. */
  let sought: ControlTarget | null = null;
  let drawn: WindowHandle | null = null;

  const follow = async (windowId: string | null | undefined) => {
    if (!windowId) return;
    current = windowId;
    const h = handle(windowId);
    if (drawn === h) return;
    drawn = h;
    await overlay.set(h, { goal: o.name });
  };
  const front = async () => (await windows().catch(() => [])).find((w) => w.focused)?.id ?? null;

  /** One act: aim at its control, run it (overlay hidden for real input), one trace row. */
  const shown = async <T>(
    cmd: string,
    what: string,
    run: () => Promise<T>,
    at?: { ref: string; mode?: InputMode | undefined },
  ): Promise<T> => {
    if (!current) await follow(await front());
    const s = drawn;
    if (!s) return run();
    const began = Date.now();
    await overlay.begin(s, cmd);
    if (at) {
      const box = await aimBox(at.ref);
      await overlay.aim(s, box, `${cmd} ${what}`);
    }
    let failed: unknown = null;
    try {
      return at?.mode === "headed" ? await overlay.hidden(run) : await run();
    } catch (e) {
      failed = e;
      throw e;
    } finally {
      await overlay.after(s);
      const row: Omit<TraceRow, "n" | "at"> = {
        cmd,
        what,
        ok: failed === null,
        ms: Date.now() - began,
        note: "",
        detail: failed ? [String((failed as Error).message ?? failed).slice(0, 300)] : [],
      };
      await overlay.end(s, row);
    }
  };

  /** The control's rect from its display's top-left; null: no box, the row still shows. */
  const aimBox = async (ref: string): Promise<Bounds | null> => {
    if (!current || !base.bounds) return null;
    const [box, w] = await Promise.all([
      base.bounds(ref).catch(() => null),
      windows()
        .then((ws) => ws.find((x) => x.id === current))
        .catch(() => undefined),
    ]);
    if (!box || !w) return null;
    return surface.local(box, w.bounds);
  };

  const label = () => (sought ? `${sought.role} "${sought.name}"` : "focused control");

  const desktop: Desktop = {
    ...base,
    windows,
    async find(windowId, t) {
      sought = t;
      await follow(windowId);
      return base.find(windowId, t);
    },
    async focused(windowId) {
      sought = null;
      await follow(windowId);
      return base.focused(windowId);
    },
    click: (ref, mode) => shown("click", label(), () => base.click(ref, mode), { ref, mode }),
    // never the text: a row says how much was typed
    type: (ref, text, mode) =>
      shown("type", `${text.length} chars in ${label()}`, () => base.type(ref, text, mode), {
        ref,
        mode,
      }),
    async press(combo, where, mode) {
      await follow(where?.windowId);
      const send = () => base.press(combo, where, mode);
      return shown("key", combo, () => (mode === "headed" ? overlay.hidden(send) : send()));
    },
    async launch(app, lo) {
      const r = await shown("launch", app, () => base.launch(app, lo));
      await follow(r.window?.id);
      return r;
    },
    async place(windowId, b) {
      await follow(windowId);
      return shown("place", `${b.w}×${b.h} at ${b.x},${b.y}`, () => base.place(windowId, b));
    },
    async focusWindow(windowId) {
      await follow(windowId);
      return shown("focus", "window", () => base.focusWindow(windowId));
    },
    // a command can hold a path or a token: the row names the act only
    shell: (command, root) =>
      shown("shell", root ? "as root" : "", () => base.shell(command, root)),
  };

  return {
    desktop,
    async close() {
      if (drawn) await overlay.remove(drawn);
    },
  };
}
