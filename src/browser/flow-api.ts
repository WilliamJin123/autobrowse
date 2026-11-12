import type { Page } from "playwright";
import type { OverlayDeps } from "../explore/overlay.js";
import type { FlowRuns } from "../runs/flows.js";
import type { DoneActs } from "./attempt.js";
import type { CaptchaOutcome, Eyes } from "./captcha/index.js";
import type { CodeStore } from "./code.js";
import type { Fixes } from "./fixes.js";
import type { Pace } from "./human/index.js";
import type { Strategy } from "./ladder.js";
import type { Hints } from "./locate.js";
import type { NetLog } from "./network.js";
import type { SessionPark } from "./park.js";
import type { ProfilePool } from "./profile-pool.js";
import type { Repairer, RepairReport } from "./repair.js";
import type { Resumes } from "./resume.js";
import type { LearnedScreens, ScreenHelp, ScreenReader } from "./screens.js";
import type { Artifacts, BrowserOptions, FailureRecord } from "./session.js";
import type { Passkeys } from "./webauthn.js";

/** A site names a persistent profile; any kebab-case string. Known ones have a home page for `login`. */
export type Site = string;

export const SITES: Record<string, { home: string }> = {
  cloudflare: { home: "https://dash.cloudflare.com/" },
  "google-admin": { home: "https://admin.google.com/" },
  instantly: { home: "https://app.instantly.ai/" },
};

/** One recorded gesture, replayed. */
export type Op =
  | { kind: "click" }
  | { kind: "fill"; value: string }
  | { kind: "select"; value: string }
  | { kind: "press"; key: string }
  /** The pointer onto the control, and it stays: a hover menu, a control shown on hover, a tooltip. */
  | { kind: "hover" }
  /**
   * Files into a file input, or through the chooser a button opens: paths or refs, or bytes
   * held in memory (a stored file), which reach the page without touching the disk.
   */
  | { kind: "upload"; files: string[] | FilePayload[] }
  /** A script: a function of `el` on the target, or an expression on the page when there are no hints. */
  | { kind: "script"; js: string };

/** No hints at all: an act on the page, not an element. */
export const pageWide = (h: Hints): boolean => !Object.values(h).some((v) => v != null);

/** A file held in memory, as Playwright's `setInputFiles` takes it. */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ActOptions {
  /** In words, for the repairer and the trace: "click Purchase". */
  goal: string;
  /** Never repaired: a miss goes to a person. */
  irreversible?: boolean;
  timeoutMs?: number;
}

/** What a flow body gets: the page, plus the things every flow does. */
export interface OpenOptions {
  /** Land on a login page on purpose (the sign-in flow itself). */
  allowWall?: boolean;
  /** `url`: sign in only on a wall its URL shows; a wall only the text suggests is left for the caller (explore). */
  signIn?: "url";
}

