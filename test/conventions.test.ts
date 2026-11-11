import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { flowIssues, routeIssues } from "../src/sites/conventions.js";
import { SITES } from "../src/sites/index.js";
import { route, type SiteApi } from "../src/sites/types.js";

describe("conventions (U4)", () => {
  it("every site route keeps the house rules", () => {
    expect(SITES.flatMap(routeIssues)).toEqual([]);
  });

  it("every hand-written flow keeps the house rules", () => {
    expect(flowIssues(BROWSER_FLOWS)).toEqual([]);
  });

  it("a flow with no strategies, or listed off its name, is named", () => {
    const f = { site: "t", name: "Bad_Name", run: async () => null } as never;
    expect(flowIssues({ "t/other": f })).toEqual([
      "t/other: listed under a name not its site/name",
      "t/other: name is not kebab-case",
      "t/other: no strategies",
    ]);
  });

  it("names each broken rule", () => {
    const bad: SiteApi = {
      site: "t",
      origin: "https://t",
      auth: { open: true },
      setup: [],
      routes: [
        route({
          method: "GET",
          path: "items/:id",
          summary: "",
          request: z.object({}),
          ported: "opencli/x",
        }),
        route({
          method: "POST",
          path: "/p/{id}",
          summary: "x",
          request: z.object({}),
          irreversible: true,
          api: async () => ({}),
        }),
      ],
    } as unknown as SiteApi;
    expect(routeIssues(bad)).toEqual([
      "t GET items/:id: path starts with /",
      "t GET items/:id: path params are {name}, not :name",
      "t GET items/:id: no summary",
      "t GET items/:id: no leg",
      "t GET items/:id: ported is not clis/<site>/<file>@<sha> (opencli/x)",
      "t POST /p/{id}: irreversible with no verify",
      "t POST /p/{id}: path param {id} not in the request",
    ]);
  });
});

describe("route scaffold (U4)", () => {
  it("puts path params in the request, and a verify on a write", async () => {
    const { routeScaffold } = await import("../src/sites/conventions.js");
    const read = routeScaffold("GET", "/users/{id}/posts");
    expect(read).toContain("id: z.string().min(1),");
    expect(read).not.toContain("irreversible");
    const write = routeScaffold("POST", "/posts");
    expect(write).toContain("irreversible: true");
    expect(write).toContain("verify: { none:");
  });
});
