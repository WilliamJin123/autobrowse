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
- Panel and boxes are drawn by a native window, glued over the Chrome window's viewport. macOS, Windows and Linux X11 (WA-1042).
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

No open-source framework glues a window above another app's window, follows it, and stays click-through except over one region. Electron and Tauri give always-on-top windows only. No cross-platform API orders a window above another app's window, so the window code is per OS.

The host is Rust (`native/overlay`): wry for the webview (WKWebView, WebView2, WebKitGTK), one core for the protocol, follow and pointer logic, and one small adapter per OS. All drawing stays in the panel's HTML, so the look is the same on every OS.

| | macOS | Windows | Linux |
|---|---|---|---|
| Window | own `NSPanel` subclass (objc2): never key, non-activating | plain Win32 popup: `WS_EX_NOACTIVATE`, `MA_NOACTIVATE`, every move `SWP_NOACTIVATE` | GTK popup, X11 only: override-redirect, so the window manager never maps, focuses or frames it |
| Chrome's window | CGWindowList, by pid and bounds | `EnumWindows`, by pid and bounds (DIPs) | `_NET_CLIENT_LIST` and `_NET_WM_PID` |
| Order | `orderWindow(.above, relativeTo:)` | inserted after the window above Chrome's | restacked above Chrome's frame (`XConfigureWindow`, sibling) |
| Viewport | insets from `view` | Chrome's render child window (`Chrome_RenderWidgetHostHWND`), else insets | insets from `view`, less Chrome's own frame border |
| Click-through | `ignoresMouseEvents` | `WS_EX_TRANSPARENT \| WS_EX_LAYERED` | an empty input shape |
| Cursor | `NSEvent.mouseLocation` | `GetCursorPos` | X pointer query |

- No tao on any OS:
  - macOS: tao's launch calls `activateIgnoringOtherApps`, which takes focus from Chrome (a `blur` in the page).
  - Windows: tao clears its no-focus flag after build; each later style change (click-through on and off) calls `ShowWindow(SW_SHOW)`, which activates.
  - Linux: tao's windows are managed by the window manager, which may focus them on map.
- Windows: not owned by Chrome's window. A cross-process owner attaches the two input queues, so a stall in the host would stall Chrome's input.
- Linux: every Xlib call runs in a gdk error trap. Chrome's window can go at any time, and Xlib's default error handler ends the process.

## How it works

- **The binary:**
  - The npm package carries one per platform in `assets/overlay/bin/<platform>-<arch>/`. CI builds them; the release job puts them in before `npm publish`. No compiler on the user's machine.
  - A checkout has none: the first overlay use runs `cargo build --release` (minutes, cold) into the user cache, keyed by a hash of the crate. Later uses start at once.
  - `pnpm build` and the gate never run cargo. The desk runs headless and never needs Rust.
  - Platforms: darwin-arm64, darwin-x64, win32-x64, win32-arm64, linux-x64, linux-arm64 (`.github/workflows/overlay.yml`).
  - No binary, no X11 (Wayland), or a host that dies before `ready` (15 s): the overlay is off and `why` says which.
  - Linux needs the WebKitGTK 4.1 runtime library and a compositing window manager (else the clear panel paints black). Without either the host exits and `why` gives its first error line.
