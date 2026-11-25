/**
 * The save and restore rules over a store (designs/2026-11-25-authbridge.md): who may save a
 * profile (the holder), when the runner saves (after a sign-in, else at most once a day),
 * and a signed-out state never becoming the newest version.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cipher } from "credvault";
import type { BrowserContext } from "playwright";
import {
  knowsSession,
  openSnapshot,
  type SignInSaver,
  type SignInSnapshot,
  sealSnapshot,
  signedOut,
  takeSnapshot,
} from "./snapshot.js";
import { PointerMoved, type SnapshotPointer, type SnapshotStore } from "./store.js";

/** Cookies rotate; a profile in use gets a fresh copy at most this often without a sign-in. */
export const REFRESH_MS = 24 * 3600_000;

/** A save holds the profile's lease: past this, the run moves on and the save is dropped. */
export const SAVE_MS = 60_000;

/** Another machine holds the profile: its save would overwrite fresher state. */
export class HeldElsewhere extends Error {
  readonly code = "held_elsewhere";
  readonly profile: string;
  readonly holder: string;
  constructor(profile: string, holder: string) {
    super(`${profile}: held by ${holder}; restore it here to move it (authbridge restore)`);
    this.profile = profile;
    this.holder = holder;
  }
}

export type SaveResult =
  | { saved: true; pointer: SnapshotPointer }
  | { saved: false; reason: "signed-out" | "fresh" | "busy" };

export interface BridgeDeps {
  store: SnapshotStore;
  /** The seal: made on first use from the owner's env store. */
  cipher: () => Promise<Cipher>;
  machine: string;
  exitFor: (profile: string) => string | null;
  /** This machine's last save or check per profile (ISO), so a run reads no store to decide. */
  indexFile: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface SignInBridge extends SignInSaver {
  save(
    profile: string,
    context: BrowserContext,
    o: { why: string; visit?: string[]; force?: boolean },
  ): Promise<SaveResult>;
  load(profile: string, version?: string): Promise<SignInSnapshot | null>;
  /** Make this machine the holder (a restore under the same name). */
  take(profile: string): Promise<void>;
  list(profile?: string): Promise<Array<SnapshotPointer & { versions?: string[] }>>;
  /** Whether the runner's rule would save now (tests, `show`). */
  due(profile: string, signedIn: boolean): boolean;
}

export function signInBridge(d: BridgeDeps): SignInBridge {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? (() => undefined);
  const inFlight = new Map<string, Promise<SaveResult>>();
  const readIndex = (): Record<string, string> => {
    try {
      return existsSync(d.indexFile) ? JSON.parse(readFileSync(d.indexFile, "utf8")) : {};
    } catch {
      return {};
    }
  };
  const mark = (profile: string, at: string) => {
    const idx = readIndex();
    idx[profile] = at;
    mkdirSync(dirname(d.indexFile), { recursive: true });
    writeFileSync(d.indexFile, JSON.stringify(idx, null, 2));
  };

  async function saveNow(
    profile: string,
    context: BrowserContext,
    o: { why: string; visit?: string[]; force?: boolean },
  ): Promise<SaveResult> {
    const before = await d.store.pointer(profile);
    if (before && before.value.holder !== d.machine)
      throw new HeldElsewhere(profile, before.value.holder);
    const snap = await takeSnapshot(context, {
      profile,
      machine: d.machine,
      exit: d.exitFor(profile),
      why: o.why,
      ...(o.visit ? { visit: o.visit } : {}),
      now: now(),
    });
    if (!o.force && signedOut(profile, snap.state)) return { saved: false, reason: "signed-out" };
    const sealed = sealSnapshot(snap, await d.cipher());
    await d.store.putSealed(profile, snap.meta.version, sealed);
    const pointer: SnapshotPointer = { ...snap.meta, holder: d.machine, bytes: sealed.length };
    // the version is stored either way; only the pointer can lose a race
    await d.store.setPointer(profile, pointer, before?.tag ?? null);
    mark(profile, snap.meta.savedAt);
    log(
      `authbridge: saved ${profile} ${snap.meta.version} (${o.why}, ${snap.meta.cookies} cookies, ${snap.meta.origins.length} origins, ${sealed.length} B)`,
    );
    return { saved: true, pointer };
  }

  const bridge: SignInBridge = {
    due(profile, signedIn) {
      if (signedIn) return true;
      const last = readIndex()[profile];
      return !last || now().getTime() - Date.parse(last) >= REFRESH_MS;
    },
    async save(profile, context, o) {
      // one save per profile at a time: a second caller gets the first one's answer
      const running = inFlight.get(profile);
      if (running) return running;
      const p = saveNow(profile, context, o).finally(() => inFlight.delete(profile));
      inFlight.set(profile, p);
      return p;
    },
    async afterRun(profile, context, signedIn) {
      if (!bridge.due(profile, signedIn)) return;
      // a refresh needs proof of a sign-in: a run can end ok on a wall it was told to allow
      if (!signedIn && !knowsSession(profile)) return;
      const last = readIndex()[profile];
      const why = signedIn ? "sign-in" : last ? "refresh" : "first";
      let timer: NodeJS.Timeout | undefined;
      try {
        const r = await Promise.race([
          bridge.save(profile, context, { why }),
          new Promise<never>((_, no) => {
            timer = setTimeout(() => no(new Error(`timed out after ${SAVE_MS} ms`)), SAVE_MS);
          }),
        ]);
        if (!r.saved) {
          log(`authbridge: kept ${profile} as it was (${r.reason})`);
          // checked: the next run waits a day too, unless it signs in
          if (r.reason === "signed-out") mark(profile, now().toISOString());
        }
      } catch (err) {
        // never fails the run that just worked
        if (err instanceof HeldElsewhere || err instanceof PointerMoved) {
          log(`authbridge: ${err.message}`);
          mark(profile, now().toISOString());
          return;
        }
        log(`authbridge: save of ${profile} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        clearTimeout(timer);
      }
    },
    async load(profile, version) {
      const v = version ?? (await d.store.pointer(profile))?.value.version;
      if (!v) return null;
      const sealed = await d.store.getSealed(profile, v);
      return sealed ? openSnapshot(sealed, await d.cipher()) : null;
    },
    async take(profile) {
      const at = await d.store.pointer(profile);
      if (!at) return;
      if (at.value.holder === d.machine) return;
      await d.store.setPointer(profile, { ...at.value, holder: d.machine }, at.tag);
    },
    async list(profile) {
      const names = profile ? [profile] : await d.store.profiles();
      const out: Array<SnapshotPointer & { versions?: string[] }> = [];
      for (const p of names) {
        const at = await d.store.pointer(p);
        if (!at) continue;
        out.push(profile ? { ...at.value, versions: await d.store.versions(p) } : at.value);
      }
      return out;
    },
  };
  return bridge;
}
