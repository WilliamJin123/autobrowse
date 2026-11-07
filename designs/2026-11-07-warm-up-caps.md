# Ramped caps: a new account acts less, by age (WA-1148)

William, 2026-11-06: "warm up limits sure". This doc adds an age ramp to autobrowse's act caps and closes the one path that acts with no cap.

## Problem

- **Evidence.** Two TikTok accounts on this Mac's IP were limited:
  - Wren (`tiktok`, made 2026-09-29). Its 24 posts have had 0 views since the first, on 10-14. Its first act came on 10-28; by 11-03 it had 6 comments, 5 likes and 0 follows (prod `touches`).
  - Lana (an explore account). TikTok flagged it for "Spam and Deceptive Account Behaviours".
- **What this says.** Wren's views stopped two weeks before its first act, so no cap would have saved Wren. The causes we can name are the shared IP, the browser (follows from it revert; the same follows from the phone stick, WA-1161) and the account's behavior. Ramped caps answer only the last.
- **Why build it anyway.** Each new account on any site starts at full caps on day 0. TikTok's `follow: 10` and `comment: 15` (`src/sites/tiktok.ts:238`) are a bot's first day, not a person's.

## Now

- **Caps.** The facade meters each site route (`meter`) in the caps ledger (`src/sites/caps.ts`), per account, per UTC day. It merges the site's caps, `limits.json` and each account's caps before the take (`src/sites/facade.ts:839-843`). When the site undoes an act, the ledger holds that bucket for 1 h, 3 h, 8 h, then 12 h steps (`caps.ts:133`).
- **No age.** A day-0 account gets the full cap.
- **One path with no cap.** Explore `flow`, CLI `try`, proofs and Restate compiled runs call a leg through `compiledDeps` (`src/workflows/compiled-deps.ts:40`), not the facade. A route's leg (`browser: { flow: "tiktok/follow" }`, `tiktok.ts:421`) runs there as workflow `tiktok-follow` (`src/engine/leg.ts:17`) and takes no cap. One of the 11-06 follows went this way; the other was a click by hand.
- **wren** ramps its own follows from the first follow it logged (`@wren/core/ramp`: 30% of the cap on day 0, +15% of the cap each 2 days). It does not see likes, comments or explore.

Terms: an **act bucket** is a bucket that a non-GET route meters (`follow`, `like`, `comment`, `connect`). The facade already splits acts from reads this way (`RETRY_BUFFER`, `facade.ts:844`). Reads (`search`, `profile`) keep their full cap.

## Options

### Where the cap holds

| Option | For | Against |
|---|---|---|
| A. Facade only | Smallest | The `compiledDeps` path stays open |
| B. Explore takes the route's meter itself | Explore acts stay live | A second writer to `caps.json` with no lock (`caps.ts:310-333`); copies the facade's settlement (`facade.ts:808-889`) |
| C. **A guard in `compiledDeps`: refuse a leg that is a metered act route's leg; name the route to call** | One place covers explore, `try`, proofs, Restate runs; no second writer; `--dry-run` still works | No live act from explore; a future act route with a `{workflow}` leg is refused on its own facade call |
| D. B plus clicks by hand: read the clicked control's text | Closes the last gap | Text match per site and language; false hits stop sessions |

### Where age comes from

| Option | For | Against |
|---|---|---|
| 1. `madeAt` on the credential | Exact | Only accounts minted here have it; Wren TikTok and Lana do not |
| 2. **First seen: the first take attempt per site and account, kept in the caps state** | Known for every account from deploy; a refused take counts, so a cap of 0 cannot stop the clock | Every live account starts at day 0 on deploy day |
| 3. Declared by a person in `limits.json` | The truth, once | One more field to keep; lets an old flagged account skip the ramp |

### Ramp shape

| Option | For | Against |
|---|---|---|
| i. wren's rule | Known numbers | Day 0 still acts (TikTok: 3 follows) |
| ii. **wren's rule after `quietDays` at 0** | A site can ask for days of no acts | One number per site |

## Design (recommended: C, 2, ii)

- **Age.** The caps state keeps `firstSeen[site|account]` (a date). The first take attempt for any bucket sets it, refused or not. The day roll carries it, as it carries `next` and `held` (`caps.ts:172-177`). `age = days since firstSeen`.
- **Ramp.** `SiteApi.ramp = { quietDays }` (default 0). For an act bucket with cap `c` (after `limits.json`):
  `today = age < quietDays ? 0 : rampedCap(c, age - quietDays)`.
  `rampedCap` is wren's: `min(c, ceil(0.3c) + ceil(0.15c) × floor(days / 2))`. TikTok: `quietDays: 3`.
- **Where.** One function beside `capsOfAccount` gives each act bucket's cap for today. The facade passes it to `take`; `autobrowse limits` prints it. `take` stays a plain ledger.
- **Refusal.** A bucket at cap 0 from the ramp says: `tiktok follow: ramp day 1 of 3 for <account>, no acts until 2026-11-10`. Today a cap of 0 says "reads are off" (`facade.ts:853-854`).
- **Guard.** `compiledDeps` refuses a leg that is the `browser.flow` of a metered non-GET route, unless the run is `--dry-run`: `tiktok-follow is an act: call POST tiktok /web/{username}/follow, which meters it`.
- **wren.** Both caps apply; the lower wins. The five-line `rampedCap` is copied (`src/sites/ramp.ts`), against `wren-ramp.ts:4` "never a copy per platform": the two repos share no package.

| TikTok `follow` (cap 10, quietDays 3) | day 0-2 | day 3-4 | day 5-6 | day 7-8 | day 9-10 | day 11+ |
|---|---|---|---|---|---|---|
| cap today | 0 | 3 | 5 | 7 | 9 | 10 |

## Non-goals

- The IP and the browser's trust (WA-1161, phone).
- Clicks by hand in explore (option D). The explore skill says: an act goes through its route.
- Replies, posts and DMs: no route meters them today.
- wren reading autobrowse's caps.

## Risks

- Deploy day: every account starts at day 0. Wren's LinkedIn and X act less for about 10 days.
- A lost `caps.json` resets every age: stricter only.
- Explore cannot follow, like or comment for real. To test an act flow live, call the route.

## For William

1. Day 0 for every account on deploy day, or a declared age (option 3) for the accounts you name?
2. Explore loses live acts (the guard). Yes?
3. This does not fix TikTok's limits (see Problem). Build now, or after WA-1161?

## Decision log

- 2026-11-07: Draft.
- 2026-11-07: fresh-eyes review (EGM trial, 7 reviewers): 4 Blockers, 9 Majors, 9 Nits; applied all four Blockers and 7 Majors; rejected 6 fixes (explore metering, network interception, shared test vectors). Fixed: the explore match key (`browser.flow`, not `workflow`), the cap-0 deadlock, `firstSeen` lost at the day roll, `since` breaking the `limits.json` schema, one meaning of "act". Open: the three questions above.