export interface FlowPage {
  page: Page;
  /** The session's virtual authenticator: export after a passkey enrollment. */
  passkeys: Passkeys;
  /**
   * Navigate. On a login wall the runner signs in with stored credentials
   * and tries again; a captcha, or a site nobody has credentials for,
   * goes to a person.
   */
  open(url: string, opts?: OpenOptions): Promise<void>;
  url(): string;
  /** Visible text of the page, capped; what a person would read. */
  text(): Promise<string>;
  /** Raw markup, capped; for things the eye cannot see (an otpauth link behind a QR). */
  html(): Promise<string>;
  /**
   * Visible now, or within `withinMs` when given (a page still rendering its
   * next step); a wait handles interrupts on the way, as an act does.
   */
  has(hints: Hints, withinMs?: number): Promise<boolean>;
  /** The element's text, trimmed and capped: what a scraping step keeps. */
  read(hints: Hints): Promise<string>;
  wait(ms: number): Promise<void>;
  /**
   * Answer requests under `prefix` in the browser itself (an OAuth redirect
   * nothing serves), so the page lands there and its URL keeps the query.
   */
  answer(prefix: string, body: string): Promise<void>;
  /** Resolves when the URL matches, or null at the timeout. */
  waitForUrl(pattern: RegExp | ((url: string) => boolean), timeoutMs: number): Promise<boolean>;
  /** The next page the site opens (an OAuth popup), or null when none comes in time. */
  nextPage(timeoutMs: number): Promise<Page | null>;
  /** Move the page down about `dy` px with the runner's hands (a feed read). */
  scroll(dy: number): Promise<void>;
  /** Every page open right now: a card that opened itself is already here, so no event comes. */
  pages(): Page[];
  /** Act on this page from now on (a popup); pass the main page to return. */
  switchTo(page: Page): void;
  /**
   * Find by hints and do the op. On a miss, ask the repairer for other
   * hints for the same goal and try once more; report the repair either way.
   */
  act(op: Op, hints: Hints, opts: ActOptions): Promise<void>;
  /**
   * Answer a wall the flow walked into on its own (a re-verification in
   * the middle of an OAuth consent): the runner signs in where the page
   * is, with no navigation to lose the URL that carries the walk.
   */
  signIn(
    site?: Site,
    account?: string,
  ): Promise<"signed-in" | "no-credential" | "unknown-site" | "no-login">;
  /**
   * Solve the captcha the page shows with the runner's hands and eyes
   * (`browser/captcha`): a checkbox always, a picture one when the runner
   * has eyes. Never throws for an unsolved one; the outcome says why.
   */
  captcha(): Promise<CaptchaOutcome>;
  /**
   * A new IP for this profile, when its exit rotates (`browser/egress`): true
   * once the line has the new address. False on the machine's own line.
   */
  newIp(): Promise<boolean>;
  /** Stop here and ask a person. */
  human(reason: string): never;
  /**
   * A step a person answers on this page (a phone tap's number, a puzzle). In a window a person
   * sees: the window comes to the front and the flow waits here till `gone` says the step is
   * past; no answer in `ms` is a NeedsHuman. In a headless run: a NeedsHuman marked `person`,
   * and the runner runs the flow once more in a window. Absent in fakes: use `human`.
   */
  person?(reason: string, gone: () => Promise<boolean>, ms?: number): Promise<void>;
  /** Under a durable call: `code`'s store for `scope`, kept across retries. Null on a local run. */
  codeStore?(scope: string): CodeStore | null;
  /** What a screens walk asks of the runner: the page's shape, learned screens, a model (`browser/screens`). */
  screens?: ScreenHelp;
  /** The session's page calls, redacted (`browser/network`); absent in fakes. */
  network?: NetLog;
  /** A new background tab in this session, for `code`'s `fp.each`; absent in fakes. */
  readTab?(): Promise<ReadTab>;
  /** Most read tabs at once (`READ_TABS`). */
  readTabs?: number;
}

