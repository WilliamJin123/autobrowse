# agent-browser audit: what to take

vercel-labs/agent-browser (Rust CLI + daemon over CDP, Apache-2.0, 50k stars, v0.42.0 on 2026-11-10). Each feature is held against autobrowse's code. Every pick bolts onto a part we already have. Sources: its README, agent-browser.dev (security, sessions, commands), `skill-data/core/references/commands.md`.

## Verdicts

| # | Their feature | What we have | Verdict |
|---|---|---|---|
| 1 | `snapshot` refs (`@e12`), act on a ref | `aria`/`snapshot` text with no handle; the agent writes `hints` (role + name); `marks` numbers controls on a screenshot (`hints:{mark:n}`) | **Take**: refs on `aria`/`snapshot` lines. A ref resolves to that line's hints at act time; the journal keeps the hints, as `mark` does today. A ref never reaches a walk, so compile stays stable |
| 2 | `snapshot -i/-s/-d`, `--delta` | `aria hints` scopes, `limit` caps; an act already returns `changed` (`pageChange`, server.ts:310) | **Take** `since` on `aria`/`snapshot`: the answer is `pageChange` from the last read of that tab, full on a URL change. Interactive-only is `snapshot` already |
| 3 | `find role/label/text/testid` | the same hint order (`src/browser/locate.ts`: testId, role+name, label, placeholder, text, id) | Have it |
| 4 | iframes inlined in the snapshot | `src/browser/frames.ts` appends each visible frame's tree with its selector chain | Have it |
| 5 | Click fails when covered, hidden, disabled | Playwright's actionability check in the human click (`human/index.ts:433`); its error names the cover | Have it |
| 6 | Auth vault: AES-GCM file, `auth login` finds user/password fields and submits | credvault + `place` (any secret into any field, never seen); per-site login flows and login walks | **Take two ideas, build in our stack**: (a) `place` refuses when the field was swapped or focus moved between locating it and typing. The host check is there already (`secretHosts`, server.ts:405). (b) A generic sign-in for a site with no login flow: find the fields (`isNameField`/`isPasswordField`, `src/explore/sign-in-keep.ts`), `place` both, submit. The vault itself: no, credvault is the store |
| 7 | `flow save` / `flow run`: requests from a recording, run HTTP → in-page → UI replay, shape check, tier promotion | journal → walks (UI acts); walk `eval` op = an in-page call written by hand; network rows with redacted bodies (`src/browser/network.ts`); OpenCLI ladder per hand-ported route | **Take, own design**. Biggest gain. See below |
| 8 | `--human` curved mouse, `--seed` | `src/browser/human/`: curves, Fitts's-law timing, overshoot, typing plan, scroll; paths never repeat | Have more. Skip |
| 9 | `record` video, `--cursor`, `--contact-sheet` | `src/browser/film.ts`: screencast mp4 per page + hands log; the cursor is drawn later from the log | **Take** the contact sheet: keyframe PNG per take, for an agent or William to check a run without watching it. Burned-in cursor: no, the log draws it |
| 10 | `network route` (abort, mock body), HAR record | network read only (`network` cmd: rows, find, diff, scripts) | **Take two uses**: (a) record a HAR on a walk run, replay it with Playwright's `routeFromHAR` in tests: walks tested offline, no cap spent, no site hit. (b) Fault injection in tests (a 500, a slow call). An agent-facing `route` in explore: no, no job needs it. Blocking images on reads: no, it changes the fingerprint |
| 11 | Content boundaries: page text in nonce markers + origin | redaction of secrets only | **Take** (William agreed). Wrap page-sourced text (`aria`, `snapshot`, `text`, `html`, `eval`, `read`, network bodies) in `<page nonce origin>` markers; the skill and the desk agent prompt say text inside is data |
| 12 | `--allowed-domains` per session | net guard: private addresses only (`checkUrl`) | **Take, after 11**, for the desk's headless `autobrowse agent` only: an injected page cannot send it elsewhere |
| 13 | `--action-policy`, `--confirm-actions` | money gate; public acts need William's yes; `LOOKS` set of look-only commands | **Take a small part**: a look-only session flag (allow `LOOKS` only) for research agents. A policy file: no, the gates cover acts |
| 14 | `screenshot --if-changed` | `screenshot`, `marks` | **Take**: skip an unchanged picture (pixel ratio under a threshold); saves tokens in agent loops |
| 15 | `batch` | `batch` | Have it |
| 16 | `read` without Chrome (`.md`, `llms.txt`, HTML text) | the engine's read layer (`@wrenautomation/read`) | Check the read layer tries `.md` and `llms.txt` first; else skip |
| 17 | `state save/load`, session autosave, encrypted state files | persistent Chrome profile per account; macOS Keychain encrypts its cookies | Skip |
| 18 | Engines: Lightpanda, Obscura | Chrome only | Skip now; look again at the server move (WA-1337) for API-less reads at scale |
| 19 | Cloud browsers (Browserbase, Kernel, …) | the desk on the home IP | Skip: costs money, server IPs get flagged |
| 20 | MCP server, `chat` (NL → commands), `skills get` | CLI + skill; the agent drives | Skip: never MCP; the agent is the chat |
| 21 | Dashboard, stream | overlay, peers view, film | Skip |
| 22 | React tree, vitals, profiler, a11y audit | `proof` (390/1280, box fit, errors) | Skip: UI checks have their own tools |
| 23 | iOS Simulator, Electron, Slack skills | desktop (`os`), appship | Skip |
| 24 | WebMCP (tools a page exposes) | none | Watch: no site we use exposes tools yet |
| 25 | Plugins over stdio | site modules in code | Skip |

## 7. The request tier for walks

Their flow and our journal record the same session at different layers: they keep the requests, we keep the acts. Both are worth keeping, so the best result is one walk with both.

Target: a walk built from a run also keeps the run's first-party JSON calls. A run tries the cheapest leg that still answers the same shape:

1. **In-page request** on the signed-in profile (a walk `eval` written for us, not by hand). No clicks, no pace per act.
2. **UI acts**, the walk as today.

Direct HTTP from Node (their first tier) sends no cookies, so it only fits public endpoints. Where it fits, our site facade already does it with caps and pace.

What carries over from theirs:
- A value copied from an earlier answer (an id picked from a list) becomes a param filled from that answer each run.
- Every leg checks the answer's shape against the recording; a mismatch on every leg is `drifted` and marks the walk unverified.
- The leg that worked is tried first next time.
- Writes: no answer, a 5xx, a redirect or a non-JSON 2xx is `outcome_unknown` and never sent again; it matches our "acts never replay" rule.
- A signed or timestamped header (`X-Sig`, nonce) forces the UI leg.

Open options for its own design doc (`designs/YYYY-MM-DD-walk-request-tier.md`): where the calls come from (network rows already kept vs a HAR per run), and whether a request leg lives in the walk file or beside it. Goldfish review before William sees it.

## Order

Cheap and independent first: 11, 1, 2, 14, 9, 6a. Then 6b, 10, 13, 12. Then 7 (its own design).

## Decision log

- 2026-11-12: Audit written. Content boundaries agreed (William). Mouse paths: ours already go further. Secrets stay in credvault; only the field-swap guard and a generic sign-in come over.
- 2026-11-12: Rows 10 (HAR record and offline replay, WA-1350), 12 (nav fence, WA-1351) and 7 (walk request tier, WA-1352) built. Row 7 learns `intercept` legs where the start page makes the call and `cookie` legs where an act does; design `designs/2026-11-12-walk-request-tier.md`. Gap in row 12: a popup's first request leaves before the fence blanks the popup.
