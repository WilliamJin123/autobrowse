import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeVersion, PACKAGE_ROOT, skewWatch } from "../src/explore/code-version.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function checkout(o: { loose?: string; packed?: string }) {
  const root = mkdtempSync(join(tmpdir(), "cv-"));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (o.loose) writeFileSync(join(root, ".git", "refs", "heads", "main"), `${o.loose}\n`);
  if (o.packed) writeFileSync(join(root, ".git", "packed-refs"), `${o.packed} refs/heads/main\n`);
  return root;
}

describe("explore code version", () => {
  it("reads HEAD's sha, loose or packed; npm installs give the package version", () => {
    expect(codeVersion(checkout({ loose: A }))).toBe("a".repeat(12));
    expect(codeVersion(checkout({ packed: B }))).toBe("b".repeat(12));
    const npm = mkdtempSync(join(tmpdir(), "cv-"));
    writeFileSync(join(npm, "package.json"), '{"version":"1.2.3"}');
    expect(codeVersion(npm)).toBe("v1.2.3");
    expect(codeVersion(PACKAGE_ROOT)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("warns once the checkout moves past the session's code, checked at most each minute", () => {
    const root = checkout({ loose: A });
    const skew = skewWatch(codeVersion(root), root);
    expect(skew(0)).toBeNull();
    writeFileSync(join(root, ".git", "refs", "heads", "main"), B);
    expect(skew(30_000)).toBeNull();
    expect(skew(60_000)).toMatch(/runs code aaaaaaaaaaaa; the code is now bbbbbbbbbbbb/);
  });
});
