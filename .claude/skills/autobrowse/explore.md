# Explore: drive a browser or the desktop

One browser stays open on a site. `open` never signs in. A sign-in wall comes back as
`wall` with `signIn: "<site>-login"` (the provider's on its products: `google-login` on
youtube.com) and `accounts`: every stored account that login can use. Pick one, then run
`{"cmd":"flow","name":"<site>-login","plan":{"account":"<account>"}}`.
You send one JSON command at a time over loopback. Every act that works is
journaled; `save` writes a recording; `compile` makes it a workflow.

From a chat session, drive it yourself: that is the default. What the page
shows is then in your context, and one session holds one browser.
Spawn the `browser` subagent (`~/.claude/agents/browser.md`, headed) only for a
side chore: a task apart from your main one, whose result is a line or two
(a setting changed, a file uploaded, an account made). A read or an act your
main task needs, you do yourself. Never two browser subagents at once.
Never `autobrowse agent` from a chat: that is the headless loop for the
desk and the bench.

Each browser holds 1 to 2 GB. When memory is tight (the OS reports pressure,
or our browsers would pass half the RAM), `start.sh` prints a warning with the
free share and each open browser's MB, then opens: no flag needed. Stop a
session of yours that is done; never one that is not yours. Only the OS's
critical level stops a start; there `--force` is a person's call.

## First: does something already do it?

```sh
autobrowse do "<goal>" --dry-run       # routes to a flow, a site route or a workflow
autobrowse tools [site] [--find words] # the toolkit by site; --find is a fuzzy search
autobrowse sites --find <words>        # supported sites: sign-in, API routes, workflows
autobrowse workflows [name]            # what exists; a name prints its inputs (--template for a plan file)
autobrowse site status <site>          # the site's API and browser routes
```

## Session

