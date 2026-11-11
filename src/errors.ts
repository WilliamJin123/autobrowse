/**
 * One error contract for every caller: CLI, HTTP API, explore, agents.
 * `code` is what a program branches on; `hint` the next move; `retryable` whether the
 * same call may work later unchanged; `outcome: "unknown"` a write that may have gone through.
 * Codes extend the HTTP API's (`ui/http.ts`) and keep the wren seam's `ACCESS_CODES` as they are.
 * Design: designs/2026-11-09-opencli-audit.md (WA-1251.1).
 */
import { z } from "zod";
import { profileBusyOf } from "./browser/browsers.js";
import { FlowFailed, FlowInterrupted, isTransientBrowserError } from "./browser/flow.js";
import { RungBroke } from "./browser/ladder.js";
import { BrowserNotReady, OwnTabsFull } from "./browser/launch-hygiene.js";
import { PoolFull } from "./browser/profile-pool.js";
import { MAY_HAVE_GONE_THROUGH } from "./browser/profile-wait.js";
import { AccessRefused, NeedsHuman } from "./browser/session.js";
import { HttpError } from "./clients/http.js";
import { GateOpen } from "./engine/effects.js";
import { PaymentGate } from "./gates/payment.js";
import { NetRefused } from "./reach/net-guard.js";
import { SiteError } from "./sites/types.js";
import type { ErrorCode } from "./ui/http.js";

export interface ErrorContract {
  code: ErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
  /** Set only when a write may have gone through: check before sending again. */
  outcome?: "unknown";
  /** HTTP status the code maps to. */
  status: number;
  /** Seconds before a retry can work. */
  retryAfter?: number;
  /** The flow's failure record (`.failure.json`): what to read before a repair. */
  artifact?: string;
}

/** The failure record a flow error carries, on it or down its `cause` chain. */
export function failureOf(err: unknown): string | undefined {
  for (let e = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++)
    if (e instanceof FlowFailed || e instanceof FlowInterrupted || e instanceof NeedsHuman)
      if (e.artifacts.failure) return e.artifacts.failure;
  return undefined;
}

const HINT: Partial<Record<ErrorCode, string>> = {
  need_login: "sign in once: `autobrowse login <site>` (one try, then report)",
  platform_blocked: "the site blocked this account or showed a captcha: stop, do not retry now",
  rate_limited: "over a cap or the site's limit: wait `retryAfter` s, then retry",
  upstream_broken: "the site's page or endpoint changed: `autobrowse repair` from the failure",
  flow_broken: "the flow failed on the page: read its artifacts, then `autobrowse repair`",
  upstream_error: "the site answered an error: read `message`; a 5xx may pass on a retry",
  needs_person: "a person must act on the page: say what the step is and wait",
  gate_refused: "a person said no or has not answered: never work around it",
  profile_busy: "another browser holds the profile: wait, or see `autobrowse browsers`",
  browser_down: "the browser or its connection died: retry the same call",
  url_refused:
    "the URL is a private address, a non-http scheme or outside NET_ALLOW_DOMAINS: do not retry",
  not_configured: "a key, token or leg is missing: `autobrowse site status <site>`",
  not_found: "no such route, site or thing: check the name",
  bad_request: "fix the input: read `message`",
  invalid_body: "fix the input: read `message`",
  invalid_query: "fix the input: read `message`",
  invalid_path: "fix the input: read `message`",
  conflict: "not now: read `message`",
  unauthorized: "this API refused the caller's key",
  forbidden: "not allowed: read `message`",
  unavailable: "the service is down: retry later",
  failed: "read `message`",
  internal: "an autobrowse bug: rerun with AUTOBROWSE_DEBUG=1 and report the stack",
};

const RETRYABLE = new Set<ErrorCode>([
  "rate_limited",
  "unavailable",
  "profile_busy",
  "browser_down",
]);

