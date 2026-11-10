import { describe, expect, it } from "vitest";
import { ladder, RungBroke } from "./ladder.js";
import { AccessRefused } from "./session.js";

const broke = (why: string) => async () => {
  throw new RungBroke(why);
};

describe("ladder", () => {
  it("answers from the first rung that works, with the ones that fell", async () => {
    const got = await ladder([
      { strategy: "cookie", run: broke("404") },
      { strategy: "intercept", run: async () => 7 },
      { strategy: "ui", run: async () => 9 },
    ]);
    expect(got).toEqual({ value: 7, via: "intercept", fell: [{ strategy: "cookie", why: "404" }] });
  });

  it("stops at once on a refusal: no fall to clicks after a block", async () => {
    let ui = false;
    await expect(
      ladder([
        {
          strategy: "cookie",
          run: async () => {
            throw new AccessRefused("rate_limited", "429");
          },
        },
        {
          strategy: "ui",
          run: async () => {
            ui = true;
            return 1;
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(ui).toBe(false);
  });

  it("all broke: upstream_broken naming each way", async () => {
    await expect(
      ladder([
        { strategy: "cookie", run: broke("404") },
        { strategy: "ui", run: broke("no rows") },
      ]),
    ).rejects.toMatchObject({ code: "upstream_broken", message: /cookie: 404; ui: no rows/ });
  });
});