/** A background tab for parallel reads: same sign-in, never an act that changes a site. */
export interface ReadTab {
  readonly page: Page;
  /** Navigate; a wall throws: sign in on the main page, then run again. */
  open(url: string): Promise<void>;
  url(): string;
  read(hints: Hints): Promise<string>;
  has(hints: Hints, withinMs?: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
  scroll(dy: number): Promise<void>;
  /** hover, click or press only; the caller decides it changes the page, not the site. */
  act(op: Op, hints: Hints): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserFlow<I, O> {
  site: Site;
  /** Unique per site; names the trace files and the fake in tests. */
  name: string;
  /** How it reaches its data; a laddered read's rungs in order (`browser/ladder`). On the route's row; the gates require it (U5). */
  strategies?: readonly Strategy[];
  /** The flow puts a secret on screen (a minted token): no screenshot, trace or step watch keeps it. */
  secret?: boolean;
  /**
   * A read no person takes over (a search, an open page): on a Mac its headed window is
   * hidden while it runs (`Session.offscreen`). The next flow without it shows the window again.
   */
  offscreen?: true;
  /**
   * false: no Playwright trace. For a flow that lasts hours (explore): the trace keeps every
   * response body in the driver until the flow ends (WA-1118: 207 MB after ten page opens).
   */
  trace?: false;
  /**
   * "provider": open the profile where the site's sign-in provider holds the
   * session (William's LinkedIn signs in by Google, in the `google` profile),
   * the one `autobrowse login` keeps warm. The site's own profile otherwise.
   */
  profile?: "provider";
  /**
   * Reads only: runs beside other reads on the profile, in its own tab (`ProfilePool`, U15).
   * Absent: a write, alone on the profile. A route's GET leg gets it from the facade.
   */
  reads?: true;
  run(fp: FlowPage, input: I): Promise<O>;
  /**
   * Env names the run makes a new value for and keeps. The runner asks before the first act
   * when one holds a value (`settleKeeps`). A flow that reads a value the site already has
   * names none: the store's own refusal covers it, and nothing is lost.
   */
  keeps?(input: I): readonly string[];
  /**
   * The part of `run` safe to do before anyone says yes: open the page, find the box. Armed
   * (`sites/arm`), it runs early in its own tab; the call then runs `run` there, and `run`'s
   * own opening finds the page already open. Never types, clicks or sends.
   */
  prepare?(fp: FlowPage, input: I): Promise<void>;
}

export function defineFlow<I, O>(flow: BrowserFlow<I, O>): BrowserFlow<I, O> {
  return flow;
}

export interface FlowRunner {
  /** `on`: run in this tab (an armed one, `tab`) instead of the browser's own page, kept as it is. */
  run<I, O>(flow: BrowserFlow<I, O>, input: I, on?: { page: Page }): Promise<O>;
  /**
   * A new tab in `site`'s browser (a profile name: `linkedin@wren`) that outlives the runs on it:
   * the browser stays open, pinned in the park, until `release`. Flows on the profile still
   * queue and run beside it. Absent without a park.
   */
  tab?(site: string): Promise<HeldTab>;
}

export interface HeldTab {
  page: Page;
  /** The browser is the person's own: nothing context-wide or page-routed is done to it. */
  shared: boolean;
  /** Close the tab and let the browser idle out again. */
  release(): Promise<void>;
}

/**
 * The browser leg broke under the flow (Chrome died, the network went
 * away, the CDP socket closed). Nothing about the site or the flow is
 * wrong, so the host retries the whole flow with a fresh session.
 */
export class FlowInterrupted extends Error {
  readonly artifacts: Artifacts;
  constructor(flow: string, cause: unknown, artifacts: Artifacts) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.artifacts = artifacts;
    this.name = "FlowInterrupted";
  }
}

const TRANSIENT =
  /target (page|context|browser) has been closed|browser has been closed|target closed|connection closed|websocket|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|REFUSED)|NAME_NOT_RESOLVED|TIMED_OUT|ADDRESS_UNREACHABLE)|browser process (crashed|exited)|Protocol error.*(Target|Session) closed/i;

/** Sleep, a dropped network, a crashed or closed browser: retry, do not fail. */
/** Chrome's own error page (no internet, DNS gone): the leg is down, whatever the flow was doing. */
export const OFFLINE_PAGE = /^chrome-error:\/\//;

export function isTransientBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT.test(msg);
}

/** A flow threw something other than NeedsHuman; the artifacts say where. */
export class FlowFailed extends Error {
  readonly artifacts: Artifacts;
  constructor(flow: string, cause: unknown, artifacts: Artifacts) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.artifacts = artifacts;
    this.name = "FlowFailed";
  }
}

