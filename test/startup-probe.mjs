// Preloaded by cli-loads.test.ts: on exit, the npm packages the CLI process loaded, one JSON line on stderr.
import { registerHooks } from "node:module";

if (process.argv[1]?.endsWith("/src/app/cli.ts")) {
  const loaded = new Set();
  registerHooks({
    load(url, ctx, next) {
      const at = url.lastIndexOf("/node_modules/");
      if (at >= 0) {
        const [a = "", b = ""] = url.slice(at + 14).split("/");
        loaded.add(a.startsWith("@") ? `${a}/${b}` : a);
      }
      return next(url, ctx);
    },
  });
  process.on("exit", () => console.error(`LOADED ${JSON.stringify([...loaded].sort())}`));
}
