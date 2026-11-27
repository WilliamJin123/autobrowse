# Sign-ins as branching walks: no hand-written sign-in, heal adds a branch

2026-11-26. Status: building option A; C is the direction after it. Task WA-1461.

## Ask

William, 11-26 (through the wren v2 sidecar):

- "Login steps shouldnt be hand written in the first place i think autobrowse work should convert them into compiled workflows across the board."
- "Yes compiled workflows were also meant to be able to support complex branching workflows so good call there."

Rules he said yes to:

1. Heal adds and never replaces. A new screen is a new branch, keyed on a recognizer. The old path stays.
2. A sign-in never learns by failing. A new sign-in starts with the known screens built in: 2FA code, passkey, save login, person step, account chooser.
3. Keep: one `signIn` hook, the password only on the spec's origins, one audit row per typed secret, wall and person-step detection, the provider handoff (`oauthLogin`, `googleWalk`).

Trigger: Instagram renamed its username box on 11-26. The hand-written `signInToInstagram` skipped the fill and said nothing (fixed in 582ad5b).

## Goal

| Part | Today | Target |
|---|---|---|
| A site's sign-in | TypeScript per site, or a `formLogin`/`oauthLogin` spec | one data file per site: screens, each a recognizer and an outcome |
| Known screens (code, passkey, save login, chooser, person, refused) | written again in most sign-ins | one kit; every sign-in has it from its first run |
| Unknown page in a sign-in | a learned row or the model reader names an old screen; else `LoginFailed` (form logins) or a person (built walks) | the same, then heal adds a screen beside the old ones |
| Heal | replaces one step's ops in a rendered workflow; never runs on a sign-in | adds a screen and never deletes one; runs on a sign-in |

Branching inside rendered workflows (an outline step that runs a walk) is its own task (Non-goals).

## Words

- **Walk**: a screens loop (`walk()`, `src/browser/screens.ts:443`). It looks at the page, picks the first screen that matches, acts, and repeats until a goal screen.
- **Built walk**: a walk as data (`WalkSpec`, `src/walks/spec.ts`), run by `walkFlow` (`src/walks/flow.ts:610`). Teach and cut write these.
- **Rendered workflow**: TypeScript rendered from an `outline.json` (`src/workflows/<name>/`). The map calls it a compiled workflow.
- **Screen**: a page a walk knows: a recognizer plus an outcome (act, goal, refused or person).
- **Recognizer**: how a screen knows its page. The code `Screen` has `at` (URL regex), `shows` and `hides` (elements), `says` (text regex) and `is` (a function) (`screens.ts:34-57`). A `ScreenSpec` has only a URL shape and exact landmark strings (`spec.ts:188`).
- **Kit**: the screens and ops every sign-in shares.
- **Person step**: the run stops and asks William to act in the window (`personStep`).
- **Hold**: after a failed sign-in, the account waits before the next try. The wait depends on the case ("Holds" below). Before this task: 12 h when the site refused or a secret was typed, else 30 min (`src/auth/login.ts:1036-1084`).
- **Heal**: an agent changes a stored artifact after a failure.

William said "compiled workflows". Two artifacts here are made from runs: rendered TypeScript and built walks. The options differ on which one a sign-in becomes.

## What exists (read 11-26)

- **One runtime.** `formWalk` (`login.ts:296`), `googleWalk` (`src/auth/google.ts`) and `walkFlow` all end in `walk()`. `walk()` holds the stuck check and the unknown-page ladder: learned rows, then the model reader (`unknown`, `screens.ts:386`).
- **Screen order.** `walk()` checks screens in list order (`observe`, `screens.ts:331`). `walkFlow` sorts a built walk first: goal, then by landmark count (`ordered`, `flow.ts:182`).
- **Sign-ins as data, two kinds.**
  - `DataLogin` (`src/mods/login.ts:48`): one JSON file per site under `logins/`, made into `formLogin` or `oauthLogin`. `formWalk` is already a kit: captcha, rejected with the previous password once, passkey, a code step per kind, person, trust, saved accounts, one-page and two-page forms. It holds the state across screens (`submitted`, `typedPrevious`) and fails with `LoginFailed`. 7 built-in sites use it. Regexes in JSON are strings (`regexOf`, `mods/login.ts:35`).
  - A built login walk (`src/walks/login.ts`, `walkLogin`): a `WalkSpec` named `login`. No live run so far.
