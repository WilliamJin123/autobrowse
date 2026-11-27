/**
 * A sign-in's heal screens (designs/2026-11-26-branching-sign-ins.md, "Heal on
 * a sign-in"): `walks/<site>/login-heal.json` in the state dir, which a deploy
 * never touches. Each screen is a trial till a sign-in passes through it; a
 * failed try that went through it drops it. Outcomes go to an append-only log,
 * so two accounts of one site never overwrite each other.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SignInHealAsk } from "../auth/login.js";
import type { Hints } from "../browser/locate.js";
import { completeJson, type Llm } from "../llm/types.js";
import { type ScreenSpec, screenSpecSchema, type WalkSpec, walkSpecSchema } from "./spec.js";

export const healFile = (walksDir: string, site: string): string =>
  join(walksDir, site, "login-heal.json");
export const healLog = (walksDir: string, site: string): string =>
  join(walksDir, site, "login-heal.jsonl");

export type HealOutcome = "passed" | "failed";
export interface HealTry {
  at: string;
  screen: string;
  outcome: HealOutcome;
}
export type HealState = "trial" | "kept" | "dropped";

/** Each logged screen's state: its last outcome decides. */
export function healStates(rows: readonly HealTry[]): Map<string, HealState> {
  const out = new Map<string, HealState>();
  for (const r of rows) out.set(r.screen, r.outcome === "passed" ? "kept" : "dropped");
  return out;
}

function readTries(walksDir: string, site: string): HealTry[] {
  const file = healLog(walksDir, site);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as HealTry] : [];
      } catch {
        return []; // a torn last line
      }
    });
}

function readScreens(walksDir: string, site: string): unknown[] {
  const file = healFile(walksDir, site);
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, "utf8")) as { screens?: unknown[] };
  return Array.isArray(doc.screens) ? doc.screens : [];
}

export interface Healed {
  spec: WalkSpec;
  /** Heal screens on trial: a pass keeps one, a failed try drops it. */
  trial: string[];
  kept: string[];
  /** Heal screens left out, each with why. */
  warnings: string[];
}

/**
 * The walk with its heal screens after the repo's, newest first: a newer heal
 * for the same page shadows an older one. A screen the schema refuses (a repo
 * screen it names was renamed) drops alone; the rest load.
 */
export function withHeal(spec: WalkSpec, walksDir: string): Healed {
  const out: Healed = { spec, trial: [], kept: [], warnings: [] };
  let raw: unknown[];
  try {
    raw = readScreens(walksDir, spec.site);
  } catch (err) {
    out.warnings.push(`${healFile(walksDir, spec.site)}: ${(err as Error).message}`);
    return out;
  }
  if (!raw.length) return out;
  const states = healStates(readTries(walksDir, spec.site));
  let screens = [...spec.screens];
  for (const r of [...raw].reverse()) {
    const one = screenSpecSchema.safeParse(r);
    const name = one.success ? one.data.name : String((r as { name?: unknown })?.name ?? "?");
    if (!one.success) {
      out.warnings.push(`heal screen ${name}: ${one.error.issues[0]?.message ?? "refused"}`);
      continue;
    }
    const state = states.get(name) ?? "trial";
    if (state === "dropped") continue;
    if (screens.some((s) => s.name === name)) {
      out.warnings.push(`heal screen ${name}: the walk already has a screen by that name`);
      continue;
    }
    const next = walkSpecSchema.safeParse({ ...spec, screens: [...screens, one.data] });
    if (!next.success) {
      out.warnings.push(`heal screen ${name}: ${next.error.issues[0]?.message ?? "refused"}`);
      continue;
    }
    screens = next.data.screens;
    (state === "kept" ? out.kept : out.trial).push(name);
  }
  out.spec = { ...spec, screens };
  return out;
}

