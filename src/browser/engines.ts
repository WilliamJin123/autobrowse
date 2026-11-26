/**
 * Which browser build a local session runs (designs/2026-11-26-browser-engines.md): Google
 * Chrome by default, a Chromium brand by its binary, or Playwright's own Firefox or WebKit.
 * One row per engine; the family is the protocol that drives it. What a family cannot do
 * refuses the session here, before a launch: a guard the session needs is never skipped.
 */
import { existsSync } from "node:fs";
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

export class EngineMissing extends Error {
  readonly engine: Engine;
  constructor(engine: Engine) {
    super(`${TABLE[engine].label} is not installed on this machine (BROWSER_ENGINE=${engine})`);
    this.name = "EngineMissing";
    this.engine = engine;
  }
}

/** The brand's installed binary, or null; `chrome` and brands only. */
export function installedBinary(
  e: Engine,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  return TABLE[e].bins?.[platform]?.find(exists) ?? null;
}

/**
 * What Playwright needs to find the build: a channel (Chrome, Edge), an app binary (brands)
 * or nothing (Playwright's own). `chrome` with no Chrome falls back to Playwright's Chromium
 * at launch (a container); a missing brand fails here.
 */
export function launchTarget(
  e: Engine,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): { executablePath?: string; channel?: string } {
  const row = TABLE[e];
  if (row.channel) return { channel: row.channel };
  if (!row.bins) return {};
  const bin = installedBinary(e, platform, exists);
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
