/**
 * The request tier of a walk (WA-1352): a read-only walk answers from the site's own JSON call
 * and clicks only when that call breaks. A UI run listens to the page's calls; once it reaches
 * its goal, each output is traced to the call whose JSON holds it: a request leg. A call the
 * start page makes as it loads is taken as the page makes it (`intercept`); one an act made is
 * sent again from the page with `fetch` (`cookie`). Legs belong to a profile, so they live
 * beside the walk, not in it: `<state>/walk-calls/<site@label>/<name>.json`.
 * Design: designs/2026-11-12-walk-request-tier.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Request, Response } from "playwright";
import { getDomain } from "tldts";
import { z } from "zod";
import type { FlowPage } from "../browser/flow.js";
import { RungBroke, type Strategy } from "../browser/ladder.js";
import { pickPath, secretName } from "../browser/network.js";
import { classify, type Fetched, pageFetch, parseJson } from "../browser/page-json.js";
import { squash } from "../browser/pick.js";
import { checkRows, dedupe, type RecordsOp, type Row } from "../browser/records.js";
import type { WalkSpec } from "./spec.js";

/** Calls one UI run keeps, at most; past it the run learns from what it kept. */
export const MAX_CALLS = 200;
/** Body bytes one UI run keeps, at most. */
export const MAX_CALL_BYTES = 8 * 1024 * 1024;
/** How long the start page gets to make an `intercept` leg's call. */
export const INTERCEPT_MS = 10_000;
/** A value shorter than this is too common to find in a URL or body. */
export const MIN_VALUE = 3;
/** A leg that broke and came back the same is not tried again for this long. */
export const OFF_MS = 7 * 24 * 3600_000;
/** Between two legs of one run: the page's own calls are not back to back either. */
export const LEG_GAP_MS = 1_200;

/** How a value is spelled in a learned call: as typed, URL-encoded, form-encoded, inside a JSON string. */
export const LEG_ENCODINGS = ["raw", "url", "form", "json"] as const;
export type LegEncoding = (typeof LEG_ENCODINGS)[number];

/**
 * One output's request leg: the site's own JSON call, learned on a UI run, as a template.
 * `{{key}}` in `url`, `body` or a header holds a plan field, an earlier output, or
 * `cookie:<name>` (read from the browser's jar when sent).
 */
export const callLegSchema = z.object({
  /** The output it gives: a `read` or `records` op's `as`. */
  as: z.string().min(1),
  kind: z.enum(["read", "records"]),
  /** `intercept`: the start page makes the call as it loads; `cookie`: the run sends it. */
  way: z.enum(["intercept", "cookie"]),
  method: z.enum(["GET", "POST"]),
  url: z.string().min(1),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  /** Each `{{key}}` and how the call spelled its value in the URL and the body. */
  vars: z.array(
    z.object({
      key: z.string().min(1),
      url: z.enum(LEG_ENCODINGS).optional(),
      body: z.enum(LEG_ENCODINGS).optional(),
    }),
  ),
  /** Where the output sits in the answer: the text (read) or the list (records); "" is the whole answer. */
  path: z.string(),
  /** A read op's `match`, applied to the text at `path`. */
  match: z.string().optional(),
  /** Records: each field's path in one item; null where the UI run read it empty. `abs`: a link the page shows absolute. */
  fields: z
    .record(z.string(), z.object({ path: z.string(), abs: z.boolean().optional() }).nullable())
    .optional(),
});
export type CallLeg = z.infer<typeof callLegSchema>;

export const walkCallsSchema = z.object({
  /** When the legs were learned. */
  learned: z.string(),
  /** One per output, in op order. */
  legs: z.array(callLegSchema).min(1),
  /** The legs broke and came back the same: not tried, and not learned again, until `until`. */
  off: z.object({ until: z.string(), why: z.string() }).optional(),
});
export type WalkCalls = z.infer<typeof walkCallsSchema>;

const FILE_PART = /^[a-z0-9][a-z0-9._@-]*$/i;

