# Browser engines: Chromium brands, Firefox, WebKit (WA-1450)

A local session can run in a browser engine other than Google Chrome: Edge, Brave, Opera GX, Playwright's Chromium, Firefox, WebKit, or WebKit as an iPhone. One setting, the engine, picks it. A guard that cannot work on an engine refuses the session. It never runs without the guard.

## Why

William, 11-25: "add full webkit ios safari edge firefox operagx support". Then: "address multi browser support for everything outside of chrome hopefully with a dedicated maintained playwright solution". Before this, every local session was Google Chrome, or Playwright's Chromium when Chrome was missing (`BROWSER_CHANNEL`).

## Target state

- `BROWSER_ENGINE` sets the default. `explore --engine` and `record --engine` set it for one session. The flag beats the default.
- Engines: `chrome` (default), `chromium`, `edge`, `brave`, `opera-gx`, `firefox`, `webkit`, `ios`.
- A Chromium brand, Firefox and WebKit each get their own profile folder. A sign-in made in Chrome does not show in Firefox.
- Persistent profiles, the live view, proxies, reap, the memory guard and the doctor work on every engine. The table "What each family can do" lists what does not; the session logs it at open.
- `BROWSER_CHANNEL` is ignored. When it is set, the CLI warns: "BROWSER_CHANNEL is ignored; set BROWSER_ENGINE=…".

## Words

- **Browser engine** (or engine): one value of `BROWSER_ENGINE`. It names one browser build.
- **Family**: the protocol that drives the engine. `chromium` (CDP): chrome, chromium, edge, brave, opera-gx. `firefox` (Playwright's Juggler): firefox. `webkit` (Playwright's inspector protocol): webkit, ios.
- **Brand**: a Chromium build from a vendor (Edge, Brave, Opera GX). Playwright drives it like Chrome, by `channel` or `executablePath`.
- **Playwright build**: Playwright's own patched Firefox or WebKit. It is not the Firefox or Safari a person installs. A site can tell it apart.
- **Exit**: an egress proxy the session leaves through (`egress`), so a site sees the exit's IP, not this Mac's.
- **Fenced run**: an `explore` session with `allowHosts` set. The nav fence (`nav-fence.ts`) holds its top frame to those hosts. Agent runs use it.

## What we measured (2026-11-26, this Mac)

Spikes in the scratchpad (`engines/spike.mjs`, `ps.mjs`, `redirect.mjs`, `redirect2.mjs`): `launchPersistentContext` headless, set a cookie and a localStorage key, relaunch, read them back; `page.screencast` for 2 s on an animated page; `newCDPSession`.

| Engine | Version | Launch | Cookie + storage kept | Screencast frames per 2 s | CDP |
|---|---|---|---|---|---|
| opera-gx (`executablePath`) | Chromium 157, OPR 140 | 1.7 s | yes | 35 (JPEG) | yes |
| firefox (firefox-1543) | 155.0 | 4.6 s | yes | 46 (JPEG) | no |
| webkit (webkit-2359) | 26.6 | 4.7 s | yes | 35 (JPEG) | no |

- Headless Opera GX says `HeadlessChrome/157 … OPR/140` in its UA. Its client hints already say `Opera GX`. The UA fix (`learnFingerprint`, `wearFingerprint`) covers it.
- Headless Firefox and WebKit send a normal UA (`Firefox/155.0`, `Version/26.6 Safari/605.1.15`). They need no UA fix.
- Process trees. Firefox: one root `firefox -no-remote -headless -profile <dir> -juggler-pipe`; its `plugin-container` children do not name the profile; lock file `.parentlock`, with no pid in it. WebKit: a root `bash pw_run.sh … --user-data-dir=<dir>` and its child `Playwright.app … --user-data-dir=<dir>`; no lock file; its pages run in XPC services (`webkit-N/com.apple.WebKit.{Networking,GPU,WebContent}.xpc`) whose parent is launchd (pid 1).
- Opera GX's first `goto` aborted once (`net::ERR_ABORTED`) and passed on the next launch: a race with its start page.
- Redirects under `context.route`: on firefox and chromium the route sees the first request only. A server-side 302 hop to an outside host is never routed. A 302 that the route fulfils itself is not routed again either. WebKit's route stopped a plain 302 hop in a second run (scratchpad `engines/fencetrace.mts`). So only CDP `Fetch` holds every hop.
- Edge and Brave are not installed on this Mac. They have unit tests only.

## Options

Priorities, in order: (1) one driver API for every flow, so no flow is written twice; (2) safety parity: no engine runs without a guard the session needs; (3) free and self-hosted; (4) how real the engine looks to a site.

