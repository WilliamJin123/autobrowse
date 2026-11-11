/**
 * What a site shows an account it has limited (OpenCLI audit U8). A hit on a failed run holds the
 * whole account (`caps` bucket `*`): `suspended` and `restricted` from the longest step, `limit`
 * from the first. Only the account's own state: a profile of someone else that says "account
 * suspended" is a missing page, not ours. A checkpoint (verify it's you) is a sign-in step a
 * person answers (`personStep`), never a hold.
 */
export type BanKind = "suspended" | "restricted" | "limit";

export interface BanSignal {
  kind: BanKind;
  url?: RegExp;
  text?: RegExp;
}

export interface BanHit {
  site: string;
  kind: BanKind;
  /** The words around the match, or the URL: what the site said. */
  said: string;
}

export const BAN_SIGNALS: Record<string, BanSignal[]> = {
  linkedin: [
    {
      kind: "restricted",
      text: /we(?:'|’)ve restricted your account|your account (?:has been|is) (?:temporarily )?restricted/i,
    },
    {
      kind: "limit",
      text: /you(?:'|’)ve reached the weekly (?:invitation )?limit|too many requests from your account/i,
    },
  ],
  x: [
    { kind: "suspended", text: /your account is suspended/i },
    {
      kind: "restricted",
      url: /x\.com\/account\/access\b/i,
      text: /your account has been locked|some of your account features are (?:currently )?limited/i,
    },
    { kind: "limit", text: /rate limit exceeded|you are over the daily limit/i },
  ],
  instagram: [
    {
      kind: "suspended",
      url: /instagram\.com\/accounts\/suspended\b/i,
      text: /we suspended your account|your account has been (?:disabled|suspended)/i,
    },
    {
      kind: "limit",
      text: /we restrict certain activity to protect our community|try again later\s+we limit how often/i,
    },
  ],
  facebook: [
    {
      kind: "suspended",
      text: /your account has been (?:disabled|suspended)|we suspended your account/i,
    },
    {
      kind: "restricted",
      text: /you(?:'|’)re temporarily (?:restricted|blocked)|your account is restricted/i,
    },
    { kind: "limit", text: /you can(?:'|’)t use this feature right now/i },
  ],
  tiktok: [
    {
      kind: "suspended",
      text: /your account was (?:permanently )?banned|your account (?:has been|was) suspended/i,
    },
    { kind: "limit", text: /you are visiting too fast|maximum number of attempts reached/i },
  ],
  reddit: [
    { kind: "suspended", text: /your account has been (?:permanently )?suspended/i },
    { kind: "limit", text: /you(?:'|’)re doing that too much|you are doing that too much/i },
  ],
  google: [
    {
      kind: "suspended",
      text: /your (?:google )?account (?:has been|is|was) (?:disabled|suspended)/i,
    },
    {
      kind: "limit",
      url: /google\.[a-z.]+\/sorry\//i,
      text: /our systems have detected unusual traffic from your computer network/i,
    },
  ],
};
BAN_SIGNALS.youtube = BAN_SIGNALS.google as BanSignal[];

const around = (text: string, i: number, len: number) =>
  text
    .slice(Math.max(0, i - 40), i + len + 80)
    .replace(/\s+/g, " ")
    .trim();

/** The first signal the page shows for `site` (`linkedin@wren` reads as `linkedin`), or null. */
export function banHit(site: string, url: string, text: string): BanHit | null {
  const base = site.split("@")[0]?.toLowerCase() ?? site;
  for (const s of BAN_SIGNALS[base] ?? []) {
    if (s.url?.test(url)) return { site: base, kind: s.kind, said: url };
    const m = s.text?.exec(text);
    if (m) return { site: base, kind: s.kind, said: around(text, m.index, m[0].length) };
  }
  return null;
}