/** `<dir>/<site@label>/<name>.json`: legs per profile, since a leg may carry its account's ids. */
export function callsFile(dir: string, site: string, name: string): string {
  if (!FILE_PART.test(site) || !FILE_PART.test(name))
    throw new Error(`no calls file for ${site}/${name}`);
  return join(dir, site, `${name}.json`);
}

/** The legs learned for this walk on this profile; null when none, or the file no longer parses. */
export function loadCalls(dir: string, site: string, name: string): WalkCalls | null {
  const file = callsFile(dir, site, name);
  if (!existsSync(file)) return null;
  try {
    const p = walkCallsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Written whole (a temp file per writer, then a rename); null deletes. */
export function saveCalls(dir: string, site: string, name: string, calls: WalkCalls | null): void {
  const file = callsFile(dir, site, name);
  if (!calls) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(join(dir, site), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(walkCallsSchema.parse(calls), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Ops a request leg can stand in for: reads, and acts that only get to a read. */
const READ_OPS = new Set([
  "open",
  "click",
  "fill",
  "select",
  "press",
  "hover",
  "see",
  "read",
  "records",
  "ai",
  "captcha",
]);

/** Why a walk can never take the request tier, or null. */
export function ineligible(spec: WalkSpec): string | null {
  if (spec.irreversible) return "the walk is irreversible";
  if (!spec.start) return "the walk has no start page";
  let outputs = 0;
  for (const s of spec.screens) {
    if (s.once === false) return `screen ${s.name} comes back (a next page)`;
    for (const op of s.ops) {
      if (!READ_OPS.has(op.kind)) return `a ${op.kind} op`;
      if (op.kind === "click" && op.irreversible) return `${op.goal} is irreversible`;
      if (op.kind === "fill" && op.value.from === "secret") return `${op.goal} types a secret`;
      if (op.kind === "fill" && op.value.from === "profile")
        return `${op.goal} types a profile value`;
      if (op.kind === "records" && op.max) return `${op.goal} scrolls a feed`;
      if (op.kind === "read" || op.kind === "records") outputs++;
    }
  }
  return outputs ? null : "no read or records op";
}

export type WalkOutputOp =
  | { kind: "read"; as: string; match?: string }
  | { kind: "records"; op: RecordsOp };

/** The outputs in op order: what each leg must give. */
export function outputsOf(spec: WalkSpec): WalkOutputOp[] {
  const out: WalkOutputOp[] = [];
  for (const s of spec.screens)
    for (const op of s.ops)
      if (op.kind === "read")
        out.push({ kind: "read", as: op.as, ...(op.match ? { match: op.match } : {}) });
      else if (op.kind === "records") out.push({ kind: "records", op });
  return out;
}

/** The legs are off for now: they broke and came back the same. */
export const offNow = (c: WalkCalls | null, now: Date): boolean =>
  !!c?.off && Date.parse(c.off.until) > now.getTime();

/** The legs a run may try now, or null: not eligible, none learned, off, or not this walk's outputs. */
export function usableCalls(spec: WalkSpec, calls: WalkCalls | null, now: Date): WalkCalls | null {
  if (!calls || ineligible(spec) || offNow(calls, now)) return null;
  const want = outputsOf(spec).map((o) => (o.kind === "read" ? o.as : o.op.as));
  return calls.legs.map((l) => l.as).join("\n") === want.join("\n") ? calls : null;
}

/** The rung the legs make: `intercept` when the page makes every call itself. */
export const strategyOf = (c: WalkCalls): Strategy =>
  c.legs.every((l) => l.way === "intercept") ? "intercept" : "cookie";

/** One XHR or fetch the page made, with its JSON answer; raw, in memory only. */
export interface SeenCall {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
  json: unknown;
  /** The origin of the page that made it. */
  from: string;
  /** Acts the run had done when it came back: 0 is the start page's own load. */
  acts: number;
}

const siteOf = (url: string): string | null => {
  try {
    return getDomain(new URL(url).hostname) ?? new URL(url).hostname;
  } catch {
    return null;
  }
};

/** The page's same-site JSON calls from now until `stop`, capped (`MAX_CALLS`, `MAX_CALL_BYTES`). */
export function listenCalls(page: Page, acts: () => number): { stop(): Promise<SeenCall[]> } {
  const calls: SeenCall[] = [];
  const pending: Promise<void>[] = [];
  let bytes = 0;
  // At the request, not the answer: a slow answer to the start page's load is still act 0.
  const sent = new WeakMap<Request, number>();
  const onRequest = (req: Request) => {
    sent.set(req, acts());
  };
  const on = (res: Response) => {
    const req = res.request();
    if (!["xhr", "fetch"].includes(req.resourceType())) return;
    if (res.status() < 200 || res.status() > 299) return;
    const from = page.url();
    const n = sent.get(req) ?? acts();
    if (!siteOf(from) || siteOf(from) !== siteOf(res.url())) return;
    if (calls.length + pending.length >= MAX_CALLS || bytes >= MAX_CALL_BYTES) return;
    pending.push(
      res
        .text()
        .then((t) => {
          bytes += t.length;
          if (bytes > MAX_CALL_BYTES) return;
          const p = parseJson(t);
          if (!p.ok || p.json === null || typeof p.json !== "object") return;
          calls.push({
            method: req.method(),
            url: res.url(),
            body: req.postData(),
            headers: req.headers(),
            json: p.json,
            from: new URL(from).origin,
            acts: n,
          });
        })
        .catch(() => {}),
    );
  };
  page.on("request", onRequest);
  page.on("response", on);
  return {
    async stop() {
      page.off("request", onRequest);
      page.off("response", on);
      await Promise.all(pending);
      return calls;
    },
  };
}

// --- tracing ---

type Leaf = { path: string; value: string };

/** Leaf values under `v`, with their paths (`a.b[2].c`); arrays inside are not entered. */
function leaves(v: unknown, prefix = "", depth = 0, out: Leaf[] = []): Leaf[] {
  if (depth > 8) return out;
  if (v === null || v === undefined) return out;
  if (typeof v !== "object") {
    out.push({ path: prefix, value: String(v) });
    return out;
  }
  if (Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  return out;
}

/** Every array of objects in a body, with its path. */
function arrays(
  v: unknown,
  prefix = "",
  depth = 0,
  out: { path: string; items: unknown[] }[] = [],
) {
  if (depth > 12 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    if (v.some((x) => x && typeof x === "object" && !Array.isArray(x)))
      out.push({ path: prefix, items: v });
    v.forEach((x, i) => {
      arrays(x, `${prefix}[${i}]`, depth + 1, out);
    });
    return out;
  }
  for (const [k, x] of Object.entries(v)) arrays(x, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  return out;
}

const textOf = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v);

/** A page value and a JSON leaf say the same: text equal after squash, or one link written two ways. */
function same(page: string, leaf: string, base: string): "eq" | "abs" | null {
  if (squash(page) === squash(leaf)) return "eq";
  if (/^https?:\/\//.test(page) && leaf.startsWith("/")) {
    try {
      if (new URL(leaf, base).href === page) return "abs";
    } catch {}
  }
  return null;
}

/** The records leg's array and field paths for these rows in one body, or null. */
function traceRows(
  json: unknown,
  rows: Row[],
  op: RecordsOp,
  base: string,
): { path: string; fields: CallLeg["fields"]; hits: number } | null {
  const wanted = op.fields.filter((f) => rows.some((r) => r[f.key]));
  if (!wanted.length || !rows.length) return null;
  let best: { path: string; fields: CallLeg["fields"]; hits: number } | null = null;
  for (const arr of arrays(json)) {
    const items = arr.items.slice(0, 500).map((x) => leaves(x));
    const fields: NonNullable<CallLeg["fields"]> = {};
    for (const f of op.fields) fields[f.key] = null;
    let ok = true;
    for (const f of wanted) {
      // The leaf path that holds this field on the most rows.
      const score = new Map<string, { n: number; abs: boolean }>();
      for (const r of rows) {
        const v = r[f.key];
        if (!v) continue;
        const hit = new Set<string>();
        for (const it of items)
          for (const l of it) {
            const k = same(v, l.value, base);
            if (!k || hit.has(l.path)) continue;
            hit.add(l.path);
            const s = score.get(l.path) ?? { n: 0, abs: false };
            s.n++;
            s.abs ||= k === "abs";
            score.set(l.path, s);
          }
      }
      const top = [...score.entries()].sort(
        (a, b) => b[1].n - a[1].n || a[0].length - b[0].length,
      )[0];
      if (!top) {
        ok = false;
        break;
      }
      fields[f.key] = { path: top[0], ...(top[1].abs ? { abs: true } : {}) };
    }
    if (!ok) continue;
    // A row counts when one item holds all its values at once.
    let hits = 0;
    for (const r of rows)
      if (
        arr.items.some((x) =>
          wanted.every((f) => {
            const v = r[f.key];
            const p = fields[f.key];
            if (!v) return true;
            const leaf = p ? textOf(pickPath(x, p.path)) : null;
            return leaf !== null && same(v, leaf, base) !== null;
          }),
        )
      )
        hits++;
    // Every row: a row the call does not hold would come back different by the way it was read.
    if (hits < rows.length) continue;
    if (!best || hits > best.hits) best = { path: arr.path, fields, hits };
  }
  return best;
}

/** The read leg's leaf path for this text in one body, or null. */
function traceText(json: unknown, text: string, match: string | undefined): string | null {
  const found: string[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 12 || found.length) return;
    if (v === null || v === undefined) return;
    if (typeof v !== "object") {
      const s = String(v);
      const got = match
        ? (s.match(new RegExp(match, "i"))?.[1] ?? s.match(new RegExp(match, "i"))?.[0])
        : s;
      if (got !== undefined && squash(got) === squash(text)) found.push(p);
      return;
    }
    if (Array.isArray(v))
      v.forEach((x, i) => {
        walk(x, `${p}[${i}]`, depth + 1);
      });
    else for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, depth + 1);
  };
  walk(json, "", 0);
  return found[0] ?? null;
}

const ENCODE: Record<LegEncoding, (v: string) => string> = {
  raw: (v) => v,
  url: (v) => encodeURIComponent(v),
  form: (v) => new URLSearchParams({ v }).toString().slice(2),
  json: (v) => JSON.stringify(v).slice(1, -1),
};

/** `v` as it is spelled in `text`, first spelling found; null when it is not there. */
function spelled(text: string, v: string, order: LegEncoding[]): LegEncoding | null {
  for (const e of order) if (text.includes(ENCODE[e](v))) return e;
  return null;
}

/** Browser-set headers: the page's fetch sends its own. */
const BROWSER_HEADERS =
  /^(:.*|sec-.*|user-agent|referer|origin|cookie|host|content-length|accept-encoding|accept-language|connection|priority)$/i;
/** A header that signs the call: replaying it with old values fails or flags. */
const SIGNED = /(^|[-_])(sig|signature|nonce|x-s|x-t|timestamp)$/i;

export interface TraceInput {
  spec: WalkSpec;
  read: Record<string, string>;
  records: Record<string, Row[]>;
  calls: SeenCall[];
  /** Plan values the run used, by field key. */
  used: Record<string, string>;
  /** Cookie values by name on the call's site. */
  cookies: Record<string, string>;
}

/** A cookie value as a header or field carries it: JSESSIONID's `"ajax:…"` goes without quotes. */
const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1");

/** Strings an earlier answer gave that look like ids: a call that sends one back depends on that answer. */
function idsBefore(calls: SeenCall[], call: SeenCall): Set<string> {
  const ids = new Set<string>();
  for (const c of calls) {
    if (c === call) break;
    const walk = (v: unknown, depth: number) => {
      if (depth > 12 || v === null || v === undefined) return;
      if (typeof v === "string" || typeof v === "number") {
        const s = String(v);
        if (s.length >= 6 && s.length <= 200 && /\d/.test(s)) ids.add(s);
        return;
      }
      if (typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
    };
    walk(c.json, 0);
  }
  return ids;
}

/** The secret-named keys in a query, a form body or a JSON body, with their values. */
function secretFields(url: string, body: string | undefined): [string, string][] {
  const out: [string, string][] = [];
  try {
    for (const [k, v] of new URL(url).searchParams) if (secretName(k)) out.push([k, v]);
  } catch {}
  if (body === undefined) return out;
  const p = parseJson(body);
  if (p.ok) {
    const walk = (v: unknown, depth: number) => {
      if (depth > 12 || !v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "string" && secretName(k)) out.push([k, x]);
        else walk(x, depth + 1);
      }
    };
    walk(p.json, 0);
  } else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body))
    for (const [k, v] of new URLSearchParams(body)) if (secretName(k)) out.push([k, v]);
  return out;
}

/**
 * One seen call as a leg's request: each plan value, earlier output and cookie it carries
 * becomes `{{key}}`. Refused: a signing header, a credential that is no cookie, an id an earlier
 * answer gave.
 */
function shapeCall(
  call: SeenCall,
  vars: [string, string][],
  cookies: Record<string, string>,
  ids: Set<string>,
  /** An intercept leg: the page makes the call, so its signature and ids are the page's own. */
  pageMakes: boolean,
):
  | {
      url: string;
      body: string | undefined;
      headers: Record<string, string>;
      legVars: CallLeg["vars"];
    }
  | { why: string } {
  const jar = Object.entries(cookies)
    .map(([k, v]) => [`cookie:${k}`, unquote(v)] as [string, string])
    .filter(([, v]) => v.length >= 8);
  const cookieOf = (v: string) => jar.find(([, c]) => c === unquote(v))?.[0] ?? null;
  if (!pageMakes)
    for (const [k, v] of secretFields(call.url, call.body ?? undefined))
      if (!cookieOf(v)) return { why: `it carries a credential (${k}) that is no cookie` };
  const headers: Record<string, string> = {};
  // An intercept leg keeps no headers: the page sends its own.
  if (!pageMakes)
    for (const [k, v] of Object.entries(call.headers)) {
      if (BROWSER_HEADERS.test(k)) continue;
      if (SIGNED.test(k)) return { why: `the call is signed (${k})` };
      const c = cookieOf(v);
      if (c) headers[k] = `{{${c}}}`;
      else if (secretName(k))
        return { why: `it carries a credential header (${k}) that is no cookie` };
      else headers[k] = v;
    }
  let url = call.url;
  let body = call.body ?? undefined;
  const legVars: CallLeg["vars"] = [];
  // Longest first: a value inside another is not split.
  // An intercept leg matches the page's call by plan values only; a cookie in it is the page's.
  for (const [key, v] of [...vars, ...(pageMakes ? [] : jar)].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (v.length < MIN_VALUE) continue;
    const inUrl = spelled(url, v, ["url", "form", "raw"]);
    const inBody = body !== undefined ? spelled(body, v, ["json", "form", "url", "raw"]) : null;
    if (inUrl) url = url.split(ENCODE[inUrl](v)).join(`{{${key}}}`);
    if (inBody && body !== undefined) body = body.split(ENCODE[inBody](v)).join(`{{${key}}}`);
    if (inUrl || inBody)
      legVars.push({ key, ...(inUrl ? { url: inUrl } : {}), ...(inBody ? { body: inBody } : {}) });
  }
  if (!pageMakes)
    for (const id of ids)
      if (url.includes(id) || body?.includes(id))
        return { why: `it sends back ${id.length} chars an earlier answer gave` };
  return { url, body, headers, legVars };
}

/** Legs for every output, or why not: one untraced output, a signed call, a plan value no call carries. */
export function traceLegs(t: TraceInput): { legs: CallLeg[] } | { why: string } {
  const why = ineligible(t.spec);
  if (why) return { why };
  const start = t.spec.start as string;
  const origin = (() => {
    try {
      return new URL(start.replace(/\{[^}]*\}/g, "x")).origin;
    } catch {
      return "";
    }
  })();
  const legs: CallLeg[] = [];
  const carried = new Set<string>();
  /** Values a leg's request may carry: plan values, then earlier outputs. */
  const vars: [string, string][] = Object.entries(t.used);
  for (const out of outputsOf(t.spec)) {
    let pick: {
      call: SeenCall;
      leg: Omit<CallLeg, "way" | "method" | "url" | "headers" | "vars">;
    } | null = null;
    if (out.kind === "records") {
      const rows = t.records[out.op.as];
      if (!rows) return { why: `no rows for ${out.op.as}` };
      let hits = -1;
      for (const call of t.calls) {
        const r = traceRows(call.json, rows, out.op, call.from);
        // The latest of equals: the call after the last act.
        if (r && r.hits >= hits) {
          hits = r.hits;
          pick = { call, leg: { as: out.op.as, kind: "records", path: r.path, fields: r.fields } };
        }
      }
    } else {
      const text = t.read[out.as];
      if (text === undefined || text.trim() === "") return { why: `no text for ${out.as}` };
      for (const call of t.calls) {
        const p = traceText(call.json, text, out.match);
        if (p !== null)
          pick = {
            call,
            leg: { as: out.as, kind: "read", path: p, ...(out.match ? { match: out.match } : {}) },
          };
      }
    }
    if (!pick) return { why: `no call holds ${out.kind === "records" ? out.op.as : out.as}` };
    const { call } = pick;
    if (call.from !== origin) return { why: `the call for ${pick.leg.as} came from another page` };
    const method = call.method.toUpperCase();
    if (method !== "GET" && method !== "POST") return { why: `a ${method} call` };
    const way = call.acts === 0 ? "intercept" : "cookie";
    const shaped = shapeCall(call, vars, t.cookies, idsBefore(t.calls, call), way === "intercept");
    if ("why" in shaped) return { why: `${pick.leg.as}: ${shaped.why}` };
    const { url, body, headers, legVars } = shaped;
    for (const v of legVars) carried.add(v.key);
    legs.push({
      ...pick.leg,
      way,
      method: method as CallLeg["method"],
      url,
      ...(body !== undefined ? { body } : {}),
      headers,
      vars: legVars,
    });
    if (out.kind === "read") vars.push([out.as, t.read[out.as] as string]);
  }
  // A plan value no call carries: the answer would not change with it.
  for (const [key, v] of Object.entries(t.used)) {
    if (v.length < MIN_VALUE) return { why: `plan value ${key} is too short to find in a call` };
    if (!carried.has(key)) return { why: `no call carries plan value ${key}` };
  }
  return { legs };
}

/** The calls to keep after a UI run: new legs, or the old ones off for a while when they came back the same. */
export function nextCalls(
  old: WalkCalls | undefined,
  legs: CallLeg[],
  broke: string | null,
  now: Date,
): WalkCalls {
  const learned = now.toISOString();
  // The whole leg: one call read at a new path is a new leg.
  if (broke && old && JSON.stringify(old.legs) === JSON.stringify(legs))
    return {
      learned,
      legs,
      off: { until: new Date(now.getTime() + OFF_MS).toISOString(), why: broke },
    };
  return { learned, legs };
}

// --- running ---

/** `{{key}}` → the value as the leg's call spelled it. */
function fillTemplate(
  text: string,
  leg: CallLeg,
  where: "url" | "body",
  value: (key: string) => string,
): string {
  let out = text;
  for (const v of leg.vars) {
    const e = v[where];
    if (e) out = out.split(`{{${v.key}}}`).join(ENCODE[e](value(v.key)));
  }
  return out;
}

/** One leg's answer as its output: rows, or text. A shape that does not fit breaks the leg. */
export function mapLeg(
  json: unknown,
  leg: CallLeg,
  op: RecordsOp | null,
  base: string,
): { rows: Row[] } | { text: string } {
  if (leg.kind === "read") {
    const leaf = pickPath(json, leg.path);
    if (leaf === undefined || leaf === null || typeof leaf === "object")
      throw new RungBroke(`${leg.as}: nothing at ${leg.path}`);
    const s = String(leaf);
    if (!leg.match) return { text: s };
    const m = s.match(new RegExp(leg.match, "i"));
    if (!m) throw new RungBroke(`${leg.as}: ${leg.path} no longer matches`);
    return { text: m[1] ?? m[0] };
  }
  if (!op) throw new RungBroke(`${leg.as}: no records op`);
  const items = pickPath(json, leg.path);
  if (!Array.isArray(items)) throw new RungBroke(`${leg.as}: no list at ${leg.path || "the top"}`);
  const rows = items.map((x) => {
    const row: Row = {};
    for (const [k, p] of Object.entries(leg.fields ?? {})) {
      const v = p ? textOf(pickPath(x, p.path)) : null;
      row[k] =
        v !== null && p?.abs
          ? (() => {
              try {
                return new URL(v, base).href;
              } catch {
                return v;
              }
            })()
          : v;
    }
    return row;
  });
  const kept = dedupe(rows, op);
  const problem = checkRows(kept, op);
  if (problem) throw new RungBroke(`${leg.as}: ${problem}`);
  return { rows: kept };
}

export interface LegRun {
  /** A plan value by key; null when there is none (the UI leg asks). */
  plan(key: string): string | null;
  read: Record<string, string>;
  records: Record<string, Row[]>;
  wait?(ms: number): Promise<void>;
}

/** Keys a leg's request fills: its vars, and `{{…}}` in its headers. */
const keysOf = (leg: CallLeg): string[] => [
  ...new Set([
    ...leg.vars.map((v) => v.key),
    ...Object.values(leg.headers).flatMap((h) =>
      [...h.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1] as string),
    ),
  ]),
];

