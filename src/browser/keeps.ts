/**
 * A flow that makes a value and keeps it is asked before its first act: a store's
 * refusal after the mint loses a value the site shows once (WA-1126,
 * credvault designs/2026-11-05-no-silent-overwrite.md).
 */
import { WouldReplace } from "credvault";
import { type Held, questionOf, replaceQuestion, type SecretSink } from "../deps/sink.js";
import { NeedsHuman } from "./session.js";

export interface KeepsInput {
  sink?: SecretSink;
  /** Yes to the replace question: the names this run keeps may hold a value. */
  replace?: boolean;
}

const YES =
  'run it again with "replace": true (a setup step: autobrowse site setup <site> <step> --confirm)';

/**
 * `names` are what the run will keep. One that holds a value stops the run before any act,
 * unless the input says `replace`; then the sink it hands on replaces those names only.
 */
export async function settleKeeps<I>(names: readonly string[], input: I): Promise<I> {
  const i = (input ?? {}) as KeepsInput;
  const sink = i.sink;
  if (!names.length || !sink) return input;
  const held: Held[] = [];
  for (const name of names) {
    const value = (await sink.get?.(name)) ?? null;
    if (value !== null) held.push({ name, length: value.length, where: "the store" });
  }
  if (!held.length) return input;
  if (i.replace !== true) throw new NeedsHuman(replaceQuestion(held, YES));
  const yes = new Set(held.map((h) => h.name));
  const settled: SecretSink = {
    get: async (name) => (await sink.get?.(name)) ?? null,
    put: (name, value, o) => sink.put(name, value, yes.has(name) ? { ...o, replace: true } : o),
  };
  return { ...input, sink: settled };
}

/** A store's refusal inside a flow is a question for a person, never a page failure to heal. */
export const asQuestion = (err: unknown): unknown =>
  err instanceof WouldReplace ? new NeedsHuman(questionOf(err, YES)) : err;
