/**
 * Repo sign-in walks (designs/2026-11-26-branching-sign-ins.md, option A):
 * one `<site>.ts` per site, `export default { … } satisfies WalkSpecInput`.
 * Listed by hand: the npm build has no `.ts` to scan. A site's file and the
 * removal of its built-in `SiteLogin` go in one commit.
 */

import type { WalkSpecInput } from "../spec.js";

export const LOGIN_WALK_FILES: readonly WalkSpecInput[] = [];
