// Preload for the checkout's CLI (bin/autobrowse, `pnpm autobrowse`): Node runs src/*.ts itself.
// - imports say `./x.js` (NodeNext); the file is `./x.ts`
// - compiled code is kept per file, so a start compiles only what changed
// Types are stripped by Node, never transformed: tsconfig `erasableSyntaxOnly` holds the source to that.
import { enableCompileCache, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

enableCompileCache(fileURLToPath(new URL("../node_modules/.cache/compile", import.meta.url)));

const src = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && spec.endsWith(".js") && ctx.parentURL?.startsWith(src)) {
      try {
        return next(`${spec.slice(0, -3)}.ts`, ctx);
      } catch {
        // a real .js beside the source
      }
    }
    return next(spec, ctx);
  },
});