| | A: Playwright engines + capability table | B: WebDriver BiDi to stock Firefox (Puppeteer) | C: WebdriverIO or Appium second driver | D: hosted browser clouds |
|---|---|---|---|---|
| Engines | all Chromium brands, Playwright Firefox, Playwright WebKit, iPhone emulation | stock Firefox only | real Safari (`safaridriver`), iOS Safari on the Simulator | real everything |
| Flow code | unchanged | a second API; every flow and module needs a port | a second API, and WebDriver has no request interception | unchanged (CDP) |
| Realism | Playwright builds can be told apart | stock Firefox | stock Safari | real |
| Cost | $0 | $0 | $0 | paid, hosted |
| Maintenance | Playwright ships Firefox and WebKit builds with each release | Puppeteer's BiDi support | Apple's driver, Appium | vendor |

Playwright also has a BiDi Firefox (`_bidiFirefox`, channel `moz-firefox`). It is internal and not public. It does not count as B.

**Recommended: A.** It keeps one API (priority 1), and a guard table makes priority 2 checkable. B and C buy realism (priority 4) at the cost of priority 1. D fails priority 3.

## Design

### The engine table (`src/browser/engines.ts`)

One row per engine: family, label, the binaries to look for, a Playwright channel, and the device for `ios`.

| Engine | Family | Launch | Binary (fingerprint key) |
|---|---|---|---|
| chrome | chromium | channel `chrome`; no Chrome = Playwright's Chromium, logged | `Google Chrome.app` in `/Applications` or `~/Applications` |
| chromium | chromium | Playwright's Chromium | Playwright's |
| edge | chromium | channel `msedge` | `Microsoft Edge.app` |
| brave | chromium | `executablePath` | `Brave Browser.app` |
| opera-gx | chromium | `executablePath` | `Opera GX.app/Contents/MacOS/Opera` |
| firefox | firefox | Playwright's Firefox | Playwright's |
| webkit | webkit | Playwright's WebKit | Playwright's |
| ios | webkit | Playwright's WebKit + `devices["iPhone 15 Pro"]` | Playwright's |

- A brand that is not installed fails before launch: `EngineMissing`, "Opera GX is not installed on this machine". Only `chrome` falls back, and it logs "Google Chrome is not installed here; using Playwright's Chromium".
- The chromium family launches through patchright. Firefox and WebKit launch through plain Playwright: patchright patches Chromium only.
- The headless UA fix learns one fingerprint per binary, so Opera GX never wears Chrome's UA.
- Linux paths exist for chrome, edge and brave. Opera GX has a Mac path only.

### Profile folders

- `chrome` and `chromium` keep `<PROFILES_DIR>/<profile>`. Nothing moves. A container ran `BROWSER_CHANNEL=chromium` on that folder.
- Every other engine: `<PROFILES_DIR>/.engines/<engine>/<profile>`. A brand at another Chromium version would migrate a Chrome profile in place. Firefox and WebKit store a different format.
- The doctor shows the folder name as the profile, plus the engine: `x@wren (firefox)`. One profile open in Chrome and in Firefox is two folders, not "open twice".
- `auth status` reads Chrome's cookie database. It lists Chrome folders only.

### What each family can do

| Module | chromium | firefox | webkit (and ios) |
|---|---|---|---|
| Persistent profile | yes | yes | yes |
| Stealth (patchright, `LOCAL_ARGS`, `--enable-automation` off, sandbox flag) | yes | no: Playwright build | no: Playwright build |
| Headless UA fix (`fingerprint.ts`) | yes, one per binary | not needed | not needed |
| Headed window on a Mac (relay launch, focus guard, app hider) | yes | refused | refused |
| Live view | CDP screencast and page script (select menu, cursor, copy out) | `page.screencast` frames; no select menu, cursor or copy out | same as firefox; `ios` taps |
| ⌘⇧O (move to a window) | yes | off: no focus guard | off: no focus guard |
| Nav fence (fenced run) | CDP `Fetch`: every hop unsent | `FENCE_HOPS=blank` (default): route; a 302 hop's page loads, is blanked, its answer dropped. `block`: refused | `blank`: route, which also stopped the 302 hop. `block`: refused |
| WebRTC behind an exit | `--webrtc-ip-handling-policy=disable_non_proxied_udp` | pref `media.peerconnection.ice.proxy_only` | refused |
| Passkeys (virtual authenticator) | yes | refused when the account has passkeys, or when the read fails | same as firefox |
| Film | yes | refused | refused |
| `record` on a Mac (a window) | yes | refused | refused |
| Tiers `browserbase`, `cdp` | yes | refused | refused |
| authbridge save | Chrome folders only (chrome, chromium) | no | no |
| Reap, doctor, profile lock | `--user-data-dir=`; `SingletonLock` | `-profile <dir>`; the root on the folder holds it | `--user-data-dir=`; the innermost root holds it |
| Memory guard | the root's tree | the root's tree | the root's tree plus every WebKit XPC service of that build |

