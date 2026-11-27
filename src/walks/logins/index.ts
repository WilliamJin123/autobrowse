/**
 * Repo sign-in walks (designs/2026-11-26-branching-sign-ins.md, option A):
 * one `<site>.ts` per site, `export default { … } satisfies WalkSpecInput`.
 * Listed by hand: the npm build has no `.ts` to scan. A site's file and the
 * removal of its built-in `SiteLogin` go in one commit.
 */

import type { WalkSpecInput } from "../spec.js";
import anthropic from "./anthropic.js";
import apple from "./apple.js";
import aws from "./aws.js";
import costco from "./costco.js";
import discord from "./discord.js";
import facebook from "./facebook.js";
import github from "./github.js";
import hubspot from "./hubspot.js";
import instagram from "./instagram.js";
import instantly from "./instantly.js";
import intuit from "./intuit.js";
import linkedin from "./linkedin.js";
import npm from "./npm.js";
import perplexity from "./perplexity.js";
import reddit from "./reddit.js";
import sentry from "./sentry.js";
import tiktok from "./tiktok.js";
import twilio from "./twilio.js";
import x from "./x.js";

export const LOGIN_WALK_FILES: readonly WalkSpecInput[] = [
  instagram,
  facebook,
  x,
  tiktok,
  instantly,
  intuit,
  npm,
  apple,
  discord,
  reddit,
  costco,
  linkedin,
  github,
  anthropic,
  twilio,
  sentry,
  hubspot,
  perplexity,
  aws,
];
