// Build step (U21): the skill into dist/skills/autobrowse, and dist/llms.txt from the built CLI.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
cpSync(new URL(".claude/skills/autobrowse/", root), new URL("skills/autobrowse/", dist), {
  recursive: true,
});
const { listSkills, llmsText } = await import(new URL("skills-pack.js", dist).href);
const tree = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      new URL("app/cli.js", dist).pathname,
      "--help",
      "--json",
      "--all",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ),
);
const catalog = JSON.parse(readFileSync(new URL("catalog.json", root), "utf8"));
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
writeFileSync(new URL("llms.txt", dist), llmsText(tree, listSkills(), catalog, version));
console.log(`skill and llms.txt packed (${listSkills().length} skill files)`);
