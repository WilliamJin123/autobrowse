---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-11-25 @ HEAD
entity: src/authbridge/bridge.ts
---

# Sign-in snapshot (authbridge)

One profile's browser state (cookies, localStorage, IndexedDB), sealed and versioned in S3, so a sign-in can be rolled back or moved to another machine. Design: `designs/2026-11-25-authbridge.md`.

## Why this shape

Playwright `storageState` is portable; a profile folder is not (the Keychain key encrypts its cookies). The pointer's holder stops two machines from both saving one profile. A signed-out state never becomes the newest version.

## Shape

- Snapshot, seal, cold-profile origins — `src/authbridge/snapshot.ts:127` (`takeSnapshot`), `:73` (`storedOrigins`), `:168` (`sealSnapshot`)
- Store, pointer compare-and-swap: S3 — `src/shots/s3.ts:151`; folder (tests) — `src/authbridge/store.ts:53`
- Save rules (sign-in or person's turn; daily refresh only with proof of sign-in; 60 s cap; holder) — `src/authbridge/bridge.ts:69`
- Runner hook (ok run, local tier, not shared) — `src/browser/flow.ts:1064`; `BrowserOptions.signIns` — `src/browser/session.ts:177`; set by `browserOptions` — `src/app/services-browser.ts:111`
- Install: shots bucket, prefix from `ownerKeys().signins` — `src/owner.ts:31`; seal key `AUTHBRIDGE_SEAL_KEY` in SSM — `src/app/services-authbridge.ts:26`; holder name — `:48`
- CLI `authbridge save|list|show|restore` — `src/app/cli-authbridge.ts:90`

## Connected to

- **joins:** [[sign-in-state]] (same session-cookie table), [[chrome-profile]], [[site-login]] (`loggedIn` checks a restore)
- **looks-like-but-is-not:** [[sign-in-context]] (the bound sign-in inputs, not saved state); a passkey (`src/auth/passkey.ts`)
