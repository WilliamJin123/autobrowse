/**
 * Content boundaries (designs/2026-11-12-agent-browser-audit.md #11): page text an answer
 * carries sits between markers with a per-session random nonce and the page's origin, so the
 * agent reads it as the page's data, never as instructions. A page cannot close the fence: it
 * never sees the nonce. Defense in depth: it holds only while the agent honours the markers.
 */

/** Per command: the string fields that hold page text. */
const PAGE_TEXT: Record<string, readonly string[]> = {
  aria: ["aria"],
  snapshot: ["rows"],
  text: ["text"],
};
/** Commands whose structured answer came from the page or its calls: tagged, not wrapped. */
// eval/read: short values, tagged; aria/snapshot: a `since` answer holds rows, not one text
const PAGE_DATA = new Set(["records", "network", "eval", "read", "aria", "snapshot"]);

export interface Fence {
  nonce: string;
  wrap(text: string, origin: string): string;
  /** The answer with its page text fenced; other commands as they came. */
  answer(cmd: string, answer: unknown, origin: string): unknown;
}

export function pageFence(nonce: string): Fence {
  const wrap = (text: string, origin: string) =>
    `<<page ${nonce} ${origin}>>\n${text}\n<<end ${nonce}>>`;
  return {
    nonce,
    wrap,
    answer(cmd, answer, origin) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return answer;
      const fields = PAGE_TEXT[cmd];
      if (!fields && !PAGE_DATA.has(cmd)) return answer;
      const a = { ...(answer as Record<string, unknown>) };
      let wrapped = false;
      for (const f of fields ?? [])
        if (typeof a[f] === "string" && a[f]) {
          a[f] = wrap(a[f] as string, origin);
          wrapped = true;
        }
      // the origin alone: values from the page, data never instructions
      if (!wrapped && PAGE_DATA.has(cmd)) a.page = origin;
      return a;
    },
  };
}

/** The page's origin for a fence; a page with none (about:blank) says so. */
export const originOf = (url: string): string => {
  if (!URL.canParse(url)) return "none";
  const u = new URL(url);
  // data:, about:, file: have no origin: the scheme alone
  return u.origin !== "null" ? u.origin : u.protocol;
};

/** A fenced text's markers and what they hold; unfenced text comes back as `inner`, no markers. */
export function unfence(text: string): { inner: string; open: string; close: string } {
  const m = /^(<<page [0-9a-f]+ [^\n]*>>)\n([\s\S]*)\n(<<end [0-9a-f]+>>)$/.exec(text);
  return m
    ? { open: m[1] ?? "", inner: m[2] ?? "", close: m[3] ?? "" }
    : { inner: text, open: "", close: "" };
}
