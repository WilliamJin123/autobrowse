/**
 * `studio` on the desk: wren's video editor work that needs this Mac (designs/2026-10-06-video-
 * editor.md in wren, step 4). `studio/render` is one render the Videos page asked for:
 * `wren video render <id> --cut [--only <part>] [--again]` against prod, which writes its own state on the
 * row. While the Mac is off the call waits in Restate. `watchRecordings` runs `wren video watch` every minute:
 * each finished OBS or Cap recording becomes a video, once. `creatorFind` / `creatorRead`: Studio's
 * Add creator (wren WA-1416 D2): `creator find --request`, then reads of what it tracked.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";

export const STUDIO_SERVICE = "studio";

/** A long talk renders in well under this; past it something hangs. */
const RENDER_MS = 2 * 3600_000;
const WATCH_MS = 60_000;
/** a find: a few searches and one Haiku pick */
const FIND_MS = 10 * 60_000;
/** reads of one person's accounts, then their pictures */
const READ_MS = 30 * 60_000;

/** The reading logins `creator refresh` takes on this Mac (wren docs/operations.md); never the bare `instagram`. */
export const READ_ACCOUNTS = ["--account", "x=x@wren", "--account", "linkedin=linkedin@wren"];

export const findArgs = (id: number) => [
  "creator",
  "find",
  "--request",
  String(id),
  ...READ_ACCOUNTS,
  "--json",
];
export const readArgs = (ids: number[]) => [
  "creator",
  "refresh",
  ...ids.flatMap((i) => ["--id", String(i)]),
  ...READ_ACCOUNTS,
  "--json",
];
export const pictureArgs = (ids: number[]) => [
  "creator",
  "pictures",
  ...ids.flatMap((i) => ["--id", String(i)]),
];

/** the creator ids a find tracked: `track` in its JSON (the CLI may print lines before it) */
export function trackedIds(out: string): number[] {
  const at = out.indexOf("{");
  if (at < 0) return [];
  try {
    const j = JSON.parse(out.slice(at)) as { track?: unknown };
    return Array.isArray(j.track) ? j.track.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export type Wren = (args: string[], timeoutMs: number) => Promise<string>;

/**
 * The wren checkout the desk runs: `AUTOBROWSE_WREN_CHECKOUT`, else `wren-desk` in the workspace
 * (a worktree on origin/main that the desk's deploy agent keeps current), else `wren`. The main
 * `wren` checkout is where sessions edit, so its tree can be behind or half changed.
 */
export function wrenCheckout(workspace: string, env = process.env): string {
  if (env.AUTOBROWSE_WREN_CHECKOUT) return env.AUTOBROWSE_WREN_CHECKOUT;
  const desk = join(workspace, "wren-desk");
  return existsSync(join(desk, "scripts/prod-wren.mjs")) ? desk : join(workspace, "wren");
}

/** Process groups of live wren calls; killed when the desk exits (detached: launchd no longer reaches them). */
const liveGroups = new Set<number>();
const killGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
  } catch {}
};
process.on("exit", () => {
  for (const pid of liveGroups) killGroup(pid, "SIGKILL");
});

/**
 * `node scripts/prod-wren.mjs <args>` in one wren checkout (`wrenCheckout`).
 * Own process group: a timeout kills bin/wren's rebuild (build.mjs, esbuild) too. With a plain
 * execFile only node died; 11-16 seven orphaned rebuilds held ~5.5 GB.
 */
