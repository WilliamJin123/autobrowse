# Captcha panel and solve record (WA-1095)

## Goal

A picture captcha is read right more often, and each solve leaves a record that says what each model saw and whether the site then let the run on.

## What October showed

- 541 captcha calls, all from LinkedIn's security check (10-28/29, 66 runs).
- 51 runs: the solver said "solved", and the run was still on `/login/`.
- 9 runs: "the eyes could not read the grid". Cause found in the bench: Sonnet thinks before it answers, and the 300-token cap ran out first (empty reply, 3 of 100 grids). At 1,500 all 3 answered. 66 of October's 541 calls (12%) stopped at the cap.
- `captchaSolved` meant "the challenge went away", not "the site let us in". Nothing kept what the model said.

## Bench

`recaptchav2-29k` tiles (multi-label: bicycle, bus, car, crosswalk, hydrant), 3×3 grids with 2–4 matches, drawn like reCAPTCHA's challenge and shot headless. Each model got the production prompt. Two ways: the whole challenge, or the whole plus the 9 crops. Score: tiles right (of 9 per grid) and grids exactly right.

100 grids, the whole challenge:

| Model | Tiles right | Grids right | p50 |
|---|---|---|---|
| `claude-sonnet-5-5` | 93.9% | 75% | 3.3 s |
| `gemini-3.1-flash-lite` (free keys; 26 of 60 calls refused for quota) | 64.1% | 40% | 2.2 s |
| `command-a-vision-07-2025` | 72.2% | 16% | 1.1 s |

On the 72 grids where all three answered: Sonnet 96.9% / 79%, the panel (majority, any lead) 93.7% / 64%. The weaker two outvote Sonnet when they agree on the same wrong square.

First 40 grids, also with crops of each square:

| Model | Whole | Whole + crops |
|---|---|---|
| `claude-sonnet-5-5` | 92.8% / 78% | 83.6% / 72% |
| `gemini-3.1-flash-lite` | 91.7% / 68% | 95.3% / 72% |
| `command-a-plus-05-2026` | 77.2% / 23% | 79.7% / 28% |
| `command-a-vision-07-2025` | 75.3% / 20% | 61.7% / 0% |

(tiles right / grids right). A 3-model panel looked 3 points better on these 40; the 100 showed that was noise.

Not in the bench: `gemini-3.8-flash` and `gemini-3.1-pro-preview`. The free keys hit their quota at once (429), and 3.8-flash thinks for about 40 s a call.

## Options

### How to read the picture better

| Option | Verdict |
|---|---|
| A. Sonnet alone, with room to answer (3,000 tokens) | **Chosen** as the default. Best measured; the cap fix ends the empty replies |
| B. Crops of each square beside the whole | No: mixed. Helps Flash-Lite a little, costs Sonnet 9 points of tiles |
| C. A panel of different makers that votes | Built, **off by default** (`EYES_PANEL`). With the models we have, it lost 15 points of whole grids to Sonnet alone. Kept for a stronger second model (a paid Gemini 3.8 Flash or Pro, not testable on free keys) |
| D. A paid solver service | No: hosted, and William's rule is self-hosted |

### How the panel votes

| Option | Verdict |
|---|---|
| A. Majority per square, tie to the lead | **Chosen** for grids: a square is clicked when most say so |
| B. Union of all picks | No: every false pick adds a wrong click |
| C. The lead decides, others only break refusals | No: drops the lift the vote gives |

Text, slider and canvas answers: the answer most others match (`mostAlike`), tie to the lead.

### Where the record goes

| Option | Verdict |
|---|---|
| A. In the flow's run row (`captchas`) | **Chosen**: the row already has the outcome, so "solved, then the run passed" needs no join |
| B. A separate `captcha-*.jsonl` ledger | No: a second file and a join on run id to know if the site let us on |

## Decision log

- 2026-11-05: Build the solve record and better reads; no stop on a flagged account (William: "dont build 1 but build 2 and 3").
- 2026-11-05: Panel of different makers built (William: "uses gemini / cohere (multi model consensus)"), left off: on 100 grids it was worse than Sonnet alone. Turn on when a second model scores near Sonnet on this bench.
- 2026-11-05: The eyes get 3,000 tokens, not 300: Sonnet's thinking used the 300 up (the October "could not read" runs). A cap is a ceiling, not a spend (William: "might wanna be like even more 3000"). Every other call under 3,000 (repair, do-pick, records, the explorer step) is raised to 3,000 for the same reason, and the Anthropic driver now names an answer lost to thinking instead of returning empty text.
- 2026-11-05: No crops: the bench showed they hurt the strongest model.
- 2026-11-05: Bench scripts are not in the repo (one-off, scratch); the method is above to redo it.
- 2026-11-05: Cohere's own v2 door now takes images (vision models read them there; the old driver refused).
- 2026-11-05: `gemini` is a provider through Google's OpenAI-compatible door; the key is `GEMINI_API_KEY`.
- 2026-11-05: Each model gets 20 s; a slow or failing member is left out of the vote, not waited on.
- 2026-11-05: Render's wall solve (`browser/render.ts`) is not recorded: it has no run row. Flows are where the walls were.
