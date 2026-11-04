# Provider logins: a page on any of a provider's products finds the provider's sign-in and tools

2026-11-04, WA-1036. William 11-03: "youtube and other services for logins should be able to use compiled google workflows … the compiled workflows that exist per website should be automatically injected into agent context the second they hit said website."

## What broke (runs/youtube/20261104-00*, 2026-11-04)

1. `open https://www.youtube.com` in an `explore youtube` session → `youtube: login page: https://accounts.google.com/v3/signin/identifier (unknown-site)`. The runner signs in as the session's site; no login is named `youtube`; the wall's URL (Google's) is not read.
2. `flow google-login` from that session failed in 14 ms: explore refuses a flow whose site is not the session's (`needs google's profile; this session is youtube`).
3. `www.youtube.com` and `studio.youtube.com` belong to no site: no toolkit, no `wall.signIn`. Google's login lists `google.com` only, and `origins` means "where the password may be typed", so youtube.com cannot go there.

Already built, and not re-decided here: the toolkit arrives in the first object answer after a host change, once per site set (`newSiteTools`, 2026-10-29).

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
- `loginProvider`: a site with no login (`youtube`, `youtube@wren`) on a page a login's `signInHere.at` matches signs in as that login, the `@label` carried (`youtube@wren` → `google@wren`). A known site keeps its own path.
- explore `flow`: a workflow of a site the page's host belongs to (`sitesOfHost`) runs here; the old rule (only the session's site) stays for every other site.
- `wallAnswer` and the toolkit come free from `sitesOfHost`.
- Skill: explore.md says `wall.signIn` may name the provider's login, not the session's site.

## Then

- Live proof (AC 4): a browser subagent on YouTube Studio in a product profile, signed in by `google-login`.
- A product that needs its own `loggedIn` (Gmail's inbox URL) keeps option A's entry; the two coexist.

## Decision log

- 2026-11-04: `properties` on the provider (option B); `origins` untouched (the password boundary).
- 2026-11-04: The login provider, not the runner, reads a sign-in page's URL: it owns the logins; the runner keeps passing the session's site.
- 2026-11-04: Product sessions keep their own profile (P1): concurrency over one fewer device sign-in.
