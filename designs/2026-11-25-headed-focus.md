# Headed Chrome takes the front for at most 220 ms (WA-1445)

Status 2026-11-26: the goal is not met. The last live proof undid 2 to 3 of 6 steals (decision log). The live view (`designs/2026-11-26-live-view.md`) replaces the headed window on a Mac.

A headed autobrowse Chrome must not take the person's keyboard at launch. Later in the session, a steal that a site causes may hold the front for at most 220 ms. Keys typed in that time can go to Chrome.

## Target state

- Launch: Chrome starts behind the person's app. No steal.
- Our own code opens no foreground tab and calls no `bringToFront`.
- A site-caused steal (a `_blank` link, `window.open`, a popup) is undone in at most 220 ms, also while the person types or clicks in their own app.
- The person's own switch into Chrome (a click, Cmd-Tab) is followed, never fought.

## Non-goals

- Zero steals after launch. macOS lets Chrome activate itself on a new tab; only no window at all stops that (option D).
- Raising the window for a person step (open decision 2).
- One guard per Mac. Each session runs its own; guards skip each other's Chrome.
- Linux and Windows. The relay and the guard are Mac only; elsewhere the launch is plain.

## What we measured (2026-11-25, macOS 26, Chrome stable)

Scripts: session scratchpad `focus/exp*.mjs`.

| Case | Steals? |
|---|---|
| Playwright `launchPersistentContext` headed | yes, at 560 ms |
| `--no-startup-window` under Playwright | Playwright hangs |
| `open -g` with a startup window | yes |
| `open -g` + `--no-startup-window` + first window from CDP `background:true` | no |
| `responsibility_spawnattrs_setdisclaim` wrapper | no help |

The `open -g` protection ends 20-75 s after launch; in one run it held past 80 s. After that:

| Action | Steals? |
|---|---|
| CDP `Target.createTarget` `background:true` (tab or window) | no |
| `Browser.setWindowBounds` (`window place`) | no |
| `_blank` click, `window.open`, popup | yes |
| `context.newPage()`, `page.bringToFront()` | yes |
| CDP `Target.activateTarget` | yes |

Which new targets carry an opener (CDP `targetInfo.openerId`): site tabs and popups do, `rel=noopener` too. Our `background:true` tabs do not.

A background tab is not throttled under Playwright: `visibilityState` is `visible`, and rAF, timers, click, type and screenshots act as in the front tab.

A visible tab switch in Chrome on macOS always activates the app. No CDP call switches tabs quietly.

A hidden app (System Events `visible` false) stays hidden through page work, but the next new tab or window shows it again (exp19). In a second run (exp18) no trigger stole at all, visible or hidden, plain launch included: when macOS lets Chrome take the front depends on state we have not pinned down. The guard covers both cases.

## Options

| | Option | Launch steal | Late steal | Cost |
|---|---|---|---|---|
| A | Launch relay (`open -g`) + quiet tabs + event guard | none | site-caused only, undone in 56-220 ms | a shim and a NUL-pipe relay per launch; a JXA guard per session; CDP on a localhost port |
| B | `connectOverCDP` to a Chrome we start with `open -g` | none | same as A | no shim or relay; but proxy, `recordHar`, the window size and the launch args move to our own spawn, and we close Chrome ourselves; CDP on a localhost port |
| C | Guard only, polling the front app (the old shape) | 560 ms, then undone | undone in 200-300 ms | no relay |
| C2 | Guard only, event driven, no relay | 560 ms, then undone in about 300 ms | undone in 56-220 ms | no relay; one launch steal per session |
| D | No visible window (headless + a screencast viewer) | none | none | the person cannot take over in a real window; breaks sign-in and person steps |
| E | Hidden app (`appHider`) unless a person step runs | none (with the relay) | same as A: a new tab or window shows the app again | re-hide after each new target; the person cannot watch |

Priorities, in order:

1. The person can watch and take over in a real window.
2. Keys go to Chrome for at most 220 ms per steal, and only on site-caused steals.
3. No change for callers.
4. Cost.

Choice: **A**. D is the only zero-steal option, but it fails priority 1. C and C2 fail 2 at launch. B gives the same result as A and moves launch options (proxy, `recordHar`, window size) into our own code; callers keep `Session` in both. E adds nothing: a new target shows a hidden Chrome again, and a hidden window fails priority 1.

## How it works

