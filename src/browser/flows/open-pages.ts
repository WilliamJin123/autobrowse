/**
 * Public pages that refuse plain clients (Google Scholar redirects, Indeed and Upwork answer
 * Cloudflare 403s) but render signed out in our browser (WA-1251.5 B, probed 11-10). Each
 * flow opens the page and reads it: the page's own state where it has one (Indeed's mosaic
 * job cards, Upwork's vuex store), whole; Scholar has none, so its markup.
 * From OpenCLI clis/google-scholar, clis/indeed, clis/upwork @9bc5f5c (their Upwork reads
 * `__NUXT__.state`, gone since Upwork moved to Nuxt 3: the store is on the app now).
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { inPage } from "../in-page.js";
import { AccessRefused } from "../session.js";

const READY_MS = 15_000;
const BLOCK_TITLE = /just a moment|attention required|access denied|unusual traffic|captcha/i;

/**
 * Polls `probe` until it answers non-null; a challenge or a timeout refuses. `globals`: the
 * probe reads the page's own state, so it runs in the page's world (Patchright's default world
 * is isolated: it shares the DOM, not `window.mosaic`).
 */
async function readWhenReady<T>(
  fp: FlowPage,
  what: string,
  probe: string,
  o: { globals?: boolean } = {},
): Promise<T> {
  const until = Date.now() + READY_MS;
  let lastError = "";
  for (;;) {
    const title = await fp.page.title().catch(() => "");
    if (BLOCK_TITLE.test(title) || /\/sorry\/|captcha/i.test(fp.url()))
      throw new AccessRefused("platform_blocked", `${what}: a bot check (${title || fp.url()})`);
    if (/\/(ab\/account-security\/login|nx\/login|account\/login)/.test(new URL(fp.url()).pathname))
      throw new AccessRefused("need_login", `${what}: the site asks for a sign-in`);
    // a navigation under the read throws; the next try reads the settled page
    const read = o.globals ? inPage<T | null>(fp.page, probe) : fp.page.evaluate<T | null>(probe);
    const got = await read.catch((e: unknown) => {
      lastError = String(e).slice(0, 200);
      return null;
    });
    if (got !== null && got !== undefined) return got;
    if (Date.now() > until)
      throw new AccessRefused(
        "upstream_broken",
        `${what}: the page never showed its data in 15 s (at ${fp.url()}, "${title}"${lastError ? `; ${lastError}` : ""})`,
      );
    await fp.wait(500);
  }
}

/* ---------------- Google Scholar ---------------- */

export const SCHOLAR = "https://scholar.google.com";

export interface ScholarSearchInput {
  q: string;
  /** Offset into the results (Scholar's `start`). */
  start?: number;
  /** Per page, up to 20 (Scholar's `num`). */
  n?: number;
  /** Year range (`as_ylo`, `as_yhi`). */
  from?: number;
  to?: number;
  /** "date": newest first, last year only (Scholar's `scisbd`). */
  sort?: "relevance" | "date";
}

export interface ScholarHit {
  /** Scholar's own id for the result (`data-cid`). */
  cid: string | null;
  title: string;
  url: string | null;
  /** [PDF], [BOOK], [CITATION]. */
  kind: string | null;
  /** The grey line whole: "A Smith, B Lee - Journal, 2024 - publisher". */
  byline: string;
  authors: Array<{ name: string; user: string | null }>;
  year: number | null;
  snippet: string | null;
  citedBy: number;
  /** Id for `cites=` (who cites it) and `cluster=` (all versions). */
  citesId: string | null;
  versions: number | null;
  pdf: string | null;
}