Rules behind the table:

- **Fail closed.** A guard the session needs and the engine lacks refuses the session before launch (`refusalOf`), with one line: the engine, the guard, what to do. Order: tier, fence (`FENCE_HOPS=block` only), film, window, WebRTC, passkeys.
- **Headed windows** for Firefox and WebKit are refused on a Mac. They have no relay and no focus guard, so they would take the front. William: "it never forces itself into focus." `--headed` goes to the live view (the default, `HEADED_VIEW=live`). `--window`, a film and `record` are refused, so `record --engine` takes Chromium engines only on a Mac. Off a Mac, a headed window is allowed: no focus rule applies there.
- **Nav fence.** Only CDP `Fetch` stops every redirect hop (measured above). Off Chromium, `FENCE_HOPS` picks (per run: `agent --fence-hops`):
  - `blank` (default): `context.route` fails each top-frame request off the sites unsent: an `open`, a link, `location=`, a meta refresh. A 302 hop it misses loads; the fence blanks the page. The command that was running drops its answer, and the journal notes the host. The outside server still gets that one request.
  - `block`: the session refuses the run. `nav-fence.ts` also throws "the nav fence needs Chromium" if a caller skips the refusal.
  - The session logs which fence holds: "nav fence: by route (no CDP); …".
  - `context.route` turns the HTTP cache off for that context; on Chromium the fence stays on CDP to keep it.
- **Passkeys.** The session reads the account's passkeys before launch. Off Chromium, a failed read refuses the session: an unknown count could hide a passkey.
- **Live view fallback.** A failed `newCDPSession` picks `page.screencast.start({ onFrame, size })`. The first frame is a JPEG screenshot, because a static page sends no frame. The page script needs a binding in an isolated world. Playwright has no public isolated world, and a binding in the main world is visible to the page. So the select menu, the cursor shape and copy to the Mac clipboard are off. The keyboard still changes a select.
- **iOS.** WebKit with the device's viewport, UA, DPR, touch and `isMobile`. The live view keeps the device's screen and ignores the viewer's size. A left click in the viewer lands as one `touchscreen.tap` on release. It is emulation, not Safari on iOS.
- **Chromium-only launch options stay Chromium-only:** `LOCAL_ARGS`, `--user-agent`, `chromiumSandbox`, `ignoreDefaultArgs`, the relay shim, the focus guard, `--force-device-scale-factor`, `HEADED_ARGS`, `X11_ARGS`. Firefox and WebKit get `timezoneId` as well as `TZ`.
- **Status line.** A session on an engine other than `chrome` logs one line at open: the engine and the rows that are off (`missingOf`).

### Process lookups (`reap.ts`, `browsers.ts`, `memory-guard.ts`)

