/**
 * Facets: a platform's own sort and filters, declared once per surface (designs/2026-11-03-search-filters.md).
 * One declaration feeds the route's zod, the URL or API query, and the catalog a UI lists.
 * Names and values are the platform's own; `label` is its UI's words.
 */
import { z } from "zod";

/** How a value reaches the platform: its page URL, its API query, a click on its own control. */
export type Via = "url" | "api" | "ui";

export type Kind = "one" | "many" | "text" | "ids" | "time";

/** A facet's catalog row: plain data, no functions. */
export interface FacetRow {
  name: string;
  label: string;
  kind: Kind;
  via: Via;
  /** one, many: the platform's values and its UI's words for each */
  values?: { value: string; label: string }[];
  default?: string;
  /** ids: what each id names and its shape */
  ids?: { of: string; shape: string };
  note?: string;
}

export interface Facet<S extends z.ZodType = z.ZodType> {
  label: string;
  kind: Kind;
  via: Via;
  zod: S;
  values?: Record<string, string>;
  default?: string;
  ids?: { of: string; shape: RegExp };
  note?: string;
  /** writes the value; unset: the facet's name as a query param, `encode`d */
  put?: (u: URL, v: never) => void;
}

interface Opts<V extends string = string> {
  via?: Via;
  note?: string;
  default?: NoInfer<V>;
  put?: (u: URL, v: NoInfer<V>) => void;
}

/** comma list or array → array */
const listOf = (v: unknown) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : v;

const keys = <V extends string>(values: Record<V, string>) => Object.keys(values) as [V, ...V[]];

/** One of the platform's values (a radio, a sort menu). */
export function one<V extends string>(label: string, values: Record<V, string>, o: Opts<V> = {}) {
  return facet({ label, kind: "one", zod: z.enum(keys(values)).optional(), values, ...o });
}

/** Several of the platform's values (checkboxes). */
export function many<V extends string>(
  label: string,
  values: Record<V, string>,
  o: Omit<Opts, "default" | "put"> & { put?: (u: URL, v: V[]) => void } = {},
) {
  const zod = z.preprocess(listOf, z.array(z.enum(keys(values))).min(1)).optional();
  return facet({ label, kind: "many", zod, values, ...o });
}

/** Free words the platform matches (a job title box). */
export function text(label: string, max: number, o: Omit<Opts, "default"> = {}) {
  return facet({ label, kind: "text", zod: z.string().trim().min(1).max(max).optional(), ...o });
}

/** The platform's ids for one kind of thing (companies, members), checked by shape. */
export function ids(
  label: string,
  of: string,
  shape: RegExp,
  o: Omit<Opts, "default" | "put"> & { put?: (u: URL, v: string[]) => void } = {},
) {
  const zod = z.preprocess(listOf, z.array(z.string().regex(shape)).min(1).max(20)).optional();
  return facet({ label, kind: "ids", zod, ids: { of, shape }, ...o });
}

/** An instant, ISO 8601 with its offset. */
export function time(label: string, o: Omit<Opts, "default"> = {}) {
  return facet({ label, kind: "time", zod: z.iso.datetime({ offset: true }).optional(), ...o });
}

function facet<S extends z.ZodType>(
  f: Omit<Facet<S>, "via" | "put"> & { via?: Via; put?: unknown },
): Facet<S> {
  return { ...f, via: f.via ?? "url" } as Facet<S>;
}

export type Facets = Record<string, Facet>;

/**
 * One preset grammar on every surface: an order, a window, or both (`top-week`).
 * A surface lists only the presets it honors exactly; any other is a 400 naming them.
 */
export const ORDERS = ["latest", "top"] as const;
export const WINDOWS = ["day", "week", "month", "year"] as const;
type Order = (typeof ORDERS)[number];
type Window = (typeof WINDOWS)[number];
export type Preset = Order | Window | `${Order}-${Window}`;

type Values<F extends Facets> = { [K in keyof F]?: z.output<F[K]["zod"]> };
/** a window ending now: relative times resolve at the call */
type Valued<F extends Facets> = Values<F> | ((now: number) => Values<F>);

export interface FacetSet<F extends Facets = Facets> {
  site: string;
  /** every route it feeds, `<site> <METHOD> <path>`; a derived site (reddit-public) lists its own */
  routes: string[];
  /** the surface in the platform's words */
  label: string;
  facets: F;
  presets?: Partial<Record<Preset, Valued<F>>>;
}

export const facetSet = <F extends Facets>(s: FacetSet<F>): FacetSet<F> => s;

