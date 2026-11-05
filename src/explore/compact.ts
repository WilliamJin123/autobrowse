/**
 * Answers that fit a budget, without a hard cut (designs/2026-11-05-async-leverage.md §4).
 * Values: JSON if it fits, else TOON (lossless), else an even cut across the whole value.
 * Text: a tree loses its deepest levels first, then every line is shortened alike, then lines
 * are sampled evenly. Every gap says what it left out. The caller keeps the whole in a file.
 */
import { encode } from "@toon-format/toon";

export type Compacted =
  | { kind: "json"; value: unknown }
  | { kind: "toon"; text: string; even: boolean }
  | { kind: "text"; text: string; even: boolean };

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const gapText = (n: number) => ` …${n} chars… `;

/** Head and tail, the gap marked. */
function shortString(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(max - 16, 8);
  const head = Math.ceil((keep * 2) / 3);
  const tail = keep - head;
  return `${s.slice(0, head)}${gapText(s.length - keep)}${tail ? s.slice(-tail) : ""}`;
}

/** k places from 0 to n-1, evenly spaced, both ends kept. */
function evenPlaces(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k <= 1) return [0];
  const out = new Set<number>();
  for (let j = 0; j < k; j++) out.add(Math.round((j * (n - 1)) / (k - 1)));
  return [...out];
}

/** Lists keep k items evenly (objects get `_i`, their place); strings keep s chars. */
function even(v: unknown, k: number, s: number): unknown {
  if (typeof v === "string") return shortString(v, s);
  if (Array.isArray(v)) {
    const at = evenPlaces(v.length, k);
    if (at.length === v.length) return v.map((x) => even(x, k, s));
    if (v.every(isPlain))
      return at.map((i) => ({ _i: i, ...(even(v[i], k, s) as Record<string, unknown>) }));
    const out: unknown[] = [];
    at.forEach((i, j) => {
      const prev = j ? (at[j - 1] as number) : -1;
      if (i - prev > 1) out.push(`…${i - prev - 1} more…`);
      out.push(even(v[i], k, s));
    });
    return out;
  }
  if (isPlain(v))
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, even(x, k, s)]));
  return v;
}

function longest(v: unknown): { list: number; str: number } {
  let list = 0;
  let str = 0;
  const walk = (x: unknown): void => {
    if (typeof x === "string") str = Math.max(str, x.length);
    else if (Array.isArray(x)) {
      list = Math.max(list, x.length);
      for (const y of x) walk(y);
    } else if (isPlain(x)) for (const y of Object.values(x)) walk(y);
  };
  walk(v);
  return { list, str };
}

export function compactValue(v: unknown, budget: number): Compacted {
  if ((JSON.stringify(v) ?? "").length <= budget) return { kind: "json", value: v };
  const toon = encode(v);
  if (toon.length <= budget) return { kind: "toon", text: toon, even: false };
  // Lists and strings shrink together, by the same factor each try, until it fits.
  const top = longest(v);
  let k = top.list;
  let s = top.str;
  for (let i = 0; i < 40 && (k > 3 || s > 60); i++) {
    k = Math.max(3, Math.floor(k * 0.6));
    s = Math.max(60, Math.floor(s * 0.6));
    const text = encode(even(v, k, s));
    if (text.length <= budget) return { kind: "toon", text, even: true };
  }
  // Too many keys for any list or string cut: the text's own even cut.
  return { kind: "toon", text: compactText(encode(even(v, 3, 60)), budget).text, even: true };
}

const lines_ = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

const depthOf = (line: string): number => (/^ */.exec(line)?.[0].length ?? 0) / 2;

/** Runs of left-out lines become one line at the run's first indent. */
function withGaps(lines: string[], keep: (i: number) => boolean): string[] {
  const out: string[] = [];
  let run = 0;
  let indent = "";
  lines.forEach((line, i) => {
    if (keep(i)) {
      if (run) out.push(`${indent}…${lines_(run)}…`);
      run = 0;
      out.push(line);
    } else {
      if (!run) indent = /^ */.exec(line)?.[0] ?? "";
      run++;
    }
  });
  if (run) out.push(`${indent}…${lines_(run)}…`);
  return out;
}

export function compactText(text: string, budget: number): { text: string; even: boolean } {
  if (text.length <= budget) return { text, even: false };
  const lines = text.split("\n");
  const render = (keep: (i: number) => boolean, width: number) =>
    withGaps(
      lines.map((l) => shortString(l, width)),
      keep,
    ).join("\n");
  // The lines later steps pick from: all, or a tree's shallowest outline.
  let base = lines.map((_, i) => i);
  // A tree (aria, an outline): the deepest levels go first, the outline stays.
  const indented = lines.filter((l) => /^ {2,}\S/.test(l)).length;
  if (indented > lines.length / 3) {
    const depths = lines.map(depthOf);
    for (let d = Math.max(...depths) - 1; d >= 1; d--) {
      const out = render((i) => (depths[i] as number) <= d, Infinity);
      if (out.length <= budget) return { text: out, even: true };
    }
    base = base.filter((i) => (depths[i] as number) <= 1);
  }
  const inBase = new Set(base);
  // Every line shortened alike: the page keeps its order and each part its head.
  const widest = Math.max(...base.map((i) => (lines[i] as string).length));
  for (let w = widest; w > 80; ) {
    w = Math.max(80, Math.floor(w * 0.7));
    const out = render((i) => inBase.has(i), w);
    if (out.length <= budget) return { text: out, even: true };
  }
  // Lines sampled evenly, both ends kept; each gap counts the lines it stands for.
  let out = render((i) => inBase.has(i), 80);
  for (let k = base.length; k > 2 && out.length > budget; ) {
    k = Math.max(2, Math.floor(k * 0.7));
    const at = new Set(evenPlaces(base.length, k).map((j) => base[j] as number));
    out = render((i) => at.has(i), 80);
  }
  return { text: out, even: true };
}
