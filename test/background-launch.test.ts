import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleOf,
  OWNER_FLAG,
  relayArgs,
  relayShim,
  takeFrames,
} from "../src/browser/background-launch.js";

describe("background launch relay", () => {
  it("turns Playwright's pipe launch into a port launch with no startup window, owned by the relay", () => {
    const pw = [
      "--disable-field-trial-config",
      "--user-data-dir=/p/x",
      "--remote-debugging-pipe",
      "--window-size=1512,886",
      "about:blank",
    ];
    expect(relayArgs(pw, 77)).toEqual([
      "--disable-field-trial-config",
      "--user-data-dir=/p/x",
      "--window-size=1512,886",
      "--remote-debugging-port=0",
      "--no-startup-window",
      `${OWNER_FLAG}=77`,
    ]);
    // a second pass changes nothing but the owner
    expect(relayArgs(relayArgs(pw, 77), 78).filter((a) => a.startsWith(OWNER_FLAG))).toEqual([
      `${OWNER_FLAG}=78`,
    ]);
  });

  it("finds the .app that holds the binary", () => {
    expect(bundleOf("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe(
      "/Applications/Google Chrome.app",
    );
    expect(bundleOf("/usr/bin/chromium")).toBeNull();
  });

  it("splits the pipe on NUL and keeps a message cut between chunks", () => {
    const a = takeFrames(Buffer.alloc(0), Buffer.from('{"id":1}\0{"id":2,"x":"é'));
    expect(a.done).toEqual(['{"id":1}']);
    const cut = Buffer.from('"}\0');
    // the é split across chunks decodes whole
    const b = takeFrames(a.rest, cut);
    expect(b.done).toEqual(['{"id":2,"x":"é"}']);
    expect(b.rest.length).toBe(0);
  });

  it("writes one executable shim that execs node on this module with the args file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-shim-"));
    try {
      const path = relayShim(dir);
      expect(relayShim(dir)).toBe(path);
      expect(statSync(path).mode & 0o111).toBe(0o111);
      const body = readFileSync(path, "utf8");
      expect(body.startsWith("#!/bin/sh\n")).toBe(true);
      expect(body).toContain(`printf '%s\\0' "$@" > "$f"`);
      expect(body).toMatch(/exec '[^']+node[^']*' .*'[^']+background-launch\.(ts|js)' "\$f"\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
