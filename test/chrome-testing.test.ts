/** `browsers update-chrome`: Google's list read, the zip unpacked into a version folder, old ones pruned. No network. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_GOOD, updateChrome } from "../src/browser/chrome-testing.js";
import { testingBinaryIn, testingVersions } from "../src/browser/engines.js";

const ZIP = "https://storage.example/158.0.8127.99/mac-arm64/chrome-mac-arm64.zip";
const list = (version: string) => ({
  channels: {
    Stable: {
      version,
      downloads: {
        chrome: [
          { platform: "mac-x64", url: "https://storage.example/x64.zip" },
          { platform: "mac-arm64", url: ZIP },
        ],
      },
    },
  },
});

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakes(version: string) {
  const asked: string[] = [];
  const fetch = (async (u: string) => {
    asked.push(u);
    return u === KNOWN_GOOD ? Response.json(list(version)) : new Response("zipbytes");
  }) as typeof globalThis.fetch;
  // unzip: lays out Google's app path
  const unzip = async (_zip: string, dest: string) => {
    const bin = testingBinaryIn(dest, "arm64");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "");
  };
  return { asked, deps: { fetch, unzip, arch: "arm64", processes: async () => "" } };
}

const seed = (v: string) => {
  const bin = testingBinaryIn(join(dir, v), "arm64");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "");
};

describe("updateChrome", () => {
  it("installs a new Stable and keeps the newest two", async () => {
    dir = mkdtempSync(join(tmpdir(), "cft-"));
    for (const v of ["157.0.1.1", "158.0.8127.88"]) seed(v);
    const { asked, deps } = fakes("158.0.8127.99");
    const r = await updateChrome({ ...deps, dir });
    expect(asked).toEqual([KNOWN_GOOD, ZIP]);
    expect(r).toMatchObject({ version: "158.0.8127.99", installed: true, removed: ["157.0.1.1"] });
    expect(existsSync(r.binary)).toBe(true);
    expect(testingVersions(dir)).toEqual(["158.0.8127.99", "158.0.8127.88"]);
    // no zip or half-made folder left
    expect(existsSync(join(dir, ".158.0.8127.99.zip"))).toBe(false);
    expect(existsSync(join(dir, ".158.0.8127.99.part"))).toBe(false);
  });

  it("already the newest: no download", async () => {
    dir = mkdtempSync(join(tmpdir(), "cft-"));
    seed("158.0.8127.99");
    const { asked, deps } = fakes("158.0.8127.99");
    const r = await updateChrome({ ...deps, dir });
    expect(asked).toEqual([KNOWN_GOOD]);
    expect(r.installed).toBe(false);
  });

  it("never deletes a version a running browser uses", async () => {
    dir = mkdtempSync(join(tmpdir(), "cft-"));
    for (const v of ["155.0.1.1", "156.0.1.1", "157.0.1.1", "158.0.8127.88"]) seed(v);
    const { deps } = fakes("158.0.8127.88");
    const r = await updateChrome({
      ...deps,
      dir,
      processes: async () => `${testingBinaryIn(join(dir, "155.0.1.1"), "arm64")} --headless\n`,
    });
    // the newest two stay, and 155 while it runs
    expect(r.removed).toEqual(["156.0.1.1"]);
    expect(testingVersions(dir)).toEqual(["158.0.8127.88", "157.0.1.1", "155.0.1.1"]);
  });

  it("a zip with no app fails and leaves nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "cft-"));
    const { deps } = fakes("158.0.8127.99");
    await expect(
      updateChrome({
        ...deps,
        dir,
        unzip: async (_z, d) => void mkdirSync(d, { recursive: true }),
      }),
    ).rejects.toThrow(/holds no mac-arm64 app/);
    expect(testingVersions(dir)).toEqual([]);
    expect(existsSync(join(dir, ".158.0.8127.99.part"))).toBe(false);
  });
});
