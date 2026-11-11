/**
 * The agent skill as part of the package (OpenCLI audit U21): `autobrowse skills list|read|install`
 * and a generated `llms.txt`. The build copies `.claude/skills/autobrowse` to `dist/skills/`;
 * from the repo the source folder is read as it is.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { CatalogFile } from "./catalog-file.js";

export const SKILL_NAME = "autobrowse";

/** `dist/skills/autobrowse` in the package; `.claude/skills/autobrowse` in the repo. */
export function skillDir(): string {
  const packed = join(import.meta.dirname, "skills", SKILL_NAME);
  return existsSync(packed)
    ? packed
    : join(import.meta.dirname, "..", ".claude", "skills", SKILL_NAME);
}

export interface SkillFile {
  /** `explore` for explore.md; `autobrowse` for SKILL.md. */
  name: string;
  file: string;
  /** The front matter's description, else the first heading or line. */
  summary: string;
}

function summaryOf(text: string): string {
  const desc = /^description:\s*(.+)$/m.exec(text.split(/^---$/m)[1] ?? "");
  if (desc?.[1]) return desc[1].trim();
  const line = text.split("\n").find((l) => l.trim() && !l.startsWith("---"));
  return (line ?? "").replace(/^#+\s*/, "").trim();
}

export function listSkills(dir = skillDir()): SkillFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)))
    .map((f) => ({
      name: f === "SKILL.md" ? SKILL_NAME : f.replace(/\.md$/, ""),
      file: join(dir, f),
      summary: summaryOf(readFileSync(join(dir, f), "utf8")),
    }));
}

export function readSkill(name = SKILL_NAME, dir = skillDir()): string {
  const hit = listSkills(dir).find((s) => s.name === name || `${s.name}.md` === name);
  if (!hit) throw new Error(`no skill file "${name}": autobrowse skills list`);
  return readFileSync(hit.file, "utf8");
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) =>
    statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)],
  );

export interface Installed {
  dest: string;
  copied: string[];
  same: string[];
  /** Files at the destination that differ: kept unless `force`. */
  kept: string[];
}

/** Copies the skill folder to `dest`. A file there that differs is kept unless `force`. */
export function installSkill(dest: string, o: { force?: boolean; from?: string } = {}): Installed {
  const from = o.from ?? skillDir();
  const out: Installed = { dest, copied: [], same: [], kept: [] };
  for (const src of filesUnder(from)) {
    const rel = relative(from, src);
    const to = join(dest, rel);
    const had = existsSync(to) ? readFileSync(to) : null;
    if (had?.equals(readFileSync(src))) {
      out.same.push(rel);
      continue;
    }
    if (had && !o.force) {
      out.kept.push(rel);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(src, to);
    out.copied.push(rel);
  }
  return out;
}

export interface HelpNode {
  name: string;
  summary: string;
  commands: HelpNode[];
}

/** llms.txt (llmstxt.org): what it is, every command, the skill files, the catalog counts. */
export function llmsText(
  tree: HelpNode,
  skills: readonly SkillFile[],
  catalog: Pick<CatalogFile, "routes" | "flows" | "workflows">,
  version: string,
): string {
  const lines = [
    "# autobrowse",
    "",
    "> Signed-in browser and site-API automation for agents: stored logins, official APIs behind one facade, and a journaled browser whose acts compile into workflows.",
    "",
    `Version ${version}. Every command takes \`--help --json\`; \`autobrowse list <words> --json\` finds a route, flow or workflow. Errors are one JSON shape: \`{code, message, hint, retryable, outcome?, artifact?}\`.`,
    "",
    "## Skill",
    "",
    ...skills.map((s) => `- [${s.name}](skills/${SKILL_NAME}/${basename(s.file)}): ${s.summary}`),
    "",
    "## Commands",
    "",
  ];
  const walk = (n: HelpNode, path: string[]) => {
    for (const c of n.commands) {
      const name = [...path, c.name].join(" ");
      lines.push(`- \`autobrowse ${name}\`${c.summary ? `: ${c.summary}` : ""}`);
      walk(c, [...path, c.name]);
    }
  };
  walk(tree, []);
  lines.push(
    "",
    "## Catalog",
    "",
    `${catalog.routes.length} site API routes, ${catalog.flows.length} browser flows, ${catalog.workflows.length} compiled workflows: \`autobrowse list --json\`.`,
    "",
  );
  return lines.join("\n");
}
