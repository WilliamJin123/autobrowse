import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leaseMs, TAKE_IDLE_MINUTES } from "../src/explore/lease.js";
import {
  closeLeftBy,
  type OpenSession,
  openSessions,
  type Post,
  portsStartedIn,
  stopMain,
} from "../src/explore/stop.js";

/** Claude Code transcript rows: a Bash call, then its result. */
const call = (id: string, command: string) =>
  JSON.stringify({
    timestamp: "2026-11-05T18:55:48.000Z",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
const result = (id: string, content: unknown, timestamp = "2026-11-05T18:56:05.000Z") =>
  JSON.stringify({
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

const session = (port: number, more: Partial<OpenSession> = {}): OpenSession => ({
  port,
  pid: process.pid,
  site: "scratch",
  held: false,
  startedAt: "2026-11-05T18:56:00.000Z",
  ...more,
});

/** A `send` that records what it got. */
const wire = (answer: (port: number, body: { cmd: string }) => { ok: boolean; body: string }) => {
  const sent: [number, Record<string, unknown>][] = [];
  const send: Post = async (port, body) => {
    sent.push([port, body as Record<string, unknown>]);
    return answer(port, body as { cmd: string });
  };
  return { sent, send };
};
const yes = () => ({ ok: true, body: '{"ok":true}' });

describe("the ports a transcript started", () => {
  it("reads start.sh and `explore --background`, with when each answered", () => {
    const t = [
      call(
        "a",
        'cd skills/autobrowse && scripts/start.sh tiktok "https://x.example" 9091 --headed 2>&1',
      ),
      result("a", "port 9091\nlog /tmp/autobrowse/explore-9091.log"),
      call("b", "autobrowse explore instagram --port 9092 --background"),
      result(
        "b",
        [{ type: "text", text: "exploring instagram on port 9092\nlog /tmp/x.log" }],
        "2026-11-05T19:00:00.000Z",
      ),
    ].join("\n");
    expect([...portsStartedIn(t)]).toEqual([
      [9091, "2026-11-05T18:56:05.000Z"],
      [9092, "2026-11-05T19:00:00.000Z"],
    ]);
  });

  it("leaves out a port another session had open, and output that only names a port", () => {
    const t = [
      call("a", "scripts/start.sh fanvue '' 9093"),
      result("a", "port 9093 already open"),
      // reading the script is no start
      call("b", "cat scripts/start.sh"),
      result("b", 'echo "port $PORT already open"\necho "port $PORT"'),
      call("c", 'scripts/cmd.sh 9094 \'{"cmd":"url"}\''),
      result("c", "port 9094"),
      "not json",
    ].join("\n");
    expect(portsStartedIn(t).size).toBe(0);
  });
});

describe("an agent that ended with sessions open", () => {
  const transcript = [call("a", "scripts/start.sh tiktok '' 9091"), result("a", "port 9091")].join(
    "\n",
  );

  it("closes the one it started, journal kept, and says why", async () => {
    const { sent, send } = wire(yes);
    const closed = await closeLeftBy(
      { agent_type: "browser" },
      { transcript, sessions: [session(9091), session(9095)], send },
    );
    expect(closed).toEqual([9091]);
    expect(sent).toEqual([
      [
        9091,
        {
          cmd: "close",
          keep: true,
          unlessPaused: true,
          why: "its agent ended with no stop (browser)",
        },
      ],
    ]);
  });

  it("leaves a held session, a paused one, and a port taken by another after it", async () => {
    const held = wire(yes);
    expect(
      await closeLeftBy(
        {},
        { transcript, sessions: [session(9091, { held: true })], send: held.send },
      ),
    ).toEqual([]);
    expect(held.sent).toEqual([]);

    const paused = wire(() => ({ ok: true, body: '{"ok":false,"paused":true}' }));
    expect(
      await closeLeftBy({}, { transcript, sessions: [session(9091)], send: paused.send }),
    ).toEqual([]);

    const taken = wire(yes);
    const later = session(9091, { startedAt: "2026-11-05T19:30:00.000Z" });
    expect(await closeLeftBy({}, { transcript, sessions: [later], send: taken.send })).toEqual([]);
    expect(taken.sent).toEqual([]);
  });
});

describe("autobrowse stop", () => {
  const run = async (argv: string[], sessions: OpenSession[] = [], answer = yes) => {
    const out: string[] = [];
    const { sent, send } = wire(answer);
    const code = await stopMain(argv, {
      out: (l) => out.push(l),
      send,
      sessions: () => sessions,
      session: "sess-1",
    });
    return { code, out, sent };
  };

  it("says the verdict, then closes", async () => {
    const r = await run(["9091", "failed", "the", "form", "refused"]);
    expect(r.sent).toEqual([
      [9091, { cmd: "done", outcome: "failed", summary: "the form refused" }],
      [9091, { cmd: "close" }],
    ]);
    expect(r).toMatchObject({ code: 0, out: ["closed explore 9091 (failed)"] });
  });

  it("with no port, closes this Claude session's one session", async () => {
    const r = await run(
      ["achieved"],
      [session(9091, { session: "sess-1" }), session(9092, { session: "other" })],
    );
    expect(r.sent.map(([port, b]) => [port, b.cmd])).toEqual([
      [9091, "done"],
      [9091, "close"],
    ]);
  });

  it("with no port and several open, names them and closes none", async () => {
    const r = await run(
      [],
      [session(9091, { session: "sess-1" }), session(9092, { session: "sess-1" })],
    );
    expect(r.code).toBe(2);
    expect(r.sent).toEqual([]);
    expect(r.out.join("\n")).toContain("autobrowse stop 9092");
  });

  it("outside Claude Code, no port is 9090, as `cmd` has it", async () => {
    const { sent, send } = wire(yes);
    const code = await stopMain([], {
      out: () => undefined,
      send,
      sessions: () => [],
      session: "",
    });
    expect([code, sent]).toEqual([0, [[9090, { cmd: "close" }]]]);
  });

  it("a close with no verdict says so only when the run had none", async () => {
    expect((await run(["9091"])).out).toEqual(["closed explore 9091"]);
    const open = await run(["9091"], [], () => ({ ok: true, body: '{"ok":true,"verdict":false}' }));
    expect(open.out).toEqual(["closed explore 9091 (no verdict: the run counts as unknown)"]);
  });

  it("a session already gone is no error", async () => {
    const r = await run(["9091", "achieved"], [], () => ({ ok: false, body: "" }));
    expect(r).toMatchObject({ code: 0, out: ["no explore session on 9091: already closed"] });
  });

  it("refuses a verdict it does not know", async () => {
    const r = await run(["9091", "maybe"]);
    expect(r.code).toBe(2);
    expect(r.sent).toEqual([]);
  });

  it("the hook never fails its agent", async () => {
    const out: string[] = [];
    const code = await stopMain(["--hook"], {
      out: (l) => out.push(l),
      stdin: async () => "not json",
    });
    expect([code, out]).toEqual([0, []]);
  });
});

describe("open sessions", () => {
  it("lists the info files whose process lives", () => {
    const dir = mkdtempSync(join(tmpdir(), "explore-stop-"));
    try {
      writeFileSync(join(dir, "explore-9092.json"), JSON.stringify(session(9092, { pid: 2 })));
      writeFileSync(join(dir, "explore-9091.json"), JSON.stringify(session(9091, { pid: 1 })));
      writeFileSync(join(dir, "explore-9093.json"), JSON.stringify(session(9093, { pid: 3 })));
      writeFileSync(join(dir, "explore-9094.json"), "{");
      writeFileSync(join(dir, "explore-9091.token"), "t");
      expect(openSessions(dir, (pid) => pid !== 3).map((s) => s.port)).toEqual([9091, 9092]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the lease", () => {
  const idle = 10 * 60_000;
  it("drops to the take time when the Claude session that started it is gone", () => {
    expect(leaseMs(idle, { paused: false, ownerGone: false })).toBe(idle);
    expect(leaseMs(idle, { paused: false, ownerGone: true })).toBe(TAKE_IDLE_MINUTES * 60_000);
    // a shorter idle time stays
    expect(leaseMs(60_000, { paused: false, ownerGone: true })).toBe(60_000);
  });
  it("a paused session waits on a person: four times as long, owner or not", () => {
    expect(leaseMs(idle, { paused: true, ownerGone: true })).toBe(idle * 4);
  });
});
