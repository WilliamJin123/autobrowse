/**
 * Our saved posts, newest saved first: `/my-items/saved-posts/`. Read only:
 * it scrolls and presses "Show more results"; it never opens a post or a menu.
 *
 * Mapped 2026-11-12 in explore. The page is the old Ember search-results
 * layout: each post is a `[data-chameleon-result-urn="urn:li:activity:N"]`
 * block; inside, `entity-result__content-actor` holds the author link
 * (`/in/<member id>?miniProfileUrn=…`), the badge ("• 1st"), the headline
 * and the age line ("11mo •"); `entity-result__content-summary` holds the
 * whole text (clamped by CSS, so `innerText` is all of it); images are the
 * author's photo (alt = their name) and the post's (alt "Image preview").
 * The page shows no counts.
 */
import { defineFlow } from "../flow.js";
import type { Hints } from "../locate.js";
import { scrollCollect } from "../scroll-collect.js";
import { ageAt } from "./linkedin-notifications.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const CARD = "main [data-chameleon-result-urn]";
const RENDER_MS = 15_000;
const EMPTY = /no saved (posts|items)|start saving|nothing saved/i;
const SHOW_MORE: Hints = { role: "button", name: "/^(show|see) more results$/i" };
const AGE = /^(\d+(?:mo|min|yr|hr|s|m|h|d|w|y))\s*•?/;

/** One block as the page holds it. */
export interface RawSaved {
  urn: string;
  text: string;
  actor: string;
  summary?: string;
  links: string[];
  images: Array<{ alt: string; src: string }>;
}

export interface SavedPost {
  /** `urn:li:activity:N` */
  urn: string;
  url: string;
  author: { name: string | null; url: string | null; headline: string | null };
  text: string;
  /** The page's age label ("11mo"), and the instant it reads as at the read. */
  age?: string;
  at?: string;
  approx?: true;
  images: string[];
  raw: RawSaved;
}

/** A string, not a function: tsx wraps named helpers in `__name`, which the page lacks. */
export const READ_SAVED = `(() => [...document.querySelectorAll(${JSON.stringify(CARD)})].map((card) => {
  const actor = card.querySelector(".entity-result__content-actor");
  const summary = card.querySelector(".entity-result__content-summary");
  return {
    urn: card.getAttribute("data-chameleon-result-urn") || "",
    text: card.innerText,
    actor: actor ? actor.innerText : "",
    ...(summary ? { summary: summary.innerText.replace(/\\s*…\\s*see more\\s*$/i, "").trim() } : {}),
    links: [...card.querySelectorAll("a[href]")].map((a) => a.href),
    images: [...card.querySelectorAll("img")].map((i) => ({ alt: i.alt || "", src: i.src || "" })),
  };
}))()`;

const lines = (t: string) =>
  t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** One block as an item; null with no urn or no text. */
export function savedOf(raw: RawSaved, now: Date): SavedPost | null {
  if (!/^urn:li:(activity|ugcPost|share):\d+$/.test(raw.urn)) return null;
  const text = (raw.summary ?? "").trim();
  if (!text) return null;
  const actor = lines(raw.actor).filter((l) => !/^View .+’s profile$|^•\s*\d|^Visible to /.test(l));
  const ageIndex = actor.findIndex((l) => AGE.test(l));
  const age = ageIndex >= 0 ? AGE.exec(actor[ageIndex] ?? "")?.[1] : undefined;
  const at = age ? ageAt(age, now) : null;
  const name = actor[0] ?? null;
  const headline = ageIndex > 1 ? actor.slice(1, ageIndex).join(" ") : null;
  const profile = raw.links.find((l) => /linkedin\.com\/(in|company)\//.test(l));
  return {
    urn: raw.urn,
    url: `${WEB}/feed/update/${raw.urn}/`,
    author: {
      name,
      url: profile ? (profile.split("?")[0] ?? null) : null,
      headline: headline || null,
    },
    text,
    ...(age ? { age } : {}),
    ...(at ? { at, approx: true as const } : {}),
    images: raw.images.filter((i) => i.alt === "Image preview" && i.src).map((i) => i.src),
    raw,
  };
}

export interface LinkedinSavedInput {
  /** Most posts read, newest saved first (default 100). */
  max?: number;
}

export const linkedinSaved = defineFlow<LinkedinSavedInput, { posts: SavedPost[] }>({
  site: "linkedin",
  name: "saved",
  strategies: ["ui"],
  async run(fp, input) {
    const max = Math.min(Math.max(1, input.max ?? 100), 1000);
    await go(fp, `${WEB}/my-items/saved-posts/`);
    if (!(await fp.has({ css: CARD }, RENDER_MS))) {
      if (EMPTY.test(await fp.text())) return { posts: [] };
      return fp.human(`no saved-posts list at ${fp.url()}`);
    }
    const now = new Date();
    const { rows } = await scrollCollect(fp, {
      read: async () =>
        (await fp.page.evaluate<RawSaved[]>(READ_SAVED))
          .map((r) => savedOf(r, now))
          .filter((p): p is SavedPost => p !== null),
      key: (p) => p.urn,
      max,
      more: async () => {
        if (!(await fp.has(SHOW_MORE, 1_500))) return false;
        await fp.act({ kind: "click" }, SHOW_MORE, { goal: "load more saved posts" });
        return true;
      },
    });
    return { posts: rows };
  },
});
