/**
 * Teach on by default (designs/2026-10-05-teach-mode.md): each run a person acted in by hand
 * becomes a draft walk, every guess taken. `walks keep` builds it again under a real name with
 * the review; `walks remove` deletes it. Drafts sit beside the walks, never among them: they do
 * not run by name and never pack.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "../money/profile.js";
import { baseSite } from "../runs/log.js";
import { buildWalk, USABLE } from "./build.js";
import { saveWalk, type WalkSpec, walkFile, walkSpecSchema } from "./spec.js";

/** A draft may come from a run a person ended by closing the browser. */
export const DRAFT_OUTCOMES: ReadonlySet<string> = new Set([...USABLE, "closed"]);

export const draftsDirOf = (walksDir: string): string => join(dirname(walksDir), "walk-drafts");

export const draftName = (run: string): string => `draft-${run.toLowerCase()}`;

/** The draft from one run; null when the build found no screens (nothing to replay). */
export function buildDraft(
  runsDir: string,
  walksDir: string,
  r: { site: string; run: string; profile?: Profile | null },
): { file: string; spec: WalkSpec } | null {
  const built = buildWalk(runsDir, {
    site: baseSite(r.site),
    name: draftName(r.run),
    runs: [r.run],
    profile: r.profile ?? null,
    outcomes: DRAFT_OUTCOMES,
  });
  if (!built.used.length || !built.spec.screens.length) return null;
  return { file: saveWalk(draftsDirOf(walksDir), built.spec), spec: built.spec };
}

export interface DraftListing {
  site: string;
  name: string;
  run: string;
  goal: string;
  screens: number;
  fields: number;
  built: string;
}

/** Every draft, newest first; a file that does not parse is skipped. */
export function listDrafts(walksDir: string): DraftListing[] {
  const dir = draftsDirOf(walksDir);
  if (!existsSync(dir)) return [];
  const out: DraftListing[] = [];
  for (const site of readdirSync(dir, { withFileTypes: true })) {
    if (!site.isDirectory()) continue;
    for (const f of readdirSync(join(dir, site.name))) {
      if (!f.endsWith(".json")) continue;
      try {
        const w = walkSpecSchema.parse(JSON.parse(readFileSync(join(dir, site.name, f), "utf8")));
        out.push({
          site: w.site,
          name: w.name,
          run: w.from[0]?.run ?? "",
          goal: w.goal,
          screens: w.screens.length,
          fields: w.fields.length,
          built: w.built,
        });
      } catch {
        // a broken draft is not worth a failed listing
      }
    }
  }
  return out.sort((a, b) => b.built.localeCompare(a.built));
}

/** `site/draft-…` or a bare draft name (unique across sites). */
export function findDraft(walksDir: string, ref: string): DraftListing | null {
  const [site, name] = ref.includes("/") ? (ref.split("/") as [string, string]) : [null, ref];
  const hits = listDrafts(walksDir).filter(
    (d) => d.name === name && (site === null || d.site === baseSite(site)),
  );
  if (hits.length > 1)
    throw new Error(`${ref}: on ${hits.map((d) => d.site).join(", ")}; name the site`);
  return hits[0] ?? null;
}

export function dropDraft(walksDir: string, d: Pick<DraftListing, "site" | "name">): void {
  rmSync(walkFile(draftsDirOf(walksDir), d.site, d.name), { force: true });
}
