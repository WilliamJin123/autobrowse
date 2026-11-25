/**
 * macOS: a headed Chrome that Playwright spawns takes the front on launch and on each new tab,
 * popup or bringToFront. One that LaunchServices starts in the background (`open -g`) may not
 * activate itself until the person clicks into it (measured 11-25: 0 steals in 5 launches).
 * `open` passes no pipe, so this relay stands where Playwright expects the browser: it starts
 * Chrome on a local CDP port, opens the first window inactive and carries the pipe both ways.
 * Run as a script; imports node builtins only (plain node runs it from src or dist).
 * Design: designs/2026-11-25-headed-focus.md
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** On a relay-launched Chrome: the relay's pid. Its parent is launchd, so ppid says nothing. */
export const OWNER_FLAG = "--autobrowse-owner";
/** The browser binary the relay starts (its .app goes to `open`). */
export const REAL_BROWSER_ENV = "AUTOBROWSE_REAL_BROWSER";

/** Playwright's pipe-launch args, made into a port launch owned by `owner`. URLs dropped: no startup window. */
export function relayArgs(args: readonly string[], owner: number): string[] {
  const kept = args.filter(
    (a) =>
      a.startsWith("-") &&
      a !== "--remote-debugging-pipe" &&
      !a.startsWith("--remote-debugging-port") &&
      a !== "--no-startup-window" &&
      !a.startsWith(`${OWNER_FLAG}=`),
  );
  return [...kept, "--remote-debugging-port=0", "--no-startup-window", `${OWNER_FLAG}=${owner}`];
}

/** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` → `/Applications/Google Chrome.app`. */
export function bundleOf(exe: string): string | null {
  const at = exe.indexOf(".app/");
  return at < 0 ? null : exe.slice(0, at + 4);
}

