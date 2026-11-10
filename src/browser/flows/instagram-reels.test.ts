import { describe, expect, it } from "vitest";
import { reelCodeOf, reelUrl } from "./instagram-reels.js";

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
