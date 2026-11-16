/**
 * `autobrowse screen-record`: the Mac's main screen as an mp4 (ffmpeg avfoundation), cropped to
 * our browsers' windows, with an optional music bed: the meta video of agents at work (WA-1406).
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertNeeds, ffmpegBin } from "../browser/film.js";
import { cacheDir } from "../explore/overlay-host.js";
import { shareFetch } from "../share/fetch.js";

const run = promisify(execFile);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The default bed: CC BY 4.0, credit required (incompetech.com FAQ, checked 2026-11-16). */
export const ELEVATOR = {
  title: "Local Forecast - Elevator",
  url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Local%20Forecast%20-%20Elevator.mp3",
  credit:
    '"Local Forecast - Elevator" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/',
};

/** avfoundation's name for the main display; `:none` = no audio device. */
const SCREEN = "Capture screen 0:none";
const BITRATE = "12M";
/** The bed under the video, not over it. */
export const MUSIC_VOLUME = 0.35;
const FADE_IN_S = 1;
const FADE_OUT_S = 2.5;

/** Raw capture: the real cursor and its clicks drawn; hardware h264. */
export const captureArgs = (raw: string, fps: number, seconds?: number): string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "avfoundation",
  "-capture_cursor",
  "1",
  "-capture_mouse_clicks",
  "1",
  "-framerate",
  String(fps),
  "-i",
  SCREEN,
  ...(seconds ? ["-t", String(seconds)] : []),
  "-c:v",
  "h264_videotoolbox",
  "-b:v",
  BITRATE,
  "-y",
  raw,
];

/** Union of boxes, in video px (`scale` = video px per screen point), inside the frame, even sides. */
export function cropOf(
  boxes: readonly Box[],
  scale: number,
  frame: { w: number; h: number },
): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) * scale);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) * scale);
  const x1 = Math.min(frame.w, Math.max(...boxes.map((b) => b.x + b.w)) * scale);
  const y1 = Math.min(frame.h, Math.max(...boxes.map((b) => b.y + b.h)) * scale);
  const even = (n: number) => Math.floor(n / 2) * 2;
  const c = { x: even(x0), y: even(y0), w: even(x1 - x0), h: even(y1 - y0) };
  return c.w >= 64 && c.h >= 64 ? c : null;
}

/** The finish: crop, then the bed looped, faded in and out, cut to the video's length. */
export function finishArgs(o: {
  raw: string;
  out: string;
  seconds: number;
  crop: Box | null;
  music: string | null;
}): string[] {
  const v = o.crop ? `[0:v]crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}[v]` : null;
  const out = Math.max(0, o.seconds - FADE_OUT_S).toFixed(2);
  const a = o.music
    ? `[1:a]volume=${MUSIC_VOLUME},afade=t=in:d=${FADE_IN_S},afade=t=out:st=${out}:d=${FADE_OUT_S}[a]`
    : null;
  const graph = [v, a].filter(Boolean).join(";");
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    o.raw,
    ...(o.music ? ["-stream_loop", "-1", "-i", o.music] : []),
    ...(graph ? ["-filter_complex", graph] : []),
    "-map",
    v ? "[v]" : "0:v",
    ...(a ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : []),
    "-t",
    o.seconds.toFixed(2),
    ...(v ? ["-c:v", "h264_videotoolbox", "-b:v", BITRATE] : ["-c:v", "copy"]),
    "-movflags",
    "+faststart",
    "-y",
    o.out,
  ];
}

/** CoreGraphics through JXA: on-screen windows, no Accessibility grant needed. */
const WINDOWS_JXA = `ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
const out = [];
for (let i = 0; i < l.count; i++) {
  const w = l.objectAtIndex(i);
  if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) !== 0) continue;
  const b = ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds'));
  out.push({ owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')), pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')), x: b.X, y: b.Y, w: b.Width, h: b.Height });
}
JSON.stringify({ screenW: $.NSScreen.mainScreen.frame.size.width, windows: out });`;

/** Chrome, Chromium and Chrome for Testing; the overlay sits over them. */
const CHROME = /^(Google Chrome|Chromium)/;

export interface ScreenWindow extends Box {
  owner: string;
  pid: number;
}

/** Our browsers' windows; the person's own Chrome only when none of ours is on screen. */
export function ourWindows(windows: readonly ScreenWindow[], ours: ReadonlySet<number>): Box[] {
  const chrome = windows.filter((w) => CHROME.test(w.owner));
  const mine = chrome.filter((w) => ours.has(w.pid));
  return (mine.length ? mine : chrome).map(({ x, y, w, h }) => ({ x, y, w, h }));
}

export async function screenWindows(): Promise<{ screenW: number; windows: ScreenWindow[] }> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", WINDOWS_JXA]);
  return JSON.parse(stdout) as { screenW: number; windows: ScreenWindow[] };
}

const LOCKED_JXA = `ObjC.import('CoreGraphics'); ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]);
const d = $.CGSessionCopyCurrentDictionary(); String(!!(d && ObjC.unwrap(d.objectForKey('CGSSessionScreenIsLocked'))))`;

/** The lock screen up: a capture would film the screensaver, not the windows. */
export async function screenLocked(): Promise<boolean> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", LOCKED_JXA]);
  return stdout.trim() === "true";
}

