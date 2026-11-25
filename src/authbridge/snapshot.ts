/**
 * authbridge: one profile's sign-in as data (designs/2026-11-25-authbridge.md). A snapshot is
 * Playwright's storage state (cookies, localStorage, IndexedDB) plus plain meta, sealed for S3.
 * Imports from autobrowse only the session-cookie table: this folder moves into its own
 * package when a second consumer exists.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Cipher } from "credvault";
import type { BrowserContext } from "playwright";
import { SESSION_COOKIES, sessionOf } from "../auth/session-status.js";

export type BrowserState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Plain facts about a snapshot: never a cookie or storage value. */
export interface SnapshotMeta {
  profile: string;
  /** Save time, `20261125T201500123Z`: sorts as text. */
  version: string;
  savedAt: string;
  machine: string;
  userAgent: string;
  platform: string;
  /** The egress exit the profile went out through; null = direct. */
  exit: string | null;
  origins: string[];
  cookies: number;
  /** Why it was saved: `sign-in`, `refresh`, `first`, `cli`, `before-restore`. */
  why: string;
}

export interface SignInSnapshot {
  meta: SnapshotMeta;
  state: BrowserState;
}

/** What the runner calls when a run ends ok (`BrowserOptions.signIns`). */
export interface SignInSaver {
  afterRun(profile: string, context: BrowserContext, signedIn: boolean): Promise<void>;
}

export const versionOf = (d: Date): string => d.toISOString().replace(/[-:.]/g, "");

/** `x@wren` → `x`: the site whose session cookies tell signed in from out. */
export const siteOfProfile = (profile: string): string => profile.split("@")[0] ?? profile;

/**
 * Signed out per the site's known session cookies; false when the site has none listed
 * (nothing to tell by). A signed-out state never becomes the newest version.
 */
export function signedOut(profile: string, state: BrowserState, now = Date.now()): boolean {
  const names = SESSION_COOKIES[siteOfProfile(profile)];
  if (!names) return false;
  // storageState: seconds, -1 for a cookie that ends with the browser; sessionOf: ms, 0
  const rows = state.cookies.map((c) => ({
    host: c.domain,
    name: c.name,
    expires: c.expires > 0 ? c.expires * 1000 : 0,
  }));
  return sessionOf(rows, names, now).state !== "signed_in";
}

/** The site has known session cookies: a save can prove it is signed in. */
export const knowsSession = (profile: string): boolean =>
  Boolean(SESSION_COOKIES[siteOfProfile(profile)]);

/**
 * Origins that hold IndexedDB in a profile folder, from the folder names
 * (`Default/IndexedDB/https_mail.google.com_0.indexeddb.leveldb`): cookie hosts miss
 * `mail.google.com` when the cookie sits on `.google.com`.
 */
export function storedOrigins(profileDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(profileDir, "Default", "IndexedDB"));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const n of names) {
    const m = /^(https?)_(.+)_(\d+)\.indexeddb\.(?:leveldb|blob)$/.exec(n);
    if (m) out.add(`${m[1]}://${m[2]}${m[3] === "0" ? "" : `:${m[3]}`}`);
  }
  return [...out].sort();
}

/** One https origin per cookie host: where localStorage and IndexedDB of a signed-in site sit. */
export function originsOf(cookies: BrowserState["cookies"]): string[] {
  const hosts = new Set(cookies.map((c) => c.domain.replace(/^\./, "")).filter(Boolean));
  return [...hosts].sort().map((h) => `https://${h}`);
}

/** Cap on origins a cold save visits: a profile that browsed widely still saves in seconds. */
export const MAX_VISITS = 80;

/**
 * Make `origins` visited in this process, so `storageState` collects their storage: one page,
 * every request answered locally with an empty document (no network, no site sees it).
 */
export async function visitOrigins(context: BrowserContext, origins: string[]): Promise<void> {
  if (!origins.length) return;
  const page = await context.newPage();
  try {
    await page.route("**/*", (r) => r.fulfill({ body: "<html></html>", contentType: "text/html" }));
    for (const o of origins.slice(0, MAX_VISITS))
      await page.goto(o, { waitUntil: "commit", timeout: 10_000 }).catch(() => undefined);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** What the browser says about itself, off an open page (or a blank one opened for it). */
async function whoAmI(context: BrowserContext): Promise<{ userAgent: string; platform: string }> {
  const open = context.pages().find((p) => !p.isClosed());
  const page = open ?? (await context.newPage());
  try {
    return await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
    }));
  } finally {
    if (!open) await page.close().catch(() => undefined);
  }
}

export async function takeSnapshot(
  context: BrowserContext,
  o: {
    profile: string;
    machine: string;
    exit: string | null;
    why: string;
    /** Origins to visit first (a cold profile); the run's own are visited already. */
    visit?: string[];
    now?: Date;
  },
): Promise<SignInSnapshot> {
  if (o.visit) await visitOrigins(context, o.visit);
  const state = await context.storageState({ indexedDB: true });
  const now = o.now ?? new Date();
  const who = await whoAmI(context);
  return {
    meta: {
      profile: o.profile,
      version: versionOf(now),
      savedAt: now.toISOString(),
      machine: o.machine,
      ...who,
      exit: o.exit,
      origins: state.origins.map((x) => x.origin),
      cookies: state.cookies.length,
      why: o.why,
    },
    state,
  };
}

/**
 * Clears every cookie, then sets the snapshot's cookies and storage. Storage of origins this
 * process never visited stays: restore into an empty profile folder.
 */
export async function applySnapshot(context: BrowserContext, snap: SignInSnapshot): Promise<void> {
  await context.setStorageState(snap.state);
}

/** gzip, then the cipher (credvault aesGcm): one sealed text line. */
export function sealSnapshot(snap: SignInSnapshot, cipher: Cipher): string {
  return cipher.seal(gzipSync(JSON.stringify(snap)).toString("base64"));
}

export function openSnapshot(sealed: string, cipher: Cipher): SignInSnapshot {
  return JSON.parse(gunzipSync(Buffer.from(cipher.open(sealed), "base64")).toString("utf8"));
}
