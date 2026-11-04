# Overlay out of the page

2026-11-04, WA-1035. William 11-03: "truly won't break on edge cases, is truly not visible, doesn't fire anything, and is purely an overlay that we can view."

## What is wrong today

The panel and the boxes are a node in the page: a closed shadow root on `<html>`, drawn by `page.evaluate`.

- The page can find it: `document.documentElement.lastChild`, a MutationObserver, a `window.__data-o…` global.
- The page can break it: Trusted Types dropped its buttons, and our portal's `style-src` dropped its styles (both patched 11-03). Frame-busting and full-screen apps have their own cases.
- Its own scripts run in the page's main world, so a getter trap on `innerHeight` sees each draw.
- It shares the page's pointer. So it swallows events in a capture listener, stops `mousedown` so focus stays, goes inert when an act's target is under it (`aim`, `held`, `READS_ONLY`, `AIMED`), and comes off for every screenshot (`bare`, `drawsOn`).

## Target state

- No node, style, global or main-world script of ours in any page.
- Panel and boxes are drawn by a native macOS window, glued over the Chrome window's viewport.
- The page's geometry is read through CDP in an isolated world. A main-world getter never runs.
- A person's click on the panel never reaches the page. An agent's press (CDP input) never meets the panel. So the inert logic goes.
- Screenshots and films are CDP captures of the renderer. An OS window is never in them, so `bare` and `drawsOn` go.
- The panel keeps its look, buttons, drag, corner grips, left-edge tab and trace (AC #5). The host changes; the design does not.

## Options

### Where the panel lives

| Option | Verdict |
|---|---|
| A. Native window: a non-activating `NSPanel` (never key), transparent, above Chrome's window, a WKWebView with today's panel HTML. One Swift helper per session, JSON lines on stdin/stdout | **Chosen**. Nothing in the page; a click on it takes no focus from Chrome (no `blur`); not in CDP shots; CSP and Trusted Types do not apply |
| B. A second Chrome window in the same browser (`Target.createTarget`) at our own origin | No: a click on it makes Chrome's page window lose focus (`blur`, `visibilitychange`); Playwright sees it as a page (page lists, popup logic); it shares the profile's cookies and history |
| C. A Chrome extension side panel | No: branded Chrome 137+ ignores `--load-extension`; the side panel narrows the viewport, so layout and shots change |
| D. Stay in the page, script in an isolated world | No: still a DOM node the page can find (fails AC #1 by construction) |
| E. Electron window | No: it cannot order itself just above another app's window, only always-on-top over every app; clicks activate it; about 200 MB for one panel |

### What draws the boxes

| Option | Verdict |
|---|---|
| A. The same native window: a click-through region over the viewport, boxes at the CDP-measured rects | **Chosen**. Numbered boxes in mark colours and the target ring, as today |
| B. DevTools `Overlay.highlightQuad` / `highlightNode` | No: one highlight at a time, no labels; covers the target flash, not N numbered boxes. Two drawing paths for one layer |

Ranked by: nothing in the page (AC #1, #3) over cross-platform reach over new code.

## Why native code

No open-source framework glues a window above another app's window, follows it, and stays click-through except over one region. Electron and Tauri give always-on-top windows only. The helper is about 300 lines of Swift: AppKit placement, a CGWindowList follower and WKWebView. All drawing stays in the panel's HTML.

## How it works

- `assets/overlay/host.swift`, compiled once by `swiftc` into `~/Library/Caches/autobrowse/overlay-host-<hash>`. Missing `swiftc` or not macOS: the overlay is off and says why.
- Node spawns it on the first draw and sends `html`, then `js` (`ui.draw`), `target` and `view` lines. The helper sends back `js` (the panel's prefs), `found`/`lost` and `moved` (Chrome's size changed).
- **Which Chrome window:**
  - The helper takes the browser pid. Node reads it over CDP (`SystemInfo.getProcessInfo`, type `browser`).
  - The helper takes the page's window bounds from `Browser.getWindowForTarget`.
  - It picks the CG window of that pid with those bounds. Then it follows that window number at 30 Hz.
  - Several Chromes run at once (the desk, other sessions, William's own). Matching by pid keeps them apart.
- **Viewport in the window:**
  - Node reads `outerHeight - innerHeight·zoom`, the right inset and the zoom in an isolated world (`Page.createIsolatedWorld`).
  - It reads again on each draw and on `{moved}`. Infobars, full screen and DevTools change these.
- **Order:**
  - The overlay window sits just above the Chrome window (`order(.above, relativeTo:)`), at the normal level. Other apps cover it as they cover Chrome.
  - It hides when Chrome's window is off screen: minimized, or on another Space.
  - It joins full-screen Spaces (`fullScreenAuxiliary`).
- **Pointer:**
  - The window ignores the mouse except over the panel's rect. The panel's JS reports that rect after each paint.
  - The helper flips `ignoresMouseEvents` from the mouse position at 60 Hz, and holds it during a drag.
  - The panel posts its rect again when an animation ends: a rect read mid-slide is not where it lands.
- **Lifetime:**
  - The helper exits on stdin EOF, and when its parent dies (it checks `getppid()`).
  - `remove()` and session close end it. No process of ours stays.

## Limits

- **macOS only:** headed runs are on this Mac, and headless draws nothing today. Linux and Windows headed runs get no overlay. The decision log names this.
- **Boxes are a snapshot in viewport coordinates,** as today. A scroll after the lookup leaves them where they were until the next act.
- **The overlay follows only the page explore drives.** Another tab in front shows the same overlay.
- **Screen captures show it.** The window has no `sharingType = .none`, so William can record it. autobrowse's own shots are CDP captures and never hold it.

## Tests

- **AC #1, #3:**
  - A page with traps: a MutationObserver, getters on `innerHeight`, `outerHeight` and `screenX`, and listeners for focus, blur, pointer and scroll.
  - It runs with the overlay on and a fake host.
  - Every trap stays at 0.
- **AC #2:** a strict-CSP and Trusted Types page, and a page in full screen. The fake host gets draws and geometry; full screen gives top inset 0.
- **AC #4:** a screenshot with the overlay on is byte-equal to one with it off.
- **AC #5:** the panel HTML in a plain page: every button toggles its pref and posts it.
- **Fake host:** a second Playwright page plays the window. `html` loads by navigation (init scripts stub `webkit.messageHandlers`), `js` runs by evaluate. The flow test uses a recorder that runs `ui.draw` lines against a plain object.
- **Live:**
  - Click every panel button in a headed explore.
  - `document.hasFocus()` stays true and no `blur` fires.
  - The boxes sit on their controls.

## Decision log

- 2026-11-04: Panel and boxes in one native macOS window (A/A). Out of the page, not hardened in it. Rejected: a second Chrome window (focus), an extension side panel (Chrome 137 flags, viewport), an isolated world (still a node), Electron (cannot sit above one window), the DevTools Overlay domain for boxes (one highlight, no labels).
- 2026-11-04: macOS only. Linux and Windows headed runs draw nothing; no one runs those today.
- 2026-11-04: `bare`, `drawsOn`, `hold`, `around` and the inert/aim logic are deleted: an OS window is never in a CDP shot and never takes a CDP press.
- 2026-11-04: Visible to screen capture (no `sharingType = .none`): William views and records it; CDP shots never include it anyway.