- **Load order.** `addSiteLogins` skips a site name already taken (`src/auth/sites.ts:1030`). Built-ins load first, so built-in `apple` hides `apple.json`, and `learnLogin` hides the `learn` built walk.
- **Gaps in the built-walk path:**
  - Open: `walkFlow` gives `walk()` no `fail` (`flow.ts:537`). An unknown page goes to a person (`screens.ts:446`), not `LoginFailed`, so no next method and no hold.
  - Open: `walk()` gets `{ fp }` only. A kit op needs `SignInContext` (`code`, `serial`, `offers`, `notify`; `login.ts:59-91`).
  - Fixed 11-26 (e71fc9d): `walkLogin` now types the password through `passwordOf`, so the origin guard, the audit row and the hold see it.
- **A gap in every walk, today:** the reader can name a screen that types a secret, on a page no screen matched. `walk()` then acts with no second check (`screens.ts:416-471`). `formWalk` has this gap too. Only the origin guard and the audit row stand behind it.
- **Moved controls already heal by adding.** On each act, a kept fix runs first, then the repairer; a fix that works is kept by flow, goal and the broken hints, and the old hints stay (`src/browser/fixes.ts:1-8`, `src/browser/flow.ts:666-735`). Fixes are keyed by the outer flow, so each flow that calls a sign-in learns its own fix.
- **Heal never sees a sign-in.** `classifyFailure` sorts "sign in" or "log in" errors as `wall` (`src/agent/heal.ts:91`). `healFailure` skips all but `locator` (`heal.ts:183`). Heal replaces a step's ops (`replaceOp`, `src/compiler/patch.ts:76`); rule 1 forbids that.
- **Heal output home.** Rendered workflows live in `src/workflows` of this checkout, which the desk (the worker on this Mac) also runs. Built walks and `logins/` live in the state dir (`~/.config/autobrowse/`), which a deploy never touches.

## Inventory

`SITE_LOGINS` (`sites.ts:990`): 24 entries plus the 5 Google apps, 29 in all. Microsoft is no entry of its own; outlook reaches it.

| Shape today | Sites | Screens they handle |
|---|---|---|
| Straight-line code (7) | instagram, x, linkedin, github, facebook, tiktok (`src/auth/<site>.ts`); aws (`sites.ts:413`) | code (totp, sms, email; kind from the page text), "send code", "Not now" for save login and notifications, person step (captcha, selfie, Arkose), rejected password, account restricted, GitHub "More options", AWS root or IAM and "Allow" |
| Code walk (4) | google (19 screens), outlook through microsoft (11), cloudflare (5), learn (8) | passkey, push with a 180 s wait, chooser, One Tap, terms, consent, previous password once, Duo sms, Google popup handoff |
| `formLogin` (7) | instantly, intuit, npm, apple, discord, reddit, costco | the `formWalk` kit above |
| `oauthLogin` (5) | anthropic, twilio, hubspot, sentry, perplexity; also the `via: google` paths of linkedin and github | Google popup; twilio's own sms step; perplexity's modal |
| Delegates (6) | google-admin and the 5 Google apps | none of their own |

Outside the list: `pageSignIn` (`src/auth/page-login.ts:139`, any site with no sign-in), `viaLogin`, `emailCodeLogin`, `walkLogin`, `loginOf`.

Google's `secondStep` (`google.ts:110-166`) is decision code: passkey, then totp, then a masked phone matched by its last digits under the inbox lock, then a push wait. No data screen expresses it well.

## Options

All five keep one runtime (`walk()`) and one hook: the artifact runs as a `SiteLogin` under `loginProvider`, so holds and audit stay.

### A. A sign-in is a built walk (`WalkSpec`); the kit is shared screens and ops

