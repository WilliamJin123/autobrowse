/**
 * Where a credential the tool minted goes: the local `.env` (0600, one
 * key upserted, the running process updated too so lazy deps see it) or
 * SSM in production. The counterpart of `SecretSource`. A minted token
 * that lapses says when (`expiresAt`), so `needs` reopens its row in time.
 */
import { createHash } from "node:crypto";
import { envFileStore, type PutOptions } from "credvault";

export interface SecretSink {
  put(name: string, value: string, o?: PutOptions): Promise<void>;
  /** What the name holds now. A sink without it cannot refuse a replace. */
  get?(name: string): Promise<string | null>;
}

/** Eight hex of a value's hash: names a value, never shows it. `env history` prints the same mark. */
export const valueMark = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

/** The value a put of `value` under `name` would replace; null when the name is free or holds the same. */
export async function heldOther(
  sink: Pick<SecretSink, "get">,
  name: string,
  value: string,
): Promise<string | null> {
  const held = (await sink.get?.(name)) ?? null;
  return held === null || held === value ? null : held;
}

/** A name that holds another value than the one about to be written. */
export interface Clash {
  name: string;
  held: string;
  /** Where it is held: "the store", or an env file's path. */
  where: string;
}

/**
 * What a refused replace says (WA-1124, credvault designs/2026-11-05-no-silent-overwrite.md).
 * 2026-11-05: an agent's `keep` replaced a live Cloudflare token twice with no warning.
 */
export function replaceWarning(clashes: Clash[], confirm: string): string {
  const first = clashes[0]?.name ?? "NAME";
  return [
    "STOP: nothing was written. Another value is already held:",
    ...clashes.map(
      (c) => `  ${c.name} in ${c.where}: mark ${valueMark(c.held)}, ${c.held.length} chars`,
    ),
    "A replace takes the held value from every reader of the name: a working key stops working for them.",
    "Keep both: store the new value under another name.",
    `Replace only when the person said so in this conversation, or this session minted the held value: ${confirm}`,
    `The way back after a wrong replace: autobrowse env history ${first} (a value only in an env file has no history).`,
  ].join("\n");
}

/** The marks a person confirmed (`a1b2c3d4,…`); the clashes none of them covers. */
export function unconfirmed(clashes: Clash[], replace: string | undefined): Clash[] {
  const ok = new Set((replace ?? "").split(",").map((m) => m.trim()));
  return clashes.filter((c) => !ok.has(valueMark(c.held)));
}

/** Upsert `NAME=value` in an env file; other lines untouched; also sets `process.env` so this process sees it. */
export function envFileSink(path: string, env: NodeJS.ProcessEnv = process.env): SecretSink {
  return envFileStore(path, env);
}

export function memorySink(): SecretSink & {
  values: Record<string, string>;
  expires: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const expires: Record<string, string> = {};
  return {
    values,
    expires,
    get: async (name) => values[name] ?? null,
    async put(name, value, o) {
      values[name] = value;
      if (o?.expiresAt) expires[name] = o.expiresAt;
      else delete expires[name];
    },
  };
}
