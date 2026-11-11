/**
 * Pinterest public reads, signed out, in the `pinterest` profile (OpenCLI port, `clis/pinterest`).
 * Pinterest's API needs an approved app and the owner's token, and reads only our own boards: so
 * these are browser legs. Writes (pin, board) wait for a Pinterest account.
 */
import { z } from "zod";
import { route, type SiteApi } from "./types.js";

const name = z.string().regex(/^@?[\w.-]{2,60}$/, "a Pinterest username");

export const pinterest: SiteApi = {
  site: "pinterest",
  origin: "https://www.pinterest.com",
  auth: { open: true },
  signedOut: true,
  // A visitor's day of browsing: about 25 pins a search page.
  caps: { reads: 150 },
  pace: { gapMs: 10_000, jitterMs: 20_000 },
  routes: [
    route({
      method: "GET",
      path: "/search/pins",
      standing: { final: "the Pinterest API has no search of other people's pins" },
      summary:
        "Pins for `q` (BaseSearchResource, paged by bookmark), each pin whole (title, description, images, pinner, board, link), up to `max` (default 50, at most 500). A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(200),
        max: z.coerce.number().int().min(1).max(500).default(50),
      }),
      meter: ({ max }) => ({ reads: Math.ceil(max / 25) }),
      browser: { flow: "pinterest/search" },
      ported: "clis/pinterest/search-pins.js@9bc5f5c",
    }),
    route({
      method: "GET",
      path: "/users/{username}",
      standing: { final: "the Pinterest API reads only the token owner's account" },
      summary:
        "A profile off its page's own data: `user` whole (follower count, about, website, pin and board counts), its boards and first pins, whole; `found:false` for no such user. A browser leg: call it on the desk",
      request: z.object({ username: name }),
      meter: () => ({ reads: 1 }),
      browser: { flow: "pinterest/user" },
      ported: "clis/pinterest/user.js@9bc5f5c",
    }),
    route({
      method: "GET",
      path: "/users/{username}/boards/{board}",
      standing: { final: "the Pinterest API reads only the token owner's boards" },
      summary:
        "A board (`info` whole) and its pins, whole: the page's first feed, then feed pages by bookmark, up to `max` (default 50, at most 500). A browser leg: call it on the desk",
      request: z.object({
        username: name,
        board: z.string().regex(/^[\w-]{1,100}$/, "a board slug"),
        max: z.coerce.number().int().min(1).max(500).default(50),
      }),
      meter: ({ max }) => ({ reads: Math.ceil(max / 25) }),
      browser: { flow: "pinterest/board" },
      ported: "clis/pinterest/board-pins.js@9bc5f5c",
    }),
  ],
  setup: [],
};
