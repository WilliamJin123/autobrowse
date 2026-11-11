/**
 * Proof fixtures (OpenCLI audit U16): what a compiled workflow's output must look like, as
 * `expect.json` beside it. Seeded from the first good proof; each later proof is checked
 * against it, so a run that "worked" on a sign-in wall or an empty list is not proven.
 * Never rewritten by code: a person (or a heal they approve) edits it, and never to loosen
 * it to make a run pass.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EXPECT_FILE = "expect.json";

export type ValueType = "string" | "number" | "boolean" | "array" | "object" | "null";

export interface FieldExpect {
  notEmpty?: true;
  type?: ValueType;
  /** A regex source the text must match. */
  pattern?: string;
  /** An array's length. */
  rowCount?: { min: number; max?: number };
}

export interface Expect {
  /** The proof it was seeded from. */
  seededFrom: string;
  fields: Record<string, FieldExpect>;
  /** Text the whole output must not hold, any case: a wall read as data. */
  mustNotContain: string[];
}

/** Words a wall puts where the data should be. */
export const WALL_WORDS = [
  "sign in to",
  "log in to",
  "unusual activity",
  "verify you are human",
  "access denied",
  "too many requests",
  "captcha",
];

const PATTERNS: Array<[RegExp, string]> = [
  [/^https?:\/\/\S+$/, "^https?://"],
  [/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "^[^@\\s]+@[^@\\s]+$"],
  [/^-?[\d,]+(\.\d+)?$/, "^-?[\\d,]+(\\.\\d+)?$"],
];

/** An output value as JSON when it is JSON text (`"[...]"`), else itself. */
const parsed = (v: unknown): unknown => {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const typeOf = (v: unknown): ValueType =>
  v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as ValueType);

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && !v.trim()) ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Fixtures from a good output: its types, what was not empty, shapes of plain values. */
export function seedExpect(output: Record<string, unknown>, at: string): Expect {
  const fields: Record<string, FieldExpect> = {};
  for (const [k, raw] of Object.entries(output)) {
    const v = parsed(raw);
    const f: FieldExpect = { type: typeOf(v) };
    if (!isEmpty(v)) f.notEmpty = true;
    if (Array.isArray(v) && v.length) f.rowCount = { min: 1 };
    if (typeof v === "string") {
      const hit = PATTERNS.find(([re]) => re.test(v.trim()));
      if (hit) f.pattern = hit[1];
    }
    fields[k] = f;
  }
  const text = JSON.stringify(output).toLowerCase();
  return { seededFrom: at, fields, mustNotContain: WALL_WORDS.filter((w) => !text.includes(w)) };
}

/** What the output misses, one line each; empty when it holds. */
export function checkExpect(e: Expect, output: Record<string, unknown> | null): string[] {
  if (!output) return Object.keys(e.fields).length ? ["no output"] : [];
  const failed: string[] = [];
  for (const [k, f] of Object.entries(e.fields)) {
    if (!(k in output)) {
      failed.push(`${k}: missing`);
      continue;
    }
    const v = parsed(output[k]);
    if (f.notEmpty && isEmpty(v)) failed.push(`${k}: empty`);
    if (f.type && typeOf(v) !== f.type && !isEmpty(v))
      failed.push(`${k}: ${typeOf(v)}, want ${f.type}`);
    if (f.pattern && typeof v === "string" && !new RegExp(f.pattern).test(v.trim()))
      failed.push(`${k}: does not match /${f.pattern}/`);
    if (f.rowCount && Array.isArray(v)) {
      if (v.length < f.rowCount.min) failed.push(`${k}: ${v.length} rows, want ≥${f.rowCount.min}`);
      if (f.rowCount.max !== undefined && v.length > f.rowCount.max)
        failed.push(`${k}: ${v.length} rows, want ≤${f.rowCount.max}`);
    }
  }
  const text = JSON.stringify(output).toLowerCase();
  for (const w of e.mustNotContain)
    if (text.includes(w.toLowerCase())) failed.push(`output holds "${w}"`);
  return failed;
}

export async function readExpect(dir: string): Promise<Expect | null> {
  try {
    return JSON.parse(await readFile(join(dir, EXPECT_FILE), "utf8")) as Expect;
  } catch {
    return null;
  }
}

export async function writeExpect(dir: string, e: Expect): Promise<void> {
  await writeFile(join(dir, EXPECT_FILE), `${JSON.stringify(e, null, 2)}\n`, { flag: "wx" });
}