/** Pids of the browsers autobrowse opened (explore, agent, desk, cli), from `autobrowse browsers`. */
async function ourBrowserPids(profilesDir: string | undefined): Promise<Set<number>> {
  if (!profilesDir) return new Set();
  const { browsersNow } = await import("../browser/browsers.js");
  const v = await browsersNow(profilesDir).catch(() => null);
  return new Set((v?.browsers ?? []).filter((b) => b.opener !== "other").map((b) => b.pid));
}

async function probe(file: string): Promise<{ w: number; h: number; seconds: number }> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    file,
  ]);
  const d = JSON.parse(stdout) as {
    streams: Array<{ width: number; height: number }>;
    format: { duration: string };
  };
  const s = d.streams[0];
  if (!s) throw new Error(`screen-record: no video in ${file}`);
  return { w: s.width, h: s.height, seconds: Number(d.format.duration) };
}

/** The default bed, downloaded once into the cache. */
export async function elevatorTrack(): Promise<string> {
  const file = join(cacheDir(), "music", "local-forecast-elevator.mp3");
  if (existsSync(file)) return file;
  await mkdir(dirname(file), { recursive: true });
  const r = await shareFetch(ELEVATOR.url);
  if (!r.ok) throw new Error(`screen-record: the music download answered ${r.status}`);
  const part = `${file}.part`;
  await writeFile(part, Buffer.from(await r.arrayBuffer()));
  await rename(part, file);
  return file;
}

export interface ScreenRecordOptions {
  out: string;
  fps?: number;
  /** Stop after this long; else at SIGINT or SIGTERM. */
  seconds?: number | undefined;
  /** `elevator` (the default bed), a file, or null: no music. */
  music?: string | null;
  /** Crop to our browsers' windows (default), or keep the whole screen. */
  crop?: "chrome" | "screen";
  /** Where our browser profiles live: picks our windows out of every Chrome's. */
  profilesDir?: string;
  log?: (line: string) => void;
}

export interface ScreenRecording {
  out: string;
  seconds: number;
  crop: Box | null;
  music: string | null;
  /** The credit the bed's licence asks for, also written to `<out>.credits.txt`. */
  credit: string | null;
}

export async function screenRecord(o: ScreenRecordOptions): Promise<ScreenRecording> {
  if (process.platform !== "darwin") throw new Error("screen-record: macOS only (avfoundation)");
  assertNeeds(["ffmpeg"]);
  const log = o.log ?? (() => undefined);
  const music = !o.music ? null : o.music === "elevator" ? await elevatorTrack() : o.music;
  if (music && !existsSync(music)) throw new Error(`screen-record: no music file ${music}`);
  if (await screenLocked().catch(() => false))
    throw new Error("screen-record: the screen is locked; unlock it, then record");
  await mkdir(dirname(o.out), { recursive: true });
  const raw = `${o.out}.raw.mp4`;
  const ff = spawn(ffmpegBin(), captureArgs(raw, o.fps ?? 30, o.seconds), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let said = "";
  ff.stderr.on("data", (b: Buffer) => {
    said = (said + b.toString()).slice(-2_000);
  });
  // `q` lets ffmpeg write the moov atom; a kill leaves an mp4 no player opens.
  // `on`, not `once`: a second Ctrl-C (or pnpm's forward) must not kill us mid-finish.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    ff.stdin.end("q");
    // ffmpeg also finishes cleanly on SIGINT
    setTimeout(() => ff.kill("SIGINT"), 3_000).unref();
  };
  const orphan = () => ff.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", orphan);
  log(o.seconds ? `recording ${o.seconds} s` : "recording; Ctrl-C stops");
  const code = await new Promise<number | null>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", resolve);
  }).finally(() => process.off("exit", orphan));
  if (code !== 0 && !existsSync(raw))
    throw new Error(
      `screen-record: ffmpeg failed: ${said.trim() || `exit ${code}`} (Screen Recording allowed for this terminal?)`,
    );
  // where the windows are at the end: one a person moved stays in the frame
  const wins = o.crop === "screen" ? null : await screenWindows().catch(() => null);
  const ours = wins ? ourWindows(wins.windows, await ourBrowserPids(o.profilesDir)) : [];
  const meta = await probe(raw);
  const crop = wins ? cropOf(ours, meta.w / wins.screenW, meta) : null;
  if (o.crop !== "screen" && !crop)
    log("no Chrome window on the main screen: the whole screen kept");
  if (!crop && !music) await rename(raw, o.out);
  else {
    const fin = spawn(
      ffmpegBin(),
      finishArgs({ raw, out: o.out, seconds: meta.seconds, crop, music }),
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let err = "";
    fin.stderr.on("data", (b: Buffer) => {
      err = (err + b.toString()).slice(-2_000);
    });
    const c = await new Promise<number | null>((resolve, reject) => {
      fin.on("error", reject);
      fin.on("close", resolve);
    });
    if (c !== 0)
      throw new Error(`screen-record: the finish failed: ${err.trim()} (raw kept at ${raw})`);
    await rm(raw, { force: true });
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  const credit = music && o.music === "elevator" ? ELEVATOR.credit : null;
  if (credit) await writeFile(`${o.out}.credits.txt`, `${credit}\n`);
  return { out: o.out, seconds: Math.round(meta.seconds * 10) / 10, crop, music, credit };
}
