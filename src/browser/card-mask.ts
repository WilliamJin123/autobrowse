/**
 * A screenshot is a print: card fields are covered in every picture a page gives (WA-1020).
 * Covered: inputs a browser would fill from a card (`autocomplete=cc-*`), inputs named as a
 * card number, expiry or security code, and the hosted card frames of the payment vendors
 * (the frame whole, so a field it draws without markup is covered too).
 */
import type { Locator, Page } from "playwright";

const named = (words: string[]) =>
  words.flatMap((w) =>
    ["name", "id", "placeholder", "aria-label", "data-testid"].map((a) => `input[${a}*="${w}" i]`),
  );

export const CARD_FIELDS = [
  'input[autocomplete^="cc-" i]',
  ...named([
    "cardnumber",
    "card-number",
    "card_number",
    "card number",
    "ccnum",
    "cvc",
    "cvv",
    "csc",
    "security code",
    "expir",
    "exp-date",
    "exp_date",
    "mm / yy",
    "mm/yy",
  ]),
].join(", ");

export const CARD_FRAMES = [
  'iframe[name^="__privateStripeFrame"]',
  'iframe[src*="js.stripe.com"]',
  'iframe[name^="braintree-hosted-field"]',
  'iframe[src*="braintreegateway.com"]',
  'iframe[src*="adyen.com"]',
  'iframe[src*="squarecdn.com"]',
  'iframe[src*="checkout.com"]',
  'iframe[src*="paypal.com"][title*="card" i]',
  'iframe[title*="card number" i]',
  'iframe[title*="secure payment" i]',
  'iframe[title*="secure card" i]',
].join(", ");

/** The `mask` of a `page.screenshot`: every card field and card frame, in every frame. */
export const cardMask = (page: Page): Locator[] =>
  page.frames().map((f) => f.locator(`${CARD_FIELDS}, ${CARD_FRAMES}`));

const SHOWN = `[...document.querySelectorAll(${JSON.stringify(CARD_FIELDS)})].some((e) => (e.value ?? "").trim() !== "")`;

/** A card field with a value in it, in any frame: an OS picture of the window would print it. */
export async function cardShown(page: Page): Promise<boolean> {
  const hits = await Promise.all(
    page.frames().map((f) => f.evaluate<boolean>(SHOWN).catch(() => false)),
  );
  return hits.some(Boolean);
}
