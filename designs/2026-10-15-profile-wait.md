# A busy profile queues the call

2026-10-15, bead wa-z8q. At 17:00 UTC a scheduled TikTok post failed for good: `profile
google@wren is open in pid 11913 (explore:9092); may have gone through`. The desk refused at
profile open, before Chrome launched. Nothing was posted. The same lock closed tab watchers and
failed Reddit reads.

## What happens now

- **Wait, don't fail.** `assertProfileFree` throws `ProfileBusy`. `waitForProfile`
  (`src/browser/profile-wait.ts`) wraps every `sites`/`desk` `call`, `arm` and `setup`: a busy
  try is journaled as an answer (not a throw, so a write's one try is not spent), then a durable
  `ctx.sleep` (15 s, 30 s, then 60 s), then a new step `<name> (try n)`. It runs once when the
  profile frees.
- **Bound.** Past 5 min it goes back as `TerminalError("not sent: profile X is busy (owner);
  waited N min for it, try again", 503)`. Callers read 503 + `not sent:` as "try next tick".
- **Exact words.** A failed write says whether it left. `markSubmitted()` flags the call when a
  flow's irreversible act starts, or when the API leg is about to send. Not flagged: `not sent:
  <why>`. Flagged: `<why>; may have gone through`. A refusal under 500 stays as it is.
- **Lease.** An explore session closes after 10 min with no command, journal kept. A write (not
  a read) takes the profile from a session idle 3 min, not held, not driven by a person: `close`
  with `keep` and a `why`, logged `profile taken from idle explore`. A session being driven
  keeps it; the write waits.
- **Watchers.** On a busy profile the watch is `paused`, looks again each minute, no doubling,
  and opens when the profile frees. Never `watch closed` for it.
- **Caps.** A busy try reached no site, so its meter is given back.

## Decisions

- One wrapper in the service, not per site: every desk call gets it.
- Journal the busy try as a value. Throwing would hit `WRITE_RETRY`'s one attempt.
- Take only from explore/agent sessions. Desk, CLI and teach sessions are never closed.
- `do` and `browser` services unchanged: box-only, and `browser` already retries.

## Wren

wren reads 503 + `not sent:` (`browserBusy`) and keeps the draft approved and scheduled,
showing "Waiting for the browser". Untagged legacy messages still read as "may have gone through".

## A dropped stream's replay joins the run (WA-1023, 2026-11-03)

The desk's h2 link to Restate (box `cloudflared access tcp` → Cloudflare → the Mac's tunnel) drops about every 18 min: 240 RT0010 "broken pipe" in 72 h. A drop kills every stream on the link, at any age (2 s to 700 s). About 44% match a drop of the Mac's tunnel ("no recent network activity"); the rest are on the box or edge side. Restate retries a second later, but the handler on the desk keeps running its flow, and the replay ran the step again: a second browser flow, a second cap unit (LinkedIn search: posts 1 to 4). Long calls meet a drop more often; no timer was at fault (`call` is 2 h).

- `waitForProfile` runs each step through `joinedRun` (`browser/joined-run.ts`), keyed by invocation, step name and that name's count in this try. A replay while the first try runs awaits it; a replay after it ended takes its value or terminal error (1 h). A retryable error is not kept.
- In memory: a desk restart forgets, and that replay runs the step again.

Options for the link itself (not built, William's call):

| Option | Verdict |
|---|---|
| A. Keep cloudflared both ends; the join absorbs drops | Built. Each drop still costs a replay of the journal |
| B. WireGuard: the Mac dials the box (UDP), Restate calls the desk on the tunnel IP | Recommended. TCP inside rides out a short blip; no Cloudflare hop. Opens one UDP port on the box; a root launchd daemon on the Mac |
| C. Tailscale with self-hosted Headscale | No: B with a control server to run |
| D. The Mac's tunnel on `--protocol http2` (TCP) in place of QUIC | Cheap, but only the Mac side; the box side drops stay |

Decision log:
- 2026-11-03: Join by invocation + step + count, not name alone: one try may run a name twice (a call again after its refused token is re-made).
