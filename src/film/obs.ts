/**
 * OBS drives the screen films: `autobrowse obs start|stop|status` over obs-websocket (OBS 28+).
 * OBS's own scene, output folder and format; we only press Record and Stop.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { newObs, type Obs } from "../calls/obs.js";

const run = promisify(execFile);

/** Where OBS keeps its websocket settings on a Mac. */
export const OBS_WEBSOCKET_CONFIG = join(
  homedir(),
  "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json",
);

export interface ObsLogin {
  url: string;
  password?: string;
}

/** The login from OBS's own config; `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD` win. */
export function obsLogin(config: string | null, env: NodeJS.ProcessEnv): ObsLogin {
  const c = config
    ? (JSON.parse(config) as {
        server_enabled?: boolean;
        server_port?: number;
        auth_required?: boolean;
        server_password?: string;
      })
    : null;
  if (c && c.server_enabled === false && !env.OBS_WEBSOCKET_URL)
    throw new Error("obs: its websocket is off (OBS: Tools, WebSocket Server Settings, Enable)");
  const url = env.OBS_WEBSOCKET_URL ?? `ws://127.0.0.1:${c?.server_port ?? 4455}`;
  const password = env.OBS_WEBSOCKET_PASSWORD ?? (c?.auth_required ? c.server_password : undefined);
  return password ? { url, password } : { url };
}

const CONNECT_MS = 20_000;

/** A connected client; opens OBS (in the background) when it is not running. */
async function connect(): Promise<Obs> {
  if (process.platform !== "darwin" && !process.env.OBS_WEBSOCKET_URL)
    throw new Error("obs: set OBS_WEBSOCKET_URL off macOS");
  const config = existsSync(OBS_WEBSOCKET_CONFIG)
    ? await readFile(OBS_WEBSOCKET_CONFIG, "utf8")
    : null;
  const login = obsLogin(config, process.env);
  const obs = await newObs();
  const until = Date.now() + CONNECT_MS;
  let opened = false;
  for (;;) {
    try {
      await obs.connect(login.url, login.password);
      // OBS answers 207 "not ready" until its scenes load: just after a launch.
      while (
        (await obs.call("GetSceneList").then(
          () => 0,
          (e: { code?: number }) => e.code,
        )) === 207
      ) {
        if (Date.now() > until) throw new Error("obs: OBS did not finish starting");
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return obs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth/i.test(msg)) throw new Error(`obs: the websocket refused the password (${msg})`);
      if (Date.now() > until) throw new Error(`obs: no answer at ${login.url} (${msg})`);
      if (!opened && process.platform === "darwin") {
        opened = true;
        await run("open", ["-g", "-a", "OBS"]).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

async function using<T>(fn: (obs: Obs) => Promise<T>): Promise<T> {
  const obs = await connect();
  try {
    return await fn(obs);
  } finally {
    await obs.disconnect().catch(() => undefined);
  }
}

export async function obsStart(o: { scene?: string } = {}): Promise<{ scene: string }> {
  return using(async (obs) => {
    if (o.scene) await obs.call("SetCurrentProgramScene", { sceneName: o.scene });
    const { currentProgramSceneName } = await obs.call("GetCurrentProgramScene");
    const { outputActive } = await obs.call("GetRecordStatus");
    if (outputActive) throw new Error("obs: it is recording already; `autobrowse obs stop` first");
    await obs.call("StartRecord");
    return { scene: currentProgramSceneName };
  });
}

/** Stop; `out` moves the file OBS wrote there, with OBS's extension. */
export async function obsStop(o: { out?: string } = {}): Promise<{ path: string }> {
  const written = await using(async (obs) => {
    const { outputActive } = await obs.call("GetRecordStatus");
    if (!outputActive) throw new Error("obs: it is not recording");
    return (await obs.call("StopRecord")).outputPath;
  });
  if (!o.out) return { path: written };
  // OBS's format wins: an .mkv moved to demo.mp4 stays an .mkv, as demo.mkv
  const out = o.out.replace(/(\.[^./]+)?$/, extname(written));
  await mkdir(dirname(out), { recursive: true });
  await rename(written, out).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EXDEV") throw err;
    await copyFile(written, out);
    await rm(written);
  });
  return { path: out };
}

export async function obsStatus(): Promise<{
  recording: boolean;
  seconds: number;
  scene: string;
  scenes: string[];
}> {
  return using(async (obs) => {
    const [s, cur, list] = await Promise.all([
      obs.call("GetRecordStatus"),
      obs.call("GetCurrentProgramScene"),
      obs.call("GetSceneList"),
    ]);
    return {
      recording: s.outputActive,
      seconds: Math.round(s.outputDuration / 1000),
      scene: cur.currentProgramSceneName,
      scenes: list.scenes.map((x) => String(x.sceneName)),
    };
  });
}
