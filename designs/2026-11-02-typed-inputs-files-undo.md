# Typed inputs, file inputs, verify timing, undo steps

2026-11-02. William: "doing all of these would be good". It must scale to many users and to autobrowse on a server.

## Goal

- A bad input fails before the first click.
- A video reaches the page without a copy in memory or in Restate's journal, on this Mac or on a server, for any user.
- An unclear send settles by a real read. A read that failed runs again when its cause is gone, not on a timer.
- Nothing posts twice on its own.
- A failed run cleans up its own private leftovers and never touches a public object.

## 1. Typed inputs

Each workflow already parses its plan with zod at the run's start (`src/engine/object.ts:291`). A bad plan is terminal, so no retry runs.
The gap: the compiler types every field `z.string().min(1)` (`src/compiler/render.ts:363`), so a file or an email is free text.

- Zod 4's own types, no helpers of ours: `z.email()`, `z.url()`, `z.iso.date()`, `z.ipv4()`, `z.hostname()`. Values stay strings, as a fill types them.
- The compiler picks the type from the recording (`fieldKinds` in `src/compiler/render.ts`): a fill on `inputType` email, url, date or number. A field filled into two kinds stays text.
- A file field is the object ref of section 2, one helper (`fileField`) for every workflow.
- The compiled workflows are retyped by hand once (`finish` writes index.ts once): google-cloud-oauth-client, google-cloud-project, instagram-change-email, aws-port25-request. File fields move with section 2.

## 2. File inputs

### Options

| Option | What the plan holds | Verdict |
|---|---|---|
| A. Object ref | `s3://<bucket>/inputs/owners/<owner>/<sha24>.<ext>`, a string | **Chosen.** Works on any host; the hash in the key proves the bytes |
| B. Files-store id | an id in autobrowse's sealed store (`src/files`) | No: the store is one Mac's, sealed by its keychain |
| C. Presigned URL from wren | a link (the X route today) | No: a retry after the link expires fails |
| D. Local path | a path on this Mac (today) | No: dead on a server and for other users. Kept for local dev runs only |

### How a file reaches the page

1. The file goes to S3 under the owner's prefix, keyed by its content. `autobrowse run` does this today (`shipPlanFiles`); wren will do the same. The plan carries the ref.
2. The plan's zod parse checks the shape (`fileField`: a ref, an https URL or a path). A workflow's `check` step resolves the file and checks its type and size before any act.
3. `resolveFile` streams the object to `<cache>/<owner>/<sha24>.<ext>` with the owner's own AWS session, and checks the sha256.
   The cache path is a pure function of the ref, so a retry or a later step finds the file without a download.
4. Playwright gets the path. A local Chrome reads the path itself; nothing large sits in Node's memory.
5. A sweep drops cache files unused for a day, then the oldest past 20 GB per owner. It runs at most once an hour.

Built (WA-1011): `resolveFile`, `sweepFileCache`, `fileField` (`src/browser/run-files.ts`); the upload op, X and YouTube (`bytesOf`) read through it; the compiler types an uploaded field `fileField()`.
Not yet: wren ships its own files as refs (the X route still gets a presigned URL; it works until the link expires).

- One resolver for every route: X and YouTube's `bytesOf` (`src/sites/youtube.ts:147`) read through it, not a second copy.
- Server: today the owner's session reads the object. A server reads through its own IAM role, scoped to the owners' `inputs/` prefixes. That role is a terraform change, made when the server exists.
- Remote browser (a Chrome on another host): Playwright then streams the file over the connection. The path still works; it costs one upload per run.

## 3. Verify timing

Today: reads at about 30 s, 3 min and 10 min (`VERIFY_PAUSES_MS`), then `unknown`. LinkedIn: one read an hour at most (`VERIFY_GAP_MS`).

An `unknown` has two causes. Each needs its own clock.

| Cause | Example | When to read again |
|---|---|---|
| The read failed | network down, login lost, token refused, desk off | when that cause is gone: the desk is up, the login works |
| The read worked but cannot prove absence | a list that lags, a cut list, one ranked by relevance | after the site's lag window, on the account's own scheduled read |

### Options

| Option | Verdict |
|---|---|
| A. Fixed 3 reads over 10 min (today) | No: arbitrary; a long outage ends in `unknown` after 10 min |
| B. Read again when health returns | **Chosen for failed reads** |
| C. A lag window per site before `absent` counts | **Chosen for lagging lists** |
| D. Fold the verify into the account's scheduled read until it settles | **Chosen for lagging lists**: no extra reads, inside the caps |

- Health is autobrowse's call: it holds the signals (refused tokens, a read's `need_login`). wren keeps only per-loop holds, so it cannot judge an account.
  - A refused token on the account: no read; `healthy` in an hour.
  - A read that failed on a login wall: `healthy` in an hour. Any other failure: in 10 min.
  - The desk is off: wren's ask times out; wren asks again in 10 min.
