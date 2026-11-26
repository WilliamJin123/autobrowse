/**
 * One browser session per flow run. Local: a persistent Chromium profile
 * per site, so a login done once by hand (`autobrowse record <site>`) is
 * still there next run. Browserbase: a persistent context on their side,
 * same idea. Either way the session is opened for one flow and closed
 * after it; `flow.ts` decides when and holds the per-site lock.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import type { SignInSaver } from "../authbridge/snapshot.js";
import { type HttpClient, safeUrls } from "../clients/http.js";
import { expandHome } from "../google/auth.js";
import { REAL_BROWSER_ENV, relayShim } from "./background-launch.js";
import { assertProfileFree } from "./browsers.js";
import { type Dialogs, watchDialogs } from "./dialogs.js";
import { boundRequests } from "./driver-memory.js";
import type { Egress, Exit } from "./egress.js";
import {
  deviceOf,
  type Engine,
  EngineMissing,
  type FenceHops,
  familyOf,
  hasAppBinary,
  installedBinary,
  labelOf,
  launchTarget,
  missingOf,
  profileDirOf,
  refusalOf,
} from "./engines.js";
import { type FilmOptions, filmContext, filmGeometry } from "./film.js";
import { type Fingerprint, geometry, learnFingerprint, wearFingerprint } from "./fingerprint.js";
import { guardFocus, markNewTargets } from "./focus-guard.js";
import { type Fault, type HarOptions, injectFaults, replayHar, scrubOrDrop } from "./har.js";
import { keepSessionCookies, keptDomains } from "./keep-session.js";
import {
  assertOwnTabRoom,
  cleanUncleanExit,
  LAUNCH_TIMEOUT_MS,
  launchFailed,
  readyOrThrow,
  recordCrash,
} from "./launch-hygiene.js";
import { type LiveView, startLiveView } from "./live-view.js";
import type { Hints } from "./locate.js";
import { guardMemory, treeOf } from "./memory-guard.js";
import { notReachable, type OwnBrowser, ownEndpoint, runsInOwn } from "./own.js";
import { addTab, backgroundTab, dropTab, ownTabsFile, reapTabs } from "./own-tabs.js";
import { DISK_CACHE_BYTES } from "./profile-trim.js";
import { listProcs, reapOrphans, reapTempDirs } from "./reap.js";
import { assertNotReserved, isDesk } from "./reserve.js";
import { type PasskeyRecord, type Passkeys, virtualAuthenticator } from "./webauthn.js";
import { DEFAULT_WINDOW, type WindowPlace, windowPlace } from "./window-bounds.js";

const run = promisify(execFile);

/**
 * Patchright: Playwright with the CDP tells (Runtime.enable, console hooks)
 * patched out, so Cloudflare Turnstile and bot walls see a plain Chrome.
 * Same API and browser builds. Loads on the first browser, not at process
 * start (~2 s of a CLI's boot).
 */
const chromium = async () =>
  (await import("patchright")).chromium as unknown as typeof import("playwright").chromium;

/** Patchright for the chromium family; plain Playwright for Firefox and WebKit, which patchright does not patch. */
async function browserTypeOf(e: Engine): Promise<BrowserType> {
  const f = familyOf(e);
  if (f === "chromium") return (await chromium()) as unknown as BrowserType;
  const pw = await import("playwright");
  return f === "firefox" ? pw.firefox : pw.webkit;
}

/** The binary that runs: the fingerprint's key, the relay's target, ⌘⇧O's app. */
async function binaryOf(e: Engine): Promise<string> {
  const bin = installedBinary(e);
  if (bin) return bin;
  if (hasAppBinary(e) && e !== "chrome") throw new EngineMissing(e);
  return (await browserTypeOf(e)).executablePath();
}

/** A page needs a person: login, captcha, consent, or a layout nobody planned for. */
export class NeedsHuman extends Error {
  /** Set by the runner, not the flow: where the screenshot and trace went. */
  artifacts: Artifacts = {};
  readonly wall?: Wall["kind"] | undefined;
  /**
   * A person can answer it on the page itself (a phone tap's number, a puzzle): the runner
   * may run the flow once more in a window and wait there (`fp.person`, WA-1028).
   */
  person = false;
  constructor(
    reason: string,
    /** The wall that stopped the flow, when one did: a read maps it to an access code. */
    wall?: Wall["kind"],
  ) {
    super(safeUrls(reason));
    this.wall = wall;
    this.name = "NeedsHuman";
  }
}

/**
 * Why a read failed, as words the caller acts on (weaver, wren): sign in, try another way,
 * wait, or report the site broke. One list on both sides of the seam.
 */
