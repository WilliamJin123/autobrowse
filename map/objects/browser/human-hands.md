---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/human/index.ts
---

# Hands

How a person's hands would do each act, in one facade: `Hands` from `handsFor(pace)` in `src/browser/human/index.ts`.

## Why this shape

Robustness lives in one place: a pause to read, a curved reach, typing in runs with mistypes. `pace: null` is instant (tests, the explore console). Nothing else adds delays.

## Shape

- `Pace` — `src/browser/human/index.ts:50`; `Hands { think, click, type, press, scroll … }` — `:113`; `handsFor` — `:245`
- Field-swap guard (WA-1349): `paste`, and `type` of text `hidden` marks as secret, take the element handle first and check after the reach that the hints still find it, its tag, name, id, autocomplete and form are unchanged, and it has focus; else `FieldSwapped`, nothing typed. Not `type` of the field (text-to-password on focus is common). Instant hands have no gap between find and fill
- Mouse, scroll, typing styles in the sibling files. Scroll (`human/scroll.ts` `scrollPlan`): one device per hands (wheel notches in flicks, or trackpad swipes: push frames, momentum decay, sideways drift); reading adds small looks back up; a long move may carry past and come back. `Hands.scroll(page, dy, {over})` aims first: onto `over`, else a reading spot when a pane under the pointer would take the wheel
- The wait after a scroll and what it did (`moved`, `loaded`): `scrollAndSettle` — `src/browser/page-scroll.ts`; which recorded scrolls a compile keeps: `src/compiler/scrolls.ts`
- An optional `HandsLog` sink hears each act (move, down, up, key, scroll, focus): [[film]]
- Chosen from settings: `paceFor` — `src/app/services-signin.ts:293`

## Connected to

- **owned-by:** the runner (`RunnerOptions.pace`, `src/browser/flow.ts:216`)
- **joins:** [[flow]], the captcha solver (`src/browser/captcha/index.ts:205`), the explore session

## If you change this

- **Hits:** `src/browser/flow.ts`, `src/browser/captcha/index.ts`, `src/explore/server.ts` (pace option).
- **Does not hit:** the desktop leg ([[desktop-hands]]), locators.

## Surfaces

| Surface | Role |
|---|---|
| runner, explore, agent | use |

## See

- Source: `src/browser/human/index.ts`
