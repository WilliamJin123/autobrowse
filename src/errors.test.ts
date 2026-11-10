import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FlowFailed } from "./browser/flow.js";
import { RungBroke } from "./browser/ladder.js";
import { AccessRefused, NeedsHuman } from "./browser/session.js";
import { HttpError } from "./clients/http.js";
import { errorOf, exitCodeOf } from "./errors.js";
import { PaymentGate } from "./gates/payment.js";
import { SiteError } from "./sites/types.js";

describe("errorOf", () => {
  it("keeps a coded SiteError's code and retry time", () => {
    const e = errorOf(new SiteError(429, "over the cap", 60));
    expect(e).toMatchObject({ code: "rate_limited", retryable: true, status: 429, retryAfter: 60 });
    expect(exitCodeOf(e)).toBe(75);
  });

  it("maps access refusals and walls to the wren seam's codes", () => {
    expect(errorOf(new AccessRefused("need_login", "signed out")).code).toBe("need_login");
    expect(errorOf(new NeedsHuman("captcha", "captcha")).code).toBe("platform_blocked");
    expect(errorOf(new NeedsHuman("consent page")).code).toBe("needs_person");
    expect(exitCodeOf(errorOf(new AccessRefused("platform_blocked", "x")))).toBe(77);
  });

  it("marks a write that may have gone through as an unknown outcome", () => {
    const e = errorOf(new SiteError(409, "POST /x: an earlier try may have gone through before …"));
    expect(e.outcome).toBe("unknown");
    expect(exitCodeOf(e)).toBe(75);
  });

  it("names a refused gate, a broken flow, a site's 5xx and bad input", () => {
    expect(errorOf(new PaymentGate("buy", "denied")).code).toBe("gate_refused");
    expect(errorOf(new FlowFailed("x/y", new Error("no button"), {})).code).toBe("flow_broken");
    expect(errorOf(new RungBroke("HTTP 404")).code).toBe("flow_broken");
    const up = errorOf(new HttpError("GET", "https://a.b/c", 503));
    expect(up).toMatchObject({ code: "upstream_error", retryable: true, status: 502 });
    const bad = z.object({ a: z.string() }).safeParse({});
    expect(exitCodeOf(errorOf(bad.error))).toBe(2);
  });

  it("tells a plain failure from a code fault", () => {
    expect(errorOf(new Error("no such site")).code).toBe("failed");
    expect(errorOf(new TypeError("x is undefined")).code).toBe("internal");
  });
});
