/**
 * The worker: the engine on the local runner's file and the UI + API (:9080) in one process,
 * sharing the event bus. It dispatches the file unless the desk already does
 * (designs/2026-11-16-local-runner.md).
 */

import pino from "pino";
import { fileKeys } from "../access/keys.js";
import type { FailureRecord } from "../browser/session.js";
import { httpClient } from "../clients/http.js";
import { expandHome } from "../google/auth.js";
import { isDefaultOwner } from "../owner.js";
import { sqliteStore, startRunner } from "../runtime/index.js";
import { startUiServer } from "../ui/server.js";
import { backendFor } from "./backend.js";
import { ingress } from "./client.js";
import { opsLane } from "./ops.js";
import { awsFor, boot } from "./owner.js";
import { initSentry } from "./sentry.js";
import {
  approverFor,
  budgetOf,
  buildApp,
  gmailFor,
  keepDiskOnTimer,
  linqFor,
  llmFor,
} from "./services.js";
import { statusOf } from "./status.js";

const { root, settings } = boot();
const log = pino({ level: settings.logLevel });
const bootedAt = new Date();
const sentry = settings.sentryDsn
  ? initSentry({ dsn: settings.sentryDsn, environment: settings.sentryEnvironment })
  : null;
const app = await buildApp(settings, log);
if (sentry) {
  app.bus.subscribe((_seq, e) => void sentry.event(e));
  log.info({ environment: settings.sentryEnvironment }, "sentry on");
}
// one store for the process: the runner and this process's clients share its wake
const runnerStore = sqliteStore(expandHome(settings.runnerFile));

// The person hears once a day when the model budget is spent; `app` exists by the time any call is made.
const llm = llmFor(settings, undefined, (err) => {
  log.warn({ used: err.used, cap: err.cap }, "model budget spent");
  void app.channel.note?.(`autobrowse: ${err.message}`).catch(() => undefined);
});
const linq = linqFor(settings);
const status = statusOf(settings, {
  llm: llm?.id ?? null,
  budget: budgetOf(llm),
  memory: app.memory.id,
  workflows: (await app.workflows()).map((w) => w.name),
});
log.info(status, "autobrowse setup");
const backend = backendFor(settings, app, {
  llm,
  status,
  ingress: ingress({
    url: settings.restateIngressUrl,
    authToken: settings.restateAuthToken ?? null,
    owner: settings.owner,
    runner: runnerStore,
  }),
  ...(app.channel.note ? { notify: app.channel.note.bind(app.channel) } : {}),
});
app.doer = backend.do;
// after the doer: a queued `do` row is claimed at once
const runner = await startRunner({
  store: runnerStore,
  services: app.services,
  log: (msg, err) => log.warn({ err: err === undefined ? undefined : String(err) }, msg),
});
log.info(
  { file: settings.runnerFile, dispatching: runner.dispatching, browser: settings.browser },
  "autobrowse runner",
);
if (!approverFor(settings, gmailFor(settings))) {
  log.warn("no channel a person can answer on: payment steps will be refused");
}
if (settings.autoHeal && backend.heal) {
  const { healLine, HEAL_ROUNDS } = await import("../agent/heal.js");
  const heal = backend.heal;
  // One heal per flow at a time. A failure while it runs (its proof broke at
  // the next op) waits and heals after: one op per heal, a few in a row at most.
  const healing = new Map<string, { next: FailureRecord | null }>();
  const start = (record: FailureRecord, file: string, rounds: number) => {
    const key = `${record.site}/${record.flow}`;
    healing.set(key, { next: null });
    void heal(record)
      .then((out) => {
        log.info({ heal: out, file }, "heal");
        return app.channel.note?.(healLine(out));
      })
      .catch((err: Error) => log.warn({ err: err.message, file }, "heal failed"))
      .finally(() => {
        const next = healing.get(key)?.next ?? null;
        healing.delete(key);
        if (next && rounds + 1 < HEAL_ROUNDS) start(next, file, rounds + 1);
      });
  };
  app.onFailure = (record, file) => {
    // Only a plain failure heals; a person's step stays theirs, an interrupted leg retries itself.
    if (record.kind !== "failed") return;
    const running = healing.get(`${record.site}/${record.flow}`);
    if (running) running.next = record;
    else start(record, file, 0);
  };
  log.info("auto-heal on");
} else if (settings.autoHeal) {
  log.warn("AUTO_HEAL set without a model: nothing heals");
}
startUiServer({
  ...backend,
  touch: () => app.idle.touch(),
  ...(linq
    ? {
        linq: {
          ...linq,
          ...(settings.linqWebhookSecret ? { secret: settings.linqWebhookSecret } : {}),
        },
      }
    : {}),
  port: settings.uiPort,
  ...(settings.uiHost ? { host: settings.uiHost } : {}),
  distDir: `${root}/ui/dist`,
  token: settings.uiToken,
  keys: fileKeys(expandHome(settings.accessFile)),
});
// Screenshots leave this machine on the disk timer and before an idle stop.
const disk = keepDiskOnTimer(settings, log);
// autotrack fleet health: the operator's worker checks each device's heartbeat hourly.
if (isDefaultOwner(settings.owner) && settings.trackBucket) {
  const ops = opsLane(httpClient());
  if (!ops) log.info("autotrack health off: no WREN_DISCORD_WEBHOOK_URL");
  else {
    const { join } = await import("node:path");
    const { checkHealth } = await import("../autotrack/health.js");
    const { iamClient } = await import("../autotrack/iam.js");
    const { s3TrackStore } = await import("../autotrack/store.js");
    const { stateDirFor } = await import("./services.js");
    const warn = (msg: string) => log.warn({ err: msg }, "autotrack health");
    const check = () =>
      void checkHealth({
        iam: iamClient(awsFor(settings)),
        store: s3TrackStore({ bucket: settings.trackBucket as string, aws: awsFor(settings) }),
        file: join(stateDirFor(settings), "autotrack-health.json"),
        // No pings: the ops lane is read, not alerted.
        post: (content) => ops(content),
        warn,
      })
        .then((sent) => {
          for (const t of sent)
            log.info({ device: t.device, silent: t.silent }, "autotrack health");
        })
        .catch((err) => warn(err instanceof Error ? err.message : String(err)));
    setTimeout(check, 60_000).unref();
    setInterval(check, 3_600_000).unref();
  }
}
// The box is the operator's: only the default owner's worker may stop it.
if (settings.idleStopMinutes > 0 && !isDefaultOwner(settings.owner))
  log.info({ owner: settings.owner }, "idle stop is the operator's worker's; off here");