/** A query value that changes per load (a time in ms or s): not matched. */
const VOLATILE = /^\d{9,}$/;

/** The page's request is the leg's call: same method, path and query, the plan values in it. */
export function sameCall(
  leg: CallLeg,
  req: { method: string; url: string; body: string | null },
  value: (key: string) => string,
): boolean {
  if (req.method.toUpperCase() !== leg.method) return false;
  let want: URL;
  let got: URL;
  try {
    want = new URL(fillTemplate(leg.url, leg, "url", value));
    got = new URL(req.url);
  } catch {
    return false;
  }
  if (want.origin !== got.origin || want.pathname !== got.pathname) return false;
  const keys = (u: URL) => [...new Set(u.searchParams.keys())].sort().join("&");
  if (keys(want) !== keys(got)) return false;
  for (const [k, v] of want.searchParams)
    if (!VOLATILE.test(v) && got.searchParams.get(k) !== v) return false;
  for (const v of leg.vars)
    if (v.body && !(req.body ?? "").includes(ENCODE[v.body](value(v.key)))) return false;
  return true;
}

/** A response as `classify` takes it. */
const fetchedOf = async (res: Response): Promise<Fetched> => ({
  status: res.status(),
  url: res.url(),
  contentType: res.headers()["content-type"] ?? "",
  text: await res.text(),
});

