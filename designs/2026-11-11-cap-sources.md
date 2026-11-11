# Caps: which source holds each bucket

2026-11-11, WA-982.

## Problem

A call's cap for one bucket can come from four places: the site's caps in code, the site's caps in `limits.json`, the account's caps in code (`SiteApi.accountCaps`), the account's caps in the file. The order was in code only (`effective` in `src/sites/limits.ts`, the merge in `src/sites/facade.ts`). Three faults sat beside it:

1. An account's caps were found by address: the first credential name whose username matched the chosen address won. Two names on one address took each other's caps, with no error.
2. A send's verify read spent the send's own bucket. On 2026-10-30, four verify asks used LinkedIn's 10 `comments`, and the next check was refused.
3. The order was not written down.

## Options for the order

| Option | Order, low to high | Verdict |
|---|---|---|
| A. Narrower wins, then file over code | code site < file site < code account < file account | **Chosen** |
| B. File wins over code at every level | code site < code account < file site < file account | No: raising a site cap in the file opens an account the code shut (William's own LinkedIn, all 0 since 11-04) |
| C. The lowest of all sources | min over the four | No: the file could never raise an account above the code's default, and the operator's edit would do nothing |

A keeps a code safety rule (an account off) from being undone by a site-wide edit. To open such an account, the file names the account.

I first told William B ("an unset account cap falls back to the site cap"). On reading the code, B opens the personal profile when the site cap is raised. So A stays, and this doc says why.

## Rule

- Per bucket, the narrowest source that sets it wins: the account's caps, else the site's.
- At each level, the file wins over the code.
- An account's caps are found by the credential name the caller gave, matched exactly. With no name, by address. Two names on that address are a 500 that names both. The fix is to name the credential, or give each its own address.
- A send's verify read is metered as `{verify: 1}` when the site sets a `verify` cap. Else it is metered as the route's own buckets. LinkedIn: `verify` 40 a day, 0 on `linkedin` and `linkedin@alt`. `VERIFY_GAP_MS` still holds each send to one read an hour.

## Decision log

- 2026-11-11: chose A. B rejected: a site-wide raise would reopen accounts the code shuts.
- 2026-11-11: two credential names on one address fail loudly rather than pick the first. Today no LinkedIn names share one (checked: `linkedin`, `linkedin@wren`, `linkedin@alt` all differ).
- 2026-11-11: a site without a `verify` cap meters verify reads as before. A new bucket with no cap would be unlimited.
