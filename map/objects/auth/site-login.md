---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-11-04 @ fe9562a+
entity: src/auth/login.ts
---

# Site login

How one site is signed into and where its password may be typed: `SiteLogin` in `src/auth/login.ts`; the list is `SITE_LOGINS` in `src/auth/sites.ts:861`, which gains the owner's and installed mods' logins as data at start ([[mod]]).

## Why this shape

The runner meets a wall and calls one hook (`RunnerOptions.login`); the spec says which credential, which origins, whether a provider button will do, and how second steps, passkeys, rotation and recovery codes walk on that site. A form is `formLogin`, itself a walk built from the spec; a branching sign-in is a hand-written walk (Google, Cloudflare, Microsoft).

## Shape

- `SiteLogin { site, home, credential?, ask?, via?, loggedIn, signIn, signInHere?, reauth? (password asked again in place, filled before any navigation), totpSetup?, passwordChange?, passkeySetup?, recoveryCodes?, origins?, properties? }` — `src/auth/login.ts:55-110`. `origins`: where the password may be typed. `properties`: the provider's other products (youtube.com → google): their pages take this login's tools, `wall.signIn` and sign-in, never the password (WA-1036, `designs/2026-11-04-provider-logins.md`)
- Builders: `formLogin` `:194`, `oauthLogin` `:275` (`before` clicks open the sign-in; a site made through a provider signs in as its own account there, never the provider's default credential), `viaLogin` `:322`; `LoginFailed` (this method failed, try the next) `:175`
- `pageLogin(site, cred)` — `src/auth/page-login.ts`: a site with a stored password and no spec. Finds the boxes the page shows (`signInFields`: autocomplete, then `isNameField`/`isPasswordField`), types the name and password, submits; a name box alone only on a sign-in address (two-page forms); two password boxes or `new-password` = a sign-up, refused; a TOTP box when the credential has a seed, else a person. One try (WA-1349). Explore's `page-login` workflow (`src/workflows/logins.ts`) runs it; a wall with no `<site>-login` offers it when the session's site has a stored account
- `loginProvider(sites, opts)` = the runner's hook: resolves the site (a labelled site with no login on a provider's `signInHere.at` surface becomes the provider, label carried: `youtube@wren` → `google@wren`; bare stays unknown; `account` may be a stored name or role), picks methods, signs in, returns `signed-in | no-credential | unknown-site`; no spec but a password credential → `pageLogin` — `:880-960`
- Wired: `loginFor` — `src/app/services-signin.ts:257`
- As data: `logins/<site>.json` (owner's own, or a [[mod]]'s) built through `formLogin`/`oauthLogin` by `loginOf` — `src/mods/login.ts:86`; added after every built-in by `addSiteLogins`, a taken name skipped — `src/auth/sites.ts:896`

## Connected to

- **owns:** its walk or form
- **owned-by:** `SITE_LOGINS` (built-ins, then data logins)
- **joins:** [[credential]], [[identity-provider]] (`via`), [[sign-in-context]], [[screen]] (walks), [[guard]] (`passwordDomains`, `src/auth/login.ts:423`), [[need]]
- **looks-like-but-is-not:** [[site-api]] (the official API), `SITES` in `src/browser/flow.ts:63`

## If you change this

- **Hits:** `src/auth/sites.ts`, `src/app/services-state.ts:269`, `src/auth/accounts.ts` (`check`), `src/app/needs.ts:96`, `src/auth/enroll.ts`, `src/auth/rotate.ts`, `src/auth/recovery.ts`, `src/auth/passkey.ts`, `src/auth/exists.ts`.
- **Does not hit:** site API routes; compiled workflows (they meet the wall through the same runner hook, unchanged).

## Surfaces

| Surface | Role |
|---|---|
| runner wall hook | calls `signIn` |
| `autobrowse login`, `accounts check`, `enroll-*`, `creds rotate` | call the specs |

## See

- Source: `src/auth/login.ts`, `src/auth/sites.ts`
