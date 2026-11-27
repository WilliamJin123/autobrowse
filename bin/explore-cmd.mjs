#!/usr/bin/env node
/**
 * `autobrowse cmd <json> [--port N]` with node builtins only: the explore wire
 * (token file, loopback POST) and nothing else. Same answer as the CLI's `cmd`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Must match `tokenFileFor` in src/explore/journal.ts (test/explore-cmd.test.ts). */
export const tokenFileFor = (port) => join(tmpdir(), "autobrowse", `explore-${port}.token`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

/** No --port: the caller's one open session (`minePort` in src/explore/stop.ts). */
export function minePort(
  me = process.env.CLAUDE_CODE_SESSION_ID,
  dir = join(tmpdir(), "autobrowse"),
  isAlive = alive,
) {
  const open = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^explore-\d+\.json$/.test(name)) continue;
    try {
      const info = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isAlive(info.pid) && (!me || info.session === me)) open.push(info);
    } catch {
      // half-written or gone
    }
  }
  if (open.length === 1) return open[0].port;
  if (open.length === 0)
    throw new Error("no explore session of yours is open: start one, or name its port (--port N)");
  open.sort((a, b) => a.port - b.port);
  throw new Error(
    `${open.length} sessions open: name one\n${open.map((s) => `  --port ${s.port}   # ${s.site}`).join("\n")}`,
  );
}

export async function postCmd(port, body) {
  const tokenFile = tokenFileFor(port);
  if (!existsSync(tokenFile))
    throw new Error(`no explore session on ${port}: autobrowse explore <site> --background`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/?wait=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`,
        // the run names the Claude Code session that drove it
        "x-claude-session": process.env.CLAUDE_CODE_SESSION_ID ?? "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    return { ok: res.ok, body: await res.text() };
  } catch (err) {
    // No answer: an act may have run. The same id again gets its answer, never a second act.
    return {
      ok: false,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        outcome: "unknown",
        hint: body?.id
          ? "send the same command with the same id: it answers what happened, it does not act again"
          : 'look before you act again; give each act an "id" so a resend is safe',
      }),
    };
  }
}

async function main(argv) {
  // `--mine`: print the caller's one session's port (cmd.sh with no port)
  if (argv[0] === "--mine") {
    try {
      console.log(minePort());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  const at = argv.indexOf("--port");
  const json = at < 0 ? argv[0] : argv.filter((_, i) => i !== at && i !== at + 1)[0];
  if (!json) {
    console.error("usage: autobrowse cmd '<json>' [--port N]");
    process.exit(2);
  }
  let port;
  try {
    port = at < 0 ? minePort() : Number(argv[at + 1]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!Number.isInteger(port)) {
    console.error("usage: autobrowse cmd '<json>' [--port N]");
    process.exit(2);
  }
  try {
    const res = await postCmd(port, JSON.parse(json));
    console.log(res.body);
    if (!res.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`autobrowse cmd ${json} failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
