/**
 * Where snapshots live: `<profile>/<version>.sealed` and `<profile>/latest.json` (the pointer)
 * under one prefix. The pointer is written compare-and-swap, so two machines never both think
 * they hold a profile. A folder here (tests, offline); S3 in `src/shots/s3.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotMeta } from "./snapshot.js";

/** The newest version of a profile, and the one machine that may save it. */
export interface SnapshotPointer extends SnapshotMeta {
  holder: string;
  /** Sealed bytes of the newest version. */
  bytes: number;
}

export interface Tagged<T> {
  value: T;
  /** The store's version tag of the pointer (S3 ETag): what the next write must match. */
  tag: string;
}

/** Another writer moved the pointer between our read and our write. */
export class PointerMoved extends Error {
  constructor(profile: string) {
    super(`${profile}: the pointer changed under this write; read it again`);
  }
}

export interface SnapshotStore {
  where: string;
  putSealed(profile: string, version: string, sealed: string): Promise<void>;
  getSealed(profile: string, version: string): Promise<string | null>;
  /** Newest first. */
  versions(profile: string): Promise<string[]>;
  profiles(): Promise<string[]>;
  pointer(profile: string): Promise<Tagged<SnapshotPointer> | null>;
  /** `tag` null: only when no pointer exists yet. Else only when it still has that tag. */
  setPointer(profile: string, value: SnapshotPointer, tag: string | null): Promise<void>;
}

export const SEALED = ".sealed";
export const POINTER = "latest.json";
// a profile name is a folder name already (`x@wren`); nothing here may climb out
export const safeProfile = (profile: string) => {
  if (!/^[a-z0-9][a-z0-9._@-]*$/i.test(profile) || profile.includes(".."))
    throw new Error(`not a profile name: ${JSON.stringify(profile)}`);
  return profile;
};

/** A folder: tests, and a machine with no bucket. */
export function dirSnapshotStore(dir: string): SnapshotStore {
  const at = (p: string) => join(dir, safeProfile(p));
  const tagOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  return {
    where: dir,
    async putSealed(profile, version, sealed) {
      mkdirSync(at(profile), { recursive: true });
      writeFileSync(join(at(profile), `${version}${SEALED}`), sealed, { mode: 0o600 });
    },
    async getSealed(profile, version) {
      const f = join(at(profile), `${version}${SEALED}`);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },
    async versions(profile) {
      if (!existsSync(at(profile))) return [];
      return readdirSync(at(profile))
        .filter((f) => f.endsWith(SEALED))
        .map((f) => f.slice(0, -SEALED.length))
        .sort()
        .reverse();
    },
    async profiles() {
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    },
    async pointer(profile) {
      const f = join(at(profile), POINTER);
      if (!existsSync(f)) return null;
      const text = readFileSync(f, "utf8");
      return { value: JSON.parse(text), tag: tagOf(text) };
    },
    async setPointer(profile, value, tag) {
      const now = await this.pointer(profile);
      if ((now?.tag ?? null) !== tag) throw new PointerMoved(profile);
      mkdirSync(at(profile), { recursive: true });
      writeFileSync(join(at(profile), POINTER), JSON.stringify(value, null, 2));
    },
  };
}
