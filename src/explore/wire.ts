/** The loopback protocol both session servers speak (explore, the desktop session): ids, resends. */

/** Answers kept by command id for resends. */
export const SENT_KEEP = 500;

/** The caller's id for a command (U6), taken off before the schema reads it. */
export function commandId(raw: Record<string, unknown>): string | null {
  const id = raw.id;
  // A number is the command's own field (`network` row id), not the caller's id.
  if (id === undefined || typeof id === "number") return null;
  delete raw.id;
  if (typeof id !== "string" || !/^[\w.:-]{1,80}$/.test(id))
    throw new Error("id: 1-80 letters, digits or . : _ -");
  return id;
}

/** The first answer, marked as a resend's. */
export function withRepeat(body: string): string {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v))
      return JSON.stringify({ ...v, repeat: true });
  } catch {}
  return body;
}
