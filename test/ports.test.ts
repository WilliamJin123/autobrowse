import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS, no types
import { minePort as fastMine } from "../bin/explore-cmd.mjs";
import {
  anyPort,
  CLAIM_ENV,
  claimedByOther,
  claimFile,
  claimHolder,
  claimPort,
  portFree,
  releasePort,
} from "../src/share/ports.js";

const fresh = () => mkdtempSync(join(tmpdir(), "ports-"));
const free = async () => true;
const alive = (pid: number) => pid !== 999_999;

describe("claimPort", () => {
  it("takes the first unclaimed port and writes its pid", async () => {
    const dir = fresh();
    const a = await claimPort({ dir, from: 9090, pid: 11, free, alive });
    const b = await claimPort({ dir, from: 9090, pid: 12, free, alive });
    expect([a, b]).toEqual([9090, 9091]);
    expect(readFileSync(claimFile(9090, dir), "utf8")).toBe("11");
    expect(claimHolder(9091, dir, alive)).toBe(12);
  });

  it("takes over a dead claimer's port", async () => {
    const dir = fresh();
    writeFileSync(claimFile(9090, dir), "999999");
    expect(await claimPort({ dir, from: 9090, pid: 11, free, alive })).toBe(9090);
    expect(claimHolder(9090, dir, alive)).toBe(11);
  });

  it("passes over skipped and busy ports, and drops the busy port's claim", async () => {
    const dir = fresh();
    const port = await claimPort({
      dir,
      from: 9090,
      pid: 11,
      skip: (p) => p === 9090,
      free: async (p) => p !== 9091,
      alive,
    });
    expect(port).toBe(9092);
    expect(existsSync(claimFile(9091, dir))).toBe(false);
  });

  it("lets one taker at a time take over a dead claim", async () => {
    const dir = fresh();
    writeFileSync(claimFile(9090, dir), "999999");
    mkdirSync(`${claimFile(9090, dir)}.lock`); // another taker is mid-takeover
    expect(await claimPort({ dir, from: 9090, pid: 11, free, alive })).toBe(9091);
    expect(readFileSync(claimFile(9090, dir), "utf8")).toBe("999999");
  });

  it("refuses a hand-named port another starter claimed, but not to the claimer's child", async () => {
    const dir = fresh();
    writeFileSync(claimFile(9090, dir), "4242");
    expect(claimedByOther(9090, dir, () => true)).toBe(4242);
    process.env[CLAIM_ENV] = "4242";
    try {
      expect(claimedByOther(9090, dir, () => true)).toBeNull();
    } finally {
      delete process.env[CLAIM_ENV];
    }
    expect(claimedByOther(9090, dir, () => false)).toBeNull();
  });

  it("frees a port on release", async () => {
    const dir = fresh();
    await claimPort({ dir, from: 9090, pid: 11, free, alive });
    releasePort(9090, dir);
    expect(await claimPort({ dir, from: 9090, pid: 12, free, alive })).toBe(9090);
  });

  it("sees a port someone listens on", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    expect(await portFree(port)).toBe(false);
    expect(await claimPort({ dir: fresh(), from: port, alive })).not.toBe(port);
    await new Promise((r) => s.close(r));
    expect(await portFree(port)).toBe(true);
    expect(await anyPort()).toBeGreaterThan(0);
  });
});

describe("cmd with no port (bin/explore-cmd.mjs)", () => {
  const info = (dir: string, port: number, session?: string, pid = process.pid) =>
    writeFileSync(
      join(dir, `explore-${port}.json`),
      JSON.stringify({ port, pid, site: `s${port}`, ...(session ? { session } : {}) }),
    );

  it("goes to the caller's one session", () => {
    const dir = fresh();
    info(dir, 9091, "me");
    info(dir, 9092, "other");
    info(dir, 9093, "me", 999_999);
    expect(fastMine("me", dir, alive)).toBe(9091);
    expect(() => fastMine("nobody", dir, alive)).toThrow(/no explore session/);
    expect(() => fastMine("", dir, alive)).toThrow(/--port 9092/);
  });
});
