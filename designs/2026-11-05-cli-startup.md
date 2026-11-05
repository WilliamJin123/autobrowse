# CLI start-up time (WA-1102)

## Goal

A command answers as fast as its own work allows. The start (load the code, register the commands) was 1.5 s of every command.

## What the start cost

`autobrowse --help` on William's Mac, warm disk: 1.5 s (`pnpm -s autobrowse`: 2.0 s). A CPU profile put about 85% in module load.

| Part | Cost |
|---|---|
| Packages only a few commands use: Playwright 330–490 ms, AWS clients 80–130 ms each, undici 54–100, nodemailer + libmime 60–110, obs-websocket-js 28 | about 740 ms |
| tsx: its loader, and a transform of each of 385 own files | about 400 ms |
| The rest: read and compile 385 own files and about 200 package files | about 350 ms |

## Options

### How the TypeScript runs

| Option | `--help` | Verdict |
|---|---|---|
| A. tsx (before) | 0.94 s | No: the slowest; its loader runs for every file |
| B. tsx + Node's compile cache | 0.80 s | No: the tsx loader still runs |
| C. Node strips the types itself, with a compile cache per file | 0.50 s | **Chosen**. No build, always HEAD. The cache is keyed by each file's content, so an edit recompiles one file and nothing can go stale |
| D. An esbuild bundle, rebuilt when a source file is newer | 0.38 s | No: 0.12 s more, for a build step that must detect staleness, a cache that grows with each rebuild, and `import.meta.url` paths that change meaning (6 places). Peers edit this checkout all day, so many starts would pay the rebuild |
| E. Run `dist/` | 0.45 s | No: a build before every use, or a stale CLI |

(Times after the lazy imports below. C needs source Node can strip: no parameter properties, enums or namespaces.)

### Which code a start loads

| Option | Verdict |
|---|---|
| A. Heavy packages load at first use (`import()` where they are used) | **Chosen**. 13 packages leave the start; a test holds them out |
| B. Each command loads only its own module | Not now. 12 command groups would start in about 0.2 s (settings, env, share, film…). The common ones (`web`, `runs`, `sites`, `explore`) all reach `services.ts`, which pulls 311 files: they would not change. It pays only after that hub is split |
| C. Split `services.ts` so a command builds only its own clients | Later, as its own design: it is the composition root for 29 command files |

## Built

- Lazy: Playwright (`cli-film` → `film/director`), obs-websocket-js (`calls/obs`), undici (`share/fetch`), nodemailer and libmime (`google/gmail`; `rawHeader` is now async), AWS SSM, EC2, ACM, CloudFront, Route 53 (`clients/roster`, `money/wallet`, `money/profile`, `app/box`, `app/box-register`, `app/cli-connectors`, `clients/aws-domain` through `later`).
- `later(make)` in `app/services-kit.ts`: `lazy` for a client whose package loads at first use. Each method call waits for the import. Only for clients used through async methods (`ssm.send`, the domain client).
- `bin/ts-loader.mjs`: maps `./x.js` to `./x.ts` under `src/`, and turns on Node's compile cache (`node_modules/.cache/compile`). `bin/autobrowse` and `pnpm autobrowse` use it.
- Source is erasable TypeScript: 23 files' constructor parameter properties are now plain fields. `erasableSyntaxOnly` in `tsconfig.json` holds it.
- `test/cli-loads.test.ts` lists the packages a start must not load.

## Result

| | Before | After |
|---|---|---|
| `autobrowse --help` | 1.5 s | 0.50 s |
| `autobrowse tokens --days 1` | 1.6 s | 0.55 s |
| `pnpm -s autobrowse --help` | 2.0 s | 0.9 s (pnpm itself is 0.4 s) |
| `autobrowse cmd …` | 0.09 s | 0.09 s |

The task aimed at 0.4 s. The 0.1 s left is in the options not taken (B/C above) and in credvault, below.

## Decision log

- 2026-11-05: Lazy imports and a compile cache (William: "go ahead with the optimizations you recommended").
- 2026-11-05: Node's own type stripping, not tsx, for the CLI. Stable in Node 25; the launcher hides the experimental warning Node 24 prints.
- 2026-11-05: The worker and the desk stay on tsx. They start once, and the desk is prod: a loader change there has risk and no gain. Two loaders run the same source; `erasableSyntaxOnly` and the CLI load test keep the source valid for both.
- 2026-11-05: No bundle (option D): 0.12 s does not pay for a staleness check.
- 2026-11-05: The wallet's `ParameterNotFound` check is by name only (it was `instanceof` or name): the class would need the SDK loaded.
- 2026-11-05: Not done: credvault imports `@aws-sdk/client-ssm` and `client-sts` when it loads, about 60 ms of every start. It needs a credvault release (WA-1103).
- 2026-11-05: No time budget in the test: a time fails under load. The test checks which packages loaded.
