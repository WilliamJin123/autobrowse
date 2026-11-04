# Disk upkeep (WA-1056)

William's disk: `~/.config/autobrowse` was 28 GB, 22 GB of it 83 browser profiles. Goal: cut it without touching any identity.

## Target

- Each profile keeps its own identity: cookies, storage, history, logins. Never shared.
- Caches are capped. Chrome rebuilds them.
- Component files Chrome copies into every profile (TTS voices, crx, suggest model) are one set of blocks.
- Failure dumps live in the bucket; the disk keeps the last 14 days.

## What it is

- `--disk-cache-size=200 MB` on every local launch (`browser/session.ts`).
- `browser/profile-trim.ts`, daily on the disk timer and `autobrowse trim [--dry]`:
  - Closed profiles only: a live `SingletonLock` pid skips the profile, read again before each write.
  - A cache folder over 300 MB goes whole.
  - On macOS, equal files over 100 KB in the component folders become `clonefile` copies of one. A ledger (`profiles-cloned.tsv`) keeps reruns to new files.
- `keepDiskOnTimer` (`app/services-state.ts`): one timer for desk and box. Traces copy and sweep, shots ship and clear, profile trim.
- `ShotRoot.clearAfterDays`: the artifacts root clears top-level dumps once shipped and 14 days old. Subfolders (records, sends, uploads) are state and stay.

Measured 2026-11-04: 149 → 161 GiB free. Trim: 8.8 GB of caches, 653 files (3.7 GB) cloned.

## Options

| Option | Verdict |
|---|---|
| A. Cap and trim caches per profile; clone equal component files | **Chosen**. No identity shared; reversible; Chrome rebuilds what goes |
| B. One shared cache or one profile per site group | No: shared cookies and storage link accounts a site must see as separate people |
| C. `--disable-component-update` | No: stops Widevine and security updates; a missing Widevine is a tell |
| D. Hardlinks for component files | No: an in-place write to one would change every profile; clones are copy-on-write |
| E. Delete idle profiles | No: their sign-ins cost a person to make again |

## Decision log

- 2026-11-04: Option A (William's disk question, relayed by the birdwatch session).
- 2026-11-04: Clones by `/bin/cp -c`. Node's `COPYFILE_FICLONE` copies in full on macOS, and `_FORCE` fails with ENOSYS (measured).
- 2026-11-04: The lock's host is ignored: the Mac's name changed twice, and a live lock under the old name must still count.
- 2026-11-04: Trim line 1.5× the flag: the flag is a soft cap, and a cache at 210 MB must not go every day.
- 2026-11-04: The desk had no shots timer (only the box's `main.ts` had one), so shots stopped shipping on 10-19. One shared timer fixes both.
- 2026-11-04: The trim runs while the network is held: it is local.
