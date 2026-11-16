# Overlay: the panel over the page

A visual for a person who watches a headed page: a panel and purple boxes.
Two looks: a floating panel (light or dark) and the old terminal. The bar button switches them.
It is a native window over Chrome's window, not part of the page. The page, your acts, the aria tree and every screenshot never see it.
macOS, Windows and Linux X11. On Wayland, with no host for the platform, or on Linux without the WebKitGTK 4.1 library or a compositor, it is off and `overlay` says why. In a checkout, the first use builds the host with cargo (minutes). Nothing depends on it, so remove it freely.

## Where it shows

| Run | Default | Turn it on or off |
|---|---|---|
| explore session | on when headed | `{"cmd":"overlay","on":false}` / `"on":true`, any time |
| `autobrowse try <wf>` | on with `--headed`, off with `--film` | `--overlay` / `--no-overlay` |
| flows on the worker or desk | off (the desk runs headless) | `AUTOBROWSE_OVERLAY=on` |

`AUTOBROWSE_OVERLAY=auto|on|off` sets the default for every run. A flag wins over it.

## What it shows

- The bar: the goal (explore: what you set; a flow: `site/flow`) and the run's seed.
- A busy line while a command runs: phase words (locating, aiming, clicking), with a light passing through them.
  Between commands, with a goal set: "thinking".
- The trace: one row per command or flow step. Each row has the aim, ms and a dim note (a failed act is red; the terminal look adds ✓/✗)
  (where the page went, controls added and gone, state changes, page errors, chars read; for `network`, `proof`, `errors` a count). It never shows a typed value, a query string, a call body or a cookie.
- The act's control locks on in purple before the hands reach it; a ring leaves it while the act runs.

## The agent's cursor

- A pointer with a name pill draws where the agent's hands go. Long jumps arc. A click shrinks it and leaves a ripple. A type puts a ring round the field.
- It shows only with human pace (explore, `try --headed`). Instant hands make no events, so no cursor shows.
- It never shows keys or scrolls: a key can belong to a secret.
- Name and colour: `{"cmd":"overlay","name":"Scout","color":"#ff5a1f"}`. Default: the site, one colour a port, so two sessions differ. The cursor draws it toned toward grey.
- After 6 s with no act it dims.

## Steer the agent

Like Operator's Pause and Claude Code's queued messages.
- Pause (bar button): the running command finishes, then the agent waits ("Pausing", then "Paused").
  Do the step by hand, then press Resume. If you changed the page, the agent's waiting command does not run; it reads the page again.
  Only you resume it. After 10 min the waiting command answers that it did not run.
- The note box under the bar: type, Enter. The note shows Queued, then Read once the agent's next answer carried it.
  A click on the box gives it the keyboard. Esc or a click on the page gives the keyboard back to Chrome.

## Buttons

- Your clicks land on the panel. The page never sees them, and Chrome keeps focus (the note box takes it while you type). The agent's acts never touch it.
- Drag the bar to move it. Drag any corner to size it; the text scales with its width.
- Bar buttons: Pause or Resume, the look (panel or terminal), the boxes (show or hide), light or dark (panel only), minimize to a tab on the left edge. Click the tab to show it again.
- Wheel over the trace to scroll it, live. Each choice carries to the next page.
- Screen recordings (OBS, ⌘⇧5) show it; autobrowse's own shots and films never do.

## Drive it (explore)

- Set the goal once: `{"cmd":"overlay","goal":"…","step":"3 of 8"}`.
- Give each act a short `goal` (why you act). The panel shows it as the thought. Send no overlay call per act.
- `refs:[{n,hints}]` boxes controls with numbers; `clear:true` empties the fields.
- `on:false` takes it down and keeps the trace; `on:true` draws it again.
- It takes no part in your acts and no row in the run's history.

## Record the screen

OBS records it: the overlay, the agent's cursor and the real pointer show. autobrowse only presses Record and Stop.
- `autobrowse obs start [--scene <name>]`, then `autobrowse obs stop [--out demo.mp4]`. Stop prints the file.
- `autobrowse obs status`: recording or not, the scene, the scenes.
- It opens OBS when it is closed. It reads the websocket login from OBS's own config. OBS sets the scene, folder and format.
- Keep our windows in front: OBS films the display as the scene has it.
- A locked screen films only the lock screen.

## Record a run once

`autobrowse try <wf> --headed --film [dir]` writes one mp4 per page plus a JSON log
(default `~/.config/autobrowse/films/<wf>-<time>/`). The film is clean: no overlay, no cursor.
The pane JSON holds every hand act and one `step` event per flow step (cmd, aim, ✓/✗, ms, note).
An editor draws the overlay and the cursor from it afterwards. Send the mp4. Never run the flow again to show it.
