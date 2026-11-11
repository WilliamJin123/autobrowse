import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modExtensions } from "../src/mods/extend.js";
import { modSchema } from "../src/mods/mod.js";
import type { SiteFacade } from "../src/sites/facade.js";
import { type CallHook, type HookOutcome, withHooks } from "../src/sites/hooks.js";

const stub = (fail = false) =>
  ({
    call: async (_s: string, _m: string, _p: string, input: Record<string, unknown>) => {
      if (fail) throw new Error("upstream down");
      return { echoed: input };
    },
  }) as unknown as SiteFacade;

describe("call hooks (U23)", () => {
  it("before refuses with a 403 that names the hook; after sees each outcome", async () => {
    const seen: HookOutcome[] = [];
    const deny: CallHook = {
      name: "no-deletes",
      before: (c) => {
        if (c.method === "DELETE") throw new Error("deletes are off");
      },
      after: (_c, out) => void seen.push(out),
    };
    const f = withHooks(stub(), [deny]);
    await expect(f.call("x", "GET", "/a", { q: 1 })).resolves.toEqual({ echoed: { q: 1 } });
    await expect(f.call("x", "DELETE", "/a", {})).rejects.toMatchObject({
      status: 403,
      message: /refused by hook no-deletes: deletes are off/,
    });
    await expect(withHooks(stub(true), [deny]).call("x", "GET", "/a", {})).rejects.toThrow(
      /upstream down/,
    );
    expect(seen.map((o) => o.ok)).toEqual([true, false]);
  });

  it("a hook cannot change the input, only its sites run, and a failed after is not the caller's", async () => {
    const errors: string[] = [];
    const hooks: CallHook[] = [
      {
        name: "meddler",
        before: (c) => {
          (c.input as Record<string, unknown>).q = 2;
        },
      },
      { name: "elsewhere", sites: ["y"], before: () => Promise.reject(new Error("no")) },
      { name: "noisy", after: () => Promise.reject(new Error("boom")) },
    ];
    const f = withHooks(stub(), hooks, (h) => errors.push(h));
    await expect(f.call("x@label", "GET", "/a", { q: 1 })).rejects.toThrow(/meddler/);
    const g = withHooks(stub(), hooks.slice(1), (h) => errors.push(h));
    await expect(g.call("x", "GET", "/a", { q: 1 })).resolves.toEqual({ echoed: { q: 1 } });
    expect(errors).toEqual(["noisy"]);
  });
});

describe("mod sites and hooks (U23)", () => {
  const sha = "0".repeat(64);
  function modsDir(o: { trusted: boolean; site: string; listed: string[] }) {
    const root = mkdtempSync(join(tmpdir(), "mods-"));
    const dir = join(root, "acme");
    mkdirSync(join(dir, "sites"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const mod = {
      name: "acme",
      version: "1.0.0",
      autobrowse: ">=0.1.0",
      description: "acme",
      sites: o.listed,
      domains: ["acme.test"],
      gates: [],
      credentials: [],
      irreversible: false,
      files: [
        { kind: "site", path: "sites/acme.ts", sha256: sha },
        { kind: "hook", path: "hooks/audit.ts", sha256: sha },
      ],
    };
    expect(modSchema.safeParse(mod).success).toBe(true);
    writeFileSync(join(dir, "mod.json"), JSON.stringify(mod));
    writeFileSync(
      join(dir, "installed.json"),
      JSON.stringify({ source: "test", at: "2026-11-10", trusted: o.trusted }),
    );
    writeFileSync(
      join(dir, "sites", "acme.ts"),
      `export default { site: ${JSON.stringify(o.site)}, origin: "https://acme.test", auth: { open: true }, routes: [], setup: [] };\n`,
    );
    writeFileSync(
      join(dir, "hooks", "audit.ts"),
      'export default { name: "audit", after: () => {} };\n',
    );
    return root;
  }

  it("loads a trusted mod's site and hook", async () => {
    const ext = await modExtensions(modsDir({ trusted: true, site: "acme", listed: ["acme"] }), [
      "x",
    ]);
    expect(ext.sites.map((s) => s.site)).toEqual(["acme"]);
    expect(ext.hooks.map((h) => h.name)).toEqual(["acme/audit"]);
    expect(ext.skipped).toEqual([]);
  });

  it("loads nothing untrusted, never a built-in's name, never a site mod.json does not name", async () => {
    expect(
      await modExtensions(modsDir({ trusted: false, site: "acme", listed: ["acme"] }), []),
    ).toEqual({ sites: [], hooks: [], skipped: [] });
    const clash = await modExtensions(modsDir({ trusted: true, site: "acme", listed: ["acme"] }), [
      "acme",
    ]);
    expect(clash.skipped).toEqual(["acme sites/acme.ts: site acme is taken"]);
    const unlisted = await modExtensions(
      modsDir({ trusted: true, site: "other", listed: ["acme"] }),
      [],
    );
    expect(unlisted.skipped[0]).toMatch(/other is not in mod.json sites/);
  });

  it("a site or hook is one .ts file in its folder", () => {
    const bad = modSchema.safeParse({
      name: "acme",
      version: "1.0.0",
      autobrowse: ">=0.1.0",
      description: "",
      sites: ["acme"],
      domains: ["acme.test"],
      gates: [],
      credentials: [],
      irreversible: false,
      files: [{ kind: "site", path: "sites/a/b.ts", sha256: sha }],
    });
    expect(bad.success).toBe(false);
  });
});
