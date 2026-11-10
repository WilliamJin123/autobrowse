/**
 * AI answer engines on their own pages, signed out (WA-1251.5 B, mapped 11-10 in explore).
 * ChatGPT: `/?q=` sends at once (`hints=search` turns on web search); the transcript is
 * `li[data-message-role]`, the answer done at `data-message-complete`. Gemini: no `?q=`, so the
 * question is typed; the answer is `model-response message-content`, done when the Stop button
 * goes and the text holds still. Signed out, Gemini is Flash-Lite with no sources.
 * Grok, DeepSeek and Claude ask for a sign-in before an answer: not built.
 * From OpenCLI clis/chatgpt, clis/gemini @9bc5f5c (theirs drive a signed-in session).
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { AccessRefused } from "../session.js";

const ANSWER_MS = 120_000;
const POLL_MS = 1_500;

export interface AnswerSource {
  url: string;
  text: string;
}

export interface Answer {
  engine: string;
  query: string;
  /** The answer as the page shows it, as text. */
  text: string;
  sources: AnswerSource[];
  url: string;
}

/** A page's tracking tag on a link, not part of the source. */
export const cleanUrl = (href: string): string => {
  try {
    const u = new URL(href);
    u.searchParams.delete("utm_source");
    return u.toString();
  } catch {
    return href;
  }
};

/** Links once each, tracking tags cut. */
export function sourcesOf(links: Array<[string, string]>): AnswerSource[] {
  const seen = new Set<string>();
  const out: AnswerSource[] = [];
  for (const [href, text] of links) {
    const url = cleanUrl(href);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: text.trim() });
  }
  return out;
}

interface Read {
  done: boolean;
  text: string;
  links: Array<[string, string]>;
  /** A sign-in or limit wall's text, when one covers the page. */
  wall: string | null;
}

const WALL = `(() => {
  const d = [...document.querySelectorAll("[role=dialog]")].map((e) => e.innerText).find((t) => /log in|sign in|sign up|limit/i.test(t));
  return d ? d.slice(0, 300) : null;
})()`;

/** Polls `probe` until the answer is done; a wall with no answer refuses. */
async function answerOf(fp: FlowPage, engine: string, probe: string): Promise<Read> {
  let last: Read | null = null;
  for (let t = 0; t < ANSWER_MS; t += POLL_MS) {
    await fp.wait(POLL_MS);
    const now = await fp.page.evaluate<Read>(probe).catch(() => null);
    if (now?.done && now.text) return now;
    if (now?.wall && !now.text) {
      throw new AccessRefused(
        /limit/i.test(now.wall) ? "rate_limited" : "need_login",
        `${engine}: ${now.wall.replace(/\s+/g, " ")}`,
      );
    }
    if (now) last = now;
  }
  if (last?.text) return last;
  throw new AccessRefused(
    "upstream_broken",
    `${engine}: no answer in ${ANSWER_MS / 1000}s (${fp.url()})`,
  );
}

/* ---------------- ChatGPT ---------------- */

export const CHATGPT = "https://chatgpt.com";

const CHATGPT_ANSWER = `(() => {
  const a = [...document.querySelectorAll("li[data-message-role=assistant]")].at(-1);
  const wall = ${WALL};
  if (!a) return { done: false, text: "", links: [], wall };
  return {
    done: a.hasAttribute("data-message-complete"),
    text: a.innerText.trim(),
    links: [...a.querySelectorAll("a[href^=http]")].map((l) => [l.href, l.innerText]),
    wall,
  };
})()`;

export const chatgptAsk = defineFlow<{ q: string; search?: boolean }, Answer>({
  site: "chatgpt",
  name: "ask",
  offscreen: true,
  async run(fp, { q, search = true }) {
    const p = new URLSearchParams({ q });
    if (search) p.set("hints", "search");
    await fp.open(`${CHATGPT}/?${p}`);
    const got = await answerOf(fp, "chatgpt", CHATGPT_ANSWER);
    return {
      engine: "chatgpt",
      query: q,
      text: got.text,
      sources: sourcesOf(got.links),
      url: fp.url(),
    };
  },
});

/* ---------------- Gemini ---------------- */

export const GEMINI = "https://gemini.google.com";

const GEMINI_ANSWER = `(() => {
  const r = [...document.querySelectorAll("model-response")].at(-1);
  const wall = ${WALL};
  const c = r?.querySelector("message-content") ?? r;
  if (!c) return { done: false, text: "", links: [], wall };
  const busy = !!document.querySelector("button[aria-label*=Stop i]");
  return {
    done: !busy,
    text: c.innerText.trim(),
    links: [...c.querySelectorAll("a[href^=http]")].map((l) => [l.href, l.innerText]),
    wall,
  };
})()`;

export const geminiAsk = defineFlow<{ q: string }, Answer>({
  site: "gemini",
  name: "ask",
  offscreen: true,
  async run(fp, { q }) {
    await fp.open(`${GEMINI}/app`);
    const box = { role: "textbox", name: "Enter a prompt for Gemini" } as const;
    await fp.act({ kind: "fill", value: q }, box, { goal: "type the question" });
    await fp.act({ kind: "press", key: "Enter" }, box, { goal: "ask" });
    // the Stop button shows a beat after the send: a done answer must also hold still
    let prev = "";
    for (let i = 0; ; i++) {
      const got = await answerOf(fp, "gemini", GEMINI_ANSWER);
      if (got.text === prev || i === 40)
        return {
          engine: "gemini",
          query: q,
          text: got.text.replace(/^Gemini said\s*/, ""),
          sources: sourcesOf(got.links),
          url: fp.url(),
        };
      prev = got.text;
    }
  },
});
