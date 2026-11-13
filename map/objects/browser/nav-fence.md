---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-11-12 @ be8c91f
entity: src/browser/nav-fence.ts
---

# Navigation fence

The hosts a session's top frame may load; any other top-frame document request fails before it is sent: `src/browser/nav-fence.ts` (WA-1351).

## Why this shape

Page text can tell an agent to go elsewhere (agent-browser audit row 12). The fence keeps the desk's agent on its sites whatever the page says. It intercepts with its own CDP `Fetch`, Document requests only, on one browser-level session: a popup's first request (a `target=_blank` form post) pauses before Playwright hands over the page. Playwright's `route` would turn the HTTP cache off for the whole context (`Network.setCacheDisabled`), and sites see that.

## Shape

- `fenceNavigations(context, allow, onRefused?)`: every page, now and later. Stops `open`, links, form posts, script redirects and each redirect hop in the top frame. Iframes (captchas, embedded sign-in) and subresources pass.
- Scope: a page target's id is its main frame's id. A paused frame that is a page target of this context is a top frame; another context's pages and iframes pass (`fenceBrowser`).
- Fallback (`fencePage`): a browser with no browser-level session fences per page; there a popup's first request leaves. Both paths blank a page that lands off the sites.
- `urlAllowed(url, allow)`: about:, data: and error pages pass; http(s) by host. `outsideSession(url)`: the `NetRefused` an `open` gets.
- `sessionHosts(site, url, domains)` (`src/auth/signup.ts`): a host named for the site (`hostNamed`), the start URL's registrable domain, `SIGNUP_ALSO_HOSTS`, `SIGN_IN_HOSTS` (accounts.google.com, appleid.apple.com, login.microsoftonline.com, login.live.com), and `domains`.
- `ExploreOptions.allowHosts`: the explore server fences at start and refuses an `open` early.

## Connected to

- **owned-by:** [[explore-session]]
- **joins:** agent sessions (`src/agent/sessions.ts`: `StartRequest.allowDomains`; `agentFor` in `src/app/backend.ts` always fences), `POST /api/agent` `allowDomains`, `autobrowse agent --allow-domains` (opt-in)
- **looks-like-but-is-not:** the net guard (`src/reach/net-guard.ts`: private addresses and `NET_ALLOW_DOMAINS` for every fetch and `open`, process-wide); `secretHosts` (where a placed secret may land)

## If you change this

- **Hits:** every desk agent session (`do`, heal, the UI's agent), `test/nav-fence.test.ts`.
- **Does not hit:** compiled flows, CLI `explore`, site APIs.

## See

- Source: `src/browser/nav-fence.ts`; test `test/nav-fence.test.ts`
- Design: `designs/2026-11-12-agent-browser-audit.md` (row 12)
