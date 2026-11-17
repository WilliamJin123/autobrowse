# Autocomp: desktop sessions in autobrowse

WA-1411. Autocomp is autobrowse's desktop half: an agent drives any Mac app the way explore drives a page,
with the same journal, steering, overlay and compile. It is a working name for this design only: no new
package, no new bin. The commands live under `autobrowse desktop`.

Terms: a **ref** (`@s1:e4`) names one control in one snapshot. A **target** names a window (app plus a
title piece) or a control (role plus name, or native id) and outlives the run. **Headless** input goes to
the control through accessibility, with no pointer and no focus change; **headed** input is real keys and
clicks to the front window.

## Target state

- `autobrowse desktop start <name>` opens a desktop session on a loopback port. No browser. (Stage 2.)
- The agent sends one JSON command at a time, as in explore. It snapshots a window and gets refs.
  It clicks, types, presses keys, places windows and waits.
- Every act that works is journaled. `save` writes a recording. `compile` makes a workflow with
  only desktop steps. `autobrowse run <workflow>` replays it with no browser.
- The overlay draws over the window the agent acts on: the cursor flies to the control, and the
  panel shows the rows, Pause and the note box. (Stage 2.)
- A person's Pause holds the next command. A note rides the next answer. This works as it does in explore. (Stage 2.)
- Proof: the two-level demo film. A compiled desktop workflow (the director) types a prompt into
  Claude Code in Ghostty. That session drives autobrowse on X.

## Stages (proposed; the order is William's call)

- **Stage 1 (built):** the engine, the hands (record and replay), the compiler, and the film. The director is
  recorded once through explore's `os` command, which already journals desktop rows. Takes are compiled replays.
- **Stage 2 (built, William: "nah build it bro"):** the browserless session (D2), the overlay over any window (D7)
  and the CLI names (D9). The film does not need them: a take has no overlay or steering. Live proof (11-16,
  Calculator): Pause held a command, an unchanged Resume ran it, a person's press and note refused the next one
  with `changed` and `notes`.

## What existed before this work (2026-11-16, HEAD)

- `src/desktop/`: a `Desktop` interface with a JXA engine (`mac.ts`). Ops: apps, open, tree, click by role
  and name, type, key, shot, shell, root shell. No windows, no waits, no refs.
- Explore ran the ops as `{"cmd":"os","act":…}`, inside a browser session only.
- The journal had a `desktop` row (`recorder/types.ts`). `structure.ts` grouped desktop rows into a step.
- `autobrowse film <tape>` (`film/tape.ts`, `film/director.ts`): a ttyd terminal in a browser page that types,
  presses, waits for text and sleeps, and screencasts each inner browser. It cannot show the native overlay
  window, the real Claude Code TUI in Ghostty or both in one frame, so the film uses the real desktop and OBS.
- The overlay host (`native/overlay`, Rust and wry) follows any process's window (`Os::find(pid, rect)`).
  Its rect now comes from Chrome's CDP bounds only (`geometryOf`).
- `autobrowse obs start|stop` records the screen.

## Where the code is

- `src/desktop/types.ts`: the act schema (what the agent sends), the op schema (what the journal keeps), the
  `Desktop` engine interface, `fakeDesktop`. These are the source of truth for shapes; this doc does not copy them.
- `src/desktop/agent-desktop.ts`: the adapter. One CLI process per call; typed text goes by stdin.
- `src/desktop/hands.ts`: the policy. `act()` records (refs in, targets out); `run()` replays (targets in).
  The focus guard, the headed retry, waits and secrets live here, once, for both.
- `src/desktop/mac.ts`: `shell`, root shell, screenshot and file checks; the root helper.
- `compiler/structure.ts`, `render.ts`: desktop ops become outline ops, then `hands.run(...)` lines.
- `src/desktop/session.ts`: the browserless session (D2), `windowSurface` (D7). `src/explore/steer.ts`: the
  steering both sessions share. `src/explore/wire.ts`: command ids and repeats. Card: `map/objects/build/desktop-session.md`.
- Consumers of the op shape: explore's `os` command (`explore/server.ts`), autotrack import
  (`autotrack/import.ts`), the agent prompt (`agent/explorer.ts`). Old recordings with JXA-era desktop rows
  no longer parse: they are dropped, not migrated.

## Spike on this Mac (agent-desktop 1.3.1)

- Accessibility and Screen Recording are granted to the terminal. `list-windows` gives each window's
  id, pid, title, bounds and focus.
