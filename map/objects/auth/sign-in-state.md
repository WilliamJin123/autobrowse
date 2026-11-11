---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-11-10 @ HEAD
entity: src/auth/session-status.ts
---

# Sign-in state and route state

Two reads that make no call (OpenCLI audit U18). A Chrome profile's sign-in, from a copy of its cookie DB. A route's state (`ready / needs_login / cooldown / needs_person / broken / unchecked`), from the facade and the site-call ledger.

## Why this shape

`login <site>` opens a browser to learn what the cookie file already says. Names, hosts and expiry are plain in the DB; values stay encrypted and are never read. Only a site with known session-cookie names answers `signed_in` / `signed_out`; any other answers `maybe` or `unknown`.

## Shape

- `SESSION_COOKIES` (checked on real profiles 2026-11-10) — `src/auth/session-status.ts:13`; `readCookies` (copy, read-only, big ints) — `:67`; `sessionOf` — `:94`; `sessionStatuses` — `:113`
- `routeState` (missing leg → refused token → account hold → newest call; a 400/404 is the caller's) — `src/sites/route-state.ts:33`; `lastCalls` — `:22`; `siteHeldS` (only `ACCOUNT_HOLD`: a route row does not name its buckets) — `:65`
- CLI: `auth status` — `src/app/cli-auth.ts:961`; `site status` — `src/app/cli-site.ts:252`; `doctor --json` gives `issues[]`, exits 1 on any — `src/app/cli-reach.ts:54`. An issue is a sign-in seen before and now gone (marker `.signed-in-at` in the profile, written by each status read), or a site that once had a leg. A profile never signed in, or a site never connected, is not one.

## Connected to

- **joins:** [[site-call-ledger]], [[probe]] (same states), [[chrome-profile]]
- **looks-like-but-is-not:** `login --all` (signs in for real)
