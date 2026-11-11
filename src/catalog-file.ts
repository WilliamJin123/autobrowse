/**
 * The committed catalog (OpenCLI audit U3): every site route, hand-written flow and shipped
 * workflow by name, in `catalog.json`. A test fails when the code and the file differ, so a
 * dropped route or flow is a reviewed change, never a silent one. `pnpm catalog` writes it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_FLOWS } from "./engine/browser-service.js";
import { SITES } from "./sites/index.js";
import { accessOf } from "./sites/types.js";
import { LOGIN_WORKFLOWS } from "./workflows/logins.js";
import { SHIPPED_DIR } from "./workflows/roots.js";

export const CATALOG_FILE = join(import.meta.dirname, "..", "catalog.json");

export interface CatalogFile {
  /** `site METHOD /path` with its access label; `!` marks an irreversible route. */
  routes: string[];
  flows: string[];
  workflows: string[];
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function catalogNow(): CatalogFile {
  return {
    routes: sorted(
      SITES.flatMap((s) =>
        s.routes.map(
          (r) => `${s.site} ${r.method} ${r.path} ${accessOf(r)}${r.irreversible ? " !" : ""}`,
        ),
      ),
    ),
    flows: sorted(Object.keys(BROWSER_FLOWS)),
    workflows: sorted([
      ...readdirSync(SHIPPED_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(SHIPPED_DIR, d.name, "index.ts")))
        .map((d) => d.name),
      ...LOGIN_WORKFLOWS.keys(),
    ]),
  };
}

/** What one side has and the other lacks, per list. */
export function catalogDiff(
  was: CatalogFile,
  now: CatalogFile,
): { gone: string[]; added: string[] } {
  const gone: string[] = [];
  const added: string[] = [];
  for (const k of ["routes", "flows", "workflows"] as const) {
    const a = new Set(was[k]);
    const b = new Set(now[k]);
    for (const x of a) if (!b.has(x)) gone.push(`${k}: ${x}`);
    for (const x of b) if (!a.has(x)) added.push(`${k}: ${x}`);
  }
  return { gone, added };
}
