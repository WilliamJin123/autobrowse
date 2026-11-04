import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISK_CACHE_BYTES, trimProfiles } from "../src/browser/profile-trim.js";

const big = Buffer.alloc(1.5 * DISK_CACHE_BYTES + 1);
const model = Buffer.alloc(200 * 1024, 7);

function profiles() {
  const root = mkdtempSync(join(tmpdir(), "trim-"));
  const dir = join(root, "profiles");
  for (const p of ["a", "b", "open"]) {
    mkdirSync(join(dir, p, "Default", "Cache"), { recursive: true });
    mkdirSync(join(dir, p, "Default", "Code Cache"), { recursive: true });
    mkdirSync(join(dir, p, "WasmTtsEngine", "1.0"), { recursive: true });
    writeFileSync(join(dir, p, "Default", "Cookies"), "identity");
    writeFileSync(join(dir, p, "Default", "Code Cache", "js"), "small");
    writeFileSync(join(dir, p, "WasmTtsEngine", "1.0", "voice.bin"), model);
  }
  writeFileSync(join(dir, "a", "Default", "Cache", "data"), big);
  writeFileSync(join(dir, "open", "Default", "Cache", "data"), big);
  symlinkSync("OldHost-4242", join(dir, "open", "SingletonLock"));
  const old = new Date("2026-10-01T00:00:00Z");
  utimesSync(join(dir, "b", "WasmTtsEngine", "1.0", "voice.bin"), old, old);
  return { dir, ledgerFile: join(root, "cloned.tsv"), alive: (pid: number) => pid === 4242 };
}

describe("trimProfiles", () => {
  it("removes caches over the cap in closed profiles only; identity stays", async () => {
    const p = profiles();
    const r = await trimProfiles({ profilesDir: p.dir, ledgerFile: p.ledgerFile, alive: p.alive });
    expect(r.profiles).toBe(3);
    expect(r.open).toEqual(["open"]);
    expect(r.removed.map((x) => x.path)).toEqual([join(p.dir, "a", "Default", "Cache")]);
    expect(() => statSync(join(p.dir, "a", "Default", "Cache"))).toThrow();
    expect(statSync(join(p.dir, "open", "Default", "Cache", "data")).size).toBe(big.length);
    expect(readFileSync(join(p.dir, "a", "Default", "Cookies"), "utf8")).toBe("identity");
    expect(readFileSync(join(p.dir, "b", "Default", "Code Cache", "js"), "utf8")).toBe("small");
  });

  it("dry removes nothing", async () => {
    const p = profiles();
    const r = await trimProfiles({
      profilesDir: p.dir,
      ledgerFile: p.ledgerFile,
      alive: p.alive,
      dry: true,
    });
    expect(r.freedBytes).toBe(big.length);
    expect(statSync(join(p.dir, "a", "Default", "Cache", "data")).size).toBe(big.length);
  });

  it.runIf(process.platform === "darwin")(
    "clones equal component files across closed profiles, keeps each mtime, and a rerun clones nothing",
    async () => {
      const p = profiles();
      const o = { profilesDir: p.dir, ledgerFile: p.ledgerFile, alive: p.alive, clone: true };
      const voice = join(p.dir, "b", "WasmTtsEngine", "1.0", "voice.bin");
      const before = statSync(voice).mtimeMs;
      const r = await trimProfiles(o);
      expect(r.cloneError).toBeNull();
      expect(r.cloned).toBe(1);
      expect(readFileSync(voice).equals(model)).toBe(true);
      expect(Math.trunc(statSync(voice).mtimeMs)).toBe(Math.trunc(before));
      expect(readFileSync(p.ledgerFile, "utf8").trim().split("\n")).toHaveLength(2);
      const again = await trimProfiles(o);
      expect(again.cloned).toBe(0);
    },
  );
});
