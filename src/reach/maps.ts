/**
 * Google Maps listings as a lead list, from two MIT engines on loopback that answer
 * one REST API (post a job, wait, download its CSV):
 * - the Maps kit (vendored, Python, the Mac's Chrome): fast; emails and socials.
 * - the current Maps scraper (gosom's image in Docker): the owner field.
 * Their rows merge by `cid`. The CSV is what `wren email import --format google-maps` reads.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const exec = promisify(execFile);

export const MAPS_IMAGE = "gosom/google-maps-scraper";
export const MAPS_CONTAINER = "autobrowse-maps";
/** Restate owns 8080 on this machine. */
export const MAPS_BASE = "http://127.0.0.1:8090";
export const MAPS_KIT_BASE = "http://127.0.0.1:8091";
/** The vendored kit (`PIN.md`); the same depth from `src/reach` and `dist/reach`. */
export const MAPS_KIT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "vendor",
  "google-maps-scraper-kit",
);

export interface MapsJob {
  /** One search each: "hvac contractor in austin tx". */
  keywords: string[];
  /** How far down the results list to scroll; 1 is about 20 places a keyword. */
  depth: number;
  /** Visit each website for emails: slower, and the whole point for outreach. */
  email: boolean;
  /** Read Instagram, Facebook, LinkedIn, TikTok, YouTube, X links off each website (kit only). */
  socials?: boolean;
  /** The job gives up after this long. */
  maxMinutes: number;
  lang?: string;
}

interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Each status the job reports, as it changes. */
  onStatus?: (status: string) => void;
  base?: string;
}

const POLL_MS = 10_000;

