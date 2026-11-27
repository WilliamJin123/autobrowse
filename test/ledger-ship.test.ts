import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shipLedgers } from "../src/runs/ledger-ship.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-ship-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (kind: string, name: string, body: string) => {
  mkdirSync(join(dir, kind), { recursive: true });
  writeFileSync(join(dir, kind, name), body);
};

describe("shipLedgers", () => {
  it("ships each month file gzipped, again only after it grew; skips bodies and odd names", async () => {
    file("calls", "calls-2026-11.jsonl", '{"a":1}\n');
    file("calls", "notes.txt", "x");
    mkdirSync(join(dir, "calls", "bodies"));
    file("engine", "engine-2026-10.jsonl", '{"b":1}\n');
    const got = new Map<string, string>();
    const put = async (k: string, b: Buffer) => void got.set(k, gunzipSync(b).toString());
    const sent = new Map<string, number>();

    expect(await shipLedgers({ dir, put, sent })).toEqual([
      "calls/calls-2026-11.jsonl",
      "engine/engine-2026-10.jsonl",
    ]);
    expect([...got.keys()]).toEqual([
      "ledgers/calls/calls-2026-11.jsonl.gz",
      "ledgers/engine/engine-2026-10.jsonl.gz",
    ]);
    expect(await shipLedgers({ dir, put, sent })).toEqual([]);

    appendFileSync(join(dir, "calls", "calls-2026-11.jsonl"), '{"a":2}\n');
    expect(await shipLedgers({ dir, put, sent })).toEqual(["calls/calls-2026-11.jsonl"]);
    expect(got.get("ledgers/calls/calls-2026-11.jsonl.gz")).toBe('{"a":1}\n{"a":2}\n');
  });

  it("keeps a failed file unsent, so the next run tries it again", async () => {
    file("flows", "flows-2026-11.jsonl", "{}\n");
    const sent = new Map<string, number>();
    const fail = async () => {
      throw new Error("offline");
    };
    await expect(shipLedgers({ dir, put: fail, sent })).rejects.toThrow("offline");
    expect(await shipLedgers({ dir, put: async () => {}, sent })).toEqual([
      "flows/flows-2026-11.jsonl",
    ]);
  });
});
