---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-11-10 @ HEAD
entity: src/browser/profile-pool.ts
---

# Profile pool

One browser per Chrome profile, shared by reads (OpenCLI audit U15). Reads run side by side, each in its own tab, up to 3; a write waits for an idle profile and runs alone. Past 16 waiters a call fails at once (`PoolFull`, code `profile_busy`).

## Why this shape

A persistent profile opens once per process, so the old per-profile mutex ran every call in a line, reads too. Reads do not change the account, so they can share the open browser. Order stays FIFO: a read never jumps a queued write, so writes never starve. A read that meets a sign-in wall stops (`SignInAlone`) and runs again as a write: one sign-in per profile, never two at once.

## Shape

- `ProfileGate` (reader-writer scheduler, bounded queue) — `src/browser/profile-pool.ts:44`; `PoolFull` — `:21`
- `ProfilePool.use(key, mode, open, fn, {fresh})` — `:154`: the first user takes the parked browser or opens one and keeps its main page; a later read joins with a background tab (`poolTabs`, `:123`); the last one out tidies and parks, or closes on `discard` (`settle`, `:210`)
- Flows: `browserPool` (tidy = stray tabs + route stubs) — `src/browser/flow.ts:127`; mode from `BrowserFlow.reads` — `:228`; `SignInAlone` — `:116`; `nextPage` skips pool tabs — `:461`
- Renderer: a render is a read — `src/browser/render.ts:116`
- Who is a read: a route whose access is `read` and not irreversible (`legOf`, `src/sites/facade.ts:285`); a compiled step of only `read` and `records` ops (`src/compiler/render.ts:212`)
- Worker: one pool for flows and renders — `src/app/services.ts:276`

## Connected to

- **owned-by:** [[flow]] (the runner)
- **joins:** [[session]], `SessionPark` (`src/browser/park.ts`)
- **looks-like-but-is-not:** `fp.each` read tabs (inside one flow's code); `ProfileBusy` (another process holds the profile)

## If you change this

- **Hits:** the runner's open and teardown, the renderer, the facade's browser legs, the compiler's rendered flows.
- **Does not hit:** explore sessions (their own browser), cross-process holds (`browsers.ts`).

## See

- Design: `designs/2026-11-09-opencli-audit.md` (U15 decision)
