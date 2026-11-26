/**
 * A page function as a string expression with a local `__name`. tsx (esbuild keepNames) wraps
 * named helpers inside a function in `__name(...)`; the page has none. Local scope: no global
 * the site could see.
 */
export function inPage<A>(fn: (arg: A) => unknown, arg?: A): string {
  const json = arg === undefined ? "" : JSON.stringify(arg);
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${json}); })()`;
}