/** The pipe's `\0`-ended messages: the whole ones, and the bytes of an unfinished one. */
export function takeFrames(pending: Buffer, chunk: Buffer): { done: string[]; rest: Buffer } {
  let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const done: string[] = [];
  for (let end = buf.indexOf(0); end >= 0; end = buf.indexOf(0)) {
    done.push(buf.subarray(0, end).toString("utf8"));
    buf = buf.subarray(end + 1);
  }
  return { done, rest: buf };
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The executable Playwright spawns. It writes its args to a file and execs the relay, so `ps`
 * shows no `--user-data-dir` on the relay (profile lookups find Chrome only). Fds 3 and 4 pass through exec.
 */
export function relayShim(dir = join(tmpdir(), "autobrowse")): string {
  const self = fileURLToPath(import.meta.url);
  const mod = join(self, "..", `background-launch${extname(self)}`);
  const body = [
    "#!/bin/sh",
    "f=$(mktemp -t autobrowse-args) || exit 1",
    `printf '%s\\0' "$@" > "$f"`,
    `exec ${shQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shQuote(mod)} "$f"`,
    "",
  ].join("\n");
  const path = join(
    dir,
    `chrome-relay-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.sh`,
  );
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}`;
    writeFileSync(tmp, body);
    chmodSync(tmp, 0o755);
    renameSync(tmp, path); // whole or absent: a parallel launch never runs half a file
  }
  return path;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  process.stderr.write(`autobrowse background launch: ${msg}\n`);
  process.exit(1);
}

/** One CDP connection: calls by id; other messages to `onEvent`. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((ok, no) => {
    ws.onopen = () => ok();
    ws.onerror = () => no(new Error(`no CDP at ${url}`));
  });
  let id = 0;
  const waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data)) as { id?: number };
    if (d.id !== undefined) waiting.get(d.id)?.(d as never);
  };
  return {
    ws,
    async call<T>(method: string, params: object = {}): Promise<T> {
      const i = ++id;
      const r = await new Promise<{ result?: unknown; error?: { message: string } }>((ok) => {
        waiting.set(i, ok);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
      waiting.delete(i);
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result as T;
    },
  };
}

/** Stops `chrome` once `owner` is gone, even after a SIGKILL of the relay's process group. */
function watchdog(owner: number, chrome: number): void {
  const sh = `while kill -0 ${owner} 2>/dev/null; do sleep 1; done; ps -p ${chrome} -o command= | grep -q -- "${OWNER_FLAG}=${owner}" && kill ${chrome}`;
  spawn("/bin/sh", ["-c", sh], { detached: true, stdio: "ignore" }).unref();
}

async function main(argsFile: string): Promise<void> {
  const args = readFileSync(argsFile, "utf8").split("\0").filter(Boolean);
  rmSync(argsFile, { force: true });
  const exe = process.env[REAL_BROWSER_ENV] ?? fail(`${REAL_BROWSER_ENV} unset`);
  const bundle = bundleOf(exe) ?? fail(`${exe} is not inside an .app`);
  const dir =
    args.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ??
    fail("no --user-data-dir");
  const portFile = join(dir, "DevToolsActivePort");
  rmSync(portFile, { force: true }); // a dead run's port
  // LaunchServices drops our env; TZ is the one a launch sets (exit timezones)
  const env = process.env.TZ ? ["--env", `TZ=${process.env.TZ}`] : [];
  const stopStray = () =>
    execFile("pkill", ["-f", "--", `${OWNER_FLAG}=${process.pid}`], () => undefined);
  await new Promise<void>((ok) =>
    execFile(
      "open",
      ["-g", "-n", "-a", bundle, ...env, "--args", ...relayArgs(args, process.pid)],
      (err) => (err ? fail(`open: ${err.message}`) : ok()),
    ),
  );
  let line = "";
  for (let i = 0; i < 1200 && !line.includes("\n"); i++) {
    await wait(25);
    line = existsSync(portFile) ? readFileSync(portFile, "utf8") : "";
  }
  if (!line.includes("\n")) {
    stopStray();
    fail("Chrome wrote no DevToolsActivePort in 30 s");
  }
  const [port, path] = line.split("\n");
  const url = `ws://127.0.0.1:${port}${path}`;
  // own connection for setup: its ids never meet Playwright's
  const setup = await connect(url).catch((e: Error) => {
    stopStray();
    return fail(e.message);
  });
  const info = await setup.call<{ processInfo: Array<{ type: string; id: number }> }>(
    "SystemInfo.getProcessInfo",
  );
  const chrome = info.processInfo.find((p) => p.type === "browser")?.id ?? 0;
  if (chrome) watchdog(process.pid, chrome);
  // the first window, inactive: a foreground first window takes the front even from open -g
  await setup.call("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
    background: true,
  });
  setup.ws.close();

  const cdp = new WebSocket(url);
  await new Promise<void>((ok) => {
    cdp.onopen = () => ok();
    cdp.onerror = () => fail("relay connection refused");
  });
  const fromPw = new Socket({ fd: 3, readable: true, writable: false });
  const toPw = new Socket({ fd: 4, readable: false, writable: true });
  toPw.on("error", () => undefined);
  let shutting = false;
  const shutdown = (code: number) => {
    if (shutting) return;
    shutting = true;
    try {
      cdp.send(JSON.stringify({ id: -1, method: "Browser.close" }));
    } catch {
      // closed already
    }
    setTimeout(() => {
      if (chrome) {
        try {
          process.kill(chrome, "SIGTERM");
        } catch {
          // gone
        }
      }
      process.exit(code);
    }, 3_000).unref();
  };
  cdp.onmessage = (m) => toPw.write(`${String(m.data)}\0`);
  cdp.onclose = () => {
    shutting = true;
    toPw.end(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  let pending: Buffer = Buffer.alloc(0);
  fromPw.on("data", (chunk: Buffer) => {
    const { done, rest } = takeFrames(pending, chunk);
    pending = rest;
    for (const msg of done) cdp.send(msg);
  });
  fromPw.on("end", () => shutdown(0));
  fromPw.on("error", () => shutdown(1));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => shutdown(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv[2] ?? fail("no args file")).catch((e: Error) => fail(e.message));
}
