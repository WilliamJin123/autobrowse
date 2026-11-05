/**
 * `autobrowse stop`: the one way an agent ends an explore session (designs/2026-11-05-explore-stop.md).
 * Node builtins only: `bin/autobrowse stop` runs this file alone, ~0.1 s.
 *
 *   autobrowse stop [port] [achieved|failed] [why]   verdict, then close browser and socket
 *   autobrowse stop --hook                           Claude Code's SubagentStop hook (JSON on stdin)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tokenFileFor } from "./journal.js";
import { pidAlive } from "./lease.js";

/** `explore-<port>.json` beside the token file (`ExploreInfo` in `server.ts`). */
export interface OpenSession {
  port: number;
  pid: number;
  site: string;
  held: boolean;
  startedAt: string;
  /** The Claude Code session that started it. */
  session?: string;
}

/** Live explore sessions, by port. */
export function openSessions(
  dir = join(tmpdir(), "autobrowse"),
  isAlive = pidAlive,
): OpenSession[] {
  const out: OpenSession[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^explore-\d+\.json$/.test(name)) continue;
    try {
      const info = JSON.parse(readFileSync(join(dir, name), "utf8")) as OpenSession;
      if (isAlive(info.pid)) out.push(info);
    } catch {
      // half-written or gone: not a session
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

const STARTS = /start\.sh|autobrowse\b[^\n|;&]*\bexplore\b/;
/** `start.sh` prints `port N`; `explore --background` prints `exploring <site> on port N`. */
const STARTED = /^(?:exploring \S+ on )?port (\d+)$/m;

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string } & Record<
  string,
  unknown
>;

const textOf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map((x) => textOf((x as { text?: unknown }).text ?? "")).join("\n")
      : "";

/**
 * The ports an agent's transcript (Claude Code jsonl) started, each with when its last start
 * answered. A start that found the port open (`port N already open`) is someone else's session:
 * not listed.
 */
export function portsStartedIn(transcript: string): Map<number, string | null> {
  const starts = new Set<string>();
  const ports = new Map<number, string | null>();
  for (const line of transcript.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("tool_result")) continue;
    let blocks: Block[];
    let at: string | null;
    try {
      const row = JSON.parse(line) as { timestamp?: string; message?: { content?: unknown } };
      const content = row.message?.content;
      blocks = Array.isArray(content) ? (content as Block[]) : [];
      at = row.timestamp ?? null;
    } catch {
      continue;
    }
    for (const b of blocks) {
      if (b.type === "tool_use" && b.name === "Bash" && b.id) {
        if (STARTS.test(String((b.input as { command?: unknown })?.command ?? "")))
          starts.add(b.id);
      } else if (b.type === "tool_result" && b.tool_use_id && starts.has(b.tool_use_id)) {
        const m = STARTED.exec(textOf(b.content));
        if (m) ports.set(Number(m[1]), at);
      }
    }
  }
  return ports;
}

export type Post = (port: number, body: object) => Promise<{ ok: boolean; body: string }>;

/** One command to a session; a session that is gone answers `ok: false`. */
export const post: Post = async (port, body) => {
  const tokenFile = tokenFileFor(port);
  if (!existsSync(tokenFile)) return { ok: false, body: "" };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`,
        "x-claude-session": process.env.CLAUDE_CODE_SESSION_ID ?? "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: res.ok, body: await res.text() };
  } catch {
    return { ok: false, body: "" };
  }
};

/** What Claude Code gives a SubagentStop hook. */
export interface AgentEnded {
  agent_type?: string;
  agent_transcript_path?: string;
}

/**
 * Closes the sessions an ended agent started and left open. Left alone: a held session, a paused
 * one (it waits on a person), and one that started after the agent's own start answered (the
 * port was closed and taken by another). The journal stays, so a later start on the port
 * resumes the run.
 */
export async function closeLeftBy(
  ended: AgentEnded,
  deps: { sessions?: OpenSession[]; transcript?: string; send?: Post } = {},
): Promise<number[]> {
  const path = (ended.agent_transcript_path ?? "").replace(/^~(?=\/)/, homedir());
  const transcript =
    deps.transcript ?? (path && existsSync(path) ? readFileSync(path, "utf8") : "");
  const started = portsStartedIn(transcript);
  const closed: number[] = [];
  for (const s of deps.sessions ?? openSessions()) {
    if (!started.has(s.port) || s.held) continue;
    const answered = started.get(s.port);
    if (answered && Date.parse(s.startedAt) > Date.parse(answered)) continue;
    const res = await (deps.send ?? post)(s.port, {
      cmd: "close",
      keep: true,
      unlessPaused: true,
      why: `its agent ended with no stop (${ended.agent_type || "subagent"})`,
    });
    if (res.ok && !/"paused":true/.test(res.body)) closed.push(s.port);
  }
  return closed;
}

const OUTCOMES = new Set(["achieved", "failed"]);
const USAGE = 'usage: autobrowse stop [port] [achieved|failed] ["why"]';

/** Exit code. `out` gets what a person or an agent reads. */
export async function stopMain(
  argv: string[],
  deps: {
    out?: (line: string) => void;
    send?: Post;
    sessions?: () => OpenSession[];
    session?: string;
    stdin?: () => Promise<string>;
  } = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const send = deps.send ?? post;
  if (argv[0] === "--hook") {
    // A hook never fails its agent: any error is a session the lease closes later.
    try {
      const raw = await (deps.stdin ?? (async () => readFileSync(0, "utf8")))();
      await closeLeftBy(JSON.parse(raw) as AgentEnded, {
        ...(deps.sessions ? { sessions: deps.sessions() } : {}),
        send,
      });
    } catch {
      // nothing to say
    }
    return 0;
  }
  const args = [...argv];
  let port = /^\d+$/.test(args[0] ?? "") ? Number(args.shift()) : null;
  const outcome = args.shift();
  const summary = args.join(" ").trim();
  if (outcome !== undefined && !OUTCOMES.has(outcome)) {
    out(USAGE);
    return 2;
  }
  const me = deps.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  // Outside Claude Code: the default port, as `cmd` has it.
  if (port === null && !me) port = 9090;
  if (port === null) {
    const mine = (deps.sessions ?? openSessions)().filter((s) => s.session === me);
    if (mine.length === 0) {
      out("no explore session of this Claude session is open");
      return 0;
    }
    if (mine.length > 1) {
      out(`${mine.length} sessions open: name one`);
      for (const s of mine) out(`  autobrowse stop ${s.port}   # ${s.site}`);
      return 2;
    }
    port = (mine[0] as OpenSession).port;
  }
  if (outcome) {
    const said = await send(port, {
      cmd: "done",
      outcome,
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
    });
    if (!said.ok && said.body) out(said.body);
  }
  const res = await send(port, { cmd: "close" });
  if (!res.ok && !res.body) {
    out(`no explore session on ${port}: already closed`);
    return 0;
  }
  if (!res.ok) {
    out(res.body);
    return 1;
  }
  const unsaid = !outcome && /"verdict":false/.test(res.body);
  out(
    `closed explore ${port}${outcome ? ` (${outcome})` : unsaid ? " (no verdict: the run counts as unknown)" : ""}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await stopMain(process.argv.slice(2)));
