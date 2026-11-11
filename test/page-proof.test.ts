import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pageErrorLog } from "../src/browser/page-errors.js";
import {
  brokenIds,
  compareProofs,
  errorIds,
  type Proof,
  proofFlags,
  proofPage,
  visibleOver,
  type WidthProof,
} from "../src/browser/page-proof.js";

const w = (o: Partial<WidthProof>): WidthProof => ({
  width: 390,
  scrolls: false,
  pageWidth: 390,
  over: [],
  cut: [],
  errors: [],
  broken: [],
  shot: null,
  ...o,
});
const proof = (url: string, ...widths: WidthProof[]): Proof => ({ url, at: "", widths });

describe("page proof", () => {
  it("one bug on two hosts is one identity; stacks and resets do not count", () => {
    const a = w({
      errors: [{ message: "TypeError at http://localhost:5173/app.js\n  at f (x:1)" }],
      broken: [
        { url: "http://localhost:5173/logo.png", status: 404, type: "image" },
        {
          url: "http://localhost:5173/fav.ico",
          status: 0,
          type: "image",
          failure: "net::ERR_ABORTED",
        },
      ],
    });
    const b = w({
      errors: [{ message: "TypeError at https://wren.app/app.js\n  at g (y:9)" }],
      broken: [{ url: "https://wren.app/logo.png", status: 404, type: "image" }],
    });
    expect(errorIds(a, "http://localhost:5173")).toEqual(["TypeError at <origin>/app.js"]);
    expect(brokenIds(a, "http://localhost:5173")).toEqual(["<origin>/logo.png 404"]);
    expect(
      compareProofs(proof("http://localhost:5173/", a), proof("https://wren.app/", b)),
    ).toEqual([]);
  });
  it("a swap at the same count is a change", () => {
    const a = w({ broken: [{ url: "https://x.io/a.png", status: 404, type: "image" }] });
    const b = w({ broken: [{ url: "https://x.io/b.png", status: 404, type: "image" }] });
    const d = compareProofs(proof("https://x.io/", a), proof("https://x.io/", b));
    expect(d).toEqual([
      {
        width: 390,
        field: "broken",
        before: "1: <origin>/a.png 404",
        after: "1: <origin>/b.png 404",
      },
    ]);
  });
  it("overflow and cut text are flagged and compared by box", () => {
    const box = { sel: "div.hero", left: 0, right: 520, width: 520 };
    const a = w({
      scrolls: true,
      pageWidth: 520,
      over: [box],
      cut: [{ ...box, sel: "span.name", text: "William" }],
    });
    expect(proofFlags(proof("https://x.io/", a))).toEqual([
      "390: scrolls sideways (page 520 px)",
      "390: div.hero past the edge (0..520)",
      '390: span.name text cut ("William")',
    ]);
    const fields = compareProofs(proof("https://x.io/", w({})), proof("https://x.io/", a)).map(
      (d) => d.field,
    );
    expect(fields).toEqual(["scrolls", "over", "cut"]);
  });
  it("a closed drawer off a page that never scrolls is no fault", () => {
    const drawer = { sel: "nav.drawer", left: -300, right: 0, width: 300 };
    const half = { sel: "div.wide", left: 0, right: 600, width: 600 };
    expect(visibleOver([drawer, half], 390, false)).toEqual([half]);
    expect(visibleOver([drawer], 390, true)).toEqual([drawer]);
  });
  it.runIf(process.env.LIVE === "1")("live: a wide page at 390 and 1280", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/gone.png") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<body style="margin:0"><div style="width:800px;height:20px">wide</div><img src="/gone.png">
         <p style="width:80px;overflow:hidden;white-space:nowrap">a long name that is cut</p></body>`,
      );
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const dir = mkdtempSync(join(tmpdir(), "proof-"));
      const p = await proofPage(page, {
        url: `http://127.0.0.1:${port}/`,
        errors: pageErrorLog(),
        shotPath: (x) => join(dir, `${x}.png`),
        settleMs: 100,
      });
      const [narrow, wide] = p.widths as [WidthProof, WidthProof];
      expect(narrow.scrolls).toBe(true);
      expect(narrow.over.map((b) => b.sel)).toContain("div");
      expect(wide.scrolls).toBe(false);
      expect(narrow.cut[0]?.sel).toBe("p");
      expect(brokenIds(narrow, `http://127.0.0.1:${port}`)).toEqual(["<origin>/gone.png 404"]);
    } finally {
      await browser.close();
      srv.close();
    }
  });
});
