/**
 * Turn on TOTP for a site ourselves: open its two-factor page, read the
 * seed the page shows, confirm with a code we generate, store the seed.
 * From then on the login needs nobody. `readSecretFromPage` is the
 * site-agnostic half; the page walk is per site.
 */

import type { CredentialStore } from "credvault";
import { findTotpSecret, totp } from "credvault";
import type { Page } from "playwright";
import { defineFlow, type FlowPage } from "../browser/flow.js";
import { LoginFailed, type SiteLogin, type TotpSetupSpec } from "./login.js";

/** How long a page gets to draw the seed after a click. */
const RENDER_MS = 8_000;

/**
 * The seed on the current page: the otpauth link behind the QR (HTML), or
 * the manual key in what a person sees: the open dialog first, since a
 * whole page's text can hold other 16-letter runs.
 */
export async function readSecretFromPage(fp: FlowPage): Promise<string | null> {
  return seedIn(await fp.html(), await dialogText(fp.page), await fp.text());
}

/** The same read on a bare page, every frame's HTML: explore's `seed` (Oracle's sign-in enrollment, 11-10). */
export async function seedOnPage(page: Page): Promise<string | null> {
  const htmls = await Promise.all(page.frames().map((f) => f.content().catch(() => "")));
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  return seedIn(htmls.join("\n"), await dialogText(page), text);
}

const dialogText = (page: Page) =>
  page
    .locator("[role=dialog]")
    .first()
    .innerText({ timeout: 500 })
    .catch(() => "");

/** otpauth link first, then a key in the open dialog, then the page's text. */
export function seedIn(html: string, dialog: string, text: string): string | null {
  const uri = html.match(/otpauth:\/\/totp\/[^\s"'<>]+/i)?.[0];
  if (uri) return findTotpSecret(uri.replaceAll("&amp;", "&"));
  return findTotpSecret(dialog) ?? findTotpSecret(text);
}

/** The seed once the page shows it: pages draw the key a beat after the click. */
async function readSecretWithin(fp: FlowPage, ms: number): Promise<string | null> {
  const step = 500;
  for (let waited = 0; ; waited += step) {
    const secret = await readSecretFromPage(fp);
    if (secret || waited >= ms) return secret;
    await fp.wait(step);
  }
}

/** Record a freshly enrolled seed and prove it by producing a code the caller submits. */
export async function storeSeed(
  store: CredentialStore,
  site: string,
  secret: string,
  now: () => number = Date.now,
): Promise<string> {
  const cred = await store.get(site);
  if (!cred) throw new LoginFailed(site, "enroll TOTP: no credential stored for the site");
  await store.put(site, { ...cred, totpSecret: secret });
  return totp(secret, { at: now() });
}

/** When the site's walk is unknown: the seed may be behind one obvious button. */
const GUESS: Omit<TotpSetupSpec, "url"> = {
  reveal: [{ role: "button", name: "/set up|add|enable|turn on/i" }],
  code: { role: "textbox" },
  confirm: { role: "button", name: "/verify|confirm|continue|enable|activate/i" },
  done: /enabled|turned on|added|success/i,
};

/**
 * The enrollment as a flow: walk to the seed, store it, prove it with a
 * code, confirm. The seed never leaves the process: page → store.
 */
export function enrollTotpFlow(
  login: Pick<SiteLogin, "site" | "credential" | "totpSetup">,
  store: CredentialStore,
  url?: string,
) {
  const spec: TotpSetupSpec | null = login.totpSetup
    ? login.totpSetup
    : url
      ? { url, ...GUESS }
      : null;
  if (!spec) throw new LoginFailed(login.site, "enroll TOTP: no setup page known; pass --url");
  const credName = login.credential ?? login.site;
  return defineFlow<undefined, string>({
    site: login.site,
    name: "enroll-totp",
    async run(fp) {
      const cred = await store.get(credName);
      if (!cred)
        throw new LoginFailed(login.site, `enroll TOTP: no credential stored for ${credName}`);
      await fp.open(typeof spec.url === "string" ? spec.url : spec.url(cred));
      let secret = await readSecretWithin(fp, RENDER_MS);
      for (const step of spec.reveal) {
        if (secret) break;
        const clicked = await fp.act({ kind: "click" }, step, { goal: "toward the seed" }).then(
          () => true,
          () => false,
        );
        if (!clicked) break;
        secret = await readSecretWithin(fp, RENDER_MS);
      }
      if (!secret) return fp.human("no TOTP seed visible on the page");
      const code = await storeSeed(store, credName, secret);
      for (const step of spec.toCode ?? []) {
        await fp.act({ kind: "click" }, step, { goal: "to the code box" });
        await fp.wait(1_000);
      }
      await fp.act({ kind: "fill", value: code }, spec.code, { goal: "type the first code" });
      await fp.act({ kind: "click" }, spec.confirm, { goal: "confirm authenticator" });
      await fp.wait(2_000);
      const text = (await fp.text()).replace(/\s+/g, " ");
      if (!spec.done.test(text))
        return `seed stored for ${credName}; page did not confirm, says: ${text.slice(0, 200)}`;
      return `TOTP enrolled for ${credName}`;
    },
  });
}
