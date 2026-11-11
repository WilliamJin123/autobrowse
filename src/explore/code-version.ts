/**
 * The code an explore session runs: the checkout's HEAD sha, or the package version when
 * installed from npm. A session lives for hours; a commit in that time makes it stale.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** src/explore or dist/explore → the package root. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");

/** `.git` dir, or a worktree's `.git` file → its gitdir; refs live in the shared `commondir`. */
function gitDirs(root: string): { head: string; refs: string } | null {
  const dot = join(root, ".git");
  if (!existsSync(dot)) return null;
  const head = statSync(dot).isDirectory()
    ? dot
    : resolve(root, /^gitdir: (.+)$/.exec(read(dot))?.[1] ?? dot);
  const common = read(join(head, "commondir"));
  return { head, refs: common ? resolve(head, common) : head };
}

/** `.git/HEAD` → its sha (loose ref or packed-refs), 12 chars; else `v<package version>`. */
export function codeVersion(root = PACKAGE_ROOT): string {
  try {
    const g = gitDirs(root);
    const head = g ? read(join(g.head, "HEAD")) : "";
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    const sha =
      g && ref
        ? read(join(g.refs, ref)) ||
          (read(join(g.refs, "packed-refs"))
            .split("\n")
            .find((l) => l.endsWith(` ${ref}`))
            ?.split(" ")[0] ??
            "")
        : head;
    if (/^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 12);
    const pkg = JSON.parse(read(join(root, "package.json")) || "{}") as { version?: string };
    return pkg.version ? `v${pkg.version}` : "unknown";
  } catch {
    return "unknown";
  }
}

/** A checker that says once a minute at most whether the code moved past `started`. */
export function skewWatch(started: string, root = PACKAGE_ROOT, every = 60_000) {
  let at = 0;
  let now = started;
  return (t = Date.now()): string | null => {
    if (t - at >= every) {
      at = t;
      now = codeVersion(root);
    }
    return now !== started && now !== "unknown"
      ? `this session runs code ${started}; the code is now ${now}: stop and reopen it for the new code`
      : null;
  };
}
