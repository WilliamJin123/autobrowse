/**
 * API paths and GraphQL operations named in a page's own scripts (audit U12): the calls a page
 * can make, before any of them fires. Pure text scan; the server fetches the scripts.
 */

export interface ScriptText {
  /** The script's URL, or `inline #n`. */
  src: string;
  text: string;
}

export interface Endpoint {
  path: string;
  count: number;
  /** Up to 3 scripts it was in. */
  in: string[];
}

export interface Operation {
  name: string;
  kind: "query" | "mutation" | "subscription" | "op";
  queryId?: string;
  in: string[];
}

export interface ScriptScan {
  scripts: number;
  bytes: number;
  endpoints: Endpoint[];
  operations: Operation[];
}

const ROOTS = "api|graphql|youtubei|ajax|rest|svc|gql|_next\\/data|i\\/api|v\\d{1,2}";
/** A quoted path under an API root, relative or on an http(s) host. */
const PATH = new RegExp(
  `["'\`]((?:https?:\\/\\/[a-z0-9.-]+)?\\/(?:${ROOTS})\\/[A-Za-z0-9_\\-./{}:$]{0,160})["'\`?]`,
  "g",
);
const QUERY_ID = /queryId\s*:\s*["']([\w-]{6,})["']\s*,\s*operationName\s*:\s*["'](\w+)["']/g;
const OP_NAME = /operationName\s*:\s*["'](\w{3,})["']/g;
const GQL_DOC = /\b(query|mutation|subscription)\s+([A-Z]\w{2,})\s*[({]/g;

const MAX = 300;

/** A path with ids folded: `/api/v1/users/123/` → `/api/v1/users/{id}/`. */
export function foldPath(p: string): string {
  return p
    .replace(/\/\d{3,}(?=\/|$)/g, "/{id}")
    .replace(/\$\{[^}]*\}/g, "{var}")
    .replace(/\/+$/, "/");
}

export function scanScripts(scripts: readonly ScriptText[]): ScriptScan {
  const eps = new Map<string, Endpoint>();
  const ops = new Map<string, Operation>();
  let bytes = 0;
  const add = <T extends { in: string[] }>(
    m: Map<string, T>,
    key: string,
    src: string,
    make: () => T,
  ) => {
    const e = m.get(key) ?? make();
    if (!m.has(key)) m.set(key, e);
    if (e.in.length < 3 && !e.in.includes(src)) e.in.push(src);
    return e;
  };
  for (const s of scripts) {
    bytes += s.text.length;
    for (const m of s.text.matchAll(PATH)) {
      const path = foldPath(m[1] as string);
      // Bare roots ("/api/") say nothing.
      if (path.split("/").filter(Boolean).length < 2) continue;
      add(eps, path, s.src, () => ({ path, count: 0, in: [] })).count++;
    }
    for (const m of s.text.matchAll(QUERY_ID)) {
      const op = add(ops, m[2] as string, s.src, () => ({
        name: m[2] as string,
        kind: "op" as const,
        in: [],
      }));
      op.queryId ??= m[1] as string;
    }
    for (const m of s.text.matchAll(OP_NAME))
      add(ops, m[1] as string, s.src, () => ({
        name: m[1] as string,
        kind: "op" as const,
        in: [],
      }));
    for (const m of s.text.matchAll(GQL_DOC)) {
      const op = add(ops, m[2] as string, s.src, () => ({
        name: m[2] as string,
        kind: m[1] as Operation["kind"],
        in: [],
      }));
      if (op.kind === "op") op.kind = m[1] as Operation["kind"];
    }
  }
  return {
    scripts: scripts.length,
    bytes,
    endpoints: [...eps.values()]
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, MAX),
    operations: [...ops.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX),
  };
}

/** In-page: inline scripts, and same-origin and CDN script files (40 files, 4 MB each, at most). */
export const COLLECT_SCRIPTS = `(async () => {
  const out = [];
  let n = 0;
  for (const s of document.querySelectorAll("script:not([src])")) {
    const t = s.textContent || "";
    if (t.length > 40) out.push({ src: "inline #" + (++n), text: t.slice(0, 4000000) });
  }
  const srcs = [...new Set([...document.querySelectorAll("script[src]")].map((s) => s.src))].slice(0, 40);
  await Promise.all(srcs.map(async (src) => {
    try {
      const r = await fetch(src, { credentials: "omit" });
      if (r.ok) out.push({ src, text: (await r.text()).slice(0, 4000000) });
    } catch {}
  }));
  return out;
})()`;
