/**
 * Path standing (designs/2026-11-05-path-standing.md): whether the leg a route answers by is the
 * answer for good, or a stand-in until something outside our code clears. Stated on the route
 * where the legs cannot say it; derived where they can (a missing grant, no token).
 */
import type { Blocker, SiteApi, SiteRoute, Standing } from "./types.js";

type AnyRoute = SiteRoute<never, unknown>;

/** What a route with both legs waits on when no token is held: a setup step, ours to run. */
export const CONNECT = "connect";

/** A `final` reason that names a gate we could pass is a `waits` stated wrong. */
const GATED = /\b(review|audit|approval|approved|beta|waitlist|verification)\b/i;

/** The site's blocker that gives grant `g`. */
export const blockerFor = (s: Pick<SiteApi, "blockers">, g: string): string | undefined =>
  Object.entries(s.blockers ?? {}).find(([, b]) => b.grants?.includes(g))?.[0];

/**
 * Where the stated standings break the rule; empty when they hold.
 *
 *   browser only        `final` or `waits`
 *   `prefer: "browser"` `final`
 *   both legs           nothing: derived from `needs` and the token; or `waits` as below
 *   an API leg          nothing, or `waits` for a better gated way (a webhook in review)
 *   `final`             a reason, which names no review, audit or beta (that is a `waits`)
 *   `waits`             a blocker the site lists; a fixed `needs` grant has a blocker that gives it
 *   a blocker           a route waits on it, or it gives grants
 */
export function standingFaults(sites: readonly SiteApi[]): string[] {
  const faults: string[] = [];
  for (const s of sites) {
    const blockers = s.blockers ?? {};
    const used = new Set<string>();
    for (const r of s.routes) {
      const say = (what: string) => faults.push(`${s.site} ${r.method} ${r.path}: ${what}`);
      const st = r.standing;
      if (st && "waits" in st) {
        used.add(st.waits);
        if (!blockers[st.waits]) say(`waits on "${st.waits}", which ${s.site} does not list`);
      }
      if (st && "final" in st && !st.final.trim()) say("`final` gives no reason");
      if (st && "final" in st && GATED.test(st.final))
        say("`final` names a review: a call a review gives states `waits` on its blocker");
      if (r.browser && !r.api && !st)
        say("browser only: state `final` (why for good) or `waits` (a blocker)");
      if (r.browser && r.api) {
        if (r.prefer === "browser") {
          if (!st || !("final" in st)) say("prefers the browser: state `final`, the reason");
        } else if (st && "final" in st)
          say("both legs: the leg comes from `needs` and the token; `final` says nothing");
      }
      if (r.api && !r.browser && st && "final" in st)
        say("API only: `final` says nothing; `waits` names a better gated way");
      if (Array.isArray(r.needs))
        for (const g of r.needs as readonly string[])
          if (!blockerFor(s, g)) say(`needs "${g}", which no blocker of ${s.site} gives`);
    }
    for (const [id, b] of Object.entries(blockers))
      if (!used.has(id) && !b.grants?.length) faults.push(`${s.site}: no route waits on "${id}"`);
  }
  return faults;
}

/**
 * Why a route answers as it does now. `held`: a token is in hand; `lacks`: the grants it is
 * missing. Undefined: the API answers and nothing better is gated.
 */
export function standingOf(
  s: Pick<SiteApi, "blockers">,
  r: Pick<AnyRoute, "api" | "browser" | "standing" | "prefer">,
  held: boolean,
  lacks: readonly string[],
): Standing | undefined {
  const g = lacks[0];
  if (r.api && g && r.prefer !== "browser")
    return { waits: blockerFor(s, g) ?? `grant ${lacks.join(", ")}` };
  if (r.api && r.browser && r.prefer !== "browser" && !held) return { waits: CONNECT };
  return r.standing;
}

/** A site's routes as `site status` gives them: only what the report reads. */
export interface PathSite {
  site: string;
  blockers?: Readonly<Record<string, Blocker>>;
  routes: readonly {
    method: string;
    path: string;
    via: "api" | "browser" | "none";
    missing?: string;
    standing?: Standing;
  }[];
}

export interface PathsReport {
  /** Nothing to wait for: the API answers, or the browser does for good. */
  settled: { site: string; api: number; browser: number }[];
  /** By what is waited on: a blocker's id, `connect`, or a grant no blocker names. */
  waiting: {
    id: string;
    site: string;
    blocker?: Blocker;
    /** `none`: nothing answers until it clears. */
    routes: { route: string; via: "api" | "browser" | "none" }[];
  }[];
  /** The browser answers for good: each route and why. */
  final: { site: string; route: string; why: string }[];
  /** No leg answers now, and no blocker says why: a flow to record, a token to make. */
  none: { site: string; route: string; missing: string }[];
}

export function pathsReport(sites: readonly PathSite[]): PathsReport {
  const out: PathsReport = { settled: [], waiting: [], final: [], none: [] };
  for (const s of sites) {
    const count = { site: s.site, api: 0, browser: 0 };
    const groups = new Map<string, PathsReport["waiting"][number]>();
    for (const r of s.routes) {
      const route = `${r.method} ${r.path}`;
      const st = r.standing;
      if (st && "waits" in st) {
        const blocker = s.blockers?.[st.waits];
        const g = groups.get(st.waits) ?? {
          id: st.waits,
          site: s.site,
          ...(blocker ? { blocker } : {}),
          routes: [],
        };
        g.routes.push({ route, via: r.via });
        groups.set(st.waits, g);
        continue;
      }
      if (r.via === "none") {
        out.none.push({ site: s.site, route, missing: r.missing ?? "no leg" });
        continue;
      }
      if (r.via === "api") count.api++;
      else {
        count.browser++;
        out.final.push({ site: s.site, route, why: st?.final ?? "" });
      }
    }
    if (count.api || count.browser) out.settled.push(count);
    out.waiting.push(...groups.values());
  }
  return out;
}

/** A call the ledger holds: the leg that ran. */
export interface RanLeg {
  site: string;
  /** `GET /2/tweets/123`: the method leads. */
  route: string;
  template?: string;
  via?: "api" | "browser";
  at: string;
}

export interface Drift {
  site: string;
  route: string;
  /** What `site status` says answers now. */
  stated: "api" | "browser" | "none";
  ran: { api: number; browser: number };
  last: string;
}

/**
 * Routes whose ledger rows ran a leg other than the one stated now. `perRequest` names the
 * routes that pick a leg by request (`prefer` or `needs` as a function): both legs are right.
 */
export function drift(
  sites: readonly PathSite[],
  rows: readonly RanLeg[],
  perRequest: (site: string, route: string) => boolean = () => false,
): Drift[] {
  const ran = new Map<string, Drift["ran"] & { last: string }>();
  for (const row of rows) {
    if (!row.via || !row.template) continue;
    const key = `${row.site} ${row.route.split(" ")[0]} ${row.template}`;
    const n = ran.get(key) ?? { api: 0, browser: 0, last: row.at };
    n[row.via]++;
    if (row.at > n.last) n.last = row.at;
    ran.set(key, n);
  }
  const out: Drift[] = [];
  for (const s of sites)
    for (const r of s.routes) {
      const route = `${r.method} ${r.path}`;
      const n = ran.get(`${s.site} ${route}`);
      if (!n || perRequest(s.site, route)) continue;
      const other = r.via === "api" ? n.browser : r.via === "browser" ? n.api : n.api + n.browser;
      if (other)
        out.push({
          site: s.site,
          route,
          stated: r.via,
          ran: { api: n.api, browser: n.browser },
          last: n.last,
        });
    }
  return out;
}