`scripts/` sits beside this file (the skill's folder). Run them from anywhere.

```bash
scripts/start.sh <site> [url] [port] [flags]   # default port 9090; prints "port N" when ready
scripts/cmd.sh <port> '<json>'                 # one command, JSON back
autobrowse stop [port] achieved|failed "…"     # verdict, then close browser + socket; no port = your one open session
                                               # a session that does not answer: its process is ended, and stop says so
scripts/state.sh                               # open sessions (held ones marked), resumable journals, profiles
autobrowse browsers [--json]           # every browser of ours: owner, age, MB; sessions: driver MB, idle, held
autobrowse browsers stop <port>        # close a session, journal kept (--forget drops it)
```

A session is a lease: it closes itself after 10 minutes with no command,
journal kept. A scheduled write on the desk (a post) that needs the same
profile takes it sooner: after 3 minutes with no command it closes the
session (journal kept) and runs; while you drive it, the write waits.
`--hold` (`start.sh <site> "" <port> --hold`) turns both off: only for
multi-loop work or a long wait on a person, and scheduled posts on that
profile wait meanwhile. You stop a held session yourself (`autobrowse stop`);
`doctor` flags one held over 12 hours.

Stop a session the moment its goal is done or failed: `autobrowse stop`. Never
kill a process, never leave it to the lease. A backstop closes what you forget
(journal kept): a subagent that ends closes the sessions it started, and a
session whose Claude session exited closes after 3 minutes. Both spare a
paused session and a held one. So before you end your turn at a step a
person must do: `{"cmd":"pause"}`, then report the port. Paused, it waits 40
minutes.

`<site>` is a profile name (`google`, `cloudflare`, `aws`, `scratch` = no login;
`<site>@<label>` for a second account). One session per site; `start.sh` on an
open port just reports it. A session that died left its journal:
`start.sh <site> "" <same port>` resumes on its last page, so `save` still has
every act. `autobrowse stop` ends it for good. Flags for secrets: signup.md.

## Commands

Targets are `hints`: `{role, name, text, placeholder, id, testId, href, inputType, css, nth}`.
Any subset; `name` is the accessible name from `aria`. Or `{"mark":n}`: a number from the last `marks` picture.

Look:
- `{"cmd":"snapshot"}` — interactive elements, one line each. Start here.
- `{"cmd":"overlay",…}` — the panel a person watching reads: [overlay.md](overlay.md). Optional; acts never depend on it.
- `{"cmd":"aria"}` — accessibility tree, masked. `hints` scopes it, `limit` is the answer's size (default 12000; past it, compacted). `extras:true` also lists what the tree misses (controls in closed shadow roots, cards clickable only by script), each with hints to act on. A link's target is its `/url:` line.
- `{"cmd":"text"}` — the page's words as laid out: side-by-side reads as a row (`Price | $40`), tables across, a sidebar as `[col 1/2]`. Costs what plain text does. `"coords":true` adds `@x,y` per line (+25%); `"layout":false` = DOM order.
- `{"cmd":"url"}`, `{"cmd":"screenshot"}` (path back), `{"cmd":"count","hints":…}`. Every page picture covers card fields and the payment vendors' card frames (`browser/card-mask.ts`); `os shot` is refused while a card field on the page holds a value.
- `{"cmd":"marks"}` — a screenshot with a numbered box on each control in view, and the list `{n, tag, role, name}`. For a control the snapshot and `aria` do not name (an icon, a canvas widget). Act with `"hints":{"mark":n}`: the journal keeps the control's own hints, never the point. A load or re-render makes the marks stale: take them again.
- `network` is on in explore (`AUTOBROWSE_NETWORK=0` turns it off). Before you scrape a list from the DOM, look for the JSON behind it:
  - `{"cmd":"network"}`: JSON calls grouped by URL and GraphQL query name, with ids, count, status and data keys. `all` adds pages and non-JSON.
  - `{"cmd":"network","find":"<text on the page>"}`: the calls whose body holds that text, with the key path to it.
  - `{"cmd":"network","id":12,"pick":"data.user.edges[0].node"}`: one part of one body.
  - A flow reads that JSON with `pageJson`/`pagedJson` (cookie rung) or `captureJson` (intercept rung), in `ladder` rungs (`src/browser/ladder.ts`).
- `{"cmd":"pages"}` / `{"cmd":"page","index":1}` or `"main"` — OAuth popups; the session returns to main when the popup closes. A tab your command opened closes when you send `open` or `page main` (`closedTabs`): read it before you move on.

Act (journaled):
- `{"cmd":"open","url":"https://…"}` — answers `wall` (`kind`, `by`: `url` or `text`) when one is there.
- `{"cmd":"click","hints":{"role":"button","name":"Create"},"goal":"…"}`
- `{"cmd":"fill","hints":{…},"value":"…"}`, `select`, `press` (`"key":"Enter"`), `hover` (a menu or a control that shows on hover, a tooltip to read), `upload` (`"files":["path"]` or a stored file, below).
- `{"cmd":"type","text":"…"}`, `{"cmd":"key","key":"Escape"}` — into whatever is focused.
- `{"cmd":"place","hints":{…},"secret":"code"}` — types a secret the session holds (signup.md); the value never reaches you. `"secret":"profile.taxId"` fills a field of the Mac's wallet profile (signup.md).
- `{"cmd":"read","hints":{…},"as":"fieldName"}` — text off the page into the flow's output.
- `{"cmd":"records","as":"ads","goal":"…","fields":[{"key":"name","says":"…"},{"key":"site","says":"…","optional":true}],"code":"return [...]"}` — a list page as rows. `code` is a function body over `root` (the document), run in a sandbox and checked; leave it out and the session's model writes one. `key` (default the first field) dedupes, `max` scrolls a feed, `min:0` lets the list be empty. A walk built from the run replays it, with no model.
- `{"cmd":"keep","hints":{…},"env":"X_API_KEY"}` — a secret the site just showed goes straight to the store (`.env` locally, SSM in prod). The journal keeps the element and the name, never the value. This is how keys get set up.
  - **A second key of a vendor**: add `"key":"<vendor>@<label>"` (`"key":"cloudflare@pages","env":"CLOUDFLARE_PAGES_TOKEN"`). The key goes in the vault at its own label and fills its own env name only (no rotation names); the vendor's other keys stay. `autobrowse creds key ls --vendor cloudflare` shows each label and the names it fills.
  - **No replace without a yes.** A name that holds another value: the answer is `{ok:false, kept:false, held:{env, length}, question}` and nothing was written. The question says what would be replaced, then yes or no. No (the default): keep both, the new value under another name or label that says what it is for. Yes: send the same command with `"confirm":true`, only when William said yes to that question in this conversation, or this session made the held value. A `confirm` with no question before it is asked anyway.
  - A label that holds another key, or an env name a vault key fills, is refused with no yes path: a new value there is `autobrowse creds key rotate <address>`, William's call.
  - The same two phases hold for `env set`, `env push`, `env pull`, `env rm`, `creds key add` and `site setup` (`--confirm`), and for a flow or workflow that mints a key (`"replace": true` in its input or plan).
- `{"cmd":"seed"}` — a site asks to set up an authenticator: open the step that shows its QR or setup key ("another authenticator app", "can't scan"), then `seed` seals the seed into this site's login: the otpauth link in a captured call first, then the page. It never answers the seed. Then `place{secret:"<site>.code"}` types the current code, and sign-ins after that need nobody. A login that holds another seed: it asks first (`"confirm":true` only after William's yes).
- `{"cmd":"captcha"}` — solves the page's captcha (a checkbox by a human click, a picture by a model, cropped in memory). Returns `{solved, kind, vendor, reason?}`. Never screenshot a captcha yourself.
- `{"cmd":"note","text":"…"}` — a comment in the journal.
- `{"cmd":"eval","js":"…"}` — last resort; not journaled as a click, so the recording misses it.
- `{"cmd":"batch","cmds":[{…},{…}]}` — up to 30 commands in order, one answer, one `changed`. No `close`, `pause`, `resume`, `save`, `flow`, `code` or nested batch.
- `{"cmd":"flow","name":"amazon-cart","plan":{"searchFor":"Dune"}}` — runs a workflow on this page: a compiled one (`autobrowse workflows`) or a hand-written leg as `<site>-<name>` (`linkedin-create-post`; its input fields are the plan). Its saved plan goes under yours.
  Answer: `{status, steps, gate?, account?, otherSite?, wall?, url}`. The page stays where it ended: go on by hand. Mix freely: sign in, explore, `flow`, explore again.
  - Any site's workflow runs here. The toolkit is a guide, not a lock: a Google page no site claims can still run `google-login` (`tools find google`). `otherSite` names legs of a site that is not this profile's.
  - `plan.account` (any workflow on a site that signs in): its legs run as that account (`google@wren`). None: the profile's own on that platform. A leg of another platform with neither stops at a sign-in wall: the answer has `wall` with `signIn` and `accounts`; send it again with `plan.account`.
  - `<site>-login` signs in with a stored credential (through its Google/Microsoft button when the site has one). `"plan":{"account":"…"}` takes an `account` from the list (`google@wren`), a role (`wren`) or an address; none = the profile's own (a profile with none, such as bare `youtube`, must name one). The runner types it; you never hold it. Use it on a sign-in page, a signed-out state or an expired session instead of `--login` and `place`.
  - Accounts: `profile: true` marks the account this browser profile is for. Another one puts its cookies in this profile; for more than a quick task, start a session as that account instead (`start.sh youtube@<label>`).
  - Every money act asks the person, as yours do. A workflow's `purchase`/`password`/`send` gate asks too. Send with `?wait=1` to hold for the answer.
  - A sign-in step only a person answers (a phone tap, a puzzle, "Verify it's you"): a headless CLI or desk run opens its own window, tells William and waits 5 min; no hold follows. In explore it comes back as `human`: say what the step is and wait.
  - `waiting` with `gate.name` `human`: fix it, then send the same command. The step runs again from its first `open`, so a fix the site keeps (a sign-in, a setting) holds; a fix on the page only (a closed dialog) does not. `choose`: send it again with `"choice":"…"`.
  - `failed`: the same command goes on from the failed step. `"fresh":true` starts over.
  - The journal keeps its acts flat, so `save` makes one recording. A secret flow keeps only its start and end notes.