export const ACCESS_CODES = [
  "need_login",
  "platform_blocked",
  "rate_limited",
  "upstream_broken",
] as const;
export type AccessCode = (typeof ACCESS_CODES)[number];

/** A flow's read the site refused for a known reason; the runner passes it on unwrapped. */
export class AccessRefused extends Error {
  readonly code: AccessCode;
  constructor(code: AccessCode, reason: string) {
    super(safeUrls(reason));
    this.code = code;
    this.name = "AccessRefused";
  }
}

export interface Artifacts {
  screenshot?: string;
  /** The accessibility tree as text, next to the PNG: every control by role and name. */
  aria?: string;
  trace?: string;
  /** The failure as data (site, flow, url, last goal, error): what `autobrowse repair` starts from. */
  failure?: string;
  /** A watched run's steps (`WATCH_FLOWS`): steps.jsonl, a masked shot and aria per step. */
  steps?: string;
  /** The page calls before the failure, redacted (`browser/network`). */
  network?: string;
  /** The page's HTML at the failure, scripts emptied and redacted. */
  html?: string;
}

/** What a flow left behind when it stopped: enough for an agent to pick up where it fell. */
export interface FailureRecord {
  site: string;
  flow: string;
  url: string;
  /** The goal of the last act the flow attempted, when there was one. */
  goal: string | null;
  /** What the last act or read looked for: pins the one op that broke. */
  hints?: Hints;
  /** Acts and reads the run made before that one: tells two "click Next" apart. */
  actsBefore?: number;
  error: string;
  kind: "failed" | "human" | "interrupted";
  at: string;
  screenshot?: string;
  aria?: string;
  /** Every step up to the failure, when the run was watched. */
  steps?: string;
  network?: string;
  html?: string;
}

/**
 * Where the browser is: launched here with a profile per site, a Browserbase
 * session, or a browser already running that the caller names by its CDP
 * endpoint (a Chrome with `--remote-debugging-port`, or an Electron app such
 * as the new Outlook, Slack, Notion started with it: the desktop leg for
 * apps that are web pages inside).
 */
export type Tier = "local" | "browserbase" | "cdp";

export interface BrowserOptions {
  tier: Tier;
  profilesDir: string;
  artifactsDir: string;
  /** Flows watched step by step (`WATCH_FLOWS`, see `browser/watch`); the runner's own `watch` wins. */
  watchFlows?: string;
  /** Most background tabs `code`'s `fp.each` reads in at once (`READ_TABS`). */
  readTabs?: number;
  headless?: boolean;
  /** The local build (`--engine`, else `BROWSER_ENGINE`; `browser/engines`). One per process. Required: a test defaulting to real Chrome races its code-sign clones. */
  engine: Engine;
  /** The nav fence will hold this session (explore with `allowHosts`). */
  fenced?: boolean;
  /** A fenced run off Chromium (`FENCE_HOPS`): "block" refuses it (`refusalOf`), "blank" runs it. */
  fenceHops?: FenceHops;
  browserbase?: { apiKey: string; projectId: string; http: HttpClient } | null;
  /** `BROWSER=cdp`: the endpoint to attach to (`http://127.0.0.1:9222` or a `ws://` URL). */
  cdpUrl?: string | null;
  /** Passkeys to load into the site's session: the ones enrolled for its account. */
  passkeys?: (site: string) => Promise<readonly PasskeyRecord[]>;
  /**
   * The profile to work in, when it is not the site's own. A credential that
   * signs in through a provider's button belongs in that provider's profile:
   * the session Google already holds there answers the button, where a fresh
   * profile would ask for the password again.
   */
  profile?: string;
  /** The profile directory a name opens: the stored account it names (`x@wren_automation` → `x@wren`). */
  profileName?: (name: string) => Promise<string>;
  /** Where a site's sign-in provider holds its session (a flow's `profile: "provider"`); null = its own. */
  providerProfile?: (site: string) => Promise<string | null>;
  /** The person's own browser, for the sites they opted in (`browser/own`). */
  own?: OwnBrowser | null;
  /** Where each local profile leaves from (`browser/egress`); none = the machine's own line. */
  egress?: Egress;
  /** authbridge: saves a profile's sign-in when a run on it ends ok; none = never saved. */
  signIns?: SignInSaver;
  /**
   * The time zone a local browser says (`America/New_York`): the one where its
   * IP is, or a site sees a Virginia IP on UTC. A profile behind an exit says
   * the exit's (`EGRESS_<NAME>_TZ`); the rest this; the machine's own when unset.
   */
  timezone?: string;
  /** Film every page into a take (`AUTOBROWSE_FILM`, `browser/film`); never the person's own browser. */
  film?: FilmOptions | null;
  /** Headed: where the window opens (`explore --window`). */
  window?: WindowPlace;
  /** What headed means on a Mac (`HEADED_VIEW`): Chrome's window, or the live view. */
  headedView?: "window" | "live";
  /** This session runs headless in the live view (`explore --live`). */
  live?: boolean;
  /** The live view's stream scale (`LIVE_VIEW_SCALE`). */
  liveViewScale?: number;
  /** Record the run's calls to a HAR (`AUTOBROWSE_HAR`, local only), or answer them from one (tests). */
  har?: HarOptions;
  /** Tests: a status, a delay or a dropped call on matching URLs (`browser/har`). */
  faults?: readonly Fault[];
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /**
   * The person's own browser: the context holds their tabs too, so nothing
   * context-wide (trace, routes, init scripts) is done to it.
   */
  shared?: boolean;
  /** The virtual authenticator: export after an enrollment. */
  passkeys: Passkeys;
  /** Each page films itself as a pane (`browser/film.ts`): a trace takes no screenshots of its own. */
  filmed?: boolean;
  /** A new IP from the profile's exit, when it rotates (`browser/egress`); false otherwise. */
  newIp?: () => Promise<boolean>;
  /**
   * Off the screen or back on it (WA-1214): a headed window on this Mac, for a read no
   * person takes over. Absent where there is no window to hide (headless, a film, another OS,
   * a rented or attached browser).
   */
  offscreen?: (off: boolean) => Promise<void>;
  /** Native dialogs seen and answered (`browser/dialogs.ts`). */
  dialogs: Dialogs;
  /** The live view this session shows in (`browser/live-view.ts`): `person` asks for the person. */
  live?: LiveView;
  /** The local build it runs; absent on a rented or attached browser. */
  engine?: Engine;
  close(): Promise<void>;
}

