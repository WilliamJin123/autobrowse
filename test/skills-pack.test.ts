import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill, listSkills, llmsText, readSkill } from "../src/skills-pack.js";

describe("the skill in the package (U21)", () => {
  it("lists the skill files, entry first, each with a line", () => {
    const rows = listSkills();
    expect(rows[0]?.name).toBe("autobrowse");
    expect(rows.map((r) => r.name)).toContain("explore");
    expect(rows.every((r) => r.summary.length > 0)).toBe(true);
    expect(readSkill("explore")).toMatch(/Repair rules/);
    expect(() => readSkill("nope")).toThrow(/no skill file/);
  });

  it("installs, then keeps a changed file unless forced", () => {
    const dest = join(mkdtempSync(join(tmpdir(), "skills-")), "autobrowse");
    const first = installSkill(dest);
    expect(first.copied).toContain("SKILL.md");
    expect(first.copied.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(installSkill(dest).copied).toEqual([]);
    writeFileSync(join(dest, "explore.md"), "mine");
    expect(installSkill(dest).kept).toEqual(["explore.md"]);
    expect(readFileSync(join(dest, "explore.md"), "utf8")).toBe("mine");
    expect(installSkill(dest, { force: true }).copied).toEqual(["explore.md"]);
  });

  it("writes llms.txt with the skill, every command and the catalog", () => {
    const text = llmsText(
      {
        name: "autobrowse",
        summary: "",
        commands: [
          {
            name: "skills",
            summary: "the skill",
            commands: [{ name: "list", summary: "files", commands: [] }],
          },
        ],
      },
      listSkills(),
      { routes: [{}] as never, flows: [] as never, workflows: [] as never },
      "9.9.9",
    );
    expect(text).toMatch(/^# autobrowse\n\n> /);
    expect(text).toContain("- [explore](skills/autobrowse/explore.md): ");
    expect(text).toContain("- `autobrowse skills list`: files");
    expect(text).toContain("1 site API routes");
  });
});
