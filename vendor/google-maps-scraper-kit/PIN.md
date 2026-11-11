# google-maps-scraper-kit, vendored

- Source: https://github.com/Mahanaicoach/google-maps-scraper-kit
- Commit: 29893c834862e39e8e389eda516595dbaec9ecbd (2026-11-10, engine 2.3.1)
- License: MIT (`LICENSE`); city presets CC BY 4.0 (`engine/presets/NOTICE.md`)
- Kept: `engine/` without tests and `spike.py`. Not kept: scripts, web docs, Docker files.
- Unchanged code. autobrowse runs `engine/serve.py` on 127.0.0.1:8091 with `SCRAPER_NO_UPDATE_CHECK=1` (`src/reach/maps.ts`).
- Update: copy the same files from a newer commit, change this pin, run `autobrowse maps` once on a known search.
