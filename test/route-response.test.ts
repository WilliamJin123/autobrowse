import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkResponse } from "../src/sites/facade.js";
import { SiteError } from "../src/sites/types.js";

const shape = z.looseObject({ hits: z.array(z.looseObject({ id: z.string() })) });

describe("route response schema (U2)", () => {
  it("passes a good answer back as sent, extra fields kept", () => {
    const out = { hits: [{ id: "a", points: 3 }], more: true };
    expect(checkResponse({ method: "GET", path: "/s", response: shape }, out)).toBe(out);
  });

  it("fails a read whose shape broke as upstream_broken", () => {
    let err: unknown;
    try {
      checkResponse({ method: "GET", path: "/s", response: shape }, { hits: [{ id: 1 }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).code).toBe("upstream_broken");
    expect((err as SiteError).status).toBe(502);
    expect((err as Error).message).toContain("hits.0.id");
  });

  it("keeps a write's answer and says what drifted", () => {
    const got = checkResponse(
      { method: "POST", path: "/p", response: z.looseObject({ id: z.string() }) },
      { url: "x" },
    ) as Record<string, unknown>;
    expect(got.url).toBe("x");
    expect(got.shapeDrift).toContain("id");
  });

  it("a POST labelled read fails like a GET", () => {
    expect(() =>
      checkResponse({ method: "POST", path: "/q", access: "read", response: shape }, {}),
    ).toThrow(/changed shape/);
  });

  it("no schema: no check", () => {
    expect(checkResponse({ method: "GET", path: "/s" }, 5)).toBe(5);
  });
});
