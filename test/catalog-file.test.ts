import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_FILE, type CatalogFile, catalogDiff, catalogNow } from "../src/catalog-file.js";
import type { Ability } from "../src/do/catalog.js";
import { listAbilities, useOf } from "../src/do/list.js";

describe("catalog.json (U3)", () => {
  it("matches the code: a dropped or added route, flow or workflow is a reviewed change", () => {
    const was = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as CatalogFile;
    const { gone, added } = catalogDiff(was, catalogNow());
    expect(
      { gone, added },
      "catalog.json is stale: `pnpm catalog`, then commit it with the change",
    ).toEqual({ gone: [], added: [] });
  });

  it("names what went and what came", () => {
    const was = { routes: ["a GET /x read"], flows: ["a/f"], workflows: [] };
    const now = { routes: [], flows: ["a/f", "a/g"], workflows: [] };
    expect(catalogDiff(was, now)).toEqual({
      gone: ["routes: a GET /x read"],
      added: ["flows: a/g"],
    });
  });
});

const ab = (kind: Ability["kind"], name: string, summary = ""): Ability => ({
  kind,
  name,
  site: kind === "site" ? (name.split(" ")[0] ?? null) : null,
  summary,
  inputs: [],
  irreversible: false,
  ready: true,
  missing: null,
});

describe("autobrowse list (U3)", () => {
  const all = [
    ab("site", "hackernews GET /search", "Algolia search"),
    ab("site", "arxiv GET /search", "papers"),
    ab("workflow", "domain", "Buy a domain"),
    ab("flow", "google/search", "Google's results page"),
  ];

  it("pages with a next command that keeps the filters", () => {
    const p = listAbilities(all, { limit: 2 });
    expect(p.total).toBe(4);
    expect(p.items.map((a) => a.name)).toEqual(["google/search", "arxiv GET /search"]);
    expect(p.next).toBe("autobrowse list --limit 2 --offset 2 --json");
    expect(listAbilities(all, { limit: 2, offset: 2 }).next).toBeNull();
  });

  it("finds by words and filters by kind", () => {
    expect(listAbilities(all, { query: "domain" }).items[0]?.name).toBe("domain");
    expect(
      listAbilities(all, { kind: "site", query: "search" }).items.every((a) => a.kind === "site"),
    ).toBe(true);
  });

  it("says the command that uses each", () => {
    expect(useOf(all[0] as Ability)).toBe(
      "autobrowse site call hackernews GET /search --body '<json>'",
    );
    expect(useOf(all[2] as Ability)).toBe("autobrowse workflows domain");
  });
});