- Each site: `src/walks/logins/<site>.ts` in the repo, one typed object literal (data only: regexes as strings, no functions), checked by `walkSpecSchema` on load. A static index (`src/walks/logins/index.ts`) lists them, since the npm build has no `.ts` to scan. They load before the state dir. The commit that adds a site's file removes its built-in entry.
- The recognizer becomes the code `Screen` as data: `at`, `shows`, `hides`, `says`, regexes as strings through `regexOf`. Built walks gain it too. Login walks keep file order: site screens, then kit screens.
- Outcomes: ops, goal, `refused { says }` (throws `LoginFailed` with `refused: true`), `person { why }`.
- `walkFlow` takes `fail` (a login walk fails with `LoginFailed`) and `signIn: SignInContext`.
- The kit: `formWalk`'s screens move into one module that `formWalk` and login walks both use. New kit screens: "Not now" (save login, notifications), account chooser, "send code". Kit ops hold the state across screens:
  - `password { field, submit }`: types `passwordOf`; a form that comes back after it fails; the previous password once on a rejected screen.
  - `code { kinds, field, submit, send? }`: asks under `ctx.serial`, each ask after the last code.
  - `passkey`, `push { waitMs }`, `provider { name }` (hands off to `providerOf(name).signIn`).
  - `second-step { order }`: Google's choice of passkey, totp, a masked phone by its last digits, or push, from the credential and the page (`google.ts:110-166`). Microsoft's push and Cloudflare's saved-profile chooser get the same treatment: decision code lives in a kit op; the data file names it.
- Google, Microsoft and Cloudflare convert too (William, 11-26), last, after the form sites prove the kit.
- Example, Instagram (the shape; the real file is `src/walks/logins/instagram.ts`). The goal counts only after a secret was submitted, and `/challenge/` is a sign-in page, not the goal:

```json
{
  "name": "login", "site": "instagram",
  "start": "https://www.instagram.com/accounts/login/",
  "signedIn": { "url": "/^https:\\/\\/www\\.instagram\\.com\\/(?!accounts|challenge)/" },
  "screens": [
    { "name": "login form", "shows": [{ "role": "textbox", "name": "/username|email/i" }],
      "ops": [{ "kind": "fill", "field": { "role": "textbox", "name": "/username|email/i" }, "value": "$username" },
              { "kind": "password", "field": { "role": "textbox", "name": "/^password$/i" },
                "submit": { "role": "button", "name": "/^log in$/i" } }] },
    { "name": "rejected", "says": "/password was incorrect|user not found/i",
      "refused": { "says": "password rejected" } },
    { "name": "code", "at": "/two_factor|challenge/",
      "ops": [{ "kind": "code", "kinds": ["totp", "email"],
                "field": { "role": "textbox", "name": "/security code|^code$/i" },
                "send": { "role": "button", "name": "/send (security )?code/i" } }] },
    { "name": "selfie", "says": "/video selfie|captcha/i",
      "person": { "why": "Instagram wants a check only a person can pass" } }
  ]
}
```

Trade-offs: one data format for every branching flow, sign-ins and taught walks alike. The kit logic is `formWalk`'s, which has live runs. Cost: the recognizer, two outcomes, five kit ops and the context in the interpreter; `walkLogin` has no live run yet.

### B. The compiler emits a code walk (rendered TypeScript with screens)

- An outline step gains `screens`. Render writes `walk(ctx, { screens })`. Each sign-in: `src/workflows/<site>-login/`.
- Heal adds a screen to `outline.json`, then renders, typechecks, tests and proves.

Trade-offs: typed source and a test per sign-in. A heal on the desk writes `src/workflows` in the shared checkout; uncommitted, it holds every desk deploy. Each heal runs tsc and vitest on a 16 GB Mac.

### C. Every rendered workflow becomes a built walk

- A, then the rendered workflows (10 with an `outline.json`) move to `WalkSpec`. Render and the TypeScript heal retire.

Trade-offs: one artifact and one heal. Moves the Workflow editor and the heal job too. Not needed for sign-ins.

### D. TypeScript sign-ins as screen tables

