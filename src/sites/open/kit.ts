/**
 * Shared parts of the open sites: public APIs with no key, ported from OpenCLI (WA-1251.5).
 * Each answer goes back whole; a route only picks the list out of the envelope.
 */
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../../clients/http.js";
import { SiteError } from "../types.js";

/** The ref every ported route carries; `autobrowse sites upstream` watches it. */
export const OPENCLI_SHA = "9bc5f5c";
export const ported = (file: string) => `clis/${file}@${OPENCLI_SHA}`;

/** A plain client name; Wikimedia and NCBI ask for one. */
const UA = "autobrowse (+https://www.npmjs.com/package/@wrenautomation/autobrowse)";

/** Each host's last call, so one process keeps a host's asked-for gap (arXiv 3 s). */
const lastAt = new Map<string, number>();

async function politely(url: string, gapMs: number): Promise<void> {
  if (!gapMs) return;
  const host = new URL(url).host;
  const wait = (lastAt.get(host) ?? 0) + gapMs - Date.now();
  lastAt.set(host, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface Get {
  /** The site's name in an error: `arxiv /query`. */
  label: string;
  headers?: Record<string, string>;
  /** Least time between two calls to this host, in this process. */
  gapMs?: number;
  /** Statuses that answer null instead of throwing (a 404 for "no such id"). */
  empty?: readonly number[];
}

async function get(http: HttpClient, url: string, o: Get, accept: string) {
  await politely(url, o.gapMs ?? 0);
  const res = await http.json<unknown>(url, {
    headers: { accept, "user-agent": UA, ...o.headers },
  });
  if (!res.ok && !o.empty?.includes(res.status))
    throw new SiteError(
      res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status,
      `${o.label}: HTTP ${res.status}${res.text ? ` ${res.text.slice(0, 160)}` : ""}`,
    );
  return res;
}

/** A JSON answer, whole; null for an `empty` status. */
export async function getJson<T = unknown>(
  http: HttpClient,
  url: string,
  o: Get,
): Promise<T | null> {
  const res = await get(http, url, o, "application/json");
  if (!res.ok) return null;
  if (res.body === null) throw new SiteError(502, `${o.label}: not JSON`);
  return res.body as T;
}

/** A text answer (XML, RSS), whole; null for an `empty` status. */
export async function getText(http: HttpClient, url: string, o: Get): Promise<string | null> {
  const res = await get(http, url, o, "application/xml, text/xml, */*");
  return res.ok ? (res.text ?? "") : null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
});

/** XML as a plain object: attributes under `@name`, text under `#text` when mixed. */
export const parseXml = (text: string): Record<string, unknown> =>
  parser.parse(text) as Record<string, unknown>;

/** One or many as a list: XML gives a lone child as an object. */
export const listOf = <T = unknown>(v: unknown): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T];

/** A query string from the set values only. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}
