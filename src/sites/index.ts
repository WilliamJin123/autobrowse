export { CALCOM_ORIGIN, calcom } from "./calcom.js";
export { connectorProfile, connectors } from "./connectors.js";
export { DISCORD_API, discord, inviteUrl } from "./discord.js";
export { DRIVE_ORIGIN, drive, driveOAuth } from "./drive.js";
export {
  ARM_MS,
  ARMS_PER_PROFILE,
  type Armed,
  type CallFrom,
  type CheckRow,
  checkSite,
  matchPath,
  type RouteRow,
  type SetupRow,
  type SiteFacade,
  type SiteFacadeDeps,
  type SiteRow,
  siteFacade,
} from "./facade.js";
export { fbPublic } from "./fb-public.js";
export { gmail, gmailOAuth } from "./gmail.js";
export {
  type CallHook,
  type HookCall,
  type HookOutcome,
  withHooks,
} from "./hooks.js";
export { instagram } from "./instagram.js";
export { langfuse } from "./langfuse.js";
export { linkedin } from "./linkedin.js";
export { LOOM_ORIGIN, loom } from "./loom.js";
export { meta, metaOAuth } from "./meta.js";
export { createRegistryUser, NPM_TOKEN, npm } from "./npm.js";
export { accessTokens, accountEnv, runConsent } from "./oauth.js";
export { outlook } from "./outlook.js";
export { PERPLEXITY_API, perplexity } from "./perplexity.js";
export { REDDIT_ORIGIN, reddit, redditPublic } from "./reddit.js";
export {
  fileSendJournal,
  memorySendJournal,
  type SendJournal,
  type SendRecord,
} from "./send-journal.js";
export {
  DESK_SERVICE,
  SITES_SERVICE,
  type SitesService,
  sitesService,
  VERIFY_AGAIN_MS,
  VERIFY_GAP_MS,
  VERIFY_HELD_MS,
  VERIFY_RETRY_MS,
  VERIFY_WAIT_MS,
} from "./service.js";
export { THREADS_MAX, threads, threadsOAuth } from "./threads.js";
export { tiktok } from "./tiktok.js";
export * from "./types.js";
export { web } from "./web.js";
export { profileOf, type SiteParts, sitesFor } from "./wire.js";
export { x, xOAuth } from "./x.js";
export { youtube } from "./youtube.js";

import { calcom } from "./calcom.js";
import { connectors } from "./connectors.js";
import { discord } from "./discord.js";
import { drive } from "./drive.js";
import { fbPublic } from "./fb-public.js";
import { gmail } from "./gmail.js";
import { instagram } from "./instagram.js";
import { langfuse } from "./langfuse.js";
import { linkedin } from "./linkedin.js";
import { loom } from "./loom.js";
import { meta } from "./meta.js";
import { npm } from "./npm.js";
import { chatgpt, gemini } from "./open/answers.js";
import { arxiv } from "./open/arxiv.js";
import { bluesky } from "./open/bluesky.js";
import { dblp } from "./open/dblp.js";
import { devto } from "./open/devto.js";
import { hackernews } from "./open/hackernews.js";
import { indeed, upwork } from "./open/jobs.js";
import { lobsters } from "./open/lobsters.js";
import { medium } from "./open/medium.js";
import { bbc, bloomberg, reuters } from "./open/news.js";
import { openalex } from "./open/openalex.js";
import { openreview } from "./open/openreview.js";
import { producthunt } from "./open/producthunt.js";
import { pubmed } from "./open/pubmed.js";
import { googleScholar } from "./open/scholar.js";
import { stackoverflow } from "./open/stackoverflow.js";
import { substack } from "./open/substack.js";
import { wikidata, wikipedia } from "./open/wiki.js";
import { yahooFinance } from "./open/yahoo-finance.js";
import { outlook } from "./outlook.js";
import { perplexity } from "./perplexity.js";
import { reddit, redditPublic } from "./reddit.js";
import { threads } from "./threads.js";
import { tiktok } from "./tiktok.js";
import type { SiteApi } from "./types.js";
import { web } from "./web.js";
import { x } from "./x.js";
import { youtube } from "./youtube.js";

/** Every site autobrowse serves under its official API's shape. */
export const SITES: readonly SiteApi[] = [
  // open research reads, ported from OpenCLI (WA-1251.5)
  arxiv,
  openalex,
  pubmed,
  dblp,
  openreview,
  wikipedia,
  wikidata,
  // open community reads (WA-1251.5 A2)
  stackoverflow,
  hackernews,
  lobsters,
  devto,
  bluesky,
  substack,
  medium,
  // open news and finance (WA-1251.5 A3)
  bbc,
  bloomberg,
  reuters,
  yahooFinance,
  producthunt,
  googleScholar,
  indeed,
  upwork,
  chatgpt,
  gemini,
  linkedin,
  youtube,
  instagram,
  threads,
  tiktok,
  outlook,
  gmail,
  drive,
  langfuse,
  meta,
  x,
  reddit,
  redditPublic,
  loom,
  npm,
  calcom,
  web,
  perplexity,
  discord,
  fbPublic,
  connectors,
];
export * from "./verdict.js";
