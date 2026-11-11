/**
 * `autobrowse list [query]` (OpenCLI audit U3): one paged finder over every ability (site
 * routes, workflows, flows, tools), each with the command that uses it. Fuzzy by `find`.
 */
import { find } from "../workflows/find.js";
import { type Ability, type AbilityKind, parseSiteAbility } from "./catalog.js";

export const LIST_PAGE = 30;

export interface ListQuery {
  query?: string;
  kind?: AbilityKind;
  site?: string;
  limit?: number;
  offset?: number;
}

export interface Listed extends Ability {
  /** The command that runs or shows it. */
  use: string;
}

export interface ListPage {
  total: number;
  offset: number;
  items: Listed[];
  /** The command for the next page; null on the last. */
  next: string | null;
}

/** The command an agent runs for this ability. */
export function useOf(a: Ability): string {
  const route = parseSiteAbility(a.name);
  if (a.kind === "site" && route)
    return `autobrowse site call ${route.site} ${route.method} ${route.path} --body '<json>'`;
  if (a.kind === "workflow") return `autobrowse workflows ${a.name}`;
  return `autobrowse do '${a.name}'`;
}

const quote = (s: string) => (/^[\w./@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

export function listAbilities(all: readonly Ability[], q: ListQuery = {}): ListPage {
  const limit = q.limit ?? LIST_PAGE;
  const offset = q.offset ?? 0;
  const kept = all.filter((a) => (!q.kind || a.kind === q.kind) && (!q.site || a.site === q.site));
  const ranked = q.query?.trim()
    ? find(
        kept.map((a) => ({
          a,
          name: a.name,
          site: a.site,
          aim: a.summary,
          words: a.inputs.map((f) => f.name).join(" "),
        })),
        q.query,
        kept.length,
      ).map((h) => h.a)
    : [...kept].sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
  const items = ranked.slice(offset, offset + limit).map((a) => ({ ...a, use: useOf(a) }));
  const more = offset + limit < ranked.length;
  const next = more
    ? [
        "autobrowse list",
        ...(q.query?.trim() ? [quote(q.query.trim())] : []),
        ...(q.kind ? [`--kind ${q.kind}`] : []),
        ...(q.site ? [`--site ${q.site}`] : []),
        ...(q.limit ? [`--limit ${limit}`] : []),
        `--offset ${offset + limit}`,
        "--json",
      ].join(" ")
    : null;
  return { total: ranked.length, offset, items, next };
}
