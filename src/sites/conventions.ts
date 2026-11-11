/**
 * House rules for routes and flows (OpenCLI audit U4), checked in the gates by
 * `test/conventions.test.ts`. Each issue names the route or flow and the rule it breaks.
 */
import type { BrowserFlow } from "../browser/flow.js";
import { accessOf, type SiteApi } from "./types.js";

const PORTED = /^clis\/[\w-]+\/[\w./-]+@[0-9a-f]{7,40}$/;
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const SUMMARY_MAX = 800;

const shapeKeys = (schema: unknown): Set<string> | null => {
  let t = schema as { shape?: Record<string, unknown>; def?: { innerType?: unknown } } | null;
  while (t && !t.shape && t.def?.innerType) t = t.def.innerType as typeof t;
  return t?.shape ? new Set(Object.keys(t.shape)) : null;
};

export function routeIssues(api: SiteApi): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of api.routes) {
    const at = `${api.site} ${r.method} ${r.path}`;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) out.push(`${at}: defined twice`);
    seen.add(key);
    if (!r.path.startsWith("/")) out.push(`${at}: path starts with /`);
    if (/\/:[\w]/.test(r.path)) out.push(`${at}: path params are {name}, not :name`);
    if (!r.summary?.trim()) out.push(`${at}: no summary`);
    else if (r.summary.length > SUMMARY_MAX)
      out.push(`${at}: summary over ${SUMMARY_MAX} chars (${r.summary.length})`);
    if (!r.api && !r.browser) out.push(`${at}: no leg`);
    if (r.irreversible && accessOf(r) === "read") out.push(`${at}: irreversible but a read`);
    if (r.irreversible && !r.verify) out.push(`${at}: irreversible with no verify`);
    if (r.method === "GET" && r.access === "write") out.push(`${at}: a GET labelled write`);
    if (r.ported && !PORTED.test(r.ported))
      out.push(`${at}: ported is not clis/<site>/<file>@<sha> (${r.ported})`);
    const keys = shapeKeys(r.request);
    for (const m of r.path.matchAll(/\{(\w+)\}/g))
      if (keys && !keys.has(m[1] as string))
        out.push(`${at}: path param {${m[1]}} not in the request`);
  }
  return out;
}

export function flowIssues(flows: Record<string, BrowserFlow<never, unknown>>): string[] {
  const out: string[] = [];
  for (const [key, f] of Object.entries(flows)) {
    if (key !== `${f.site}/${f.name}`) out.push(`${key}: listed under a name not its site/name`);
    if (!KEBAB.test(f.name)) out.push(`${key}: name is not kebab-case`);
    // U5: each browser leg says how it reaches its data (cookie, intercept, ui).
    if (!f.strategies?.length) out.push(`${key}: no strategies`);
  }
  return out;
}

/** A new route's skeleton that already keeps the rules above: `autobrowse site scaffold`. */
export function routeScaffold(method: string, path: string): string {
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
  const read = method === "GET";
  const fields = params.map((p) => `      ${p}: z.string().min(1),`).join("\n");
  return `  route({
    method: "${method}",
    path: "${path}",
    summary: "TODO: what it returns, its inputs in backticks, and what the answer keeps whole",
    request: z.object({
${fields || "      // the official API's own field names"}
    }),
${read ? "    // response: z.looseObject({ … }), // the fields callers read (U2)\n" : '    irreversible: true,\n    verify: { none: "TODO: the read that proves it went, or why none can" },\n'}    api: async (input, leg) => {
      throw new Error("TODO");
    },
  }),`;
}
