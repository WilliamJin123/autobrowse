import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findArgs,
  pictureArgs,
  RENDER_PARTS,
  readArgs,
  renderArgs,
  trackedIds,
  wrenCheckout,
  wrenIn,
} from "./service.js";

describe("studio", () => {
  it("renders with the cut pass first, narrowed to one part on ask", () => {
    expect(renderArgs(12)).toEqual(["video", "render", "12", "--cut"]);
    expect(renderArgs(12, "shorts")).toEqual([
      "video",
      "render",
      "12",
      "--cut",
      "--only",
      "shorts",
    ]);
    expect(RENDER_PARTS).toContain("long");
    expect(renderArgs(12, undefined, true)).toEqual(["video", "render", "12", "--cut", "--again"]);
  });

  it("runs the desk's own wren checkout when there is one, else the main one", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    expect(wrenCheckout(ws, {})).toBe(join(ws, "wren"));
    mkdirSync(join(ws, "wren-desk/scripts"), { recursive: true });
    writeFileSync(join(ws, "wren-desk/scripts/prod-wren.mjs"), "");
    expect(wrenCheckout(ws, {})).toBe(join(ws, "wren-desk"));
    expect(wrenCheckout(ws, { AUTOBROWSE_WREN_CHECKOUT: "/elsewhere" })).toBe("/elsewhere");
  });

  it("says why a run failed, from its last lines", async () => {
    await expect(wrenIn("/nowhere")(["video", "watch"], 5000)).rejects.toThrow(/exit|ENOENT/);
  });

  it("finds with the labeled reading logins, then reads what it tracked", () => {
    expect(findArgs(7)).toEqual([
      "creator",
      "find",
      "--request",
      "7",
      "--account",
      "x=x@wren",
      "--account",
      "linkedin=linkedin@wren",
      "--json",
    ]);
    expect(findArgs(7).join(" ")).not.toMatch(/instagram/);
    expect(readArgs([3, 5])).toEqual([
      "creator",
      "refresh",
      "--id",
      "3",
      "--id",
      "5",
      "--account",
      "x=x@wren",
      "--account",
      "linkedin=linkedin@wren",
      "--json",
    ]);
    expect(pictureArgs([3])).toEqual(["creator", "pictures", "--id", "3"]);
    expect(trackedIds('wren: source changed\n{"state":"found","track":[1,2,3]}')).toEqual([
      1, 2, 3,
    ]);
    expect(trackedIds("no json")).toEqual([]);
    expect(trackedIds('{"state":"found"}')).toEqual([]);
  });
});
