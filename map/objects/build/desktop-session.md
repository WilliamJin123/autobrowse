---
type: object
cluster: build
universe: live
status: verified
verified: 2026-11-16 (+ WA-1411 stage 2)
entity: src/desktop/session.ts
---

# Desktop session

A browserless session over any Mac window: the agent sends explore's JSON commands (`os`, `goal`, `note`, `pause`, `resume`, `journal`, `save`, `close`), the overlay draws over the window it acts on, and a person's Pause and notes steer it as in explore.

## Why this shape

Explore needs a page; a desktop task does not. The session is its own small server, and the steering is shared with explore (`steering()`), so a fix lands once. On the desktop "the person acted" means the window's rows changed (`actedBy: "change"`): a person's clicks in another app are not counted. Design: `designs/2026-11-16-autocomp-desktop.md` (D2, D7, D9).

## Shape

- `startDesktopSession(opts)` → `{exec, port, paused, done, resumedFrom}`; `DESKTOP_COMMANDS` (anything else answers 400 "page commands need explore") — `src/desktop/session.ts`
- `windowSurface(d)`: a window's bounds and pid as the overlay's geometry (`view` = bounds, `dpr` from the display under its center, `displayOf`) — `src/desktop/session.ts`
- Steering: `steering({scene, journal, held, takeNotes, busy, now, change, redact})`; `Scene {where, rows, short, key, noun, actedBy}` — `src/explore/steer.ts`
- Wire: `commandId`, `withRepeat`, `SENT_KEEP` (a resend with the same id answers the first answer) — `src/explore/wire.ts`
- Overlay over a window: `overlayFor<WindowHandle>`, `aim`, `hidden`, `hostPid` — `src/explore/overlay.ts`
- Overlay over a compiled run's desktop steps: `overlaidDesktop(desktop, {name})` wraps `Desktop`, one row per act, aims by `Desktop.bounds` — `src/desktop/overlaid.ts`; `try <workflow> --overlay`
- CLI: `autobrowse desktop start <name> [--port 9095] [--idle <s>] [--hold] [--fresh] [--no-overlay]` — `src/app/cli-desktop.ts`; `start.sh desktop:<name> "" <port>`

## State

- Token and info files: explore's (`$TMPDIR/autobrowse/explore-<port>.{token,json}`), so `cmd.sh` and `stop.sh` work unchanged; removed on close.
- Journal: `<recordings>/.desktop-<name>/journal-port-<port>.jsonl`; rows have `url: ""`. A restart resumes it; `--fresh` drops it.
- `save` writes a recording with site `desktop`.

## Connected to

- **uses:** [[desktop-hands]] (`act`, `peek`, `headed`), [[approval]] (`PendingApprovals` on a click that spends)
- **shares-with:** [[explore-session]] (steering, wire, overlay, token files)
- **writes:** [[recording]]

## If you change this

- **Hits:** `src/explore/steer.ts` changes both sessions: run `test/explore-steer.test.ts` and `test/desktop-session.test.ts`.
- **Does not hit:** the page leg, compiled replays (they use hands, not the session).

## Live findings (11-16, Calculator)

- The overlay's web view has no accessibility tree: Pause cannot be pressed by ref. Proof injects panel events at the host seam (`overlayDeps.host`).
- A pause captures the window (~0.5 s). A resume waits for that capture, else it has nothing to compare.
- Before the first act the overlay draws over the front window, which may be another app.
