# Teach mode

Living doc. Started 2026-10-05. William: "a manual mode for autobrowse where you can do a workflow (not an agent) and that gets created into a deterministic workflow, but with values generalized so the workflow becomes flexible for other users / future uses."

## Answer first

`autobrowse teach <site> <name>` opens a headed browser and you do the chore by hand. When you're done, autobrowse builds a walk from that one run: data, not code, and replayed with no model. It also decides where each value should come from next time:

- your profile;
- a secret;
- a field asked for on each run, with what you typed as its default;
- or fixed.

You confirm the guesses in one short review. `--mod <dir>` packs the walk into a mod for someone else to install. Their own profile and secrets fill it.

## What exists

- `explore` already journals a person's acts (`act` rows with `hand: true`), but with no look, because the page had already changed by the time it was seen.
- `walks build` turns runs into a walk: screens by look, ops, and value sources (`plan`, `secret`, `literal`). A typed value becomes fixed only when two runs typed the same thing.
- `walks run` replays a walk, takes `--plan k=v`, and falls back to each field's example.
- `record` plus `compile` turn a recording into TS code. It stays for chores with a terminal or desktop part. Teach is the browser path, and it never writes code.
- Owner profiles (`src/money/profile.ts`): name, birthday, gender, address, email, phone and tax id. Billing forms already fill from them.

## The session

1. `autobrowse teach <site> <name> [--url <start>] [--goal <words>] [--profile <id>]` starts explore headed and paused, driver `person`, on the site's logged-in Chrome profile.
2. After each of your acts the page settles (the DOM-quiet wait), and explore takes a look. It becomes the next act's `look`, so a run taught by hand has looks like an agent's run, and `walks build` can find its screens.
3. You type `done` in the terminal, or close the browser. With no `--goal`, it asks for the goal in one line.
4. It builds and reviews (below), writes the walk, and prints the command to run it.

Teach the same name again and that run is added to the walk's runs. The build then uses every run, as `walks build` does today. A value that was the same each time stays fixed, unless the review said otherwise.

## Where values come from

The build guesses in this order, and the first match wins.

| You typed | Becomes | Why |
|---|---|---|
| a secret, or a field the redactor hid | `{from: "secret"}` | as today |
| exactly a profile value: full, first or last name, email, phone, a line of the address, city, postal code, country, birthday | `{from: "profile", field}` | it's about who runs it, so another user's profile fills it |
| a date | a field whose default is relative to the day you taught it (`today+3d`) | a fixed date is wrong tomorrow |
| a number or an id that also shows in the URL you landed on | a field, and the URL becomes a template (`/projects/{project}`) | the same flow on another record |
| anything else | a field asked each run, defaulting to what you typed | safe default: never silently fixed |

Clicks:

- A click whose target text equals a field's value, such as picking the search result you just typed, targets `{field}`. It follows the value, not the row.
- Other clicks stay as they are.
- A select stays fixed, and the review can make it a field with the options it saw.

The walk spec bumps `WALK_VERSION` to 2:

- `valueSchema` gains `{from: "profile", field}`;
- fields gain an optional `default` (literal or `today+Nd`) and `options`;
- `open.url` and click hints may name `{field}`.

Version 1 walks still load unchanged.

## Review

Each value is one line, `label · what you typed · guess`. You keep the guess with Enter, or press `f` for fixed, `a` for ask each run, `p` for profile, or `s` for secret. There's one screen in the terminal, and `--yes` takes every guess. Secrets are never shown, only their labels.

## Running it

`autobrowse walks run <site> <name> [--plan k=v] [--profile <id>]`:

- A field with no value and no default is asked for in the terminal, or with `--ask` when a model drives.
- Profile fields come from `--profile`, else the only profile there is.
- The wren `sites` facade and MCP take the same plan object.

## Mods

`--mod <dir>` writes the walk to `<dir>/walks/<site>/<name>.json` and adds it to `mod.json`, as `walkthrough/mods/autobrowse-mod-scratch` does. Publishing stays the mods doc's step (a version bump, then publish).

A walk with fixed values that look personal won't pack until the review says so. Those values are an email, a phone or an address that isn't from the profile.

## Phases

- T1. Looks after hand acts in explore, plus `teach` (the session, a single-run build, writing the walk).
- T2. Value guessing: profile, date, URL id, click-by-field. Then spec v2, with `walks run` reading it.
- T3. The review screen, `--yes`, and `--mod` packing with the personal-value check.
- T4. An end-to-end test on the scratch site:
  1. Teach the localhost join-list form by hand, scripted through the page as a person would.
  2. The name and email become profile values, and the note becomes a field.
  3. Replay with another profile and another note, and land on the thank-you page.

  Plus the docs: README, the map's `walk` card, and `walkthrough/`.

## Done when

- The T4 test passes in `pnpm -s gates`.
- A real chore taught on William's Mac replays from a fresh terminal with a different field value. Pick one with no spend and no posting, such as a newsletter signup to his own inbox.
- The scratch mod republishes with a taught walk in it.

## Teach on by default (2026-11-11)

William: "teach mode should be like implicitly on". Every headed session a person acts in can become a walk, with no `teach` command first.

- A run with at least one hand act ends: explore builds a draft walk from it at once. No questions, every guess taken.
- Drafts live in `<state>/walk-drafts/<site>/draft-<run>.json`, beside the walks, never among them: they never run by name and never pack.
- The commands sit under `walks`: `teach drafts` would read `drafts` as a site.
- `autobrowse walks drafts` lists them, newest first: site, run, screens, fields, goal.
- `autobrowse walks keep <site>/<draft> <name>` builds the walk again from that run under its real name, with the review. `--yes` takes every guess. The draft goes.
- `autobrowse walks drop <site>/<draft>` deletes one.
- Skipped: a `teach` session (it builds its own), a run that ended `failed` or `unknown`, an idle close that resumes later.
- A draft also takes a run that ended `closed` (a person closed the browser). A real walk still needs `achieved` or `saved`; `keep` is the person's word that the run did its job.

