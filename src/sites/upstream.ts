/**
 * The upstream watch for ported routes (WA-1251.6). A route ported by hand from OpenCLI says
 * where from (`ported: "clis/<site>/<file>@<sha>"`). Once a week this diffs each such file
 * against their main and opens one task per file that changed: their fix (an endpoint moved,
 * a field renamed) reaches us as a task with the commits, not a silent drift.
 * Design: designs/2026-11-09-opencli-audit.md.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SiteApi } from "./types.js";

const run = promisify(execFile);
export const UPSTREAM_REPO = "https://github.com/jackwener/opencli.git";
const CLONE = join(homedir(), ".cache", "autobrowse", "opencli");
const STATE = join(homedir(), ".config", "autobrowse", "upstream.json");
export const WEEK_MS = 7 * 24 * 60 * 60_000;

export interface Ported {
  /** `clis/instagram/user.js` */
  file: string;
  sha: string;
  /** `instagram GET /web/{username}/reels` */
  routes: string[];
}

/** Each ported file once, with the routes that came from it. Bad `ported` values are errors. */
export function portedOf(sites: readonly Pick<SiteApi, "site" | "routes">[]): Ported[] {
  const out = new Map<string, Ported>();
  for (const s of sites)
    for (const r of s.routes) {
      if (!r.ported) continue;
      const m = /^(clis\/[^@\s]+)@([0-9a-f]{7,40})$/.exec(r.ported);
      if (!m) throw new Error(`${s.site} ${r.method} ${r.path}: ported must be clis/<path>@<sha>`);
      const [, file, sha] = m as unknown as [string, string, string];
      const k = `${file}@${sha}`;
      const p = out.get(k) ?? { file, sha, routes: [] };
      p.routes.push(`${s.site} ${r.method} ${r.path}`);
      out.set(k, p);
    }
  return [...out.values()];
}

export interface Changed extends Ported {
  /** Their main's head. */
  head: string;
  /** `abc1234 fix(instagram): …`, newest first. */
  commits: string[];
  /** Gone upstream (moved or deleted). */
  gone: boolean;
}

const git = async (args: string[], cwd?: string) =>
  (await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/** A blobless clone kept in the cache, fetched to their main. */
async function freshClone(dir: string): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    await git(["clone", "--filter=blob:none", "--no-checkout", UPSTREAM_REPO, dir]);
  } else await git(["fetch", "--quiet", "origin"], dir);
}

/** Each ported file whose upstream changed since the sha it came from. */
export async function upstreamChanges(ported: readonly Ported[], dir = CLONE): Promise<Changed[]> {
  if (!ported.length) return [];
  await freshClone(dir);
  const head = await git(["rev-parse", "--short", "origin/HEAD"], dir);
  const out: Changed[] = [];
  for (const p of ported) {
    const commits = (await git(["log", "--oneline", `${p.sha}..origin/HEAD`, "--", p.file], dir))
      .split("\n")
      .filter(Boolean);
    if (!commits.length) continue;
    const gone = !(await git(["ls-tree", "--name-only", "origin/HEAD", "--", p.file], dir));
    out.push({ ...p, head, commits, gone });
  }
  return out;
}

interface State {
  checkedAt?: string;
  /** file → the head a task was opened for, so one change opens one task. */
  tasked: Record<string, string>;
}

const readState = (file = STATE): State => {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    return { ...s, tasked: s.tasked ?? {} };
  } catch {
    return { tasked: {} };
  }
};

/** True when the last check is a week old or more. */
export const upstreamDue = (now = Date.now(), file = STATE): boolean => {
  const at = readState(file).checkedAt;
  return !at || now - Date.parse(at) >= WEEK_MS;
};

/** One task per changed file not tasked at this head (backlog in `BACKLOG_CWD`). */
export async function taskChanges(
  changed: readonly Changed[],
  o: { file?: string; now?: () => Date } = {},
): Promise<string[]> {
  const file = o.file ?? STATE;
  const state = readState(file);
  const made: string[] = [];
  for (const c of changed) {
    const last = c.commits[0]?.split(" ")[0] ?? c.head;
    if (state.tasked[c.file] === last) continue;
    const title = `OpenCLI changed ${c.file}: re-check the port`;
    const desc = [
      `Upstream ${UPSTREAM_REPO.replace(/\.git$/, "")} changed \`${c.file}\` since ${c.sha}${c.gone ? " (now gone: moved or deleted)" : ""}.`,
      "",
      `Routes ported from it: ${c.routes.join("; ")}.`,
      "",
      "Commits:",
      ...c.commits.map((l) => `- ${l}`),
      "",
      `See: git -C ~/.cache/autobrowse/opencli diff ${c.sha} origin/HEAD -- ${c.file}`,
      "Port what fixes our route, prove it live, then set `ported` to the new sha.",
    ].join("\n");
    await run(
      "backlog",
      ["task", "create", title, "-d", desc, "-l", "autobrowse,upstream", "--plain"],
      {
        // the desk runs in this repo; the board is its sibling
        cwd: process.env.BACKLOG_CWD ?? resolve(process.cwd(), "..", "tasks"),
      },
    );
    state.tasked[c.file] = last;
    made.push(title);
  }
  state.checkedAt = (o.now?.() ?? new Date()).toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return made;
}