- Each sign-in becomes a `Screen[]` table in TypeScript plus the kit module.

Trade-offs: smallest change, full types. Sign-ins stay hand-written, against William's first quote.

### E. Grow `DataLogin`; `formWalk` is the kit

- `DataLogin` gains the `FormLoginSpec` fields it lacks (`person`, `passkey`, `trust`, `keepSignedIn`), an optional `start`, and `screens[]`: data `Screen`s with click and fill ops, secrets by name.
- `formWalk` runs the site's screens first, then its own.
- Built-in sites move to `src/logins/<site>.json`.

Trade-offs: the least new code, on a path with 7 live sites. Sign-ins get a second data format that branches, beside `WalkSpec`, with its own heal overlay and loader. A later merge with built walks is option C's work again.

### Priorities and ranking

1. Secrets stay safe. All five can. A and E need the reader fix below; A also needs the `fail` and context fixes.
2. Heal adds and survives a deploy: A, C, E (state-dir overlay). B writes source in a shared checkout. D has no heal.
3. One branching format, per William's second quote: C, then A. E and D keep sign-ins apart. B keeps two compiled forms.
4. Risk to live sign-ins: D, then E, then A. Each switches per site behind parity.

**Recommendation: A.** It makes a sign-in the same artifact as every other branching flow, which is what William's second quote asks. E is safer this week but adds a second branching format to merge later. A takes E's main strength: its kit is `formWalk`'s code. C stays open for later.

## Heal on a sign-in (option A)

- **Trigger:** `loginProvider`'s catch (`login.ts:1073`) starts one heal when a sign-in fails with its own `LoginFailed`, never one with case `password` or `account`. One heal per site per 24 h. It does not go through the failure-record pipeline.
- **A moved control:** fixes and the repairer, as today. Sign-in acts key their fixes under `<site>/login`, so one fix serves every caller.
- **A known screen with a new look:** learned rows, as today. A row maps the look to the screen; the screen stays.
- **A page no screen acts on:** the agent works from the failure page as caught before anything leaves it (`SignInHealAsk` in `login.ts`: URL, page snapshot, error, steps so far), goal "finish this sign-in screen". It opens no live session on the account. The agent never holds a secret; where one goes it names a kit op. The result is one screen in `walks/<site>/login-heal.json` (state dir), marked `from: heal`.
- **Trial:** every heal screen runs as a trial, a secret op included (William, 11-26). One sign-in that passes through it makes it kept; a failure drops it. A session may later commit a kept screen to the repo file (`walks promote`). A bad try sets the hold its case gives; the session check (771eacb) lifts a false one.
- **Overlay load:** per screen, after the repo file. A screen that fails the schema (a repo screen it names was renamed) drops alone with a warning; the rest load. Trial counts go to an append-only log, so two accounts of one site never overwrite each other.
- **Reader fix (all walks):** screens with a secret op leave the reader's `known` list (`screens.ts:393`). A secret then goes only on a page a recognizer matched.

## Holds

William, 11-26: the hold depends on the case, with a short backoff ("1 min 3 min 5 min etc"). "one time code fials are pretty lenient, because a lot of the times emials dont work or need resend". A password the site rejected stays strict. This replaces the 12 h hold on any typed secret (378afbe).

The case comes from the failure, not from words. `LoginFailed` carries `case`: the kit ops and `typedSecret` set it from which secret went last and which screen came after. The `SITE_REFUSAL` regex stays only for sites not yet converted.

| Case | When | Wait | Cap per 24 h, then 24 h and a note |
|---|---|---|---|
| `password` | the site said the password is wrong | until the stored password changes (`liftHolds`), or 24 h | none: one is the cap |
| `account` | the site locked or refused the account or this browser | 24 h | none |
| `unproven` | a password went in, no later screen came, the site said nothing | the ladder from 10 min | 3 password fills |
| `code` | a code went in and the site said no, or no code came | the ladder from 1 min | 6 |
| `later` | the password worked (a later screen came), then the walk failed | the ladder from 1 min | 6 |
| `ours` | nothing secret went in | the ladder from 1 min | none: nothing typed |

