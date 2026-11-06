/**
 * Where a credential the tool minted goes: the local `.env` (0600, one
 * key upserted, the running process updated too so lazy deps see it) or
 * SSM in production. The counterpart of `SecretSource`. A minted token
 * that lapses says when (`expiresAt`), so `needs` reopens its row in time.
 */
import { createHash } from "node:crypto";
import { envFileStore, type PutOptions, WouldReplace } from "credvault";

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

/** A name that holds another value than the one about to be written. Never the value. */
export interface Held {
  name: string;
  length: number;
  /** Where it is held: "the store", or an env file's path. */
  where: string;
  /** When the held value was set, when the store says. */
  since?: string | null;
  expiresAt?: string | null;
}

export const heldLine = (h: Held): string =>
  `  ${h.name} in ${h.where}: ${h.length} chars${h.since ? `, set ${h.since}` : ""}${h.expiresAt ? `, lapses ${h.expiresAt}` : ""}`;

/**
 * Phase one of a replace: what would go, then yes or no (WA-1124, WA-1126;
 * credvault designs/2026-11-05-no-silent-overwrite.md). `yes` is the same action with the confirmation.
 * 2026-11-05: an agent's `keep` replaced a live Cloudflare token twice with no question.
 */
export function replaceQuestion(held: Held[], yes: string): string {
  const first = held[0]?.name ?? "NAME";
  return [
    "Nothing was written. This would replace a value already held:",
    ...held.map(heldLine),
    "Every reader of the name gets the new value; a key that works for them now may stop.",
    "Is that intended?",
    `  yes: ${yes}`,
    "  no: do nothing, or keep both: store the new value under another name.",
    `Say yes only when the person said so in this conversation, or this session made the held value. The way back: autobrowse env history ${first}`,
  ].join("\n");
}

/** A store's refusal as the question. */
export const questionOf = (err: WouldReplace, yes: string): string =>
  replaceQuestion([{ name: err.key, length: err.heldLength, where: err.where }], yes);

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
    // The store's rule, so a test meets the refusal a live store gives.
    async put(name, value, o) {
      const held = values[name];
      if (held !== undefined && held !== value && !o?.replace)
        throw new WouldReplace(name, held.length);
      values[name] = value;
      if (o?.expiresAt) expires[name] = o.expiresAt;
      else delete expires[name];
    },
  };
}