- A verify is a read with its own bucket (WA-982). The LinkedIn rule of one read an hour holds.
- Still `unknown` after 48 h: it goes to a person.

How:
- autobrowse: an `unknown` verdict says when to ask again: `next: {at, when: "healthy" | "time"} | null`.
  - A read that failed: `healthy`, at once (or after the site's gap).
  - A list that lags, is cut or ranked: `time`, after the site's gap or 30 min.
  - No verify read on the route: `null`, a person decides.
- The fixed pauses go. A fresh send gets one read after 30 s; what is left is wren's to schedule.
- wren: `send_attempts` keeps `recheck_at`, `recheck_when` and the write keys (`writes`). One loop for every item kind (dm, thread, comment, onpost, private, draft):
  - a row's `send_key` is the send's scope; autobrowse keys each write as scope + route (`writeKey`). So the send records each keyed write's key and service (`sites` or `desk`: the journal is on the machine that ran it);
  - due rows ask that service's `verdict` by write key, which only reads;
  - `sent`: the item settles as a person's Mark posted does (`settle-send.ts`);
  - `not_sent`: it stays for a person, marked checked;
  - `unknown`: the next `next` replaces the old one.
- The DM-only recheck (`RECHECK_WHYS`) folds into this loop.

## 4. No automatic repost

- `not_sent` proven by a full read never sends again on its own. A person says "send again".
- Change: outreach `recordNotSent` (`wren/packages/starling/outbound/src/tick.ts:590`) puts the message back in the queue after `NOT_SENT_HOLD_MS`. Under this rule it holds for a person. Desk posts already hold (`sendHeld`).
- A refusal before the submit (`before_submit`, a cap) still requeues: nothing reached the site.

## 5. Undo steps

### Options

| Option | Verdict |
|---|---|
| A. `undo(plan, memo)` on a step; the engine runs the done steps' undos in reverse on a terminal error | **Chosen** |
| B. One cleanup per workflow | No: it must know which steps ran |
| C. A Restate saga per route, by hand | No: one copy per route |

Rules:
- An undo touches only what nobody else sees: a held cap slot, uploaded media not yet posted, a draft, a temp file.
- No undo deletes or edits a public object. A public act that went out stays; the verdict records it.
- On an `unknown` verdict no undo runs. The cap slot stays held until the verdict settles.
- An undo that fails goes to the run's history and to a person. It never blocks the run's answer.

### When undos run

A failed run resumes from its failed step: `run` again and the done steps are not redone. An undo at failure would break that.

| Option | Verdict |
|---|---|
| A. At every terminal error | No: kills resume after a fix |
| B. Only on reject and reset | No: a failed run nobody resumes keeps its drafts for good |
| C. Reject and reset at once; a failed run after a day with no rerun | **Chosen** |

- A run that is done keeps all: what it made is the goal, not a leftover.
- An irreversible step that may have acted (failed, needs a person, rejected at the human gate) stops every undo: the same rule as `unknown`.
- `defineWorkflow` refuses an `undo` on an irreversible step.
- A public act that went out keeps every step before it: the post uses that draft and media. Only steps after it are undone.
- Undos run in their own `undo` invocation. An undo that retries through an outage never holds a reject or a reset. A reset passes the state it clears.
- An undone step runs again on a rerun. A failed undo is `undo-failed` in the results and a message to a person.

Built (WA-1014): `StepDef.undo`, `undoRun` (`src/engine/run.ts`), the `undo` handler (`src/engine/object.ts`), the `undone` event. No workflow has an undo yet: the drafts and media of section 5 are site route legs today, not workflow steps.

## Decision log

- 2026-11-02: Typed input fields come from the recording, as zod's own types (my call: zod has them; no helpers of ours).
- 2026-11-02: A file input is an S3 object ref, presigned at use and cached by sha256 per owner (William: "as long as it scales to multi user and … on a server").
- 2026-11-02: A failed verify read runs again when health returns, not on a timer (William). A lagging list waits for the site's window.
- 2026-11-02: No automatic repost, for posts and outreach (William: "duplicate posts might decrease trust").
- 2026-11-02: wren stores each keyed write's key and service on the row, and asks `verdict` by it (my call). Rejected: a verify-only flag on every kind's send handler, rerun as the DM recheck does: more plumbing, and the reads before the write run again against the caps.
- 2026-11-02: Health is judged in autobrowse's `verdict`, not by wren (my call): autobrowse has the refused tokens and the read's error code; wren has only per-loop holds.
- 2026-11-02: The ref stays a string, not `{key, sha256, type, bytes}` (my call): it already ships, a fill takes strings, and the hash in the key proves the bytes. Type and size are checked from the file.
- 2026-11-02: The cache, not Restate's journal, holds the local path (my call): the path is a function of the ref, and a journaled path is wrong on another host.
- 2026-11-02: Undo steps clean only private leftovers; a public object is never deleted (William).
- 2026-11-02: Undos run on reject and reset at once, and a day after a failure with no rerun (my call): a failed run must stay resumable.
