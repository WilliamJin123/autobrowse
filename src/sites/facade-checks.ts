import { type AccessCode, AccessRefused, NeedsHuman } from "../browser/session.js";
import { errorOf } from "../errors.js";
import type { CheckRow, SiteFacade, SiteFacadeDeps, SiteRow } from "./facade-api.js";
import { accessOf, SiteError, type SiteRoute } from "./types.js";

export const CODE_STATUS: Record<AccessCode, number> = {
  need_login: 401,
  platform_blocked: 403,
  rate_limited: 429,
  upstream_broken: 502,
};

/**
 * The answer against the route's `response` (U2), returned as sent. A read whose shape broke
 * fails, so a changed site shows as `upstream_broken`, not as empty rows; a write went through,
 * so it keeps its answer and says what drifted.
 */
export function checkResponse(
  r: Pick<SiteRoute, "response" | "method" | "path" | "access">,
  out: unknown,
): unknown {
  if (!r.response) return out;
  const got = r.response.safeParse(out);
  if (got.success) return out;
  const why = got.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "answer"}: ${i.message}`)
    .join("; ");
  if (accessOf(r) === "read")
    throw new SiteError(
      502,
      `${r.method} ${r.path}: the answer changed shape (${why})`,
      undefined,
      "upstream_broken",
    );
  return out && typeof out === "object" && !Array.isArray(out) ? { ...out, shapeDrift: why } : out;
}

/**
 * A browser leg's failure on a read, as a coded SiteError: a flow's `AccessRefused`, or a wall
 * the runner met (login → `need_login`, a captcha left → `platform_blocked`). Lasting, so terminal:
 * Restate would retry it for hours. Anything else stays as it was.
 */
export function accessError(err: unknown): SiteError | null {
  if (err instanceof AccessRefused)
    return new SiteError(CODE_STATUS[err.code], err.message, undefined, err.code);
  if (err instanceof NeedsHuman && err.wall) {
    const code = err.wall === "captcha" ? "platform_blocked" : "need_login";
    return new SiteError(CODE_STATUS[code], err.message, undefined, code);
  }
  return null;
}

/** One who-am-I call on the API leg: proves the token works, not just that one is kept. */
export async function checkSite(
  f: Pick<SiteFacade, "call">,
  row: SiteRow,
  account: string | null = null,
  now: () => number = Date.now,
): Promise<CheckRow> {
  const probe = row.probe;
  if (!probe) return { site: row.site, ok: false, why: "no probe" };
  const r = row.routes.find((x) => x.method === "GET" && matchPath(x.path, probe.path));
  // The row's `via` is the site's plain token; an account's token is only found by calling as it.
  if (!account && r?.via !== "api")
    return { site: row.site, ok: false, why: r?.missing ?? "probe has no api leg" };
  const t = now();
  try {
    await f.call(row.site, "GET", probe.path, probe.input ?? {}, account);
    return { site: row.site, ok: true, ms: now() - t };
  } catch (e) {
    const status = e instanceof SiteError ? `${e.status} ` : "";
    const msg = e instanceof Error ? e.message : String(e);
    return {
      site: row.site,
      ok: false,
      ms: now() - t,
      code: errorOf(e).code,
      why: `${status}${msg}`.replace(/\s+/g, " ").slice(0, 100),
    };
  }
}

/** `/rest/socialActions/{urn}/comments` against `/rest/socialActions/urn:li:share:1/comments`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const a = path.split("?")[0]?.split("/") ?? [];
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    const got = a[i] as string;
    const m = /^([^{}]*)\{([^{}]+)\}([^{}]*)$/.exec(seg);
    if (m) {
      // `{urn}`, or a segment with a fixed prefix/suffix around it (`act_{adAccountId}`).
      const [, before = "", name = "", after = ""] = m;
      if (!got.startsWith(before) || !got.endsWith(after)) return null;
      const inner = got.slice(before.length, got.length - after.length);
      if (!inner) return null;
      params[name] = decodeURIComponent(inner);
    } else if (seg !== got) return null;
  }
  return params;
}

/** `{ env: "X" }` → the env store's value of X (its absence was caught by `needs`); anything else is itself. */
export function resolveInput(
  v: unknown,
  env: SiteFacadeDeps["env"],
  account: string | null,
): unknown {
  if (
    v &&
    typeof v === "object" &&
    "account" in v &&
    (v as { account: unknown }).account === true
  ) {
    if (!account)
      throw new SiteError(
        409,
        "setup needs an account: --account <address>, or autobrowse accounts",
      );
    return account;
  }
  if (v && typeof v === "object" && "env" in v && typeof (v as { env: unknown }).env === "string") {
    const name = (v as { env: string }).env;
    const got = env(name);
    if (got === undefined) throw new SiteError(409, `setup needs ${name} first`);
    return got;
  }
  return v;
}