/**
 * Open the start page and take each leg's answer, in op order: an `intercept` leg's from the
 * call the page makes as it loads, a `cookie` leg's by `fetch` from the page. A 429, a sign-in
 * answer or a block stops the run (`classify`); a 4xx, a non-JSON answer, a CORS refusal, a call
 * the page no longer makes or a shape that does not fit breaks the leg (`RungBroke`).
 */
export async function runLegs(
  fp: Pick<FlowPage, "page" | "open">,
  spec: WalkSpec,
  calls: WalkCalls,
  start: string,
  r: LegRun,
): Promise<void> {
  const ops = new Map(
    outputsOf(spec).flatMap((o) => (o.kind === "records" ? [[o.op.as, o.op] as const] : [])),
  );
  /** A plan value or an earlier output; the cookie jar for `cookie:` keys. */
  const valuesFor = async (leg: CallLeg): Promise<(key: string) => string> => {
    let jar: { name: string; value: string }[] | null = null;
    const values = new Map<string, string>();
    for (const key of keysOf(leg)) {
      if (key.startsWith("cookie:")) {
        jar ??= await fp.page.context().cookies(leg.url.replace(/\{\{[^}]*\}\}/g, "x"));
        const c = jar.find((x) => x.name === key.slice(7));
        if (!c) throw new RungBroke(`${leg.as}: no ${key.slice(7)} cookie`);
        values.set(key, unquote(c.value));
        continue;
      }
      const v = r.read[key] ?? r.plan(key);
      if (v === null || v === undefined) throw new RungBroke(`${leg.as}: no value for ${key}`);
      values.set(key, v);
    }
    return (key) => values.get(key) ?? "";
  };

  const caught = new Map<string, Promise<Fetched>>();
  const want: [CallLeg, (key: string) => string][] = [];
  for (const leg of calls.legs) if (leg.way === "intercept") want.push([leg, await valuesFor(leg)]);
  let all = () => {};
  const allCaught = new Promise<void>((done) => {
    all = done;
  });
  const on = (res: Response) => {
    const req = res.request();
    if (!["xhr", "fetch"].includes(req.resourceType())) return;
    const call = { method: req.method(), url: res.url(), body: req.postData() };
    // Two outputs may come from one call: both take this answer.
    const hits = want.filter(([leg, value]) => !caught.has(leg.as) && sameCall(leg, call, value));
    if (!hits.length) return;
    const p = fetchedOf(res);
    // Read later, or never when an earlier leg breaks.
    p.catch(() => {});
    for (const [leg] of hits) caught.set(leg.as, p);
    if (caught.size === want.length) all();
  };
  if (want.length) fp.page.on("response", on);
  try {
    await fp.open(start);
    if (want.length && caught.size < want.length)
      await Promise.race([allCaught, new Promise((ok) => setTimeout(ok, INTERCEPT_MS))]);
  } finally {
    fp.page.off("response", on);
  }
  const base = fp.page.url();
  /** Sent requests by method, URL, headers and body: two outputs of one call send it once. */
  const sent = new Map<string, Fetched>();
  for (const leg of calls.legs) {
    let got: Fetched;
    let url: string;
    if (leg.way === "intercept") {
      const p = caught.get(leg.as);
      if (!p) throw new RungBroke(`${leg.as}: the start page no longer makes its call`);
      try {
        got = await p;
      } catch (e) {
        throw new RungBroke(`${leg.as}: no answer body (${(e as Error).message.slice(0, 120)})`);
      }
      url = got.url;
    } else {
      const value = await valuesFor(leg);
      url = fillTemplate(leg.url, leg, "url", value);
      const body = leg.body !== undefined ? fillTemplate(leg.body, leg, "body", value) : undefined;
      const headers = Object.fromEntries(
        Object.entries(leg.headers).map(([k, h]) => [
          k,
          h.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => value(key)),
        ]),
      );
      const key = JSON.stringify([leg.method, url, headers, body ?? null]);
      const again = sent.get(key);
      if (again) got = again;
      else {
        if (sent.size) await r.wait?.(LEG_GAP_MS);
        try {
          got = await pageFetch(fp, url, {
            method: leg.method,
            headers,
            ...(body !== undefined ? { body } : {}),
          });
        } catch (e) {
          throw new RungBroke(
            `${leg.as}: the page's fetch failed (${(e as Error).message.slice(0, 120)})`,
          );
        }
        sent.set(key, got);
      }
    }
    const json = classify(got, `${leg.as} ${url.replace(/\?.*/, "")}`);
    const m = mapLeg(json, leg, ops.get(leg.as) ?? null, base);
    if ("rows" in m) r.records[leg.as] = m.rows;
    else r.read[leg.as] = m.text;
  }
}
