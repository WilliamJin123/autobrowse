import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wrenIn } from "./service.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** a fake checkout whose prod-wren.mjs runs `body` */
function checkout(body: string): string {
  dir = mkdtempSync(join(tmpdir(), "wren-in-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/prod-wren.mjs"), body);
  return dir;
}

describe("wrenIn", () => {
  it("returns stdout on exit 0", async () => {
    const wren = wrenIn(checkout(`console.log(JSON.stringify(process.argv.slice(2)));`));
    expect(JSON.parse(await wren(["calls", "upcoming"], 10_000))).toEqual(["calls", "upcoming"]);
  });

  it("fails with the CLI's last lines on a non-zero exit", async () => {
    const wren = wrenIn(checkout(`console.error("no such client"); process.exit(3);`));
    await expect(wren([], 10_000)).rejects.toThrow("exit 3: no such client");
  });

  // 11-16: a timed-out poll left bin/wren's rebuild (build.mjs + esbuild) running; seven piled up
  it("a timeout kills the grandchild too", async () => {
    const co = checkout(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync("kid.pid", String(kid.pid));
      setInterval(() => {}, 1000);
    `);
    const wren = wrenIn(co);
    await expect(wren([], 1500)).rejects.toThrow("took over");
    const kid = Number(readFileSync(join(co, "kid.pid"), "utf8"));
    for (let i = 0; i < 50 && alive(kid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(kid)).toBe(false);
  });
});
