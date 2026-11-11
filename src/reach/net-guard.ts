/**
 * Where a fetch or a browser may go: http(s) only, no private or metadata
 * address, optional domain allowlist. One rule set for the ladder, the
 * renderer and every browser navigation (designs/2026-11-10-pinchtab-audit.md, P1).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { loadSettings } from "../app/config.js";

export interface NetRules {
  /** 127/8 and ::1; on for a Mac (local tools), off on a server. */
  loopback: boolean;
  /** Private and link-local ranges (a LAN page); off by default. */
  private: boolean;
  /** Host suffixes allowed; empty = any public host. */
  allowDomains: readonly string[];
}

/** The URL is outside the rules: nothing was sent to it. */
export class NetRefused extends Error {
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`refused ${url}: ${reason}`);
    this.name = "NetRefused";
    this.url = url;
  }
}

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // unspecified, "this host"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const)
  BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const)
  BLOCKED.addSubnet(net, bits, "ipv6");
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** IPv4 wrapped in 6to4 (2002:AABB:CCDD::) or NAT64 (64:ff9b::AABB:CCDD); null otherwise. */
function wrappedV4(ip: string): string | null {
  const h = expand6(ip);
  if (!h) return null;
  const quad = (a: string, b: string) =>
    [a.slice(0, 2), a.slice(2), b.slice(0, 2), b.slice(2)].map((x) => parseInt(x, 16)).join(".");
  if (h[0] === "2002") return quad(h[1] as string, h[2] as string);
  if (h[0] === "0064" && h[1] === "ff9b" && h.slice(2, 6).every((x) => x === "0000"))
    return quad(h[6] as string, h[7] as string);
  return null;
}

/** Eight 4-digit hex groups; a dotted tail folds in. */
function expand6(ip: string): string[] | null {
  let s = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = (dotted[1] as string).split(".").map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string?];
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - a.length - b.length).fill("0");
  const all = [...a, ...fill, ...b];
  return all.length === 8 ? all.map((x) => x.padStart(4, "0")) : null;
}

/** Why an address is refused; null = allowed. */
export function refusedAddress(
  ip: string,
  rules: Pick<NetRules, "loopback" | "private">,
): string | null {
  const v = isIP(ip);
  if (!v) return "not an IP address";
  const fam = v === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(ip, fam)) return rules.loopback ? null : "loopback address";
  if (BLOCKED.check(ip, fam)) return rules.private ? null : "private or reserved address";
  const inner = v === 6 ? wrappedV4(ip) : null;
  return inner ? refusedAddress(inner, rules) : null;
}

const allowed = (host: string, domains: readonly string[]) =>
  !domains.length || domains.some((d) => host === d || host.endsWith(`.${d}`));

type Lookup = (host: string) => Promise<{ address: string }[]>;
const lookupAll: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Throws `NetRefused` when the URL breaks the rules. Resolves the host: a
 * public name that points at a private address is refused too. `browser`
 * also lets about: and data: through (blank and inline pages).
 */
export async function checkUrl(
  url: string,
  o: { rules?: NetRules; browser?: boolean; lookup?: Lookup } = {},
): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NetRefused(url, "not a URL");
  }
  if (o.browser && (u.protocol === "about:" || u.protocol === "data:")) return;
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new NetRefused(url, `scheme ${u.protocol} (http and https only)`);
  const rules = o.rules ?? netRules();
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowed(host, rules.allowDomains))
    throw new NetRefused(url, `${host} is outside NET_ALLOW_DOMAINS`);
  const addrs = isIP(host)
    ? [host]
    : host === "localhost" || host.endsWith(".localhost")
      ? ["127.0.0.1"]
      : await (o.lookup ?? lookupAll)(host).then(
          (r) => r.map((a) => a.address),
          // unresolvable: the request fails on its own, as unreachable
          () => [],
        );
  for (const a of addrs) {
    const why = refusedAddress(a, rules);
    if (why) throw new NetRefused(url, `${host} → ${a}: ${why}`);
  }
}

/**
 * A `net.connect` lookup that refuses blocked addresses at connect time: the
 * address dialed is the address checked, so DNS rebinding finds no gap.
 */
export function guardedLookup(given?: NetRules): LookupFunction {
  return (host, opts, cb) => {
    const rules = given ?? netRules();
    dnsLookup(host, { ...opts, all: true, verbatim: true }).then(
      (list) => {
        const bad = list.map((a) => refusedAddress(a.address, rules)).find(Boolean);
        if (bad) return cb(new NetRefused(host, `${host}: ${bad}`), "", 4);
        const all = (opts as { all?: boolean }).all;
        if (all) return (cb as unknown as (e: null, l: typeof list) => void)(null, list);
        const first = list[0];
        if (!first)
          return cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" }), "", 4);
        cb(null, first.address, first.family);
      },
      (e: NodeJS.ErrnoException) => cb(e, "", 4),
    );
  };
}

/**
 * After a browser navigation: a redirect that landed outside the rules
 * blanks the page and throws. Chrome follows redirects itself, so the
 * request already went; this keeps its answer from the agent.
 */
export async function landedOk(page: {
  url(): string;
  goto(url: string): Promise<unknown>;
}): Promise<void> {
  try {
    await checkUrl(page.url(), { browser: true });
  } catch (e) {
    await page.goto("about:blank").catch(() => undefined);
    throw e;
  }
}

const MAX_HOPS = 10;

/**
 * Follows redirects by hand, checking each hop before it is fetched. `get`
 * must not follow redirects itself.
 */
export async function followChecked<
  R extends { status: number; headers: { get(name: string): string | null } },
>(
  url: string,
  get: (url: string) => Promise<R>,
  rules: NetRules = netRules(),
): Promise<R & { finalUrl: string }> {
  let at = url;
  for (let hop = 0; ; hop++) {
    await checkUrl(at, { rules });
    const res = await get(at);
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to || hop >= MAX_HOPS) return Object.assign(res, { finalUrl: at });
    at = new URL(to, at).toString();
  }
}

let cached: NetRules | undefined;
/** The rules from settings, read once per process. */
export function netRules(): NetRules {
  if (cached) return cached;
  const s = loadSettings();
  cached = {
    loopback: s.netLoopback,
    private: s.netAllowPrivate,
    allowDomains: s.netAllowDomains,
  };
  return cached;
}
