import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile, writeRendered } from "../src/compiler/index.js";
import { lintOutline } from "../src/compiler/lint.js";
import { render } from "../src/compiler/render.js";
import { structure } from "../src/compiler/structure.js";
import { type AdRun, agentDesktop, DesktopError, flatten } from "../src/desktop/agent-desktop.js";
import { describeOp } from "../src/desktop/describe.js";
import { desktopHands } from "../src/desktop/hands.js";
import {
  macBase,
  ROOT_HELPER,
  rootHelper,
  rootSetupCommands,
  sudoersLine,
} from "../src/desktop/mac.js";
import {
  type DesktopOp,
  desktopActSchema,
  desktopOpSchema,
  fakeDesktop,
  fakeWindow,
  noDesktop,
  snapText,
} from "../src/desktop/types.js";
import type { Recording } from "../src/recorder/types.js";

const FIX = join(import.meta.dirname, "fixtures", "agent-desktop");
const fixture = (name: string) => readFileSync(join(FIX, `${name}.json`), "utf8");

/** agent-desktop as recorded on Calculator (11-16): answers by the command, keeps every call. */
function scripted(answers: Record<string, string> = {}) {
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  const run: AdRun = async (args, stdin) => {
    calls.push({ args, stdin });
    const name = answers[args[0] ?? ""] ?? args[0] ?? "";
    return { code: 0, stdout: `${fixture(name).replace(/\n\s*/g, "")}\n`, stderr: "" };
  };
  const base = {
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    screenshot: async () => undefined,
    exists: async () => false,
    rootReady: async () => false,
  };
  return { d: agentDesktop(base, { run }), calls };
}

describe("agent-desktop adapter", () => {
  it("lists windows and flattens a snapshot into rows with refs, native ids and bounds", async () => {
    const { d, calls } = scripted();
    const [w] = await d.windows("Calculator");
    expect(w).toMatchObject({ id: "w-233741", app: "Calculator", pid: 89010, focused: false });
    expect(calls[0]?.args).toEqual(["list-windows", "--app", "Calculator"]);
    const snap = await d.snapshot("w-233741");
    expect(snap.id).toBe("s9pv385und5c");
    const edit = snap.nodes.find((n) => n.name === "Edit field");
    expect(edit).toMatchObject({ role: "scrollarea", nativeId: "StandardInputView" });
    expect(edit?.ref).toMatch(/^@s9pv385und5c:e\d+$/);
    expect(edit?.bounds).toEqual({ x: 316, y: 542, w: 210, h: 42 });
    expect(snapText(snap.nodes)).toContain('button "7"');
  });

  it("finds by role and exact name, types by stdin, and goes headed only when asked", async () => {
    const { d, calls } = scripted({ find: "find-one", type: "click", press: "press" });
    expect(await d.find("w-1", { role: "button", name: "7" })).toEqual(["@s5su4b6s0c747:e1"]);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["--role", "button", "--name", "7", "--exact"]),
    );
    await d.type("@s1:e1", "hunter2 secret");
    await d.type("@s1:e1", "x", "headed");
    expect(calls[1]?.args).toEqual(["type", "@s1:e1", "--stdin"]);
    expect(calls[1]?.stdin).toBe("hunter2 secret");
    expect(calls[1]?.args.join(" ")).not.toContain("hunter2");
    expect(calls[2]?.args).toEqual([
      "type",
      "@s1:e1",
      "--stdin",
      "--interval-ms",
      "40",
      "--headed",
    ]);
  });

  it("turns an error envelope into a DesktopError that says whether input was sent", async () => {
    const { d } = scripted({ click: "policy-denied", snapshot: "window-not-found" });
    const e = await d.click("@s1:e1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DesktopError);
    expect(e).toMatchObject({ code: "POLICY_DENIED", notDelivered: true });
    await expect(d.snapshot("w-999999")).rejects.toThrow(/WINDOW_NOT_FOUND/);
  });

  it("a launch whose window has no size yet answers no window", async () => {
    const { d, calls } = scripted();
    const r = await d.launch("Calculator", { fresh: true, args: ["-x"] });
    expect(r).toEqual({ pid: 89010, window: null });
    expect(calls[0]?.args).toEqual([
      "launch",
      "Calculator",
      "--no-attach",
      "--arg=-x",
      "--activate",
    ]);
  });

  it("a line that is not an envelope is an error, not a silent success", async () => {
    const d = agentDesktop(
      {
        shell: async () => ({ code: 0, stdout: "", stderr: "" }),
        screenshot: async () => undefined,
        exists: async () => false,
        rootReady: async () => false,
      },
      { run: async () => ({ code: 1, stdout: "", stderr: "dyld: crashed" }) },
    );
    await expect(d.windows()).rejects.toThrow(/NO_ENVELOPE: dyld: crashed/);
  });

  it("drops unnamed containers but keeps their depth", () => {
    const rows = flatten({
      role: "window",
      name: "W",
      children: [{ role: "group", children: [{ role: "button", name: "OK", ref_id: "@s:e1" }] }],
    });
    expect(rows.map((r) => [r.role, r.depth])).toEqual([
      ["window", 0],
      ["button", 1],
    ]);
  });
});

