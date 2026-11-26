import { type ChildProcess, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

/**
 * Gives the front back when our headed Chrome takes it unasked. A background launch
 * (`browser/background-launch`) stops that for 20-75 s; after that macOS lets Chrome activate
 * itself on a new tab, a popup or bringToFront (measured 2026-11-25).
 * Event driven (NSWorkspace activation note): the front is back in 56-220 ms; polling took 200-300.
 * One Chrome by pid, until it exits or `release`. Rules: `onActivated`, `onWaiting`.
 */

/** A click (left or right) or a modifier with no later key, in the last 0.8 s: maybe the person's switch. */
export const PERSON_S = 0.8;
/** A site-opened tab or popup (`mark`) this recent explains an activation. */
export const MARK_MS = 1500;

/**
 * An app became active. `follow`: it is the person's app now; `wait`: judge again with
 * `onWaiting`; `restore`: give the front back. Pure: spliced into GUARD_JS and tested.
 */
export function onActivated(s: {
  ours: boolean;
  theirs: boolean;
  otherAutobrowse: boolean;
  person: boolean;
  marked: boolean;
}): "follow" | "ignore" | "wait" | "restore" {
  // another session's Chrome is never the person's app: two guards would pass the front around
  if (!s.ours) return s.otherAutobrowse ? "ignore" : "follow";
  if (s.theirs) return "ignore";
  // input in the person's own app reads the same as a switch: only a mark tells them apart
  return s.person && !s.marked ? "wait" : "restore";
}

/** A waiting activation, every 50 ms: restore once a mark comes in, follow the person after MARK_MS. */
export function onWaiting(s: {
  stillOurs: boolean;
  marked: boolean;
  waitedMs: number;
  markMs: number;
}): "restore" | "wait" | "drop" {
  if (!s.stillOurs) return "drop";
  if (s.marked) return "restore";
  return s.waitedMs < s.markMs ? "wait" : "drop";
}

export const GUARD_JS = `ObjC.import("AppKit");
ObjC.import("CoreGraphics");
${onActivated.toString()}
${onWaiting.toString()}
function run(argv) {
  const pid = Number(argv[0]) || 0;
  const markPath = argv[1] || "";
  if (!pid) return "no pid";
  const ws = $.NSWorkspace.sharedWorkspace;
  const appOf = (p) => {
    const a = p ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(p) : null;
    return a && !a.isNil() ? a : null;
  };
  // seconds since an input event of a type (HID state): 1 left down, 3 right down, 10 key down, 12 modifier
  const since = (type) => $.CGEventSourceSecondsSinceLastEventType(1, type);
  const person = () =>
    since(1) < ${PERSON_S} || since(3) < ${PERSON_S} || (since(12) < ${PERSON_S} && since(12) < since(10));
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const chromes = ["com.google.Chrome", "com.google.Chrome.for.Testing", "com.google.Chrome.beta",
    "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium"];
  const otherAutobrowse = (a, p) => {
    if (!chromes.includes(ObjC.unwrap(a.bundleIdentifier) || "")) return false;
    try {
      return app.doShellScript("ps -o command= -p " + p).includes("--autobrowse-owner=");
    } catch (e) {
      return false;
    }
  };
  const marked = () => {
    if (!markPath) return false;
    const at = $.NSFileManager.defaultManager.attributesOfItemAtPathError(markPath, $());
    if (!at || at.isNil()) return false;
    return Date.now() - at.objectForKey("NSFileModificationDate").timeIntervalSince1970 * 1000 < ${MARK_MS};
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
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.03));
  const f = ws.frontmostApplication;
  let theirs = f && !f.isNil() ? f.processIdentifier : 0;
  if (!theirs) return "none";
  let n = 0;
  // 6 restores in 5 s pauses the guard: a page never gets a loop of flashes
  let recent = [];
  const restore = () => {
    const now = Date.now();
    recent = recent.filter((t) => now - t < 5000);
    if (recent.length >= 6) return;
    recent.push(now);
    back(theirs);
    n++;
  };
  let waitingSince = 0;
  ObjC.registerSubclass({
    name: "FocusGuardWatch",
    methods: {
      "activated:": {
        types: ["void", ["id"]],
        implementation: (note) => {
          const a = note.userInfo.objectForKey("NSWorkspaceApplicationKey");
          if (!a || a.isNil()) return;
          const p = a.processIdentifier;
          const ours = p === pid;
          const v = onActivated({
            ours,
            theirs: p === theirs,
            otherAutobrowse: !ours && otherAutobrowse(a, p),
            person: ours && person(),
            marked: ours && marked(),
          });
          waitingSince = v === "wait" ? Date.now() : 0;
          if (v === "follow") theirs = p;
          else if (v === "restore") restore();
        },
      },
    },
  });
  // the center holds observers weakly: keep this one alive past GC (it went quiet after 4 notes)
  const watch = $.FocusGuardWatch.alloc.init;
  ws.notificationCenter.addObserverSelectorNameObject(
    watch, "activated:", $.NSWorkspaceDidActivateApplicationNotification, $());
  while (appOf(pid)) {
    // returns after each note, so a waiting activation is judged on time
    $.NSRunLoop.currentRunLoop.runModeBeforeDate(
      $.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(waitingSince ? 0.05 : 0.5));
    if (!waitingSince) continue;
    const f = ws.frontmostApplication;
    const v = onWaiting({
      stillOurs: !!f && !f.isNil() && f.processIdentifier === pid,
      marked: marked(),
      waitedMs: Date.now() - waitingSince,
      markMs: ${MARK_MS},
    });
    if (v === "wait") continue;
    waitingSince = 0;
    if (v === "restore") restore();
  }
  ws.notificationCenter.removeObserver(watch);
  return String(n);
}`;

export type FocusGuard = {
  release(): void;
  /** Chrome opened a tab or popup for a page: its activation now is Chrome's, not the person's. */
  mark(): void;
};

let guards = 0;

/** Off a Mac: a no-op. */
export function guardFocus(o: {
  pid: number;
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
  markFile?: string;
}): FocusGuard {
  if ((o.platform ?? process.platform) !== "darwin" || !o.pid)
    return { release: () => undefined, mark: () => undefined };
  let child: ChildProcess | null = null;
  const markFile = o.markFile ?? join(tmpdir(), `autobrowse-focus-${process.pid}-${++guards}`);
  try {
    const c = (o.spawn ?? spawn)(
      "osascript",
      ["-l", "JavaScript", "-e", GUARD_JS, String(o.pid), markFile],
      { stdio: "ignore" },
    );
    child = c;
    c.on("error", () => undefined);
    // 0 = its Chrome exited; anything else is a script fault, and the front is unguarded
    c.on("exit", (code) => {
      if (child === c && code) console.error(`autobrowse: focus guard stopped (exit ${code})`);
    });
    c.unref();
  } catch {
    child = null;
  }
  return {
    release() {
      const c = child;
      child = null;
      if (!c) return;
      c.kill();
      rmSync(markFile, { force: true });
    },
    mark() {
      if (!child) return;
      try {
        writeFileSync(markFile, "");
      } catch {}
    },
  };
}

/**
 * Calls `mark` on each tab or popup a page opens (a target with an opener). Our own
 * `background:true` tabs have none: they never activate Chrome, so they never mark.
 */
export async function markNewTargets(
  context: BrowserContext,
  mark: () => void,
): Promise<() => Promise<void>> {
  const s = await context.browser()?.newBrowserCDPSession();
  if (!s) return async () => undefined;
  s.on("Target.targetCreated", (e) => {
    if (e.targetInfo.type === "page" && e.targetInfo.openerId) mark();
  });
  await s.send("Target.setDiscoverTargets", { discover: true });
  return () => s.detach().catch(() => undefined);
}