const STATUS_CODE: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  501: "not_configured",
  502: "upstream_error",
  503: "unavailable",
};
const CODE_STATUS: Partial<Record<ErrorCode, number>> = {
  need_login: 401,
  platform_blocked: 403,
  rate_limited: 429,
  upstream_broken: 502,
  needs_person: 409,
  gate_refused: 403,
  profile_busy: 409,
  url_refused: 403,
  browser_down: 503,
  flow_broken: 502,
  internal: 500,
  failed: 500,
};

/** Both `MAY_HAVE_GONE` (facade) and `sentWords` say it. */
const mayHaveGone = (m: string) => m.includes(MAY_HAVE_GONE_THROUGH);

function codeOf(err: unknown): { code: ErrorCode; status?: number; retryAfter?: number } {
  if (err instanceof SiteError)
    return {
      code:
        err.code ??
        STATUS_CODE[err.status] ??
        (err.status >= 500 ? "upstream_error" : "bad_request"),
      status: err.status,
      ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    };
  if (err instanceof AccessRefused) return { code: err.code };
  if (err instanceof NeedsHuman)
    return {
      code: err.wall === "captcha" ? "platform_blocked" : err.wall ? "need_login" : "needs_person",
    };
  if (err instanceof PaymentGate || err instanceof GateOpen) return { code: "gate_refused" };
  if (err instanceof NetRefused) return { code: "url_refused" };
  if (profileBusyOf(err) || err instanceof PoolFull || err instanceof OwnTabsFull)
    return { code: "profile_busy" };
  if (
    err instanceof FlowInterrupted ||
    err instanceof BrowserNotReady ||
    isTransientBrowserError(err)
  )
    return { code: "browser_down" };
  if (err instanceof FlowFailed || err instanceof RungBroke) return { code: "flow_broken" };
  if (err instanceof HttpError) {
    const up = err.status || 0;
    if (up === 429) return { code: "rate_limited", status: 429 };
    return {
      code: "upstream_error",
      status: up >= 400 && up < 500 && up !== 401 && up !== 403 ? up : 502,
    };
  }
  if (err instanceof z.ZodError) return { code: "bad_request", status: 400 };
  // A TypeError or ReferenceError is our code's fault; any other Error says its own reason.
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError)
    return { code: "internal", status: 500 };
  return { code: "failed", status: 500 };
}

/** Any thrown value as the contract. */
export function errorOf(err: unknown): ErrorContract {
  const message = err instanceof Error ? err.message : String(err);
  const { code, status, retryAfter } = codeOf(err);
  const s = status ?? CODE_STATUS[code] ?? 500;
  const artifact = failureOf(err);
  return {
    code,
    message,
    hint: HINT[code] ?? "read `message`",
    retryable: RETRYABLE.has(code) || (code === "upstream_error" && s >= 500),
    ...(mayHaveGone(message) ? { outcome: "unknown" as const } : {}),
    status: s,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(artifact ? { artifact } : {}),
  };
}

/**
 * Exit code by class (sysexits), so a script branches without parsing: 2 bad input,
 * 66 not found, 69 the site failed, 75 try later, 77 no access, 78 not set up, 1 other.
 */
export function exitCodeOf(e: Pick<ErrorContract, "code" | "status" | "outcome">): number {
  if (e.outcome === "unknown") return 75;
  switch (e.code) {
    case "bad_request":
    case "invalid_json":
    case "invalid_body":
    case "invalid_query":
    case "invalid_path":
    case "payload_too_large":
    case "unsupported_media_type":
      return 2;
    case "not_found":
      return 66;
    case "upstream_error":
    case "upstream_broken":
    case "flow_broken":
    case "unavailable":
    case "browser_down":
      return 69;
    case "rate_limited":
    case "conflict":
    case "profile_busy":
      return 75;
    case "need_login":
    case "platform_blocked":
    case "unauthorized":
    case "forbidden":
    case "gate_refused":
    case "needs_person":
    case "url_refused":
      return 77;
    case "not_configured":
      return 78;
    default:
      return 1;
  }
}