- A second Ghostty instance (`open -na Ghostty.app --args --title=…`) gets its own pid and windows.
  `move-window` and `resize-window` are verified. A headed `type` with `--interval-ms 40` landed in that
  window only, and none in the other Ghostty windows. A headed `press return` ran the line.
- A headless `type` into a terminal is refused (`POLICY_DENIED`: no semantic action, focus fallback denied).
  Terminals need headed input.
- `focus-window` said the target window had focus. `list-windows` then named a sibling window of the
  same pid. So the focus check compares pids, not window ids.
- `wait --text` takes an app name, not a window. Two Ghostty instances make it ambiguous. So waits poll our own snapshot.
- `launch <app> --no-attach` starts a new instance with its own pid (TextEdit: 3449, then 3463; Ghostty too).
- A new Ghostty instance restores the last session's windows beside its own: two windows, so the guard
  refuses. `--arg=--window-save-state=never` gives one.
- A Ghostty snapshot takes about 2.4 s. The terminal text is in `textfield` values.
- TextEdit after `launch`: no window (its Open panel is another process). Use a known-good app for tests.
- Snapshot nodes have `role`, `name`, `native_id`, `states`, `ref_id`; `--include-bounds` adds the rect.

## Decisions

### D1. Engine: agent-desktop, pinned

- npm `agent-desktop`, exact `1.3.1` (1.3.0 had breaking changes in a minor release). Its postinstall
  fetches a sha256-checked binary. pnpm 9 runs it.
- Called through its CLI, one process per command, JSON out. Never its MCP server.
- `agentDesktop()` implements `Desktop`. The JXA tree, click, type, key and open are deleted. One engine,
  no stale path. `shell` and the root helper stay ours: they are not accessibility.
- A host where the binary is missing or the OS has no desktop gets `noDesktop()`, as today.

### D2. Session shape (hard to change)

| Option | Shape | For | Against |
|---|---|---|---|
| A. Page optional in explore | `serve()` takes a page or none | One server | 251 `page` uses in 3,398 lines; every page command needs a guard; high regression risk |
| **B. Shared steering, own server** | Steering moves to `explore/steer.ts` with a `Scene` port; explore and the new `desktop/session.ts` both use it | One steering code; the desktop server stays small; explore keeps its tests | One refactor of explore's steering |
| C. Separate server, own steering | `desktop/session.ts` copies pause, hold and notes | No change to explore | Two copies drift; a fix lands in one |
| D. Desktop session = explore + a blank browser | Reuse explore as is | No new server | A 1–2 GB browser for nothing; page commands make no sense |

