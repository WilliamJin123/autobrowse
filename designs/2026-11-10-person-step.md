# A sign-in step only a person can answer (WA-1028)

## Goal

A sign-in meets a step the tool cannot answer: a phone tap's number, a puzzle, an identity check.
A window opens, William is told, he answers, the sign-in goes on. No failure, no hold.

Before: the step threw `NeedsHuman`. The desk is headless (`browserHeadless` true), so William saw no page and the caller failed.

## Target state

- One verb: `fp.person(reason, gone, ms)`. A sign-in calls it through `personStep(ctx, reason, gone)` in `auth/login.ts`.
- In a window: the window comes forward, `notify` tells William once, the flow polls `gone` every 2 s for 5 min.
- Headless: the step throws `NeedsHuman` with `person: true`. The runner runs the flow once more in a headed browser on the same profile.
- No answer in 5 min: a plain `NeedsHuman`. No hold is set: a person's step is not a refused sign-in.
- Every sign-in uses it: Google (phone tap, other challenge), Facebook, Instagram, X, TikTok, LinkedIn, and the generic captcha and `spec.person` screens.

## Options

| Option | How | Verdict |
|---|---|---|
| A. Wait in place | The headless page stays; a person answers through a remote view (CDP screencast) | No. Google binds the challenge to the page, and a headless page cannot take a passkey or a security key prompt. A remote view is a new surface to build and secure |
| B. The caller reruns | Each caller (CLI, desk, explore) catches the error and starts again with `--headed` | No. Every caller keeps its own copy of the rule; the desk has none today |
| C. The runner reruns | `flowRunner` catches `NeedsHuman.person` and runs the flow once more headed | **Chosen**. One place; every caller of `loginFor` gets it with no change |
| D. Always headed sign-ins | Every sign-in opens a window | No. Most sign-ins need no person; a window each time takes focus from William |

Priorities, in order: one seam for every caller, no second sign-in try that Google can count, no new surface.

## Edge cases

- The second run is a new page load, so the site sees one more visit. It is not a second password try when the profile kept the first step's cookies; Google shows the challenge again directly.
- No second run after a submit (`submitted`): a form sent twice is worse than a stop.
- No second run in a caller's own tab (`on`, explore): that page is already in a window or is the agent's to handle.
- No second run without a screen (the box, `tier` not local) or on a filmed run. There the step stays a `NeedsHuman`.
- The parked headless browser of the profile closes before the headed run opens: one Chrome per profile.
- The headed browser closes after the run and is not parked: the next run is headless again.
- `runner.person: false` turns the rerun off (tests, the bench).

## Callers checked

`gcloud-login`, `aws-login`, `wrangler-login`, the Cloudflare flows, `login`, the desk (`backend.ts`, `services.ts`, `services-browser.ts`) and explore all build `loginFor(settings, gmail)` → `loginProvider(SITE_LOGINS)`. None keeps its own sign-in.

## Decision log

- 2026-11-10: The runner reruns headed (C). One seam; callers do not change.
- 2026-11-10: A person's step sets no hold, at any time-out. The 12 h hold is for a refused sign-in (2eadcf2).
- 2026-11-10: Five minutes for the answer. A phone tap takes seconds; longer keeps the profile locked.
- 2026-11-10: The WA-1027 passkey stays apart: it removes Google's phone step, not the need for this path.
