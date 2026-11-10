import { describe, expect, it } from "vitest";
import { clipMedia, clipsOf, reelCodeOf, reelUrl } from "./instagram-reels.js";

describe("reelCodeOf", () => {
  it("takes the code of a clips item", () => {
    expect(reelCodeOf({ product_type: "clips", code: "C1a_b-2" })).toBe("C1a_b-2");
  });

  it("is null for a photo, a carousel, no code, or no item", () => {
    expect(reelCodeOf({ product_type: "feed", code: "X" })).toBeNull();
    expect(reelCodeOf({ product_type: "carousel_container", code: "X" })).toBeNull();
    expect(reelCodeOf({ product_type: "clips", code: "" })).toBeNull();
    expect(reelCodeOf(null)).toBeNull();
  });
});

describe("reelUrl", () => {
  it("builds the reel's page", () => {
    expect(reelUrl("C1a_b-2")).toBe("https://www.instagram.com/reel/C1a_b-2/");
  });
});

const answer = (codes: string[], more = true) => ({
  data: {
    fetch__XDTUserDict: {
      clips_connection: {
        edges: codes.map((code) => ({ node: { media: { code, pk: `p${code}` } } })),
        page_info: { end_cursor: "c", has_next_page: more },
      },
    },
  },
});

describe("clipsOf", () => {
  it("finds the Reels tab connection, null for another query", () => {
    expect(clipsOf(answer(["A"]))?.edges).toHaveLength(1);
    expect(clipsOf({ data: { xdt_viewer: {} } })).toBeNull();
    expect(clipsOf("x")).toBeNull();
  });
});

describe("clipMedia", () => {
  it("keeps each media whole, once, in arrival order", () => {
    const got = clipMedia([answer(["A", "B"]), { data: {} }, answer(["B", "C"], false)]);
    expect(got.map((m) => m.code)).toEqual(["A", "B", "C"]);
    expect(got[0]).toEqual({ code: "A", pk: "pA" });
  });
});
