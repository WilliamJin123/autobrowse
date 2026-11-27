/** Writes catalog.json from the code (U3). Run after adding or dropping a route, flow or workflow. */
import { writeFileSync } from "node:fs";
import { addSiteLogins } from "../src/auth/sites.js";
import { CATALOG_FILE, catalogNow } from "../src/catalog-file.js";
import { repoWalkLogins } from "../src/walks/login.js";

// as at boot: each repo sign-in walk is a `<site>-login` workflow
addSiteLogins(repoWalkLogins(), { builtIn: true });
const c = catalogNow();
writeFileSync(CATALOG_FILE, `${JSON.stringify(c, null, 2)}\n`);
console.log(`${c.routes.length} routes, ${c.flows.length} flows, ${c.workflows.length} workflows`);
