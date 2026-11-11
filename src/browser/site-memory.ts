/**
 * Site memory (OpenCLI audit U13): what explore learned about a site's calls, kept across
 * sessions. `endpoints.json`: each call (method, URL shape, query name) with its statuses,
 * counts and response keys. `field-map.json`: field name → the calls and paths that hold it.
 * Keys only, never values: rows are redacted before they exist, and no value is copied here.
 * Per base site (`instagram@wren` → `instagram`): calls are the site's, not an account's.
 * A personal profile writes none.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { callName, type NetRow } from "./network.js";
import { urlShape } from "./screens.js";

export interface Endpoint {
  method: string;
  /** `host/path`, ids as `*`. */
  shape: string;
  /** GraphQL query name. */
  name?: string;
  statuses: number[];
  /** Calls seen, all sessions. */
  seen: number;
  first: string;
  last: string;
  /** Response key paths, arrays as `[]`. */
  keys: string[];
  /** The request body's top keys. */
  sends?: string[];
}

export interface SiteMemory {
  site: string;
  updated: string;
  /** By `METHOD shape[ name]`. */
  endpoints: Record<string, Endpoint>;
  /** Field name → `call :: path`, newest first. */
  fields: Record<string, string[]>;
}

const MAX_ENDPOINTS = 500;
const MAX_KEYS = 120;
const MAX_FIELDS = 4_000;
const MAX_PLACES = 6;
const KEY_DEPTH = 8;

export const memoryDir = (site: string, env: NodeJS.ProcessEnv = process.env) =>
  join(
    env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse"),
    "sites",
    site.split("@")[0] ?? site,
  );

export const callKey = (r: Pick<NetRow, "method" | "url" | "reqHeaders" | "reqBody">) => {
  const name = callName(r as NetRow);
  return `${r.method} ${urlShape(r.url)}${name ? ` ${name}` : ""}`;
};

/** Key paths to `depth`, arrays as `[]` (one element walked). */
export function deepKeys(v: unknown, depth = KEY_DEPTH): string[] {
  const out = new Set<string>();
  const walk = (x: unknown, p: string, d: number) => {
    if (d >= depth || x === null || typeof x !== "object" || out.size >= MAX_KEYS) return;
    if (Array.isArray(x)) {
      const first = x.find((e) => e && typeof e === "object");
      if (first) walk(first, `${p}[]`, d);
      return;
    }
    for (const [k, e] of Object.entries(x)) {
      const q = p ? `${p}.${k}` : k;
      out.add(q);
      walk(e, q, d + 1);
    }
  };
  walk(v, "", 0);
  return [...out];
}

const leaf = (path: string) => path.split(".").at(-1)?.replace(/\[\]$/, "") ?? path;

const empty = (site: string): SiteMemory => ({ site, updated: "", endpoints: {}, fields: {} });

/** Fold a session's rows into what was known; pure. */
export function learn(had: SiteMemory, rows: readonly NetRow[], at: string): SiteMemory {
  const endpoints = { ...had.endpoints };
  const fields: Record<string, string[]> = { ...had.fields };
  for (const r of rows) {
    if (r.type === "document") continue;
    const key = callKey(r);
    const name = callName(r);
    const was = endpoints[key];
    const keys = deepKeys(r.body);
    const sends =
      r.reqBody && typeof r.reqBody === "object" && !Array.isArray(r.reqBody)
        ? Object.keys(r.reqBody)
        : [];
    endpoints[key] = {
      method: r.method,
      shape: urlShape(r.url),
      ...(name ? { name } : {}),
      statuses: [...new Set([...(was?.statuses ?? []), r.status])].sort((a, b) => a - b),
      seen: (was?.seen ?? 0) + 1,
      first: was?.first ?? at,
      last: at,
      keys: [...new Set([...(was?.keys ?? []), ...keys])].slice(0, MAX_KEYS),
      ...(sends.length || was?.sends
        ? { sends: [...new Set([...(was?.sends ?? []), ...sends])].slice(0, 40) }
        : {}),
    };
    for (const path of keys) {
      const f = leaf(path);
      const place = `${key} :: ${path}`;
      const list = fields[f] ?? [];
      if (list[0] === place) continue;
      fields[f] = [place, ...list.filter((p) => p !== place)].slice(0, MAX_PLACES);
    }
  }
  // Oldest out past the caps.
  const kept = Object.entries(endpoints)
    .sort(([, a], [, b]) => b.last.localeCompare(a.last))
    .slice(0, MAX_ENDPOINTS);
  const live = new Set(kept.map(([k]) => k));
  const keptFields = Object.entries(fields)
    .map(([f, places]) => [f, places.filter((p) => live.has(p.split(" :: ")[0] ?? ""))] as const)
    .filter(([, places]) => places.length > 0)
    .slice(-MAX_FIELDS);
  return {
    site: had.site,
    updated: at,
    endpoints: Object.fromEntries(kept),
    fields: Object.fromEntries(keptFields),
  };
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const writeJson = (file: string, v: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v, null, 1)}\n`);
  renameSync(tmp, file);
};

export function readMemory(site: string, env: NodeJS.ProcessEnv = process.env): SiteMemory {
  const dir = memoryDir(site, env);
  const base = site.split("@")[0] ?? site;
  const ep = readJson<{ updated?: string; endpoints?: Record<string, Endpoint> }>(
    join(dir, "endpoints.json"),
  );
  const fm = readJson<{ fields?: Record<string, string[]> }>(join(dir, "field-map.json"));
  return {
    ...empty(base),
    updated: ep?.updated ?? "",
    endpoints: ep?.endpoints ?? {},
    fields: fm?.fields ?? {},
  };
}

/** Add a session's rows to the site's files. Returns the dir, or null when nothing was new. */
export function rememberCalls(
  site: string,
  rows: readonly NetRow[],
  env: NodeJS.ProcessEnv = process.env,
  at = new Date().toISOString(),
): string | null {
  if (!rows.some((r) => r.type !== "document")) return null;
  const dir = memoryDir(site, env);
  const m = learn(readMemory(site, env), rows, at);
  writeJson(join(dir, "endpoints.json"), {
    site: m.site,
    updated: m.updated,
    endpoints: m.endpoints,
  });
  writeJson(join(dir, "field-map.json"), { site: m.site, updated: m.updated, fields: m.fields });
  return dir;
}

/** One line per call, newest first: `GET host/path Name ×12 200/404 {keys…}`. */
export const endpointLine = (key: string, e: Endpoint) => {
  const keys = e.keys.filter((k) => !k.includes(".")).slice(0, 8);
  return `${key} ×${e.seen} ${e.statuses.join("/")} ${e.last.slice(0, 10)}${keys.length ? ` {${keys.join(",")}}` : ""}`;
};

/** What `memory` answers: matching calls and fields, or the newest calls. */
export function recall(m: SiteMemory, find?: string, last = 40) {
  const all = Object.entries(m.endpoints).sort(([, a], [, b]) => b.last.localeCompare(a.last));
  if (!find)
    return {
      calls: all.slice(0, last).map(([k, e]) => endpointLine(k, e)),
      ...(all.length > last ? { more: all.length - last } : {}),
      fields: Object.keys(m.fields).length,
      updated: m.updated || null,
    };
  const q = find.toLowerCase();
  return {
    calls: all.filter(([k]) => k.toLowerCase().includes(q)).map(([k, e]) => endpointLine(k, e)),
    fields: Object.fromEntries(
      Object.entries(m.fields)
        .filter(([f]) => f.toLowerCase().includes(q))
        .slice(0, 30),
    ),
  };
}