export const wrenIn =
  (checkout: string): Wren =>
  (args, timeoutMs) =>
    new Promise((ok, fail) => {
      const p = spawn("node", ["scripts/prod-wren.mjs", ...args], {
        cwd: checkout,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = p.pid;
      if (pid) liveGroups.add(pid);
      let stdout = "";
      let stderr = "";
      let killed = false;
      p.stdout.on("data", (d) => {
        stdout += d;
      });
      p.stderr.on("data", (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      const timer = setTimeout(() => {
        killed = true;
        if (!pid) return;
        killGroup(pid, "SIGTERM");
        setTimeout(() => killGroup(pid, "SIGKILL"), 5000).unref();
      }, timeoutMs);
      p.on("error", (err) => {
        clearTimeout(timer);
        if (pid) liveGroups.delete(pid);
        fail(err);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (pid) liveGroups.delete(pid);
        if (code === 0 && !killed) return ok(stdout);
        const why = killed ? `took over ${timeoutMs / 60_000} minutes` : `exit ${code}`;
        // The CLI's last lines say what broke.
        fail(new Error(`${why}: ${(stderr || stdout).trim().slice(-400)}`));
      });
    });

/** What `render --only` takes: one format, or the Shorts or thumbnails alone (wren's RENDER_PARTS). */
export const RENDER_PARTS = ["long", "vertical", "square", "portrait", "shorts", "thumbs"] as const;
export type RenderPart = (typeof RENDER_PARTS)[number];

/**
 * A render narrowed to one part (`only`) draws just that; with none it draws what changed.
 * `again` draws every output again, changed or not.
 */
export const renderArgs = (id: number, only?: RenderPart, again?: boolean) => [
  "video",
  "render",
  String(id),
  "--cut",
  ...(only ? ["--only", only] : []),
  ...(again ? ["--again"] : []),
];

export function studioService(wren: Wren, name: string = STUDIO_SERVICE) {
  // a failed read lands on its creator row (read_error); pictures are best effort
  const readAll = (ctx: restate.Context, ids: number[]) =>
    ctx.run("read", async () => {
      await wren(readArgs(ids), READ_MS).catch((err: Error) => {
        throw new restate.TerminalError(`creator refresh: ${err.message}`);
      });
      await wren(pictureArgs(ids), READ_MS).catch(() => undefined);
    });
  return restate.service({
    name,
    handlers: {
      render: async (ctx: restate.Context, raw: unknown): Promise<{ ms: number }> => {
        const r = z
          .object({
            id: z.number().int().positive(),
            only: z.enum(RENDER_PARTS).optional(),
            again: z.boolean().optional(),
          })
          .safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        return ctx.run("render", async () => {
          const t0 = Date.now();
          // A failed render is reported, not retried: the page shows why, and Render again.
          await wren(renderArgs(r.data.id, r.data.only, r.data.again), RENDER_MS).catch(
            (err: Error) => {
              throw new restate.TerminalError(`render: ${err.message}`);
            },
          );
          return { ms: Date.now() - t0 };
        });
      },
      // The CLI writes the find's state on its row; a failure here is reported, not retried.
      creatorFind: async (ctx: restate.Context, raw: unknown): Promise<{ track: number[] }> => {
        const r = z.object({ id: z.number().int().positive() }).safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        const track = await ctx.run("find", async () =>
          trackedIds(
            await wren(findArgs(r.data.id), FIND_MS).catch((err: Error) => {
              throw new restate.TerminalError(`creator find: ${err.message}`);
            }),
          ),
        );
        if (track.length) await readAll(ctx, track);
        return { track };
      },
      creatorRead: async (ctx: restate.Context, raw: unknown): Promise<{ ids: number[] }> => {
        const r = z
          .object({ ids: z.array(z.number().int().positive()).min(1).max(50) })
          .safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        await readAll(ctx, r.data.ids);
        return { ids: r.data.ids };
      },
    },
    // A render runs for minutes; Restate's default 10 minute abort would cut it off.
    options: { inactivityTimeout: RENDER_MS, abortTimeout: RENDER_MS },
  });
}

/** `wren video watch` every minute, one at a time; a failure is logged and the next minute tries. */
export function watchRecordings(wren: Wren, log: (msg: string) => void): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const out = (await wren(["video", "watch"], 3600_000)).trim();
      if (out && !out.startsWith("no OBS profile")) log(out);
    } catch (err) {
      log(`video watch: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), WATCH_MS);
  return () => clearInterval(t);
}
