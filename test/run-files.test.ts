import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileField, resolveFile, shipPlanFiles, sweepFileCache } from "../src/browser/run-files.js";

describe("run files", () => {
  it("ships only the local files a plan names, keyed by content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rf-"));
    const file = join(dir, "pfp.png");
    await writeFile(file, "png-bytes");
    const puts: string[] = [];
    const store = {
      put: async (key: string) => {
        puts.push(key);
        return `s3://b/${key}`;
      },
    };
    const r = await shipPlanFiles(
      { photo: file, name: "Wren", missing: "/nope/x.png", list: [file] },
      store,
    );
    const plan = r.plan as Record<string, unknown>;
    expect(plan.photo).toMatch(/^s3:\/\/b\/inputs\/[0-9a-f]{24}\.png$/);
    expect(plan.name).toBe("Wren");
    expect(plan.missing).toBe("/nope/x.png");
    expect((plan.list as string[])[0]).toBe(plan.photo);
    expect(new Set(puts).size).toBe(1);
  });

  const sha24 = (b: string) => createHash("sha256").update(b).digest("hex").slice(0, 24);
  const body = (b: string) => () =>
    Promise.resolve(new Response(b).body as ReadableStream<Uint8Array>);

  it("brings a ref back once, cached by owner and content", async () => {
    const cache = await mkdtemp(join(tmpdir(), "rf-cache-"));
    const ref = `s3://b/inputs/owners/o1/${sha24("gif-bytes")}.gif`;
    let reads = 0;
    const s3 = () => {
      reads++;
      return body("gif-bytes")();
    };
    const path = await resolveFile(ref, { s3, cache });
    expect(path).toBe(join(cache, "o1", `${sha24("gif-bytes")}.gif`));
    expect(await readFile(path, "utf8")).toBe("gif-bytes");
    expect(await resolveFile(ref, { s3, cache })).toBe(path);
    expect(reads).toBe(1);
    expect(await resolveFile("/kept/as/is.png", { cache })).toBe("/kept/as/is.png");
  });

  it("refuses bytes that do not match the name's hash, and leaves no part file", async () => {
    const cache = await mkdtemp(join(tmpdir(), "rf-cache-"));
    const ref = `s3://b/inputs/owners/o1/${sha24("real")}.png`;
    await expect(resolveFile(ref, { s3: body("swapped"), cache })).rejects.toThrow("sha256");
    expect(await readdir(join(cache, "o1"))).toEqual([]);
  });

  it("keys a URL whole, and keeps the URL out of errors", async () => {
    const cache = await mkdtemp(join(tmpdir(), "rf-cache-"));
    let reads = 0;
    const ok = (async () => {
      reads++;
      return new Response("mp4");
    }) as unknown as typeof fetch;
    const a = await resolveFile("https://h/v.mp4?sig=1", { fetch: ok, cache });
    expect(await resolveFile("https://h/v.mp4?sig=1", { fetch: ok, cache })).toBe(a);
    expect(await resolveFile("https://h/v.mp4?sig=2", { fetch: ok, cache })).not.toBe(a);
    expect(reads).toBe(2);
    expect(a).toMatch(/_url\/[0-9a-f]{24}\.mp4$/);
    const no = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    const err = await resolveFile("https://h/x.mp4?sig=secret", { fetch: no, cache }).catch(
      (e) => e,
    );
    expect(String(err)).toContain("403");
    expect(String(err)).not.toContain("secret");
  });

  it("sweeps files unused past a day, then the oldest past the cap", async () => {
    const cache = await mkdtemp(join(tmpdir(), "rf-cache-"));
    await mkdir(join(cache, "o1"));
    const now = Date.now();
    const put = async (name: string, ageMs: number, bytes: number) => {
      const at = new Date(now - ageMs);
      await writeFile(join(cache, "o1", name), "x".repeat(bytes));
      await utimes(join(cache, "o1", name), at, at);
    };
    await put("stale.png", 25 * 3600_000, 1);
    await put("old.png", 2 * 3600_000, 6);
    await put("new.png", 1000, 6);
    expect(await sweepFileCache({ cache, now, maxBytes: 10 })).toBe(2);
    expect(await readdir(join(cache, "o1"))).toEqual(["new.png"]);
  });

  it("types a file field: a ref, a URL or a path", () => {
    const f = fileField("photo");
    expect(f.safeParse("s3://b/k.png").success).toBe(true);
    expect(f.safeParse("https://h/k.png").success).toBe(true);
    expect(f.safeParse("assets/me.png").success).toBe(true);
    expect(f.safeParse("ftp://h/k.png").success).toBe(false);
    expect(f.safeParse("").success).toBe(false);
  });
});

describe("temp dir reaper", () => {
  it("removes only our stale dirs", async () => {
    const { reapTempDirs } = await import("../src/browser/reap.js");
    const root = await mkdtemp(join(tmpdir(), "reap-"));
    for (const d of ["run-files-old", "run-files-new", "other-old"]) await mkdir(join(root, d));
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(join(root, "run-files-old"), old, old);
    await utimes(join(root, "other-old"), old, old);
    expect(await reapTempDirs({ dir: root })).toBe(1);
    expect((await readdir(root)).sort()).toEqual(["other-old", "run-files-new"]);
  });
});
