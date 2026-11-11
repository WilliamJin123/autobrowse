/**
 * A browser flow is a typed function over a logged-in page: input in,
 * result out, `NeedsHuman` when a person must step in. The runner around
 * it is the same for every flow: one session per run, one flow per site at
 * a time (a profile cannot be open twice), a Playwright trace of every run
 * that goes wrong, a screenshot on the way out. A step that runs a flow
 * still proves the result through an API read afterwards where one exists;
 * the trace is for the person, the API read is for the machine.
 *
 * Flows are transcribed from recordings (`autobrowse record <site> --flow
 * <name>` runs Playwright codegen on the site's profile). The recording is
 * raw and may hold typed secrets; it stays out of git. What goes in is the
 * typed flow with visible-label selectors, so a redesign fails loudly.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { resumeDir, statsDirOf } from "../deps/stats.js";
// Explore's panel; moves to browser/ once its open peer edit lands.
import type { Command } from "../explore/commands.js";
import { overlayFor, traceRow } from "../explore/overlay.js";
import { expandHome } from "../google/auth.js";
import { tallied } from "../llm/ledger.js";
import { redactAria, redactText } from "../recorder/redact.js";
import { type CaptchaSolve, type FlowOutcome, fileFlowRuns } from "../runs/flows.js";
import { shareOff, shareTrace } from "../share/share.js";
import { failureShape, firstTraceOfShape } from "../shots/traces.js";
import { currentCall, currentReach, markBanned, markReached, markSubmitted } from "./attempt.js";
import { banHit } from "./ban-signals.js";
import { type CaptchaOutcome, solveCaptcha } from "./captcha/index.js";
import { cardMask } from "./card-mask.js";
import { collectWhenIdle } from "./driver-memory.js";
import { filmLog, filmStep } from "./film.js";
import { flowKey } from "./fixes.js";
import { freshSeed, HUMAN_PACE, handsFor, seeded } from "./human/index.js";
import { asQuestion, settleKeeps } from "./keeps.js";
import { type Hints, locate, textOf } from "./locate.js";
import { htmlForFile, NetLog, networkOn } from "./network.js";
import { describePage } from "./page-state.js";
import type { SessionPark } from "./park.js";
import { type PoolMode, ProfilePool, poolTabs } from "./profile-pool.js";
import { COMMITTING, canLearn, noRepairer, type RepairReport, snapshotPage } from "./repair.js";
import { fileResumes, keptUrl, sameHost } from "./resume.js";
import {
  INTERRUPTS,
  isOn,
  keepOf,
  lookAt,
  memoryScreens,
  type PageLook,
  type Screen,
  type ScreenHelp,
  type Trail,
} from "./screens.js";
import { holdsSecret } from "./secrets.js";
import {
  AccessRefused,
  type Artifacts,
  type BrowserOptions,
  bodyText,
  type FailureRecord,
  looksLikeWall,
  NeedsHuman,
  openSession,
  pageHtml,
  type Session,
} from "./session.js";
import { scrubSecretsFile } from "./trace-secrets.js";
import { type Watch, watches, watchSteps } from "./watch.js";

/** Calls a flow's log keeps, and their body bytes. */
const FLOW_NET_ROWS = 300;
const FLOW_NET_BYTES = 8 * 1024 * 1024;

export * from "./flow-api.js";

import { NetRefused } from "../reach/net-guard.js";
import {
  type BrowserFlow,
  FlowFailed,
  FlowInterrupted,
  type FlowPage,
  type FlowRunner,
  type HeldTab,
  isTransientBrowserError,
  OFFLINE_PAGE,
  type Op,
  type OpenOptions,
  pageWide,
  type RunnerOptions,
} from "./flow-api.js";
import {
  ACT_TIMEOUT_MS,
  backgroundPage,
  closeStrayTabs,
  doOp,
  keptTabs,
  MAX_DETOURS,
  openReadTab,
  PERSON_MS,
  POLL_MS,
  runRow,
  SETTLE_MS,
  samePage,
  seedOf,
  settle,
  solveRow,
} from "./flow-steps.js";

export { chooseOption, closeStrayTabs, openReadTab, seedOf } from "./flow-steps.js";

const PERSON_POLL_MS = 2_000;

const writeOf = <I, O>({ reads: _, ...flow }: BrowserFlow<I, O>): BrowserFlow<I, O> => flow;

/** A shared read met a sign-in: the runner runs it again as a write, alone on the profile. */
class SignInAlone extends Error {
  constructor() {
    super("sign-in needs the profile alone");
    this.name = "SignInAlone";
  }
}

/**
 * The pool flows and the renderer share (U15): a joined read gets a background tab; the last
 * user out closes stray tabs (unless one waits on a person) and drops the run's route stubs.
 */
export function browserPool(park?: SessionPark): ProfilePool {
  return new ProfilePool({
    park,
    newTab: (s) => backgroundPage(s.context, s.page),
    tidy: async (s, o) => {
      if (!o.keepTabs && !s.shared) await closeStrayTabs(s.context, s.page);
      // Stubs from `answer` belong to the runs that ended.
      await s.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    },
  });
}

