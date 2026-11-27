import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { holderPid, viewOf, warnings } from "../src/browser/browsers.js";
import {
  EngineMissing,
  launchTarget,
  onChromeFolder,
  profileDirOf,
  refusalOf,
  type SessionNeeds,
  TestingMissing,
  testingBinary,
  testingBinaryIn,
} from "../src/browser/engines.js";
import { treeOf } from "../src/browser/memory-guard.js";
import { orphanBrowsers, type Proc, profileFolderOf, profileRoots } from "../src/browser/reap.js";

const P = "/Users/u/.config/autobrowse/profiles";
const CFT =
  "/Users/u/.cache/autobrowse/chrome-for-testing/158.0.8127.88/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PW = "/Users/u/Library/Caches/ms-playwright";
const FF = `${PW}/firefox-1543/firefox/Nightly.app/Contents/MacOS`;
const WK = `${PW}/webkit-2359`;
const OPERA = "/Applications/Opera GX.app/Contents/MacOS/Opera";

// ps lines from real runs (scratchpad engines/ps.mjs, 11-26), home shortened
const firefox = (pid: number, ppid: number, dir: string): Proc[] => [
  {
    pid,
    ppid,
    command: `${FF}/firefox -no-remote -headless -profile ${dir} -juggler-pipe about:blank`,
  },
  {
    pid: pid + 1,
    ppid: pid,
    command: `${FF}/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -prefsHandle 0:28011 -sbStartup`,
  },
];
const webkit = (pid: number, ppid: number, dir: string): Proc[] => [
  {
    pid,
    ppid,
    command: `bash ${WK}/pw_run.sh --inspector-pipe --headless --user-data-dir=${dir} about:blank`,
  },
  {
    pid: pid + 1,
    ppid: pid,
    command: `${WK}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless --user-data-dir=${dir} about:blank`,
  },
];
const xpc = (pid: number, name: string): Proc => ({
  pid,
  ppid: 1,
  command: `${WK}/com.apple.WebKit.${name}.xpc/Contents/MacOS/com.apple.WebKit.${name}.Development`,
});
const opera = (pid: number, ppid: number, dir: string): Proc[] => [
  { pid, ppid, command: `${OPERA} --no-first-run --user-data-dir=${dir} --remote-debugging-pipe` },
  { pid: pid + 1, ppid: pid, command: `${OPERA} Helper --type=renderer --user-data-dir=${dir}` },
];
const chrome = (pid: number, ppid: number, dir: string): Proc => ({
  pid,
  ppid,
  command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --no-first-run`,
});

describe("profileFolderOf", () => {
  it("ends the folder at a trailing URL", () => {
    expect(profileFolderOf(`chrome --user-data-dir=${P}/x@wren https://x.com/home`)).toBe(
      `${P}/x@wren`,
    );
    expect(profileFolderOf(webkit(1, 1, `${P}/w`)[1]?.command ?? "")).toBe(`${P}/w`);
  });
  it("reads Firefox's -profile", () => {
    expect(profileFolderOf(firefox(1, 1, `${P}/.engines/firefox/a b`)[0]?.command ?? "")).toBe(
      `${P}/.engines/firefox/a b`,
    );
  });
  it("skips a helper and Chrome's --profile-directory", () => {
    expect(profileFolderOf(opera(1, 1, `${P}/o`)[1]?.command ?? "")).toBeNull();
    expect(profileFolderOf("chrome --profile-directory=Default")).toBeNull();
    expect(profileFolderOf(firefox(1, 1, "/x")[1]?.command ?? "")).toBeNull();
  });
});

describe("profileRoots", () => {
  const dir = `${P}/.engines/webkit/w`;
  it("keeps the innermost of WebKit's wrapper chain, its top's parent as outerPpid", () => {
    const roots = profileRoots([
      { pid: 500, ppid: 1, command: "node app/cli.js" },
      ...webkit(10, 500, dir),
    ]);
    expect(roots).toEqual([expect.objectContaining({ pid: 11, dir, outerPpid: 500 })]);
  });
  it("calls the app an orphan only when the wrapper went to init", () => {
    expect(orphanBrowsers(webkit(10, 1, dir), P, 999)).toEqual([{ pid: 11, profile: "w" }]);
    const owned = [{ pid: 500, ppid: 1, command: "node app/cli.js" }, ...webkit(10, 500, dir)];
    expect(orphanBrowsers(owned, P, 999)).toEqual([]);
  });
});

