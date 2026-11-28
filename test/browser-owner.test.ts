import { describe, expect, it } from "vitest";
import { ProfileBusy, profileBusyOf } from "../src/browser/browsers.js";
import { jobArgs, jobOfCommand, jobOfEnv, jobsOf, jobsOfEnvLines } from "../src/browser/owner.js";

describe("browser owner", () => {
  it("reads the job from the env: AUTOBROWSE_OWNER, then a launchd label", () => {
    expect(jobOfEnv({ AUTOBROWSE_OWNER: "job:capture/7", XPC_SERVICE_NAME: "com.x" })).toBe(
      "job:capture/7",
    );
    expect(jobOfEnv({ XPC_SERVICE_NAME: "com.wrenautomation.desk" })).toBe(
      "com.wrenautomation.desk",
    );
    expect(jobOfEnv({ XPC_SERVICE_NAME: "0" })).toBeNull();
    expect(jobOfEnv({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" })).toBeNull();
    expect(jobOfEnv({})).toBeNull();
    expect(jobArgs({ AUTOBROWSE_OWNER: "job:a b" })).toEqual(["--autobrowse-job=job:a_b"]);
    expect(jobArgs({})).toEqual([]);
  });
  it("reads the flag from a command line", () => {
    expect(jobOfCommand("/chrome --user-data-dir=/p/x --autobrowse-job=com.y --x")).toBe("com.y");
    expect(jobOfCommand("/chrome --user-data-dir=/p/x")).toBeNull();
  });
  it("reads ps eww lines: the env after the command wins", () => {
    const out = [
      "  12 node mail.mjs XPC_SERVICE_NAME=0 HOME=/u",
      "  13 node run.mjs --x XPC_SERVICE_NAME=com.a AUTOBROWSE_OWNER=job:c/1",
      "  14 /bin/zsh XPC_SERVICE_NAME=com.b",
      "  15 node x.js XPC_SERVICE_NAME=application.foo",
    ].join("\n");
    expect([...jobsOfEnvLines(out)]).toEqual([
      [13, "job:c/1"],
      [14, "com.b"],
    ]);
  });
  it("names a browser's job by its flag, else its nearest launcher's env", async () => {
    const procs = [
      { pid: 2, ppid: 1, command: "launchd-ish" },
      { pid: 5, ppid: 2, command: "node a.mjs" },
      { pid: 6, ppid: 5, command: "node b.mjs" },
      { pid: 9, ppid: 6, command: "/chrome --user-data-dir=/p/x" },
      { pid: 10, ppid: 1, command: "/chrome --user-data-dir=/p/y --autobrowse-job=com.f" },
      { pid: 11, ppid: 1, command: "/chrome --user-data-dir=/p/z" },
    ];
    const asked: number[][] = [];
    const jobs = await jobsOf([9, 10, 11], procs, async (pids) => {
      asked.push(pids);
      return new Map([[5, "com.l"]]);
    });
    expect([...jobs]).toEqual([
      [10, "com.f"],
      [9, "com.l"],
    ]);
    expect(asked).toEqual([[6, 5, 2]]);
  });
  it("puts the job in ProfileBusy and reads it back from the words", () => {
    const e = new ProfileBusy("x", 9, "other", "/p", { ageS: 60, job: "com.l" });
    expect(e.message).toBe("profile x is open in pid 9 (other), for 60s; job com.l");
    const back = profileBusyOf(new Error(`wrapped: ${e.message}`));
    expect([back?.opener, back?.job]).toEqual(["other", "com.l"]);
    expect(profileBusyOf(new Error("profile x is open in pid 9 (cli): a"))?.job).toBeUndefined();
  });
});
