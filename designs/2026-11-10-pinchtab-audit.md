# PinchTab audit: what to take, what to leave (2026-11-10)

William, 11-10: "pinchtab autobrowse audit of the repo. Kind of similar, almost the other half of opencli?"
Source: github.com/pinchtab/pinchtab a626620 (MIT, Go, 121k lines), read 11-10. `P/` is its repo.

## The answer

Not the other half of OpenCLI. OpenCLI is a catalog of site reads. PinchTab is a generic browser
server for anonymous agents: a Chrome per instance behind HTTP, an accessibility-tree page view,
and a security posture for an operator who exposes it. It has no sign-in, no caps, no pace, no
gates. autobrowse already does its job for one signed-in account per profile.

So it is a third source, smaller than OpenCLI. Take its page-view craft, its launch hygiene and
its navigation guards. Leave its server, scheduler and stealth.

| Facet | PinchTab | autobrowse | Better |
|---|---|---|---|
| Page view | AX tree, `eN` refs bound to a node per document, `maxTokens` cut by tier | `aria`, `snapshot` rows, `marks`, hints; caps in chars and rows | PinchTab for the view; ours for flows (hints compile, refs do not) |
| Diff after an act | Opt-in; added, changed (value, checked), removed | Automatic; added and gone rows only | Ours, with their changed fields |
| Text | Readability, raw, markdown | Layout text (tables, columns) | Both; add their article mode |
| Process | Server + bridge child per instance, HTTP hops | One process, browser per profile, OS lock, park | Ours for one Mac |
| Launch hygiene | Health poll at launch, crash ring, unclean-exit cleanup, tab budget | 3 s probe on park take, stray-tab sweep | PinchTab |
| Scheduler | In-memory queue, per-agent fairness, no pace | Restate, caps, pace, write expiry | Ours |
| Injection | Domain allowlist (off by default), regex scan, advisory wrap | Secrets never shown, gates | Ours structurally; take their allowlist |
| Network guard | Scheme + private-IP check after DNS | None | PinchTab |
| Stealth | JS patches, or CloakBrowser | Patchright, real fingerprint | Ours |
| Captcha | Cloudflare click, paid solver stubs | Vision vote, human hands | Ours |
| Agent surface | CLI over HTTP, MCP (45 tools), `errors` channel, remedy line | JSON socket, error contract, `changed` | Ours, plus their `errors` channel |
| Health / QA | `audit` (vitals, broken assets, a11y), `compare --fail-on-diff` | Proof shots, none of these | PinchTab |
| Tests | Census tests, skill token budget, e2e tiers with a path map | Vitest, `LIVE=1` | PinchTab on the meta-tests |

Their benchmark is honest on cost (real `usage`, 10–20 % lower than agent-browser) but the saving is
fewer turns, not a smaller page. The "800 tokens a page" line is not measured anywhere in the repo.

## Take

| # | What | Where | Size |
|---|---|---|---|
| P1 | Navigation guard: http/https only; private, loopback, link-local, CGNAT refused after DNS (`P/internal/netguard/netguard.go:70-100`) | `fp.open`, explore `open` | S |
| P2 | Page text to the agent: strip bidi, zero-width and control characters (`P/internal/sanitize/text.go`) | `src/agent/digest.ts`, explore reads | S |
| P3 | `errors` channel: uncaught page errors (`pageerror`) kept per session | explore `{"cmd":"errors"}`, skill line | S |
| P4 | Sparse stable refs on `snapshot`: `eN` per node, new numbers on a new document; `hints:{ref}` resolves to hints, the journal keeps hints | `src/browser/repair.ts`, `src/explore/server.ts` | M |
| P5 | Snapshot budget by tier: controls, then headings, then prose, in page order; skip an oversized row | `snapshotPage`, `compact.ts` | S |
| P6 | Diff fields: value, checked, disabled changes in `pageChange` | `server.ts` | S |
| P7 | `text` article mode (Readability-style main text) beside layout text | `src/browser/layout.ts` | S |
| P8 | Readiness probe at launch: fail fast as not sent | `openSession` | S |
| P9 | Unclean-exit marker: clear Chrome's session-restore files only, never cookies | `session.ts` | S |
| P10 | Crash ring: last 20 browser deaths with profile, opener, reason, in `browsers` and `doctor` | `browsers.ts` | S |
| P11 | Tab budget at open: close page targets the session does not own, past a cap (own and cdp tiers) | `session.ts` | S |
| P12 | Skill size budget test over `.claude/skills/autobrowse/*.md` | `test/` | S |
| P13 | `proof` at widths with overflow, page errors, broken assets; compare rules (identity diff, masked host, drop statusless failures) | explore + `shots/` | M |

## Leave

| What | Why |
|---|---|
| Server + bridge per instance, HTTP proxy hops | ~300 MB a child and an auth hop for one Mac, one trust domain |
| Their scheduler | In memory, lost on restart; no pace or caps; Restate does it durably |
| Quarantine a corrupt profile and relaunch fresh | Signs a Wren account out unattended; a person looks instead |
| Stealth JS bundle, CloakBrowser | A page can see a JS patch; Patchright already patches the driver |
| Paid captcha solvers | Sends Wren's sign-in pages to a third party |
| Hash-embedding `find`, schema `extract` | The agent already picks from rows; `read`/`records` replay, `extract` does not |
| MCP server, dashboard auth, tab-lock TTL | CLI + skills policy; no multi-user exposure; a TTL can expire under a live writer |
| Regex injection scan as a block | Detection only; a paraphrase passes. The allowlist and our gates are the real controls |

## Decision log

- 2026-11-10: PinchTab is a third source, not OpenCLI's other half (my read, from the code).
- 2026-11-10: Refs resolve to hints before the journal: compiled flows stay hint-based (my call).
- 2026-11-10: No per-run domain allowlist yet: explore crosses sites by design (sign-in providers, OAuth). The scheme and private-IP guard ships first (my call).
- 2026-11-10: William: "Pinchtab we should discuss first get the opencli stuff done prior". Nothing here is built until that talk.
- 2026-11-11: P3 reads errors through the recorder's observer (a main-world `error` and `unhandledrejection` listener over the binding), not Playwright's `pageerror`: Patchright keeps CDP Runtime off, so `pageerror`, `console` and `Log.entryAdded` never fire. Turning Runtime on is a known bot signal. Built: `src/browser/page-errors.ts`, `pageErrors` on act answers, `{"cmd":"errors"}`.
