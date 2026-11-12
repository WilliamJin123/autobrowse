# Walk request tier

WA-1352. From the agent-browser audit (`designs/2026-11-12-agent-browser-audit.md`, row 7).

## Goal

A read-only walk gets its answer from the site's own JSON call when it can. It clicks and types only when that call breaks. A run then costs one page load and at most one request per output, not a screen of acts at a person's pace.

## Terms

- **Walk**: a saved flow of screens and ops (`WalkSpec`, `src/walks/spec.ts`), run by `walkFlow` (`src/walks/flow.ts`). Map card: `map/objects/build/walk-spec.md`.
- **Output**: what a walk returns. A `records` op's rows (`out.records[as]`) or a `read` op's text (`out.read[as]`).
- **Call**: one XHR or fetch the page made, with a JSON answer.
- **Act**: an op that changes the page: every op but `see`, `read`, `records`, `ai`, `captcha`, `walk`, `each`. `open` is an act.
- **Request leg**: one output's call, saved as a template, plus where the output sits in the answer. Two ways:
  - `intercept`: the start page makes the call as it loads (before the first act). The run opens the page and takes the answer. It sends nothing the page does not send.
  - `cookie`: an act made the call. The run sends it again with `fetch` from the page, with the browser's cookies.
- **Ladder**: `ladder()` in `src/browser/ladder.ts`. It tries rungs in order (`cookie`, `intercept`, `ui`); a rung that throws `RungBroke` falls to the next.

## Today