describe("mac base", () => {
  it("runs root commands only through the audited helper", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const b = macBase(async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: "", stderr: "" };
    });
    await b.shell("ls /", false);
    await b.shell("launchctl list", true);
    expect(calls[0]).toEqual({ file: "/bin/sh", args: ["-c", "ls /"] });
    expect(calls[1]).toEqual({ file: "sudo", args: ["-n", ROOT_HELPER, "launchctl list"] });
    expect(sudoersLine("william")).toBe(`william ALL=(root) NOPASSWD: ${ROOT_HELPER}`);
    expect(rootHelper()).toContain('exec /bin/sh -c "$1"');
    expect(rootSetupCommands("william", "/tmp/h").join("\n")).toContain(
      "/etc/sudoers.d/autobrowse",
    );
  });

  it("a host without a desktop says so", async () => {
    await expect(noDesktop().windows()).rejects.toThrow(/no desktop/);
    expect(await noDesktop().permissions()).toEqual({ accessibility: false, root: false });
  });
});

const calc = () =>
  fakeWindow("w-1", "Calculator", "Calculator", [
    ["button", "7"],
    ["button", "Add"],
    ["button", "Add"],
    ["text", "Result 0"],
  ]);
const term = (extra = {}) => fakeWindow("w-2", "Ghostty", "~ zsh", [["textfield", ""]], extra);
/** A clock the hands' sleeps move, so waits run at once. */
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