export interface RunnerOptions {
  repairer?: Repairer;
  /**
   * A headless run that met a person's step (`fp.person`) runs once more in the browser these
   * options open: by default the same one, headed, where this machine has a screen. A run
   * that already sent something, or runs in an armed tab, is never run again. false: never.
   */
  person?: false | ((opts: BrowserOptions) => BrowserOptions);
  /**
   * The page-call log's caps (`browser/network`); a flow's short log by default. An explore
   * session keeps more, and sets `on` (capture there by default, WA-1251.4).
   */
  network?: { maxRows: number; maxBodyBytes: number; on?: boolean };
  /**
   * How a person's hands would do each act (`browser/human`): a pause to
   * read, a curved reach, typing in runs. On by default; null is instant
   * (tests, demos).
   */
  pace?: Pace | null;
  /** Every run's motion seed, to replay a run's moves (`AUTOBROWSE_SEED`). Absent: fresh per run, kept in its row. */
  seed?: number;
  /**
   * Solves a login wall for a site: "signed-in" to retry the open,
   * anything else to hand off. Absent = every wall is a person's.
   */
  login?: (
    fp: FlowPage,
    site: Site,
    /** Whose sign-in it is, when the caller knows: picks the `<site>@<label>` credential for it. */
    account?: string,
  ) => Promise<"signed-in" | "no-credential" | "unknown-site">;
  /**
   * A captcha wall is solved before it goes to a person: checkboxes by the
   * hands alone, pictures when `eyes` is given (a model that sees). Absent =
   * every captcha is a person's. `attempts` whole solves before that
   * (`CAPTCHA_ATTEMPTS`, default 3; 0 = straight to a person).
   */
  captcha?: { eyes: Eyes | readonly Eyes[] | null; attempts?: number };
  /** Repair misses on irreversible acts too (the `irreversible` guard is off). */
  repairIrreversible?: boolean;
  /** Every repair, tried or not, so the flow's source can be fixed for good. */
  onRepair?: (report: RepairReport) => void;
  /** Repairs that worked, tried before the source's own hints on the next run (`browser/fixes`). */
  fixes?: Fixes;
  /** Pages seen before on each site and what worked on them: walks' screens, clicks past interrupts (`browser/screens`). */
  learnedScreens?: LearnedScreens;
  /** Names a page a walk does not know, from the walk's own screens. Absent = such a page fails the walk. */
  screenReader?: ScreenReader | null;
  /** Irreversible acts a durable call already did: a retry never does them twice (`browser/attempt`). */
  done?: DoneActs;
  /** `code`'s saved calls and acts per durable call: a retry goes on where the last try ended (`fileCodeStores`). */
  codeStores?: (call: string, scope: string) => CodeStore;
  /** Every failure record written (kind failed/human/interrupted): what healing starts from. */
  onFailure?: (record: FailureRecord, file: string) => void;
  /** The profile's one browser, shared with the renderer; built from `park` when absent (U15). */
  pool?: ProfilePool;
  /**
   * Keep each run's browser for the next run on the same site instead of
   * closing it: a gate or a hand-off between two steps keeps the page.
   * Only for a long-lived worker; a one-shot CLI would never exit.
   */
  park?: SessionPark;
  /**
   * The flows to watch step by step (`WATCH_FLOWS`: `all`, a site, or
   * `site/flow`, comma separated): a masked screenshot and the aria tree per
   * step, and the trace kept even when the run works (`browser/watch`).
   */
  watch?: string;
  /**
   * Draw the panel and a box on each act's control (`explore/overlay`), a native
   * window over Chrome's, for a person who watches. Off by default; never on a
   * secret flow or the person's own browser.
   */
  overlay?: boolean;
  /** The overlay's window; default the native host (tests inject one). */
  overlayHost?: OverlayDeps["host"];
  /**
   * One line per run, success or not (`runs/flows`): outcome, time, acts,
   * captcha tries, model tokens. Absent = the stats dir (`deps/stats`,
   * `~/.config/autobrowse/flows`, read by `autobrowse stats success`); null = none.
   */
  runs?: FlowRuns | null;
  /**
   * Where a keyed run (`withCall`) stopped, so the next try of the same call opens that page
   * and its walks go on from there (`browser/resume`). Absent = files in the owner's state dir
   * (`deps/stats`, `~/.config/autobrowse/resume`); false = every try starts at step 1.
   */
  resume?: Resumes | false;
}