| Option | Verdict |
|---|---|
| A. Build a draft at the end of each hand run; keep or drop later | **Chosen**. No question during work; nothing lost; the review waits for a person who wants the walk |
| B. Ask at the end of each hand run ("make this a walk?") | No: a question after every chore; an agent's session has nobody at a terminal |
| C. Build nothing; `walks keep` builds from any old run on demand | No: a person must find the run id; nothing tells them a walk is possible |
| D. Save each hand run straight as a walk | No: walks fill with half chores and guesses nobody checked |

## Keep a sign-in a person types (WA-1307, 2026-11-11)

William: a person signs in by hand in a headed session. autobrowse keeps that username and password, sealed, so nobody pastes a password into `creds set`.

- The observer already sends each typed value to explore, and `redactRaw` already masks a secret before the journal. The password stays out of the journal, the trace, the answer and the log, as today.
- New: in the same step, explore holds the value in memory, with the site and the field. It also holds the last name typed into a username, email or phone field on that site. A sign-in that spans two pages (name, then password) still pairs.
- No name was typed (the site filled it): explore reads the page's username or email field once, in code. The agent never sees it.
- Trigger: a submit, Enter or click after the password, then the page settles. A password field still visible means a wrong password: nothing is asked, and a new try replaces the held one.
- Then the overlay asks once: "Keep this sign-in for instagram@w.jin1?" with Keep and Not now. Not now drops it; the site is not asked again this session.
- No overlay (off, or it cannot draw): the held sign-in waits for the session end. A `teach` terminal asks there. Elsewhere it is dropped, with a trace note.
- Keep stores it under `<site>@<username>` through the credential store (`creds` history keeps every write).
  - The same password already stored: nothing changes.
  - A different password under that name: the new one goes under `<site>@<username>-<YYYY-MM-DD>`. Never an overwrite (no-silent-overwrite). `creds merge` or `creds rename` picks later.
- The answer to the next command says `kept: "<name>"` and never the value. A teach walk's `{from:"secret"}` value now has a credential to fill it.

| Option | Verdict |
|---|---|
| A. Hold the observer's typed values in memory; pair the name and the password; ask after the submit settles | **Chosen**. Uses what the page already sends; nothing new reads the DOM; holds across a two-page sign-in |
| B. A page script reads the form's fields at submit | No: a second path that sends the password through the page's world; misses a sign-in split over two pages |
| C. Read Chrome's own saved passwords (Login Data, Keychain) | No: Chrome asks the person first, the profile may never save, and decrypting the Keychain needs his password |
| D. Read the sign-in POST body from the network | No: each site's body differs (JSON, form, encrypted at Instagram) |

## Decision log

- 2026-10-05: Written. Build on walks, not `record` plus `compile`: walks are data, so they pack, diff and run with no model, and compile writes code a buyer has to trust. One run is enough. Ask-each-run with a default is the safe guess, so nothing personal gets frozen in by accident. Profile is the "other users" seam: the same walk runs as whoever's profile is loaded.
- 2026-10-05: Built. Teach runs explore unpaused with driver `person`. A pause would fold every act into one human op. A hand act is journaled with the last quiet look before it, and a person session that ends by closing the browser ends `achieved`. With no terminal (a script on the loopback), teach ends on `close` or the browser.
- 2026-10-05: `default` is what was typed. `a` drops it so every run asks. v2 never falls back to `example`; v1 walks still do, and still load.
- 2026-10-05: `{field}` works in open URLs, click hints and select values, not in `start`. Profile match is exact, case-insensitive; phones are not normalized. Click-by-field only covers plan fields.
- 2026-10-05: Skipped select `options` capture: the observer never sees the option list. The schema has the slot, nothing fills it yet. Skipped `walks run --ask` for model runs and any MCP or sites change: both already pass plan input.
- 2026-10-05: `walkFor` wires profile values on the Mac, so desk runs get them too. `packInto` keeps the mod's version; a person bumps it.
- 2026-10-05: Real chore. Substack (simonw) was dropped: its signed-in cookie skips the email screen, and it folds `+tags` into one account, so a replay with another address hits a sign-in. Taught Postgres Weekly (Cooperpress, no captcha) as `postgresweekly/subscribe` with william+pg@wren-automation.net; replayed with `--plan email=william+pg2@…`, reached "Check your email".
- 2026-10-05: Found while teaching. An unlabeled radio had nothing to find it by: the observer now records `nth` among its kind. explore's own "a person did N act(s)" note named screens: build skips it. A placeholder like "you@example.com" named the field: an email, tel or url input whose only name is its placeholder is named by its type.
- 2026-10-05: A mod packed with a v2 walk needs autobrowse that reads v2, so `packInto` sets `autobrowse` to `>=` the packing version, and autobrowse goes to 0.4.0. Scratch mod 0.2.0 holds the walk taught by hand (name with a default, start date `today+7d`).
- 2026-10-05: Select options now recorded. The observer sends a select's option values (first 100) with the choice, the review's `a` makes them the field's `options`, and `walks run` lists them when it asks.
- 2026-11-11: Teach on by default: a draft walk from every hand run, kept or dropped later (option A). WA-1307: a sign-in typed by hand is held in memory, asked once in the overlay, stored under a new dated name when its password differs (option A).