- A walk only acts and reads the page. Explore keeps the page's calls in memory as redacted rows (`src/browser/network.ts`); the run log keeps none.
- Hand-ported flows climb the ladder (LinkedIn's inbox, `src/browser/flows/linkedin-reach.ts`). Each rung is written by hand.

## Target

1. A UI run of an eligible walk listens to the page's calls. Each call notes how many acts the run had done when it was sent.
2. After a run that reached its goal and was not held, each output is traced to the call whose JSON holds it. That call becomes the output's leg: `intercept` when it was sent before the first act, else `cookie`.
3. The next run opens `start` (one page load), takes each `intercept` answer as the page makes it, sends each `cookie` leg with `fetch`, and maps each answer to its output. Two outputs of one call share one answer. `ai` ops run after, in op order. `see`, `captcha` and the acts do not run. `goal` is the goal screen's name.
4. Every answer goes through `classify` (`src/browser/page-json.ts:73`). A 429, a 401, a sign-in redirect or a block body stops the run: dropping to clicks after a block looks more like a bot. Another 4xx, a non-JSON answer, a CORS refusal, a call the page no longer makes, or a shape that does not fit breaks the leg (`RungBroke`): the run falls to the UI rung, which learns again.
5. The output says which rung answered (`via`: `intercept`, `cookie` or `ui`), why one fell (`fell`), and what the UI run learned (`learned`: a leg count, or why none).

## Eligible walks

A walk is eligible when:

- it has a `start` and `spec.irreversible` is false;
- every op is `open`, `click`, `fill`, `select`, `press`, `hover`, `see`, `read`, `records`, `ai` or `captcha` (`walkOpSchema`); no click is irreversible;
- no `fill` types a secret or a profile value: a walk that signs itself in stays UI, since `need_login` stops the tier;
- no screen comes back (`once: false`) and no `records` op has `max`: paging spans many calls;
- it has at least one `read` or `records` op.

## Learning a leg

- The listener keeps each same-site XHR or fetch with a 2xx JSON answer: raw method, URL, body, headers and answer, read from Playwright responses (not `NetRow`s). At most 200 calls and 8 MB a run, in memory only. Past the cap, the trace runs on what it kept.
- `records`: an array whose items match every UI row. A row matches when each field with a value equals a leaf of its item, after whitespace squash; a link may be relative in the answer. Each field keeps its path in the item; a field the UI read empty keeps none.
- `read`: a leaf whose text, after the op's `match`, equals the read text.
- Paths resolve with `pickPath` (`src/browser/network.ts:500`).
- Template: each plan value the run used (given, default or asked), and each earlier output, becomes `{{key}}` where the call carries it, in its spelling (raw, URL, form or JSON). A leg is refused when a plan value is under 3 chars or no call carries it: the answer would not follow the input.
- The call must come from the `start` page's origin.
- A `cookie` leg also needs:
  - no header named like a signature (`sig`, `signature`, `nonce`, `x-s`, `x-t`, `timestamp`);
  - each credential-named header, query key or body key (`secretName`) equal to a cookie, quotes stripped (`JSESSIONID`'s `"ajax:…"`). It becomes `{{cookie:<name>}}`, read from the context's jar at run time, so HttpOnly does not matter;
  - no value an earlier answer gave (an id that changes per session).
  - Headers: all but the browser's own (`sec-*`, `user-agent`, `cookie`, `referer`, …).
- An `intercept` leg keeps no headers. The page makes the call, so a signature or a page token in it is the page's own. The run matches the page's call by method, path, query keys, the non-volatile query values (a value of 9+ digits, a time, may change) and the plan values in the body.

### The leg file

`<state>/walk-calls/<site@label>/<name>.json`, mode 0600, written whole through a temp file per writer:

```json
{
  "learned": "2026-11-12T22:00:00.000Z",
  "legs": [
    {
      "as": "products", "kind": "records", "way": "cookie",
      "method": "GET", "url": "https://shop.test/api/search?q={{q}}&v=1",
      "headers": { "csrf-token": "{{cookie:JSESSIONID}}" },
      "vars": [{ "key": "q", "url": "url" }],
      "path": "data.items",
      "fields": { "title": { "path": "title" }, "link": { "path": "url", "abs": true } }
    }
  ],
  "off": { "until": "2026-11-19T22:00:00.000Z", "why": "products: HTTP 404" }
}
```

- One leg per output, in op order. The tier runs only when the legs' `as` list equals the walk's outputs.
- `off`: the legs broke, and the UI run learned the very same legs again. For 7 days the tier is not tried and nothing is learned.
- Legs that broke and could not be learned again are deleted.

## Options

### Leg kind

| Option | Verdict |
|---|---|
| I. `intercept` for calls the start page makes; `cookie` for calls an act makes | **Chosen**. No extra request where the page makes the call, so signed calls and page tokens work; replay only where it must |
| R. `cookie` (replay with `fetch`) for every call | No: a call the page load makes would go twice, and signed calls never work |
| I only | No: a search behind a button would stay UI |

### Where the calls come from

| Option | Verdict |
|---|---|
| A. Learn on each UI run of the walk | **Chosen**. Works for every walk on disk now; fresh as the last run; the UI fallback learns again after a site change |
| B. Keep network rows in each explore run's log; build traces them | No: up to 32 MB of bodies a session (`MAX_BODY_BYTES`, `network.ts:17`); a walk built before this never gets legs |
| C. A HAR per run (`src/browser/har.ts`, WA-1350) | No: a HAR recorder turns off the HTTP cache (`map/objects/browser/har.md:25`), which sites can see |

### Where a leg lives

| Option | Verdict |
|---|---|
| X. In the walk file, `calls` beside `screens` | No. A walk file is per base site (`walkFile` strips `@label`), so one profile's legs, with its ids, would run on another's session. A mod's walk would get a copy in the owner's folder and hide mod updates. A hand edit during a run would be lost |
| Y. A side file per profile: `<state>/walk-calls/<site@label>/<name>.json` | **Chosen**. Only `walkFlow` reads it; the packer never sees it; the walk file has one writer again |

### Writes

| Option | Verdict |
|---|---|
| W1. Reads only | **Chosen**. The money gate and William's yes for public acts sit on UI acts; a leg would go around them. A write could also be sent twice |
| W2. Writes too, with `outcome_unknown` (agent-browser's rule) | No, for now: the gates would need a request-level twin first |

## Risks

- **A wrong trace.** A common value can match the wrong leaf. Mitigations: every row must match; plan values under 3 chars refuse the leg; the shape check and `checkRows` run every time.
- **Personal data on disk.** On `x`, `linkedin` and `google` the network log keeps no query (`network.ts:21-22`), but a leg keeps raw URLs. Kept: the file is local, 0600, per profile and never packed. These are the sites where the tier pays most.
- **Pace.** A run holds the site's pace slot and cap like any walk run. Cookie legs wait 1.2 s between calls.

## Non-goals

- Direct HTTP from Node. It sends no cookies; the site facade covers public APIs.
- Paging, nested walks (`walk`, `each`), writes.
- An agent-facing `route` command or request mocking.

## Build

- `src/walks/calls.ts` (new): the leg schema and file (`loadCalls`, `saveCalls`), `ineligible`, `listenCalls`, `traceLegs`, `nextCalls`, `sameCall`, `runLegs`.
- `src/walks/flow.ts`: `walkSpec` counts acts. `walkFlow` runs a request rung (`strategyOf`: `intercept` when every leg is) and the UI rung through `ladder()`. `WalkDeps.calls` is `{load, save}`. `WalkOutput` gains `via`, `fell`, `learned`.
- `src/app/services-signin.ts`: `walkFor` keys the leg file on `site@label`.
- `src/walks/spec.ts`: `saveWalk` writes through a temp file per writer.
- Tests (`test/walk-calls.test.ts`): a local shop. A search behind a button learns `cookie` legs, then runs on one request and no acts. A results page that searches as it loads learns `intercept` legs, then runs with no extra request. A changed shape falls to UI and learns again. A 429 stops. Legs that are off are neither tried nor learned. Signed, irreversible, credential and earlier-id cases refuse.

## Decision log

- 2026-11-12: Calls learned on UI runs (A), legs in the walk file (X), reads only (W1).
- 2026-11-12: goldfish review: 36 findings, 30 applied, 6 rejected; no open owner decisions. Applied, among others: G2 (`classify` stops 401, 403 and blocks), F1/G3 (every plan value carried), F2 (credential keys in query and body), F3 (`off`), F4 (all headers, quotes stripped), F5/G4 (`ai` after legs; `goal`), F6 (secret fills not eligible), F7/G6 (no paging), F8/G5 (`start` only), F10 (temp file per writer), F11/Z6 (leg schema), G12 (trace after goal only), G13, G15, F15, Z4 (every row), Z5. Rejected: G1 and F14 (the op list was right; its `see` point folds into F5), F13 and G11 (source is `har.md:25`), G9 (cookies come from the context jar, as `linkedin-reach.ts:976` does), G14 (each term cites its file). Changed choices:
  - Z1/F12: two leg kinds (I). A call the start page makes is taken as it loads.
  - Z2: legs move to a side file per profile (Y), not the walk file. This also clears F9 and the hand-edit race in F10.
  - Z3, in part: `pickPath` replaces a second path resolver. The trace keeps its own matcher: `findText` matches text only, not rows, links or encodings.
