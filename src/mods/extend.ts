/**
 * What a trusted mod adds to the site facade (U23): a whole site API (`sites/<site>.ts`, default
 * export a `SiteApi`) and call hooks (`hooks/<name>.ts`, default export a `CallHook`). Code kinds:
 * loaded only from a mod added with `--trust`, after its sha256 check at install. A mod's site
 * never replaces a built-in one, and must be one its `mod.json` names.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CallHook, isCallHook } from "../sites/hooks.js";
import type { SiteApi } from "../sites/types.js";
import { installedMods } from "./mod.js";

export interface ModExtensions {
  sites: SiteApi[];
  hooks: CallHook[];
  /** `<mod> <file>: why`, one per file not loaded. */
  skipped: string[];
}

const isSiteApi = (v: unknown): v is SiteApi =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as SiteApi).site === "string" &&
  Array.isArray((v as SiteApi).routes) &&
  Array.isArray((v as SiteApi).setup);

export async function modExtensions(
  modsDir: string,
  builtIn: readonly string[],
): Promise<ModExtensions> {
  const out: ModExtensions = { sites: [], hooks: [], skipped: [] };
  const taken = new Set(builtIn);
  for (const m of installedMods(modsDir)) {
    if (!m.trusted) continue;
    for (const f of m.mod.files) {
      if (f.kind !== "site" && f.kind !== "hook") continue;
      const skip = (why: string) => out.skipped.push(`${m.mod.name} ${f.path}: ${why}`);
      let mod: Record<string, unknown>;
      try {
        mod = (await import(pathToFileURL(join(m.dir, f.path)).href)) as Record<string, unknown>;
      } catch (err) {
        skip(`does not load: ${(err as Error).message}`);
        continue;
      }
      const v = mod.default;
      if (f.kind === "hook") {
        if (isCallHook(v)) out.hooks.push({ ...v, name: `${m.mod.name}/${v.name}` });
        else skip("default export is not a CallHook");
        continue;
      }
      if (!isSiteApi(v)) skip("default export is not a SiteApi");
      else if (!m.mod.sites.includes(v.site)) skip(`site ${v.site} is not in mod.json sites`);
      else if (taken.has(v.site)) skip(`site ${v.site} is taken`);
      else {
        taken.add(v.site);
        out.sites.push(v);
      }
    }
  }
  return out;
}
