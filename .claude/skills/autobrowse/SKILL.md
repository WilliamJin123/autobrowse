---
name: autobrowse
description: Web research (read a page, search, Google's own results page, Perplexity), lead lists (Google Maps, LinkedIn people and companies), site API calls (post, read, OAuth setup), accounts, credentials and keys, and driving a signed-in browser or this Mac's desktop (map a page, sign up, do a chore, fix a flow). Use for any web, browser or OS task in this repo instead of Playwright or manual steps.
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/state.sh)
---

# autobrowse

Sites signed in through stored logins, official APIs behind one facade, and a
browser whose every act is journaled so it can compile into a workflow.
CLI: `autobrowse <cmd>` from any folder (`bin/autobrowse` linked on PATH; it runs the repo HEAD). Without the link: `pnpm -s autobrowse <cmd>` in the repo.

Right now:
!`${CLAUDE_SKILL_DIR}/scripts/state.sh`

## Pick the job, read its file first

| Job | Read |
|---|---|
| Read a page, search the web, Google's own page, ask Perplexity | [research.md](research.md) |
| Lead lists: Google Maps, LinkedIn people and companies | [leads.md](leads.md) |
| Post, read or set up a site's API (YouTube, LinkedIn, X, Gmail, …) | [site-apis.md](site-apis.md) |
| Drive a browser or the desktop: map a page, do a chore, fix a flow (yourself; the `browser` subagent only for a side chore) | [explore.md](explore.md) |
| Make an account, sign in, type a secret without seeing it | [signup.md](signup.md), then explore.md |
| The terminal panel over a headed page, toggles, recording a run as video | [overlay.md](overlay.md) |
| Credentials, which account does what, keys and env, what William owes | [accounts.md](accounts.md) |

The files sit in `${CLAUDE_SKILL_DIR}/`. Read only the one the job needs; read it
again after a context summary. Every command: `README.md` (Run, Site APIs).
Changing autobrowse's code: `map/CLAUDE.md`.

A long worker call you need later, not now: start it as a job, do other work, collect.
- Services: `sites` (site APIs, the box), `desk` (the same on this Mac's home IP), `do` (one verb, handler `run`), `browser` (compiled flows by name). Handlers of `sites`/`desk`: `call` (`{site, method, path, input}`), `status`, `watch`, `caps`, `keys`; all in `src/sites/service.ts`.
- `autobrowse job start desk call '{"site":"…","method":"GET","path":"/…","input":{}}' --by <your id> --why "…"` prints `{id}` at once. `--delay <s>` starts it later; `--key` makes a new job of the same call.
- `job wait <id...> --timeout <s>` prints each result as it lands, `{done:false}` at the timeout (the job runs on); exit 1 if one failed. `job peek <id>` never waits. `job list` shows the ledger (`~/.config/autobrowse/jobs.jsonl`).
- The same call twice is one job. A write through a job is still a write: the same yes rules apply.

## Always

- Secrets never pass through you. Never type a password, TOTP or code:
  `place` types it. A key a site shows goes to the store by `keep`. Never
  echo a secret, put one in a URL or a message, or screenshot a revealed key.
- William's details are stored: profile `william` (`autobrowse profile list`)
  holds his name, birthday, gender, email, phone, address and tax id. A form asks
  for one: `place{secret:"profile.phone"}` (`.phoneLocal`, `.name`, `.birthday`,
  `.address1`, signup.md). Never ask William for them. A `--signup` or `--login`
  session types its account's own `phone` instead.
- A site's fixed facts (a member number, a delivery postal code, a home
  store) are details on its credential: `autobrowse creds detail <site>` lists
  them, `place{secret:"<site>.<name>"}` types one on that site's pages.
- Sign in to a site: `{"cmd":"flow","name":"<site>-login"}` in explore (explore.md). `--login`
  is only for another site's login typed into a popup on this page.
- Money is William's call. A billing field, a button that spends, or an API
  route that `spends` waits for his yes at the payment gate. A no
  (`{"gate":"payment"}`, exit 1) ends the task: say what was refused. Never
  work around it.
- Posting, sending, following, connecting and messaging are public and
  final. Never without William's yes for that act.
- William's personal accounts: only when he asks. Wren's work runs on
  Wren's accounts, picked by the accounts policy.
- Never change or rotate a stored password. Never wipe a browser profile.
  Explore LinkedIn only as `linkedin@wren`: reads, under 20 page loads,
  stop on a 429. Never William's own LinkedIn in an explore session.
- Stop every explore session you start, as soon as it is done
  (`autobrowse stop <port> achieved|failed "why"`). `autobrowse browsers`
  lists our browsers and sessions (owner, memory, idle, held); `doctor` warns.
- One sign-in try per site, then report. Repeated tries get accounts
  flagged (Google, X, Reddit).
- Verification texts (SMS codes, a Duo passcode) are free to send again.
  Ask William for none. LEARN's Duo is always a texted passcode. A sign-in
  your test makes fail on purpose (a wrong code) is fine.
- A wall you cannot pass (a code only William has, an unsolved captcha):
  say what the step is and wait.
