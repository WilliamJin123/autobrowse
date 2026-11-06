/**
 * `autobrowse env …`: secrets in and out of the store (SSM) from any
 * machine with AWS access. Values never land in argv or on the screen
 * unless asked: the clipboard (cleared after a minute; Universal Clipboard
 * carries it to a phone), `export` lines for `eval`, or a 0600 env file.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  type EnvEntry,
  type EnvListing,
  type EnvStore,
  isProjectedName,
  parseDotenv,
  parseVendorKeyName,
  toDotenv,
  toExports,
  upsertDotenv,
} from "credvault";
import { type Held, heldLine, replaceQuestion, valueMark } from "../deps/sink.js";
import { expandHome } from "../google/auth.js";
import { isDefaultOwner } from "../owner.js";
import type { Settings } from "./config.js";
import type { EnvVersion } from "./services-keys.js";
import { editSetting, isSettingName, settingsPath } from "./settings-file.js";

export interface EnvCliDeps {
  store: () => EnvStore;
  /** Put text on the clipboard and clear it after `clearAfterMs` if still there. */
  clipboard?: (text: string, clearAfterMs: number) => Promise<void>;
  say?: (line: string) => void;
  out?: (text: string) => void;
  /** What is on the clipboard, for `set --clipboard`. */
  paste?: () => Promise<string>;
  /** Each version of one name the store still holds, oldest first. */
  versions?: (name: string) => Promise<EnvVersion[]>;
  /** The vault key that fills an env name (`cloudflare@pages`), or null. Absent: not checked. */
  filledBy?: (name: string) => Promise<string | null>;
}

const heldInStore = (name: string, value: string, row?: EnvListing): Held => ({
  name,
  length: value.length,
  where: "the store",
  since: row?.updatedAt ?? null,
  expiresAt: row?.expiresAt ?? null,
});

/** Says which versions hold the same value, never the value. */
const mark = valueMark;

interface PullOptions {
  out: string;
  export?: boolean;
  stdout?: boolean;
  confirm?: boolean;
}

interface SetOptions {
  clipboard?: boolean;
  out: string;
  storeOnly?: boolean;
  confirm?: boolean;
}

const CONFIRM_FLAG = [
  "--confirm",
  "yes to the question the first run asked: replace the value a name holds",
] as const;

/** Two phases: the first run asks and writes nothing; the same command with --confirm is the yes. */
function askFirst(held: Held[], confirm: boolean | undefined, again: string): void {
  if (held.length && !confirm) throw new Error(replaceQuestion(held, `${again} --confirm`));
}

/** The name's value in an env file; null when the file or the name is absent. */
const localValue = (file: string, name: string): string | null =>
  existsSync(file)
    ? (parseDotenv(readFileSync(file, "utf8")).find((e) => e.name === name)?.value ?? null)
    : null;

/** A secret on the clipboard: 5 min, then emptied if untouched (William, 2026-11-06: 1 min too short). */
export const CLIPBOARD_MS = 5 * 60_000;

/**
 * Why `env set`/`env rm` refuse `name`, or null. API key names are the vault's
 * projection (`creds key`): a hand-set value would be overwritten, or would
 * split the env from the vault. `get` and `pull` still read them.
 */
export function projectedRefusal(name: string): string | null {
  if (!isProjectedName(name)) return null;
  const vendor = parseVendorKeyName(name)?.vendor;
  return vendor
    ? `${name} is an API key name: keys live in the vault. autobrowse creds key add ${vendor}@<label> --clipboard`
    : `${name} is set by the projection from the vault's ${name.replace(/^NUM_/, "").toLowerCase().replace(/_/g, "-")} keys`;
}

