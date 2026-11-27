import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecretBox } from "../src/browser/flow-api.js";
import { doOp, WrongSecretBox } from "../src/browser/flow-steps.js";
import { instantHands } from "../src/browser/human/index.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});

/** One box on the page; the secret's fill into it; what the box holds after. */
async function fillInto(box: string, into: SecretBox) {
  await page.setContent(`<label>Box ${box}</label>`);
  const err = await doOp(
    page,
    { css: "#b" },
    { kind: "fill", value: "s3cret", into },
    2_000,
    instantHands,
  ).catch((e: unknown) => e);
  return { err, value: await page.inputValue("#b").catch(() => "") };
}

describe("a secret goes only into its kind of box", () => {
  it("a password into input[type=password]; into a text box, nothing typed", async () => {
    expect(await fillInto('<input id="b" type="password">', "password")).toEqual({
      err: undefined,
      value: "s3cret",
    });
    const wrong = await fillInto('<input id="b" type="text" name="password">', "password");
    expect(wrong.err).toBeInstanceOf(WrongSecretBox);
    expect(String(wrong.err)).toMatch(/input\[type=text\]/);
    expect(wrong.value).toBe("");
  });

  it("a code into a box that reads as a code box", async () => {
    for (const box of [
      '<input id="b" autocomplete="one-time-code">',
      '<input id="b" type="tel" maxlength="6">',
      '<input id="b" inputmode="numeric">',
      '<input id="b" name="verificationCode">',
    ])
      expect((await fillInto(box, "code")).value, box).toBe("s3cret");
  });

  it("a code never into an email, username, password or plain box", async () => {
    for (const box of [
      '<input id="b" type="email">',
      '<input id="b" name="username">',
      '<input id="b" type="password">',
      '<input id="b">',
      '<textarea id="b"></textarea>',
    ]) {
      const got = await fillInto(box, "code");
      expect(got.err, box).toBeInstanceOf(WrongSecretBox);
      expect(got.value, box).toBe("");
    }
  });
});