describe("treeOf", () => {
  it("counts WebKit's XPC services, which launchd owns", () => {
    const dir = `${P}/.engines/webkit/w`;
    const procs = [
      ...webkit(10, 500, dir),
      xpc(20, "Networking"),
      xpc(21, "WebContent"),
      xpc(22, "GPU"),
    ];
    expect(treeOf(procs, dir)).toEqual([11, 20, 21, 22]);
  });
  it("counts Firefox's content processes under its root", () => {
    expect(treeOf(firefox(30, 500, `${P}/.engines/firefox/f`), `${P}/.engines/firefox/f/`)).toEqual(
      [30, 31],
    );
  });
});

describe("holderPid", () => {
  const od = `${P}/.engines/opera-gx/o`;
  it("takes Opera GX's SingletonLock pid: a browser that is no Chrome", () => {
    expect(holderPid(opera(40, 500, od), od, () => 40)).toBe(40);
  });
  it("finds a Firefox by its profile flag: Firefox writes no SingletonLock", () => {
    const fd = `${P}/.engines/firefox/f`;
    expect(holderPid(firefox(30, 500, fd), fd, () => null)).toBe(30);
    expect(holderPid(firefox(30, 500, fd), `${P}/.engines/firefox/other`, () => null)).toBeNull();
  });
  it("a Chromium folder with no lock is free, even while its closing Chrome still runs", () => {
    const cd = `${P}/scratch`;
    expect(holderPid(opera(40, 500, cd), cd, () => null)).toBeNull();
    expect(holderPid(opera(40, 500, od), od, () => null)).toBeNull();
  });
  it("skips a stale lock whose pid now runs something else", () => {
    expect(holderPid([{ pid: 7, ppid: 1, command: "vim notes.md" }], od, () => 7)).toBeNull();
  });
});

describe("viewOf on engines", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engines-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const cli = { pid: 500, ppid: 1, command: "node app/cli.js site call x GET /me" };

  it("tells one profile in Chrome and in Firefox apart: no 'open twice'", () => {
    const procs = [
      cli,
      chrome(50, 500, `${tmp}/x@wren`),
      ...firefox(60, 500, `${tmp}/.engines/firefox/x@wren`),
    ];
    const v = viewOf(procs, tmp, [], 16_384, () => null);
    expect(v.browsers.map((b) => [b.pid, b.profile, b.engine])).toEqual([
      [50, "x@wren", undefined],
      [60, "x@wren", "firefox"],
    ]);
    expect(warnings(v).filter((w) => w.includes("open twice"))).toEqual([]);
  });

  it("still warns on one engine folder open twice", () => {
    const fd = `${tmp}/.engines/firefox/x@wren`;
    const v = viewOf(
      [cli, ...firefox(60, 500, fd), ...firefox(70, 500, fd)],
      tmp,
      [],
      16_384,
      () => null,
    );
    expect(warnings(v)).toContain(
      "profile x@wren (firefox) open twice: pid 60 (cli), pid 70 (cli); stop one",
    );
  });

  it("finds a stranger under .engines", () => {
    mkdirSync(join(tmp, ".engines", "opera-gx", "o"), { recursive: true });
    const procs = opera(80, 1234, "/elsewhere");
    const v = viewOf(procs, tmp, [], 16_384, (f) =>
      f === join(".engines", "opera-gx", "o") ? 80 : null,
    );
    expect(v.strangers).toEqual([{ profile: "o (opera-gx)", pid: 80 }]);
  });
});

