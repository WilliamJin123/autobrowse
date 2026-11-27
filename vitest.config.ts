import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Vitest keeps transformed modules in <tmpdir>/<21-char nanoid>/ssr and removes the dir only on a
// clean close; killed runs left 6217 of them, 20.6 GB (10-23). Its own dir takes the path before
// this config loads, so moving TMPDIR here cannot help. Each run removes leaks idle over an hour.
// Same as wren's packages/db/src/testing-vitest.ts: the repos share no test code.
function pruneLeakedRuns(): void {
  const cutoff = Date.now() - 3_600_000;
  for (const root of new Set([tmpdir(), "/private/tmp"])) {
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => /^[\w-]{21}$/.test(n));
    } catch {}
    for (const name of names) {
      try {
        const dir = join(root, name);
        if (Math.max(statSync(dir).mtimeMs, statSync(join(dir, "ssr")).mtimeMs) < cutoff)
          rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}
pruneLeakedRuns();
// Fetched plan files: a cache hit from the last run would skip a test's fetch.
const FILE_CACHE_DIR = join(tmpdir(), "autobrowse-test-files");
rmSync(FILE_CACHE_DIR, { recursive: true, force: true });
export default defineConfig({
  test: {
    // dist/ holds tsc copies of src tests: same tests twice
    exclude: [...configDefaults.exclude, "dist/**"],
    // the repo's sign-in walks in SITE_LOGINS, as every entry point loads them
    setupFiles: ["test/boot-logins.ts"],
    env: {
      AUTOBROWSE_STATS: "off",
      AUTOBROWSE_RESUME: "off",
      AUTOBROWSE_SHARE: "off",
      PLANS_DIR: join(tmpdir(), "autobrowse-test-plans"),
      SETTINGS_FILE: join(tmpdir(), "autobrowse-test-settings", "settings.json"),
      LIMITS_FILE: join(tmpdir(), "autobrowse-test-limits", "limits.json"),
      FILE_CACHE_DIR,
      // Playwright's Chromium, never the person's Chrome app: an update it stages kills each launch
      // ("Library missing", a crash report per test, 11-26)
      BROWSER_ENGINE: "chromium",
    },
    // default is cores - 1 (9 here), each fork up to a browser: the 16 GB Mac swapped 17 GB (11-26)
    maxWorkers: 4,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
