/**
 * LinkedIn acts on others through the signed-in page: like a post, follow a member or a company.
 * No API gives a member's reactions or follows to anyone but partners. Run as linkedin@wren only;
 * capped per account (sites/linkedin.ts).
 *
 * Mapped 2026-10-09 in explore as linkedin@wren. A post page (`/feed/update/<urn>/`) labels its
 * like "Reaction button state: no reaction" ("… like", "… celebrate" once reacted). A profile's
 * top card has "Follow <Name>" beside "Invite <Name> to connect"; a member whose main button is
 * Connect keeps Follow under "More". A company page shows "Follow <Company>". Once followed, the
 * label reads "Following <Name>" (or "Unfollow …").
 */
import { already } from "../attempt.js";
import { defineFlow } from "../flow.js";
import type { Hints } from "../locate.js";
import { actAndProve, firstShown, stateOf } from "./kit.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";

const MISSING = /this page doesn.t exist|page not found|this post (?:cannot|can.t) be displayed/i;

/**
 * The act's own calls (voyager, any non-GET): reactions, and following states for follows. Not
 * mapped live; a miss costs one reload, the proof then.
 */
const ACT_CALL = /linkedin\.com\/voyager\/api\/\S*(reaction|followingstate|follow)/i;

const unreacted: Hints = { role: "button", name: "/^reaction button state: no reaction$/i" };
const reacted: Hints = {
  role: "button",
  name: "/^reaction button state: (?!no reaction)\\w+/i",
};

export interface LikeInput {
  /** `urn:li:activity:N`, `urn:li:ugcPost:N` or `urn:li:share:N`. */
  urn: string;
  undo?: boolean;
}

export const linkedinLike = defineFlow<
  LikeInput,
  { urn: string; liked: boolean; already?: true } | { found: false; reason: string }
>({
  site: "linkedin",
  name: "like",
  strategies: ["ui"],
  async run(fp, { urn, undo }) {
    await go(fp, `${WEB}/feed/update/${urn}/`);
    const state = await firstShown(fp, [reacted, unreacted], MISSING);
    if (state === "missing") return { found: false, reason: `no LinkedIn post ${urn}` };
    if (state === null) return fp.human(`no Like on post ${urn} (${fp.url()})`);
    const liked = state === 0;
    if (liked === !undo) return already({ urn, liked, already: true });
    const url = `${WEB}/feed/update/${urn}/`;
    await actAndProve(fp, {
      click: () =>
        fp.act({ kind: "click" }, undo ? reacted : unreacted, {
          goal: `${undo ? "take back the like on" : "like"} post ${urn}`,
        }),
      call: ACT_CALL,
      what: `${undo ? "unlike" : "like"} on ${urn}`,
      reload: { open: () => go(fp, url), state: stateOf(fp, reacted, unreacted, MISSING) },
      want: !undo,
    });
    return { urn, liked: !undo };
  },
});

// The first match is the top card's: "People also follow" sits below it in the page.
const off: Hints = { css: 'main button[aria-label^="Follow " i]' };
const on: Hints = {
  css: 'main button[aria-label^="Following " i], main button[aria-label^="Unfollow " i]',
};
const more: Hints = {
  css: 'main section button[aria-label="More" i], main section button[aria-label="More actions" i]',
};
const followItem: Hints = { css: 'main section div[role=button][aria-label^="Follow " i]' };
const unfollowItem: Hints = { css: 'main section div[role=button][aria-label^="Unfollow " i]' };
const confirmUnfollow: Hints = { role: "button", name: "/^unfollow$/i" };

export interface FollowInput {
  /** A member's `/in/<vanity>/`. */
  vanity?: string;
  /** Or a company's `/company/<handle>/`. */
  company?: string;
  undo?: boolean;
}

export const linkedinFollow = defineFlow<
  FollowInput,
  { following: boolean; already?: true } | { found: false; reason: string }
>({
  site: "linkedin",
  name: "follow",
  strategies: ["ui"],
  async run(fp, { vanity, company, undo }) {
    const who = vanity
      ? `/in/${encodeURIComponent(vanity)}/`
      : company
        ? `/company/${encodeURIComponent(company)}/`
        : null;
    if (!who) throw new Error("linkedin/follow: a vanity or a company");
    await go(fp, `${WEB}${who}`);
    // Follow sits under More for a member whose main button is Connect.
    const inMore = async (): Promise<boolean | null> => {
      await fp.act({ kind: "click" }, more, { goal: "open More on the profile" });
      if (await fp.has(unfollowItem, 5_000)) return true;
      return (await fp.has(followItem, 2_000)) ? false : null;
    };
    const top = await firstShown(fp, [on, off, more], MISSING);
    if (top === "missing") return { found: false, reason: `nothing at ${who}` };
    if (top === null) return fp.human(`no Follow on ${who} (${fp.url()})`);
    const underMore = top === 2;
    const following = underMore ? await inMore() : top === 0;
    const followState = async (): Promise<boolean | null> => {
      const n = await firstShown(fp, [on, off, more], MISSING);
      return n === 2 ? inMore() : n === 0 ? true : n === 1 ? false : null;
    };
    if (following === null) return fp.human(`no Follow under More on ${who}`);
    if (following === !undo) return already({ following, already: true });
    await actAndProve(fp, {
      click: async () => {
        await fp.act(
          { kind: "click" },
          underMore ? (undo ? unfollowItem : followItem) : undo ? on : off,
          { goal: `${undo ? "unfollow" : "follow"} ${who}` },
        );
        if (undo && (await fp.has(confirmUnfollow, 3_000)))
          await fp.act({ kind: "click" }, confirmUnfollow, { goal: "confirm the unfollow" });
      },
      call: ACT_CALL,
      what: `${undo ? "unfollow" : "follow"} of ${who}`,
      reload: { open: () => go(fp, `${WEB}${who}`), state: followState },
      want: !undo,
    });
    return { following: !undo };
  },
});
