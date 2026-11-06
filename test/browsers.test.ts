import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  admit,
  BROWSER_WARN_MB,
  DRIVER_WARN_MB,
  HELD_WARN_HOURS,
  IDLE_WARN_MINUTES,
  lockHolder,
  NEW_BROWSER_MB,
  openerOf,
  viewOf,
  warnings,
} from "../src/browser/browsers.js";
import { etimeSeconds } from "../src/browser/reap.js";

const dir = "/home/u/.config/autobrowse/profiles";
const chrome = (pid: number, ppid: number, profile: string, rss = 100_000) => ({
  pid,
  ppid,
  rss,
  age: 60,
  command: `/chrome --user-data-dir=${dir}/${profile} --headless`,
});
const procs = [
  { pid: 100, ppid: 1, command: "node tsx/dist/cli.mjs src/app/desk.ts" },
  { pid: 101, ppid: 100, command: "node --import tsx/loader.mjs src/app/desk.ts" },
  chrome(10, 101, "x@wren"),
  { pid: 11, ppid: 10, rss: 50_000, command: `/chrome --type=renderer --user-data-dir=${dir}/x` },
  { pid: 200, ppid: 1, command: "node dist/app/main.js" },
  chrome(20, 200, "youtube"),
  {
    pid: 300,
    ppid: 1,
    command: "node --import tsx/loader.mjs src/app/cli.ts explore x --port 9090",
  },
  chrome(30, 300, "x"),
  chrome(31, 300, "google"), // an explore process's other browser: a plain CLI one
  chrome(40, 1, "npm"),
  { pid: 500, ppid: 1, command: "/bin/zsh" },
  chrome(50, 500, "langfuse"),
];
const ex9090 = {
  port: 9090,
  pid: 300,
  site: "x",
  driver: "console",
  held: false,
  startedAt: "",
  idleMinutes: 0,
  idleMs: 0,
  mb: 150,
};
const explorers = [ex9090];

describe("who owns a browser", () => {
  it("names the process that launched it", () => {
    const opener = (pid: number, profile: string) => openerOf(pid, profile, procs, explorers);
    expect(opener(10, "x@wren")).toBe("desk");
    expect(opener(20, "youtube")).toBe("worker");
    expect(opener(30, "x")).toBe("explore:9090");
    expect(opener(31, "google")).toBe("cli");
    expect(opener(40, "npm")).toBe("orphan");
    expect(opener(50, "langfuse")).toBe("other");
  });
  it("an agent's or a person's explore server", () => {
    const as = (driver: string) => openerOf(30, "x", procs, [{ ...ex9090, driver }]);
    expect(as("agent:claude")).toBe("agent:9090");
    expect(as("person")).toBe("teach:9090");
  });
  it("in a container the worker is init: its browser is no orphan", () => {
    const boxed = [{ pid: 1, ppid: 0, command: "node dist/app/main.js" }, chrome(7, 1, "x")];
    expect(openerOf(7, "x", boxed, [])).toBe("worker");
  });
  it("reads ps elapsed time", () => {
    expect(etimeSeconds("05:07")).toBe(307);
    expect(etimeSeconds("02:00:01")).toBe(7201);
    expect(etimeSeconds("1-00:00:00")).toBe(86_400);
  });
});

