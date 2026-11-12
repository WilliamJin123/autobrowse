import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExplore } from "../src/explore/server.js";

describe("explore --look-only", () => {
  let dir: string;
  let port: number;
  let done: Promise<void>;
  let token: string;
  const send = async (cmd: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "explore-look-"));
    port = 9700 + Math.floor(Math.random() * 100);
    ({ done, token } = await startExplore({
      site: "scratch",
      port,
      lookOnly: true,
      tokenFile: join(dir, "explore.token"),
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    }));
  }, 30_000);
  afterAll(async () => {
    await send({ cmd: "close" }).catch(() => undefined);
    await done;
    expect(existsSync(join(dir, "explore.token"))).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("reads and goes to URLs; refuses a click, a script and a batch step that acts", async () => {
    const page = `data:text/html,${encodeURIComponent("<button onclick=\"document.title='hit'\">Go</button>")}`;
    expect((await send({ cmd: "open", url: page })).status).toBe(200);
    const { aria } = (await send({ cmd: "aria" })).body as { aria: string };
    expect(aria).toMatch(/button "Go"/);
    for (const cmd of [
      { cmd: "click", hints: { role: "button", name: "Go" } },
      { cmd: "eval", js: "document.title='x'" },
    ]) {
      const r = await send(cmd);
      expect(JSON.stringify(r.body)).toMatch(/refused, this session is look-only/);
    }
    const b = (
      await send({
        cmd: "batch",
        cmds: [{ cmd: "url" }, { cmd: "click", hints: { role: "button", name: "Go" } }],
      })
    ).body as { failed?: { at: number; error: string } };
    expect(b.failed).toMatchObject({ at: 1 });
    expect(b.failed?.error).toMatch(/look-only/);
    expect(JSON.stringify((await send({ cmd: "text" })).body)).not.toMatch(/hit/);
  }, 60_000);
});
