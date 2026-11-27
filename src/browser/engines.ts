/**
 * Which browser build a local session runs (designs/2026-11-26-browser-engines.md): Chrome by
 * default (Chrome for Testing on a Mac), a Chromium brand by its binary, or Playwright's own
 * Firefox or WebKit.
 * One row per engine; the family is the protocol that drives it. What a family cannot do
 * refuses the session here, before a launch: a guard the session needs is never skipped.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENGINES = [
  "chrome",
  "chromium",
  "edge",
  "brave",
  "opera-gx",
  "firefox",
  "webkit",
  "ios",
] as const;
export type Engine = (typeof ENGINES)[number];
export type Family = "chromium" | "firefox" | "webkit";
/** A fenced run off Chromium: refuse it, or fence by route and blank a redirect hop's outside page. */
export const FENCE_HOPS = ["block", "blank"] as const;
export type FenceHops = (typeof FENCE_HOPS)[number];
/**
 * `chrome` on a Mac: testing = Chrome for Testing, its own app, so a desk browser is never the
 * person's Google Chrome in the Dock (11-27); stable = Google Chrome.app (`CHROME_BUILD`, the rollback).
 */
export const CHROME_BUILDS = ["testing", "stable"] as const;
export type ChromeBuild = (typeof CHROME_BUILDS)[number];

interface Row {
  family: Family;
  label: string;
  /** Installed app binaries, first found wins; absent = Playwright's own build or a channel. */
  bins?: Partial<Record<NodeJS.Platform, readonly string[]>>;
  /** Playwright finds it by channel (Edge). */
  channel?: string;
  /** Playwright device descriptor: emulation, not the real device. */
  device?: string;
}

const inApps = (app: string) => [join("/Applications", app), join(homedir(), "Applications", app)];

const TABLE: Record<Engine, Row> = {
  chrome: {
    family: "chromium",
    label: "Google Chrome",
    channel: "chrome",
    bins: {
      darwin: inApps("Google Chrome.app/Contents/MacOS/Google Chrome"),
      linux: ["/opt/google/chrome/chrome"],
    },
  },
  chromium: { family: "chromium", label: "Chromium (Playwright)" },
  edge: {
    family: "chromium",
    label: "Microsoft Edge",
    channel: "msedge",
    bins: {
      darwin: inApps("Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      linux: ["/opt/microsoft/msedge/msedge"],
    },
  },
  brave: {
    family: "chromium",
    label: "Brave",
    bins: {
      darwin: inApps("Brave Browser.app/Contents/MacOS/Brave Browser"),
      linux: ["/usr/bin/brave-browser", "/opt/brave.com/brave/brave"],
    },
  },
  "opera-gx": {
    family: "chromium",
    label: "Opera GX",
    bins: { darwin: inApps("Opera GX.app/Contents/MacOS/Opera") },
  },
  firefox: { family: "firefox", label: "Firefox (Playwright)" },
  webkit: { family: "webkit", label: "WebKit (Playwright)" },
  ios: { family: "webkit", label: "iPhone (WebKit emulation)", device: "iPhone 15 Pro" },
};

export const familyOf = (e: Engine): Family => TABLE[e].family;
export const labelOf = (e: Engine): string => TABLE[e].label;
export const deviceOf = (e: Engine): string | undefined => TABLE[e].device;

export function isEngine(v: string): v is Engine {
  return (ENGINES as readonly string[]).includes(v);
}

export function engineOf(v: string): Engine {
  if (isEngine(v)) return v;
  throw new Error(`unknown browser engine "${v}": one of ${ENGINES.join(", ")}`);
}

/**
 * Chrome and Playwright's Chromium keep the folder they always had (a container ran
 * `BROWSER_CHANNEL=chromium` on it); any other engine its own (a brand migrates a profile in place).
 * authbridge snapshots only these folders: its paths, IndexedDB read and platform are Chrome's.
 */
export const onChromeFolder = (e: Engine): boolean => e === "chrome" || e === "chromium";

export function profileDirOf(profilesDir: string, profile: string, engine: Engine): string {
  return onChromeFolder(engine)
    ? join(profilesDir, profile)
    : join(profilesDir, ".engines", engine, profile);
}

/** Where `autobrowse browsers update-chrome` keeps Chrome for Testing, one folder per version. */
export const TESTING_DIR = join(homedir(), ".cache", "autobrowse", "chrome-for-testing");

/** The binary inside a version folder: Google's zip layout. */
export const testingBinaryIn = (versionDir: string, arch: string = process.arch): string => {
  const plat = arch === "arm64" ? "mac-arm64" : "mac-x64";
  return join(
    versionDir,
    `chrome-${plat}`,
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  );
};

const byVersionDesc = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

/** Installed CfT versions, newest first (folder names `158.0.8127.88`). */
export function testingVersions(dir: string = TESTING_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
      .sort(byVersionDesc);
  } catch {
    return [];
  }
}