- `{"cmd":"code","as":"titles","code":"…","plan":{"pages":"40"}}` — a loop, a while, a branch: your code over the primitives, in one command. Use it for any job of more than a few same acts (100 pages, a feed to its end).
  - In scope: `fp.open(url)`, `fp.act(op, hints, {goal})`, `fp.read(hints)`, `fp.has(hints, ms?)`, `fp.wait(ms)`, `fp.human(reason)`, `records({fields, code, key?, max?})` (as the command, no model), `log(values)`, `plan` (strings), `rows` (push your output).
  - Example: `for (let p = 1; p <= Number(plan.pages); p++) { log({p}); await fp.open(plan.base + "?page=" + p); rows.push(...await records({fields:[{key:"title",says:"…"}], code:"return [...root.querySelectorAll('h2')].map(h => ({title: h.textContent}))"})); }`
  - Answer: `{rows, first, calls, stored, log?, url}`. `failed: {call, i, url, log, error}`: fix the code, send it again. Saved reads come back at once (`stored`), the loop goes on from the failed call. `"fresh":true` starts over.
  - Rules: every input in `plan`, never a literal (compile makes each a plan field). No `Date.now()`, no `Math.random()`: they break the saved reads. No secrets in code or plan (refused). A changed `records` code reads every page again.
  - Acts in a rerun: a click, press or script is done once; a rerun skips it and goes on from the URL it left. Hover, fill, select and upload are replayed to rebuild the page. Mark a click that changes only the page (a "Next" with no new URL, a tab, a menu) `{goal, view:true}`, or a rerun skips it and reads the wrong page.
  - Many pages to read: `const got = await fp.each(plan.urls.split(" "), async (tab, url, i) => { await tab.open(url); return tab.records({…}); }, {tabs?}); rows.push(...got.flat())`. Lists in `plan` are one string (`"urls":"a b c"`): plan values are strings. Up to `READ_TABS` (default 3) background tabs, same sign-in; results in item order. A tab has `open`, `read`, `has`, `wait`, `records`, and `act` for hover or a `{view:true}` click/press only. Any other act in a tab, and any `fp` call inside `each`, throws: do it before or after. `failed.item` names the item; a rerun replays done items. Worth it when each page is slow (a scroll read, a heavy page): opens are spaced 0.3–1.2 s, so fast pages gain little.
  - `failed` says an act "may have run" (the last run died mid act): look at the page, then send again with `"started":"ran"` (it happened) or `"redo"`.
  - Money acts ask the person, as yours do. Journaled as one row: `save` compiles it into the workflow. Each call is a row in the run history (`autobrowse explored show <run>`).