else if (settings.idleStopMinutes > 0) {
  const { EC2Client } = await import("@aws-sdk/client-ec2");
  const { ec2Port, instanceIdFromMetadata, selfStopper } = await import("./box.js");
  const { scheduleIdleStop } = await import("./idle.js");
  const busyStates = new Set(["starting", "running"]);
  const services = app.services.map((s) => s.name);
  scheduleIdleStop({
    idle: app.idle,
    minutes: settings.idleStopMinutes,
    // An agent mid-goal is work; a session waiting on a person is not (it is not durable, and the person left).
    // A run or call due on the runner is work too; one waiting on a person or a timer resumes on the next boot.
    alsoBusy: async () => {
      if ((backend.agent?.list() ?? []).some((s) => busyStates.has(s.status))) return true;
      const n = await runnerStore.due(services);
      if (n > 0) log.info({ due: n }, "idle, but the runner holds work");
      return n > 0;
    },
    stop: selfStopper({
      ec2: ec2Port(new EC2Client(awsFor(settings))),
      instanceId: async () => settings.instanceId ?? (await instanceIdFromMetadata()),
    }),
    // What this session did with secrets and money, to the person, before the lights go out.
    beforeStop: async () => {
      await disk.ship("before stop");
      const { ledgerSince, ledgerSummary } = await import("../auth/ledger.js");
      const { auditFor, spendLedgerFor } = await import("./services.js");
      const lines = ledgerSummary(
        await ledgerSince(auditFor(settings), spendLedgerFor(settings), bootedAt),
      );
      if (lines.length) await app.channel.note?.(lines.join("\n"));
    },
    log,
  });
  log.info({ minutes: settings.idleStopMinutes }, "idle stop armed");
}
if (llm && settings.evaluateEveryHours > 0 && app.channel.note) {
  const { proposeWorkflows, readFailures } = await import("../agent/evaluator.js");
  const { scheduleEvaluator } = await import("../agent/schedule.js");
  const { listRecordingSummaries, loadRecording } = await import("../recorder/store.js");
  const { proofLine } = await import("../workflows/proof.js");
  const note = app.channel.note.bind(app.channel);
  const { agent, prove } = backend;
  const builder =
    settings.autoBuild && agent && prove
      ? {
          agent,
          notify: note,
          remember: new Set<string>(),
          compile: async (name: string) => ({
            workflow: (await backend.compile(await loadRecording(backend.recordingsDir, name)))
              .outline.name,
          }),
          prove: async (workflow: string) => proofLine(await prove(workflow)),
        }
      : null;
  if (settings.autoBuild && !builder) log.warn("AUTO_BUILD set without a model: nothing builds");
  scheduleEvaluator({
    everyHours: settings.evaluateEveryHours,
    evidence: async () => ({
      failures: await readFailures(backend.artifactsDir),
      sessions: agent?.list() ?? [],
      recordings: (await listRecordingSummaries(backend.recordingsDir)).map((r) => ({
        name: r.name,
        site: r.site,
      })),
      workflows: (await app.workflows()).map((w) => ({ name: w.name, description: w.description })),
    }),
    propose: (e) => proposeWorkflows(llm, e),
    notify: note,
    ...(builder
      ? {
          build: async (proposals) => {
            const { buildProposals } = await import("../agent/builder.js");
            return buildProposals(proposals, builder);
          },
        }
      : {}),
    onError: (err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "evaluator");
      sentry?.error(err, { where: "evaluator" });
    },
  });
  log.info(
    { everyHours: settings.evaluateEveryHours, autoBuild: builder !== null },
    "evaluator scheduled",
  );
}
log.info(
  {
    port: settings.uiPort,
    auth: Boolean(settings.uiToken),
    llm: llm?.id ?? "none",
    memory: app.memory.id,
  },
  "autobrowse ui",
);