Priorities, in order: no regression in explore, one steering code, small blast radius. **B.**
`Scene` is what a resume compares: `where()` (url, or the front window's app and id; it may be async) and
`rows()` (aria rows, or the last act's window's AX rows without refs). Hand-act counting stays browser-only.
On the desktop, "the person acted" means the scene changed: `Scene.actedBy: "change"`.
A pause captures the scene (~0.5 s on the desktop); a resume waits for that capture, else it has nothing to compare.

### D3. Desktop ops

- The ops are in `types.ts` (`desktopActSchema`, `desktopOpSchema`). Looking (`windows`, `snapshot`, `shot`)
  is not journaled. Acting (`launch`, `click`, `type`, `key`, `place`, `focus`, `wait`, `waitFile`, `sleep`,
  `shell`) is.
- `window` is an id (`w-123`, one run) or a target. A target must match exactly one window, else the act fails.
- `launch {fresh:true}` starts an instance with its own pid: the only safe target for headed keys.
- `type {secret:"name"}` reads a stored value (`profile.phone`, `<site>.<detail>`) and types it by stdin.
  The journal keeps the name. At replay the secret comes from `deps.secrets`. Text that looks like a secret is refused.

### D4. Refs at record, targets at replay

- A ref belongs to one snapshot, so a workflow cannot store it. Hands keep each window's newest snapshot;
  a ref from an older one is refused as stale.
- The engine itself keeps older refs live (live check, 11-16: a ref from an older snapshot still clicks).
  So steering's own resume snapshot does not stale the agent's refs; hands still refuse them by their rule.
- At record, the journal stores the ref's target: window (app, title), control (role, name, native id).
  A control with no name and no id, or one whose target matches two controls, is refused at record.
- At replay, `find` gives a fresh ref. Native id ranks first. Zero or two matches fail the step, never a guess.

### D5. Headed input and the focus guard

- Default headless.
- A `POLICY_DENIED` refusal runs again headed, once, behind the guard. The journal row keeps `headed: true`;
  the replay goes headed at once, behind the guard.
- Guard: the window must be its pid's only window (so a `fresh` launch), then `focus-window`, then
  `list-windows` must show a focused window of that pid. Else the act fails and nothing is sent.
- A key to a window needs the only-window check even headless: a terminal takes a headless key, and it
  goes to the pid, not the window (live smoke, 11-16).

### D6. Waits

- `wait` polls the window's snapshot and matches in our process. `waitFile` polls for a file. Both answer
  `{found, afterS}`, never text: terminals are large and can hold secrets.
- A poll starts after the last snapshot ends, so a 2.4 s Ghostty snapshot never stacks.
- A wait on a terminal must not match the line the agent typed. Wait for a marker the prompt does not hold,
  or for a file. The skill says so.
- An agent's wait is capped at 600 s (`WAIT_MAX_S`): the explore client resends at 900 s. A replay has no
  socket, so its waits take the recorded timeout with no cap (a whole inner run).

### D7. Overlay over any window (stage 2, built)

- Geometry has two sources (`Surface<S>`). Page: CDP, as before (`pageSurface`). Window: `windowSurface`, the
  `list-windows` bounds and pid, with `view` equal to the bounds and `dpr` from the display under the window's center.
- The overlay host is a window too: the session leaves its pid out of every `windows` answer.
- Headed input runs with the overlay hidden (`hidden`), so a physical click never lands on the panel.
- Before the first act the overlay follows the front window, which may be another app.
- The panel's web view has no accessibility tree: an agent cannot press Pause by ref. Only a person can.
- Boxes and the cursor take the control's bounds from the snapshot, in screen points.
- The panel, Pause and note box are unchanged. The overlay follows the window of the last act.

### D8. Compile and run

- An outline may have only desktop steps. The run opens a browser only when a step asks
  (`flowRunner`, `browser/flow.ts`), so a desktop-only workflow starts none.
- Each outline op renders as one `hands.run({...})` line; typed text keeps the value kinds (plan field,
  secret, literal). A wait's text may be a plan field.
- The generated test seeds `fakeDesktop` with the windows and files the ops name.
- A desktop row has no page. Explore writes the page URL it was on (`page.url()`); autotrack import and the
  desktop session write `""`. A saved desktop session recording has site `desktop`.

### D9. Names (stage 2)

- No second bin. `autobrowse desktop start <name> [--port 9095] [--idle <s>] [--hold] [--fresh] [--no-overlay]`
  writes the same `explore-<port>.token` and `.json` files as explore, so `cmd.sh` and `stop.sh` work unchanged;
  `start.sh desktop:<name> "" <port>` starts one. Default port 9095.
- Journal: `<recordings>/.desktop-<name>/journal-port-<port>.jsonl`. A restart resumes it; `--fresh` drops it.
- Commands: `os`, `goal`, `note`, `pause`, `resume`, `journal`, `save`, `close` and the reads. A page command
  answers 400 "page commands need explore".

## The film (proof)

1. Record the director once through explore's `os`: OBS start (a `shell` op), launch a fresh Ghostty, place
   it on the left half, type the prompt, Return, wait for the inner run's marker file, OBS stop.
2. Compile it. Each take is `autobrowse try film-director --plan …` from the granted terminal: in process,
   no Restate, no desk worker (`run` goes through the desk, and a commit restarts it).
3. The inner Claude Code session runs explore headed on X: the profile edit, then the post.
4. A rehearsal plan stops before the post. The real take needs William's yes on the exact post text.
5. Before each take: free memory check (the last take was black under swap). OBS records the whole screen.
   Music is an OBS media source.

### Beats (William, 11-16)

1. Autocomp opens the Claude desktop app (not Ghostty) and types the prompt.
2. Claude runs autobrowse on X: the sign-in, with secrets shown as dots.
3. It scrolls X through a few computer-use demos.
4. It types draft 1, the long draft, into the composer.
5. Pause, then the steer note "make it way shorter and to the point", then Resume. Cmd+A and Backspace clear the draft (`key` command), and draft 2 is typed.
6. Post. Draft 2 is fixed text in the prompt, so William's yes covers the exact words.
7. Double reveal: the inner run compiles into a workflow on screen, then the camera pulls back to the autocomp workflow that typed the first prompt. No captions.

Layout (William, 11-17): the Claude app on the left half of the screen, Chrome with X on the right half.

Cut: profile edit, approval gate.

## Tests

- Adapter, offline: recorded agent-desktop envelopes as fixtures (ok, `STALE_REF`, `AMBIGUOUS_TARGET`,
  `WINDOW_NOT_FOUND`, `POLICY_DENIED`). A fake CLI runner returns them. Covers the headed retry, the focus
  guard, the secret by stdin and the target lookup.
- Hands (`test/desktop.test.ts`, on `fakeDesktop`): stale refs, refused targets, the guard, the headed retry,
  secrets by name, waits on a fake clock, ambiguous windows, replay.
- Compile round trip: the director's journal goes through outline and render; the module typechecks, and
  `runFlow` runs it on `fakeDesktop`.
- Explore `os` (`test/explore.test.ts`): snapshot, click by ref, the payment gate, a secret kept by name.
- Stage 2 (`test/desktop-session.test.ts`, fake desktop and fake host): held command and unchanged resume,
  refusal after a scene change and after a focus move, a resume during the capture, notes, the payment gate,
  page commands refused (400 on the wire), headed input hides the overlay, `aim` boxes relative to the window,
  window geometry, the overlay's window left out, journal and save, token files. The explore-steer tests pass unchanged.
- Adapter: a read that hits `APP_UNRESPONSIVE` is read once more; an act is never sent twice (live: 2 in 5 first
  snapshots of a background Calculator failed so).
- Live smoke, opt-in (`DESKTOP_LIVE=1`, `test/desktop-live.test.ts`; `DESKTOP_LIVE_INPUT=1` adds the typing), out of the gate: a Ghostty instance of its own, place, type,
  Return, wait for the echo, quit. Run by hand at hand-off.
- Film rehearsal: the director workflow on the real desktop, up to the post.

## Non-goals

- Windows and Linux live runs. The adapter is the same CLI; nobody tests it there yet.
- agent-desktop sandboxes (throwaway macOS VMs). Later, if a film needs a clean desktop.
- Counting a person's own desktop acts. The scene diff stands in.
- A cursor per agent.

## Risks

- agent-desktop is 9 months old with breaking minors. Pin exact; the offline fixtures catch shape changes on upgrade.
- One process per command: about 0.1–0.3 s each, 2.4 s for a big snapshot. Fine for a film. The C library is the later fix.
- Headed acts take focus from William while he works. Sessions say so at start. A film runs when he is away from the keys.

## Decision log

- 2026-11-16: Autocomp lives in autobrowse with agent-desktop as the engine (William: "A. is fine"). Rejected: our own engine (re-solves their logged edge cases), agent-desktop whole (two designs; no steering, secrets or compile).
- 2026-11-16: Session shape B, shared steering. Rejected A (blast radius), C (two copies), D (a browser for nothing).
- 2026-11-16: Refs never stored; targets found again at replay (D4).
- 2026-11-16: Headed only on refusal, behind a pid focus guard (spike: focus-window and list-windows disagree on the window).
- 2026-11-16: Wait answers found or not, never text (terminal text can hold secrets).
- 2026-11-16: The file wait is its own op, `waitFile`: a discriminated union refuses two `wait` members, and one meaning per word.
- 2026-11-16: Film on the real desktop with OBS, not the tape director: ttyd in a page cannot show the native overlay or the real Claude Code TUI.
- 2026-11-16: Takes run by `try`, not `run`: `run` goes through the desk worker, which a commit restarts.
- 2026-11-16: No `autocomp` bin: a second name for one CLI; the session reuses explore's token file.
- 2026-11-16: Old JXA-era desktop rows are dropped, not migrated (engineering bar: break compat).
- 2026-11-16: goldfish review: 39 findings (3 merged): 25 applied, 5 rejected (already in code or disproved by it), 6 wait on stage 2 or stay open questions (a menu or sheet as a find surface, pruning old snapshots); open: stage 2 now or after the film (William).
- 2026-11-16: Stage 2 built now, not after the film (William: "nah build it bro").
- 2026-11-16: Steering moved to `explore/steer.ts` (D2 B); a held command counts as sent before the resume whatever the clock says, and a resume waits for the pause's capture (both races seen in tests and live).
- 2026-11-16: Adapter reads retry once on `APP_UNRESPONSIVE`; acts never retry (a resent click is a second click).
