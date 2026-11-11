/**
 * A video's transcript off its watch page (OpenCLI port, `clis/youtube/transcript.js`). Mapped live
 * 2026-11-10: timedtext needs the player's own `pot` token, so the flow turns captions on and keeps
 * the player's `/api/timedtext?…fmt=json3` answer for this `v=` (ads load theirs first: other ids).
 * The transcript panel's `youtubei/v1/get_panel` answer is kept too. Fallback: the panel's
 * `transcript-segment-view-model` rows. Bodies stay whole.
 */

import { defineFlow, type FlowPage } from "../flow.js";
import { type Fell, ladder, RungBroke, type Strategy } from "../ladder.js";
import { captureJson, parseJson } from "../page-json.js";

const WEB = "https://www.youtube.com";
const PANEL = /^https:\/\/www\.youtube\.com\/youtubei\/v1\/get_panel\b/;
/** Ad, then the main video's first captions. */
const WAIT_MS = 60_000;

export interface Line {
  startMs: number;
  durMs: number;
  text: string;
}

/** Caption lines of a json3 timedtext answer; null when it is not one. */
export function json3Lines(body: unknown): Line[] | null {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  const out: Line[] = [];
  for (const e of events as Array<{ tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown }>) {
    const segs = Array.isArray(e?.segs) ? (e.segs as Array<{ utf8?: unknown }>) : [];
    const text = segs
      .map((s) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({ startMs: Number(e.tStartMs) || 0, durMs: Number(e.dDurationMs) || 0, text });
  }
  return out;
}

/** "1:02:03" → ms. */
export function clockMs(s: string): number {
  const parts = s.trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((a, n) => a * 60 + n, 0) * 1000;
}

export interface TranscriptInput {
  videoId: string;
}

export interface Transcript {
  videoId: string;
  found: boolean;
  via?: Strategy;
  fell: Fell[];
  lines: Line[];
  /** The caption track's query (`lang`, `kind`, `name`, …) from the timedtext call. */
  track: Record<string, string> | null;
  /** The json3 timedtext answer, whole. */
  timedtext: unknown;
  /** The transcript panel's `get_panel` answer, whole. */
  panel: unknown;
}

const SEGMENTS = `[...document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer")].map((s) => ({
  at: (s.querySelector("[class*=Timestamp], .segment-timestamp")?.textContent || "").trim(),
  text: (s.querySelector("[role=text], .segment-text")?.textContent || "").replace(/\\s+/g, " ").trim(),
}))`;

/** Skip an ad, turn captions on, open the transcript panel; each once it shows. */
const NUDGE = `(() => {
  const skip = document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button-modern");
  if (skip) skip.click();
  const ad = !!document.querySelector(".ad-showing");
  const cc = document.querySelector(".ytp-subtitles-button");
  if (cc && cc.getAttribute("aria-pressed") === "false") cc.click();
  if (!ad && !document.querySelector("transcript-segment-view-model, ytd-transcript-segment-renderer")) {
    document.querySelector("#description-inline-expander #expand")?.click();
    const t = [...document.querySelectorAll("ytd-video-description-transcript-section-renderer button, button")]
      .find((b) => /show transcript/i.test(b.textContent || ""));
    t?.click();
  }
  return { ad, captions: !!cc, unavailable: !!document.querySelector("ytd-player-error-message-renderer, .ytp-error") };
})()`;

export const youtubeTranscript = defineFlow<TranscriptInput, Transcript>({
  site: "youtube",
  name: "transcript",
  strategies: ["intercept", "ui"],
  async run(fp: FlowPage, { videoId }) {
    const ownVideo = (url: string) => {
      try {
        return new URL(url).searchParams.get("v") === videoId;
      } catch {
        return false;
      }
    };
    // This video's json3 answers, each with its url (ads send theirs first, with other ids).
    const own: { url: string; body: unknown }[] = [];
    const pending: Promise<void>[] = [];
    const watch = (r: { url(): string; text(): Promise<string> }) => {
      const u = r.url();
      if (!u.startsWith(`${WEB}/api/timedtext?`) || !ownVideo(u)) return;
      pending.push(
        r
          .text()
          .then((t) => {
            const p = parseJson(t);
            if (p.ok && json3Lines(p.json)) own.push({ url: u, body: p.json });
          })
          .catch(() => {}),
      );
    };
    let missing = false;
    fp.page.on("response", watch);
    const { bodies } = await captureJson(fp, { match: PANEL }, async (got) => {
      await fp.open(`${WEB}/watch?v=${encodeURIComponent(videoId)}`);
      const start = Date.now();
      while (Date.now() - start < WAIT_MS) {
        const s = (await fp.page.evaluate(NUDGE).catch(() => null)) as {
          ad: boolean;
          captions: boolean;
          unavailable: boolean;
        } | null;
        if (s?.unavailable) {
          missing = true;
          return;
        }
        await Promise.all(pending);
        if (own.some((o) => json3Lines(o.body)?.length) && got.length) return;
        // Past the ad with no captions button: no tracks; the panel may still have rows.
        if (s && !s.ad && !s.captions && Date.now() - start > WAIT_MS / 2) return;
        await fp.wait(1_000);
      }
    }).finally(() => fp.page.off("response", watch));
    await Promise.all(pending);
    if (missing)
      return {
        videoId,
        found: false,
        fell: [],
        lines: [],
        track: null,
        timedtext: null,
        panel: null,
      };
    const panel = bodies[0] ?? null;
    let timedtext: unknown = null;
    let track: Record<string, string> | null = null;
    const climbed = await ladder<Line[]>([
      {
        strategy: "intercept",
        run: async () => {
          const last = own.findLast((o) => json3Lines(o.body)?.length);
          if (!last) throw new RungBroke("no timedtext answer for this video");
          timedtext = last.body;
          const u = new URL(last.url);
          track = Object.fromEntries(
            ["lang", "kind", "name", "tlang", "fmt"].flatMap((k) => {
              const v = u.searchParams.get(k);
              return v === null ? [] : [[k, v]];
            }),
          );
          return json3Lines(last.body) as Line[];
        },
      },
      {
        strategy: "ui",
        run: async () => {
          const rows = (
            (await fp.page.evaluate(SEGMENTS).catch(() => [])) as { at: string; text: string }[]
          ).filter((r) => r.text);
          if (!rows.length) throw new RungBroke("no transcript rows");
          return rows.map((r, i) => {
            const startMs = clockMs(r.at);
            const next = rows[i + 1];
            return {
              startMs,
              durMs: next ? Math.max(0, clockMs(next.at) - startMs) : 0,
              text: r.text,
            };
          });
        },
      },
    ]);
    return {
      videoId,
      found: true,
      via: climbed.via,
      fell: climbed.fell,
      lines: climbed.value,
      track,
      timedtext,
      panel,
    };
  },
});
