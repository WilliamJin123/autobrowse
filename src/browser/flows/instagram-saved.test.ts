import { describe, expect, it } from "vitest";
import type { FlowPage } from "../flow.js";
import { type IgSaved, instagramSaved } from "./instagram-people.js";

const media = { code: "C1", pk: "1", taken_at: 1762900000, saved_collection_ids: ["9"] };
const saved = {
  status: 200,
  contentType: "application/json",
  text: JSON.stringify({ items: [{ media }], more_available: false }),
};

/** a page whose fetches answer by path */
const pageOf = (collections: { status: number; text: string }): FlowPage =>
  ({
    open: async () => {},
    url: () => "https://www.instagram.com/",
    wait: async () => {},
    page: {
      evaluate: async (_fn: unknown, { url }: { url: string }) =>
        url.startsWith("/api/v1/collections/list/")
          ? { ...collections, url, contentType: "text/html" }
          : { ...saved, url },
    },
  }) as unknown as FlowPage;

const run = (fp: FlowPage, input: { collection?: string } = {}) =>
  instagramSaved.run(fp, { max: 10, ...input }) as Promise<IgSaved>;

describe("instagram saved", () => {
  it("reads saved posts when the collections read is broken", async () => {
    const got = await run(pageOf({ status: 404, text: "<html>" }));
    expect(got).toMatchObject({ found: true, collections: [], media: [media] });
    expect(got.collectionsError).toMatch(/collections\/list\/: HTTP 404, not JSON/);
  });

  it("fails a named collection read and a refusal", async () => {
    await expect(
      run(pageOf({ status: 404, text: "<html>" }), { collection: "Edits" }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(run(pageOf({ status: 429, text: "" }))).rejects.toThrow(/429/);
  });
});