const SCHOLAR_HITS = `(() => {
  const cards = [...document.querySelectorAll(".gs_r.gs_or.gs_scl")];
  const total = document.querySelector("#gs_ab_md .gs_ab_mdw")?.textContent?.trim() || null;
  if (!cards.length && !/did not match any articles/i.test(document.body?.innerText || "")) return null;
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const hits = cards.map((el) => {
    const a = el.querySelector(".gs_rt a");
    const byline = clean(el.querySelector(".gs_a")?.textContent);
    const authorsPart = byline.split(" - ")[0] || "";
    const linked = new Map([...el.querySelectorAll(".gs_a a[href*='user=']")].map((x) => [clean(x.textContent), new URL(x.href).searchParams.get("user")]));
    const authors = authorsPart.split(",").map((n) => clean(n).replace(/…$/, "")).filter(Boolean).map((name) => ({ name, user: linked.get(name) || null }));
    const cited = el.querySelector(".gs_fl a[href*='cites=']");
    const citesId = cited ? new URL(cited.href).searchParams.get("cites") : null;
    const ver = [...el.querySelectorAll(".gs_fl a[href*='cluster=']")].map((x) => clean(x.textContent)).find((t) => /versions?/i.test(t));
    const year = byline.match(/\\b(19|20)\\d{2}\\b/g);
    return {
      cid: el.getAttribute("data-cid"),
      title: clean((el.querySelector(".gs_rt a") || el.querySelector(".gs_rt"))?.textContent).replace(/^\\[[A-Z]+\\]\\s*/, ""),
      url: a?.href || null,
      kind: clean(el.querySelector(".gs_rt .gs_ctc, .gs_rt .gs_ctu, .gs_rt .gs_ct1")?.textContent).replace(/[\\[\\]]/g, "") || null,
      byline,
      authors,
      year: year ? Number(year[year.length - 1]) : null,
      snippet: clean(el.querySelector(".gs_rs")?.textContent) || null,
      citedBy: cited ? Number(clean(cited.textContent).replace(/\\D/g, "")) || 0 : 0,
      citesId,
      versions: ver ? Number(ver.replace(/\\D/g, "")) || null : null,
      pdf: el.querySelector(".gs_or_ggsm a")?.href || null,
    };
  });
  return { total, hits };
})()`;

export const scholarSearch = defineFlow<
  ScholarSearchInput,
  { url: string; total: string | null; hits: ScholarHit[] }
>({
  site: "google-scholar",
  name: "search",
  async run(fp, { q, start = 0, n = 10, from, to, sort = "relevance" }) {
    const p = new URLSearchParams({ q, hl: "en", num: String(Math.min(n, 20)) });
    if (start) p.set("start", String(start));
    if (from) p.set("as_ylo", String(from));
    if (to) p.set("as_yhi", String(to));
    if (sort === "date") p.set("scisbd", "1");
    const url = `${SCHOLAR}/scholar?${p}`;
    await fp.open(url);
    const got = await readWhenReady<{ total: string | null; hits: ScholarHit[] }>(
      fp,
      "google-scholar /search",
      SCHOLAR_HITS,
    );
    return { url, ...got };
  },
});

export interface ScholarAuthor {
  user: string;
  name: string;
  affiliation: string | null;
  interests: string[];
  homepage: string | null;
  /** Citations, h-index, i10-index: all time and since the shown year. */
  stats: Array<{ name: string; all: number | null; since: number | null }>;
  /** Citations per year, from the bar chart. */
  byYear: Array<{ year: number; citations: number }>;
  papers: Array<{
    title: string;
    url: string | null;
    authors: string | null;
    venue: string | null;
    citedBy: number;
    year: number | null;
  }>;
}

