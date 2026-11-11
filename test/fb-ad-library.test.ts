import { describe, expect, it } from "vitest";
import {
  adOf,
  connectionsOf,
  jsonLines,
  libraryUrl,
  pageRef,
} from "../src/browser/flows/fb-ad-library.js";
import { fbPublic } from "../src/sites/fb-public.js";

const DAY = 86_400;
const record = (o: Record<string, unknown> = {}) => ({
  ad_archive_id: "111",
  page_id: "15087023444",
  page_name: "Nike",
  is_active: true,
  start_date: 1_750_000_000,
  end_date: 1_750_000_000 + 3 * DAY,
  publisher_platform: ["FACEBOOK", "INSTAGRAM"],
  collation_count: 4,
  snapshot: {
    page_profile_uri: "https://www.facebook.com/nike/",
    page_like_count: 39_000_000,
    display_format: "VIDEO",
    title: "Air Max",
    body: { text: "Run." },
    cta_text: "Shop now",
    cta_type: "SHOP_NOW",
    link_url: "https://www.nike.com/",
    caption: "NIKE.COM",
    images: [{ original_image_url: "https://img/o.jpg", resized_image_url: "https://img/r.jpg" }],
    videos: [
      {
        video_hd_url: "https://v/hd.mp4",
        video_sd_url: null,
        video_preview_image_url: "https://v/p.jpg",
      },
    ],
    cards: [
      { title: "Card", body: "B", link_url: "https://c", original_image_url: "https://c.jpg" },
    ],
  },
  ...o,
});

describe("adOf", () => {
  it("keeps the record whole and reads its fields", () => {
    const now = (1_750_000_000 + 10 * DAY) * 1000;
    const ad = adOf(record(), now);
    expect(ad).toMatchObject({
      libraryId: "111",
      advertiser: {
        id: "15087023444",
        name: "Nike",
        url: "https://www.facebook.com/nike/",
        likes: 39_000_000,
      },
      active: true,
      ended: null,
      daysRunning: 10,
      platforms: ["FACEBOOK", "INSTAGRAM"],
      versions: 4,
      format: "VIDEO",
      headline: "Air Max",
      body: "Run.",
      cta: "Shop now",
      link: "https://www.nike.com/",
      media: {
        images: [{ url: "https://img/o.jpg", resized: "https://img/r.jpg" }],
        videos: [{ hd: "https://v/hd.mp4", sd: null, poster: "https://v/p.jpg" }],
      },
      cards: [{ headline: "Card", link: "https://c", image: "https://c.jpg", video: null }],
    });
    expect(ad.raw.ad_archive_id).toBe("111");
  });

  it("an ended ad counts days to its end; no collation is one version", () => {
    const ad = adOf(record({ is_active: false, collation_count: null }), Date.now());
    expect(ad.daysRunning).toBe(3);
    expect(ad.ended).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ad.versions).toBe(1);
  });
});

describe("connectionsOf", () => {
  it("finds the connection deep in a bbox payload, with its cursor", () => {
    const root = {
      require: [
        [
          0,
          0,
          0,
          {
            __bbox: {
              result: {
                data: {
                  ad_library_main: {
                    search_results_connection: {
                      count: 90,
                      edges: [
                        { node: { collated_results: [record()] } },
                        { node: { collated_results: [record({ ad_archive_id: "222" })] } },
                      ],
                      page_info: { end_cursor: "C1", has_next_page: true },
                    },
                  },
                },
              },
            },
          },
        ],
      ],
    };
    const [c] = connectionsOf(root);
    expect(c?.count).toBe(90);
    expect(c?.records.map((r) => r.ad_archive_id)).toEqual(["111", "222"]);
    expect(c?.cursor).toBe("C1");
  });

  it("no next page: no cursor", () => {
    const [c] = connectionsOf({
      search_results_connection: {
        edges: [],
        page_info: { end_cursor: "X", has_next_page: false },
      },
    });
    expect(c?.cursor).toBeNull();
  });
});

describe("jsonLines", () => {
  it("reads one JSON, or one per line", () => {
    expect(jsonLines('{"a":1}')).toEqual([{ a: 1 }]);
    expect(jsonLines('for (;;);{"a":1}')).toEqual([{ a: 1 }]);
    expect(jsonLines('{"a":1}\n{"b":2}\nnot json')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("pageRef and libraryUrl", () => {
  it("an id passes; a URL or username is fetched", () => {
    expect(pageRef("15087023444")).toEqual({ id: "15087023444" });
    expect(pageRef("https://www.facebook.com/ads/library/?view_all_page_id=123456")).toEqual({
      id: "123456",
    });
    expect(pageRef("https://www.facebook.com/nike/")).toEqual({
      url: "https://www.facebook.com/nike/",
    });
    expect(pageRef("@nike")).toEqual({ url: "https://www.facebook.com/nike" });
  });

  it("builds the page and keyword searches", () => {
    const page = new URL(libraryUrl({ pageId: "9", country: "US", inactive: true }));
    expect(page.searchParams.get("view_all_page_id")).toBe("9");
    expect(page.searchParams.get("search_type")).toBe("page");
    expect(page.searchParams.get("active_status")).toBe("all");
    const kw = new URL(libraryUrl({ q: "staffing agency", country: "ALL", inactive: false }));
    expect(kw.searchParams.get("q")).toBe("staffing agency");
    expect(kw.searchParams.get("active_status")).toBe("active");
  });
});

describe("GET /ads", () => {
  const r = fbPublic.routes.find((x) => x.path === "/ads");
  it("takes q or page, not both, and meters by result page", () => {
    expect(r?.request.safeParse({ q: "shoes" }).success).toBe(true);
    expect(r?.request.safeParse({ page: "nike" }).success).toBe(true);
    expect(r?.request.safeParse({}).success).toBe(false);
    expect(r?.request.safeParse({ q: "shoes", page: "nike" }).success).toBe(false);
    const meter = r?.meter as (i: unknown) => { reads: number };
    expect(meter(r?.request.parse({ q: "shoes", max: 90 }))).toEqual({ reads: 3 });
    expect(meter(r?.request.parse({ page: "nike" }))).toEqual({ reads: 2 });
    expect(meter(r?.request.parse({ page: "15087023444" }))).toEqual({ reads: 1 });
  });
});
