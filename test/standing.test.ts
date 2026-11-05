import { describe, expect, it } from "vitest";
import { SITES } from "../src/sites/index.js";
import {
  CONNECT,
  drift,
  type PathSite,
  pathsReport,
  standingFaults,
  standingOf,
} from "../src/sites/standing.js";
import type { SiteApi } from "../src/sites/types.js";

const leg = { flow: "s/f" };
const api = async () => ({});
const site = (routes: object[], blockers?: SiteApi["blockers"]): SiteApi =>
  ({
    site: "s",
    routes: routes.map((r) => ({ method: "GET", path: "/a", ...r })),
    ...(blockers ? { blockers } : {}),
  }) as unknown as SiteApi;
const review = { what: "a review", since: "2026-11-01" };

describe("path standing", () => {
  it("every route of every site states its standing by the rule", () => {
    expect(standingFaults(SITES)).toEqual([]);
  });

  it("a browser-only route must say for good or what it waits on", () => {
    expect(standingFaults([site([{ browser: leg }])])).toEqual([
      "s GET /a: browser only: state `final` (why for good) or `waits` (a blocker)",
    ]);
    expect(standingFaults([site([{ browser: leg, standing: { final: "no API" } }])])).toEqual([]);
    expect(standingFaults([site([{ browser: leg, standing: { final: " " } }])])).toHaveLength(1);
  });

  it("a `final` that names a review, a price or a partner program is a wait stated wrong", () => {
    const fault =
      "s GET /a: `final` names a review or a price: a call some API gives states `waits` on a blocker";
    for (const final of [
      "hashtags only, after App Review",
      "the API bills each read",
      "Enterprise only",
      "closed partner programs only",
    ])
      expect(standingFaults([site([{ browser: leg, standing: { final } }])])).toEqual([fault]);
  });

  it("a wait names a blocker the site lists, and each blocker has a route or grants", () => {
    const waits = { browser: leg, standing: { waits: "review" } };
    expect(standingFaults([site([waits])])).toEqual([
      's GET /a: waits on "review", which s does not list',
    ]);
    expect(standingFaults([site([waits], { review })])).toEqual([]);
    expect(standingFaults([site([{ api }], { review })])).toEqual([
      's: no route waits on "review"',
    ]);
    expect(standingFaults([site([{ api }], { review: { ...review, grants: ["g"] } })])).toEqual([]);
  });

  it("both legs state no `final`, unless the browser is preferred", () => {
    const both = { api, browser: leg };
    expect(standingFaults([site([both])])).toEqual([]);
    expect(
      standingFaults([site([{ ...both, standing: { waits: "review" } }], { review })]),
    ).toEqual([]);
    expect(standingFaults([site([{ ...both, standing: { final: "x" } }])])).toHaveLength(1);
    expect(standingFaults([site([{ ...both, prefer: "browser" }])])).toEqual([
      "s GET /a: prefers the browser: state `waits` (what holds the API back) or `final`",
    ]);
    expect(
      standingFaults([site([{ ...both, prefer: "browser", standing: { final: "richer page" } }])]),
    ).toEqual([]);
    // the API leg answers, held back by a cost call: a wait, not for good
    expect(
      standingFaults([
        site([{ ...both, prefer: "browser", standing: { waits: "review" } }], { review }),
      ]),
    ).toEqual([]);
  });

  it("an API-only route may wait on a better gated way, and a fixed grant needs a blocker", () => {
    expect(standingFaults([site([{ api, standing: { waits: "review" } }], { review })])).toEqual(
      [],
    );
    expect(standingFaults([site([{ api, standing: { final: "x" } }])])).toHaveLength(1);
    expect(standingFaults([site([{ api, needs: ["g"] }])])).toEqual([
      's GET /a: needs "g", which no blocker of s gives',
    ]);
  });

  it("derives what a route with both legs waits on", () => {
    const s = { blockers: { review: { ...review, grants: ["g"] } } };
    const both = { api, browser: leg } as never;
    expect(standingOf(s, both, true, [])).toBeUndefined();
    expect(standingOf(s, both, false, [])).toEqual({ waits: CONNECT });
    expect(standingOf(s, both, true, ["g"])).toEqual({ waits: "review" });
    expect(standingOf(s, both, false, ["h"])).toEqual({ waits: "grant h" });
    // An API-only route that lacks a grant waits on the blocker too; with no token it is plain `none`.
    expect(standingOf(s, { api } as never, true, ["g"])).toEqual({ waits: "review" });
    expect(standingOf(s, { api } as never, false, [])).toBeUndefined();
    // A stated wait (a webhook in review) shows once the API answers.
    const hook = { api, browser: leg, standing: { waits: "review" } } as never;
    expect(standingOf(s, hook, false, [])).toEqual({ waits: CONNECT });
    expect(standingOf(s, hook, true, [])).toEqual({ waits: "review" });
    expect(
      standingOf(s, { browser: leg, standing: { final: "no API" } } as never, false, []),
    ).toEqual({
      final: "no API",
    });
  });

  const sites: PathSite[] = [
    {
      site: "s",
      blockers: { review },
      routes: [
        { method: "GET", path: "/api", via: "api" },
        { method: "GET", path: "/hook", via: "api", standing: { waits: "review" } },
        { method: "GET", path: "/page", via: "browser", standing: { final: "no API" } },
        { method: "POST", path: "/post", via: "browser", standing: { waits: "review" } },
        { method: "POST", path: "/both", via: "browser", standing: { waits: CONNECT } },
        { method: "GET", path: "/gone", via: "none", missing: "flow s/f not recorded" },
        {
          method: "POST",
          path: "/gated",
          via: "none",
          missing: "waiting on g",
          standing: { waits: "review" },
        },
      ],
    },
  ];

  it("reports what is settled and what waits, by blocker", () => {
    expect(pathsReport(sites)).toEqual({
      settled: [{ site: "s", api: 1, browser: 1 }],
      waiting: [
        {
          id: "review",
          site: "s",
          blocker: review,
          routes: [
            { route: "GET /hook", via: "api" },
            { route: "POST /post", via: "browser" },
            { route: "POST /gated", via: "none" },
          ],
        },
        { id: CONNECT, site: "s", routes: [{ route: "POST /both", via: "browser" }] },
      ],
      final: [{ site: "s", route: "GET /page", why: "no API" }],
      none: [{ site: "s", route: "GET /gone", missing: "flow s/f not recorded" }],
    });
  });

  it("names a route that ran a leg other than the stated one", () => {
    const row = (route: string, template: string, via: "api" | "browser", at: string) => ({
      site: "s",
      route,
      template,
      via,
      at,
    });
    const rows = [
      row("GET /api", "/api", "api", "2026-11-01T00:00:00Z"),
      row("GET /api", "/api", "browser", "2026-11-02T00:00:00Z"),
      row("GET /page", "/page", "browser", "2026-11-02T00:00:00Z"),
      row("POST /both", "/both", "api", "2026-11-03T00:00:00Z"),
      { site: "s", route: "GET /old", at: "2026-10-01T00:00:00Z" },
    ];
    expect(drift(sites, rows)).toEqual([
      {
        site: "s",
        route: "GET /api",
        stated: "api",
        ran: { api: 1, browser: 1 },
        last: "2026-11-02T00:00:00Z",
      },
      {
        site: "s",
        route: "POST /both",
        stated: "browser",
        ran: { api: 1, browser: 0 },
        last: "2026-11-03T00:00:00Z",
      },
    ]);
    expect(drift(sites, rows, (_s, r) => r === "GET /api")).toHaveLength(1);
  });
});
