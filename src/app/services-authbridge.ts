/**
 * authbridge for this install (designs/2026-11-25-authbridge.md): snapshots in the shots bucket
 * under the owner's `signins/` prefix, sealed with `AUTHBRIDGE_SEAL_KEY` from the owner's SSM
 * path (cached in the env file), so any machine that reads that path opens them.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { aesGcmCipher, type Cipher, envFileStore, WouldReplace } from "credvault";
import { type SignInBridge, signInBridge } from "../authbridge/bridge.js";
import type { Egress } from "../browser/egress.js";
import { expandHome } from "../google/auth.js";
import { ownerKeys } from "../owner.js";
import { s3SnapshotStore } from "../shots/s3.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";
import { envStoreFor } from "./services-keys.js";

export const SEAL_KEY = "AUTHBRIDGE_SEAL_KEY";

/**
 * The seal: made once in SSM (never replaced: every snapshot sealed under it would be lost),
 * then cached in the env file. Made in SSM first: a key only this machine holds seals blobs no
 * other machine opens. Read from the file: SSM needs the AWS login, which expires.
 */
export async function sealCipher(settings: Settings): Promise<Cipher> {
  const local = envFileStore(settings.envFile);
  let key = await local.get(SEAL_KEY);
  if (!key) {
    const shared = envStoreFor(settings);
    if (!(await shared.get(SEAL_KEY)))
      await shared.put(SEAL_KEY, randomBytes(32).toString("base64")).catch((err) => {
        // another machine made it first: theirs stands
        if (!(err instanceof WouldReplace)) throw err;
      });
    // read back: of two first writers, the stored one wins
    key = await shared.get(SEAL_KEY);
    if (key) await local.put(SEAL_KEY, key);
  }
  if (!key) throw new Error(`${SEAL_KEY}: not readable after it was made`);
  return aesGcmCipher(Buffer.from(key, "base64"));
}

/**
 * The holder's name: `AUTOBROWSE_MACHINE`, else this Mac's host name (`Williams-MacBook-Pro`).
 * Null off a Mac without it: a container's host name changes on every deploy.
 */
export function machineName(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env.AUTOBROWSE_MACHINE?.trim();
  if (set) return set;
  return process.platform === "darwin" ? hostname().replace(/\.local$/, "") : null;
}

const bridges = new Map<string, SignInBridge>();

/** One bridge per owner per process; null without a shots bucket or a machine name. */
export function bridgeFor(settings: Settings, egress?: Egress): SignInBridge | null {
  // a test run never writes a real bucket from a settings file it happened to load
  const machine = machineName();
  if (!settings.shotsBucket || !machine || process.env.VITEST) return null;
  const memo = `${settings.owner}|${settings.shotsBucket}`;
  const made = bridges.get(memo);
  if (made) return made;
  let cipher: Promise<Cipher> | null = null;
  const bridge = signInBridge({
    store: s3SnapshotStore({
      bucket: settings.shotsBucket,
      prefix: ownerKeys(settings.owner).signins,
      aws: awsFor(settings),
    }),
    cipher: () => {
      cipher ??= sealCipher(settings).catch((err) => {
        cipher = null;
        throw err;
      });
      return cipher;
    },
    machine,
    exitFor: (profile) => egress?.exitFor(profile)?.name ?? null,
    indexFile: join(dirname(expandHome(settings.credentialsFile)), "signins.json"),
    log: (line) => console.error(line),
  });
  bridges.set(memo, bridge);
  return bridge;
}
