/**
 * What our routes wait on outside our code (designs/2026-11-05-path-standing.md): one entry per
 * review, grant or beta. An id is wren's review id where one exists (`app-reviews.ts`).
 * When one clears: delete it here. The standing test then names each route to move to the API.
 */
import type { Blocker } from "./types.js";

/** Meta holds Advanced Access behind business verification, which needs a legal document. */
export const META_APP: Blocker = {
  what: "Meta App Review (Advanced Access, with threads_keyword_search), after Meta Business Verification: that needs William's legal business document and phone. Parked 11-03: no entity yet. It gives Threads search by API, comment and message webhooks, and Page messaging",
  task: "WA-1048",
  since: "2026-11-03",
  grants: ["pages_manage_engagement", "messaging"],
};

export const TIKTOK_DIRECT_POST: Blocker = {
  what: "TikTok Direct Post audit: until it passes, an API post is private only (403 unaudited_client, 10-24). Not filed; parked 11-03 (WA-1030)",
  since: "2026-10-24",
};

export const LINKEDIN_PAGES: Blocker = {
  what: "LinkedIn Community Management API, Development tier: filed 10-09, in review since 10-12. Never apply again. It gives Page posts, comments, reactions and post statistics",
  task: "WA-1032",
  since: "2026-10-09",
  grants: [
    "w_organization_social",
    "r_organization_social",
    "r_member_social",
    "w_member_social_feed",
  ],
};

export const REDDIT_DEVVIT: Blocker = {
  what: "Reddit Devvit external endpoints beta: filed 10-24. The Data API was refused 09-27, 10-15 and 10-25: never apply again. The public Data API closes 2027-03",
  task: "WA-fdxh",
  since: "2026-10-24",
};
