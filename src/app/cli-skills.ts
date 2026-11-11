/** `autobrowse skills list|read|install` (OpenCLI audit U21): the agent skill shipped with the package. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { installSkill, listSkills, readSkill, SKILL_NAME, skillDir } from "../skills-pack.js";

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("The agent skill that ships with autobrowse: list, read, install");

  skills
    .command("list")
    .description("The skill's files, each with one line")
    .option("--json", "as JSON")
    .action((o: { json?: boolean }) => {
      const rows = listSkills();
      if (o.json) {
        console.log(JSON.stringify({ dir: skillDir(), files: rows }));
        return;
      }
      for (const r of rows) console.log(`${r.name.padEnd(12)} ${r.summary}`);
    });

  skills
    .command("read [name]")
    .description("Print one skill file (default: the entry, SKILL.md)")
    .action((name?: string) => {
      process.stdout.write(readSkill(name));
    });

  skills
    .command("install")
    .description(
      "Copy the skill to an agent's skills folder; a changed file there is kept unless --force",
    )
    .option("--dir <path>", "skills folder", join(homedir(), ".claude", "skills"))
    .option("--force", "overwrite files that differ")
    .option("--json", "as JSON")
    .action((o: { dir: string; force?: boolean; json?: boolean }) => {
      const out = installSkill(join(o.dir, SKILL_NAME), o.force ? { force: true } : {});
      if (o.json) {
        console.log(JSON.stringify(out));
        return;
      }
      console.log(
        `${out.dest}: ${out.copied.length} copied, ${out.same.length} the same, ${out.kept.length} kept`,
      );
      if (out.kept.length)
        console.log(`  differ, kept (--force to overwrite): ${out.kept.join(" ")}`);
    });
}
