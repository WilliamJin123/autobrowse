---
type: object
cluster: app
universe: live
status: verified
verified: 2026-11-27 @ HEAD
entity: src/share/ports.ts
---

# Loopback port

The 127.0.0.1 port an explore, desktop or agent session listens on. One picker for all of them.

## Rules

- No `--port`: the first port from 9090 up that is free, unclaimed and has no dead session's journal of that site. A journal resumes only on the port you name.
- A pick is claimed: `$TMPDIR/autobrowse/port-<n>.claim` holds the claimer's pid, made with O_EXCL. Two starters never get the same port in the seconds before either listens. The session drops the claim once it listens (`server.ts`, `desktop/session.ts`). A dead pid's claim is taken over under `port-<n>.claim.lock`.
- A port by name keeps the old checks: open → `already open` (the caller's own session), held by a live pid → refused. Another starter's live claim → refused; the starter's own child passes (`AUTOBROWSE_PORT_CLAIM`).
- `cmd` and `stop` with no port go to the caller's one session: `session` in `explore-<port>.json` = `CLAUDE_CODE_SESSION_ID`. Outside Claude Code: the one open session.
- A child told its port by flag (ttyd, an eval's agent) takes `anyPort()`, the OS's pick.

## Shape

- `claimPort`, `releasePort`, `claimHolder`, `claimedByOther`, `portFree`, `anyPort` — `src/share/ports.ts`; `refuseClaimed` — `src/app/cli-record.ts`
- explore and `port` (start.sh) — `src/app/cli-record.ts`; desktop — `src/app/cli-desktop.ts`; agent sessions from 9100 — `src/agent/sessions.ts`
- own-session lookup — `mySessions`, `minePort` in `src/explore/stop.ts`; the fast `cmd` copy in `bin/explore-cmd.mjs`
- journals — `journalFileFor`, `desktopJournalFor`, `sessionJournalFor` in `src/explore/journal.ts`
- skill scripts — `.claude/skills/autobrowse/scripts/start.sh`, `cmd.sh`
- why and the options — `designs/2026-11-05-explore-stop.md` "Ports"
