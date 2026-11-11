/** Writes catalog.json from the code (U3). Run after adding or dropping a route, flow or workflow. */
import { writeFileSync } from "node:fs";
import { CATALOG_FILE, catalogNow } from "../src/catalog-file.js";

const c = catalogNow();
writeFileSync(CATALOG_FILE, `${JSON.stringify(c, null, 2)}\n`);
console.log(`${c.routes.length} routes, ${c.flows.length} flows, ${c.workflows.length} workflows`);
