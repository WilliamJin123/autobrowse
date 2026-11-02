# Overlay: the terminal panel over the page

A visual for a person who watches a headed page: a panel and pulsing purple boxes.
It is in a closed shadow root outside `body`. Your acts and the aria tree never see it.
It is off for every screenshot and every film frame. Nothing depends on it, so remove it freely.

## Where it shows

| Run | Default | Turn it on or off |
|---|---|---|
| explore session | on when headed | `{"cmd":"overlay","on":false}` / `"on":true`, any time |
| `autobrowse try <wf>` | on with `--headed`, off with `--film` | `--overlay` / `--no-overlay` |
| flows on the worker or desk | off (real accounts; a page script can see the node) | `AUTOBROWSE_OVERLAY=on` |

`AUTOBROWSE_OVERLAY=auto|on|off` sets the default for every run. A flag wins over it.

## What it shows

- The bar: the goal (explore: what you set; a flow: `site/flow`) and the run's seed.
- A busy line while a command runs: phase words (locating, aiming, clicking) and a spinner.
  Between commands, with a goal set: "thinking".
- The trace: one row per command or flow step. Each row has the aim, ✓/✗, ms and a dim note
  (where the page went, controls added and gone, chars read). It never shows a typed value or a query string.
- The act's control pulses purple before the hands reach it.

## Buttons

- Your clicks land on the panel. The page never sees them. The agent's acts go through it.
- Drag the bar to move it. Drag any corner to size it; the text scales with its width.
- `[◆]`/`[◇]` shows or hides the boxes. `[_]` minimizes it to a tab on the left edge. Click the tab to show it again.
- Wheel over the trace to scroll it, live. Each choice carries to the next page.

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
