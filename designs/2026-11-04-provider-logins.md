# Provider logins: a page on any of a provider's products finds the provider's sign-in and tools

2026-11-04, WA-1036. William 11-03: "youtube and other services for logins should be able to use compiled google workflows … the compiled workflows that exist per website should be automatically injected into agent context the second they hit said website."

## What broke (runs/youtube/20261104-00*, 2026-11-04)

1. `open https://www.youtube.com` in an `explore youtube` session → `youtube: login page: https://accounts.google.com/v3/signin/identifier (unknown-site)`. The runner signs in as the session's site; no login is named `youtube`; the wall's URL (Google's) is not read.
2. `flow google-login` from that session failed in 14 ms: explore refuses a flow whose site is not the session's (`needs google's profile; this session is youtube`).
3. `www.youtube.com` and `studio.youtube.com` belong to no site: no toolkit, no `wall.signIn`. Google's login lists `google.com` only, and `origins` means "where the password may be typed", so youtube.com cannot go there.

Already built, and not re-decided here: the toolkit arrives in the first object answer after a host change, once per site set (`newSiteTools`, 2026-10-29).

## Correction, same night (William)

"I didn't mean that it should auto sign in. It should expose that sign in is a compiled workflow and all the profiles that could be signed in there … it seems like it's just auto signing into the first account, which is not how it should work since we have multiple accounts."

- An agent's explore `open` never signs in (reverses WA-1022's "a login URL signs in", 10-29, for console sessions). A sign-in wall answers `signIn: "<login>"` and `accounts: [{account, user, roles, profile?}]`, URL walls included.
- The toolkit's `<site>-login` entry carries the same `accounts`.
- `plan.account` takes the listed name (`google@wren`), a role or an address. None: the profile's own account (`profile: true`); a profile with none (bare `youtube`) must name one, and the error lists them.
- The login provider maps a site with no login to the provider only with a label (`youtube@wren` → `google@wren`); bare `youtube` stays `unknown-site`, never the provider's main (William's personal) account.
- Desk legs and the headless agent keep signing in on a wall: no agent picks there, and the run's site names the account.
- Account and profile: one Chrome profile per account stays the rule. An agent may sign another account into a profile (the OAuth consent path already does); the list marks the profile's own and the skill says to start a session as the other account for more than a quick task. Rejected: refusing a cross-account sign-in (blocks the consent case).

## Second pass, 11-04 (William)

"Desk and compiled workflow is fine if the input payload determines which profiles to use." "They should be able to use other sites' compiled workflows … not a hard lock but rather just a guide." "Default values should be shown in the tool agent context … just like how code would show it."

- Every workflow takes `plan.account`. Its platform's bare legs run in that account's profile (`google@wren`: `gmail` → `gmail@wren`). One mapper (`runnerForAccount`, `src/workflows/compiled-deps.ts`) on all four run paths: desk (the run object hands its raw plan to `resolve`), CLI, proof, explore. Before: 3 of 26 workflows took an account; the rest ran on the main profile.
- Explore runs any site's workflow. A leg's wall signs in as the leg's site (labelled by `plan.account`, or the profile's own account as default), not the session's. A bare leg of another platform stops at the wall; the answer carries `wall` with `signIn` and `accounts`.
- Tools show inputs as a signature: `q, max = 20, account = "google@wren"`. Defaults: the schema's, under the saved plan's, under the profile's own account. Search reads names only.
- WA-1029: `linkedin` (William's own) and `linkedin@alt` are 0 in code, as live since 10-30; research runs as `linkedin@wren`. Founder caps unchanged (the live ramp governs).

| Where `account` is read | Verdict |
|---|---|
| A. The raw plan at each run entry, one mapper | **Chosen**. No workflow edits; compiled files on disk work as they are |
| B. An `account` field in every plan schema (compiler template, hand edits) | No: 23 edits, and compiled files on disk keep the old template until recompiled |

## Goal

- A page on any product of a provider (YouTube under Google, Azure under Microsoft) gets the provider's login and tools, with no entry per product.
- A sign-in page names its own provider: the runner signs in as the provider whose sign-in surface the URL is, whatever the session's site is.
- `origins` stays the password boundary. Nothing widens it.

## Options

### How a product's page finds its provider

| Option | Verdict |
|---|---|
| A. One `SiteLogin` per product (today's gmail/drive/docs pattern: `credential: "google"`, the provider's `signInHere`) | No as the rule: an entry per product (YouTube, Studio, Cloud console, Play, Ads, Blogger…), each with a hand-written `loggedIn`; the `google-*` workflows still do not show on the product's host. Kept where a product needs its own `loggedIn` and home |
| B. `properties` on the provider's login: registrable domains of its other products; `sitesOfHost` matches through it; the login provider signs a sign-in page in as the login whose surface it is | **Chosen**. One line per product domain; toolkit, `wall.signIn`, `flow` and the runner's wall path all read it; Microsoft and GitHub follow by one line each |
| C. A host → site alias table beside the logins | No: a second place that knows the sites (one seam, no stale paths) |

Ranked by: one source for routes, workflows, walls and the toolkit; no password-boundary change; least per-product work.

### Which browser profile a product session runs in

| Option | Verdict |
|---|---|
| P1. Its own profile (`youtube`), signed in with the provider's credential (how gmail, drive, docs run today) | **Chosen**. Sessions on two products run at once; the desk's holds stay per product. Cost: Google sees one device per product profile (one sign-in each, its 2FA answered by our codes) |
| P2. A product session opens in the provider's profile (`explore youtube` → profile `google`) | No: one profile is one session; a YouTube read would wait on a Gmail read, and on the desk's hold of `google` |
| P3. Seed the product profile from the provider's cookies | No: Google binds a session to the device; a copied cookie jar is a flagged sign-in |

## Target state

- `SiteLogin.properties?: readonly string[]`: google `["youtube.com", "blogger.com", "withgoogle.com", "google.dev"]`; outlook `["office.com", "azure.com", "microsoft365.com"]`; github none (its wall is on github.com). Add a domain when a run meets it.
- `sitesOfHost`: a host under a login's `properties` is a near match (after the exact home host).
- `loginProvider`: a labelled site with no login (`youtube@wren`) on a page a login's `signInHere.at` matches signs in as that login, the label carried (`google@wren`). Bare `youtube` stays unknown. A known site keeps its own path.
- explore `flow`: a workflow of a site the page's host belongs to (`sitesOfHost`) runs here; the old rule (only the session's site) stays for every other site.
- `wallAnswer` and the toolkit come free from `sitesOfHost`.
- Skill: explore.md says `wall.signIn` may name the provider's login, not the session's site.

## Then

- Live proof: a fresh product profile on YouTube Studio; `open` answers the wall with google-login and its accounts and signs in nothing; `flow google-login {account}` then signs in.
- A product that needs its own `loggedIn` (Gmail's inbox URL) keeps option A's entry; the two coexist.

## Decision log

- 2026-11-04: `properties` on the provider (option B); `origins` untouched (the password boundary).
- 2026-11-04: The login provider, not the runner, reads a sign-in page's URL: it owns the logins; the runner keeps passing the session's site.
- 2026-11-04: Product sessions keep their own profile (P1): concurrency over one fewer device sign-in.
- 2026-11-04 (William): an agent's `open` never signs in; walls and login tools list the accounts; the agent picks. Desk legs keep signing in. A bare product site never maps to the provider's main account.
- 2026-11-04 (William): every workflow takes `plan.account` (option A: raw plan, one mapper); explore's site lock becomes a guide, with a stop at walls for a bare leg of another platform; tools show defaults as code does; personal LinkedIn 0 in code.