describe("desktop hands: record", () => {
  it("acts by the refs of the newest snapshot and journals a target, never a ref", async () => {
    const d = fakeDesktop([calc()]);
    const h = desktopHands(d, clock());
    const snap = await h.act({ op: "snapshot", window: "w-1" });
    expect(snap.answer.tree).toContain('button "7" @s1:e1');
    const r = await h.act({ op: "click", ref: "@s1:e1" });
    expect(r.op).toEqual({
      op: "click",
      window: { app: "Calculator", title: "Calculator" },
      control: { role: "button", name: "7" },
    });
    expect(r.box).toEqual({ x: 10, y: 10, w: 100, h: 24 });
    await h.act({ op: "snapshot", window: { app: "Calculator", title: "Calc" } });
    await expect(h.act({ op: "click", ref: "@s1:e1" })).rejects.toThrow(/unknown or stale ref/);
    await expect(h.act({ op: "click", ref: "@zz:e1" })).rejects.toThrow(/unknown or stale ref/);
  });

  it("refuses a ref a replay could not tell apart, or find at all", async () => {
    const d = fakeDesktop([
      fakeWindow("w-1", "Calculator", "Calculator", [
        ["button", "Add"],
        ["button", "Add"],
        ["button", ""],
      ]),
    ]);
    const h = desktopHands(d, clock());
    await h.act({ op: "snapshot", window: "w-1" });
    await expect(h.act({ op: "click", ref: "@s1:e1" })).rejects.toThrow(/2 controls match/);
    await expect(h.act({ op: "click", ref: "@s1:e3" })).rejects.toThrow(/no name and no id/);
    expect(d.calls).toEqual([]);
  });

  it("types a secret by name: the value goes to the engine, the journal keeps the name", async () => {
    const d = fakeDesktop([term()]);
    const h = desktopHands(d, {
      ...clock(),
      secret: async (n) => (n === "profile.phone" ? "+1 555 0100" : "?"),
      looksSecret: (t) => t.startsWith("sk-"),
    });
    const r = await h.act({ op: "type", window: "w-2", secret: "profile.phone" });
    expect(r.op).toEqual({
      op: "type",
      window: { app: "Ghostty", title: "~ zsh" },
      secret: "profile.phone",
    });
    expect(JSON.stringify(r)).not.toContain("555");
    expect(d.calls).toEqual([
      { call: "type", windowId: "w-2", node: "", text: "+1 555 0100", mode: "headless" },
    ]);
    await expect(h.act({ op: "type", window: "w-2", text: "sk-live-123" })).rejects.toThrow(
      /looks like a secret/,
    );
    await expect(desktopHands(d).act({ op: "type", window: "w-2", secret: "x" })).rejects.toThrow(
      /no secrets in this session/,
    );
  });

  it("goes headed once headless is refused, after the guard, and journals it", async () => {
    const d = fakeDesktop([term()], { headedOnly: ["Ghostty"] });
    const h = desktopHands(d, clock());
    const r = await h.act({ op: "type", window: "w-2", text: "ls" });
    expect(r.op).toMatchObject({ op: "type", headed: true });
    expect(d.calls).toEqual([
      { call: "focusWindow", windowId: "w-2" },
      { call: "type", windowId: "w-2", node: "", text: "ls", mode: "headed" },
    ]);
  });

  it("the guard refuses headed input when the window shares its pid, or focus went elsewhere", async () => {
    const shared = fakeDesktop(
      [term({ pid: 7 }), fakeWindow("w-3", "Ghostty", "peer session", [], { pid: 7 })],
      { headedOnly: ["Ghostty"] },
    );
    await expect(
      desktopHands(shared, clock()).act({ op: "type", window: "w-2", text: "ls" }),
    ).rejects.toThrow(/only window \(pid 7 has 2\).*Nothing was sent/);
    // a headless key goes to the pid, so a key checks the window is alone even unrefused
    await expect(
      desktopHands(shared, clock()).act({ op: "key", combo: "return", window: "w-2" }),
    ).rejects.toThrow(/a key needs Ghostty "~ zsh" to be its instance's only window/);
    await expect(
      desktopHands(shared, clock()).run({
        op: "key",
        combo: "return",
        window: { app: "Ghostty", title: "zsh" },
      }),
    ).rejects.toThrow(/only window/);
    expect(shared.calls.filter((c) => c.call === "type" || c.call === "press")).toEqual([]);

    const stolen = fakeDesktop([term(), calc()], { headedOnly: ["Ghostty"], focusedId: "w-1" });
    await expect(
      desktopHands(stolen, clock()).act({ op: "type", window: "w-2", text: "ls" }),
    ).rejects.toThrow(/Calculator "Calculator" has focus/);
    expect(stolen.calls.filter((c) => c.call === "type")).toEqual([]);
  });

  it("names a window by app and title piece, and refuses two that match", async () => {
    const d = fakeDesktop([
      fakeWindow("w-1", "Ghostty", "film: director", []),
      fakeWindow("w-2", "Ghostty", "film: inner", []),
    ]);
    const h = desktopHands(d, { ...clock(), windowTries: 1 });
    expect((await h.windowFor({ app: "Ghostty", title: "inner" })).id).toBe("w-2");
    await expect(h.windowFor({ app: "Ghostty", title: "film" })).rejects.toThrow(
      /2 Ghostty windows match "film"/,
    );
    await expect(h.windowFor({ app: "Ghostty", title: "none" })).rejects.toThrow(/no Ghostty/);
  });

  it("waits for text or a file, and says when it never came", async () => {
    const d = fakeDesktop([calc()], { files: ["/tmp/take.mov"] });
    const h = desktopHands(d, clock());
    expect((await h.act({ op: "wait", window: "w-1", text: "Result" })).answer).toMatchObject({
      found: true,
    });
    await expect(h.act({ op: "wait", window: "w-1", text: "Error", timeoutS: 5 })).rejects.toThrow(
      /not seen in 5 s/,
    );
    const f = await h.act({ op: "waitFile", file: "/tmp/take.mov" });
    expect(f.op).toEqual({ op: "waitFile", file: "/tmp/take.mov" });
    expect(desktopActSchema.safeParse({ op: "waitFile", file: "/x", timeoutS: 601 }).success).toBe(
      false,
    );
  });

  it("a click that may spend waits at the gate before any input", async () => {
    const d = fakeDesktop([fakeWindow("w-1", "App Store", "Xcode", [["button", "Buy"]])]);
    const h = desktopHands(d, {
      ...clock(),
      gateClick: async (_app, c) => {
        if (c.name === "Buy") throw new Error("payment gate: declined");
      },
    });
    await h.act({ op: "snapshot", window: "w-1" });
    await expect(h.act({ op: "click", ref: "@s1:e1" })).rejects.toThrow(/declined/);
    expect(d.calls).toEqual([]);
  });
});

describe("desktop hands: replay", () => {
  it("finds each target again and runs the op, headed when the recording was", async () => {
    const d = fakeDesktop([calc(), term()], { headedOnly: ["Ghostty"] });
    const h = desktopHands(d, { ...clock(), secret: async () => "pw" });
    const ops: DesktopOp[] = [
      { op: "launch", app: "Calculator" },
      {
        op: "click",
        window: { app: "Calculator", title: "Calc" },
        control: { role: "button", name: "7" },
      },
      { op: "type", window: { app: "Ghostty", title: "zsh" }, text: "ls", headed: true },
      { op: "key", combo: "return", window: { app: "Ghostty", title: "zsh" }, headed: true },
      { op: "wait", window: { app: "Calculator", title: "Calc" }, text: "Result", timeoutS: 3600 },
      { op: "sleep", ms: 10 },
      { op: "shell", command: "true" },
    ];
    for (const op of ops) await h.run(desktopOpSchema.parse(op));
    expect(d.calls.map((c) => [c.call, "mode" in c ? c.mode : ""])).toEqual([
      ["launch", ""],
      ["click", "headless"],
      ["focusWindow", ""],
      ["type", "headed"],
      ["focusWindow", ""],
      ["press", "headed"],
      ["shell", ""],
    ]);
  });

  it("a control that is gone or doubled stops the replay with what it looked for", async () => {
    const d = fakeDesktop([calc()]);
    const h = desktopHands(d, clock());
    const w = { app: "Calculator", title: "Calculator" };
    await expect(
      h.run({ op: "click", window: w, control: { role: "button", name: "Add" } }),
    ).rejects.toThrow(/2 button "Add" in Calculator "Calculator": ambiguous/);
    await expect(
      h.run({ op: "click", window: w, control: { role: "button", name: "9" } }),
    ).rejects.toThrow(/0 button "9".*not found/);
  });
});

/** Turning a setting on: launch, click, type a stored password, return, a root command. */
const sharing = { app: "System Settings", title: "Sharing" };
const recording: Recording = {
  name: "allow-remote-login",
  site: "scratch",
  startedAt: "2026-09-21T10:00:00Z",
  finishedAt: "2026-09-21T10:01:00Z",
  trace: null,
  terminal: null,
  commands: [],
  actions: [
    { t: 0, kind: "note", url: "about:blank", text: "Remote login" },
    {
      t: 1,
      kind: "desktop",
      url: "",
      op: { op: "launch", app: "System Settings" },
      redacted: false,
    },
    {
      t: 2,
      kind: "desktop",
      url: "",
      op: { op: "click", window: sharing, control: { role: "checkbox", name: "Remote Login" } },
      redacted: false,
    },
    {
      t: 3,
      kind: "desktop",
      url: "",
      op: { op: "type", window: sharing, secret: "mac.password" },
      redacted: true,
    },
    {
      t: 4,
      kind: "desktop",
      url: "",
      op: { op: "key", combo: "return", window: sharing },
      redacted: false,
    },
    {
      t: 5,
      kind: "desktop",
      url: "",
      op: { op: "shell", command: "systemsetup -getremotelogin", root: true },
      redacted: false,
    },
  ],
};

/** The film's director in short: a fresh terminal, a typed command, waits on text and a file. */
const filmRec: Recording = {
  ...recording,
  name: "film-director",
  actions: [
    { t: 0, kind: "note", url: "", text: "Director" },
    {
      t: 1,
      kind: "desktop",
      url: "",
      op: { op: "launch", app: "Ghostty", fresh: true },
      redacted: false,
    },
    {
      t: 2,
      kind: "desktop",
      url: "",
      op: {
        op: "type",
        window: { app: "Ghostty", title: "zsh" },
        text: "autobrowse obs start",
        headed: true,
      },
      redacted: false,
    },
    {
      t: 3,
      kind: "desktop",
      url: "",
      op: { op: "key", combo: "return", window: { app: "Ghostty", title: "zsh" }, headed: true },
      redacted: false,
    },
    {
      t: 4,
      kind: "desktop",
      url: "",
      op: { op: "wait", window: { app: "Ghostty", title: "zsh" }, text: "recording", timeoutS: 30 },
      redacted: false,
    },
    { t: 5, kind: "desktop", url: "", op: { op: "sleep", ms: 500 }, redacted: false },
    {
      t: 6,
      kind: "desktop",
      url: "",
      op: { op: "waitFile", file: "/tmp/take.mov", timeoutS: 900 },
      redacted: false,
    },
  ],
};

/** Typechecks rendered files against the library source. */
function typecheck(files: string[]): string[] {
  const config = ts.readConfigFile(join(import.meta.dirname, "../tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    join(import.meta.dirname, ".."),
  );
  const program = ts.createProgram(files, {
    ...parsed.options,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: ["node"],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("desktop step", () => {
  it("structures desktop acts into one gated step; a stored secret keeps its name", () => {
    const o = structure(recording);
    expect(o.steps).toHaveLength(1);
    const step = o.steps[0];
    if (step?.kind !== "desktop") throw new Error("expected a desktop step");
    expect(step.name).toBe("remote-login");
    expect(step.irreversible).toBe(true); // a root command
    expect(step.ops.map((op) => op.kind)).toEqual(["launch", "click", "type", "key", "shell"]);
    expect(step.ops[1]).toMatchObject({
      goal: 'click checkbox "Remote Login" in System Settings "Sharing"',
      window: sharing,
      control: { role: "checkbox", name: "Remote Login", nativeId: null },
    });
    expect(o.secrets).toEqual([{ key: "macPassword", label: "mac.password" }]);
    const typed = recording.actions[3];
    if (typed?.kind !== "desktop") throw new Error("expected a desktop act");
    expect(describeOp(typed.op, true)).toBe(
      'type secret mac.password in System Settings "Sharing"',
    );
  });

  it("renders each op through hands.run, the secret outside the journal, and gates the step", () => {
    const src = render(structure(recording)).files["index.ts"] ?? "";
    expect(src).toContain("desktop: Desktop;");
    expect(src).toContain("const hands = desktopHands(deps.desktop);");
    expect(src).toContain(
      'hands.run({ op: "click", window: { app: "System Settings", title: "Sharing" }, control: { role: "checkbox", name: "Remote Login" } }).then(() => undefined)',
    );
    expect(src).toContain('const macPassword = await deps.secrets.get("macPassword");');
    expect(src).toContain("text: macPassword");
    expect(src).toContain('await sh(4, "systemsetup -getremotelogin", true);');
    expect(src).toContain('gate("send"');
  });

  it("lints window titles, control names and waited text for a person's details", () => {
    const o = structure({
      ...recording,
      actions: [
        {
          t: 1,
          kind: "desktop",
          url: "",
          op: {
            op: "click",
            window: { app: "Mail", title: "Re: invoice for jane.doe@acmemail.net" },
            control: { role: "button", name: "Send" },
          },
          redacted: false,
        },
      ],
    });
    expect(lintOutline(o).join("\n")).toMatch(/window\.title/);
  });

  it("the rendered film director typechecks and its generated test runs on the fake desktop", async () => {
    const dir = await mkdtemp(join(import.meta.dirname, ".generated-desktop-"));
    try {
      const lib = join(import.meta.dirname, "../src/index.ts");
      const out = await compile(filmRec, { lib });
      const index = out.files["index.ts"] ?? "";
      expect(index).toContain('hands.run({ op: "launch", app: "Ghostty", fresh: true })');
      expect(index).toContain(
        'hands.run({ op: "waitFile", file: "/tmp/take.mov", timeoutS: 900 })',
      );
      expect(index).toContain("await fx.sleep(500);");
      const test = out.files["index.test.ts"] ?? "";
      expect(test).toContain(
        'fakeWindow("w-1", "Ghostty", "zsh", [["textfield",""],["text","recording"]])',
      );
      expect(test).toContain('{ files: ["/tmp/take.mov"] }');
      const files = await writeRendered(dir, out);
      expect(typecheck(files)).toEqual([]);
      const { workflow, planSchema } = await import(join(dir, "index.ts"));
      const { memoryEffects, runFlow } = await import("../src/index.js");
      const desktop = fakeDesktop(
        [
          fakeWindow("w-1", "Ghostty", "zsh", [
            ["textfield", ""],
            ["text", "recording"],
          ]),
        ],
        { files: ["/tmp/take.mov"] },
      );
      const plan = planSchema.parse({ dryRun: false, typedText1: "autobrowse obs start" });
      const res = await runFlow(
        memoryEffects().fx,
        workflow,
        { browser: { run: async () => undefined as never }, desktop },
        plan,
      );
      expect(res.status).toBe("done");
      expect(desktop.calls.map((c) => c.call)).toEqual([
        "launch",
        "focusWindow",
        "type",
        "focusWindow",
        "press",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