/** Adds one heal screen (a trial) to the site's file; its name made unique. */
export function addHealScreen(walksDir: string, site: string, screen: ScreenSpec): string {
  const file = healFile(walksDir, site);
  const screens = readScreens(walksDir, site) as ScreenSpec[];
  const taken = new Set(screens.map((s) => s.name));
  let name = screen.name;
  for (let n = 2; taken.has(name); n++) name = `${screen.name}-${n}`;
  mkdirSync(join(walksDir, site), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ screens: [...screens, { ...screen, name }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(tmp, file);
  return name;
}

/** One line per heal screen a try went through. */
export function logHealTries(
  walksDir: string,
  site: string,
  screens: readonly string[],
  outcome: HealOutcome,
  now = new Date(),
): void {
  if (!screens.length) return;
  mkdirSync(join(walksDir, site), { recursive: true });
  const at = now.toISOString();
  appendFileSync(
    healLog(walksDir, site),
    screens.map((screen) => `${JSON.stringify({ at, screen, outcome })}\n`).join(""),
    { mode: 0o600 },
  );
}

/** At most one heal per site per this. */
export const HEAL_EVERY_MS = 24 * 60 * 60_000;

const asksFile = (walksDir: string, site: string) => join(walksDir, site, "login-heal-asks.jsonl");

/** When the site's last heal was asked; null when never. */
function lastAsk(walksDir: string, site: string): number | null {
  const file = asksFile(walksDir, site);
  if (!existsSync(file)) return null;
  const at = readFileSync(file, "utf8").trim().split("\n").at(-1);
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

/** One screen as a model proposes it: the checks come from the page, never from it. */
export interface HealProposal {
  name: string;
  looks: string;
  ops: unknown[];
}

export interface HealWriter {
  readonly id: string;
  propose(req: {
    site: string;
    goal: string;
    url: string;
    snapshot: string;
    error: string;
    steps: readonly string[];
    known: { name: string; looks: string }[];
  }): Promise<HealProposal | null>;
}

/** Ops a heal screen may hold: a click past a page, or a kit op where a secret goes. */
const HEAL_OPS = new Set(["click", "username", "password", "one-time-code", "passkey", "captcha"]);
/** A click a heal never makes. */
const NEVER =
  /\b(buy|pay|purchase|order|checkout|delete|remove|publish|post|sign up|create account|forgot|reset)\b/i;

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The page's own URL as the screen's `at`, and the first op's control as its `shows`. */
export function healScreenOf(p: HealProposal, url: string): ScreenSpec | string {
  // a heal click only moves past a page: never one the run would count as a commit
  const ops = p.ops.map((op) =>
    op && typeof op === "object" && (op as { kind?: unknown }).kind === "click"
      ? { ...op, irreversible: false }
      : op,
  );
  const one = screenSpecSchema.safeParse({ name: p.name, looks: p.looks, ops });
  if (!one.success) return one.error.issues[0]?.message ?? "not a screen";
  if (!one.data.ops.length) return "a heal screen with no ops";
  const bad = one.data.ops.find((op) => !HEAL_OPS.has(op.kind));
  if (bad) return `a heal screen never holds a ${bad.kind} op`;
  for (const op of one.data.ops) {
    const h = (op as { hints?: Hints }).hints;
    if (op.kind === "click" && NEVER.test(`${h?.name ?? ""} ${h?.text ?? ""}`))
      return `a heal never clicks ${JSON.stringify(h?.name ?? h?.text)}`;
  }
  const first = one.data.ops[0] as { hints?: Hints; field?: Hints; start?: Hints };
  const shows = first.field ?? first.hints ?? first.start;
  let at: string;
  try {
    const u = new URL(url);
    at = `/^${regexEscape(`${u.origin}${u.pathname}`)}/`;
  } catch {
    return `no URL to match: ${url}`;
  }
  const full = screenSpecSchema.safeParse({
    ...one.data,
    name: `heal-${one.data.name}`.slice(0, 60),
    at,
    ...(shows ? { shows: [shows] } : {}),
  });
  return full.success ? full.data : (full.error.issues[0]?.message ?? "not a screen");
}

export type HealResult =
  | { status: "added"; screen: string }
  | { status: "skipped" | "none" | "refused"; why: string };

/**
 * One heal: a model names the screen from the failure page, the code adds its
 * checks, and it joins the site's heal file as a trial. Once per site per 24 h.
 */
export async function healSignIn(
  writer: HealWriter,
  ask: SignInHealAsk,
  now = new Date(),
): Promise<HealResult> {
  const { spec, dir } = ask;
  const last = lastAsk(dir, spec.site);
  if (last !== null && now.getTime() - last < HEAL_EVERY_MS)
    return {
      status: "skipped",
      why: `one heal per day; the last was ${new Date(last).toISOString()}`,
    };
  mkdirSync(join(dir, spec.site), { recursive: true });
  appendFileSync(asksFile(dir, spec.site), `${now.toISOString()}\n`, { mode: 0o600 });
  const proposal = await writer.propose({
    site: spec.site,
    goal: spec.goal,
    url: ask.url,
    snapshot: ask.snapshot,
    error: ask.error,
    steps: ask.steps,
    known: withHeal(spec, dir).spec.screens.map((s) => ({ name: s.name, looks: s.looks })),
  });
  if (!proposal) return { status: "none", why: `${writer.id} named no screen` };
  const screen = healScreenOf(proposal, ask.url);
  if (typeof screen === "string") return { status: "refused", why: screen };
  const fits = walkSpecSchema.safeParse({ ...spec, screens: [...spec.screens, screen] });
  if (!fits.success)
    return { status: "refused", why: fits.error.issues[0]?.message ?? "the walk refuses it" };
  return { status: "added", screen: addHealScreen(dir, spec.site, screen) };
}

const proposalSchema = z.object({
  name: z.string().nullable(),
  looks: z.string().nullable(),
  ops: z.array(z.record(z.string(), z.unknown())).nullable(),
});

const HEAL_SYSTEM = `A sign-in walk stopped on a page none of its screens knows. You write the one screen that gets past this page. You never see or type a secret: where one goes, name the op and the box.
Ops (JSON, each with a short "goal"):
- {"kind":"click","goal":"...","hints":{"role":"button","name":"Continue"},"irreversible":false}
- {"kind":"username","goal":"...","field":{hints}}
- {"kind":"password","goal":"...","field":{hints},"submit":{hints}}
- {"kind":"one-time-code","goal":"...","kinds":["totp"|"sms"|"email"],"field":{hints},"submit":{hints},"send":{hints}?}
- {"kind":"passkey","goal":"...","start":{hints}} and {"kind":"captcha","goal":"..."}
Hints: role + name, text, placeholder, testId or id, from the elements listed. Never a click that buys, deletes, posts, signs up or resets a password. "name": a few kebab-case words for the page. "looks": one line on what the page is. If no screen gets past this page, reply with nulls.`;

/** The model that writes a heal screen. */
export function llmHealWriter(llm: Llm): HealWriter {
  return {
    id: `llm:${llm.id}`,
    async propose(req) {
      const { value } = await completeJson(llm, proposalSchema, {
        purpose: "sign-in-heal",
        system: HEAL_SYSTEM,
        prompt: [
          `Site: ${req.site}. Goal: ${req.goal}.`,
          `Screens it went through: ${req.steps.join(" → ") || "none"}`,
          "Screens it knows:",
          ...req.known.map((s) => `- ${s.name}: ${s.looks}`),
          `It stopped with: ${req.error}`,
          `URL: ${req.url}`,
          "Elements:",
          req.snapshot,
          'Reply: {"name": "...", "looks": "...", "ops": [...]}',
        ].join("\n"),
        maxTokens: 2_000,
      });
      if (!value.name || !value.looks || !value.ops?.length) return null;
      return { name: value.name, looks: value.looks, ops: value.ops };
    },
  };
}
