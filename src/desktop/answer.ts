/** An `os` answer as it leaves a socket (explore's or the desktop session's). */
import { fitText } from "../explore/fit.js";
import { redactText } from "../recorder/redact.js";
import type { ActResult } from "./hands.js";

/** Tree text and shell output masked; long output to a file. */
export function desktopAnswer(r: ActResult, shotsDir: string): Record<string, unknown> {
  const a = { ...r.answer };
  const fitOut = (key: string, budget: number) => {
    if (typeof a[key] !== "string") return;
    const f = fitText(shotsDir, key, redactText(a[key] as string), budget);
    a[key] = f.text;
    if (f.whole) a[`${key}Whole`] = f.whole;
  };
  // Output can hold tokens: masked like everything else that leaves the socket.
  fitOut("tree", 12_000); // a terminal's scrollback is one big value
  fitOut("stdout", 4_000);
  fitOut("stderr", 1_000);
  return a;
}
