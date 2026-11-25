import { type ChildProcess, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

/**
 * Gives the front back when a headed Chrome of ours takes it unasked. A background launch
 * (`browser/background-launch`) stops that for 20-75 s; after that macOS lets Chrome activate
 * itself on a new tab, a popup or bringToFront (measured 2026-11-25).
 * Event driven (NSWorkspace activation note): the front is back in 56-220 ms; polling took 200-300.
 * With `pid`: that Chrome, until it exits or `release`. Without: any Chrome that started after
 * the guard (a launch whose pid is not known yet), for `capMs`.
 * The person's own switch (a click, or Cmd let go after Tab or Space) is followed, never fought.
 * A click or Cmd in the person's own app looks the same: then a new tab or window in the last
 * 1.5 s (`mark`, from `markNewTargets`) says the activation was Chrome's, and it is undone.
 */
export const GUARD_JS = `ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  const pid = Number(argv[0]) || 0;
  const ms = Number(argv[1]) || 0;
  const markPath = argv[2] || "";
  const ws = $.NSWorkspace.sharedWorkspace;
  const loop = (s) => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(s));
  const appOf = (p) => {
    const a = p ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(p) : null;
    return a && !a.isNil() ? a : null;
  };
  // seconds since an input event of a type (HID state): 1 left down, 3 right down, 10 key down, 12 modifier
  const since = (type) => $.CGEventSourceSecondsSinceLastEventType(1, type);
  const byPerson = () =>
    since(1) < 0.8 || since(3) < 0.8 || (since(12) < 0.8 && since(12) < since(10));
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const chromes = ["com.google.Chrome", "com.google.Chrome.for.Testing", "com.google.Chrome.beta",
    "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium"];
  // ps etime [[dd-]hh:]mm:ss; launchDate is nil off LaunchServices
  const ranS = (p) => {
    try {
      const e = app.doShellScript("ps -o etime= -p " + p).trim();
      const [days, rest] = e.includes("-") ? e.split("-") : ["0", e];
      return Number(days) * 86400 + rest.split(":").map(Number).reduce((s, v) => s * 60 + v, 0);
    } catch (e) {
      return Infinity;
    }
  };
  const t0 = Date.now();
  const ours = (a, p) => {
    if (pid) return p === pid;
    return chromes.includes(ObjC.unwrap(a.bundleIdentifier) || "") && ranS(p) <= (Date.now() - t0) / 1000 + 2;
  };
  const marked = () => {
    if (!markPath) return false;
    const at = $.NSFileManager.defaultManager.attributesOfItemAtPathError(markPath, $());
    if (!at || at.isNil()) return false;
    return Date.now() - at.objectForKey("NSFileModificationDate").timeIntervalSince1970 * 1000 < 1500;
  };
  const back = (p) => {
    const a = appOf(p);
    if (!a) return;
    if (a.activateWithOptions($.NSApplicationActivateAllWindows)) return;
    try {
      Application("System Events").processes.whose({ unixId: p })()[0].frontmost = true;
    } catch (e) {}
  };
  // frontmostApplication is stale until a run loop turns
  loop(0.03);
  const f = ws.frontmostApplication;
  let theirs = f && !f.isNil() ? f.processIdentifier : 0;
  if (!theirs) return "none";
  let n = 0;
  // a Chrome that takes the front 6 times in 5 s wins: never a loop of flashes
  let recent = [];
  const restore = () => {
    const now = Date.now();
    recent = recent.filter((t) => now - t < 5000);
    if (recent.length >= 6) return;
    recent.push(now);
    back(theirs);
    n++;
  };
  // an activation while the person was busy: judged 150 ms later, when the new target's mark is in
  let pending = 0;
  ObjC.registerSubclass({
    name: "FocusGuardWatch",
    methods: {
      "activated:": {
        types: ["void", ["id"]],
        implementation: (note) => {
          const a = note.userInfo.objectForKey("NSWorkspaceApplicationKey");
          if (!a || a.isNil()) return;
          const p = a.processIdentifier;
          if (!ours(a, p)) {
            theirs = p;
            return;
          }
          if (p === theirs) return;
          // the mark is usually in before the note: no wait then
          if (byPerson() && !marked()) pending = Date.now();
          else restore();
        },
      },
    },
  });
  // the center holds observers weakly: keep this one alive past GC (it went quiet after 4 notes)
  const watch = $.FocusGuardWatch.alloc.init;
  ws.notificationCenter.addObserverSelectorNameObject(
    watch, "activated:", $.NSWorkspaceDidActivateApplicationNotification, $());
  const end = ms ? Date.now() + ms : Infinity;
  while (Date.now() < end && (!pid || appOf(pid))) {
    // returns after each note, so a pending activation is judged on time
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
      $.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(pending ? 0.05 : 0.5));
    if (!pending || Date.now() - pending < 150) continue;
    pending = 0;
    const f = ws.frontmostApplication;
    if (f && !f.isNil() && ours(f, f.processIdentifier) && marked()) restore();
  }
  ws.notificationCenter.removeObserver(watch);
  return String(n);
}`;

/** Off a Mac, or with nothing in front: a no-op. */
export type FocusGuard = {
  release(graceMs?: number): void;
  /** Chrome just made a tab or window: its activation now is Chrome's, not the person's. */
  mark(): void;
};

let guards = 0;

export function guardFocus(
  o: {
    pid?: number;
    capMs?: number;
    spawn?: typeof spawn;
    platform?: NodeJS.Platform;
    markFile?: string;
  } = {},
): FocusGuard {
  if ((o.platform ?? process.platform) !== "darwin")
    return { release: () => undefined, mark: () => undefined };
  let child: ChildProcess | null = null;
  const capMs = o.capMs ?? (o.pid ? 0 : 30_000);
  const markFile = o.markFile ?? join(tmpdir(), `autobrowse-focus-${process.pid}-${++guards}`);
  try {
    child = (o.spawn ?? spawn)(
      "osascript",
      ["-l", "JavaScript", "-e", GUARD_JS, String(o.pid ?? 0), String(capMs), markFile],
      { stdio: "ignore" },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    child = null;
  }
  return {
    // a launch guard keeps a grace: Chrome can take the front again as its first page paints
    release(graceMs = o.pid ? 0 : 8_000) {
      const c = child;
      child = null;
      if (!c) return;
      const stop = () => {
        c.kill();
        rmSync(markFile, { force: true });
      };
      if (graceMs <= 0) stop();
      else setTimeout(stop, graceMs).unref();
    },
    mark() {
      if (!child) return;
      try {
        writeFileSync(markFile, "");
      } catch {}
    },
  };
}

/** Calls `mark` on each new tab or window (CDP target discovery). Returns the stop. */
export async function markNewTargets(
  context: BrowserContext,
  mark: () => void,
): Promise<() => Promise<void>> {
  const s = await context.browser()?.newBrowserCDPSession();
  if (!s) return async () => undefined;
  s.on("Target.targetCreated", (e) => {
    if (e.targetInfo.type === "page") mark();
  });
  await s.send("Target.setDiscoverTargets", { discover: true });
  return () => s.detach().catch(() => undefined);
}