- `src/browser/background-launch.ts`: Playwright's `executablePath` is a shim. The shim starts Chrome with `open -g -n`, `--remote-debugging-port=0`, `--no-startup-window` and `--autobrowse-owner=<relay pid>`. It opens the first window with `background:true` and relays Playwright's NUL-framed pipe to the CDP websocket. A watchdog stops Chrome when the relay dies.
- `src/browser/session.ts`: launches through the relay. On failure it reaps orphan Chromes of the profile and launches plain: one launch steal, no guard until launch ends. After launch, a pid guard runs until `close()`. No pid: logged, no guard.
- `src/browser/focus-guard.ts`: a JXA process watches `NSWorkspaceDidActivateApplicationNotification`. The decisions are two pure functions, `onActivated` and `onWaiting`, spliced into the script with `toString` and unit tested. When our Chrome activates unasked, the guard activates the person's app again. It pauses after 6 restores in 5 s, so a page cannot cause a flash loop. Another autobrowse Chrome (`--autobrowse-owner` in its `ps` command) is never taken as the person's app, so two guards do not pass the front back and forth.
- Person or Chrome: a left or right click, or any modifier with no later key, in the last 0.8 s can mean the person chose Chrome. The same input in the person's own app looks identical. So the session marks each new target that has an opener (`markNewTargets`, CDP target discovery); the mark is a file the guard reads.
- Quiet tabs: the held write tab (`flow.ts`), the owner render tab (`render.ts`) and every pooled read tab (`profile-pool.ts`) open with `backgroundPage` (`own-tabs.ts`, CDP `background:true`). The person prompt no longer calls `bringToFront`; `offscreen(false)` puts the window back on screen behind the person's app. `offscreen(true)` hides the app every time, because a popup shows a hidden Chrome again.
- `reap.ts` and `browsers.ts` find a Chrome's owner from `--autobrowse-owner`.

### Input × mark

What the guard does when our Chrome activates:

| Input in the last 0.8 s | Mark in the last 1.5 s | Result |
|---|---|---|
| none | any | restore |
| click or modifier | yes | restore (a site tab) |
| click or modifier | none yet | wait up to 1.5 s: a mark comes → restore; none → follow the person |
| any, Chrome already the person's app | any | nothing |

## Risks

- CDP moves from Playwright's private pipe to a localhost port, open for the whole session on signed-in profiles. Any local process can read `DevToolsActivePort` and attach with no auth. Accepted: a process that runs as William can already read the profile folder and its cookies.
- The cap pauses the guard: a page that opens more than 6 tabs in 5 s keeps the front until the window passes.
- A wait with no mark ends in "follow the person". A site tab whose CDP note is later than 1.5 s keeps the front.
- `backgroundPage` falls back to `newPage` + `bringToFront` when CDP fails. That path steals. Kept: the tab opens either way, and reliability comes first.

## Known limits

- A site-caused steal still shows Chrome for 56-220 ms. The time is in macOS: the note arrives in 0-150 ms, and `activateWithOptions` can block for up to 114 ms while Chrome is still activating.
- The person clicks into Chrome in the same 1.5 s as a site opens a tab: the guard sends them back once. Their next click works.
- The fallback launch (relay failed) steals once, at about 560 ms.

## Open decisions for William

1. The goal wording. This doc puts take-over first and accepts up to 220 ms of lost keys per site-caused steal. If no lost key ranks first, D wins, and the person loses the real window. Recommendation: keep A.
2. The person step. When a flow needs a person, the window comes back on screen but stays behind the person's app. Raise it on purpose (the guard lets one raise through), or keep it quiet? Recommendation: keep it quiet; the run already tells him.

## Decision log

- 2026-11-25: launch relay with `open -g` and a background first window. Launch steal gone (E4, L1, T1).
- 2026-11-25: the protection ends after 20-75 s (exp9). Added a pid guard for the whole session.
- 2026-11-25: polling guard (200-300 ms) replaced by the activation note (76-267 ms).
- 2026-11-25: the note observer must be kept in a variable. The center holds it weakly; after 4 notes, GC freed it and the guard went quiet.
- 2026-11-25: our own triggers cut: held tab and render tab go to `backgroundPage`; the person prompt does not call `bringToFront`.
- 2026-11-25: option D (no visible window) rejected: the person must be able to take over in a real window.
- 2026-11-25: a click or modifier in the person's own app read as "the person chose Chrome", and the guard let those steals stand. Added target marks.
- 2026-11-25: proof on the shipped path (`explore scratch --headed`, past 75 s): 24 site-caused steals, half right after a Shift tap. 24 undone, in 56-220 ms. Launch and `window place`: no steal. Launch guard: 3 of 3 undone, 267-528 ms.
- 2026-11-25: goldfish review: 30 findings, 14 applied, 16 rejected; open: the goal wording against D, and whether a person step raises the window.
- 2026-11-25: after review: rules moved into pure functions; marks only for targets with an opener; a pending activation waits up to 1.5 s for a mark; guards skip other autobrowse Chromes; the no-pid launch guard is gone (the fallback reaps and launches plain); pooled read tabs open in the background; `backgroundPage` moved to `own-tabs.ts`.
- 2026-11-25: live proof after the review fixes, on an unlocked Mac: FAILED. Idle: 3 of 6 site steals undone; with marks: 2 of 6. A hidden Chrome still takes the front. Unit tests pass (33). The guard stays as a best effort; the headed path moves to the live view (`designs/2026-11-26-live-view.md`): headless Chrome has no window to take the front.
