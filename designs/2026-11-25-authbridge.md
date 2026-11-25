# authbridge: sealed sign-in snapshots (2026-11-25, WA-1440)

## Goal

A Chrome profile's sign-in can be saved, rolled back and moved to another machine. Today it lives only in the profile folder on this Mac (115 profiles, 14 GB, counted 11-25). A broken or signed-out profile has no copy. No other machine can use it: not the box worker (the AWS host that runs browsers off the Mac), not the shared runner on Postgres when it exists.

Target state: after a run that signs in, autobrowse saves the profile's browser state (cookies, localStorage, IndexedDB), sealed and versioned in S3. `authbridge restore` puts any version into an empty profile folder, on any machine that reads the owner's SSM path and S3 prefix.

Precedent: Browserbase Contexts (one saved state per login; never two live sessions on one).

## Options

Where the code lives:

| | Option | For | Against |
|---|---|---|---|
| A | Inside autobrowse (`src/authbridge/`), split out later | Fewest moving parts; the sign-in code it hooks stays where it is | One more folder in a large repo |
| B | `authbridge` package now: snapshots, code sources, hand-off, sign-in log | Cleanest seams | One consumer; the sign-in code needs autobrowse's browser code, so the split cuts `SignInContext` in half |
| C | Snapshots in credvault | It already seals, syncs, audits | Its charter is "no browser"; an SSM parameter holds 8 KB at most; a cookie jar changes on every visit, it is not a credential |
| D | Browserbase hosted Contexts | Built | Not self-hosted, paid, their fingerprint |

How the state is captured (the harder choice to change):

| | Capture | For | Against |
|---|---|---|---|
| 1 | Copy of the profile folder | Complete: service workers, passkey state, everything | Mac only: Chrome encrypts cookies with the Keychain key "Chrome Safe Storage"; GBs per profile |
| 2 | Playwright `storageState` | Portable JSON, KBs; any OS opens it | Storage only of origins the process visited; no service workers |
| 3 | Both: 2 for every save, 1 as the local rollback at restore | Portable copy plus a full local undo | Two paths |

Ranked priorities: 1 account safety (no forked sessions, no lost sign-in); 2 portability to the box and to owners; 3 fewest moving parts now; 4 clean seams.

Decision: A with capture 3 (William, 11-25: "A. makes sense, we can call it authbridge internally"). Capture 3 costs nothing extra: a restore over an existing folder moves that folder aside, which is the folder copy. `src/authbridge/` imports from the rest of autobrowse only the session-cookie table, so it can move into a package when a second consumer exists (the shared runner, or a page where a client connects their own account; that page is when a Live View hand-off earns its place).

## Words

- **snapshot**: one saved browser state of one profile, with its meta. Never "context": `SignInContext` already means the bound sign-in inputs, and `BrowserContext` is Playwright's.
- **version**: one snapshot's id, its save time (`20261125T203720238Z`).
- **pointer**: `latest.json` per profile: the newest version and the holder.
- **holder**: the machine that may save the profile. Its name is `AUTOBROWSE_MACHINE`, else the Mac's host name. Off a Mac without `AUTOBROWSE_MACHINE`, authbridge is off: a container's host name changes on every deploy.
- **exit**: the egress line a profile goes out through (`src/browser/egress.ts`, `EGRESS_<NAME>`); null = the machine's own line.
- **proof of sign-in**: the site's session cookies from `SESSION_COOKIES` (`src/auth/session-status.ts`), present and not expired. 10 sites have them.

## Shape

- S3: the shots bucket (`SHOTS_BUCKET`); the papers bucket refuses all but William's own user. Default owner: `signins/`; another owner: `owners/<owner>/signins/`, where the owners role may put, get and list (`deploy/terraform/owners.tf`, applied 11-25). Under it: `<profile>/<version>.sealed` and `<profile>/latest.json`. Kept, never expired: no lifecycle rule covers these prefixes. The store: `src/shots/s3.ts` (the file that names the bucket vendor); a folder store in `src/authbridge/store.ts` for tests. Box access to the shots bucket is not checked yet.
- Seal: gzip, then credvault `aesGcmCipher` with `AUTHBRIDGE_SEAL_KEY` (32 random bytes, base64). Made once in the owner's SSM path, with a put that refuses to replace a held value, then read back: of two first writers, the stored key wins. Then cached in the local env file and read from there: SSM needs the AWS login, which expires; a save must not.
- Meta, plain, in the pointer and the snapshot: profile, version, saved at, machine, user agent, platform, exit, origins, cookie count, why (`sign-in`, `first`, `refresh`, `cli`), holder, sealed bytes. Never a value.
- Write order: the version object first (`If-None-Match: *`), then the pointer, compare-and-swap on its ETag (`If-Match`, or `If-None-Match: *` for the first). A lost race leaves an orphan version: listed by `list <profile>`, harmless.
- Size: 7.7 KB sealed for a Reddit profile (measured 11-25). A heavy IndexedDB site can reach MBs. All versions kept ("keep data"): about 115 profiles × 1 save a day × tens of KB is under 1 GB a year, cents a month.

## When it saves

The runner (`src/browser/flow.ts`, after the trace stops, before `leave`) calls `signIns.afterRun(profile, browserContext, signedIn)` when all hold:

- the run ended `ok` and the browser is not broken;
- the tier is `local` and the session is not `shared`: never the person's own Chrome (`own`) or an attached app (`cdp`), whose context holds every site they use;
- `BrowserOptions.signIns` is set. `browserOptions()` (`src/app/services-browser.ts`) sets it for every runner it builds; the `authbridge` CLI clears it for its own browsers.

`signedIn` is true when the run signed in (either sign-in path in `flow.ts`) or a person had the run (`withPerson`: a hand-cleared 2FA is the costliest session to lose).

