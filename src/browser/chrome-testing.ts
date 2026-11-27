/**
 * Chrome for Testing: the `chrome` engine's build on a Mac (engines.ts). Google's last-known-good
 * Stable, one folder per version under TESTING_DIR. The newest two stay: a running browser keeps
 * the one it launched from, the next launch takes the newest.
 */
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { shareFetch } from "../share/fetch.js";
import { TESTING_DIR, testingBinaryIn, testingVersions } from "./engines.js";

const run = promisify(execFile);

export const KNOWN_GOOD =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const KEEP = 2;

export interface ChromeUpdate {
  version: string;
  /** false: already the newest. */
  installed: boolean;
  /** Old versions deleted. */
  removed: string[];
  binary: string;
}

interface KnownGood {
  channels: {
    Stable: { version: string; downloads: { chrome: Array<{ platform: string; url: string }> } };
  };
}

export interface UpdateDeps {
  dir?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** zip → folder; `ditto` keeps the app's signature and links */
  unzip?: (zip: string, dest: string) => Promise<void>;
  /** Command lines of running processes: a version one names stays. */
  processes?: () => Promise<string>;
}

const ditto = async (zip: string, dest: string) => {
  await run("ditto", ["-x", "-k", zip, dest]);
};
const psAll = async () => (await run("ps", ["-axo", "command="], { maxBuffer: 1 << 24 })).stdout;

/** Install the last-known-good Stable if it is new; prune to the newest two. */
export async function updateChrome(o: UpdateDeps = {}): Promise<ChromeUpdate> {
  const dir = o.dir ?? TESTING_DIR;
  const arch = o.arch ?? process.arch;
  const get = o.fetch ?? shareFetch;
  const res = await get(KNOWN_GOOD);
  if (!res.ok) throw new Error(`chrome for testing: ${KNOWN_GOOD} answered ${res.status}`);
  const stable = ((await res.json()) as KnownGood).channels.Stable;
  const platform = arch === "arm64" ? "mac-arm64" : "mac-x64";
  const url = stable.downloads.chrome.find((d) => d.platform === platform)?.url;
  if (!url) throw new Error(`chrome for testing: no ${platform} build of ${stable.version}`);
  const dest = join(dir, stable.version);
  const binary = testingBinaryIn(dest, arch);
  let installed = false;
  if (!existsSync(binary)) {
    mkdirSync(dir, { recursive: true });
    // dot names: `testingVersions` never lists a half-made folder
    const zip = join(dir, `.${stable.version}.zip`);
    const part = join(dir, `.${stable.version}.part`);
    rmSync(part, { recursive: true, force: true });
    try {
      const body = await get(url);
      if (!body.ok || !body.body)
        throw new Error(`chrome for testing: ${url} answered ${body.status}`);
      await pipeline(
        Readable.fromWeb(body.body as unknown as ReadableStream<Uint8Array>),
        createWriteStream(zip),
      );
      await (o.unzip ?? ditto)(zip, part);
      if (!existsSync(testingBinaryIn(part, arch)))
        throw new Error(`chrome for testing: ${url} holds no ${platform} app`);
      rmSync(dest, { recursive: true, force: true });
      renameSync(part, dest);
      installed = true;
    } finally {
      rmSync(zip, { force: true });
      rmSync(part, { recursive: true, force: true });
    }
  }
  const running = await (o.processes ?? psAll)().catch(() => "");
  const removed: string[] = [];
  for (const v of testingVersions(dir).slice(KEEP)) {
    if (v === stable.version || running.includes(join(dir, v))) continue;
    rmSync(join(dir, v), { recursive: true, force: true });
    removed.push(v);
  }
  return { version: stable.version, installed, removed, binary };
}
