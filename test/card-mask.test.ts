import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardMask, cardShown } from "../src/browser/card-mask.js";

const FRAME =
  "<input autocomplete=cc-number value='4242 4242 4242 4242' style='width:200px;height:30px'>";
const PAGE = `<body style="margin:0;background:#fff">
<input id=name value="Ada" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
<input id=num autocomplete="cc-number" style="position:absolute;left:10px;top:60px;width:200px;height:30px">
<input id=cvc name="cvc" style="position:absolute;left:10px;top:110px;width:200px;height:30px">
<iframe name="__privateStripeFrame1" src="/frame" style="position:absolute;left:10px;top:160px;width:240px;height:50px;border:0"></iframe>
<iframe id=plain src="/frame" style="position:absolute;left:10px;top:230px;width:240px;height:50px;border:0"></iframe>`;

/** The picture's color at a point, read back by the page's own canvas. */
const colorAt = (page: Page, png: Buffer, x: number, y: number) =>
  page.evaluate(
    async ([b64, px, py]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(px as number, py as number, 1, 1).data].slice(0, 3).join(",");
    },
    [png.toString("base64"), x, y] as const,
  );

describe("card mask", () => {
  const server = createServer((q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end(q.url === "/frame" ? FRAME : PAGE),
  );
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 400, height: 320 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  });
  afterAll(async () => {
    await browser?.close();
    server.close();
  });

  const PINK = "255,0,255";

  it("covers card fields and card frames, in every frame, and nothing else", async () => {
    const png = await page.screenshot({ mask: cardMask(page) });
    expect(await colorAt(page, png, 100, 75)).toBe(PINK); // cc-number
    expect(await colorAt(page, png, 100, 125)).toBe(PINK); // named cvc
    expect(await colorAt(page, png, 230, 200)).toBe(PINK); // vendor frame, whole
    expect(await colorAt(page, png, 100, 245)).toBe(PINK); // a card input in a plain frame
    expect(await colorAt(page, png, 230, 270)).not.toBe(PINK); // the plain frame's rest
    expect(await colorAt(page, png, 100, 25)).not.toBe(PINK); // the name field
  });

  it("says when a card field holds a value", async () => {
    expect(await cardShown(page)).toBe(true); // the frames' inputs
    await page.goto(`${page.url()}`);
    await page.evaluate(() => {
      for (const f of document.querySelectorAll("iframe")) f.remove();
    });
    expect(await cardShown(page)).toBe(false);
    await page.fill("#cvc", "123");
    expect(await cardShown(page)).toBe(true);
  });
});