- `tools` in an answer: the first answer on a page of a known site lists that site's workflows (`{sites, tools:[{name, aim, inputs, accounts?}], more}`; `inputs` read as code: `q, max = 20, account = "google@wren"` = required, a default (the schema's, the saved plan's, this profile's account), optional with none `max?`; pass a field to override its default; a `-login` tool lists its `accounts`). It comes once per site. A provider's product (youtube.com, portal.azure.com) lists the provider's (`google-login` first). Use one with `flow` before you do the job by hand.
- `{"cmd":"tools"}` — each site and its count. `"site":"x"`: that site's workflows (past the 20 an answer shows). `"find":"words"`: a fuzzy search over all of them.

Files (the Mac's sealed store, `autobrowse files`): start with `--files <set>[,<set>]`
(`start.sh <site> <url> <port> --files coop`) to have a named set at the ready; the
start log lists each file, as `files` does. Any stored file works by name, set or not.
- `{"cmd":"files"}` — the session's files (`"all":true`: every one): name, kind, type, size, note.
- `{"cmd":"upload","hints":{…},"files":["file:resume"]}` — from memory, never a temp file. A `doc` goes at once; a `paper` (an ID document) asks William once per file and host.
- `{"cmd":"read_file","name":"work-history"}` — a doc's text, to fill fields by hand. A paper has none.

Desktop, `{"cmd":"os","act":{…}}`: `{"kind":"apps"}`, `{"kind":"open","app":"Finder"}`,
`{"kind":"tree"}`, `{"kind":"click","role":"AXButton","name":"OK"}`,
`{"kind":"type","text":"…","secret":true}`, `{"kind":"key","combo":"cmd+shift+4"}`,
`{"kind":"shot"}`, `{"kind":"shell","command":"…","root":true}`, `{"kind":"wait","ms":500}`.
Needs Accessibility granted to the terminal; root needs `pnpm autobrowse desktop setup` once.

Session:
- `{"cmd":"goal","text":"…"}` — what this run is for. Send it first: a walk is built from runs that share a goal.
- `{"cmd":"done","outcome":"achieved","summary":"…"}` (or `"failed"`) — how the run ended. Send it last, before `save`. A later `goal` starts the next run in the same session.
- `{"cmd":"pause"}` / `{"cmd":"resume"}` — a person acts by hand in between; those acts land in the journal too.
- Headed, no pause needed: when William does a step by hand between two of your
  commands, your next answer carries `helped: {acts, url, changed, note}`. Read
  the page he left; never redo his step.
- `{"cmd":"journal","last":5}` — what is recorded (`total` and the newest `last`).
- `{"cmd":"save","name":"site-what-it-does"}` — writes `recordings/<name>/`.
- `{"cmd":"close"}` — browser and socket, no verdict. Use `autobrowse stop`.

## How to work

Every look costs tokens. Look once, then let the acts tell you what changed.

1. `start.sh <site> <url>`, then `goal`. The `open` answer already lists the page's controls (`changed.added`).
2. `snapshot`. `aria` with `hints` or a `limit` only when the snapshot is not enough.
3. A long answer (`eval`, `aria`, `text`, `read`, `read_file`, `network` body, `shell`) is compacted to its `limit`, never cut at one point: a list of same-shape objects comes as TOON (`format:"toon"`, a header then rows, lossless); still too long, lists keep their first, last and evenly spaced items (`_i` = the item's place) and long strings their head and tail; a tree loses its deepest levels first. Each gap says what it left out. `whole: {chars, file}` holds the full answer: read the file, or raise `limit`.
4. Every act answers `changed`: `added` (new controls, up to 40), `gone` (a count), `more` (past 40). Read that; don't look again after each act.
5. Acts you are sure of (fill a form, submit) go in one `batch`. It stops at the first failure: `failed: {at, cmd, error}`, `done` holds what ran. A paying click goes alone.
6. Prefer `role`+`name`; fall back to `css`+`nth`. A failed act is not journaled. Change the hints; don't repeat. A miss answers with `marks` (the picture and its list): read it and act on a mark.
6. Never `raw:true` on a page showing a key.
7. Done: `done` with the outcome and a one-line summary, `save` with a kebab name if it should compile, `autobrowse stop <port>`. Or `autobrowse stop <port> achieved|failed "summary"` in one go. Never stop without a verdict: `autobrowse success` counts a run with none as unknown.

The payment gate: a billing field (card, CVC, tax id, billing address) or a
spending button (Buy, Pay, Subscribe, Add funds, Start trial) texts William and
`cmd.sh` holds until he answers (up to ~45 min); the act runs on a yes. No `eval`
or `type` around it. The bank's 3-D Secure challenge (a code texted to his phone,
usually in an iframe on the bank's domain, often nested) is answered with
`place{hints:{role:"textbox",name:"…"},secret:"card.code"}`: no `frame` hint, the
search finds the field; `aria` shows the frames. It works only after `place card.*`
in this session, inside the payment yes or a live `spend --grant`, within 10 min.
It waits up to 90 s for the text and types the newest one; a resend needs a second `place`.

## After: a workflow

Every session is a run, kept for good beside the credentials (`explored`).
Two or three runs that reached the same goal become a walk: screens known by
their URL and landmarks, each with the acts that worked on it. A walk runs
as `<site>/walk-<name>` in the catalog, with no model in the loop.

```sh
autobrowse explored <site>                         # runs: driver, goal, outcome, answer tokens
autobrowse walks build <site> <name> --goal-like "<words>"   # or --run id,id
autobrowse walks show <site>/<name>                # screens and ops, never values
autobrowse walks run <site>/<name> --plan key=value [--yes]  # --yes when it has a final act
autobrowse tokens --days 30                        # spend and the verdict
```

Or compile a saved recording to TypeScript:

```sh
autobrowse compile <name>              # → src/workflows/<name>/
autobrowse try <name>                  # run it here, no Restate: proof it is deterministic
autobrowse repair <failure.json>       # an agent picks up where a flow stopped
```

A flow that breaks gets fixed in the flow (a fallback path, a remap), not
handed to William. Failure files: `~/.config/autobrowse/artifacts/`.