describe("browsers view and warnings", () => {
  const view = (ps = procs, ex = explorers, ram = 16_384, locks = () => null) =>
    viewOf(ps, dir, ex, ram, locks);
  it("sums a browser's tree and lists only roots on our profiles", () => {
    const v = view();
    expect(v.browsers.map((b) => b.pid)).toEqual([10, 20, 30, 31, 40, 50]);
    expect(v.browsers[0]?.mb).toBe(Math.round(150_000 / 1024));
  });
  it("is quiet when nothing is wrong", () => {
    const quiet = procs.filter((p) => p.pid !== 40);
    expect(warnings(view(quiet))).toEqual([]);
  });
  it("names each problem with its fix", () => {
    const hours = HELD_WARN_HOURS + 1;
    const ex = [
      { ...ex9090, idleMinutes: IDLE_WARN_MINUTES },
      {
        ...ex9090,
        port: 9091,
        held: true,
        idleMinutes: 999,
        startedAt: new Date(Date.now() - hours * 3_600_000).toISOString(),
      },
      ...[9092, 9093].map((port) => ({ ...ex9090, port })),
      { ...ex9090, port: 9094, mb: DRIVER_WARN_MB + 1 },
    ];
    const ps = [...procs, chrome(60, 300, "x", (BROWSER_WARN_MB + 1) * 1024)];
    const w = warnings(view(ps, ex, 4096)).join("\n");
    expect(w).toContain("orphan browser on npm (pid 40): autobrowse reap");
    expect(w).toContain("explore 9090 (x) idle 120 min: autobrowse browsers stop 9090");
    expect(w).not.toContain("explore 9091 (x) idle"); // held: never idle-warned
    expect(w).toContain(`explore 9091 (x) held ${hours} h`);
    expect(w).toContain("profile x open twice: pid 30 (explore:9090), pid 60 (explore:9090)");
    expect(w).toContain("x (pid 60, explore:9090) uses 1537 MB");
    expect(w).toMatch(/browsers use \d+ MB, \d+% of RAM/);
    expect(w).toContain("5 explore servers open");
    expect(w).toContain("explore 9094 (x) driver uses 601 MB");
    expect(w).not.toContain("explore 9093 (x) driver");
  });
  it("a lock held by a browser that is none of ours", () => {
    const ps = [...procs, { pid: 77, ppid: 1, command: "/Applications/Google Chrome" }];
    const v = viewOf(ps, "/nonexistent", [], 16_384, () => 77);
    expect(v.strangers).toEqual([]); // no profiles dir: nothing to read
    const locks = (profile: string) => (profile === "a" ? 77 : null);
    const tmp = mkdtempSync(join(tmpdir(), "browsers-"));
    mkdirSync(join(tmp, "a"));
    expect(viewOf(ps, tmp, [], 16_384, locks).strangers).toEqual([{ profile: "a", pid: 77 }]);
    rmSync(tmp, { recursive: true });
  });
});

describe("profile lock", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lock-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it("names a live pid on this host; a dead one or another host's is free", () => {
    const at = (name: string, target: string) => {
      mkdirSync(join(tmp, name));
      symlinkSync(target, join(tmp, name, "SingletonLock"));
      return join(tmp, name);
    };
    expect(lockHolder(at("live", `${hostname()}-4242`), (pid) => pid === 4242)).toBe(4242);
    expect(lockHolder(at("dead", `${hostname()}-4243`), () => false)).toBeNull();
    expect(lockHolder(at("box", "other-host-4242"), () => true)).toBeNull();
    expect(lockHolder(join(tmp, "none"), () => true)).toBeNull();
  });
});

describe("admit: one more explore browser, by memory", () => {
  const row = (mb: number, port: number) => ({
    pid: port,
    opener: `explore:${port}`,
    profile: "x",
    age: 60,
    mb,
  });
  const view = (mbs: number[], ramMb: number) => ({
    browsers: mbs.map((mb, i) => row(mb, 9090 + i)),
    explorers: [],
    strangers: [],
    totalMb: mbs.reduce((s, n) => s + n, 0),
    ramMb,
  });

  const ok = { level: "ok", freePct: 60 } as const;
  const tight = { level: "tight", freePct: 32 } as const;
  const critical = { level: "critical", freePct: 4 } as const;

  it("opens the first browser even at the critical level", () => {
    expect(admit(view([], 16_384), critical)).toBeNull();
  });
  it("past our share of RAM is a warning, scaled to the machine; the browser opens", () => {
    const held = [2000, 2000, 2000, 1500];
    const warn = admit(view(held, 16_384), ok);
    expect(warn?.stop).toBe(false);
    expect(warn?.text).toMatch(/^warning: memory is tight: 4 browsers of ours hold 7500 MB/);
    expect(warn?.text).toContain("Opening anyway.");
    expect(admit(view(held, 65_536), ok)).toBeNull();
    expect(admit(view([8192 - NEW_BROWSER_MB], 16_384), ok)).toBeNull();
  });
  it("OS pressure is a warning that says what is free and who holds what; no --force needed", () => {
    const warn = admit(view([300, 900], 65_536), tight);
    expect(warn?.stop).toBe(false);
    expect(warn?.text).toMatch(/the OS reports memory pressure\)\. 32% of RAM is free\./);
    // Largest first, each with its opener.
    expect(warn?.text).toMatch(/explore:9091 x: 900 MB\n {2}explore:9090 x: 300 MB/);
    expect(warn?.text).not.toContain("--force");
  });
  it("stops only at the critical level, and names the way out", () => {
    const no = admit(view([300], 65_536), critical);
    expect(no?.stop).toBe(true);
    expect(no?.text).toMatch(/^memory is critical.*critical memory pressure.*Not opened\./);
    expect(no?.text).toMatch(/autobrowse stop <port>/);
    expect(no?.text).toContain("`--force` opens anyway");
  });
});