const SCHOLAR_AUTHOR = `(() => {
  const name = document.querySelector("#gsc_prf_in")?.textContent?.trim();
  if (!name) return null;
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const num = (s) => { const v = clean(s).replace(/\\D/g, ""); return v ? Number(v) : null; };
  const years = [...document.querySelectorAll(".gsc_md_hist_b .gsc_g_t")].map((e) => Number(clean(e.textContent)));
  const bars = [...document.querySelectorAll(".gsc_md_hist_b .gsc_g_a")];
  return {
    name,
    affiliation: clean(document.querySelector(".gsc_prf_il")?.textContent) || null,
    interests: [...document.querySelectorAll("#gsc_prf_int a")].map((a) => clean(a.textContent)),
    homepage: document.querySelector("#gsc_prf_ivh a")?.href || null,
    stats: [...document.querySelectorAll("#gsc_rsb_st tbody tr")].map((tr) => {
      const td = tr.querySelectorAll("td");
      return { name: clean(td[0]?.textContent), all: num(td[1]?.textContent), since: num(td[2]?.textContent) };
    }),
    byYear: bars.map((b) => {
      const z = Number(getComputedStyle(b).zIndex) || 0;
      const at = years.length - z;
      return { year: years[at] ?? null, citations: num(b.textContent) ?? 0 };
    }).filter((y) => y.year),
    papers: [...document.querySelectorAll("tr.gsc_a_tr")].map((tr) => {
      const grey = tr.querySelectorAll(".gs_gray");
      return {
        title: clean(tr.querySelector(".gsc_a_at")?.textContent),
        url: tr.querySelector(".gsc_a_at")?.href || null,
        authors: clean(grey[0]?.textContent) || null,
        venue: clean(grey[1]?.textContent) || null,
        citedBy: num(tr.querySelector(".gsc_a_c a")?.textContent) ?? 0,
        year: num(tr.querySelector(".gsc_a_y span")?.textContent),
      };
    }),
  };
})()`;

export const scholarAuthor = defineFlow<
  { user: string; n?: number; sort?: "cited" | "date" },
  ScholarAuthor
>({
  site: "google-scholar",
  name: "author",
  async run(fp, { user, n = 100, sort = "cited" }) {
    const p = new URLSearchParams({ user, hl: "en", pagesize: String(Math.min(n, 100)) });
    if (sort === "date") p.set("sortby", "pubdate");
    await fp.open(`${SCHOLAR}/citations?${p}`);
    const got = await readWhenReady<Omit<ScholarAuthor, "user">>(
      fp,
      "google-scholar /authors",
      SCHOLAR_AUTHOR,
    );
    return { user, ...got };
  },
});

/* ---------------- Indeed ---------------- */

export const INDEED = "https://www.indeed.com";

export interface IndeedSearchInput {
  q: string;
  /** "Austin, TX", "remote". */
  l?: string;
  /** Days back: 1, 3, 7, 14. */
  fromage?: number;
  sort?: "relevance" | "date";
  /** Offset, a multiple of 10. */
  start?: number;
}

const INDEED_CARDS = `(() => {
  const m = window.mosaic?.providerData?.["mosaic-provider-jobcards"]?.metaData?.mosaicProviderJobCardsModel;
  if (!m) return document.querySelector('[data-testid="noResultsMessage"], [data-testid="empty-serp-result"]') ? { count: "0", jobs: [], meta: null } : null;
  const { results, tierSummaries, pageNumber, searchTimestamp, what, where, radius, radiusUnit } = m;
  return {
    count: document.querySelector('[data-testid="jobsearch-JobCountAndSortPane-jobCount"]')?.textContent?.trim() || null,
    jobs: JSON.parse(JSON.stringify(results || [])),
    meta: JSON.parse(JSON.stringify({ tierSummaries, pageNumber, searchTimestamp, what, where, radius, radiusUnit })),
  };
})()`;

export const indeedSearch = defineFlow<
  IndeedSearchInput,
  { url: string; count: string | null; jobs: unknown[]; meta: unknown }
>({
  site: "indeed",
  name: "search",
  async run(fp, { q, l, fromage, sort, start }) {
    const p = new URLSearchParams({ q });
    if (l) p.set("l", l);
    if (fromage) p.set("fromage", String(fromage));
    if (sort === "date") p.set("sort", "date");
    if (start) p.set("start", String(start));
    const url = `${INDEED}/jobs?${p}`;
    await fp.open(url);
    const got = await readWhenReady<{ count: string | null; jobs: unknown[]; meta: unknown }>(
      fp,
      "indeed /jobs",
      INDEED_CARDS,
      { globals: true },
    );
    return { url, ...got };
  },
});

