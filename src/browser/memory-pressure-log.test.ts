import { describe, expect, it } from "vitest";
import { appOf, pressureRow, topRows } from "./memory-pressure-log.js";
import type { Proc } from "./reap.js";

const TOP = `Processes: 568 total
PhysMem: 15G used (3218M wired, 5052M compressor), 126M unused.

PID    PPID  MEM   CMPRS COMMAND
9730   1     2053M 3124M com.apple.Virtua
86747  824   1264M 366M  2.1.318
39686  39664 1.5G  161M  Google Chrome He
39664  1     118M  20K   Google Chrome
52252  52250 267M  0B    node
`;

const procs: Proc[] = [
  { pid: 9730, ppid: 1, command: "/System/Library/Frameworks/Virtualization.framework/x" },
  { pid: 86747, ppid: 824, command: "/Users/u/.local/share/claude/versions/2.1.318 --resume" },
  {
    pid: 39664,
    ppid: 1,
    command:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=/u/.config/autobrowse/profiles/x@wren --remote-debugging-pipe",
  },
  {
    pid: 39686,
    ppid: 39664,
    command: "/Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer",
  },
  { pid: 52252, ppid: 52250, command: "node /u/autobrowse/src/app/desk.ts" },
];
const byPid = new Map(procs.map((p) => [p.pid, p]));

describe("memory pressure log", () => {
  it("reads top's MEM and compressed columns in MB", () => {
    expect(topRows(TOP)).toEqual([
      { pid: 9730, mb: 2053, compressedMb: 3124 },
      { pid: 86747, mb: 1264, compressedMb: 366 },
      { pid: 39686, mb: 1536, compressedMb: 161 },
      { pid: 39664, mb: 118, compressedMb: 0 },
      { pid: 52252, mb: 267, compressedMb: 0 },
    ]);
  });

  it("names a Chrome helper by its root's profile", () => {
    expect(appOf(39686, byPid)).toBe("chrome x@wren");
    expect(appOf(86747, byPid)).toBe("claude");
    expect(appOf(52252, byPid)).toBe("node app/desk.ts");
    expect(appOf(1, byPid)).toBe("?");
  });

  it("sums each app, largest first", () => {
    const r = pressureRow(TOP, procs, { level: "tight", freePct: 30 }, 4800);
    expect(r.apps[0]).toEqual({ app: "x", mb: 2053, procs: 1 });
    expect(r.apps.find((a) => a.app === "chrome x@wren")).toEqual({
      app: "chrome x@wren",
      mb: 1654,
      procs: 2,
    });
    expect(r.top[0]?.pid).toBe(9730);
    expect(r.swapUsedMb).toBe(4800);
  });
});