- Node spawns it on the first draw and sends `html`, then `js` (`ui.draw`), `target` and `view` lines. The helper sends back `js` (the panel's prefs), `found`/`lost` and `moved` (Chrome's size changed).
- **Which Chrome window:**
  - The helper takes the browser pid. Node reads it over CDP (`SystemInfo.getProcessInfo`, type `browser`).
  - The helper takes the page's window bounds from `Browser.getWindowForTarget`.
  - It picks the OS window of that pid with those bounds. Then it follows that window at 30 Hz.
  - A host that finds no window in 3 s sets `why` ("cannot find Chrome's window (Wayland?)"); a later `found` clears it. Headed Chrome on Linux starts with `--ozone-platform=x11`, so on a Wayland desktop it runs on XWayland, where the host finds it.
  - Several Chromes run at once (the desk, other sessions, William's own). Matching by pid keeps them apart.
- **Viewport in the window:**
  - Node reads `outerHeight - innerHeight·zoom`, the right inset and the zoom in an isolated world (`Page.createIsolatedWorld`).
  - It reads again on each draw and on `{moved}`. Infobars, full screen and DevTools change these.
  - A horizontal gap of 16 px or less is Chrome's own frame border (Linux, not maximized): the same on the left, right and bottom. A wider gap is a side pane, taken as frameless.
- **Order:**
  - The overlay window sits just above the Chrome window (`order(.above, relativeTo:)`), at the normal level. Other apps cover it as they cover Chrome.
  - It hides when Chrome's window is off screen: minimized, or on another Space.
  - It joins full-screen Spaces (`fullScreenAuxiliary`).
- **Pointer:**
  - The window ignores the mouse except over the panel's rect. The panel's JS reports that rect after each paint (`webkit.messageHandlers.host`; the host maps it onto wry's `ipc`).
  - The helper flips `ignoresMouseEvents` from the mouse position at 60 Hz, and holds it during a drag.
  - The panel posts its rect again when an animation ends: a rect read mid-slide is not where it lands.
- **Lifetime:**
  - The helper exits on stdin EOF, and when its parent dies (it checks the parent pid on unix).
  - It exits 2 s after EOF even when its UI thread is stuck (a full stdout pipe).
  - `remove()` and session close end it. A context closed while the host starts ends it too. No process of ours stays.
- **Memory:**
  - macOS: every AppKit and CoreFoundation object is a `Retained`/`CFRetained`, released on drop; each event runs in an autorelease pool.
  - Linux: every Xlib buffer (`XGetWindowProperty`, `XQueryTree`) is freed where it is read.
  - js queued before the page loads is capped at 1024.
  - Soaks: macOS 60 s (60 Hz follow, 6000 evals) keeps RSS flat, and `leaks` finds only WebKit's own XPC cycles, the same as the old Swift host. Linux 90 s (10,300 evals, re-finds, show and hide, click-through on and off) keeps RSS within 0.5 MB.

## Limits

- **No Wayland:** a Wayland client cannot place or stack its window over another app's. The host runs on X11 (`GDK_BACKEND=x11`); with no `DISPLAY` the overlay is off and says why.
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
- **Live (`native/overlay/smoke.ts`, in CI per platform):**
  - Headed Chrome, the shipped binary, real OS clicks (xdotool, `SendInput`).
  - The host finds Chrome's window. The theme, look and minimize buttons and the tab work.
  - `document.hasFocus()` stays true; the page sees no `blur` and no pointer event from a panel click.
  - A click beside the panel reaches the page. No host process is left.
  - Screenshots go up as artifacts; the boxes sit on their controls.

## Decision log

- 2026-11-04: Panel and boxes in one native macOS window (A/A). Out of the page, not hardened in it. Rejected: a second Chrome window (focus), an extension side panel (Chrome 137 flags, viewport), an isolated world (still a node), Electron (cannot sit above one window), the DevTools Overlay domain for boxes (one highlight, no labels).
- 2026-11-04: macOS only. Linux and Windows headed runs draw nothing; no one runs those today. Superseded the same day by WA-1042 (William).
- 2026-11-04: `bare`, `drawsOn`, `hold`, `around` and the inert/aim logic are deleted: an OS window is never in a CDP shot and never takes a CDP press.
- 2026-11-04: Visible to screen capture (no `sharingType = .none`): William views and records it; CDP shots never include it anyway.
- 2026-11-04 (WA-1042): One Rust host for macOS, Windows and Linux (wry + a small adapter per OS), prebuilt per platform. Replaces `host.swift`. Rejected: a Swift + C# + C helper each (three codebases), Electron (cannot sit above one window, 100 MB), a compile-on-use helper (a compiler on every machine).
- 2026-11-04: Binaries ship inside `@wrenautomation/autobrowse` (`assets/overlay/bin`). Rejected: one npm package per platform in `optionalDependencies` (several packages, each needs a first manual publish), download on first use (network and trust at run time). Cost: every install carries all platforms (about 0.5–2 MB each).
- 2026-11-04: No tao on any OS; each one activates or lets the window manager focus (see Why native code). macOS: objc2 drives `NSApplication` and our own `NSPanel`. Windows: plain Win32 (`windows` crate). Linux: GTK directly. wry attaches to each.
- 2026-11-04: Windows stacks by z-order, not by owner. Rejected: owner = Chrome's window (input queues attached across processes). Cost: after Chrome is raised, up to 33 ms before the panel is above it again.
- 2026-11-04: Linux uses an override-redirect popup and restacks it itself. Rejected: a managed utility window, transient for Chrome's (the window manager may focus it on map, and stacking varies by manager).
- 2026-11-04: Wayland is a limit, not a bug: X11 only on Linux.
- 2026-11-04: Minimize folds the panel into the left-edge tab (a copy shrinks toward the tab's point; the tab peeks after), and reopen grows it back out of that point (William: "a better minimize animation"). The real panel goes at once, so the host's click rect is the tab's during the fold. Panel look only; reduced motion and the terminal look switch at once.
- 2026-11-04: In the panel, the target leads and the verb follows: "click **Save**", not "**click** Save" (William). A failure colours the target. The terminal look and traces keep their order.
