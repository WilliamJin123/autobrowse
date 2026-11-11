/**
 * `fetch` for the share ingest that survives a stale negative DNS cache.
 * macOS mDNSResponder can keep "no such host" for a new subdomain for hours
 * (share.wrenautomation.com, 2026-10-24), and only root can flush it. On
 * ENOTFOUND the call goes again with the host resolved by public resolvers.
 */
import { Resolver } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import type { Agent } from "undici";

const MISSING = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const codeOf = (err: unknown): string | undefined =>
  (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;

let agent: Agent | undefined;

/** An agent whose lookup asks 1.1.1.1 and 8.8.8.8, not this machine's cache. */
function publicAgent(Make: typeof Agent): Agent {
  if (agent) return agent;
  const dns = new Resolver();
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
  agent = new Make({
    connect: {
      lookup: (host, opts, cb) => {
        dns.resolve4(host).then(
          (addrs) => {
            const all = addrs.map((address) => ({ address, family: 4 }));
            if ((opts as { all?: boolean }).all) cb(null, all as never);
            else cb(null, addrs[0] as string, 4);
          },
          (err: NodeJS.ErrnoException) => cb(err, "", 4),
        );
      },
    },
  });
  return agent;
}

export const shareFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (!MISSING.has(codeOf(err) ?? "")) throw err;
    // Loaded on this path only: undici costs every CLI start ~80 ms.
    const undici = await import("undici");
    return (await undici.fetch(input as string, {
      ...(init as object),
      dispatcher: publicAgent(undici.Agent),
    })) as unknown as Response;
  }
};

/**
 * Global fetch through an undici agent whose connect lookup is `lookup` (the net guard):
 * the address dialed is the one checked. Agent made on first call, undici loaded then.
 */
export function fetchWithLookup(lookup: LookupFunction): typeof fetch {
  let made: Promise<Agent> | undefined;
  return async (input, init) => {
    made ??= import("undici").then((u) => new u.Agent({ connect: { lookup } }));
    return fetch(input, { ...init, dispatcher: await made } as unknown as RequestInit);
  };
}