/** macOS: pbcopy now, and a detached shell that empties it after `clearAfterMs` only if it still holds this value (compared by hash). */
export async function macClipboard(text: string, clearAfterMs: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("clipboard needs macOS; use --print or pull");
  await new Promise<void>((res, rej) => {
    const p = execFile("pbcopy", (err) => (err ? rej(err) : res()));
    p.stdin?.end(text);
  });
  const hash = createHash("sha256").update(text).digest("hex");
  const secs = Math.ceil(clearAfterMs / 1000);
  spawn(
    "sh",
    [
      "-c",
      `sleep ${secs}; [ "$(pbpaste | shasum -a 256 | cut -d' ' -f1)" = "${hash}" ] && pbcopy </dev/null`,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

/** Names that describe the machine, not the fleet: a blanket `pull` leaves them alone. */
export const MACHINE_LOCAL = new Set([
  "CREDENTIALS_CIPHER",
  "BROWSER",
  "BROWSER_HEADLESS",
  "SENTRY_ENVIRONMENT",
]);

export function registerEnvCommands(program: Command, settings: Settings, deps: EnvCliDeps): void {
  const say = deps.say ?? ((l: string) => console.log(l));
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const clipboard = deps.clipboard ?? macClipboard;
  // Only the default owner's store feeds the box; an owner's worker reads its own at boot.
  const boxHint = () => {
    if (isDefaultOwner(settings.owner))
      say("the box reads the store on its next deploy (push to main)");
  };
  // A name a vault key fills is the projection's: a hand-set value would split env from vault.
  const vaultRefusal = async (name: string): Promise<string | null> => {
    const address = (await deps.filledBy?.(name)) ?? null;
    return address
      ? `${name} is filled by the vault key ${address}. A new value for it: autobrowse creds key rotate ${address} --clipboard. A second key: autobrowse creds key add ${address.split("@")[0]}@<label> --env <NAME> --clipboard`
      : null;
  };
  const env = program
    .command("env")
    .description(
      "Secrets in and out of the store (SSM /autobrowse/config; an owner's /autobrowse/owners/<owner>/config): the same values on every machine and the prod box",
    );

  env
    .command("ls")
    .description("Names in the store, when each changed and when it lapses; never values")
    .action(async () => {
      const rows = await deps.store().list();
      if (!rows.length) return say("(empty)");
      for (const r of rows)
        say(
          `${r.name.padEnd(32)} ${(r.updatedAt ?? "").padEnd(24)} ${r.expiresAt ? `expires ${r.expiresAt}` : ""}`.trimEnd(),
        );
    });

  env
    .command("get <name>")
    .description(
      "One value to the clipboard (emptied after a minute); --print writes it to stdout instead",
    )
    .option("--print", "stdout instead of the clipboard (for a pipe)")
    .action(async (name: string, o: { print?: boolean }) => {
      const value = await deps.store().get(name);
      if (value === null) throw new Error(`${name} is not in the store`);
      if (o.print) return out(value);
      await clipboard(value, CLIPBOARD_MS);
      say(`${name} is on the clipboard for ${CLIPBOARD_MS / 60_000} min`);
    });

  env
    .command("pull [names...]")
    .description(
      'Values from the store into an env file (merged, 0600; default .env), or --export for eval "$(autobrowse env pull --export)"',
    )
    .option("--out <file>", "env file to upsert into", settings.envFile)
    .option("--export", "print `export NAME='…'` lines to stdout instead of writing a file")
    .option("--stdout", "print KEY=VALUE lines to stdout instead of writing a file")
    .option(...CONFIRM_FLAG)
    .action(async (names: string[], o: PullOptions) => {
      const all = await deps.store().all();
      const missing = names.filter((n) => !all.some((e) => e.name === n));
      if (missing.length) throw new Error(`not in the store: ${missing.join(", ")}`);
      const chosen = names.length ? all.filter((e) => names.includes(e.name)) : all;
      // The store is the fleet's; a few names describe THIS machine and a blanket
      // pull would hand it the box's answer (a sealed credential file read as plain).
      let entries = names.length ? chosen : chosen.filter((e) => !MACHINE_LOCAL.has(e.name));
      const kept = chosen.length - entries.length;
      if (o.export) return out(toExports(entries));
      // Settings that are no secret go to settings.json; the env file keeps secrets.
      if (!o.stdout) {
        const settled = entries.filter((e) => isSettingName(e.name));
        for (const e of settled) editSetting(settingsPath(), e.name, e.value);
        if (settled.length)
          say(
            `${settled.length} settings → ${settingsPath()}: ${settled.map((e) => e.name).join(", ")}`,
          );
        entries = entries.filter((e) => !isSettingName(e.name));
      }
      const file = resolve(expandHome(o.out));
      // A multi-line value (a service-account JSON) goes to its own 0600 file beside the env file.
      const sidecars: Array<[string, string]> = [];
      const text = toDotenv(entries, (name, value) => {
        const path = join(dirname(file), `${name.toLowerCase()}.json`);
        sidecars.push([path, value]);
        return path;
      });
      if (o.stdout) return out(text);
      // A file value the store held before is a rotation reaching this machine: it goes.
      // One the store never held exists only here, with no history: that needs a yes.
      const held: Held[] = [];
      for (const e of entries) {
        const local = /[\r\n]/.test(e.value) ? null : localValue(file, e.name);
        if (local === null || local === e.value) continue;
        const before = deps.versions ? await deps.versions(e.name) : [];
        if (!before.some((v) => v.value === local))
          held.push({ name: e.name, length: local.length, where: file });
      }
      askFirst(held, o.confirm, `autobrowse env pull ${names.join(" ")}`.trim());
      await mkdir(dirname(file), { recursive: true });
      for (const [path, value] of sidecars) await writeSecretFile(path, value);
      const current = existsSync(file) ? await readFile(file, "utf8") : "";
      await writeSecretFile(
        file,
        upsertDotenv(
          current,
          entries.map((e) => ({
            name: e.name,
            value: /[\r\n]/.test(e.value)
              ? (sidecars.find(([p]) => p.endsWith(`${e.name.toLowerCase()}.json`))?.[0] ?? "")
              : e.value,
          })),
        ),
      );
      say(
        `${entries.length} value${entries.length === 1 ? "" : "s"} → ${file}: ${entries.map((e) => e.name).join(", ")}`,
      );
      if (kept)
        say(
          `kept this machine's own: ${[...MACHINE_LOCAL].join(", ")} (name one explicitly to pull it anyway)`,
        );
    });

  env
    .command("push [names...]")
    .description(
      "Values from an env file into the store: named ones from .env, or every key of --from <file>",
    )
    .option("--from <file>", "env file to read (default .env; required when no names are given)")
    .option(...CONFIRM_FLAG)
    .action(async (names: string[], o: { from?: string; confirm?: boolean }) => {
      if (!names.length && !o.from)
        throw new Error("name what to push, or --from <file> to push every key in a file");
      const file = resolve(expandHome(o.from ?? settings.envFile));
      if (o.from && !existsSync(file)) throw new Error(`no such file: ${file}`);
      // No .env on this machine yet: every named value has to be in the store already.
      const entries = existsSync(file)
        ? parseDotenv(readFileSync(file, "utf8"), (p) =>
            existsSync(expandHome(p)) ? readFileSync(expandHome(p), "utf8") : null,
          )
        : [];
      const chosen = names.length ? entries.filter((e) => names.includes(e.name)) : entries;
      const missing = names.filter((n) => !chosen.some((e) => e.name === n));
      const store = deps.store();
      if (missing.length) {
        // Not in the file but already in the store (`env set` put it there): nothing to push.
        const there = new Set((await store.list()).map((r) => r.name));
        const absent = missing.filter((n) => !there.has(n));
        if (absent.length)
          throw new Error(
            `not in ${file} or the store: ${absent.join(", ")} (a new one: autobrowse env set NAME --clipboard)`,
          );
        say(`already in the store, not in ${file}: ${missing.join(", ")}`);
      }
      const there = await store.getMany(chosen.map((e) => e.name));
      const rows = new Map((await store.list()).map((r) => [r.name, r]));
      askFirst(
        chosen.flatMap((e) => {
          const held = there[e.name];
          return held === undefined || held === e.value
            ? []
            : [heldInStore(e.name, held, rows.get(e.name))];
        }),
        o.confirm,
        `autobrowse env push ${o.from ? `--from ${o.from}` : names.join(" ")}`,
      );
      for (const e of chosen) await store.put(e.name, e.value, { replace: o.confirm === true });
      if (chosen.length) say(`pushed ${chosen.length}: ${chosen.map((e) => e.name).join(", ")}`);
      boxHint();
    });

  env
    .command("set <name>")
    .description(
      "One new value into the store without a file: --clipboard takes what is copied; otherwise piped stdin, or a hidden prompt",
    )
    .option("--clipboard", "read the value from the clipboard (macOS)")
    .option("--out <file>", "env file that gets it too (merged, 0600)", settings.envFile)
    .option("--store-only", "the store alone, not the local env file")
    .option(...CONFIRM_FLAG)
    .action(async (name: string, o: SetOptions) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an env name: ${name}`);
      const refused = projectedRefusal(name) ?? (await vaultRefusal(name));
      if (refused) throw new Error(refused);
      const value = cleanValue(
        name,
        o.clipboard ? await (deps.paste ?? pasteboard)() : await secretInput(name),
      );
      const store = deps.store();
      const file = resolve(expandHome(o.out));
      const held = await store.get(name);
      const local = o.storeOnly ? null : localValue(file, name);
      const clashes: Held[] = [];
      if (held !== null && held !== value)
        clashes.push(
          heldInStore(
            name,
            held,
            (await store.list()).find((r) => r.name === name),
          ),
        );
      if (local !== null && local !== value && local !== held)
        clashes.push({ name, length: local.length, where: file });
      askFirst(
        clashes,
        o.confirm,
        `autobrowse env set ${name}${o.clipboard ? " --clipboard" : ""}${o.storeOnly ? " --store-only" : ""}`,
      );
      await store.put(name, value, { replace: o.confirm === true });
      say(
        held === null || held === value
          ? `set ${name} in the store (${value.length} chars)`
          : `replaced ${name} in the store (${mark(held)} → ${mark(value)}); the way back: autobrowse env history ${name}`,
      );
      if (!o.storeOnly) {
        await mkdir(dirname(file), { recursive: true });
        const current = existsSync(file) ? await readFile(file, "utf8") : "";
        await writeSecretFile(file, upsertDotenv(current, [{ name, value }]));
        say(`and in ${file}`);
      }
      boxHint();
    });

  env
    .command("expires <name> <when>")
    .description(
      "Record when a value lapses (an ISO date, or `none`) without printing it: for a token minted by hand, or before expiry was kept",
    )
    .action(async (name: string, when: string) => {
      const store = deps.store();
      const value = await store.get(name);
      if (value === null) throw new Error(`${name} is not in the store`);
      const at = when === "none" ? undefined : new Date(when);
      if (at && Number.isNaN(at.getTime())) throw new Error(`not a date: ${when}`);
      await store.put(name, value, at ? { expiresAt: at.toISOString() } : {});
      say(at ? `${name} expires ${at.toISOString()}` : `${name}: no expiry`);
    });

  const versionsOf = async (name: string): Promise<EnvVersion[]> => {
    if (!deps.versions) throw new Error("this store keeps no versions");
    const rows = await deps.versions(name);
    if (!rows.length) throw new Error(`${name} is not in the store`);
    return rows;
  };
  env
    .command("history <name>")
    .description(
      "Each version the store still holds of one value (the newest 100): when it was set, its length and a mark that is the same for the same value; never the value",
    )
    .option("--file <file>", "env file to compare with", settings.envFile)
    .action(async (name: string, o: { file: string }) => {
      const rows = await versionsOf(name);
      const local = localValue(resolve(expandHome(o.file)), name);
      for (const [i, r] of rows.entries())
        say(
          [
            `v${r.version}`.padEnd(5),
            (r.at ?? "").padEnd(24),
            mark(r.value),
            `${r.value.length} chars`.padEnd(10),
            r.expiresAt ? `expires ${r.expiresAt}` : "",
            i === rows.length - 1 ? "← the store now" : "",
            local === r.value ? "← this machine's env file" : "",
          ]
            .filter(Boolean)
            .join("  "),
        );
      if (local !== null && !rows.some((r) => r.value === local))
        say(`this machine's env file holds a value the store never had (${mark(local)})`);
    });

  env
    .command("restore <name> <version>")
    .description(
      "Put an earlier version back, as a new version: the store and the local env file. The value replaced stays in the history",
    )
    .option("--out <file>", "env file that gets it too (merged, 0600)", settings.envFile)
    .option("--store-only", "the store alone, not the local env file")
    .action(async (name: string, version: string, o: { out: string; storeOnly?: boolean }) => {
      const rows = await versionsOf(name);
      const want = rows.find((r) => `v${r.version}` === version || `${r.version}` === version);
      if (!want)
        throw new Error(`${name} has no version ${version}: autobrowse env history ${name}`);
      const now = rows.at(-1);
      // The command names the version: that is the yes. The value it replaces stays in the history.
      if (now && now.value !== want.value)
        await deps.store().put(name, want.value, {
          replace: true,
          ...(want.expiresAt ? { expiresAt: want.expiresAt } : {}),
        });
      say(
        now && now.value === want.value
          ? `${name}: the store already holds v${want.version}'s value`
          : `${name}: v${want.version} (${mark(want.value)}) is back in the store; it replaced v${now?.version} (${now ? mark(now.value) : ""}), which stays in the history`,
      );
      if (!o.storeOnly) {
        const file = resolve(expandHome(o.out));
        await mkdir(dirname(file), { recursive: true });
        const current = existsSync(file) ? await readFile(file, "utf8") : "";
        await writeSecretFile(file, upsertDotenv(current, [{ name, value: want.value }]));
        say(`and in ${file}`);
      }
      boxHint();
    });

  env
    .command("rm <name>")
    .description("Remove one value from the store, with every earlier version of it")
    .option("--confirm", "yes to the question the first run asked")
    .action(async (name: string, o: { confirm?: boolean }) => {
      const refused = projectedRefusal(name) ?? (await vaultRefusal(name));
      if (refused) throw new Error(refused);
      const store = deps.store();
      const held = await store.get(name);
      if (held !== null && !o.confirm)
        throw new Error(
          [
            "Nothing was removed. This would remove a value in use:",
            heldLine(
              heldInStore(
                name,
                held,
                (await store.list()).find((r) => r.name === name),
              ),
            ),
            "Each reader of the name fails after it. The store keeps the last value under removed/, no earlier one.",
            "Is that intended?",
            `  yes: autobrowse env rm ${name} --confirm`,
            "  no: do nothing.",
          ].join("\n"),
        );
      say((await store.remove(name)) ? `removed ${name}` : `${name} was not in the store`);
    });
}

/**
 * A pasted value as it is meant: blank edges gone, a whole `NAME=value`
 * line or surrounding quotes cut down to the value. A multi-line value is
 * only taken when it is JSON (a service-account key).
 */
export function cleanValue(name: string, raw: string): string {
  let v = raw.trim();
  const line = new RegExp(`^(export\\s+)?${name}=`);
  if (line.test(v)) v = v.replace(line, "").trim();
  if (/^(['"]).*\1$/s.test(v)) v = v.slice(1, -1);
  if (!v) throw new Error("empty value; nothing stored");
  if (/[\r\n]/.test(v) && !/^[{[]/.test(v))
    throw new Error("the value has line breaks; copy just the value");
  return v;
}

/** What is on the macOS clipboard. */
export function pasteboard(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("--clipboard needs macOS; pipe it in instead");
  return new Promise((res, rej) =>
    execFile("pbpaste", (err, stdout) => (err ? rej(err) : res(stdout))),
  );
}

/** Piped stdin, or a prompt that echoes nothing. */
export async function secretInput(name: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  stderr.write(`${name} (hidden): `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((res, rej) => {
    let text = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      err ? rej(err) : res(text);
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function writeSecretFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export type { EnvEntry };
