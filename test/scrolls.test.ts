import { describe, expect, it } from "vitest";
import { renderOp } from "../src/compiler/render.js";
import { keepScrolls, mergeScrolls } from "../src/compiler/scrolls.js";
import type { Action } from "../src/recorder/types.js";

const base = { at: "2026-11-17T00:00:00Z", url: "https://x.test/" };
const scroll = (dy: number, o: { moved?: number; loaded?: boolean; pane?: string } = {}) =>
  ({
    ...base,
    kind: "scroll",
    dy,
    ...(o.moved !== undefined ? { moved: o.moved } : {}),
    ...(o.loaded ? { loaded: true } : {}),
    ...(o.pane ? { target: { role: "dialog", name: o.pane } } : {}),
  }) as unknown as Action;
const target = { role: "button", name: "Go" };
const click = { ...base, kind: "click", target } as unknown as Action;
const read = { ...base, kind: "read", target, as: "title", value: "x" } as unknown as Action;
const note = { ...base, kind: "note", text: "Feed" } as unknown as Action;
const nav = { ...base, kind: "navigate" } as unknown as Action;
const keep = (acts: Action[], o?: { breaks?: string[] }) =>
  keepScrolls(
    acts,
    (a) => a,
    (_, s) => s,
    o,
  ).map((a) => (a.kind === "scroll" ? `scroll ${a.dy}${a.loaded ? " loaded" : ""}` : a.kind));

describe("merge scrolls", () => {
  it("back-to-back scrolls with no load are their net move, by what moved", () => {
    expect(
      mergeScrolls([scroll(800), scroll(800, { moved: 300 })] as never).map((s) => s.dy),
    ).toEqual([1100]);
    expect(mergeScrolls([scroll(500), scroll(-500)] as never)).toEqual([]);
  });

  it("a run that loaded goes to its deepest point, then back when far", () => {
    const run = [scroll(2000, { loaded: true }), scroll(-1500)] as never;
    expect(mergeScrolls(run).map((s) => [s.dy, s.loaded ?? false])).toEqual([
      [2000, true],
      [-1500, false],
    ]);
    // a person's small overshoot is not replayed
    expect(
      mergeScrolls([scroll(2000, { loaded: true }), scroll(-60)] as never).map((s) => s.dy),
    ).toEqual([2000]);
  });
});

describe("keep scrolls", () => {
  it("keeps a scroll before a read, merged", () => {
    expect(keep([scroll(400), scroll(400), read])).toEqual(["scroll 800", "read"]);
  });

  it("drops looking around: before a control, a load, the end", () => {
    expect(keep([scroll(900), click])).toEqual(["click"]);
    expect(keep([scroll(900), nav])).toEqual(["navigate"]);
    expect(keep([click, scroll(900)])).toEqual(["click"]);
  });

  it("keeps a scroll that loaded rows a control needs", () => {
    expect(keep([scroll(3000, { loaded: true }), click])).toEqual(["scroll 3000 loaded", "click"]);
  });

  it("notes pass, unless they break the run (a new step)", () => {
    expect(keep([scroll(500), note, read])).toEqual(["note", "scroll 500", "read"]);
    expect(keep([scroll(500), note, read], { breaks: ["note"] })).toEqual(["note", "read"]);
  });

  it("another pane ends the run", () => {
    expect(keep([scroll(300, { pane: "List" }), scroll(700), read])).toEqual([
      "scroll 700",
      "read",
    ]);
  });
});

describe("render", () => {
  it("a scroll op is fp.scroll, with its pane when it has one", () => {
    expect(renderOp({ kind: "scroll", goal: "scroll down", dy: 800 })).toBe(
      "    await fp.scroll(800);",
    );
    expect(
      renderOp({
        kind: "scroll",
        goal: "scroll down",
        dy: -300,
        hints: { role: "dialog", name: "List" },
      }),
    ).toBe('    await fp.scroll(-300, { role: "dialog", name: "List" });');
  });
});
