/**
 * What a local browser tells a site about the machine: the UA, the client
 * hints behind it, `navigator.platform`, languages, screen and DPR. It is
 * never written down per platform. It is read off this host's own Chrome,
 * so a Mac, the Linux box or a Windows laptop each say what a person on
 * that machine's Chrome would say, and the headers follow the device.
 *
 * Headed Chrome is already true and is left alone. Headless Chrome is
 * learned once, then made to say the same with one word changed:
 * "HeadlessChrome" becomes "Chrome". Chrome for Testing says only
 * "Chromium" in its brands: `chrome: true` adds "Google Chrome" in the
 * order Google Chrome of that version sends.
 */
import type { BrowserContext, Frame, Page } from "playwright";

type Brand = { brand: string; version: string };

export interface Fingerprint {
  userAgent: string;
  /** `navigator.platform`: "MacIntel", "Linux x86_64", "Win32". */
  platform: string;
  /** `Accept-Language`, as Chrome would build it from the profile's languages. */
  acceptLanguage: string;
  /** Chrome's own client hints (CDP `UserAgentMetadata`). */
  metadata: {
    brands: Brand[];
    fullVersionList: Brand[];
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
}

const unheadless = (list: Brand[]) =>
  list.map((b) => (b.brand === "HeadlessChrome" ? { ...b, brand: "Google Chrome" } : b));

/** Chromium's brand order: [grease, Chromium, brand] placed by `orders[major % 6]` (user_agent_utils.cc; measured on Chrome 158). */
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/** The list Google Chrome of the same version says; unchanged when it has no Chromium or grease entry. */
export function chromeBrands(list: Brand[]): Brand[] {
  const chromium = list.find((b) => b.brand === "Chromium");
  const grease = list.find(
    (b) => !["Chromium", "Google Chrome", "HeadlessChrome"].includes(b.brand),
  );
  if (!chromium || !grease) return unheadless(list);
  const [g, c, b] = ORDERS[Number.parseInt(chromium.version, 10) % 6] ?? ORDERS[0];
  const out: Brand[] = [];
  out[g] = grease;
  out[c] = chromium;
  out[b] = { brand: "Google Chrome", version: chromium.version };
  return out;
}

/** Where the fingerprint is read: https (client hints need a secure context), answered locally. */
const PROBE_URL = "https://fingerprint.autobrowse.invalid/";

/**
 * Read the fingerprint off a page of this host's Chrome; `headless` says whether it needs wearing.
 * `chrome`: say Google Chrome's brands (the `chrome` engine, whose CfT build lacks them).
 */
export async function learnFingerprint(
  page: Page,
  o: { chrome?: boolean } = {},
): Promise<{ headless: boolean; fingerprint: Fingerprint }> {
  const brands = o.chrome ? chromeBrands : unheadless;
  await page.route(PROBE_URL, (r) => r.fulfill({ contentType: "text/html", body: "" }));
  // Opera GX aborts the first navigation of a fresh profile (its start page wins): once more
  await page.goto(PROBE_URL).catch((err: Error) => {
    if (!/ERR_ABORTED/.test(err.message)) throw err;
    return page.goto(PROBE_URL);
  });
  await page.unroute(PROBE_URL);
  const seen = await page.evaluate(async () => {
    const data = (
      navigator as Navigator & {
        userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> };
      }
    ).userAgentData;
    const high = data
      ? await data.getHighEntropyValues([
          "architecture",
          "bitness",
          "brands",
          "fullVersionList",
          "model",
          "platformVersion",
          "wow64",
        ])
      : {};
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      languages: [...navigator.languages],
      high,
    };
  });
  const h = seen.high as Partial<Fingerprint["metadata"]>;
  return {
    headless: seen.ua.includes("HeadlessChrome"),
    fingerprint: {
      userAgent: seen.ua.replace("HeadlessChrome", "Chrome"),
      platform: seen.platform,
      acceptLanguage: seen.languages.join(","),
      metadata: {
        brands: brands(h.brands ?? []),
        fullVersionList: brands(h.fullVersionList ?? []),
        platform: h.platform ?? "",
        platformVersion: h.platformVersion ?? "",
        architecture: h.architecture ?? "",
        model: h.model ?? "",
        mobile: h.mobile ?? false,
        bitness: h.bitness ?? "",
        wow64: h.wow64 ?? false,
      },
    },
  };
}

/**
 * Say `id` on every page and every cross-site frame (a captcha lives in
 * one). Launch with `--user-agent=<id.userAgent>` as well: that flag covers
 * requests made before this lands, but alone it sends the detailed hints
 * (arch, OS version) blank.
 */
export function wearFingerprint(context: BrowserContext, id: Fingerprint): void {
  const wear = (target: Page | Frame) =>
    context
      .newCDPSession(target)
      .then((cdp) =>
        cdp.send("Emulation.setUserAgentOverride", {
          userAgent: id.userAgent,
          acceptLanguage: id.acceptLanguage,
          platform: id.platform,
          userAgentMetadata: id.metadata,
        }),
      )
      .catch(() => undefined); // a same-site frame shares its page's session: nothing to set
  const onPage = (page: Page) => {
    void wear(page);
    page.on("frameattached", (f) => void wear(f));
  };
  for (const p of context.pages()) onPage(p);
  context.on("page", onPage);
}

/** A headless page's screen: what a common display of this OS measures. */
const SCREENS: Partial<Record<NodeJS.Platform, { width: number; height: number; dpr: number }>> = {
  darwin: { width: 1512, height: 982, dpr: 2 }, // a 14" MacBook
  win32: { width: 1920, height: 1080, dpr: 1.25 },
};
const OTHER_SCREEN = { width: 1920, height: 1080, dpr: 1 };

/**
 * Window, screen and DPR, consistent with a real machine:
 * - headed: no emulation at all. A forced viewport gives `outerHeight` below
 *   `innerHeight`, a screen the size of the page and DPR 1 on a Retina Mac;
 *   reCAPTCHA Enterprise refuses the checkbox for it.
 * - headless: a page inside a larger screen, at the OS's usual DPR.
 */
export function geometry(
  headless: boolean,
  os: NodeJS.Platform = process.platform,
  place?: { x: number; y: number; w: number; h: number },
) {
  // a place opens the window there: no move after launch
  if (!headless)
    return {
      viewport: null,
      args: place
        ? [`--window-position=${place.x},${place.y}`, `--window-size=${place.w},${place.h}`]
        : ["--window-size=1280,900"],
    };
  const screen = SCREENS[os] ?? OTHER_SCREEN;
  return {
    viewport: { width: 1280, height: 800 },
    screen: { width: screen.width, height: screen.height },
    deviceScaleFactor: screen.dpr,
    args: [] as string[],
  };
}
