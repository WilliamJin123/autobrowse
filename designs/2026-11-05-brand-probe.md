# `web GET /brand`: a page's brand, as a person sees it (WA-1097)

## Goal

read's `brandOf(url)` gets a site's colours, fonts and logo when the static CSS says nothing (linear.app: the stylesheet is built by script). The answer is what the browser computed, not what the CSS files say.

## Contract

`BrandProbe` in `@wrenautomation/read` (`brand/brand.ts`, engine 0.42.0). read owns the shape and votes on it (`voteProbe`); autobrowse fills it.

| Field | From the page |
|---|---|
| `finalUrl`, `status`, `block` | the render, as `/fetch` gives them |
| `themeColor` | `meta[name=theme-color]` whose `media` matches the light scheme |
| `body` | the fill of `body`, else `html`, else white; `color`; `font-family` |
| `headings` | visible `h1`, `h2`: font and colour, first 6 |
| `buttons` | visible `button`, `[role=button]`, submit inputs and links with a fill that is not the page's: fill, text colour, area, first 20 |
| `links` | visible text links with no fill: colour, first 30 |
| `logos` | visible `img` and `svg` named logo or brand (id, class, alt, label, title, src, 3 parents up) or inside the home link: `src` or the SVG markup, `named`, `top` (in `header`, `nav`, banner), area, first 12 |

Colours stay as the browser gives them (`rgb(…)`, `oklch(…)`): read parses both. A gradient gives its first stop, and wins over the colour under it. A fill under half opaque is no fill (read drops those too; here they would use up the caps). An SVG over 20,000 characters or one that points at a sprite (`<use>`) is left out: it is no picture outside its page.

## Options

### How the route reaches the page

| Option | Verdict |
|---|---|
| A. `Render` takes a `probe(page)` that runs after the wall wait, in the same page | **Chosen**. One browser path: the park, the lock per profile, the captcha solver and the exit stay as `/fetch` has them |
| B. A second renderer for brand | No: a copy of the session, park and wall logic |
| C. A browser flow (`browser: { flow }`, like `/google`) | No: flows run on the desk with a person's pace and a journal. This is a signed-out read any worker with a browser can do |
| D. Read the rendered HTML from `/fetch` | No: that is read's fallback now. HTML has no computed colour |

### What a block answers

| Option | Verdict |
|---|---|
| A. The page's styles with `block` set, like `/fetch` | **Chosen**. read checks `block` and falls back; a block is data, not an error |
| B. An error | No: Restate would retry a wall |

## Rules

- Light scheme (`emulateMedia`), so one site gives one answer.
- Profile `fetch` only. No climb to the exit: read falls back to `/fetch` from `render`, which climbs.
- Meter: 1 of `fetch`, as a render costs.
- No browser on the worker: 501. read falls back.
- The page script is a string (`READ_BRAND`): the desk runs under tsx, which wraps named helpers in `__name`.

## Decision log

- 2026-11-05: Built from WA-1094's contract (birdwatch dev wrote `BrandProbe`; William approved brand extraction).
- 2026-11-05: `Render` gets `scheme` and `probe`, not a new renderer (option A).
- 2026-11-05: The reader waits for the network to go quiet (5 s at most) before it reads: script-built styles land after `load`.
- 2026-11-05: Checked on linear.app, stripe.com and cloudflare.com, headless: 3 to 8 s a page; the brand colour is among the buttons, the header logo is first.
- 2026-11-05: Buttons exclude a fill equal to the page's: it is no brand colour. read applies its own `apart` test after.
