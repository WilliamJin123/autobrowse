/**
 * The desk worker: the site facade on the Mac, as the service `desk`.
 * Some sites refuse the box's datacenter IP (Reddit bot-checks it); their
 * browser legs run here, on a home IP, with the Mac's signed-in profiles.
 * Lean on purpose: no UI, no idle stop, no evaluator; the box stays the worker.
 * Calls come from wren's door (api.wrenautomation.com): the desk pulls them, so it needs no
 * inbound port and calls wait in Postgres while the Mac sleeps.
 * It also serves `claude`: questions to Claude Code on this Mac, read only (`src/claude/`),
 * and for Wren `studio`: renders the Videos page asks for, and new recordings picked up every
 * minute (`src/studio/`); and `calls`: William's calls recorded by OBS (`src/calls/`).
 * launchd keeps it up: `deploy/desk/`.
 */
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import pino from "pino";
import { logPressureOnTimer } from "../browser/memory-pressure-log.js";
import { obsBooth } from "../calls/obs.js";
import { Recorder } from "../calls/recorder.js";
import { callsService, macBanner, watchCalls } from "../calls/service.js";
import { OBS_CREDENTIAL } from "../calls/setup.js";
import { CLAUDE_SERVICE, claudeService } from "../claude/service.js";
import { isDefaultOwner, named } from "../owner.js";
import { fileSiteCalls } from "../runs/calls.js";
import { DESK_SERVICE, sitesService } from "../sites/index.js";
import { studioService, watchRecordings, wrenCheckout, wrenIn } from "../studio/service.js";
import { COMPILED_DIR } from "../workflows/roots.js";
import { proveCompiled } from "./backend.js";
import { doorHttp, pullFromDoor } from "./door-pull.js";
import { boot } from "./owner.js";
import {
  buildApp,
  credentialsFor,
  keepDiskOnTimer,
  keepSharedOnTimer,
  keyAdminFor,
  probeOnTimer,
  probesDirFor,
  sendJournalFor,
  sendSharedOnTimer,
  shareKnownFor,
  siteCallsDirFor,
  upstreamOnTimer,
  watchersFor,
} from "./services.js";

/** The port deploy/desk/install.sh points the Cloudflare Tunnel at. */

/**
 * The Mac sleeps or is off for hours (10-26: 4 h asleep left 70 calls paused). Restate's
 * default gives up after about 70 tries a minute apart. Here a call tries once a minute for
 * about a day, so a post or a send waits for the Mac and goes through. Past that it pauses:
 * the caller's own budget (to the end of its day) decides what is lost.
 */
const OUTAGE_RETRY = {
  initialInterval: 1_000,
  exponentiationFactor: 2,
  maxInterval: 60_000,
  maxAttempts: 1_500,
  onMaxAttempts: "pause",
} as const;

const { settings } = boot();
const log = pino({ level: settings.logLevel });
const app = await buildApp(settings, log);
const watchers = watchersFor(settings, app.browser, log);
const desk = sitesService(
  app.sites,
  named(DESK_SERVICE, settings.owner),
  fileSiteCalls(siteCallsDirFor(settings)),
  watchers,
  // A busy profile: who waited, and which idle explore a write took it from. The journal: what
  // each keyed write left on this Mac, so a rerun after a crash never writes twice.
  {
    wait: { log: (msg, extra) => log.info(extra ?? {}, msg) },
    journal: sendJournalFor(settings),
    keys: keyAdminFor(settings),
  },
);
// Claude Code reads the workspace holding this checkout (wren's `Ask`).
const claude = claudeService(resolve(".."), named(CLAUDE_SERVICE, settings.owner));
// Wren's video editor: its prod, its recordings; never another owner's desk.
const wren = isDefaultOwner(settings.owner) ? wrenIn(wrenCheckout(resolve(".."))) : null;
// William's calls, recorded by OBS on this Mac (wren designs/2026-10-16-call-recording.md).
const recorder = wren
  ? new Recorder({
      booth: obsBooth(async () => {
        const cred = await credentialsFor(settings).get(OBS_CREDENTIAL);
        if (!cred?.password) throw new Error("no OBS password: autobrowse calls setup");
        return cred.password;
      }),
      wren,
      log: (msg) => log.info({ calls: msg }, "calls"),
      notify: macBanner,
    })
  : null;
const services =
  wren && recorder ? [desk, claude, studioService(wren), callsService(recorder)] : [desk, claude];
// calls come only from wren's door (Restate retired 11-09, wren WA-1217): no inbound port
if (!settings.deskDoorUrl || !settings.deskDoorToken)
  throw new Error("desk needs DESK_DOOR_URL and DESK_DOOR_TOKEN: wren's door is its only source");
const pull = await pullFromDoor({
  door: doorHttp(settings.deskDoorUrl, settings.deskDoorToken),
  services,
  retry: OUTAGE_RETRY,
  concurrency: 8,
  log: (msg, extra) => log.warn(extra ?? {}, msg),
});
if (wren) watchRecordings(wren, (msg) => log.info({ watch: msg }, "recordings"));
if (recorder) watchCalls(recorder, (msg) => log.warn({ calls: msg }, "calls"));
watchers?.start();
keepDiskOnTimer(settings, log);
sendSharedOnTimer(log);
upstreamOnTimer(log);
// what holds memory, each minute under pressure (11-09 incident)
logPressureOnTimer((e) => log.warn({ err: String(e) }, "memory pressure log"));
keepSharedOnTimer(log);
probeOnTimer(log, {
  dir: probesDirFor(settings),
  root: COMPILED_DIR,
  sites: app.sites,
  prove: (name, plan) => proveCompiled(app.catalog, app.browser, name, plan),
});
await shareKnownFor(settings);
// A stalled event loop starves every Restate stream on it: calls arrive past their 60 s token
// and connections die (2026-10-16). Log any stall over 2 s, so the next one is proven.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
setInterval(() => {
  const maxMs = Math.round(loopDelay.max / 1e6);
  if (maxMs > 2_000) log.warn({ maxMs }, "desk event loop stalled");
  loopDelay.reset();
}, 10_000).unref();
// deploy/desk/update.mjs waits for this exact message after a restart.
log.info(
  {
    pulls: pull.services,
    browser: settings.browser,
  },
  "desk up",
);
