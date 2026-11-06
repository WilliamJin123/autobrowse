/**
 * Where a key the tool minted goes: the owner's key vault (`creds key`), not
 * an env name. The counterpart of `SecretSink` for API keys. `project` writes
 * the env names the vault projects; `login` says which stored login a site's
 * browser signs in with, so a key records where it came from.
 */
import type { ApiKey, ApiKeyInput } from "credvault";

export interface KeyKeeper {
  put(key: ApiKeyInput): Promise<ApiKey>;
  get(address: string): Promise<ApiKey | null>;
  /**
   * Make the env names for these vendors equal the vault's keys; answers the names, never values.
   * `replace`: a key's own env name may hold a value the key never had (a person said yes).
   */
  project(
    vendors: string[],
    o?: { replace?: boolean },
  ): Promise<{ put: string[]; removed: string[] }>;
  /** The key that fills an env name (`cloudflare@pages`), or null. Absent: not known here. */
  filledBy?(name: string): Promise<string | null>;
  /** Whose keys these are. */
  owner: string;
  /** The stored login a browser on `site` signs in with (`anthropic`, `anthropic@william`). */
  login(site: string): Promise<string>;
}

/** The keeper of a process with no vault: any use says so. */
export const noKeys: KeyKeeper = {
  owner: "",
  put: () => Promise.reject(new Error("no key vault here")),
  get: () => Promise.reject(new Error("no key vault here")),
  project: () => Promise.reject(new Error("no key vault here")),
  login: (site) => Promise.resolve(site),
};