/** Post the job, wait for it, return its CSV. */
export async function mapsScrape(job: MapsJob, deps: Deps = {}): Promise<string> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = deps.base ?? MAPS_BASE;
  const posted = await f(`${base}/api/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: job.keywords[0]?.slice(0, 60) ?? "autobrowse",
      keywords: job.keywords,
      lang: job.lang ?? "en",
      depth: job.depth,
      email: job.email,
      ...(job.socials ? { socials: true } : {}),
      max_time: job.maxMinutes * 60,
    }),
  });
  if (!posted.ok)
    throw new Error(`maps: job refused, HTTP ${posted.status}: ${await posted.text()}`);
  const { id } = (await posted.json()) as { id: string };
  const deadline = Date.now() + (job.maxMinutes + 5) * 60_000;
  let last = "";
  for (;;) {
    const res = await f(`${base}/api/v1/jobs/${id}`);
    if (!res.ok) throw new Error(`maps: job ${id} status HTTP ${res.status}`);
    const status = ((await res.json()) as { Status?: string }).Status ?? "unknown";
    if (status !== last) deps.onStatus?.(status);
    last = status;
    if (status === "ok") break;
    if (status === "failed") throw new Error(`maps: job ${id} at ${base} failed`);
    if (Date.now() > deadline) throw new Error(`maps: job ${id} still ${status} past its max time`);
    await sleep(POLL_MS);
  }
  const csv = await f(`${base}/api/v1/jobs/${id}/download`);
  if (!csv.ok) throw new Error(`maps: job ${id} download HTTP ${csv.status}`);
  return csv.text();
}

/** Rows in a CSV, header excluded; quoted newlines inside a cell do not count. */
export function csvRows(csv: string): number {
  let rows = 0;
  let quoted = false;
  for (const ch of csv.trimEnd()) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "\n" && !quoted) rows++;
  }
  return rows;
}

const up = async (base: string) => {
  try {
    return (await fetch(`${base}/api/v1/jobs`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
};

/**
 * The scraper answering on loopback: already, or started now in Docker.
 * Says whether it started it, so the caller stops what it started.
 */
export async function ensureMapsServer(dataDir: string, base = MAPS_BASE): Promise<boolean> {
  if (await up(base)) return false;
  await exec("docker", ["info"], { timeout: 20_000 }).catch(() => {
    throw new Error("maps: Docker is not running; start Docker Desktop, then run this again");
  });
  const { stdout } = await exec("docker", ["images", "-q", MAPS_IMAGE]);
  // The first pull is a few GB: its own step, no timeout, progress on stderr.
  if (!stdout.trim())
    await new Promise<void>((ok, fail) =>
      spawn("docker", ["pull", MAPS_IMAGE], { stdio: ["ignore", "inherit", "inherit"] }).on(
        "exit",
        (code) =>
          code === 0 ? ok() : fail(new Error(`maps: docker pull ${MAPS_IMAGE} exited ${code}`)),
      ),
    );
  const port = new URL(base).port;
  await exec("docker", ["rm", "-f", MAPS_CONTAINER]).catch(() => undefined);
  await exec(
    "docker",
    [
      ...["run", "-d", "--rm", "--name", MAPS_CONTAINER],
      ...["-p", `127.0.0.1:${port}:8080`, "-v", `${dataDir}:/gmapsdata`],
      ...[MAPS_IMAGE, "-data-folder", "/gmapsdata", "-c", "2"],
    ],
    { timeout: 60_000 },
  );
  for (let i = 0; i < 60; i++) {
    if (await up(base)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`maps: the scraper did not answer on ${base} (docker logs ${MAPS_CONTAINER})`);
}

const KIT_PID = "kit.pid";

/**
 * The kit's engine answering on loopback: already, or started now (detached, its log in
 * `dataDir`). Says whether it started it. No update check: the code is pinned.
 */
export async function ensureKitServer(dataDir: string, base = MAPS_KIT_BASE): Promise<boolean> {
  if (await up(base)) return false;
  const serve = join(MAPS_KIT_DIR, "engine", "serve.py");
  if (!existsSync(serve)) throw new Error(`maps: the kit is missing at ${MAPS_KIT_DIR}`);
  const log = openSync(join(dataDir, "kit.log"), "a");
  const child = spawn("python3", [serve, "--port", new URL(base).port, "--data", dataDir], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, SCRAPER_NO_UPDATE_CHECK: "1" },
  });
  closeSync(log);
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  child.once("error", () => undefined);
  child.unref();
  if (child.pid) writeFileSync(join(dataDir, KIT_PID), String(child.pid));
  for (let i = 0; i < 30; i++) {
    if (await up(base)) return true;
    const code = await Promise.race([exited, new Promise((r) => setTimeout(r, 1_000, "wait"))]);
    if (code !== "wait")
      throw new Error(`maps: the kit exited ${code} (see ${join(dataDir, "kit.log")})`);
  }
  stopKitServer(dataDir);
  throw new Error(`maps: the kit did not answer on ${base} (see ${join(dataDir, "kit.log")})`);
}

export function stopKitServer(dataDir: string): void {
  const file = join(dataDir, KIT_PID);
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8"));
  try {
    if (pid) process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  rmSync(file, { force: true });
}

type Row = Record<string, string>;

const rowsOf = (csv: string): { header: string[]; rows: Row[] } => {
  let header: string[] = [];
  const rows = parse(csv, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    columns: (h: string[]) => {
      header = h;
      return h;
    },
  }) as Row[];
  return { header, rows };
};

/** A place's key: `cid` is stable across engines; `place_id`, then the link, when it is empty. */
const keyOf = (r: Row): string => r.cid || r.place_id || r.link || "";

export interface MapsMerge {
  csv: string;
  /** In both engines' results. */
  both: number;
  kitOnly: number;
  ownerOnly: number;
  /** Rows with an owner name. */
  owners: number;
}

/**
 * One CSV: the kit's rows and columns first, an empty cell filled from the current
 * scraper's row for the same place, then places only that scraper found.
 */
export function mergeMaps(kitCsv: string, ownerCsv: string): MapsMerge {
  const kit = rowsOf(kitCsv);
  const other = rowsOf(ownerCsv);
  const header = [...kit.header, ...other.header.filter((h) => !kit.header.includes(h))];
  const byKey = new Map(other.rows.map((r) => [keyOf(r), r] as const));
  byKey.delete("");
  let both = 0;
  const seen = new Set<string>();
  const out = kit.rows.map((r) => {
    const k = keyOf(r);
    const o = k ? byKey.get(k) : undefined;
    if (!o) return r;
    both++;
    seen.add(k);
    const merged: Row = { ...o, ...r };
    for (const h of header) if (!r[h] && o[h]) merged[h] = o[h];
    return merged;
  });
  const extra = other.rows.filter((r) => !seen.has(keyOf(r)));
  const all = [...out, ...extra];
  return {
    csv: stringify(all, { header: true, columns: header }),
    both,
    kitOnly: kit.rows.length - both,
    ownerOnly: extra.length,
    owners: all.filter((r) => r.owner?.trim()).length,
  };
}

/** One line: can `maps` run here, and what is missing. */
export async function mapsReady(base = MAPS_BASE): Promise<string> {
  const kit = existsSync(join(MAPS_KIT_DIR, "engine", "serve.py")) ? "kit ok" : "kit missing";
  return `${kit}; owner scraper: ${await ownerReady(base)}`;
}

async function ownerReady(base: string): Promise<string> {
  if (await up(base)) return `scraper answering on ${base}`;
  if (
    !(await exec("docker", ["info"], { timeout: 20_000 }).then(
      () => true,
      () => false,
    ))
  )
    return "Docker is not running";
  const { stdout } = await exec("docker", ["images", "-q", MAPS_IMAGE]).catch(() => ({
    stdout: "",
  }));
  return stdout.trim() ? "ready (Docker up, image pulled)" : `ready; first run pulls ${MAPS_IMAGE}`;
}

export async function stopMapsServer(): Promise<void> {
  await exec("docker", ["stop", MAPS_CONTAINER]).catch(() => undefined);
}
