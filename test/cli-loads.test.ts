import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Packages a start must not load: each is used by a few commands and costs every command
 * 30–490 ms (designs/2026-11-05-cli-startup.md). Import them where they are used, with `import()`.
 */
const AT_FIRST_USE = [
  "playwright",
  "playwright-core",
  "undici",
  "nodemailer",
  "libmime",
  "obs-websocket-js",
  "imapflow",
  "@aws-sdk/client-acm",
  "@aws-sdk/client-cloudfront",
  "@aws-sdk/client-ec2",
  "@aws-sdk/client-iam",
  "@aws-sdk/client-route-53",
  "@aws-sdk/client-s3",
];

describe("the CLI", () => {
  // Every command registers at start: a clash (two `steps`) breaks every command, not one.
  it("loads with every command registered, and no package that waits for first use", async () => {
    const probe = fileURLToPath(new URL("./startup-probe.mjs", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)("pnpm", ["-s", "autobrowse", "--help"], {
      // CI has no .env: the one required setting, so start-up gets to registering.
      env: {
        RESTATE_INGRESS_URL: "http://localhost:8080",
        ...process.env,
        NO_COLOR: "1",
        NODE_OPTIONS: `--import ${probe}`,
      },
    });
    expect(stdout).toContain("watched");
    const line = stderr.split("\n").find((l) => l.startsWith("LOADED "));
    const loaded = JSON.parse(line?.slice(7) ?? "null") as string[];
    expect(loaded).toContain("commander");
    expect(loaded.filter((p) => AT_FIRST_USE.includes(p))).toEqual([]);
  }, 60_000);
});