/** The live view's session cookies outlive the hand-off to a window by this long. */
const LIVE_COOKIE_MS = 3_600_000;

/**
 * Headless in the live view: `--live`, or headed while `HEADED_VIEW=live` (the default). A film
 * and a placed window (`--window`) need a real window. Local Chrome on a Mac only.
 */
export function isLive(
  o: Pick<BrowserOptions, "tier" | "headless" | "headedView" | "live" | "film" | "window">,
): boolean {
  if (o.tier !== "local" || process.platform !== "darwin") return false;
  if (o.live === true) return true;
  return o.headless === false && o.headedView === "live" && !o.film && !o.window;
}

/** ⌘⇧O: the same Chromium build on the profile, in a window, the tabs reopened; no automation attached. */
async function openInWindow(profileDir: string, urls: string[], engine: Engine) {
  const args = [`--user-data-dir=${profileDir}`, "--no-first-run", ...urls];
  spawn(await binaryOf(engine), args, { detached: true, stdio: "ignore" }).unref();
}

export async function openSession(site: string, given: BrowserOptions): Promise<Session> {
  if (runsInOwn(given.own, site)) return openOwn(given.own);
  const live = isLive(given);
  if (live && given.film)
    throw new Error("a live session cannot be filmed: the film needs a window");
  // from here on, headed means a real window
  const opts: BrowserOptions = live ? { ...given, headless: true, live: true } : given;
  const asked = opts.profile ?? site;
  const profile = (await opts.profileName?.(asked)) ?? asked;
  const engine = opts.engine;
  // a failed read: Chromium opens without them; any other family refuses (no authenticator to fall back on)
  const stored =
    (await opts.passkeys?.(site).catch((err: Error) => {
      if (familyOf(engine) === "chromium") return [];
      throw new Error(
        `BROWSER_ENGINE=${engine}: cannot read ${site}'s passkeys (${err.message}); use chrome`,
      );
    })) ?? [];
  const exit = opts.tier === "local" ? (opts.egress?.exitFor(profile) ?? null) : null;
  const refused = refusalOf(engine, {
    tier: opts.tier,
    window: opts.headless === false,
    film: !!opts.film,
    proxied: !!exit,
    passkeys: stored.length,
    ...(opts.fenced ? { fenced: opts.fenceHops ?? "blank" } : {}),
  });
  if (refused) throw new Error(refused);
  let context: BrowserContext;
  let browser: Browser | null = null;
  let profileDir = "";
  /** Headed on a Mac: the front stays the person's (`browser/focus-guard`). */
  let focus: ReturnType<typeof guardFocus> | null = null;
  let unmark: (() => Promise<void>) | null = null;
  /** Local launches only: a cap on the browser's memory (`browser/memory-guard`). */
  let guard: ReturnType<typeof guardMemory> | null = null;
  if (opts.tier === "browserbase") {
    if (!opts.browserbase)
      throw new Error("BROWSER=browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
    const contextId = await browserbaseContext(profile, opts.browserbase);
    const session = await browserbaseSession(opts.browserbase, contextId);
    browser = await (await chromium()).connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else if (opts.tier === "cdp") {
    if (!opts.cdpUrl) throw new Error("BROWSER=cdp needs BROWSER_CDP_URL");
    // The app's own context and pages: nothing is launched, nothing closed on our way out.
    browser = await (await chromium()).connectOverCDP(opts.cdpUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    profileDir = profileDirOf(expandHome(opts.profilesDir), profile, engine);
    if (isDesk()) assertNotReserved(profile, profileDir);
    // A browser left by a dead owner would hold this profile; stop those first.
    const reaped = await reapOrphans(expandHome(opts.profilesDir));
    await assertProfileFree(
      profileDir,
      profile,
      reaped.map((o) => o.pid),
    );
    if (cleanUncleanExit(profileDir))
      recordCrash({ profile, reason: "unclean-exit", detail: "found at launch; restore cleared" });
    void reapTempDirs(); // files a crashed upload left, in the background
    context = await launchLocal(profileDir, opts, exit, engine).catch((err: unknown) => {
      throw launchFailed(err, profile);
    });
    guard = guardMemory(context, profileDir);
    if (engine !== "chrome") {
      const off = missingOf(engine);
      console.error(
        `autobrowse: ${labelOf(engine)} ${context.browser()?.version() ?? ""}${off.length ? `; off: ${off.join(", ")}` : ""}`,
      );
    }
    if (
      opts.headless === false &&
      process.platform === "darwin" &&
      familyOf(engine) === "chromium"
    ) {
      const pid = await browserPid(context);
      if (!pid) console.error("autobrowse: no browser pid; the focus guard is off");
      const f = guardFocus({ pid });
      focus = f;
      unmark = await markNewTargets(context, () => f.mark()).catch((err: unknown) => {
        console.error(`autobrowse: no new-tab marks: ${err instanceof Error ? err.message : err}`);
        return null;
      });
    }
    // `navigator.webdriver` is already false (LOCAL_ARGS). No init-script shim: an own
    // `webdriver` property on navigator, reading undefined, is itself a tell.
  }
  const local = opts.tier !== "browserbase" && opts.tier !== "cdp";
  const page = context.pages()[0] ?? (await context.newPage());
  if (local) {
    const launched = context;
    await readyOrThrow(page, profile).catch(async (err: unknown) => {
      recordCrash({ profile, reason: "not-ready", detail: (err as Error).message });
      guard?.stop();
      await launched.close().catch(() => undefined);
      throw err;
    });
  }
  /** Set by our own close: any other close of a local browser is a death (P10). */
  let closing = false;
  if (local)
    context.on("close", () => {
      if (!closing && !guard?.fired())
        recordCrash({
          profile,
          reason: "closed",
          detail: "the browser closed with no close() call",
        });
    });
  boundRequests(context);
  // after the guard: a replay answers first, a fault before both
  if (opts.har?.replay) await replayHar(context, opts.har.replay);
  if (opts.faults?.length) await injectFaults(context, opts.faults);
  const recording = local ? opts.har?.record : undefined;
  const dialogs = watchDialogs(context);
  const film = opts.film ? await filmContext(context, opts.film) : null;
  const passkeys = virtualAuthenticator(context, stored);
  const hide =
    local &&
    opts.headless === false &&
    !opts.film &&
    process.platform === "darwin" &&
    familyOf(engine) === "chromium"
      ? appHider(profileDir)
      : null;
  let session: Session | null = null;
  const view =
    local && live
      ? await startLiveView(context, {
          site,
          scale: opts.liveViewScale ?? 1.2,
          ...liveScreen(await deviceFor(engine)),
          main: page,
          // ⌘⇧O: the profile goes to a real window; this session ends. Chromium only: no focus
          // guard holds a Firefox or WebKit window back from the front
          ...(familyOf(engine) === "chromium"
            ? {
                onWindow: async (urls: string[]) => {
                  await keepSessionCookies(context, /./, Date.now(), LIVE_COOKIE_MS).catch(() => 0);
                  await session?.close();
                  await openInWindow(profileDir, urls, engine);
                  return null;
                },
              }
            : {}),
        })
      : null;
  session = {
    context,
    page,
    passkeys,
    dialogs,
    ...(film ? { filmed: true } : {}),
    ...(hide ? { offscreen: hide } : {}),
    ...(view ? { live: view } : {}),
    ...(local ? { engine } : {}),
    ...(local && opts.egress ? { newIp: () => (opts.egress as Egress).newIp(profile) } : {}),
    async close() {
      if (closing) return;
      closing = true;
      await view?.close();
      guard?.stop();
      focus?.release();
      await unmark?.();
      // Before the pages go: each pane's last frame holds until now.
      await film?.stop();
      // An attached app keeps its windows; only what we launched or rented closes.
      if (opts.tier === "cdp") {
        await browser?.close().catch(() => undefined);
        return;
      }
      // By site: the profile can be another's (William's LinkedIn signs in through the `google` profile).
      const keep = local ? keptDomains(site) : null;
      if (keep) await keepSessionCookies(context, keep).catch(() => 0);
      await context.close().catch(() => undefined);
      if (recording) scrubOrDrop(recording);
      await browser?.close().catch(() => undefined);
    },
  };
  return session;
}

/** The descriptors carry `screen` (iPhone 15 Pro: 393×852); Playwright's type leaves it out. */
type Device = typeof import("playwright")["devices"][string] & {
  screen?: { width: number; height: number };
};

/** The engine's emulated device (`ios`); Playwright loads only then. */
async function deviceFor(engine: Engine): Promise<Device | undefined> {
  const name = deviceOf(engine);
  return name ? (await import("playwright")).devices[name] : undefined;
}

/** The headless screen and DPR (fingerprint.ts), or the device's: the live view's page keeps them. */
function liveScreen(d: Device | undefined): {
  dpr: number;
  screen: { width: number; height: number };
  fixed?: { w: number; h: number };
  touch?: boolean;
} {
  if (d)
    return {
      dpr: d.deviceScaleFactor,
      screen: d.screen ?? d.viewport,
      fixed: { w: d.viewport.width, h: d.viewport.height },
      touch: d.hasTouch,
    };
  const g = geometry(true) as {
    screen: { width: number; height: number };
    deviceScaleFactor: number;
  };
  return { dpr: g.deviceScaleFactor, screen: g.screen };
}

/** A tab of our own in the person's browser; closing it leaves the browser and their tabs. */
async function openOwn(own: OwnBrowser): Promise<Session> {
  const url = await ownEndpoint(own);
  // The browser asks the person to allow the connection: give them time to.
  // Plain Playwright: their browser needs no stealth patches, and patchright's
  // request interception on every target dies on the browser's own internal pages.
  const browser = await (await import("playwright")).chromium
    .connectOverCDP(url, { timeout: 120_000 })
    .catch((err: unknown) => {
      throw new Error(
        `${notReachable(own)} (${err instanceof Error ? err.message.split("\n")[0] : err})`,
      );
    });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  boundRequests(context);
  const ledger = ownTabsFile();
  const cdp = await browser.newBrowserCDPSession();
  await reapTabs(cdp, ledger, own.dataDir).catch(() => []);
  try {
    assertOwnTabRoom(ledger, own.dataDir);
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
  const { page, targetId } = await backgroundTab(context, cdp);
  addTab(ledger, {
    pid: process.pid,
    targetId,
    browser: own.dataDir,
    at: new Date().toISOString(),
  });
  return {
    context,
    page,
    shared: true,
    // Our tab only: their other tabs' dialogs stay theirs.
    dialogs: watchDialogs(page),
    // Their passkeys stay theirs: no virtual authenticator in their browser.
    passkeys: { export: async () => [] },
    async close() {
      await page.close().catch(() => undefined);
      dropTab(ledger, targetId);
      await browser.close().catch(() => undefined); // disconnects; the browser stays open
    },
  };
}

/**
 * Hides or shows the Chrome launched on `profileDir`, as Cmd-H does: the app, not the window.
 * Each profile is its own Chrome app, so no other window goes with it. Measured 11-10 on
 * macOS 26: a hidden app's page stays `visible`, its timers and frames run at full rate
 * (75 s), and loads, clicks and screenshots work. A window moved off the screen does not
 * work: Chrome clamps `--window-position`, and macOS keeps 40 px of a CDP-moved window in view.
 */
function appHider(profileDir: string): (off: boolean) => Promise<void> {
  let hidden = false;
  return async (off) => {
    // hide every time: a popup shows a hidden Chrome again
    if (!off && !hidden) return;
    try {
      const [pid] = treeOf(await listProcs(), profileDir);
      if (!pid) return;
      await run(
        "osascript",
        [
          "-e",
          `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to ${!off}`,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      hidden = off;
    } catch {
      // no permission, or past the cap: the window stays where it is
    }
  };
}

/** Launch flags that keep a site from telling the browser apart from a person's. */
/**
 * A Linux box has no GPU, and headed Chrome there has no WebGL at all (it dropped the
 * software fallback): a rarer tell than the software renderer this turns back on.
 */
const NO_GPU_ARGS = process.platform === "linux" ? ["--enable-unsafe-swiftshader"] : [];
const LOCAL_ARGS = [
  "--disable-blink-features=AutomationControlled",
  `--disk-cache-size=${DISK_CACHE_BYTES}`,
  ...NO_GPU_ARGS,
];

/**
 * Headed on Linux: X11 (XWayland on a Wayland desktop). The overlay can place its window over
 * Chrome's only there (designs/2026-11-04-overlay-out-of-page.md).
 */
const X11_ARGS =
  process.platform === "linux" && process.env.DISPLAY ? ["--ozone-platform=x11"] : [];

/** Headed: no "unsupported command-line flag" infobar over the page (shows in films, shifts the view). */
const HEADED_ARGS = ["--test-type"];

/**
 * Behind a proxy, WebRTC would still ask STUN over UDP from the machine's
 * own address and show the page the IP the proxy hides; only proxied UDP
 * (none, for an HTTP proxy) is allowed.
 */
const PROXIED_ARGS = ["--webrtc-ip-handling-policy=disable_non_proxied_udp"];

/** The headed fingerprint of each Chromium binary on this host, learned on its first headless launch. */
const headedFingerprints = new Map<string, Fingerprint>();

/** The browser process's own pid: a relay can stand between us and it. 0 if unknown. */
async function browserPid(context: BrowserContext): Promise<number> {
  try {
    const s = await context.browser()?.newBrowserCDPSession();
    if (!s) return 0;
    const r = (await s.send("SystemInfo.getProcessInfo")) as {
      processInfo: Array<{ type: string; id: number }>;
    };
    await s.detach().catch(() => undefined);
    return r.processInfo.find((x) => x.type === "browser")?.id ?? 0;
  } catch {
    return 0;
  }
}

async function launchLocal(
  profileDir: string,
  opts: BrowserOptions,
  exit: Exit | null,
  engine: Engine,
): Promise<BrowserContext> {
  if (familyOf(engine) !== "chromium") return launchPlaywrightBuild(profileDir, opts, exit, engine);
  const proxy = exit?.proxy ?? null;
  const headless = opts.headless ?? true;
  // headed with no place: the screen's free area, never Chrome's own 1280x900 in a corner
  const place =
    opts.window ??
    (!headless && !opts.film && process.platform === "darwin"
      ? await windowPlace(DEFAULT_WINDOW).catch(() => undefined)
      : undefined);
  const { args: sizeArgs, ...size } = opts.film
    ? filmGeometry(opts.film.size)
    : geometry(headless, process.platform, place);
  // Headless says the headed fingerprint (fingerprint.ts). Not through Playwright's
  // `userAgent`: that rebuilds the client hints from the UA string and sends
  // `Sec-CH-UA-Arch: "x86"` and platform version "10_15_7" from an arm Mac on 26.x.
  const uaArgs = (ua: string | null) => (headless && ua ? [`--user-agent=${ua}`] : []);
  // Chrome takes its zone from TZ: Date, Intl and workers agree, where a CDP override covers pages only.
  const tz = exit?.timezone ?? opts.timezone;
  const base = (ua: string | null) => ({
    headless,
    ...size,
    args: [
      ...LOCAL_ARGS,
      ...(proxy ? PROXIED_ARGS : []),
      ...sizeArgs,
      ...uaArgs(ua),
      // the live view's frames: else headless paints 1x and only says DPR 2
      ...(opts.live && "deviceScaleFactor" in size
        ? [`--force-device-scale-factor=${size.deviceScaleFactor}`]
        : []),
      ...(headless ? [] : [...X11_ARGS, ...HEADED_ARGS]),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    // else Playwright adds --no-sandbox: an infobar and a bot tell; the Linux worker runs as root, keeps it
    chromiumSandbox: process.platform === "darwin",
    timeout: LAUNCH_TIMEOUT_MS,
    ...(proxy ? { proxy } : {}),
    // written on close; scrubbed then (`browser/har`)
    ...(opts.har?.record
      ? { recordHar: { path: opts.har.record, content: "embed" as const } }
      : {}),
    ...(tz ? { env: { ...process.env, TZ: tz } } : {}),
  });
  // headed on a Mac: launched in the background (`browser/background-launch`); a failed relay costs one steal
  const launch = async (o: ReturnType<typeof base>) => {
    if (o.headless || process.platform !== "darwin") return plainLaunch(o);
    const real = await binaryOf(engine);
    try {
      return await (await chromium()).launchPersistentContext(profileDir, {
        ...o,
        executablePath: relayShim(),
        env: { ...(o.env ?? process.env), [REAL_BROWSER_ENV]: real },
      });
    } catch (err) {
      console.error(
        `autobrowse: background launch failed, launching in front: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
      );
    }
    // a Chrome the failed relay left would hold the profile; the pid guard starts after launch
    await reapOrphans(expandHome(opts.profilesDir)).catch(() => []);
    return plainLaunch(o);
  };
  const type = await browserTypeOf(engine);
  const target = launchTarget(engine);
  const plainLaunch = async (o: ReturnType<typeof base>) => {
    try {
      return await type.launchPersistentContext(profileDir, { ...o, ...target });
    } catch (err) {
      // no Google Chrome (a container): Playwright's Chromium
      const missing = /executable doesn't exist|chrome/i.test(
        err instanceof Error ? err.message : "",
      );
      if (engine !== "chrome" || !missing) throw err;
    }
    console.error("autobrowse: Google Chrome is not installed here; using Playwright's Chromium");
    return type.launchPersistentContext(profileDir, o);
  };
  const key = await binaryOf(engine).catch(() => engine);
  const known = headedFingerprints.get(key) ?? null;
  const context = await launch(base(known?.userAgent ?? null));
  if (!headless) return context;
  if (known) {
    wearFingerprint(context, known);
    return context;
  }
  // Headless Chrome says "HeadlessChrome/153…" and sites like YouTube Studio refuse it as an
  // unsupported browser. The version is only known once launched: learn it, relaunch as the headed one.
  // a throw here would leave the browser running under a live owner, which no reap touches
  const learned = await learnFingerprint(context.pages()[0] ?? (await context.newPage())).catch(
    async (err) => {
      await context.close().catch(() => undefined);
      throw err;
    },
  );
  if (!learned.headless) return context;
  headedFingerprints.set(key, learned.fingerprint);
  await context.close();
  const relaunched = await launch(base(learned.fingerprint.userAgent));
  wearFingerprint(relaunched, learned.fingerprint);
  return relaunched;
}

/**
 * Firefox and WebKit: Playwright's own builds. No Chromium flag applies; their headless UA
 * is already the headed one (measured 11-26). Headed only off a Mac (`refusalOf`).
 */
async function launchPlaywrightBuild(
  profileDir: string,
  opts: BrowserOptions,
  exit: Exit | null,
  engine: Engine,
): Promise<BrowserContext> {
  const proxy = exit?.proxy ?? null;
  const headless = opts.headless ?? true;
  const device = await deviceFor(engine);
  const { args: _chromiumOnly, ...size } = device
    ? { args: [] as string[] }
    : geometry(headless, process.platform, opts.window);
  const tz = exit?.timezone ?? opts.timezone;
  return (await browserTypeOf(engine)).launchPersistentContext(profileDir, {
    headless,
    ...size,
    ...(device
      ? {
          viewport: device.viewport,
          screen: device.screen ?? device.viewport,
          userAgent: device.userAgent,
          deviceScaleFactor: device.deviceScaleFactor,
          isMobile: device.isMobile,
          hasTouch: device.hasTouch,
        }
      : {}),
    timeout: LAUNCH_TIMEOUT_MS,
    ...(proxy ? { proxy } : {}),
    // WebRTC on the proxy only, as PROXIED_ARGS does for Chromium; WebKit behind an exit is refused
    ...(proxy && familyOf(engine) === "firefox"
      ? { firefoxUserPrefs: { "media.peerconnection.ice.proxy_only": true } }
      : {}),
    ...(opts.har?.record
      ? { recordHar: { path: opts.har.record, content: "embed" as const } }
      : {}),
    ...(tz ? { env: { ...process.env, TZ: tz }, timezoneId: tz } : {}),
  });
}

// --- Browserbase: persistent contexts keyed by site name -------------------

const BB = "https://api.browserbase.com/v1";
const contextIds = new Map<string, string>();

type Browserbase = NonNullable<BrowserOptions["browserbase"]>;

async function browserbaseContext(site: string, bb: Browserbase): Promise<string> {
  const known = contextIds.get(site) ?? process.env[`BROWSERBASE_CONTEXT_${site.toUpperCase()}`];
  if (known) return known;
  const r = await bb.http.json<{ id: string }>(`${BB}/contexts`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey },
    body: { projectId: bb.projectId },
  });
  if (!r.ok || !r.body) throw new Error(`browserbase create context: HTTP ${r.status}`);
  contextIds.set(site, r.body.id);
  return r.body.id;
}

async function browserbaseSession(bb: Browserbase, contextId: string) {
  const r = await bb.http.json<{ id: string; connectUrl: string }>(`${BB}/sessions`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey },
    body: {
      projectId: bb.projectId,
      browserSettings: { context: { id: contextId, persist: true } },
    },
  });
  if (!r.ok || !r.body) throw new Error(`browserbase create session: HTTP ${r.status}`);
  return r.body;
}

/** The page shows a login, captcha or verification wall. */
/**
 * The page's visible text, cut in the page: only `limit` characters cross
 * the CDP socket, not a whole document read for its first lines. Empty
 * when the page is gone or mid-navigation.
 */
export async function bodyText(page: Page, limit: number): Promise<string> {
  return page
    .evaluate((n) => (document.body ? document.body.innerText : "").slice(0, n), limit)
    .catch(() => "");
}
// The in-page functions above and below run in the browser; this module compiles without the DOM lib.
declare const document: {
  body: { innerText: string } | null;
  documentElement: { outerHTML: string } | null;
};

/** The page's HTML, cut in the page the same way. */
export async function pageHtml(page: Page, limit: number): Promise<string> {
  return page
    .evaluate(
      (n) => (document.documentElement ? document.documentElement.outerHTML : "").slice(0, n),
      limit,
    )
    .catch(() => "");
}

export interface Wall {
  /** `login` and `challenge`: credentials and codes; `captcha`: the solver (`fp.captcha`), then a person. */
  kind: "login" | "challenge" | "captcha";
  detail: string;
  /** `url`: the URL alone says it (the login page). `text`: the page's words do, a guess. */
  by: "url" | "text";
}

export async function looksLikeWall(page: Page): Promise<Wall | null> {
  const url = page.url();
  // A sign-in path segment, not a substring: myaccount's /signinoptions/ is a settings page.
  if (/accounts\.google\.com\/|signin\.aws\.amazon\.com\/|\/(login|sign-?in)(\/|\?|#|$)/i.test(url))
    return { kind: "login", detail: `login page: ${url}`, by: "url" };
  return wallOf(url, await bodyText(page, 4000));
}

/** The wall a URL and page text show, if any; `looksLikeWall` over a page, this over what a flow already read. */
export function wallOf(url: string, text: string): Wall | null {
  if (/accounts\.google\.com\/|signin\.aws\.amazon\.com\/|\/(login|sign-?in)(\/|\?|#|$)/i.test(url))
    return { kind: "login", detail: `login page: ${url}`, by: "url" };
  // A SAML sign-in (AD FS, the university's) and Duo's prompt after it.
  if (/^https:\/\/[^/]+\/adfs\/ls\/|^https:\/\/api-[0-9a-f]+\.duosecurity\.com\//i.test(url))
    return { kind: "login", detail: `single sign-on: ${url.split("?")[0]}`, by: "url" };
  // LinkedIn signed out: every member page goes to /authwall ("Join LinkedIn", a Sign in link).
  if (/^https:\/\/www\.linkedin\.com\/authwall(\/|\?|$)/i.test(url))
    return { kind: "login", detail: `signed out: ${url}`, by: "url" };
  // LinkedIn signed out on a guest page (a member's /in/ profile, no /authwall): the top bar says
  // "Join now" and "Sign in"; the sign-in dialog sits past the text read here.
  if (
    /^https:\/\/www\.linkedin\.com\//i.test(url) &&
    /\bjoin now\s+sign in\b/i.test(text.slice(0, 600))
  )
    return { kind: "login", detail: `signed out (guest page): ${url}`, by: "text" };
  // TikTok signed out: pages still load, with a Log in button under the side menu and a
  // guest-only "What would you like to watch" picker on top. Mapped 2026-10-29.
  if (
    /^https:\/\/www\.tiktok\.com\//i.test(url) &&
    /what would you like to watch on tiktok\?|\bMore\s+Log in\b/i.test(text)
  )
    return { kind: "login", detail: `signed out: ${url}`, by: "text" };
  // Google Account signed out: myaccount sends every page to its /intro/ twin with a "Sign in" button.
  if (/^https:\/\/myaccount\.google\.com\/intro(\/|\?|$)/i.test(url))
    return { kind: "login", detail: `signed out: ${url}`, by: "url" };
  // "protected by reCAPTCHA" is the legal footer on every sign-up form, not a wall.
  if (
    /verify you are human|(?<!protected by re)captcha|i'm not a robot|unusual traffic|performing security verification|verifies you are not a bot|drag the slider to fit the puzzle/i.test(
      text,
    )
  )
    return { kind: "captcha", detail: "captcha", by: "text" };
  if (/verify your phone|enter the code|2-step verification/i.test(text))
    return { kind: "challenge", detail: "verification challenge", by: "text" };
  // A login form rendered under whatever URL was asked for (platform.claude.com does this).
  if (
    /\b(continue|sign ?in|log ?in|sign ?up) with (google|email|sso|github|microsoft|apple)\b/i.test(
      text,
    )
  )
    return { kind: "login", detail: `login form on ${url}`, by: "text" };
  return null;
}
