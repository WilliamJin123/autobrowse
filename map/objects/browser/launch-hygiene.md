---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-11-11 @ HEAD
entity: src/browser/launch-hygiene.ts
---

# Launch hygiene

Checks around a local browser launch (PinchTab audit P8–P11). A launch that never answers fails before any site call; a crashed profile opens clean; each browser death is kept; our tabs in a person's browser stay under a cap.

## Shape

- P8 `readyOrThrow` (`page.evaluate("1")` in 15 s) and `launchFailed` (launch timeout 60 s) → `BrowserNotReady`, code `browser_down` — `src/browser/session.ts:253`
- P9 `cleanUncleanExit`: `Default/Preferences` exit flags set clean, `Default/Sessions` cleared, cookies never — `src/browser/session.ts:236`, after `assertProfileFree`
- P10 crash ring `~/.config/autobrowse/browser-crashes.jsonl`, last 20 (`recordCrash`, `recentCrashes`): reasons `closed` (a close with no `close()` call, `session.ts:263`), `unclean-exit`, `memory` (`memory-guard.ts:138`), `not-ready`. Shown as one warning in `browsers` and `doctor` (`browsers.ts:245`); rows in `browsers --json` `crashes`
- P11 `assertOwnTabRoom`: past 6 live ledger tabs in one person's browser, the open fails `OwnTabsFull`, code `profile_busy` — `session.ts:321`. Their tabs are never closed

## Connected to

- **joins:** [[session]], [[profile-pool]], `own-tabs.ts` (the ledger), `memory-guard.ts`
