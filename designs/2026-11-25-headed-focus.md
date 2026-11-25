# Headed Chrome never takes the front (WA-1445)

A headed autobrowse Chrome must not take keyboard focus from the person's app: not at launch and not later in the session.

## Target state

- Launch: Chrome starts behind the person's app. No steal.
- Our own code opens no foreground tab and calls no `bringToFront`.
- A steal that the site causes (a `_blank` link, `window.open`, a popup) is undone by an event guard in under 300 ms, also while the person types or clicks in their own app.
- The person's own switch into Chrome (a click, Cmd-Tab) is followed, never fought.

## What we measured (2026-11-25, macOS 26, Chrome stable)

Scripts: session scratchpad `focus/exp*.mjs`.

| Case | Steals? |
|---|---|
| Playwright `launchPersistentContext` headed | yes, at 560 ms |
| `--no-startup-window` under Playwright | Playwright hangs |
| `open -g` with a startup window | yes |
| `open -g` + `--no-startup-window` + first window from CDP `background:true` | no |
| `responsibility_spawnattrs_setdisclaim` wrapper | no help |

The `open -g` protection ends 20-75 s after launch. After that:

| Action | Steals? |
|---|---|
| CDP `Target.createTarget` `background:true` (tab or window) | no |
| `Browser.setWindowBounds` (`window place`) | no |
| `_blank` click, `window.open`, popup | yes |
| `context.newPage()`, `page.bringToFront()` | yes |
| CDP `Target.activateTarget` | yes |

A background tab is not throttled under Playwright: `visibilityState` is `visible`, and rAF, timers, click, type and screenshots act as in the front tab.

A visible tab switch in Chrome on macOS always activates the app. No CDP call switches tabs quietly.

## Options

| | Option | Launch steal | Late steal | Cost |
|---|---|---|---|---|
| A | Launch relay (`open -g`) + quiet tabs + event guard | none | site-caused only, undone in 56-220 ms | a shim per launch; a JXA guard process per session |
| B | `connectOverCDP` to a Chrome we start with `open -g` | none | same as A | loses `launchPersistentContext` (profile lock, close, persistent context API); every caller changes |
| C | Guard only (poll the front app) | 560 ms, then undone | undone in 200-300 ms | none; the old shape |
| D | No visible window (headless + a screencast viewer) | none | none | the person cannot take over in a real window; breaks sign-in and person steps |

Priorities, in order: no keystroke lost to Chrome; the person can watch and take over; no change for callers; cost.

Choice: **A**. D is the only zero-steal option, but it takes away the window the person takes over in. B gives no gain over A and breaks the API.

## How it works

- `src/browser/background-launch.ts`: Playwright's `executablePath` is a shim. The shim starts Chrome with `open -g -n`, `--remote-debugging-port=0`, `--no-startup-window` and `--autobrowse-owner=<relay pid>`. It opens the first window with `background:true` and relays Playwright's NUL-framed pipe to the CDP websocket. A watchdog stops Chrome when the relay dies.
- `src/browser/session.ts`: launches through the relay. On failure it falls back to a plain spawn with a launch guard. After launch, a pid guard runs until `close()`.
- `src/browser/focus-guard.ts`: a JXA process watches `NSWorkspaceDidActivateApplicationNotification`. When our Chrome activates, the guard activates the person's app again. It stops after 6 restores in 5 s, so a page cannot cause a flash loop.
- Person or Chrome: a mouse click or a Cmd switch in the last 0.8 s can mean the person chose Chrome. The same input in the person's own app looks identical. So the session marks each new tab or window (`markNewTargets`, CDP target discovery); the mark is a file the guard reads. An activation within 1.5 s of a mark is Chrome's and is undone. With input and no mark, the guard looks again 150 ms later, then follows the person.
- Launch guard (no pid): only on the fallback launch. It treats any Chrome that started after it as ours, by `ps` age.
- `reap.ts` and `browsers.ts` find a Chrome's owner from `--autobrowse-owner`.
- Quiet tabs: the held write tab (`flow.ts`, used by watchers and armed prepares) and the owner render tab (`render.ts`) open with `backgroundPage` (CDP `background:true`). The person prompt no longer calls `bringToFront`; `offscreen(false)` puts the window back on screen behind the person's app.

## Known limits

- A site-caused steal still shows Chrome for 56-220 ms. Keys typed in that time go to Chrome. The time is in macOS: the note arrives in 0-150 ms, and `activateWithOptions` can block for up to 114 ms while Chrome is still activating.
- The launch guard (fallback launch only) is slower: 267-528 ms.
- The person clicks into Chrome in the same 1.5 s as a site opens a tab: the guard sends them back once. Their next click works.
- When a flow needs a person, the window comes back on screen but does not come to the front. The run waits for the person; nothing raises the window. Open for William: raise it on purpose (the guard would let a raise through only with a flag), or keep it quiet.
- `backgroundPage` falls back to `newPage` + `bringToFront` when CDP is not there (a context without CDP). That path steals.

## Decision log

- 2026-11-25: launch relay with `open -g` and a background first window. Launch steal gone (E4, L1, T1).
- 2026-11-25: the protection ends after 20-75 s (exp9). Added a pid guard for the whole session.
- 2026-11-25: polling guard (200-300 ms) replaced by the activation note (76-267 ms).
- 2026-11-25: the note observer must be kept in a variable. The center holds it weakly; after 4 notes, GC freed it and the guard went quiet.
- 2026-11-25: our own triggers cut: held tab and render tab go to `backgroundPage`; the person prompt does not call `bringToFront`.
- 2026-11-25: option D (no visible window) rejected: the person must be able to take over in a real window.
- 2026-11-25: a click or modifier in the person's own app read as "the person chose Chrome", and the guard let those steals stand. Added target marks.
- 2026-11-25: proof on the shipped path (`explore scratch --headed`, past 75 s): 24 site-caused steals, half right after a Shift tap. 24 undone, in 56-220 ms. Launch and `window place`: no steal. Launch guard: 3 of 3 undone, 267-528 ms.
