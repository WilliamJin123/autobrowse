/** Search over names and aims: MiniSearch, in-process, rebuilt per call (a few hundred entries). */
import MiniSearch from "minisearch";

/** What search reads: a name, a site, an aim, and any more words (input and step names). */
export interface Findable {
  name: string;
  site: string | null;
  aim: string;
  words?: string;
}

/**
 * Fuzzy, prefixed search; an exact name ranks first, then a whole name within the typo budget
 * (`serch` → `search` before `tiktok-search`: tokens alone tie them). Short terms match
 * exactly: a prefix "a" would match everything.
 */
export function find<T extends Findable>(items: readonly T[], q: string, limit = 10): T[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const index = new MiniSearch<Findable & { id: number }>({
    fields: ["name", "site", "aim", "words"],
    storeFields: [],
    searchOptions: {
      boost: { name: 3, site: 2 },
      combineWith: "OR",
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
    },
  });
  index.addAll(items.map((t, id) => ({ ...t, site: t.site ?? "", id }) as never));
  const hits = index.search(query).map((r) => items[r.id as number] as T);
  const exact = items.find((t) => t.name === query);
  const budget = query.length >= 4 ? Math.round(query.length * 0.2) : 0;
  const near = budget
    ? items.filter((t) => t !== exact && editDistance(t.name.toLowerCase(), query) <= budget)
    : [];
  const first = [...(exact ? [exact] : []), ...near];
  return [...first, ...hits.filter((t) => !first.includes(t))].slice(0, limit);
}

/** Levenshtein, two rows. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length] as number;
}