/** The job page's model whole, less page chrome (header and footer HTML, CSS, test groups). */
const INDEED_JOB = `(() => {
  const m = window._initialData?.viewJobClientSideModel;
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (/HTML$|^cssReset|Proctor|^i18n|^deploymentGroup/.test(k)) continue;
    out[k] = v;
  }
  return { found: true, job: JSON.parse(JSON.stringify(out)) };
})()`;

export const indeedJob = defineFlow<{ jk: string }, { found: boolean; job: unknown }>({
  site: "indeed",
  name: "job",
  async run(fp, { jk }) {
    await fp.open(`${INDEED}/viewjob?jk=${encodeURIComponent(jk)}`);
    const got = await readWhenReady<{ found: boolean; job?: unknown }>(
      fp,
      "indeed /jobs/{jk}",
      INDEED_JOB,
      { globals: true },
    );
    return { found: got.found, job: got.job ?? null };
  },
});

/* ---------------- Upwork ---------------- */

export const UPWORK = "https://www.upwork.com";

export interface UpworkSearchInput {
  q: string;
  page?: number;
  /** 10, 20 or 50. */
  perPage?: number;
  sort?: "relevance" | "recency";
}

/** Upwork's search marks matches with `<span class="highlight">`: UI, not data. */
const UPWORK_STORE = `document.getElementById("__nuxt")?.__vue_app__?.$nuxt?.payload?.vuex`;

const UPWORK_JOBS = `(() => {
  const s = ${UPWORK_STORE}?.jobsSearch;
  if (!s || s.status === "loading" || !Array.isArray(s.jobs)) return null;
  const plain = (v) => typeof v === "string" ? v.replace(/<\\/?span[^>]*>/g, "") : v;
  const jobs = JSON.parse(JSON.stringify(s.jobs)).map((j) => ({ ...j, title: plain(j.title), description: plain(j.description) }));
  return { jobs, paging: JSON.parse(JSON.stringify(s.paging ?? null)) };
})()`;

export const upworkSearch = defineFlow<
  UpworkSearchInput,
  { url: string; jobs: unknown[]; paging: unknown }
>({
  site: "upwork",
  name: "search",
  async run(fp, { q, page = 1, perPage = 50, sort = "relevance" }) {
    const p = new URLSearchParams({ q, per_page: String(perPage) });
    if (page > 1) p.set("page", String(page));
    if (sort === "recency") p.set("sort", "recency");
    const url = `${UPWORK}/nx/search/jobs/?${p}`;
    await fp.open(url);
    const got = await readWhenReady<{ jobs: unknown[]; paging: unknown }>(
      fp,
      "upwork /jobs",
      UPWORK_JOBS,
      { globals: true },
    );
    return { url, ...got };
  },
});

/** The job's store whole, less the viewer's session and the page's experiments. */
const UPWORK_JOB = `(() => {
  const d = ${UPWORK_STORE}?.jobDetails;
  if (!d) return null;
  if (d.errorResponse && !d.job?.uid) return { found: false, error: JSON.parse(JSON.stringify(d.errorResponse)) };
  if (!d.job?.uid) return null;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (/^(cache|currentUserInfo|paths|ff|qt|auth|experiments|prefillWith|aiInterview|hireMeNow|acceptTerms|upworkNow|videoInterview|isAIInterview|submitProposalGate|bonusConnects|hasAcceptedFreelancerTerms|proposalPermissions)/.test(k)) continue;
    out[k] = v;
  }
  return { found: true, job: JSON.parse(JSON.stringify(out)) };
})()`;

export const upworkJob = defineFlow<{ id: string }, { found: boolean; job: unknown }>({
  site: "upwork",
  name: "job",
  async run(fp, { id }) {
    await fp.open(`${UPWORK}/jobs/${id.startsWith("~") ? id : `~${id}`}`);
    const got = await readWhenReady<{ found: boolean; job?: unknown }>(
      fp,
      "upwork /jobs/{id}",
      UPWORK_JOB,
      { globals: true },
    );
    return { found: got.found, job: got.job ?? null };
  },
});
