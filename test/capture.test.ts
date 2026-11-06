import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { captureFor, keepRun, packStale } from "../src/runs/capture.js";

const dirFor = () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  mkdirSync(join(dir, "x"));
  return dir;
};
const unpack = (file: string) => zstdDecompressSync(readFileSync(file)).toString();

describe("a run's observations", () => {
  it("keeps a text once, across lives; rows longer than a read piece and short lines too", async () => {
    const dir = dirFor();
    const file = join(dir, "x", "r1.obs.jsonl");
    const first = captureFor(dir, "x", "r1");
    const big = "a".repeat(2_500_000);
    const h = first.text("hello");
    const hBig = first.text(big);
    // a torn line a killed session left
    writeFileSync(file, `${readFileSync(file, "utf8")}{"h":"12\n`);
    const second = captureFor(dir, "x", "r1");
    expect(second.text("hello")).toBe(h);
    expect(second.text(big)).toBe(hBig);
    second.text("new");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("packs at the close, off the main thread, under a name that ships", async () => {
    const dir = dirFor();
    const c = captureFor(dir, "x", "r1");
    c.text("one");
    c.text("two");
    let ticks = 0;
    const tick = setInterval(() => ticks++, 1);
    await c.close();
    clearInterval(tick);
    const files = readdirSync(join(dir, "x"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^r1\.obs\.\d+\.jsonl\.zst$/);
    expect(keepRun(`x/${files[0]}`)).toBe(true);
    expect(
      unpack(join(dir, "x", files[0] as string))
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    // a close with nothing written makes no file
    await captureFor(dir, "x", "r2").close();
    expect(readdirSync(join(dir, "x"))).toHaveLength(1);
  });

  it("packs what a dead life left once a day has passed: the text file, or one a pack was cut on", async () => {
    const dir = dirFor();
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const name of ["r1.obs.jsonl", "r2.obs.1793505600000.jsonl", "r3.obs.jsonl"])
      writeFileSync(join(dir, "x", name), '{"h":"0123456789abcdef","text":"t"}\n');
    writeFileSync(join(dir, "x", "r2.obs.1793505600000.jsonl.zst.tmp"), "half");
    for (const name of ["r1.obs.jsonl", "r2.obs.1793505600000.jsonl"])
      utimesSync(join(dir, "x", name), old, old);
    expect(await packStale(dir)).toBe(2);
    const files = readdirSync(join(dir, "x")).sort();
    expect(files).toHaveLength(3);
    expect(files[0]).toMatch(/^r1\.obs\.\d+\.jsonl\.zst$/);
    expect(files[1]).toBe("r2.obs.1793505600000.jsonl.zst");
    expect(files[2]).toBe("r3.obs.jsonl"); // a live run's
    expect(unpack(join(dir, "x", files[1] as string))).toContain("0123456789abcdef");
  });
});