The bridge (`src/authbridge/bridge.ts`) then saves when:

1. `signedIn`, or
2. the site has proof of sign-in and this machine's last save or check of the profile (the index file `signins.json` beside the credentials file) is missing or older than 24 h. A site without proof never saves on this rule: a run can end ok on a wall it was told to allow.

A save whose state lacks the proof of sign-in is dropped ("signed-out") and the check is recorded, so the next run waits a day. One save per profile at a time per process (an in-flight map). A save past 60 s, a held profile or a lost pointer race is logged to stderr and never fails the run.

Cold profiles: Playwright collects localStorage and IndexedDB only for origins the process visited. `authbridge save` first visits, in one page whose every request is answered locally with an empty document (`page.route`, no network): each cookie host as `https://<host>`, and each origin named by an IndexedDB folder (`Default/IndexedDB/https_mail.google.com_0.indexeddb.leveldb`). localStorage of an origin with neither is missed: Local Storage keys sit inside LevelDB.

## Restore

`autobrowse authbridge restore <profile> [--version v] [--into <name>] [--replace] [--force] [--no-check]`

1. Load the version (default: the pointer's). The version is fixed before anything else runs.
2. Fit: the platform here (Chrome's `navigator.platform` for this OS) and the target's exit must match the snapshot's. A null exit matches only on the machine that saved it. `--force` skips this. A move from the Mac to the box always needs `--force` (platform) and a named exit both use (IP).
3. Target = `--into` or the profile. If its folder exists, `--replace` is required: the folder must be free (no Chrome lock, no desk reserve), then it moves aside to `<target>.before-restore-<version>-<ms>`, kept. Restore always goes into an empty folder: `setStorageState` clears every cookie but leaves storage of origins it never visited.
4. Apply in a headless browser, then check: the session cookies are present, and when the site's login spec has `loggedIn`, its home page passes it (no sign-in is tried; a wall is a fail).
5. Fail: the new folder goes, the folder moved aside comes back, exit 1. Pass on the same name (a move): the holder becomes this machine, compare-and-swap. Pass on another name (a copy): the holder stays; the copy is its own profile from now on and saves under its own name.

`authbridge save <profile> [--force]`, `list [<profile>]` and `show <profile> [--version]` round it out. All print JSON: sizes, counts and origins, never values.

## Errors

| Error | When | What to do |
|---|---|---|
| `held by <machine>` | a save from a machine that is not the holder | restore it here to move it |
| `the pointer changed under this write` | two writers raced | run again |
| `the profile folder exists; --replace …` | restore onto an existing folder | add `--replace` |
| `platform … ≠ …`, `exit … ≠ …`, `direct line of …` | fit check | `--force`, or restore on a fitting machine |
| `needs SHOTS_BUCKET, and AUTOBROWSE_MACHINE …` | no bucket, or a non-Mac without a name | set them |
| `ProfileBusy` | a Chrome or the desk holds the target | stop that run |

## Non-goals

- Passkeys: `src/auth/passkey.ts` owns them; `storageState({credentials})` stays off (it blocks real authenticators).
- A cross-machine live-session lease. The holder stops a stale save; it does not stop a run on the old machine. The shared runner's Postgres lease does that when it exists.
- Live View hand-off. Waits for a client-facing connect page.
- Restore through the desk. A CLI restore refuses a folder the desk holds; it never races it.

## Risks

- A move still forks the session until the shared lease exists: the old machine can run on its own folder. A copy forks it by design, and says so. A site that rotates tokens may sign out one side.
- The seal key lost = every snapshot lost. It sits in SSM and in each machine's env file. SSM keeps the last 100 values of a parameter (`autobrowse env history`), so a wrong overwrite is recoverable.
- IndexedDB of a heavy site can be MBs. Kept whole; gzip first.
- Hidden collection pages in a headed browser can flash a tab. The desk runs headless.

## Proof

- Unit (`test/authbridge.test.ts`): seal round trip; holder refusal and `take`; pointer compare-and-swap; signed-out never newest unless forced; the runner rule (sign-in saves, refresh only with proof, 24 h); a held profile logs and never throws; the fit check; the holder name.
- Browser test (same file): seed a cookie, localStorage and IndexedDB on a local origin; close; reopen cold; save (IndexedDB folder names give the origin); restore into a new profile; read all three back.
- Live, 11-25: `reddit@alt`, headless. `save`: 10 cookies, 2 origins, 7690 B sealed. `restore --into reddit@abtest`: signed in at `/settings/`. Again without `--replace`: refused. With `--replace`: folder moved aside, signed in. The original still signed in. Scratch folders deleted. (`github` was signed out: `save` refused it, as it should.)

## Log

- 2026-11-25: option A chosen by William. Name authbridge kept internal; the object is `SignInSnapshot`.
- 2026-11-25: goldfish review (critic, reader, zoom-out): bucket moved from papers to shots; seal key SSM only; holder name from `AUTOBROWSE_MACHINE`; refresh saves need proof of sign-in; a person's turn counts as a sign-in; never the `own` or `cdp` browser; restore into an empty folder, old one moved aside; holder moves only after the check passes; null exit matches only on its own machine.
- 2026-11-25: goldfish review: 35 findings (critic 15, reader 15, zoom-out 5), 30 applied, 5 rejected; open: none. Rejected: drop the holder and the pointer compare-and-swap (zoom-out Z2; built and tested, it makes a fork visible in the log, and the Postgres lease replaces it); shrink the location table (William's choice stays on record); a separate real-site check (the live proof is one); passive-voice edits; "storageState's hidden page fires `page` events" (wrong: Playwright's own storage page sends none). Report: scratchpad `goldfish-authbridge-1125/`.
