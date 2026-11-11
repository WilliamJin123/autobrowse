---
type: object
cluster: reach
universe: live
status: verified
verified: 2026-11-11 @ HEAD
entity: src/reach/net-guard.ts
---

# Net guard

Where a fetch or a browser may go (PinchTab audit P1). http and https only; the browser also opens about: and data:. Private, link-local (169.254 metadata), CGNAT, benchmark, multicast and reserved ranges are refused, also when wrapped in IPv4-mapped, 6to4 or NAT64 IPv6. A refusal is `NetRefused`, code `url_refused` (403, exit 77, not retryable): nothing was sent.

## Settings

- `NET_LOOPBACK` (default true): 127/8 and ::1. False on a server.
- `NET_ALLOW_PRIVATE` (default false): private and link-local ranges (a router page).
- `NET_ALLOW_DOMAINS` (default empty = any public host): comma list, matched by suffix.

## Why this shape

One rule set in one module, checked at each place a URL leaves the process. The fetch ladder is checked twice: before each hop (scheme, allowlist, DNS) and at connect time through undici's `connect.lookup`, so the address dialed is the address checked (no DNS-rebinding gap). Chrome resolves and redirects on its own, so the browser is checked before `goto` and on the URL it landed on; a refused landing blanks the page. A redirect hop inside Chrome is not stopped before it is sent: on a server, egress rules in the network close that gap.

## Shape

- Ranges and `refusedAddress` — `src/reach/net-guard.ts`; `checkUrl` (resolves names); `landedOk` (after a browser navigation); `followChecked` (manual redirects); `guardedLookup` (connect time); `netRules` (settings, once per process)
- Ladder: plain rung = global fetch + guarded undici `Agent` (`fetchWithLookup`, `src/share/fetch.ts`), `redirect: "manual"`; impersonate rung = impit with `followRedirects: false` — `src/reach/ladder.ts` (`realRungs`)
- Browser: `settle` — `src/browser/flow-steps.ts` (every `fp.open`, explore `open`, read tabs); renderer — `src/browser/render.ts`; watchers — `src/browser/watchers.ts`; recorder start URL — `src/recorder/browser.ts`
- Flows rethrow `NetRefused` unwrapped (no repair) — `src/browser/flow.ts`
- Error contract — `src/errors.ts` (`codeOf`), `src/ui/http.ts` (`ErrorCode`)
- Tests — `test/net-guard.test.ts`

## Connected to

- **joins:** [[settings]], [[flow]], [[session]]