/** Every order × window the platform honors, each alone and paired. */
export function grid<F extends Facets>(
  orders: Partial<Record<Order, Values<F>>>,
  windows: Partial<Record<Window, Valued<F>>>,
): Partial<Record<Preset, Valued<F>>> {
  const at = (w: Valued<F>, now: number) => (typeof w === "function" ? w(now) : w);
  const out: Partial<Record<Preset, Valued<F>>> = { ...orders, ...windows };
  for (const [o, ov] of Object.entries(orders) as [Order, Values<F>][])
    for (const [w, wv] of Object.entries(windows) as [Window, Valued<F>][])
      out[`${o}-${w}`] = (now: number) => ({ ...at(wv, now), ...ov });
  return out;
}

/** ISO instant `days` before `now` */
export const ago = (days: number) => (now: number) =>
  new Date(now - days * 86_400_000).toISOString();

/** The set's zod fields, to spread into a route's schema; all optional, `resolve` fills defaults. */
export const fields = <F extends Facets>(
  s: FacetSet<F>,
): { [K in keyof F]: F[K]["zod"] } & { preset: z.ZodOptional<z.ZodEnum> } => {
  const names = Object.keys(s.presets ?? {});
  return {
    ...Object.fromEntries(Object.entries(s.facets).map(([k, f]) => [k, f.zod])),
    ...(names.length && {
      preset: z
        .enum(names as [string, ...string[]], {
          error: `a preset of ${s.site} ${s.label}: ${names.join(", ")}`,
        })
        .optional(),
    }),
  } as never;
};

/** A flow's facet input: each optional, `preset` too. */
export type FacetInput<S extends FacetSet> = Values<S["facets"]> & { preset?: Preset };

/**
 * The values a search runs with: each facet's own value, else its preset's, else its default.
 * `preset` is dropped; keys the set does not know pass through.
 */
export function resolve<T extends Record<string, unknown>>(
  s: FacetSet,
  input: T,
  now = Date.now(),
): Omit<T, "preset"> {
  const { preset, ...rest } = input as Record<string, unknown>;
  const p = preset === undefined ? undefined : s.presets?.[preset as Preset];
  if (preset !== undefined && !p)
    throw new Error(`no preset ${String(preset)} on ${s.site} ${s.label}`);
  const from = typeof p === "function" ? p(now) : (p ?? {});
  const out: Record<string, unknown> = { ...rest };
  for (const [k, f] of Object.entries(s.facets)) {
    const v = rest[k] ?? (from as Record<string, unknown>)[k] ?? f.default;
    if (v !== undefined) out[k] = v;
  }
  return out as never;
}

/** Writes each facet of `via` onto `u`, resolved: its own `put`, or `name=encode(value)`. */
export function apply(
  u: URL,
  s: FacetSet,
  input: Record<string, unknown>,
  o: { via?: Via; encode?: (v: unknown) => string; now?: number } = {},
): URL {
  const via = o.via ?? "url";
  const encode = o.encode ?? String;
  const r = resolve(s, input, o.now) as Record<string, unknown>;
  for (const [name, f] of Object.entries(s.facets)) {
    const v = r[name];
    if (v === undefined || v === "" || f.via !== via) continue;
    if (f.put) (f.put as (u: URL, v: unknown) => void)(u, v);
    else u.searchParams.set(name, encode(v));
  }
  return u;
}

export const rowOf = (name: string, f: Facet): FacetRow => ({
  name,
  label: f.label,
  kind: f.kind,
  via: f.via,
  ...(f.values && {
    values: Object.entries(f.values).map(([value, label]) => ({ value, label })),
  }),
  ...(f.default !== undefined && { default: f.default }),
  ...(f.ids && { ids: { of: f.ids.of, shape: f.ids.shape.source } }),
  ...(f.note && { note: f.note }),
});

/** A set as plain data: what a UI draws its controls from; presets as they resolve at `now`. */
export const catalogOf = (s: FacetSet, now = Date.now()) => ({
  site: s.site,
  routes: s.routes,
  label: s.label,
  facets: Object.entries(s.facets).map(([n, f]) => rowOf(n, f)),
  presets: Object.fromEntries(
    Object.entries(s.presets ?? {}).map(([n, p]) => [n, typeof p === "function" ? p(now) : p]),
  ),
});

/** One line for a route summary: the preset names, short. */
export const presetWords = (s: FacetSet): string => {
  const n = new Set(Object.keys(s.presets ?? {}));
  const o = ORDERS.filter((x) => n.has(x));
  const w = WINDOWS.filter((x) => n.has(x));
  const words = [o.join("|"), w.join("|")].filter(Boolean).join(", ");
  return `\`preset\` ${words}${o.length && w.length ? ` or paired (\`${o.at(-1)}-${w[0]}\`)` : ""}`;
};
