---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-11-12 @ 1c11f76
entity: src/browser/har.ts
---

# HAR record, replay, faults

A walk's network saved once as a HAR, then played back with no site; faults (a status, a delay, a dropped call) on top: `src/browser/har.ts`.

## Why this shape

A flow test needs the site's answers, not the site. A recorded HAR gives them offline and the same each run. Faults test the paths a live site rarely shows. Playwright's own `recordHar` and `routeFromHAR` do the work; we add the scrub and the fault routes.

## Shape

- `HarOptions { record?, replay? }`, `Fault { url, status?, body?, delayMs?, abort?, times? }`: `src/browser/har.ts:13-34`
- `replayHar`: `routeFromHAR`, a URL not in the file is aborted. `injectFaults`: one `context.route` per fault.
- `scrubHar(file, secrets)`: drops cookies, `Set-Cookie` and credential headers; masks each held secret in every spelling (raw, URL, form). A secret shorter than the match floor stays. `scrubOrDrop`: scrub, or delete the file when the scrub fails.
- `BrowserOptions.har` / `.faults` (`src/browser/session.ts:182-184`). Record is local only (`recordHar`, content embedded). The HAR is written on context close; the scrub runs then.
- Setting `har` / `AUTOBROWSE_HAR` (`src/app/config.ts`): every local session records to that path.
- Recording turns the HTTP cache off for the context (patchright sends `Network.setCacheDisabled` while a HAR recorder is on): every request carries `no-cache`. Record test walks, not daily runs.

## Connected to

- **owned-by:** [[session]] (launch and close)
- **joins:** [[flow]] (a test runs a flow over a replayed HAR)
- **looks-like-but-is-not:** [[film]] (video and shots, not network); call bodies (`src/runs/call-bodies.ts`, API replies)

## If you change this

- **Hits:** `src/browser/session.ts` launch and close, `test/har.test.ts`.
- **Does not hit:** site APIs, the desk.

## See

- Source: `src/browser/har.ts`; test `test/har.test.ts`
- Design: `designs/2026-11-12-agent-browser-audit.md` (WA-1350)
