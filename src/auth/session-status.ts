/**
 * Is a Chrome profile signed in, without opening it (OpenCLI audit U18)? Reads a copy of the
 * profile's cookie DB: names, hosts and expiry are plain; values stay encrypted and unread.
 * A site with known session cookies answers `signed_in` or `signed_out`; any other site
 * answers `maybe` (a live auth-like cookie) or `unknown`.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Cookies a site sets only while signed in, checked against real profiles 2026-11-10. */
export const SESSION_COOKIES: Readonly<Record<string, readonly string[]>> = {
  github: ["user_session"],
  linkedin: ["li_at"],
  x: ["auth_token"],
  reddit: ["reddit_session"],
  instagram: ["sessionid"],
  facebook: ["c_user"],
  tiktok: ["sessionid"],
  google: ["SID", "__Secure-1PSID"],
  gmail: ["SID", "__Secure-1PSID"],
  youtube: ["SID", "__Secure-1PSID"],
};

const AUTH_LIKE = /sess|auth|token|login|^sid$|user_id/i;

export type SessionState = "signed_in" | "signed_out" | "maybe" | "unknown" | "no_cookies";

export interface SessionStatus {
  profile: string;
  site: string;
  host: string;
  state: SessionState;
  /** The session cookie's expiry (ISO); null for a cookie that ends with the browser. */
  expires?: string | null;
  /** When the profile's cookies were last written. */
  touched?: string;
  /** When a status read last saw it signed in (`SEEN_FILE`); absent: never seen signed in. */
  lastSignedIn?: string;
}

/** Per profile: the last time a status read saw it signed in. Tells a lost sign-in from one never made. */
export const SEEN_FILE = ".signed-in-at";

export interface CookieRow {
  host: string;
  name: string;
  /** Unix ms; 0 for a browser-session cookie. */
  expires: number;
}

/** Chrome's time: microseconds since 1601-01-01. */
const chromeMs = (v: bigint) => (v === 0n ? 0 : Number(v / 1000n) - 11_644_473_600_000);

/** `www.linkedin.com` → `linkedin.com`; `bbc.co.uk` keeps three labels. */
export function baseDomain(host: string): string {
  const parts = host.replace(/^\./, "").split(".");
  const n =
    parts.length >= 3 && (parts.at(-2) ?? "").length <= 3 && (parts.at(-1) ?? "").length === 2
      ? 3
      : 2;
  return parts.slice(-n).join(".");
}

export const cookieFileOf = (profileDir: string): string | null =>
  [join(profileDir, "Default", "Network", "Cookies"), join(profileDir, "Default", "Cookies")].find(
    existsSync,
  ) ?? null;

/** The rows for `domain` and its subdomains, read from a copy (Chrome may hold the file). */
export function readCookies(file: string, domain: string): CookieRow[] {
  const dir = mkdtempSync(join(tmpdir(), "cookies-"));
  try {
    const copy = join(dir, "Cookies");
    copyFileSync(file, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const q = db.prepare(
        "SELECT host_key AS host, name, expires_utc AS expires FROM cookies WHERE host_key = ? OR host_key = ? OR host_key LIKE ?",
      );
      // Chrome's microsecond times pass 2^53.
      q.setReadBigInts(true);
      const rows = q.all(domain, `.${domain}`, `%.${domain}`) as Array<{
        host: string;
        name: string;
        expires: bigint;
      }>;
      return rows.map((r) => ({ host: r.host, name: r.name, expires: chromeMs(r.expires) }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pure: a state from the cookie rows. */
export function sessionOf(
  rows: readonly CookieRow[],
  names: readonly string[] | undefined,
  now = Date.now(),
): Pick<SessionStatus, "state" | "expires"> {
  const live = rows.filter((r) => r.expires === 0 || r.expires > now);
  if (!rows.length) return { state: "no_cookies" };
  if (names?.length) {
    const hit = live.find((r) => names.includes(r.name));
    if (!hit) return { state: "signed_out" };
    return {
      state: "signed_in",
      expires: hit.expires ? new Date(hit.expires).toISOString() : null,
    };
  }
  return { state: live.some((r) => AUTH_LIKE.test(r.name)) ? "maybe" : "unknown" };
}

/** Every profile under `profilesDir` whose site has a known home. */
export function sessionStatuses(
  profilesDir: string,
  homeOf: (site: string) => string | undefined,
  o: { site?: string; now?: number } = {},
): SessionStatus[] {
  if (!existsSync(profilesDir)) return [];
  const out: SessionStatus[] = [];
  for (const profile of readdirSync(profilesDir).sort()) {
    const site = profile.split("@")[0] ?? profile;
    if (o.site && site !== o.site) continue;
    const home = homeOf(site);
    if (!home) continue;
    const host = baseDomain(new URL(home).hostname);
    const file = cookieFileOf(join(profilesDir, profile));
    if (!file) {
      out.push({ profile, site, host, state: "no_cookies" });
      continue;
    }
    let rows: CookieRow[];
    try {
      rows = readCookies(file, host);
    } catch {
      out.push({ profile, site, host, state: "unknown" });
      continue;
    }
    const st = sessionOf(rows, SESSION_COOKIES[site], o.now);
    const lastSignedIn = seenSignedIn(join(profilesDir, profile), st.state, o.now);
    out.push({
      profile,
      site,
      host,
      ...st,
      touched: statSync(file).mtime.toISOString(),
      ...(lastSignedIn ? { lastSignedIn } : {}),
    });
  }
  return out;
}

/** Writes the marker when signed in; reads it otherwise. A failed write never fails the read. */
function seenSignedIn(dir: string, state: SessionState, now = Date.now()): string | undefined {
  const f = join(dir, SEEN_FILE);
  if (state === "signed_in") {
    const at = new Date(now).toISOString();
    try {
      writeFileSync(f, at, { mode: 0o600 });
    } catch {
      // read-only profile dir
    }
    return at;
  }
  try {
    return readFileSync(f, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