export function flowRunner(opts: BrowserOptions, runner: RunnerOptions = {}): FlowRunner {
  const artifactsDir = expandHome(opts.artifactsDir);
  const pool = runner.pool ?? browserPool(runner.park);
  const repairer = runner.repairer ?? noRepairer;
  // A filmed page hears every act (`browser/film`); the rest drop it. Hands per run, on that
  // run's seed: runs on two profiles at once never share a stream.
  const pace = runner.pace === undefined ? HUMAN_PACE : runner.pace;
  const fixedSeed = runner.seed ?? seedOf();
  const handsOn = (seed: number) => handsFor(pace, seeded(seed), filmLog, holdsSecret);
  const park = runner.park;
  const runsDir = runner.runs === undefined ? statsDirOf("flows") : null;
  const runs = runner.runs ?? (runsDir ? fileFlowRuns(runsDir) : null);
  const resumesDir = runner.resume === undefined ? resumeDir() : null;
  const resumes =
    runner.resume === false
      ? null
      : (runner.resume ?? (resumesDir ? fileResumes(resumesDir) : null));
  const tab = park
    ? async (site: string): Promise<HeldTab> => {
        const asked = opts.profile ?? site;
        const key = (await opts.profileName?.(asked)) ?? asked;
        // Brief: a write that only opens the tab; the tab outlives it, kept from tidying.
        return pool.use(
          key,
          "write",
          () => openSession(site, opts),
          async ({ session }, leave) => {
            leave({ keepTabs: true });
            park.pin(key);
            try {
              const page = await session.context.newPage();
              keptTabs.add(page);
              let released = false;
              return {
                page,
                shared: session.shared === true,
                release: async () => {
                  if (released) return;
                  released = true;
                  await page.close().catch(() => undefined);
                  park.unpin(key);
                },
              };
            } catch (err) {
              park.unpin(key);
              throw err;
            }
          },
        );
      }
    : undefined;
  const HAS_SCREEN = process.platform === "darwin" || !!process.env.DISPLAY;
  const inWindow =
    runner.person === false
      ? null
      : (runner.person ??
        (HAS_SCREEN && opts.tier === "local" && !opts.film
          ? (o: BrowserOptions): BrowserOptions => ({ ...o, headless: false })
          : null));
  return {
    ...(tab ? { tab } : {}),
    run: async (flow, input, on) => {
      try {
        return await runOnce(flow, input, on, false);
      } catch (err) {
        // A read at a sign-in wall: again alone, so one run on the profile signs in (U15).
        if (err instanceof SignInAlone) return runOnce(writeOf(flow), input, on, false);
        if (!(err instanceof NeedsHuman) || !err.person || !inWindow || on) throw err;
        return runOnce(flow, input, on, true);
      }
    },
  };
  async function runOnce<I, O>(
    flow: BrowserFlow<I, O>,
    input: I,
    on: { page: Page } | undefined,
    /** The run a person answers: its own headed browser, closed after. */
    withPerson: boolean,
  ): Promise<O> {
    {
      const sessionOpts = withPerson && inWindow ? inWindow(opts) : opts;
      const profile =
        flow.profile === "provider" ? ((await opts.providerProfile?.(flow.site)) ?? null) : null;
      // A profile opens once: everything that lands on one Chrome profile shares one queue and
      // one parked browser. A flow under its site (`reddit`) and under its account's profile
      // (`reddit@wren`, the sites facade) resolve to the same profile, as openSession does.
      const asked = profile ?? opts.profile ?? flow.site;
      const key = (await opts.profileName?.(asked)) ?? asked;
      // Reads share the profile's browser, each in its own tab; a write, or a person's run, is alone.
      const mode: PoolMode = flow.reads && !withPerson ? "read" : "write";
      // Opening the browser is the first thing the network or the machine can break.
      const opening = Date.now();
      const open = () =>
        openSession(flow.site, profile ? { ...sessionOpts, profile } : sessionOpts).catch(
          (err: unknown) => {
            const transient = isTransientBrowserError(err);
            // A run that never got a browser is still a run: the row says it broke here.
            runs?.record(
              runRow(flow, opening, {
                outcome: err instanceof NeedsHuman ? "human" : transient ? "interrupted" : "failed",
                submitted: false,
                goal: "open the browser",
                error: redactText(err instanceof Error ? err.message : String(err)),
                acts: 0,
                captchaTries: 0,
                captchaSolved: null,
                llmCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
              }),
            );
            if (transient) throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, {});
            throw err;
          },
        );
      // the parked browser has no window: a person's run opens its own on the profile
      return pool.use(
        key,
        mode,
        open,
        async (lease, leave) => {
          const held = lease.session;
          // A joined read leaves the window as the owner set it.
          if (lease.owner) await held.offscreen?.(flow.offscreen === true);
          // An armed tab, or a joined read's own tab, stands in for the browser's page.
          const armed = on && !on.page.isClosed() ? on.page : null;
          const own = armed ?? (lease.owner ? null : lease.page);
          const session: Session = own
            ? (Object.create(held, { page: { value: own } }) as Session)
            : held;
          // A kept browser already on the page the flow opens first stays put:
          // reloading would lose what the last run left there (a form, a list, an armed reply box).
          let keepPage = lease.reused || armed !== null;
          // A flow keeps a short log: enough to see the call that broke, not a session's worth.
          // Off by default (`networkOn`); explore turns it on.
          const network =
            (runner.network?.on ?? networkOn())
              ? NetLog.of(session.context, {
                  site: key,
                  maxRows: runner.network?.maxRows ?? FLOW_NET_ROWS,
                  maxBodyBytes: runner.network?.maxBodyBytes ?? FLOW_NET_BYTES,
                })
              : undefined;
          let broken = false;
          const stamp = `${flow.site}-${flow.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          let lastGoal: string | null = null;
          const call = currentCall();
          // Where an earlier try of this call stopped, on this profile: its first open goes there.
          const saved = call && resumes ? resumes.get(call) : null;
          const resume = saved?.profile === key ? saved : null;
          let resumeTo = resume?.url ?? null;
          let resumed = false;
          let firstOpen: string | null = null;
          const screensDone: Record<string, string[]> = structuredClone(resume?.screensDone ?? {});
          const trail: Trail = {
            before: (w) => resume?.screensDone[w] ?? [],
            passed: (w, screen) => {
              screensDone[w] = [...(screensDone[w] ?? []), screen];
            },
          };
          // What the last act or read looked for: a heal finds the one op that broke by it.
          let lastHints: Hints | null = null;
          let acts = 0;
          let actsBefore = 0;
          mkdirSync(artifactsDir, { recursive: true });
          // Tracing is best effort: a CDP-attached context may refuse it. Never
          // in the person's own browser: it would film their other tabs. A filmed
          // session's frames are the film's: a page has one screencast, and its first client sets the size.
          // One trace per context: a joined read records none.
          const tracing =
            lease.owner &&
            flow.trace !== false &&
            !flow.secret &&
            !session.shared &&
            (await session.context.tracing
              .start({ screenshots: !session.filmed, snapshots: true })
              .then(() => true)
              .catch(() => false));
          let signingIn = false;
          let triedCaptcha = false;
          let captchaTries = 0;
          let captchaSolved: boolean | null = null;
          const captchas: CaptchaSolve[] = [];
          const startedAt = Date.now();
          const seed = fixedSeed ?? freshSeed();
          const hands = handsOn(seed);
          let outcome: FlowOutcome = "ok";
          let failure: string | null = null;
          // the failure record's path, for the run row (U19)
          let failureFile: string | null = null;
          // Provisional until the run ends ok: a repair that clicked the wrong control fails later.
          const repaired: { report: RepairReport; passed: { look: PageLook; reason: string }[] }[] =
            [];
          const fixesUsed: { goal: string; hints: Hints }[] = [];
          let submitted = false;
          let active = session.page;
          const overlay = overlayFor(
            runner.overlay === true && !flow.secret && !session.shared && lease.owner,
            runner.overlayHost ? { host: runner.overlayHost } : {},
          );
          // A new document: its boxes go, any tab.
          const redraw = (p: Page) => void overlay.loaded(p);
          const onPage = (p: Page) => p.on("load", redraw);
          if (overlay.enabled) {
            for (const p of session.context.pages()) onPage(p);
            session.context.on("page", onPage);
            overlay.tag(`seed ${seed}`);
            await overlay.set(active, { goal: `${flow.site}/${flow.name}` });
          }
          /** One trace row per step: the act's box pulses first; never a typed value. */
          const shown = async <T>(
            s: { kind: string; goal: string; op?: string; hints?: Hints; url?: string },
            run: () => Promise<T>,
            answer?: (r: T) => unknown,
          ): Promise<T> => {
            // A film gets the rows, never the drawn layer.
            const filmed = session.filmed === true && !flow.secret;
            if (!overlay.enabled && !filmed) return run();
            const page = active;
            const from = page.url();
            const started = Date.now();
            const cmd = s.op ?? s.kind;
            // An open's goal holds the whole URL: the row shows its host and path only.
            const c = { cmd, hints: s.hints, url: s.url, ...(s.url ? {} : { goal: s.goal }) };
            await overlay.begin(page, cmd);
            if (s.hints) await overlay.flash(page, s.hints, `${cmd}: ${s.goal}`);
            let failed: unknown = null;
            let got: T | undefined;
            try {
              got = await run();
              return got;
            } catch (err) {
              failed = err;
              throw err;
            } finally {
              await overlay.after(active);
              const row = traceRow(c as unknown as Command, failed, Date.now() - started, {
                from,
                to: active.url(),
                ...(answer && got !== undefined ? { answer: answer(got) } : {}),
              });
              await overlay.end(active, row);
              if (filmed) {
                const { cmd, what, ok, ms, note } = row;
                filmStep(page, { kind: "step", t: started, cmd, what, ok, ms, note });
              }
            }
          };
          const learned = runner.learnedScreens ?? memoryScreens();
          const help: ScreenHelp = {
            look: () => lookAt(active),
            snapshot: () => snapshotPage(active),
            learned,
            reader: runner.screenReader ?? null,
            trail,
          };
          // The URL whose overlays were last looked for: once per page, not per act.
          let overlaysAt: string | null = null;
          const watch: Watch | null =
            !flow.secret && watches(runner.watch ?? opts.watchFlows, flow.site, flow.name)
              ? watchSteps(join(artifactsDir, stamp))
              : null;
          const stepped = <T>(
            s: Parameters<Watch["step"]>[0] & { url?: string },
            run: () => Promise<T>,
            outcome?: (r: T) => "ok" | "repaired" | "failed",
          ): Promise<T> => {
            // The ledger keeps the redacted goal, never the raw url.
            const { url: _, ...step } = s;
            return shown(s, () => (watch ? watch.step(step, () => active, run, outcome) : run()));
          };
          const fp: FlowPage = {
            get page() {
              return active;
            },
            open: (url, o = {}) =>
              stepped({ kind: "open", goal: `open ${url}`, url }, () => openPage(url, o)),
            url: () => active.url(),
            text: () => bodyText(active, 20_000),
            html: () => pageHtml(active, 400_000),
            has: async (hints, withinMs = 0) => {
              // A wait handles what shows up in the way, as an act's does: a
              // guard like "the dialog opened, else a person" never misses its
              // control behind a banner or a screen learned on this site.
              if (withinMs > 0)
                await clearWay(hints, { kind: "click" }, lastGoal ?? "wait", withinMs).catch(
                  () => undefined,
                );
              return locate(active, hints)
                .first()
                .isVisible()
                .catch(() => false);
            },
            read: async (hints) => {
              lastHints = hints;
              actsBefore = acts++;
              markReached();
              return shown(
                { kind: "read", goal: "read", hints },
                async () => (await textOf(locate(active, hints))).slice(0, 2_000),
                (text) => ({ as: "text", text }),
              );
            },
            wait: (ms) => active.waitForTimeout(ms),
            answer: (prefix, body) =>
              session.context
                .route(
                  (u) => u.toString().startsWith(prefix),
                  (r) => r.fulfill({ status: 200, contentType: "text/plain", body }),
                )
                .then(() => {}),
            waitForUrl: (pattern, timeout) =>
              active
                .waitForURL(pattern instanceof RegExp ? pattern : (u) => pattern(u.toString()), {
                  timeout,
                })
                .then(
                  () => true,
                  () => false,
                ),
            nextPage: (timeout) =>
              session.context
                .waitForEvent("page", { timeout, predicate: (p) => !poolTabs.has(p) })
                .catch(() => null),
            // Hands between steps: the panel lets them through.
            scroll: (dy) => hands.scroll(active, dy),
            pages: () => session.context.pages(),
            switchTo(page) {
              active = page;
            },
            async act(op, hints, a) {
              lastGoal = a.goal;
              lastHints = hints;
              actsBefore = acts++;
              // Kept after the flow succeeds too: a step that runs two flows replays the first when the second breaks.
              const once =
                a.irreversible && call && runner.done
                  ? `${flow.site}/${flow.name} ${actsBefore} ${a.goal}`
                  : null;
              // The send starts here: a failure from now on may have gone through (`attempt.ts`).
              if (a.irreversible) {
                markSubmitted();
                submitted = true;
              }
              if (once && runner.done?.has(call as string, once))
                throw new NeedsHuman(
                  `${flow.site}: "${a.goal}" already went through on an earlier try of this step; check it before running again`,
                );
              await stepped(
                { kind: "act", goal: a.goal, op: op.kind, hints },
                () => actOnce(op, hints, a),
                (how) => how,
              );
              if (once) runner.done?.add(call as string, once);
            },
            async signIn(site, account) {
              if (!runner.login || signingIn) return "no-login";
              if (mode === "read") throw new SignInAlone();
              signingIn = true;
              try {
                return await stepped(
                  { kind: "sign-in", goal: `sign in to ${site ?? flow.site}` },
                  () =>
                    (runner.login as NonNullable<RunnerOptions["login"]>)(
                      fp,
                      site ?? flow.site,
                      account,
                    ),
                );
              } finally {
                signingIn = false;
              }
            },
            captcha: () =>
              stepped(
                { kind: "captcha", goal: "solve the captcha" },
                () => solveWithRetries(),
                (got) => (got.solved ? "ok" : "failed"),
              ),
            newIp: () =>
              stepped(
                { kind: "new-ip", goal: "get a new IP from the exit" },
                async () => (await session.newIp?.()) ?? false,
                (got) => (got ? "ok" : "failed"),
              ),
            codeStore: (scope) =>
              call && runner.codeStores ? runner.codeStores(call, scope) : null,
            human(reason) {
              throw new NeedsHuman(`${flow.site}: ${reason}`);
            },
            async person(reason, gone, ms = PERSON_MS) {
              const why = `${flow.site}: ${reason}`;
              // A joined read never holds the window: it runs again alone, with a person.
              if ((!withPerson && sessionOpts.headless !== false) || !lease.owner) {
                const err = new NeedsHuman(why);
                err.person = true;
                throw err;
              }
              await held.offscreen?.(false);
              await session.page.bringToFront().catch(() => undefined);
              for (let t = 0; t < ms; t += PERSON_POLL_MS) {
                await session.page.waitForTimeout(PERSON_POLL_MS).catch(() => undefined);
                if (session.page.isClosed() || (await gone().catch(() => false))) return;
              }
              throw new NeedsHuman(`${why} (no answer in ${Math.round(ms / 60_000)} min)`);
            },
            passkeys: session.passkeys,
            ...(network ? { network } : {}),
            screens: help,
            readTab: () => openReadTab(session.context, session.page, hands),
            readTabs: opts.readTabs ?? 3,
          };
          /** An interrupt the page shows now: a coded one, else a click learned on this site. */
          async function interruptHere(overlaysOnly: boolean): Promise<Screen | null> {
            for (const s of INTERRUPTS)
              if ((!overlaysOnly || s.overlay) && (await isOn(s, { fp }))) return s;
            if (overlaysOnly || !learned.has(flow.site)) return null;
            const row = learned.find(flow.site, null, await lookAt(active));
            const click = row?.click;
            if (!row || !click) return null;
            return {
              name: `learned click on ${row.url}`,
              looks: row.reason,
              is: async () => true,
              act: () =>
                doOp(active, click, { kind: "click" }, ACT_TIMEOUT_MS, hands).then(
                  () => learned.used(row),
                  (err: unknown) => {
                    learned.drop(row);
                    throw err;
                  },
                ),
            };
          }
          /**
           * Handle an interrupt; false when its handler failed. Its clicks are
           * not the flow's acts: they neither count (an irreversible act is
           * known by its place in the flow) nor take the step's goal.
           */
          async function handle(s: Screen, goal: string, hints: Hints): Promise<boolean> {
            const bare: FlowPage = {
              ...fp,
              page: active,
              act: (op, h) => doOp(active, h, op, ACT_TIMEOUT_MS, hands),
            };
            const ok = await (s.act?.({ fp: bare }) ?? Promise.resolve()).then(
              () => true,
              () => false,
            );
            lastGoal = goal;
            lastHints = hints;
            return ok;
          }
          /**
           * Before an act: wait for its control, handling what shows up in the
           * way. An overlay (a cookie banner) is looked for once per page even
           * when the control shows. Returns the time left for the act.
           */
          async function clearWay(hints: Hints, op: Op, goal: string, timeout: number) {
            const start = Date.now();
            const url = active.url();
            if (url !== overlaysAt) {
              overlaysAt = url;
              const s = await interruptHere(true);
              if (s) await handle(s, goal, hints);
            }
            // A file input is hidden on purpose; a page-wide script has no target.
            if (op.kind === "upload" || (op.kind === "script" && pageWide(hints))) return timeout;
            let target: Locator;
            try {
              target = locate(active, hints);
            } catch {
              return timeout;
            }
            let handled = 0;
            let seen = false;
            while (Date.now() - start < timeout) {
              seen = await target.isVisible().catch(() => false);
              if (seen) break;
              const s = handled < MAX_DETOURS ? await interruptHere(false) : null;
              if (s) {
                handled += 1;
                await handle(s, goal, hints);
                continue;
              }
              await active.waitForTimeout(POLL_MS);
            }
            // Never shown: say so, with the page, instead of a 1 s act that fails with Playwright's words.
            // A script may run on a hidden element, so it still gets its try.
            if (!seen && op.kind !== "script")
              throw new Error(
                `${goal}: ${JSON.stringify(hints)} not visible after ${Math.round(timeout / 1000)} s (${describePage(url, await bodyText(active, 600))})`,
              );
            return Math.max(timeout - (Date.now() - start), 1_000);
          }
          /** One act: the recorded locator, else the repairer's; "repaired" when the second found it. */
          async function actOnce(
            op: Op,
            hints: Hints,
            a: Parameters<FlowPage["act"]>[2],
          ): Promise<"ok" | "repaired"> {
            const timeout = a.timeoutMs ?? ACT_TIMEOUT_MS;
            const page = active;
            const mayRepair = !a.irreversible || runner.repairIrreversible;
            // A kept fix first: the source's hints are known stale, so no wait on them and no model.
            const key = flowKey(flow.site, flow.name);
            const fix = mayRepair ? (runner.fixes?.find(key, a.goal, hints) ?? null) : null;
            if (fix) {
              try {
                for (const d of fix.detours) await doOp(page, d, { kind: "click" }, timeout, hands);
                await doOp(page, fix.hints, op, timeout, hands);
                fixesUsed.push({ goal: a.goal, hints });
                return "repaired";
              } catch {
                // The page moved again (or back): drop it and go the long way.
                runner.fixes?.drop(key, a.goal, hints);
              }
            }
            try {
              await doOp(page, hints, op, await clearWay(hints, op, a.goal, timeout), hands);
              return "ok";
            } catch (err) {
              if (!mayRepair)
                throw new NeedsHuman(`${flow.site}: ${a.goal} (irreversible, not repaired)`);
              // Something on top that came late: handled, then the op once more.
              const late = await interruptHere(false);
              if (late && (await handle(late, a.goal, hints)))
                try {
                  await doOp(page, hints, op, timeout, hands);
                  return "ok";
                } catch {
                  // the long way
                }
              // On the live page, from where the run is: a few clicks past what is in
              // the way, then the op. The run goes on from there; nothing replays.
              const detours: Hints[] = [];
              const passed: { look: PageLook; reason: string }[] = [];
              for (;;) {
                const proposal = await repairer.propose({
                  site: flow.site,
                  goal: a.goal,
                  failed: hints,
                  url: page.url(),
                  snapshot: await snapshotPage(page),
                  ...(detours.length ? { detours } : {}),
                });
                if (!proposal) throw err;
                if (proposal.detour) {
                  const name = `${proposal.hints.name ?? ""} ${proposal.hints.text ?? ""}`;
                  if (detours.length >= MAX_DETOURS || COMMITTING.test(name)) throw err;
                  const look = await lookAt(page);
                  await doOp(page, proposal.hints, { kind: "click" }, timeout, hands);
                  detours.push(proposal.hints);
                  passed.push({ look, reason: proposal.reason });
                  continue;
                }
                const report: RepairReport = {
                  ...proposal,
                  ...(detours.length ? { detours } : {}),
                  site: flow.site,
                  flow: `${flow.site}/${flow.name}`,
                  goal: a.goal,
                  failed: hints,
                  url: page.url(),
                  ok: false,
                };
                try {
                  await doOp(page, proposal.hints, op, timeout, hands);
                  report.ok = true;
                  repaired.push({ report, passed });
                } finally {
                  runner.onRepair?.(report);
                }
                return "repaired";
              }
            }
          }
          async function solveWithRetries(): Promise<CaptchaOutcome> {
            const eyes = runner.captcha?.eyes ?? null;
            const attempts = runner.captcha?.attempts ?? 3;
            let got: CaptchaOutcome = {
              solved: false,
              kind: null,
              vendor: null,
              reason: "captcha attempts are 0 (CAPTCHA_ATTEMPTS)",
            };
            for (let n = 1; n <= attempts; n++) {
              const t0 = Date.now();
              got = await solveCaptcha(active, { hands, eyes });
              if (got.kind) {
                captchaTries++;
                captchaSolved = got.solved;
                captchas.push(solveRow(got, active.url(), Date.now() - t0));
              }
              // Nothing there, or a picture with no eyes: another try would say the same.
              if (got.solved || !got.kind || (!eyes && got.kind !== "checkbox")) break;
            }
            return got;
          }
          async function openPage(asked: string, o: OpenOptions): Promise<void> {
            active = session.page;
            firstOpen ??= asked;
            // The first open of a resumed try goes where the last try stopped, on the same site.
            const url = resumeTo && sameHost(resumeTo, asked) ? resumeTo : asked;
            resumed ||= url !== asked;
            resumeTo = null;
            // A kept tab already on the saved page stays: its query may hold what the saved URL drops.
            const stay =
              keepPage &&
              (samePage(session.page.url(), url) ||
                (url !== asked && keptUrl(session.page.url(), null) === keptUrl(url, null)));
            keepPage = false;
            if (!stay) await settle(session.page, url);
            if (OFFLINE_PAGE.test(session.page.url()))
              throw new Error(`net::ERR_INTERNET_DISCONNECTED opening ${url}`);
            if (o.allowWall) return;
            // Twice: a security page asks for the password again right after a sign-in.
            for (let attempt = 1; ; attempt++) {
              const wall = await looksLikeWall(session.page);
              if (!wall) return;
              // Signed in, yet the page still asks: say what it shows, not just "a login page".
              const after =
                attempt > 1
                  ? ` after a sign-in that reported success (${describePage(session.page.url(), await session.page.innerText("body").catch(() => ""))}); if that is the login page itself, store a page behind it as the credential's url`
                  : "";
              if (wall.kind === "captcha" && runner.captcha && !triedCaptcha) {
                triedCaptcha = true;
                const got = await fp.captcha();
                // The detector saw none: the word is the page's content (a story about captchas), not a wall.
                if (!got.solved && got.kind === null) return;
                if (got.solved) {
                  // A checkbox wall lets the page through on its own (Cloudflare reloads it).
                  await session.page
                    .waitForLoadState("networkidle", { timeout: SETTLE_MS })
                    .catch(() => undefined);
                  continue;
                }
                throw new NeedsHuman(`${flow.site}: captcha (${got.reason})${after}`, "captcha");
              }
              // a guess on the first look: the caller judges it; after a sign-in, any wall is a miss
              if (
                o.signIn === "url" &&
                wall.by === "text" &&
                wall.kind !== "captcha" &&
                attempt === 1
              )
                return;
              if (wall.kind === "captcha" || !runner.login || signingIn || attempt > 2)
                throw new NeedsHuman(`${flow.site}: ${wall.detail}${after}`, wall.kind);
              if (mode === "read") throw new SignInAlone();
              signingIn = true;
              try {
                const login = runner.login;
                const outcome = await stepped(
                  { kind: "sign-in", goal: `sign in to ${flow.site}` },
                  () => login(fp, flow.site),
                );
                if (outcome !== "signed-in")
                  throw new NeedsHuman(`${flow.site}: ${wall.detail} (${outcome})`, wall.kind);
              } finally {
                signingIn = false;
              }
              await settle(session.page, url);
            }
          }
          /**
           * Keep where this try stopped for the next try of the call. A resumed try that failed in
           * its own code without moving (same page, no new screen) drops the record instead: the
           * saved page is what broke it, so the next try starts at step 1.
           */
          function keepResume(call: string, kind: FailureRecord["kind"]): void {
            const url = keptUrl(session.page.url(), firstOpen);
            const moved =
              !resumed ||
              url !== resume?.url ||
              JSON.stringify(screensDone) !== JSON.stringify(resume?.screensDone ?? {});
            if (kind === "failed" && !moved) resumes?.clear(call);
            else if (url) resumes?.put(call, { url, profile: key, screensDone, at: Date.now() });
          }
          /** The run ended ok: its repairs and the fixes it went through are proven. */
          async function keepRepairs(): Promise<void> {
            const key = flowKey(flow.site, flow.name);
            for (const f of fixesUsed) runner.fixes?.used(key, f.goal, f.hints);
            for (const { report, passed } of repaired) {
              // Each screen clicked past is an interrupt for every flow on the site from now on.
              passed.forEach(({ look, reason }, i) => {
                learned.keep({
                  site: flow.site,
                  url: look.url,
                  landmarks: keepOf(look),
                  click: report.detours?.[i] as Hints,
                  reason,
                });
              });
              runner.fixes?.learn(report);
              if (canLearn(repairer)) await repairer.learn(report);
            }
          }
          /** The run failed in the page, not the network: the fixes it went through are suspect. */
          function dropFixes(): void {
            const key = flowKey(flow.site, flow.name);
            for (const f of fixesUsed) runner.fixes?.drop(key, f.goal, f.hints);
          }
          // Any answer to this browser came from the site, an in-page fetch too: the cap counts a try.
          // A request with no answer (offline) spends nothing.
          // Playwright fires events outside this run's async context: the call's reach is held here.
          const reach = currentReach();
          const onResponse = () => {
            if (reach) reach.reached = true;
          };
          if (reach) session.context.on("response", onResponse);
          const run = tallied(async () => {
            try {
              return await flow.run(fp, await settleKeeps(flow.keeps?.(input) ?? [], input));
            } catch (err) {
              throw asQuestion(err);
            }
          });
          try {
            const out = await run.done;
            if (call) resumes?.clear(call);
            await keepRepairs();
            return out;
          } catch (caught) {
            // not a failure: the run starts again alone
            if (caught instanceof SignInAlone) {
              outcome = "interrupted";
              failure = caught.message;
              throw caught;
            }
            let err = caught;
            // The account's own limit on the page: the whole account holds, not one bucket (U8).
            if (!(err instanceof AccessRefused) && !(err instanceof NeedsHuman && err.person)) {
              const text = await active.innerText("body", { timeout: 2_000 }).then(
                (t) => t.slice(0, 50_000),
                () => "",
              );
              const hit = banHit(flow.site, active.url(), text);
              if (hit) {
                markBanned(hit);
                err = new AccessRefused(
                  hit.kind === "limit" ? "rate_limited" : "platform_blocked",
                  `${flow.site}: the account is ${hit.kind === "limit" ? "rate limited" : hit.kind} (${hit.said}); every call for it is held`,
                );
              }
            }
            // a person is asked to look: the window comes back
            if (err instanceof NeedsHuman && lease.owner) await held.offscreen?.(false);
            const artifacts: Artifacts = watch ? { steps: watch.dir } : {};
            const shot = join(artifactsDir, `${stamp}.png`);
            if (
              !flow.secret &&
              (await session.page
                .screenshot({ path: shot, fullPage: true, mask: cardMask(session.page) })
                .then(
                  () => true,
                  () => false,
                ))
            )
              artifacts.screenshot = shot;
            // The accessibility tree next to the PNG: a reader (or a model)
            // sees every control by role and name without opening the image.
            const aria = join(artifactsDir, `${stamp}.aria.txt`);
            const tree = await session.page
              .locator("body")
              .ariaSnapshot({ timeout: 5_000 })
              .catch(() => null);
            if (tree !== null) {
              writeFileSync(aria, redactAria(`${session.page.url()}\n\n${tree}`));
              artifacts.aria = aria;
            }
            if (network && !flow.secret) {
              const calls = join(artifactsDir, `${stamp}.network.jsonl`);
              const text = network.jsonl();
              if (text) {
                writeFileSync(calls, text);
                artifacts.network = calls;
              }
              const html = await session.page.content().catch(() => null);
              if (html !== null && !network.personal) {
                const file = join(artifactsDir, `${stamp}.html`);
                writeFileSync(file, htmlForFile(html));
                artifacts.html = file;
              }
            }
            const shape = failureShape(
              flow.site,
              flow.name,
              err instanceof Error ? err.message : String(err),
            );
            if (tracing && !(await firstTraceOfShape(artifactsDir, shape))) {
              // The same failure kept a trace today: end the trace without a file.
              await session.context.tracing.stop().catch(() => undefined);
            } else if (tracing) {
              const trace = join(artifactsDir, `${stamp}.zip`);
              if (
                await session.context.tracing.stop({ path: trace }).then(
                  () => true,
                  () => false,
                )
              ) {
                artifacts.trace = trace;
                await scrubSecretsFile(trace).catch((e) =>
                  console.warn(`trace secrets not scrubbed: ${e instanceof Error ? e.message : e}`),
                );
              }
            }
            const kind: FailureRecord["kind"] =
              err instanceof NeedsHuman
                ? "human"
                : isTransientBrowserError(err) || OFFLINE_PAGE.test(active.url())
                  ? "interrupted"
                  : "failed";
            // The failure as data: `autobrowse repair <this file>` hands it to the agent.
            const record: FailureRecord = {
              site: flow.site,
              flow: flow.name,
              url: active.url(),
              goal: lastGoal,
              ...(lastHints ? { hints: lastHints, actsBefore } : {}),
              error: redactText(err instanceof Error ? err.message : String(err)),
              kind,
              at: new Date().toISOString(),
              ...(artifacts.screenshot ? { screenshot: artifacts.screenshot } : {}),
              ...(artifacts.aria ? { aria: artifacts.aria } : {}),
              ...(artifacts.network ? { network: artifacts.network } : {}),
              ...(artifacts.html ? { html: artifacts.html } : {}),
              ...(watch ? { steps: watch.dir } : {}),
            };
            outcome = kind;
            failure = record.error;
            // a network cut proves nothing either way
            if (kind !== "interrupted") dropFixes();
            if (artifacts.trace)
              await shareTrace(artifacts.trace, { site: key, flow: flow.name, outcome: kind });
            if (call && resumes) keepResume(call, kind);
            artifacts.failure = join(artifactsDir, `${stamp}.failure.json`);
            writeFileSync(artifacts.failure, JSON.stringify(record, null, 2));
            failureFile = artifacts.failure;
            runner.onFailure?.(record, artifacts.failure);
            if (err instanceof NeedsHuman) {
              err.artifacts = artifacts;
              // what was sent is sent: no second run
              if (submitted) err.person = false;
              throw err;
            }
            if (err instanceof AccessRefused) throw err;
            // the URL broke the net rules: no page changed, nothing to repair
            if (err instanceof NetRefused) throw err;
            if (kind === "interrupted") {
              broken = true;
              // an irreversible act began: a retry could send twice, so a person checks first
              if (submitted) {
                const held = new NeedsHuman(
                  `${flow.site}/${flow.name}: cut off after "${lastGoal}" began; it may have gone through. Check before running again`,
                );
                held.artifacts = artifacts;
                throw held;
              }
              throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, artifacts);
            }
            throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
          } finally {
            // a worker runs flows for days: collect between them
            collectWhenIdle();
            runs?.record(
              runRow(flow, startedAt, {
                outcome,
                submitted,
                goal: lastGoal,
                error: failure,
                acts,
                captchaTries,
                captchaSolved,
                ...(captchas.length ? { captchas } : {}),
                llmCalls: run.tally.calls,
                inputTokens: run.tally.inputTokens,
                outputTokens: run.tally.outputTokens,
                seed,
                ...(failureFile ? { failure: failureFile } : {}),
              }),
            );
            if (reach) session.context.off("response", onResponse);
            runner.fixes?.flush();
            learned.flush();
            if (overlay.enabled) {
              session.context.off("page", onPage);
              for (const p of session.context.pages()) p.off("load", redraw);
              // A parked browser serves the next run: nothing of this one stays drawn.
              if (runner.park) await overlay.remove(active);
            }
            // A watched run keeps its trace whatever happened; a failure saved one already.
            // A run that worked goes to the shared library too (`share/share`), scrubbed first.
            if (tracing) {
              const share = outcome === "ok" && !shareOff();
              const path = watch
                ? join(watch.dir, "trace.zip")
                : share
                  ? join(artifactsDir, `${stamp}.share.zip`)
                  : null;
              const saved = await session.context.tracing
                .stop(path ? { path } : undefined)
                .then(() => true)
                .catch(() => false);
              if (saved && path && share)
                await shareTrace(path, { site: key, flow: flow.name, outcome: "ok" });
              if (path && !watch) rmSync(path, { force: true });
            }
            // The pool parks or closes the browser when its last user leaves.
            // A run that waits for a person keeps every tab: the answer may need one.
            leave({
              discard: broken || withPerson,
              keepTabs: outcome === "human" || session.shared === true,
            });
          }
        },
        { fresh: withPerson },
      );
    }
  }
}
