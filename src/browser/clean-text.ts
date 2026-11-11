/**
 * Page text before an agent reads it: drop the characters that make text say
 * one thing and show another (PinchTab audit P2). Bidi embeddings, overrides
 * and isolates reorder what a person sees; zero-width spaces and the BOM split
 * words; Unicode tag characters (U+E0000–E007F) carry invisible ASCII, a known
 * prompt-injection channel; C0/C1 controls (not tab, newline, return) are noise.
 * ZWJ and ZWNJ stay: emoji and several scripts need them.
 * Display only: stored rows and files keep the page's own text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what it removes
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‎‏‪-‮⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/g;

export function cleanText(s: string): string {
  return s.replace(HIDDEN, "");
}

/** `JSON.stringify` replacer: every string value cleaned. */
export const cleanStrings = (_key: string, v: unknown): unknown =>
  typeof v === "string" ? cleanText(v) : v;