- **The ladder:** 1, 3, 5, 10, 30, 60 min, then 60 min. The rung is the count of failures in a row since the last sign-in that worked. Each wait gets ±20 % jitter, so tries fall on no fixed rhythm.
- **Only a later screen proves a password.** A password typed and the form back with no words is `unproven`, never `later`. So a wrong password the site did not name is typed at most 3 times in 24 h.
- **A short hold pages nobody.** A hold of 60 min or less throws `SignInHeld` (the run fails; its caller tries again later). A 24 h hold throws `NeedsHuman` and notes William.
- **The hold file** keeps `until` and `error` (the sidecar reads them) and adds `case`, `fails` (in a row) and `recent` (the capped failures of the last 24 h). The jitter takes an injected random source.
- **Every try is logged:** one JSON line per sign-in try in `sign-in-tries.jsonl` beside the hold file: name, method, case, the screens passed, the URL it ended on, typed or not, the hold set, the time. No secret goes in it.

## Lockout

A site locks an account after several bad secrets in a short time. The guard is a count per 24 h, not a long wait:

- At most 3 password fills per account per 24 h that no later screen proved (`unproven`, plus the previous password once on a rejected screen). A rejected password stops all fills until the password changes, or 24 h.
- At most 6 failed code tries per account per 24 h. Codes are lenient: a site sends a new one.
- `password` fills only an `input[type=password]`. `code` fills only a box shaped for a code (`autocomplete=one-time-code`, a numeric input mode, or a max length of 4 to 8). A heal screen cannot aim a secret at any other box.
- A secret goes only on the spec's origins (the guard), with an audit row.
- At most one heal per site per 24 h. The heal continues the failed try from its page; it starts no new try.
- A trial screen that fails is dropped and never runs again.
- Two failed heals for one site in 7 days: heal stops for that site, and William gets a note.

The session check (771eacb) lifts a hold when the account is in fact signed in.

## Proof (designed first)

Build order: the kit leaves `formWalk` first, with `test/auth.test.ts` unchanged as the parity bar (7 live sites run on it). The simulated site comes before any site converts. The live Instagram try is last.

1. **Parity.** Data screens compile to `Screen` objects and match through `fp.has` and `fp.text` (`isOn`, `screens.ts:309`), so the `fakePage` scripts (`test/auth-fakes.ts`, the site tests) run on them. The old and new sign-in must give the same act lines on each script. The old tests go with the old code.
2. **Fixtures.** Each real sign-in screen as scrubbed HTML: signed-out pages saved look-only, later screens from past failure artifacts. A Playwright test walks each branch: chooser, code, save login, refused, and an unknown page that ends in `LoginFailed`.
3. **Look-only live.** `explore --look-only` opens each site's login page. The walk names the screen. Nothing is typed.
4. **One live sign-in, Instagram first,** after 1 to 3 pass. One try; the hold applies. Then the rest by shape.
5. **Simulated site.** A local server (`test/sim-site/`) serves a sign-in that changes on command: a renamed field, a new page between steps, a wrong password, a wrong code and a resend, a page no screen knows. It counts bad passwords and locks the account as a real site would; each test asserts it never locks. The heal agent is scripted and the clock injected. It runs its own headless browser and stops it after. Cases: renamed field (a fix heals it), new page (a trial screen heals it and is kept), wrong password (no retype), wrong code then resend, unknown page (`LoginFailed`), a trial that fails (dropped), a second failed heal (heal stops), a secret aimed at a box that is not a password box (refused), a wrong origin (refused).
6. **Switch per site.** The site's file and the removal of its TypeScript sign-in go in one commit, after its parity and look-only checks pass.

## One format, one schema

William, 11-26: "i just want things to be unified where typing can be similar so theres less maitenance overhead". So C follows A.

