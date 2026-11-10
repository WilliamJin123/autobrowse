/**
 * OpenReview's public API v2, no key. Each note whole, plus `kind`: paper (its own forum),
 * else from its invitation (review, meta_review, decision, rebuttal, comment, …).
 * `/notes/search` answers any client; `/notes` asks a plain client for a browser challenge
 * (403 since 11-09), so those routes read inside an openreview.net page (flow `openreview/api`).
 */
import { z } from "zod";
import type { PageApiAnswer } from "../../browser/flows/page-api.js";
import { route, type SiteApi } from "../types.js";
import { getJson, ported, qs } from "./kit.js";

const API = "https://api2.openreview.net";

type Note = Record<string, unknown> & { id?: string; forum?: string; invitations?: string[] };
type Notes = { count: number | null; notes: Array<Note & { kind: string }> };

/** What a note is: `paper` for a forum's root, else its invitation's last part, lowercased. */
export function noteKind(n: Note): string {
  if (n.id && n.id === n.forum) return "paper";
  const t = (
    (n.invitations ?? []).map((i) => i.split("/-/")[1] ?? "").find(Boolean) ?? ""
  ).toLowerCase();
  for (const k of ["meta_review", "decision", "withdrawal", "rebuttal", "review", "comment"])
    if (t.includes(k) || t.includes(k.replace("_", ""))) return k;
  return t || "note";
}

/** An answer's notes, each with `kind`. */
export const notesOf = (body: unknown): Notes => {
  const b = (body ?? {}) as { notes?: Note[]; count?: number };
  return {
    count: b.count ?? null,
    notes: (b.notes ?? []).map((n) => ({ ...n, kind: noteKind(n) })),
  };
};

/** A `/notes` read through the page. */
const inPage = <I>(
  params: (i: I) => Record<string, string | number | undefined>,
  out: (n: Notes) => unknown = (r) => r,
) => ({
  flow: "openreview/api",
  input: (i: I) => ({ url: `${API}/notes?${qs(params(i))}` }),
  output: (o: unknown) => out(notesOf((o as PageApiAnswer).json)),
});

const n = z.coerce.number().int().min(1).max(1000).default(25);
const offset = z.coerce.number().int().min(0).default(0);

export const openreview: SiteApi = {
  site: "openreview",
  origin: API,
  auth: { open: true },
  signedOut: true,
  setup: [],
  pace: { gapMs: 2_000, jitterMs: 2_000 },
  blockers: {
    "bot-check": {
      what: "OpenReview's /notes answers a Cloudflare Turnstile (403 ChallengeRequiredError) to a plain client (11-09); those routes read inside openreview.net's page",
      since: "2026-11-09",
    },
  },
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Notes by words (`q`, `n` up to 1000, `papers` true by default keeps forum roots only): each note whole with `kind`",
      ported: ported("openreview/search.js"),
      request: z.object({
        q: z.string().min(1),
        n,
        papers: z.enum(["true", "false"]).default("true"),
      }),
      api: async ({ q, n, papers }, leg) => {
        const r = notesOf(
          await getJson(
            leg.http,
            `${API}/notes/search?${qs({ term: q, type: "terms", limit: n })}`,
            {
              label: "openreview /notes/search",
            },
          ),
        );
        return papers === "true" ? { ...r, notes: r.notes.filter((x) => x.kind === "paper") } : r;
      },
    }),
    route({
      method: "GET",
      path: "/notes/{id}",
      summary: "One note (a paper's forum id): whole with `kind`, or found false",
      ported: ported("openreview/paper.js"),
      request: z.object({ id: z.string().min(1) }),
      standing: { waits: "bot-check" },
      browser: inPage<{ id: string }>(
        ({ id }) => ({ id }),
        ({ notes: [note] }) => (note ? { found: true, note } : { found: false, note: null }),
      ),
    }),
    route({
      method: "GET",
      path: "/notes/{id}/replies",
      summary:
        "A paper's whole thread: reviews, meta review, decision, rebuttals and comments, oldest first, each whole with `kind`",
      ported: ported("openreview/reviews.js"),
      request: z.object({ id: z.string().min(1) }),
      standing: { waits: "bot-check" },
      browser: inPage<{ id: string }>(
        ({ id }) => ({ forum: id, details: "replies", limit: 1000 }),
        ({ notes }) => {
          const replies = notes
            .filter((x) => x.id !== x.forum)
            .sort((a, b) => Number(a.cdate ?? 0) - Number(b.cdate ?? 0));
          return {
            paper: notes.find((x) => x.kind === "paper") ?? null,
            count: replies.length,
            replies,
          };
        },
      ),
    }),
    route({
      method: "GET",
      path: "/author",
      summary: "One author's notes, newest first (`profile` like `~Yoshua_Bengio1`, `n`, `offset`)",
      ported: ported("openreview/author.js"),
      request: z.object({ profile: z.string().regex(/^~/), n, offset }),
      standing: { waits: "bot-check" },
      browser: inPage<{ profile: string; n: number; offset: number }>(({ profile, n, offset }) => ({
        "content.authorids": profile,
        limit: n,
        offset,
        sort: "cdate:desc",
      })),
    }),
    route({
      method: "GET",
      path: "/venue",
      summary:
        "A venue's notes (`venue` like `ICLR 2025 Oral`, or an invitation like `ICLR.cc/2025/Conference/-/Submission`; `n`, `offset`): count and each note whole",
      ported: ported("openreview/venue.js"),
      request: z.object({ venue: z.string().min(1), n, offset }),
      standing: { waits: "bot-check" },
      browser: inPage<{ venue: string; n: number; offset: number }>(({ venue, n, offset }) => ({
        ...(venue.includes("/-/") ? { invitation: venue } : { "content.venue": venue }),
        limit: n,
        offset,
      })),
    }),
  ],
};
