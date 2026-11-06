import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { memoryEnvStore } from "credvault";
import { describe, expect, it } from "vitest";
import { registerEnvCommands } from "../src/app/cli-env.js";
import type { Settings } from "../src/app/config.js";
import { valueMark } from "../src/deps/sink.js";

describe("autobrowse env", () => {
  const setup = (initial: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
    const store = memoryEnvStore(initial);
    const said: string[] = [];
    let printed = "";
    let pasted = "";
    const copied: string[] = [];
    const program = new Command().exitOverride();
    registerEnvCommands(program, { envFile: join(dir, ".env"), owner: "me" } as Settings, {
      store: () => store,
      say: (l) => said.push(l),
      out: (t) => {
        printed += t;
      },
      clipboard: async (t) => {
        copied.push(t);
      },
      paste: async () => pasted,
    });
    const run = (...args: string[]) => program.parseAsync(["node", "autobrowse", "env", ...args]);
    const paste = (t: string) => {
      pasted = t;
    };
    return { dir, store, said, copied, run, paste, printed: () => printed };
  };

  it("history shows marks, never values; restore puts a version back in the store and the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
    const store = memoryEnvStore({ TOKEN: "wrong-value-22" });
    const said: string[] = [];
    const program = new Command().exitOverride();
    registerEnvCommands(program, { envFile: join(dir, ".env"), owner: "me" } as Settings, {
      store: () => store,
      say: (l) => said.push(l),
      versions: async (name) =>
        name === "TOKEN"
          ? [
              {
                version: 1,
                at: "2026-09-25T00:00:00.000Z",
                value: "first-value-11",
                expiresAt: null,
              },
              {
                version: 2,
                at: "2026-11-05T00:00:00.000Z",
                value: "wrong-value-22",
                expiresAt: null,
              },
            ]
          : [],
    });
    const run = (...args: string[]) => program.parseAsync(["node", "autobrowse", "env", ...args]);
    await run("history", "TOKEN");
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/^v2 .*14 chars.*the store now/);
    expect(said.join("\n")).not.toMatch(/first-value|wrong-value/);
    await run("restore", "TOKEN", "1");
    expect(await store.get("TOKEN")).toBe("first-value-11");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TOKEN=first-value-11");
    expect(said.join("\n")).not.toMatch(/first-value|wrong-value/);
    await expect(run("restore", "TOKEN", "9")).rejects.toThrow(/no version 9/);
    await expect(run("history", "NOPE")).rejects.toThrow(/not in the store/);
  });

  it("lists names only, copies one value, prints on request", async () => {
    const t = setup({ TWILIO_AUTH_TOKEN: "tok", A: "1" });
    await t.run("ls");
    expect(t.said.join("\n")).toMatch(/^A\nTWILIO_AUTH_TOKEN/);
    expect(t.said.join("\n")).not.toContain("tok");
    await t.run("get", "TWILIO_AUTH_TOKEN");
    expect(t.copied).toEqual(["tok"]);
    expect(t.said.at(-1)).toMatch(/on the clipboard for 5 min/);
    await t.run("get", "TWILIO_AUTH_TOKEN", "--print");
    expect(t.printed()).toBe("tok");
    await expect(t.run("get", "NOPE")).rejects.toThrow(/not in the store/);
  });

  it("records an expiry without printing the value, shows it in ls, and clears it", async () => {
    const t = setup({ NPM_TOKEN: "tok" });
    await t.run("expires", "NPM_TOKEN", "2026-12-21");
    expect(t.said.at(-1)).toBe("NPM_TOKEN expires 2026-12-21T00:00:00.000Z");
    expect(await t.store.get("NPM_TOKEN")).toBe("tok");
    await t.run("ls");
    expect(t.said.at(-1)).toMatch(/^NPM_TOKEN\s+expires 2026-12-21T00:00:00.000Z$/);
    await t.run("expires", "NPM_TOKEN", "none");
    expect((await t.store.list())[0]?.expiresAt).toBeNull();
    expect(t.said.join("\n")).not.toContain("tok");
    await expect(t.run("expires", "NPM_TOKEN", "soon")).rejects.toThrow(/not a date/);
    await expect(t.run("expires", "NOPE", "2026-12-21")).rejects.toThrow(/not in the store/);
  });

  it("pulls into a 0600 env file (merged), as exports, or to stdout; sidecars for multi-line values", async () => {
    const t = setup({ A: "1", SA: '{\n "k": 1\n}', B: "2" });
    writeFileSync(join(t.dir, ".env"), "LOCAL=keep\nA=old\n");
    // A file value the store never held has no history: the pull asks first and writes nothing.
    await expect(t.run("pull")).rejects.toThrow(
      /Nothing was written[\s\S]*A in .*: 3 chars[\s\S]*Is that intended\?[\s\S]*yes: autobrowse env pull --confirm/,
    );
    expect(readFileSync(join(t.dir, ".env"), "utf8")).toBe("LOCAL=keep\nA=old\n");
    await t.run("pull", "--confirm");
    const env = readFileSync(join(t.dir, ".env"), "utf8");
    expect(env).toBe(`LOCAL=keep\nA=1\nB=2\nSA=${join(t.dir, "sa.json")}\n`);
    expect(statSync(join(t.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(t.dir, "sa.json"), "utf8")).toBe('{\n "k": 1\n}');
    await t.run("pull", "B", "--export");
    expect(t.printed()).toBe("export B='2'\n");
    await expect(t.run("pull", "NOPE")).rejects.toThrow(/not in the store: NOPE/);
  });

  it("pulls a setting that is no secret into settings.json, not the env file", async () => {
    const t = setup({ LOG_LEVEL: "debug", UI_TOKEN: "tok" });
    const was = process.env.SETTINGS_FILE;
    process.env.SETTINGS_FILE = join(t.dir, "settings.json");
    try {
      await t.run("pull");
      expect(readFileSync(join(t.dir, ".env"), "utf8")).toBe("UI_TOKEN=tok\n");
      expect(JSON.parse(readFileSync(join(t.dir, "settings.json"), "utf8"))).toEqual({
        logLevel: "debug",
      });
    } finally {
      process.env.SETTINGS_FILE = was;
    }
  });

  it("pushes named keys from .env, or every key of a file; refuses a bare push", async () => {
    const t = setup({});
    writeFileSync(
      join(t.dir, ".env"),
      "TWILIO_ACCOUNT_SID=AC1\nTWILIO_AUTH_TOKEN=tok\nLOG_LEVEL=debug\n",
    );
    await expect(t.run("push")).rejects.toThrow(/name what to push/);
    await t.run("push", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN");
    expect(t.store.values).toEqual({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
    expect(t.said.at(-2)).toBe("pushed 2: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN");
    await expect(t.run("push", "MISSING")).rejects.toThrow(/not in .*MISSING/);
    writeFileSync(join(t.dir, "prod.env"), "X=1\nY=2\n");
    await t.run("push", "--from", join(t.dir, "prod.env"));
    expect(Object.keys(t.store.values).sort()).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "X",
      "Y",
    ]);
    // A remove asks first; the same command with --confirm is the yes.
    await expect(t.run("rm", "X")).rejects.toThrow(
      /Nothing was removed[\s\S]*Is that intended\?[\s\S]*yes: autobrowse env rm X --confirm/,
    );
    expect(t.store.values.X).toBe("1");
    await t.run("rm", "X", "--confirm");
    expect(t.store.values.X).toBeUndefined();
    expect(t.said.at(-1)).toBe("removed X");
  });
  it("sets a new value from the clipboard into the store and .env, cleaned of a pasted line or quotes", async () => {
    const t = setup({});
    t.paste("  TWILIO_AUTH_TOKEN='k-1'\n");
    await t.run("set", "TWILIO_AUTH_TOKEN", "--clipboard");
    expect(await t.store.get("TWILIO_AUTH_TOKEN")).toBe("k-1");
    expect(readFileSync(join(t.dir, ".env"), "utf8")).toMatch(/^TWILIO_AUTH_TOKEN=k-1$/m);
    expect(t.said.join("\n")).not.toContain("k-1");
    t.paste("");
    await expect(t.run("set", "X", "--clipboard")).rejects.toThrow(/empty/);
    t.paste("a\nb");
    await expect(t.run("set", "X", "--clipboard")).rejects.toThrow(/line breaks/);
    await expect(t.run("set", "lower", "--clipboard")).rejects.toThrow(/not an env name/);
    t.paste("k2");
    await t.run("set", "ONLY_THERE", "--clipboard", "--store-only");
    expect(readFileSync(join(t.dir, ".env"), "utf8")).not.toContain("ONLY_THERE");
  });
  it("no set or push replaces a held value until the second run confirms", async () => {
    const t = setup({ CF_TOKEN: "live-token-1" });
    t.paste("other-token-2");
    const refusal = await t.run("set", "CF_TOKEN", "--clipboard").then(
      () => "",
      (e: Error) => e.message,
    );
    expect(refusal).toContain("Nothing was written");
    expect(refusal).toContain("CF_TOKEN in the store: 12 chars");
    expect(refusal).toContain("Is that intended?");
    expect(refusal).toContain("yes: autobrowse env set CF_TOKEN --clipboard --confirm");
    expect(refusal).toContain("no: do nothing, or keep both");
    expect(refusal).not.toContain("live-token-1");
    expect(refusal).not.toContain("other-token-2");
    expect(t.store.values.CF_TOKEN).toBe("live-token-1");
    expect(existsSync(join(t.dir, ".env"))).toBe(false);

    await t.run("set", "CF_TOKEN", "--clipboard", "--confirm");
    expect(t.store.values.CF_TOKEN).toBe("other-token-2");
    expect(t.said.join("\n")).toContain(
      `replaced CF_TOKEN in the store (${valueMark("live-token-1")} → ${valueMark("other-token-2")})`,
    );

    // The same value again is no replace.
    const same = setup({ SAME: "v" });
    same.paste("v");
    await same.run("set", "SAME", "--clipboard");

    // A push writes none of its names while one of them would replace.
    const p = setup({ B: "held" });
    writeFileSync(join(p.dir, ".env"), "A=1\nB=new\n");
    await expect(p.run("push", "A", "B")).rejects.toThrow(
      /B in the store: 4 chars[\s\S]*yes: autobrowse env push A B --confirm/,
    );
    expect(p.store.values).toEqual({ B: "held" });
    await p.run("push", "A", "B", "--confirm");
    expect(p.store.values).toEqual({ A: "1", B: "new" });
  });

  it("a set refuses a value held only in the env file; a pull lets a rotation through", async () => {
    const t = setup({});
    writeFileSync(join(t.dir, ".env"), "ONLY_HERE=local-1\n");
    t.paste("fresh-2");
    await expect(t.run("set", "ONLY_HERE", "--clipboard")).rejects.toThrow(
      /ONLY_HERE in .*\.env: 7 chars/,
    );
    expect(t.store.values.ONLY_HERE).toBeUndefined();

    // The file holds the store's earlier version: the pull is the rotation reaching this machine.
    const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
    const store = memoryEnvStore({ TOKEN: "rotated-2", LOST: "store-value" });
    const program = new Command().exitOverride();
    registerEnvCommands(program, { envFile: join(dir, ".env"), owner: "me" } as Settings, {
      store: () => store,
      say: () => {},
      versions: async (name) =>
        name === "TOKEN"
          ? [
              { version: 1, at: "2026-11-01T00:00:00.000Z", value: "first-1", expiresAt: null },
              { version: 2, at: "2026-11-05T00:00:00.000Z", value: "rotated-2", expiresAt: null },
            ]
          : [{ version: 1, at: "2026-11-05T00:00:00.000Z", value: "store-value", expiresAt: null }],
    });
    const run = (...args: string[]) => program.parseAsync(["node", "autobrowse", "env", ...args]);
    writeFileSync(join(dir, ".env"), "TOKEN=first-1\n");
    await run("pull", "TOKEN");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TOKEN=rotated-2\n");
    writeFileSync(join(dir, ".env"), "LOST=never-stored\n");
    await expect(run("pull", "LOST")).rejects.toThrow(/Nothing was written/);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("LOST=never-stored\n");
  });

  it("a push of a name only in the store says so; one in neither place is an error", async () => {
    const t = setup({ ONLY_THERE: "v" });
    await t.run("push", "ONLY_THERE");
    expect(t.said.join("\n")).toMatch(/already in the store/);
    await expect(t.run("push", "NOWHERE")).rejects.toThrow(/not in .* or the store: NOWHERE/);
  });

  it("refuses to set or remove a name the vault projects, and still reads it", async () => {
    const t = setup({ EXA_API_KEY: "synthetic-a", NUM_EXA: "1" });
    t.paste("synthetic-b");
    await expect(t.run("set", "EXA_API_KEY", "--clipboard")).rejects.toThrow(
      "EXA_API_KEY is an API key name: keys live in the vault. autobrowse creds key add exa@<label> --clipboard",
    );
    await expect(t.run("set", "NUM_EXA", "--clipboard")).rejects.toThrow(
      "NUM_EXA is set by the projection from the vault's exa keys",
    );
    await expect(t.run("rm", "EXA_API_KEY_1")).rejects.toThrow(/API key name/);
    await expect(t.run("rm", "NUM_EXA")).rejects.toThrow(/set by the projection/);
    expect(t.store.values.EXA_API_KEY).toBe("synthetic-a");
    await t.run("get", "EXA_API_KEY", "--print");
    expect(t.printed()).toBe("synthetic-a");
  });
});
