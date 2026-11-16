---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-11-16 @ cf4fbd4 (+ WA-1411)
entity: src/desktop/hands.ts
---

# Desktop hands

Acts on any Mac app's windows through agent-desktop (pinned 1.3.1): one policy for the agent's acts (record) and a workflow's ops (replay).

## Why this shape

A ref (`@s1:e4`) lives one snapshot in hands (the engine keeps older refs live, so another snapshot, such as steering's, does not stale the agent's), so the journal keeps targets (window app plus title piece; control role plus name or native id) and a replay finds them again. Terminals refuse background input, so headed input exists, and it goes only to a window that is its pid's only window and has focus. Design: `designs/2026-11-16-autocomp-desktop.md`.

## Shape

- Act schema (agent sends), op schema (journal keeps), `Desktop` engine interface, `fakeDesktop`, `fakeWindow` — `src/desktop/types.ts`
- `desktopHands(d, {secret, looksSecret, gateClick, sleep, now, windowTries})` → `act` (refs in, `{answer, op, window, box}` out), `run` (op in), `guard`, `windowFor` — `src/desktop/hands.ts`
- Adapter: one CLI process per call, typed text by stdin, error envelopes → `DesktopError {code, notDelivered}`; a read (snapshot, find, windows) tries once more on `APP_UNRESPONSIVE`, an act never — `src/desktop/agent-desktop.ts`
- Shell, root helper, screenshot, file checks; `localDesktop()` (no binary or not a Mac → `noDesktop`) — `src/desktop/mac.ts`
- One line per op for a person — `src/desktop/describe.ts`

## Connected to

- **owned-by:** [[explore-session]] (`os` command, `osHands`), [[desktop-session]] (`os` without a browser), [[compiled-workflow]] (`deps.desktop`, rendered `hands.run`)
- **joins:** [[recording]] (`desktop` rows), [[outline]] (desktop step ops), [[autotrack-session]] (import writes the op shape), [[approval]] (`gateClick` on a click that spends)
- **looks-like-but-is-not:** [[human-hands]] (page pointer and keys), [[hints]] (page controls)

## If you change this

- **Hits:** `src/explore/server.ts` (`os`, `desktopAnswer`), `src/compiler/{structure,render,lint,outline}.ts`, `src/autotrack/import.ts`, `src/agent/explorer.ts` (prompt lines), `.claude/skills/autobrowse/explore.md`, `test/desktop.test.ts`, `test/explore.test.ts`.
- **Does not hit:** the page leg, locators.

## Surfaces

| Surface | Role |
|---|---|
| explore `os` | records |
| `autobrowse desktop start` | records, with the overlay and steering |
| compiled workflows | replays |
| `autobrowse desktop` CLI | reads (windows, snapshot) |

## See

- Live smoke: `DESKTOP_LIVE=1 DESKTOP_LIVE_INPUT=1 vitest run test/desktop-live.test.ts`
