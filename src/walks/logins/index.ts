/**
 * Repo sign-in walks (designs/2026-11-26-branching-sign-ins.md, option A):
 * one `<site>.ts` per site, `export default { … } satisfies WalkSpecInput`.
 * Listed by hand: the npm build has no `.ts` to scan. A site's file and the
 * removal of its built-in `SiteLogin` go in one commit.
 */

import type { WalkSpecInput } from "../spec.js";
import apple from "./apple.js";
import costco from "./costco.js";
import discord from "./discord.js";
import facebook from "./facebook.js";
import instagram from "./instagram.js";
import instantly from "./instantly.js";
import intuit from "./intuit.js";
import npm from "./npm.js";
import reddit from "./reddit.js";
import tiktok from "./tiktok.js";
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
];