- `profileFolderOf` reads `--user-data-dir=<dir>` or `-profile <dir>`. The folder ends at the next token that starts with `-`, or at a trailing URL. A `--type=` helper and `--profile-directory=` never match.
- `profileRoots`: of a chain of processes on one folder, only the innermost counts (WebKit's `Playwright.app`, not `pw_run.sh`, which waits on it without `exec`). Orphan checks read the parent of the chain's top (`outerPpid`).
- `holderPid`: Chromium writes a `SingletonLock` with a pid. That pid holds the profile when its command names a profile folder or contains `chrom` (Opera GX's `…/Opera` names its folder). Firefox and WebKit write no such pid: the profile root on that folder holds it. A Chromium folder with no lock is free: Chrome drops the lock before it exits, so a closing Chrome still shows in `ps` (the gate caught this as `ProfileBusy` in teach and explore). `assertProfileFree` and the doctor's stranger check use this, and the stranger check also reads `.engines/*/*`.
- His own Opera GX, Firefox or Safari never matches: they run on folders outside `PROFILES_DIR`.

### authbridge

authbridge reads Chrome's paths, its IndexedDB and its platform. It saves only on a Chrome folder (`onChromeFolder`: chrome or chromium). `authbridge` on a profile pins the engine to a Chrome folder. A Mac Chrome snapshot still restores into container Chromium: both are Chrome folders, so no engine check is added.

### Config and CLI

- `browserEngine` (`BROWSER_ENGINE`) replaces `browserChannel`. `BROWSER_CHANNEL` warns and is ignored.
- `BrowserOptions.engine`. The desk and the worker use `BROWSER_ENGINE`; `explore --engine <e>` and `record --engine <e>` set one session. The status page shows the default engine.

## Non-goals

- Real Safari and iOS Safari on the Simulator (option C). See Open decisions.
- An engine per site. One default and a per-session flag cover today's needs.
- Camoufox or another stealth Firefox. It is not a Playwright-maintained build.
- Installing Edge, Brave or any browser. Nothing is installed without William's yes.
- Stealth for Firefox or WebKit. A Playwright build cannot look stock. A site that blocks it needs Chrome or a brand.
- Moving existing Chrome profiles.

## Risks

- **Bot walls on Playwright builds.** Firefox and WebKit builds have tells that patchright cannot remove. Use them for reads and tests, not for accounts a ban would hurt. The status line names the engine; the default stays `chrome`.
- **WebKit memory pool.** The XPC services are one pool per WebKit build. Two WebKit sessions each count both pools, so the memory cap trips early, never late.
- **Brand updates.** Opera GX and Brave update themselves. A new major can break Playwright's CDP use. A launch failure names the engine.
- **Opera GX start-page race.** The fingerprint probe retries once on `ERR_ABORTED`.

## Tests

- Unit (`test/engines.test.ts`): `profileFolderOf` (trailing URL, `-profile`, helper, `--profile-directory`); the innermost WebKit root and orphans by `outerPpid`; `treeOf` with WebKit XPC services; `holderPid` for Opera GX, for a Firefox with no lock, and for a Chromium folder with no lock while its Chrome still runs; `viewOf` with one profile in Chrome and Firefox (no "open twice") and a stranger under `.engines`; `profileDirOf`, `onChromeFolder`; `launchTarget` and `EngineMissing`; every `refusalOf` row, `fenced` included. All process lines come from real runs.
- Unit (`test/live-view.test.ts`): frames and clicks with no CDP; a touch device gets one tap on release and no mouse press.
- Proof on this Mac: `explore --engine <e> --live` on opera-gx, firefox, webkit and ios. Pass: frames flow (count per 2 s); a click lands (a tap on ios); the front app is the same before and after; no process stays after close.

Proof run, 11-26 (scratchpad `engines/liveproof.mts`: `openSession` with `--live` and `--engine`, the real viewer app, a second socket that counts frames and clicks):

| Engine | Open | Frames per 2 s | Input | Front app at open and close | Left after close |
|---|---|---|---|---|---|
| opera-gx | 5.6–9.8 s | 3–58 | click lands; UA `Chrome/157 … OPR/140`, no `HeadlessChrome` | same | 0 |
| firefox | 10.0 s | 30 | click lands | same | 0 |
| webkit | 1.8–4.1 s | 1–18 | click lands | same | 0 |
| ios | 1.7–2.1 s | 33–40 | tap lands: `touchstart`, then `mousedown`, `click`; 393 px wide | same | 0 |

- The frame count follows the viewer window: the app sends `visible` from its occlusion state, and frames stop while the window is covered. With nothing covering it, Playwright's screencast gives 34–40 frames per 2 s on WebKit and 27–41 on Firefox (scratchpad `engines/wkrate.mjs`, `wknav.mjs`).
- The front app changed twice during the runs, at times that match no session event. It held through every open and close.
- Playwright's WebKit reports `navigator.maxTouchPoints` 0 with `hasTouch` on, but touch events fire.

## Open decisions (William)

- **Real Safari and iOS Safari.** A second driver (WebdriverIO with `safaridriver`, Appium XCUITest on the Simulator). Costs a second API and loses request interception. Recommendation: wait until a site works in Safari only.

## Log

- 2026-11-26: spikes run (table above). Options A to D; A chosen on priorities 1 and 2. Edge and Brave: built, not run (not installed).
- 2026-11-26: goldfish review: the site map (`BROWSER_ENGINE_SITES`) cut; chromium keeps the base folder; the innermost root and exact flag tokens; the holder rule for engines with no lock; fenced runs refused off Chromium after the redirect spike (route misses redirect hops on firefox, webkit and chromium); memory-guard row; a failed passkey read refuses; iOS tap; ⌘⇧O Chromium only; authbridge on Chrome folders only, no engine fit check; one fingerprint per binary; `BROWSER_CHANNEL` warns; Camoufox in Non-goals. Open: fenced runs on Firefox and WebKit.
- 2026-11-26: live proof on opera-gx, firefox, webkit and ios passed (Tests). Edge and Brave stay unit-tested only.
- 2026-11-26: `BrowserOptions.engine` is required; the `"chrome"` fallback is gone. 24 test files still passed the removed `channel: "chromium"`, so they ran real Chrome, and parallel launches raced its code-sign clones ("Library missing"). `pnpm typecheck` skips `test/`, so only a typecheck that includes the tests catches a stale option.
- 2026-11-26: fenced runs off Chromium decided. William: "redirect is fine, but maybe maximize optionality". `FENCE_HOPS=blank|block`, default blank; `agent --fence-hops` per run. Live proof through explore (scratchpad `engines/fenceexplore.mts`): firefox blank: direct, link, script and meta refresh stopped unsent, the 302 hop blanked, its answer dropped, no outside text in any answer; webkit blank: nothing left the sites; firefox block: refused. Test: `test/nav-fence.test.ts` (Firefox).
