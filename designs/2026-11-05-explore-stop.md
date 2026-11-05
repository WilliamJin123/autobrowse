# One stop for an explore session, and a close when its agent ends (WA-1105)

## Goal

An agent ends its browser session with one command the moment its work is done. A session an agent forgot closes when that agent ends, not 10 minutes later. Nobody kills a process by id.

## What was there

- Three ways to end: `{"cmd":"close"}`, the skill's `stop.sh`, `autobrowse browsers stop <port>`. None is `autobrowse stop`, the name an agent tries first.
- The lease closes a session after 10 minutes with no command. That was the only backstop.
- 14 of 58 explore runs in 7 days ended with no verdict: the agent left the session to the lease, or closed with no `done`.
- A session did not know who started it.

## Options

| Option | Verdict |
|---|---|
| A. One command: `autobrowse stop [port] [achieved\|failed] [why]` | **Chosen**. One name, on the PATH, printed by every start. Verdict and close in one call |
| B. Close on the agent's end: a SubagentStop hook, and a short lease when the Claude session is gone | **Chosen**, with A. An agent that forgets costs nothing. No rule in a prompt can promise that |
| C. A shorter lease for all (2 min) | No: an agent that thinks for 3 minutes loses its page. The lease stays the last backstop |
| D. More words in the skill | No: the words were there (`stop.sh`), and 14 of 58 runs skipped them |

Priorities, in order: no window stays open with nobody driving; a session a person works in is never closed; nothing new for the agent to remember.

## Shape

### `autobrowse stop`

- `stop <port> achieved|failed "why"`: sends `done`, then `close`. No verdict: close only, and the answer says the run counts as unknown.
- No port: the one session this Claude session started (`CLAUDE_CODE_SESSION_ID`). Several open: it lists them and closes none. Outside Claude Code: 9090, as `cmd` has it.
- A session already gone is exit 0.
- `src/explore/stop.ts`, node builtins only. `bin/autobrowse stop` runs it alone (0.2 s); the commander command calls the same `stopMain` (the npm package ships `dist`, not `bin`).
- Every start prints the stop line. `done` answers `close: "autobrowse stop <port>"`. `stop.sh` calls it.

### The agent ended

- `ExploreOptions.owner { session, alive }`: the CLI fills it from `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`. `session` goes in the info file (`explore-<port>.json`).
- `autobrowse stop --hook` is a SubagentStop hook in `~/.claude/settings.json`. It reads the agent's transcript, finds the ports that agent started (a `start.sh` or `explore` call whose result has the line `port N`), and sends each open one `close` with `keep` and `unlessPaused`.
- It leaves alone:
  - a held session (`--hold`, teach);
  - a paused session: `close` with `unlessPaused` answers `{ok:false, paused:true}`;
  - a port that another session took after the agent's start answered (the info file's `startedAt` is later);
  - a port the agent found open (`port N already open`).
- The journal stays: `start` on the same port resumes on the last page. The run ends `idle` with the summary "its agent ended with no stop".
- The Claude session itself exited (`CLAUDE_PID` gone): the lease drops from 10 minutes to 3 (`leaseMs`). A person at the window keeps it by loading pages. A paused session keeps its 40 minutes.
- The hook exits 0 on any error: the lease closes what it missed.

### The rule that changes for agents

A subagent's turn also ends when it reports a wall and waits for William. So: at a step a person must do, the agent sends `pause` before it reports (`browser` agent rule 6, `explore.md`). An agent that forgets loses the window, not the work: the journal resumes it.

## Edge cases

- The main session starts a session, a subagent drives it: the subagent did not start it, so its end does not close it.
- Two subagents, one port after the other: the start-time check keeps the first one's end from closing the second one's session.
- The main session ends its turn with a session open: no hook. The 10-minute lease holds while that Claude lives, 3 minutes once it exits.
- The desk's own sessions (`agent:<port>`) have no owner and no transcript: untouched.

## Decision log

- 2026-11-05: `autobrowse stop` and the close on an agent's end (William: "I would change that").
- 2026-11-05: The hook matches by transcript, not by a new `--agent` flag on start: `agent_id` is not in the shell's env, and an agent would have to pass it.
- 2026-11-05: Owner gone shortens the lease; it does not close at once. A person may still be at the window after Claude Code quits.
- 2026-11-05: The hook keeps the journal and gives no verdict. A guessed verdict would spoil `autobrowse success`.
