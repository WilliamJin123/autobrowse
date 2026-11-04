# Overlay: the panel over the page

A visual for a person who watches a headed page: a panel and purple boxes.
Two looks: a floating panel (light or dark) and the old terminal. The bar button switches them.
It is a native macOS window over Chrome's window, not part of the page. The page, your acts, the aria tree and every screenshot never see it.
macOS only: elsewhere it is off, and `overlay` says why. Nothing depends on it, so remove it freely.

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
  (where the page went, controls added and gone, chars read). It never shows a typed value or a query string.
- The act's control locks on in purple before the hands reach it; a ring leaves it while the act runs.

## Buttons

- Your clicks land on the panel. The page never sees them, and Chrome keeps focus. The agent's acts never touch it.
- Drag the bar to move it. Drag any corner to size it; the text scales with its width.
- Bar buttons: the look (panel or terminal), the boxes (show or hide), light or dark (panel only), minimize to a tab on the left edge. Click the tab to show it again.
- Wheel over the trace to scroll it, live. Each choice carries to the next page.
- Screen recordings (OBS, ⌘⇧5) show it; autobrowse's own shots and films never do.

## Drive it (explore)

- Set the goal once: `{"cmd":"overlay","goal":"…","step":"3 of 8"}`.
- Give each act a short `goal` (why you act). The panel shows it as the thought. Send no overlay call per act.
- `refs:[{n,hints}]` boxes controls with numbers; `clear:true` empties the fields.
- `on:false` takes it down and keeps the trace; `on:true` draws it again.
- It takes no part in your acts and no row in the run's history.

## Record a run once

`autobrowse try <wf> --headed --film [dir]` writes one mp4 per page plus a JSON log
(default `~/.config/autobrowse/films/<wf>-<time>/`). The film is clean: no overlay, no cursor.
The pane JSON holds every hand act and one `step` event per flow step (cmd, aim, ✓/✗, ms, note).
An editor draws the overlay and the cursor from it afterwards. Send the mp4. Never run the flow again to show it.
