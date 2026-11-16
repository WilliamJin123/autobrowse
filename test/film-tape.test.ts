import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { showsAnew } from "../src/film/director.js";
import { loadTape } from "../src/film/tape.js";

const tapeFile = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "tape-")), "demo.tape.json");
  writeFileSync(f, JSON.stringify(body));
  return f;
};

describe("tape", () => {
  it("keeps a browser size apart from the terminal's; unset, the browser takes `size`", async () => {
    const wide = await loadTape(
      tapeFile({ size: [760, 1080], browser: [1440, 810], steps: [{ type: "ls" }] }),
    );
    expect(wide).toMatchObject({ size: [760, 1080], browser: [1440, 810] });
    expect((await loadTape(tapeFile({ steps: [{ type: "ls" }] }))).browser).toBeUndefined();
  });

  it("refuses a step it does not know, with the file in the error", async () => {
    const f = tapeFile({ steps: [{ click: "#go" }] });
    await expect(loadTape(f)).rejects.toThrow(`${f} is not a tape`);
  });

  it("waits only for text shown after the last key", () => {
    const mark = "❯ echo hi";
    expect(showsAnew(mark, mark, "❯")).toBe(false);
    expect(showsAnew(`${mark}\nhi\n❯`, mark, "❯")).toBe(true);
    // The typed line holds "hi" too; the answer under it is still new.
    expect(showsAnew(`${mark}\nhi`, mark, "hi")).toBe(true);
  });
});