/** The newest installed CfT binary, or null. */
export function testingBinary(
  dir: string = TESTING_DIR,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const v of testingVersions(dir)) {
    const bin = testingBinaryIn(join(dir, v));
    if (exists(bin)) return bin;
  }
  return null;
}

/** How a build is looked up; tests pass every field. */
export interface BuildLookup {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  build?: ChromeBuild;
  /** The CfT binary to run, or null (default: the newest in `TESTING_DIR`). */
  testing?: () => string | null;
}

/** `chrome` runs Chrome for Testing here. */
export const runsTesting = (e: Engine, o: BuildLookup = {}): boolean =>
  e === "chrome" &&
  (o.build ?? "testing") === "testing" &&
  (o.platform ?? process.platform) === "darwin";

/** No Chrome for Testing where `chrome` needs it: a loud stop, never a quiet Google Chrome.app. */
export class TestingMissing extends Error {
  constructor() {
    super(
      "Chrome for Testing is not installed: run `autobrowse browsers update-chrome` (or CHROME_BUILD=stable for Google Chrome.app)",
    );
    this.name = "TestingMissing";
  }
}

export class EngineMissing extends Error {
  readonly engine: Engine;
  constructor(engine: Engine) {
    super(`${TABLE[engine].label} is not installed on this machine (BROWSER_ENGINE=${engine})`);
    this.name = "EngineMissing";
    this.engine = engine;
  }
}

/** The brand's installed binary, or null; `chrome` (CfT on a Mac) and brands only. */
export function installedBinary(e: Engine, o: BuildLookup = {}): string | null {
  if (runsTesting(e, o)) return (o.testing ?? testingBinary)();
  return TABLE[e].bins?.[o.platform ?? process.platform]?.find(o.exists ?? existsSync) ?? null;
}

/**
 * What Playwright needs to find the build: CfT (`chrome` on a Mac), a channel (Chrome, Edge),
 * an app binary (brands) or nothing (Playwright's own). Stable `chrome` with no Chrome falls back
 * to Playwright's Chromium at launch (a container); a missing CfT or brand fails here.
 */
export function launchTarget(
  e: Engine,
  o: BuildLookup = {},
): { executablePath?: string; channel?: string } {
  if (runsTesting(e, o)) {
    const bin = (o.testing ?? testingBinary)();
    if (bin) return { executablePath: bin };
    throw new TestingMissing();
  }
  const row = TABLE[e];
  if (row.channel) return { channel: row.channel };
  if (!row.bins) return {};
  const bin = installedBinary(e, o);
  if (bin) return { executablePath: bin };
  throw new EngineMissing(e);
}

/** The engine has app binaries to look for (a brand, Chrome); none = Playwright's own build. */
export const hasAppBinary = (e: Engine): boolean => !!TABLE[e].bins;

/** The launch-time facts a refusal reads. */
export interface SessionNeeds {
  tier: "local" | "browserbase" | "cdp";
  /** A real window on this Mac (not the live view). */
  window: boolean;
  film: boolean;
  /** Leaves through an egress exit. */
  proxied: boolean;
  /** Passkeys the site's account holds. */
  passkeys: number;
  /** The nav fence holds the top frame to the session's hosts (an agent run), with this hop mode. */
  fenced?: FenceHops;
  platform?: NodeJS.Platform;
}

/** Why this engine cannot open this session, or null. One line: the engine, the guard, what to do. */
export function refusalOf(e: Engine, n: SessionNeeds): string | null {
  const f = familyOf(e);
  if (f === "chromium") return null;
  const name = `BROWSER_ENGINE=${e}`;
  if (n.tier !== "local")
    return `${name}: BROWSER=${n.tier} drives Chromium only; use a local session`;
  if (n.fenced === "block")
    return `${name}: the nav fence cannot hold every redirect hop outside Chromium (measured 11-26), so FENCE_HOPS=block needs a Chromium engine; FENCE_HOPS=blank runs it`;
  if (n.film) return `${name}: a film needs Chromium (CDP frames and a window); use chrome`;
  if (n.window && (n.platform ?? process.platform) === "darwin")
    return `${name} has no focus guard, so its window would take the front: use the live view (--live) or a Chromium engine`;
  if (n.proxied && f === "webkit")
    return `${name}: WebKit cannot keep WebRTC on the proxy, so the page would see this machine's IP; use firefox or a Chromium engine behind an exit`;
  if (n.passkeys > 0)
    return `${name}: the account signs in with a passkey and only Chromium has the virtual authenticator; use chrome`;
  return null;
}

/** The rows a non-Chrome session runs without; the session logs them at open. */
export function missingOf(e: Engine): string[] {
  const f = familyOf(e);
  if (f === "chromium") return [];
  return [
    "stealth patches (Playwright build)",
    "live view select menu, cursor and copy out",
    "⌘⇧O (move to a window)",
  ];
}
