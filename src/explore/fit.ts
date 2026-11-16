/** Long answers: compacted evenly to a budget, the whole kept in a file beside the session. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compactText } from "./compact.js";

/** A compacted answer's whole, beside the session's shots; the answer names the file. */
export function keepWhole(dir: string, kind: string, text: string, ext = "txt"): string {
  const file = join(dir, "whole", `${kind}-${Date.now()}.${ext}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** Text over budget: compacted evenly, the whole kept. */
export function fitText(dir: string, kind: string, text: string, budget: number) {
  const c = compactText(text, budget);
  if (!c.even) return { text };
  return { text: c.text, whole: { chars: text.length, file: keepWhole(dir, kind, text) } };
}