describe("engine rows", () => {
  it("keeps chrome and chromium on the base folder; any other engine its own", () => {
    expect(profileDirOf(P, "x", "chrome")).toBe(`${P}/x`);
    expect(profileDirOf(P, "x", "chromium")).toBe(`${P}/x`);
    expect(profileDirOf(P, "x", "brave")).toBe(`${P}/.engines/brave/x`);
    expect(profileDirOf(P, "x", "ios")).toBe(`${P}/.engines/ios/x`);
    expect(
      ["chrome", "chromium", "edge", "firefox"].map((e) => onChromeFolder(e as "chrome")),
    ).toEqual([true, true, false, false]);
  });

  it("finds each build: a channel, an app binary or Playwright's own", () => {
    const mac = { platform: "darwin" as const, exists: () => false };
    expect(launchTarget("chrome", { ...mac, build: "stable" })).toEqual({ channel: "chrome" });
    expect(launchTarget("chrome", { platform: "linux", testing: () => CFT })).toEqual({
      channel: "chrome",
    });
    expect(launchTarget("edge", mac)).toEqual({ channel: "msedge" });
    expect(launchTarget("chromium")).toEqual({});
    expect(launchTarget("firefox")).toEqual({});
    expect(launchTarget("ios")).toEqual({});
    expect(launchTarget("opera-gx", { platform: "darwin", exists: (p) => p === OPERA })).toEqual({
      executablePath: OPERA,
    });
  });

  it("refuses a brand that is not installed", () => {
    const miss = (() => {
      try {
        launchTarget("opera-gx", { platform: "linux", exists: () => true });
      } catch (e) {
        return e;
      }
    })();
    expect(miss).toBeInstanceOf(EngineMissing);
    expect(miss).toMatchObject({
      engine: "opera-gx",
      message: expect.stringContaining("Opera GX is not installed"),
    });
    expect(() => launchTarget("brave", { platform: "darwin", exists: () => false })).toThrow(
      EngineMissing,
    );
  });

  it("runs Chrome for Testing for chrome on a Mac; a missing one stops loud", () => {
    expect(launchTarget("chrome", { platform: "darwin", testing: () => CFT })).toEqual({
      executablePath: CFT,
    });
    // never a quiet Google Chrome.app, even when it is installed
    expect(() =>
      launchTarget("chrome", { platform: "darwin", exists: () => true, testing: () => null }),
    ).toThrow(TestingMissing);
    expect(() => launchTarget("chrome", { platform: "darwin", testing: () => null })).toThrow(
      /browsers update-chrome/,
    );
  });

  it("picks the newest installed CfT version with its app", () => {
    const dir = mkdtempSync(join(tmpdir(), "cft-"));
    try {
      for (const v of ["158.0.8127.88", "158.0.8127.9", "159.0.1.2", "notes"])
        mkdirSync(join(dir, v));
      const has = new Set(
        ["158.0.8127.88", "158.0.8127.9"].map((v) => testingBinaryIn(join(dir, v))),
      );
      // 159 has no app (a half-made folder): skipped; 88 beats 9 by number
      expect(testingBinary(dir, (p) => has.has(p))).toBe(
        testingBinaryIn(join(dir, "158.0.8127.88")),
      );
      expect(testingBinary(join(dir, "none"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refusalOf", () => {
  const ok: SessionNeeds = {
    tier: "local",
    window: false,
    film: false,
    proxied: false,
    passkeys: 0,
    platform: "darwin",
  };
  const why = (e: Parameters<typeof refusalOf>[0], n: Partial<SessionNeeds>) =>
    refusalOf(e, { ...ok, ...n });

  it("never refuses a Chromium engine", () => {
    const all = {
      tier: "browserbase",
      window: true,
      film: true,
      proxied: true,
      passkeys: 2,
      fenced: "block",
    } as const;
    for (const e of ["chrome", "chromium", "edge", "brave", "opera-gx"] as const)
      expect(why(e, all)).toBeNull();
  });
  it("opens a plain live-view session on Firefox, WebKit and iOS", () => {
    for (const e of ["firefox", "webkit", "ios"] as const) expect(why(e, {})).toBeNull();
  });
  it("refuses each guard Firefox and WebKit lack, one line each", () => {
    expect(why("firefox", { tier: "cdp" })).toMatch(/BROWSER=cdp drives Chromium only/);
    expect(why("firefox", { fenced: "block" })).toMatch(
      /cannot hold every redirect hop outside Chromium/,
    );
    expect(why("webkit", { film: true })).toMatch(/a film needs Chromium/);
    expect(why("firefox", { window: true })).toMatch(/no focus guard/);
    expect(why("webkit", { proxied: true })).toMatch(/WebKit cannot keep WebRTC on the proxy/);
    expect(why("ios", { proxied: true })).toMatch(/WebRTC/);
    expect(why("firefox", { passkeys: 1 })).toMatch(/virtual authenticator/);
  });
  it("lets what a family can do through", () => {
    expect(why("firefox", { proxied: true })).toBeNull();
    expect(why("webkit", { fenced: "blank" })).toBeNull();
    expect(why("webkit", { window: true, platform: "linux" })).toBeNull();
  });
  it("names the remote tier before any other guard", () => {
    expect(why("webkit", { tier: "browserbase", fenced: "block", film: true })).toMatch(
      /BROWSER=browserbase/,
    );
  });
});