- One zod schema (`walkSpecSchema`) types every walk: sign-ins, taught walks, and later the rendered workflows.
- A repo walk is a `.ts` file: `export default { … } satisfies WalkSpecInput` (`z.input` of the schema), so tsc checks it as you type. William agreed (11-26): typed `.ts` walk files plus one shared test runner.
- One test file (`test/login-walks.test.ts`) loads every repo walk through the schema and runs each site's scripted pages; a new site adds a script, not a test file.
- A walk in the state dir (taught, cut, or a heal overlay) stays JSON. `z.toJSONSchema` emits the schema as a file (as `cutJsonSchema` does, `src/walks/cut.ts:144`) for those. `walks promote` copies a kept heal screen into the repo file as text.

## Non-goals

- Option C in this task. It is its own task, after A ships.
- An outline step that runs a walk inside a rendered workflow. Built walks already branch and run as catalog flows (`<site>/walk-<name>`, `flow.ts:609`). Own task.
- New sign-in sites. Sites with no stored account are proved by fixtures only.
- Learned rows for interrupts in other flows.

## Risks

- A data file can hide a typo a type would catch. Mitigation: the schema, parity and fixtures.
- A kit screen can match a site's own page (a "Not now" that is the flow's own). Mitigation: file order puts site screens first; kit screens act only on exact names.
- A failed trial screen that typed a secret counts toward the caps. Mitigation: one heal per site per 24 h; the origin guard and the audit row; the session check lifts a hold when the account is signed in.
- Google's walk has 19 screens and two 180 s waits. It goes last.
- `walkLogin` has no live run. Mitigation: Instagram alone first, behind steps 1 to 3.
- A resumed try runs a `once` password screen again (`handled` is fresh per try, `flow.ts:518`). `formWalk` does the same today; out of scope.
- A short hold (1 min) lets a broken flow try again soon. Mitigation: the ladder, the caps per 24 h, and the try log to see it.
- The walk name changes from `sign-in` to `login`, so learned rows under the old name stop matching. They come back on use.

## Cards that change

`map/processes/heal.md` ("Does not hit: sign-in walks" becomes "hits"), `map/objects/build/walk-spec.md`, `map/objects/auth/site-login.md`, the screen card, `README.md` (sign-ins as data).

## Open: William's decisions

1. Decided 11-26: A. Then C, so one format holds every flow that branches.
2. Decided 11-26: a heal screen that types a secret runs as a trial before any commit.
3. Decided 11-26: Google, Microsoft and Cloudflare are in scope.

## Decision log

- 2026-11-26: Doc written. Option A recommended.
- 2026-11-26: goldfish review: 43 findings (critic 15, reader 15, zoom-out 13), 30 applied, 6 rejected; open: decisions 1 to 3. Added option E, the heal trigger, the reader fix, fixes for moved controls, the loader and overlay rules, an Instagram example; moved the outline `walk` op to its own task; decision 2 now keeps secrets off trial screens.
- 2026-11-26: William: Google, Microsoft and Cloudflare in scope ("shoudl be in scope"); a secret on a trial screen is fine ("typing a secret befor ea commit is fine"). Added the `second-step` kit op. Open: decision 1.
- 2026-11-26: William picked A ("sure we cand o A") and asked for one format with shared typing. C follows A as its own task. Added "One format, one schema".
- 2026-11-26: William asked if the 12 h hold plus secrets on trial screens risks lockout. Added "Lockout": the hold caps bad tries at one per 12 h; secret ops fill only password or code boxes; two failed heals in 7 days stop heal for that site.
- 2026-11-26: William: case-aware holds with a short ladder ("1 min 3 min 5 min etc"), lenient codes, a rejected password strict; typed `.ts` walk files and one shared test runner. Added "Holds"; Lockout now counts per 24 h. My calls: `unproven` for a password with no later screen, caps 3 and 6, a 60 min ceiling then 24 h at the cap, `SignInHeld` for short holds, the simulated site before any conversion.
- 2026-11-27: Built. Every built-in login is now a repo walk (`src/walks/logins/*.ts`); `SITE_LOGINS` starts empty and the walks join first at boot, marked built-in, so no mod or owner login replaces one. Google went last (63128e7); its apps come from `WALK_APPS`. My call: heal works from the failure page's snapshot, not a live session: the page is caught before the walk moves on, and no second session touches the account.
