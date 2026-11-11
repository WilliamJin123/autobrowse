/**
 * What our routes wait on (designs/2026-11-05-path-standing.md): one entry per review, grant,
 * beta, paid or partner API, or leg of ours not built. An id is wren's review id where one
 * exists (`app-reviews.ts`). An API we do not hold yet is a blocker however far off it is: the
 * browser is the stand-in, never the answer for good (William, 11-05).
 * When one clears: delete it here. The standing test then names each route to move to the API.
 */
import type { Blocker } from "./types.js";

/** Meta holds Advanced Access behind business verification, which needs a legal document. */
export const META_APP: Blocker = {
  what: "Meta App Review (Advanced Access, with threads_keyword_search), after Meta Business Verification: that needs William's legal business document and phone. Parked 11-03: no entity yet. It gives Threads search and Instagram hashtag search (Instagram Public Content Access) by API, comment and message webhooks, and Page messaging",
  task: "WA-1048",
  since: "2026-11-03",
  grants: ["pages_manage_engagement", "messaging"],
};

export const TIKTOK_DIRECT_POST: Blocker = {
  what: "TikTok Direct Post audit: until it passes, an API post is private only (403 unaudited_client, 10-24). Not filed; parked 11-03 (WA-1030)",
  since: "2026-10-24",
};

/** The Organic API's Accounts part, apart from the Display and Content Posting APIs we hold. */
export const TIKTOK_BUSINESS: Blocker = {
  what: "TikTok API for Business (Accounts API): an app approved on business-api.tiktok.com, and a Business account. It reads and answers comments on our own videos (`/business/comment/list/`) and gives a video's insights (`/business/video/list/`). Others' videos stay on the browser. Not filed; reviews parked 11-03 (WA-1030)",
  task: "WA-1030",
  since: "2026-11-05",
};

export const LINKEDIN_PAGES: Blocker = {
  what: "LinkedIn Community Management API: the Development tier is granted on the Wren Pages app, and its token is site `linkedin-pages` (2026-11-11). Never apply for it again. `linkedin`'s Page routes (posts, comments, counts, uploads as a Page) take that token through `borrows` (WA-1311). Routes that act as the member still wait: their grants are partner-only. The Standard tier review is William's to file",
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
  what: "Reddit Devvit external endpoints beta: filed 10-24. The Data API was refused 09-27, 10-15 and 10-25: never apply again. The public Data API closes 2027-03. The Devvit app posts, answers and reads our own posts and inbox, as the app account, where a subreddit has it installed; every other read and act stays on the browser",
  task: "WA-fdxh",
  since: "2026-10-24",
};

/** Held back by William's cost call, not by X: the API leg of these routes answers today. */
export const X_PAID_READS: Blocker = {
  what: "X API reads, billed per result on pay-per-use (no free tier since 2026-02). William's call of 11-03: read the signed-in page while the volume is small. At scale the API is the path: flip `prefer` on these routes",
  since: "2026-11-03",
};

export const X_ENTERPRISE: Blocker = {
  what: "X Enterprise API: follow and like left every self-serve tier on 2026-04-16. Profile edits are v1.1 only (OAuth 1.0a); not verified that any tier still answers them. Not asked for: far off",
  since: "2026-04-16",
};

export const LINKEDIN_PARTNER: Blocker = {
  what: "LinkedIn partner programs (Sales Navigator, Talent Solutions, Compliance): member search, profiles, invitations, connections and messages. Closed to new partners now. Which call each program gives is not verified per route. Not asked for: far off",
  since: "2026-11-05",
};

export const REDDIT_COMMERCIAL: Blocker = {
  what: "Reddit Data API under a commercial agreement: subreddit, search and user reads, messages, joins. The free Data API was refused 09-27, 10-15 and 10-25 (never apply to it again), and our Devvit app does none of these. Not asked for: far off",
  since: "2026-10-25",
};

export const GOOGLE_PLACES: Blocker = {
  what: "Google Places API (Place Details), billed per call. Not set up: the Maps page answers while the volume is small",
  since: "2026-11-05",
};

/** Ours to set up: a host for our own media. */
export const INSTAGRAM_IMAGE_URL: Blocker = {
  what: "Graph takes an image only by public URL (a video goes by resumable upload on meta, WA-1112). A local image needs a media host: wren's prod sets no WREN_MEDIA_BUCKET",
  since: "2026-11-11",
};
