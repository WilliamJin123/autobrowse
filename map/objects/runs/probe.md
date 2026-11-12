---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-11-10 @ HEAD
entity: src/runs/probes.ts
---

# Probe

A pass that proves what still works with no caller waiting: each site's who-am-I call (`checkSite`) and a re-proof of each compiled workflow with a `.plan.json`. One typed row each in `probes/probes-YYYY-MM.jsonl` (OpenCLI audit U17).

## Why this shape

A route or flow breaks between calls; the first caller should not be the one who finds out. Workflows opt in: a proof declines gates, but a profile edit or a sign-up is not gated, so a re-proof of every workflow could write. States are Agent-Reach's, plus `off_fixture` (a proof that missed its `expect.json`, [[proof]]).

## Shape

- `ProbeRow { at, kind: site|workflow, name, state, ms, why }`, `ProbeState` — `src/runs/probes.ts:26`; `stateOfCode` (error code → state) — `:39`; `siteProbeRow` — `:57`; `workflowProbeRow` — `:77`
- `recordProbes`, `readProbes` — `:114`, `:127`; `latestProbes` (newest per name, last ready) — `:148`; `probeDue` (week since the newest row) — `:164`; `probeLines` — `:170`
- `reproofPlanned` (a broken registry flow opens one issue) — `src/share/gate.ts:387`; `CheckRow.code` — `src/sites/facade.ts:391`
- `runProbe`, `probeOnTimer` (every 6 h, runs when due) — `src/app/services-state.ts:368`, `:336`; `probesDirFor` — `:516`; desk — `src/app/desk.ts:117`

## Connected to

- **joins:** [[proof]], [[flow-pack]] (registry issues), [[site-call-ledger]] (`autobrowse stats success`)
- **looks-like-but-is-not:** `site check` (prints, keeps nothing)

## Surfaces

| Surface | Role |
|---|---|
| desk timer, `autobrowse probe` | write |
| `autobrowse stats success` | read |
