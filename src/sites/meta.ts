/**
 * Meta under one Facebook Login app: the Marketing API (ad accounts,
 * campaigns, ad sets, creatives, ads, insights), Pages (posts, photos,
 * videos) and Instagram publishing through the Page's professional account
 * — all on graph.facebook.com with the person's user token, the Page's own
 * token fetched for Page writes. Anything that can start spending
 * (`status: ACTIVE`) is a `spends` route: the spend policy and then the
 * person say yes first, the amount being the budget on the request.
 * Written from the docs 2026-09-22; unproven until a Meta app, an ad
 * account with a payment method and a Page exist.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { resolveFile } from "../browser/run-files.js";
import { HttpError, type JsonResponse, mustOk } from "../clients/http.js";
import type { Amount } from "../gates/spend.js";
import { OAUTH_PROVIDERS } from "../oauth/providers.js";
import { META_APP } from "./blockers.js";
import { fields, resolve } from "./facets/core.js";
import { INSTAGRAM_TAGS } from "./facets/sets.js";
import { igContainer } from "./ig-container.js";
import { WEB_REDIRECT } from "./oauth.js";
import { type ApiLeg, bearer, type OAuthSpec, route, type SiteApi, SiteError } from "./types.js";
import type { Seen, VerifyGet, VerifyRead, VerifyRow } from "./verdict.js";
import { arr, hasNext, isoOf, rec, str, text, unclear } from "./verify-kit.js";
import { type GraphFailure, graphNote, graphWhy } from "./why.js";

export const META_ORIGIN = "https://graph.facebook.com";
/** Graph API versions live about two years. */
export const META_VERSION = "v23.0";

const POSTS_READ = 25;
const fbUrl = (id: string) => `https://www.facebook.com/${id}`;

/** The Page's newest posts (published ones), as verify rows. */
async function pagePostRows(look: VerifyGet, pageId: string): Promise<VerifyRead> {
  const r = await look(`/${pageId}/posts`, {
    fields: "id,message,created_time,permalink_url",
    limit: POSTS_READ,
  });
  return {
    rows: arr(rec(r).data).map((e) => {
      const p = rec(e);
      return {
        words: text(p.message),
        at: isoOf(p.created_time),
        id: str(p.id),
        url: str(p.permalink_url),
      };
    }),
    order: "newest",
    complete: !hasNext(r),
  };
}

/** What a post to a Page looks for: its words, or nothing to find it by. */
const noWords = (m: string | undefined): Seen | null =>
  m?.trim() ? null : unclear("the post has no words to look for");

/** A scheduled or unpublished post is not in the Page's posts yet. */
const unlisted = (published: boolean, at?: number): string | null =>
  !published || at ? "a scheduled or unpublished post is not in the Page's posts" : null;

/** A DM's rows from a Page's conversations; `ours` says whose a message is. */
function dmRows(bodies: readonly unknown[], ours: (from: string) => boolean): VerifyRow[] {
  return bodies
    .flatMap((b) => arr(rec(b).data))
    .flatMap((conv) =>
      arr(rec(rec(conv).messages).data).map((m): VerifyRow => {
        const msg = rec(m);
        return {
          words: text(msg.message),
          at: isoOf(msg.created_time),
          id: str(msg.id),
          url: null,
          mine: ours(text(rec(msg.from).id)),
        };
      }),
    )
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

const id = z.string().regex(/^[0-9]+$/, "a numeric Graph id");
/** A Graph object id: a Page post's is `<pageId>_<n>`. */
const graphId = z
  .string()
  .regex(/^[0-9]+(_[0-9]+)?$/, "a Graph id (a Page post's is <pageId>_<n>)");
/** An ad account id without its `act_` prefix (the path carries the prefix). */
const adAccount = z.string().regex(/^[0-9]+$/, "the ad account's number (after act_)");
const status = z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]);
/** Graph budgets are in the account currency's minor unit: 2000 = 20.00. */
const minor = z.coerce.number().int().min(100);
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
};

const me = z.object({ fields: z.string().default("id,name") });
const adAccounts = z.object({
  fields: z.string().default("id,name,account_status,currency,amount_spent,balance"),
  ...page,
});
const pages = z.object({
  fields: z.string().default("id,name,category,instagram_business_account"),
  ...page,
});
const listIn = z.object({
  adAccountId: adAccount,
  fields: z.string().default("id,name,status,effective_status,objective,daily_budget,created_time"),
  ...page,
});
const campaign = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  objective: z.enum([
    "OUTCOME_AWARENESS",
    "OUTCOME_TRAFFIC",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_LEADS",
    "OUTCOME_APP_PROMOTION",
    "OUTCOME_SALES",
  ]),
  status: status.default("PAUSED"),
  special_ad_categories: z.array(z.string()).default([]),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
  bid_strategy: z.string().optional(),
});
const adset = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  campaign_id: id,
  status: status.default("PAUSED"),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
  billing_event: z.string().default("IMPRESSIONS"),
  optimization_goal: z.string().default("LINK_CLICKS"),
  bid_strategy: z.string().optional(),
  bid_amount: z.coerce.number().int().optional(),
  targeting: z.record(z.string(), z.unknown()),
  promoted_object: z.record(z.string(), z.unknown()).optional(),
  destination_type: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
});
const adimage = z.object({
  adAccountId: adAccount,
  url: z.string().url().optional(),
  /** Base64 of the file, when there is no public URL. */
  bytes: z.string().optional(),
  name: z.string().optional(),
});
const advideo = z.object({
  adAccountId: adAccount,
  file_url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const creative = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  /** The Page post the ad shows: `{page_id, link_data|video_data}`; or `instagram_user_id` for IG placements. */
  object_story_spec: z.record(z.string(), z.unknown()),
  degrees_of_freedom_spec: z.record(z.string(), z.unknown()).optional(),
});
const ad = z.object({
  adAccountId: adAccount,
  name: z.string().min(1),
  adset_id: id,
  creative: z.object({ creative_id: id }),
  status: status.default("PAUSED"),
});
const update = z.object({
  objectId: id,
  status: status.optional(),
  name: z.string().optional(),
  daily_budget: minor.optional(),
  lifetime_budget: minor.optional(),
});
const object = z.object({
  objectId: graphId,
  fields: z.string().default("id"),
  /** The Page that owns the object (its video, photo or post): read with that Page's token. */
  pageId: id.optional(),
});
const search = z.object({
  type: z.enum(["adinterest", "adgeolocation", "adworkposition", "adeducationmajor"]),
  q: z.string().min(1),
  limit: z.number().int().positive().max(100).default(25),
});
const insights = z.object({
  adAccountId: adAccount,
  fields: z.string().default("campaign_name,impressions,reach,clicks,ctr,cpc,cpm,spend,actions"),
  level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
  date_preset: z.string().default("last_7d"),
  /** `{"since":"2026-01-01","until":"2026-09-29"}`; set, it replaces `date_preset`. */
  time_range: z.string().optional(),
  time_increment: z.string().optional(),
  ...page,
});
const accountFields = z.object({
  adAccountId: adAccount,
  fields: z.string().default("id,name,account_status,amount_spent,currency,created_time"),
});
const adsetsIn = listIn.extend({
  fields: z
    .string()
    .default(
      "id,name,campaign_id,effective_status,optimization_goal,promoted_object,daily_budget,learning_stage_info",
    ),
});
const adsIn = listIn.extend({
  fields: z.string().default("id,name,adset_id,effective_status,creative{id,object_type,url_tags}"),
});
const pixelsIn = listIn.extend({
  fields: z.string().default("id,name,creation_time,last_fired_time,is_unavailable"),
});
const pagePosts = z.object({
  pageId: id,
  fields: z.string().default("id,message,created_time,permalink_url,shares,likes.summary(true)"),
  ...page,
});
/** Meta's webhook fields a Page sends (wren designs/2026-10-12-push-everywhere.md). */
const pageSubscription = z.object({
  pageId: id,
  subscribed_fields: z.string().default("feed,messages"),
});
const pageOnly = z.object({ pageId: id });
const appSubscription = z.object({
  object: z.enum(["page", "instagram", "user", "permissions"]),
  callback_url: z.string().url(),
  fields: z.string().min(1),
  // Graph refuses a page subscription without values.
  include_values: z.boolean().default(true),
});
const feed = z.object({
  pageId: id,
  message: z.string().min(1).max(63_206),
  link: z.string().url().optional(),
  published: z.boolean().default(true),
  scheduled_publish_time: z.coerce.number().int().optional(),
});
const photo = z.object({
  pageId: id,
  url: z.string().url(),
  message: z.string().optional(),
  published: z.boolean().default(true),
});
const video = z.object({
  pageId: id,
  file_url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const photoStory = z.object({ pageId: id, url: z.string().url() });
const videoStory = z.object({ pageId: id, file_url: z.string().url() });
const leadForm = z.object({
  pageId: id,
  name: z.string().min(1),
  /** Meta's question objects: `{type: "EMAIL"}`, `{type: "FULL_NAME"}`, `{type: "CUSTOM", key, label}` … */
  questions: z.array(z.record(z.string(), z.unknown())).min(1),
  privacy_policy: z.object({ url: z.string().url(), link_text: z.string().optional() }),
  /** Where the thank-you button goes. */
  follow_up_action_url: z.string().url().optional(),
  thank_you_page: z.record(z.string(), z.unknown()).optional(),
  context_card: z.record(z.string(), z.unknown()).optional(),
  locale: z.string().default("EN_US"),
});
const leadForms = z.object({
  pageId: id,
  fields: z.string().default("id,name,status,leads_count,created_time"),
  ...page,
});
const leads = z.object({
  formId: id,
  fields: z.string().default("id,created_time,ad_id,campaign_id,field_data"),
  ...page,
});
const igPublish = z.object({ igUserId: id, creation_id: id });
/** A container whose video is a file: `video_file` (a path on this machine or a URL) in place of `video_url`. */
const igContainerOrFile = igContainer
  .extend({ video_file: z.string().min(1).optional() })
  .refine((b) => !(b.video_file && b.video_url), "send `video_file` or `video_url`, not both");
const igMedia = z.object({
  igUserId: id,
  fields: z
    .string()
    .default("id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count"),
  ...page,
});
const igInsights = z.object({
  mediaId: id,
  metric: z.string().default("reach,saved,likes,comments,shares,views"),
});
const igComments = z.object({
  // a Facebook Page post's comments read here too
  mediaId: graphId,
  fields: z.string().default("id,text,username,timestamp,like_count"),
  ...page,
});
/** Instagram usernames: letters, digits, `.` and `_`, up to 30. */
/** A hashtag's posts: Graph's Hashtag Search (Instagram Public Content Access). */
const igHashtag = z.object({
  tag: z.string().regex(/^[\p{L}\p{N}_]{1,100}$/u, "a hashtag, no #"),
  /** `top_media` (most liked) or `recent_media` (last 24 hours, newest first): the app's own two tabs. */
  ...fields(INSTAGRAM_TAGS),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  after: z
    .string()
    .regex(/^[A-Za-z0-9_=-]{1,512}$/)
    .optional(),
});
const igReels = z.object({
  username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "an Instagram username"),
  /** Most posts read, newest first (reels and others). */
  max: z.coerce.number().int().min(1).max(2000).default(1000),
});
const igLookup = z.object({
  username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "an Instagram username"),
  /** The page after this one: a previous answer's `next`. */
  after: z
    .string()
    .regex(/^[A-Za-z0-9_=-]{1,512}$/, "a cursor from a previous answer's `next`")
    .optional(),
  /** Posts a page, newest first. */
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const igReply = z.object({ commentId: id, message: z.string().min(1).max(2200) });
/** A Page's answer under a Facebook comment, by the Page's own token. */
const pageReply = z.object({ pageId: id, commentId: id, message: z.string().min(1).max(8000) });
/**
 * A Page's conversations, newest first by `updated_time`, each with the messages `fields` asks
 * for. `platform` picks the inbox: Messenger, or the Page's Instagram. `user_id` narrows it to
 * one person (their PSID or IGSID).
 */
const conversations = z.object({
  pageId: id,
  platform: z.enum(["messenger", "instagram"]).default("messenger"),
  fields: z
    .string()
    .default("participants,updated_time,messages.limit(10){id,message,from,created_time}"),
  user_id: id.optional(),
  ...page,
});
/**
 * The Send API: a DM from the Page (Facebook or its Instagram), to a person who wrote first
 * (`recipient.id`) or as the one Private Reply a comment allows (`recipient.comment_id`).
 */
const pageMessage = z.object({
  pageId: id,
  recipient: z.union([z.object({ id }), z.object({ comment_id: id })]),
  message: z.union([
    z.object({
      text: z.string().min(1).max(2000),
      // Instagram's quick replies: a tap comes back with the payload (wren WA-1047)
      quick_replies: z
        .array(
          z.object({
            content_type: z.literal("text"),
            title: z.string().min(1).max(20),
            payload: z.string().min(1).max(1000),
          }),
        )
        .min(1)
        .max(13)
        .optional(),
    }),
    // One button template (wren designs/2026-11-04-meta-push-flows.md): its tap opens the 24h window.
    z.object({
      attachment: z.object({
        type: z.literal("template"),
        payload: z.object({
          template_type: z.literal("button"),
          text: z.string().min(1).max(640),
          buttons: z
            .array(
              z.object({
                type: z.literal("postback"),
                title: z.string().min(1).max(20),
                payload: z.string().min(1).max(1000),
              }),
            )
            .min(1)
            .max(3),
        }),
      }),
    }),
  ]),
  messaging_type: z.enum(["RESPONSE", "UPDATE", "MESSAGE_TAG"]).optional(),
  tag: z.string().optional(),
});

const must = <T>(res: JsonResponse<T>, what: string): T =>
  mustOk(res, `${META_ORIGIN}/${what}`, graphWhy);

/** A video's bytes up to Instagram, this long at most: ~1 GB at a slow uplink. */
const RUPLOAD_MS = 60 * 60_000;

/**
 * A resumable container's video (Facebook Login only: graph.instagram.com refuses
 * `upload_type=resumable`, 2026-11-11). A URL goes as `file_url`, fetched by Meta; a path's
 * bytes go in the body. A rerun makes a new container: an unpublished one expires in a day.
 */
async function rupload(leg: ApiLeg, container: string, file: string): Promise<void> {
  const url = `https://rupload.facebook.com/ig-api-upload/${META_VERSION}/${container}`;
  // rupload answers `{debug_info: {type, message}}`, not Graph's `error`.
  const must = <T>(res: JsonResponse<T>, what: string): T =>
    mustOk(res, `https://rupload.facebook.com/${what}`, (b) => {
      const d = rec(rec(b).debug_info);
      return graphWhy(b) || [str(d.type), str(d.message)].filter(Boolean).join(": ");
    });
  const auth = { authorization: `OAuth ${leg.token}` };
  if (/^https?:\/\//i.test(file)) {
    must(
      await leg.http.json<unknown>(url, { method: "POST", headers: { ...auth, file_url: file } }),
      "ig-api-upload",
    );
    return;
  }
  const path = await resolveFile(file);
  const { size } = await stat(path);
  must(
    await leg.http.json<unknown>(url, {
      method: "POST",
      headers: {
        ...auth,
        offset: "0",
        file_size: String(size),
        // A stream needs both lengths stated, or rupload refuses the headers.
        "content-length": String(size),
        "x-entity-length": String(size),
      },
      raw: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
      timeoutMs: RUPLOAD_MS,
    }),
    "ig-api-upload",
  );
}
const v = (path: string) => `${META_ORIGIN}/${META_VERSION}/${path}`;
const withQuery = (url: string, q: Record<string, string | number | boolean | undefined>) => {
  const u = new URL(url);
  for (const [k, val] of Object.entries(q))
    if (val !== undefined) u.searchParams.set(k, String(val));
  return u.toString();
};
const get = async (leg: ApiLeg, path: string, q: Record<string, string | number | undefined>) =>
  must(await leg.http.json<unknown>(withQuery(v(path), q), { headers: bearer(leg) }), path);
const post = async (leg: ApiLeg, path: string, body: Record<string, unknown>) =>
  must(await leg.http.json<unknown>(v(path), { method: "POST", headers: bearer(leg), body }), path);

/**
 * A Page's own token, per Page and user token, held in memory for an hour (never written out,
 * never logged): a run of Page writes asks Graph for it once. One map per HTTP client, so the
 * facade that made it is the one that forgets it.
 */
const PAGE_TOKEN_MS = 60 * 60_000;
const PAGE_TOKENS_KEPT = 16;
const pageTokens = new WeakMap<object, Map<string, { token: Promise<string>; until: number }>>();

/** A Page write needs the Page's own token: read with the user's, kept an hour. */
async function pageLeg(leg: ApiLeg, pageId: string): Promise<ApiLeg> {
  const kept = pageTokens.get(leg.http) ?? new Map();
  pageTokens.set(leg.http, kept);
  const key = `${pageId}\n${leg.token}`;
  let hit = kept.get(key);
  if (!hit || hit.until <= Date.now()) {
    const token = (async () => {
      const got = (await get(leg, pageId, { fields: "access_token" })) as {
        access_token?: string;
      };
      if (!got.access_token)
        throw new HttpError(
          "CALL",
          `${META_ORIGIN}/${pageId}`,
          403,
          "no page token: not an admin of this page",
        );
      return got.access_token;
    })();
    if (kept.size >= PAGE_TOKENS_KEPT) kept.clear();
    hit = { token, until: Date.now() + PAGE_TOKEN_MS };
    kept.set(key, hit);
    // A refused read is not kept: the next write asks again.
    token.catch(() => kept.get(key) === hit && kept.delete(key));
  }
  return { ...leg, token: await hit.token };
}

/**
 * What a Page owns (its posts, videos, photos) reads with the Page's token: Graph refuses the
 * user token there (code 190). The Page is the one named, or a post id's own (`<pageId>_<n>`).
 * Any other object reads with the user's.
 */
function objectLeg(leg: ApiLeg, objectId: string, named?: string): Promise<ApiLeg> | ApiLeg {
  const pageId = named ?? /^(\d+)_\d+$/.exec(objectId)?.[1];
  return pageId ? pageLeg(leg, pageId) : leg;
}

/** The app's id, from the consent's client id. */
function appId(leg: ApiLeg): string {
  const v = leg.env("META_CLIENT_ID");
  if (!v) throw new HttpError("CALL", `${META_ORIGIN}/app`, 400, "no META_CLIENT_ID");
  return v;
}

/** An app's own calls (its webhook subscriptions) take the app token `<id>|<secret>`. */
function appLeg(leg: ApiLeg): ApiLeg {
  const secret = leg.env("META_CLIENT_SECRET");
  if (!secret) throw new HttpError("CALL", `${META_ORIGIN}/app`, 400, "no META_CLIENT_SECRET");
  return { ...leg, token: `${appId(leg)}|${secret}` };
}

const IG_PROFILE =
  "id,ig_id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count";
const IG_MEDIA =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
/** Graph's own rate limits: app (4), user (17), call (32), custom (613), Instagram app (80002). */
const RATE_CODES = new Set([4, 17, 32, 613, 80002]);
/** One Instagram business account id per token, looked up once per process. */
const igUsers = new Map<string, Promise<string>>();
function igUserOf(leg: ApiLeg): Promise<string> {
  let got = igUsers.get(leg.token);
  if (!got) {
    got = (async () => {
      const r = (await get(leg, "me/accounts", {
        fields: "instagram_business_account",
        limit: 100,
      })) as { data?: Array<{ instagram_business_account?: { id?: string } }> };
      const hit = r.data?.map((p) => p.instagram_business_account?.id).find(Boolean);
      if (!hit)
        throw new SiteError(409, "no Page of this account has an Instagram business account");
      return hit;
    })();
    igUsers.set(leg.token, got);
    got.catch(() => igUsers.delete(leg.token));
  }
  return got;
}

/**
 * `business_discovery`: a business or creator account's profile and a page of its posts, newest
 * first, read as our own Instagram business account; `next` is the cursor of the page after, null
 * once a page comes back short (the oldest post). A name that does not exist, or a personal account, is an answer
 * (`found: false`), not an error.
 */
async function igDiscover(
  leg: ApiLeg,
  { username, after, limit }: { username: string; after?: string | undefined; limit: number },
) {
  const media = `media${after ? `.after(${after})` : ""}.limit(${limit})`;
  const fields = `business_discovery.username(${username}){${IG_PROFILE},${media}{${IG_MEDIA}}}`;
  const res = await leg.http.json<
    {
      business_discovery?: {
        media?: { data?: unknown[]; paging?: { cursors?: { after?: string }; next?: string } };
      } & Record<string, unknown>;
    } & GraphFailure
  >(withQuery(v(await igUserOf(leg)), { fields }), { headers: bearer(leg) });
  const found = res.body?.business_discovery;
  if (res.ok && found) {
    const { media, ...profile } = found;
    // Discovery's paging has the cursor and no `next` link: a short page is the last one.
    const data = media?.data ?? [];
    const after = media?.paging?.cursors?.after ?? null;
    const next = data.length >= limit || media?.paging?.next ? after : null;
    return { found: true, profile, media: data, next };
  }
  const e = res.body?.error;
  const why = e?.error_user_msg ?? e?.message ?? "";
  if (e?.code !== undefined && RATE_CODES.has(e.code)) {
    // The text ends as the caps' 429s do (`retry after Ns`): that is what a caller over HTTP parses.
    const wait = Number(res.headers.get("retry-after")) || 3600;
    throw new SiteError(
      429,
      `meta Instagram rate limit (${graphNote(res.body)}): ${why.slice(0, 200)}; retry after ${wait}s`,
      wait,
    );
  }
  // 110 / 2207013: the username is unknown or not a business or creator account.
  if (e?.code === 110 || e?.error_subcode === 2207013)
    return { found: false, reason: `${why} (${graphNote(res.body)})`.trim() };
  return must(res, "{igUserId}/business_discovery");
}

/** Discovery's largest page. */
const IG_PAGE = 50;

/** Every post of a business or creator account, page by page, keeping the reels whole. */
async function igAllReels(leg: ApiLeg, { username, max }: { username: string; max: number }) {
  const media: unknown[] = [];
  let after: string | undefined;
  let pages = 0;
  let profile: unknown = null;
  do {
    const page = (await igDiscover(leg, { username, after, limit: IG_PAGE })) as {
      found?: boolean;
      profile?: unknown;
      media?: unknown[];
      next?: string | null;
    };
    pages++;
    if (!page.found) return page;
    profile = page.profile;
    media.push(...(page.media ?? []));
    after = page.next ?? undefined;
  } while (after && media.length < max);
  const reels = media.filter(
    (m) => (m as { media_product_type?: unknown }).media_product_type === "REELS",
  );
  const urls = reels.map((m) => String((m as { permalink?: unknown }).permalink ?? ""));
  return { found: true, profile, urls, reels, scanned: media.length, pages };
}

/** The budget on a request, as money, when its status starts delivery. */
function budgetOf(i: {
  status?: string | undefined;
  daily_budget?: number | undefined;
  lifetime_budget?: number | undefined;
}): Amount | null | false {
  if (i.status !== "ACTIVE") return false;
  if (i.daily_budget) return { value: i.daily_budget / 100, currency: "", per: "day" };
  if (i.lifetime_budget) return { value: i.lifetime_budget / 100, currency: "" };
  return null;
}

export const metaOAuth: OAuthSpec = {
  authorizeUrl: OAUTH_PROVIDERS.meta.authorize,
  tokenUrl: OAUTH_PROVIDERS.meta.token,
  scopes: [
    "ads_management",
    "ads_read",
    "business_management",
    "pages_show_list",
    "pages_read_engagement",
    // A Page post's likes, comments and reactions (code 10 without it).
    "pages_read_user_content",
    "pages_manage_posts",
    "pages_manage_ads",
    // Our Page's webhooks: subscribed_apps for `feed` and `messages`.
    "pages_manage_metadata",
    "pages_messaging",
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_insights",
    "instagram_manage_comments",
    // The IG inbox read (a private reply's verdict): 403 graph code 230 without it.
    "instagram_manage_messages",
    "read_insights",
    "leads_retrieval",
  ],
  scopeSeparator: ",",
  clientId: "META_CLIENT_ID",
  clientSecret: "META_CLIENT_SECRET",
  // No refresh token: the long-lived user token (60 days) is kept; consent again when it lapses.
  refreshToken: "META_REFRESH_TOKEN",
  accessToken: "META_ACCESS_TOKEN",
  longLived: {
    url: OAUTH_PROVIDERS.meta.token,
    fields: { grant_type: "fb_exchange_token" },
    tokenParam: "fb_exchange_token",
    clientIdParam: "client_id",
  },
  identity: { url: v("me?fields=name"), field: "name" },
  redirect: WEB_REDIRECT,
  consent: { flow: "facebook/oauth-consent" },
};

export const meta: SiteApi = {
  site: "meta",
  blockers: { "meta-app": META_APP },
  origin: META_ORIGIN,
  probe: { path: "/me" },
  auth: { oauth: metaOAuth },
  // Each Instagram read is one `business_discovery` call; Meta throttles by app usage.
  // Graph lets 100 Instagram posts a day; the rest are wren's own bounds, under Meta's spam flags.
  caps: { reads: 300, publish: 10, igPublish: 10, reply: 30, message: 50 },
  // The app, the Page and the ad account live on Wren's own Facebook (the default
  // account, william@): only the card on the ad account is the person's.
  routes: [
    route({
      method: "GET",
      path: "/me",
      summary: "Who the token is",
      request: me,
      api: (q, leg) => get(leg, "me", q),
    }),
    route({
      method: "GET",
      path: "/me/permissions",
      summary: "Each scope the consent asked for: granted or declined",
      request: z.object({}),
      api: (_q, leg) => get(leg, "me/permissions", {}),
    }),
    route({
      method: "GET",
      path: "/me/adaccounts",
      summary:
        "The ad accounts the person can use (`id` is `act_<number>`; routes take the number)",
      request: adAccounts,
      api: (q, leg) => get(leg, "me/adaccounts", q),
    }),
    route({
      method: "GET",
      path: "/me/accounts",
      summary: "The Pages the person admins, each with its Instagram professional account id",
      request: pages,
      // Changes when a Page is added; 747 reads in Nov, most within the hour.
      ttl: 3600,
      api: (q, leg) => get(leg, "me/accounts", q),
    }),
    route({
      method: "GET",
      path: "/instagram/tags/{tag}",
      summary:
        "Public Instagram posts on a hashtag (`edge` recent_media: last 24 h, newest first; top_media: most liked; `limit` up to 50, `after`): `{ tag, id, data, next }`. Graph caps 30 distinct hashtags a week per account. Meta refuses it (code 10) until its Instagram Public Content Access review passes",
      request: igHashtag,
      meter: () => ({ reads: 1 }),
      api: async (q, leg) => {
        const { tag, edge, limit, after } = resolve(INSTAGRAM_TAGS, q) as typeof q & {
          edge: string;
        };
        const user_id = await igUserOf(leg);
        const found = (await get(leg, "ig_hashtag_search", { user_id, q: tag })) as {
          data?: { id: string }[];
        };
        const id = found.data?.[0]?.id;
        if (!id) return { tag, id: null, data: [], next: null };
        const page = (await get(leg, `${id}/${edge}`, {
          user_id,
          fields: IG_MEDIA,
          limit,
          after,
        })) as { data?: unknown[]; paging?: { cursors?: { after?: string }; next?: string } };
        return {
          tag,
          id,
          data: page.data ?? [],
          next: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
        };
      },
    }),
    route({
      method: "GET",
      path: "/instagram/{username}",
      summary:
        "Another business or creator Instagram account by username (`business_discovery`, read as ours): `{ found: true, profile, media, next }` with the bio, site, counts and a page of posts, newest first (`limit`, default 25, max 50; `after` = a previous `next` for the page after, `next` null at the first post), or `{ found: false, reason }` for an unknown name or a personal account. A Graph rate limit is a 429",
      request: igLookup,
      meter: () => ({ reads: 1 }),
      api: (q, leg) => igDiscover(leg, q),
    }),
    route({
      method: "GET",
      path: "/instagram/{username}/reels",
      summary:
        "Every reel of a business or creator account (`business_discovery` paged to the first post): `{ found: true, profile, urls, reels, scanned, pages }`, each reel's whole Graph item kept, newest first (`max` posts read, default 1000); `{ found: false, reason }` for a personal account: then `instagram GET /web/{username}/reels`. A Graph rate limit is a 429",
      request: igReels,
      meter: ({ max }) => ({ reads: Math.ceil(max / IG_PAGE) }),
      used: (_q, out) => ({ reads: Math.max(1, (out as { pages?: number }).pages ?? 1) }),
      api: (q, leg) => igAllReels(leg, q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/campaigns",
      summary: "Campaigns on an ad account (`fields`, `limit`, `after`)",
      request: listIn,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/campaigns`, q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}",
      summary: "The ad account: status, lifetime spend (`amount_spent`, minor units), created",
      request: accountFields,
      api: ({ adAccountId, fields }, leg) => get(leg, `act_${adAccountId}`, { fields }),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/adsets",
      summary:
        "Ad sets on an ad account: goal, budget, learning stage (`fields`, `limit`, `after`)",
      request: adsetsIn,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/adsets`, q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/ads",
      summary: "Ads on an ad account with their creative's type and URL tags",
      request: adsIn,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/ads`, q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/adspixels",
      summary: "Pixels on an ad account: created, last fired",
      request: pixelsIn,
      api: ({ adAccountId, ...q }, leg) => get(leg, `act_${adAccountId}/adspixels`, q),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/campaigns",
      summary: "A campaign (PAUSED unless said; ACTIVE with a budget spends)",
      request: campaign,
      spends: (i) => budgetOf(i),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/campaigns`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adsets",
      summary: "An ad set: budget, schedule, targeting, optimization (PAUSED unless said)",
      request: adset,
      spends: (i) => budgetOf(i),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adsets`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adimages",
      summary: "An ad image from a URL or base64 bytes; answers its hash for a creative",
      request: adimage,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adimages`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/advideos",
      summary: "An ad video from a public URL; answers its id for a creative",
      request: advideo,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/advideos`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/adcreatives",
      summary: "A creative: the Page post the ad shows (`object_story_spec`)",
      request: creative,
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/adcreatives`, body),
    }),
    route({
      method: "POST",
      path: "/act_{adAccountId}/ads",
      summary:
        "An ad: a creative in an ad set (PAUSED unless said; ACTIVE spends the set's budget)",
      request: ad,
      spends: (i) => (i.status === "ACTIVE" ? null : false),
      api: ({ adAccountId, ...body }, leg) => post(leg, `act_${adAccountId}/ads`, body),
    }),
    route({
      method: "POST",
      path: "/{objectId}",
      summary: "Update a campaign, ad set or ad: status (ACTIVE spends), name, budget",
      request: update,
      spends: (i) => budgetOf(i),
      api: ({ objectId, ...body }, leg) => post(leg, objectId, body),
    }),
    route({
      method: "GET",
      path: "/{objectId}",
      summary:
        "Any Graph object by id with `fields` (a post's `likes.summary(true),comments.summary(true),shares`); `pageId` reads a Page's video or photo with its token",
      request: object,
      api: async ({ objectId, fields, pageId }, leg) =>
        get(await objectLeg(leg, objectId, pageId), objectId, { fields }),
    }),
    route({
      method: "GET",
      path: "/search",
      summary: "Targeting search: interests (`type=adinterest&q=shopify`), places, job titles",
      request: search,
      api: (q, leg) => get(leg, "search", q),
    }),
    route({
      method: "GET",
      path: "/act_{adAccountId}/insights",
      summary:
        "Results by campaign/adset/ad (`fields`, `level`, `date_preset=last_7d` or `time_range`, `time_increment`)",
      request: insights,
      api: ({ adAccountId, date_preset, ...q }, leg) =>
        get(leg, `act_${adAccountId}/insights`, q.time_range ? q : { ...q, date_preset }),
    }),
    route({
      method: "GET",
      path: "/{pageId}/posts",
      summary: "A Page's posts, newest first",
      request: pagePosts,
      api: async ({ pageId, ...q }, leg) => get(await pageLeg(leg, pageId), `${pageId}/posts`, q),
    }),
    route({
      method: "GET",
      path: "/{pageId}/subscribed_apps",
      summary: "The apps whose webhooks this Page sends, and which fields",
      request: pageOnly,
      api: async ({ pageId }, leg) =>
        get(await pageLeg(leg, pageId), `${pageId}/subscribed_apps`, {}),
    }),
    route({
      method: "POST",
      path: "/{pageId}/subscribed_apps",
      summary: "Send this app the Page's webhooks (`feed,messages`); its own Page token",
      request: pageSubscription,
      api: async ({ pageId, subscribed_fields }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/subscribed_apps`, { subscribed_fields }),
    }),
    route({
      method: "GET",
      path: "/app/subscriptions",
      summary: "The app's webhook subscriptions: object, callback, fields",
      request: z.object({}),
      api: (_q, leg) => get(appLeg(leg), `${appId(leg)}/subscriptions`, {}),
    }),
    route({
      method: "POST",
      path: "/app/subscriptions",
      summary:
        "Point the app's webhooks for one object at a callback; the handshake token is META_WEBHOOK_TOKEN",
      request: appSubscription,
      api: (body, leg) => {
        const verify_token = leg.env("META_WEBHOOK_TOKEN");
        if (!verify_token)
          throw new HttpError("CALL", `${META_ORIGIN}/subscriptions`, 400, "no META_WEBHOOK_TOKEN");
        return post(appLeg(leg), `${appId(leg)}/subscriptions`, { ...body, verify_token });
      },
    }),
    route({
      method: "POST",
      path: "/{pageId}/feed",
      summary:
        "A text or link post on a Page (`published:false` + `scheduled_publish_time` schedules)",
      request: feed,
      meter: () => ({ publish: 1 }),
      irreversible: true,
      verify: {
        words: (b) => b.message,
        read: (b, look) => pagePostRows(look, b.pageId),
        lags: (b) => unlisted(b.published, b.scheduled_publish_time),
      },
      sentAs: (o) => {
        const id = str(rec(o).id);
        return { id, url: id ? fbUrl(id) : null };
      },
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/feed`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/photos",
      summary: "A photo post on a Page from a public image URL",
      request: photo,
      meter: () => ({ publish: 1 }),
      irreversible: true,
      verify: {
        words: (b) => b.message ?? "",
        read: async (b, look) => noWords(b.message) ?? (await pagePostRows(look, b.pageId)),
        lags: (b) => unlisted(b.published),
      },
      // `post_id` is the Page post; `id` is the photo.
      sentAs: (o) => {
        const id = str(rec(o).post_id) ?? str(rec(o).id);
        return { id, url: id ? fbUrl(id) : null };
      },
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/photos`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/videos",
      summary: "A video (or Reel) on a Page from a public video URL",
      request: video,
      meter: () => ({ publish: 1 }),
      irreversible: true,
      verify: {
        words: (b) => b.description ?? b.title ?? "",
        read: async (b, look) =>
          noWords(b.description ?? b.title) ?? (await pagePostRows(look, b.pageId)),
        lags: () => "Facebook lists a video post only once it is processed",
      },
      sentAs: (o) => {
        const id = str(rec(o).id);
        return { id, url: id ? `https://www.facebook.com/watch/?v=${id}` : null };
      },
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/videos`, body),
    }),
    route({
      method: "POST",
      path: "/{pageId}/photo_stories",
      summary:
        "A photo story on a Page from a public image URL: the photo goes up unpublished, then the story; answers {post_id}",
      request: photoStory,
      meter: () => ({ publish: 1 }),
      irreversible: true,
      verify: {
        none: "a story is not in the Page's posts, and no read route lists a Page's stories",
      },
      sentAs: (o) => ({ id: str(rec(o).post_id), url: null }),
      api: async ({ pageId, url }, leg) => {
        const page = await pageLeg(leg, pageId);
        const photo = (await post(page, `${pageId}/photos`, { url, published: false })) as {
          id?: string;
        };
        if (!photo.id)
          throw new HttpError("CALL", `${META_ORIGIN}/${pageId}/photos`, 502, "no photo id");
        return post(page, `${pageId}/photo_stories`, { photo_id: photo.id });
      },
    }),
    route({
      method: "POST",
      path: "/{pageId}/video_stories",
      summary:
        "A video story on a Page from a public video URL (9:16, 3 to 90 s): start, hosted upload, finish; answers {post_id}",
      request: videoStory,
      meter: () => ({ publish: 1 }),
      irreversible: true,
      verify: {
        none: "a story is not in the Page's posts, and no read route lists a Page's stories",
      },
      sentAs: (o) => ({ id: str(rec(o).post_id), url: null }),
      api: async ({ pageId, file_url }, leg) => {
        const page = await pageLeg(leg, pageId);
        const start = (await post(page, `${pageId}/video_stories`, {
          upload_phase: "start",
        })) as { video_id?: string };
        if (!start.video_id)
          throw new HttpError("CALL", `${META_ORIGIN}/${pageId}/video_stories`, 502, "no video id");
        const up = `https://rupload.facebook.com/video-upload/${META_VERSION}/${start.video_id}`;
        await must(
          await page.http.json<unknown>(up, {
            method: "POST",
            headers: { authorization: `OAuth ${page.token}`, file_url },
          }),
          "video-upload",
        );
        return post(page, `${pageId}/video_stories`, {
          upload_phase: "finish",
          video_id: start.video_id,
        });
      },
    }),
    route({
      method: "POST",
      path: "/{pageId}/leadgen_forms",
      summary:
        "An instant form on the Page (questions + privacy policy); an ad's CTA points at its id",
      request: leadForm,
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/leadgen_forms`, body),
    }),
    route({
      method: "GET",
      path: "/{pageId}/leadgen_forms",
      summary: "The Page's instant forms with their lead counts",
      request: leadForms,
      api: async ({ pageId, ...q }, leg) =>
        get(await pageLeg(leg, pageId), `${pageId}/leadgen_forms`, q),
    }),
    route({
      method: "GET",
      path: "/{formId}/leads",
      summary:
        "Leads a form collected (`field_data` = the answers); needs leads_retrieval + the Page token",
      request: leads,
      api: async ({ formId, ...q }, leg) => {
        const form = (await get(leg, formId, { fields: "page" })) as { page?: { id?: string } };
        const pageId = form.page?.id;
        if (!pageId)
          throw new HttpError("CALL", `${META_ORIGIN}/${formId}`, 404, "no page on form");
        return get(await pageLeg(leg, pageId), `${formId}/leads`, q);
      },
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media",
      summary:
        "An Instagram media container for the Page's professional account (step 1): media by public URL, or a video by `video_file` (a path or URL, sent by resumable upload)",
      request: igContainerOrFile,
      api: async ({ igUserId, video_file, ...body }, leg) => {
        if (!video_file) return post(leg, `${igUserId}/media`, body);
        const made = (await post(leg, `${igUserId}/media`, {
          media_type: "REELS",
          ...body,
          upload_type: "resumable",
        })) as { id?: string };
        if (!made.id)
          throw new HttpError("CALL", `${META_ORIGIN}/${igUserId}/media`, 502, "no container id");
        await rupload(leg, made.id, video_file);
        return { id: made.id };
      },
    }),
    route({
      method: "POST",
      path: "/{igUserId}/media_publish",
      summary: "Publish an Instagram container (step 2); answers the media id",
      request: igPublish,
      meter: () => ({ igPublish: 1 }),
      irreversible: true,
      verify: {
        // The container says whether it was published: a state, not words.
        words: () => "",
        read: async (b, look): Promise<Seen> => {
          const status = text(
            rec(await look(`/${b.creation_id}`, { fields: "status_code" })).status_code,
          );
          if (status === "PUBLISHED") return { seen: "found", id: null, url: null, at: null };
          // Never published, and never will be: its time is out or it failed.
          if (status === "ERROR" || status === "EXPIRED") return { seen: "absent" };
          // Ready or still processing: the publish may yet land.
          return unclear(`the container is ${status || "in an unknown state"}`);
        },
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      api: ({ igUserId, creation_id }, leg) =>
        post(leg, `${igUserId}/media_publish`, { creation_id }),
    }),
    route({
      method: "GET",
      path: "/{igUserId}/media",
      summary: "The Instagram account's posts, newest first",
      request: igMedia,
      api: ({ igUserId, ...q }, leg) => get(leg, `${igUserId}/media`, q),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/insights",
      summary: "An Instagram post's metrics (`metric=reach,saved,likes,comments,shares,views`)",
      request: igInsights,
      api: ({ mediaId, metric }, leg) => get(leg, `${mediaId}/insights`, { metric }),
    }),
    route({
      method: "GET",
      path: "/{mediaId}/comments",
      summary: "Comments on an Instagram post or a Facebook Page post (`<pageId>_<n>`)",
      request: igComments,
      // a Page post reads with the Page's token (code 190 with the user's)
      api: async ({ mediaId, ...q }, leg) =>
        get(await objectLeg(leg, mediaId), `${mediaId}/comments`, q),
    }),
    route({
      method: "POST",
      path: "/{commentId}/replies",
      summary: "Reply to an Instagram comment",
      request: igReply,
      meter: () => ({ reply: 1 }),
      irreversible: true,
      verify: {
        none: "Graph names a replier by username and the input holds no account to tell our reply from another's",
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      api: ({ commentId, message }, leg) => post(leg, `${commentId}/replies`, { message }),
    }),
    route({
      method: "POST",
      path: "/{commentId}/comments",
      summary: "The Page's reply under a Facebook comment",
      request: pageReply,
      meter: () => ({ reply: 1 }),
      irreversible: true,
      verify: {
        words: (b) => b.message,
        read: async (b, look): Promise<VerifyRead> => {
          const r = await look(`/${b.commentId}/comments`, {
            fields: "id,message,from{id},created_time",
            limit: 100,
          });
          return {
            rows: arr(rec(r).data).map((e) => {
              const c = rec(e);
              return {
                words: text(c.message),
                at: isoOf(c.created_time),
                id: str(c.id),
                url: null,
                mine: text(rec(c.from).id) === b.pageId,
              };
            }),
            // Replies come in the edge's own order; only a read to the end proves absent.
            order: "ranked",
            complete: !hasNext(r),
          };
        },
      },
      sentAs: (o) => ({ id: str(rec(o).id), url: null }),
      // Not asked in the consent yet: it needs App Review, which waits on Business Verification.
      needs: ["pages_manage_engagement"],
      api: async ({ pageId, commentId, message }, leg) =>
        post(await pageLeg(leg, pageId), `${commentId}/comments`, { message }),
    }),
    route({
      method: "GET",
      path: "/{pageId}/conversations",
      summary:
        "The Page's conversations (Messenger, or `platform=instagram`), newest first, each with its last messages (`from`, `created_time`); the Page's own token, so `pages_messaging` is enough",
      request: conversations,
      // A read: the Page's own inbox. No `needs`: Standard Access reads the app's own Pages.
      api: async ({ pageId, ...q }, leg) =>
        get(await pageLeg(leg, pageId), `${pageId}/conversations`, q),
    }),
    route({
      method: "POST",
      path: "/{pageId}/messages",
      summary:
        "A DM from the Page (Send API): to someone who wrote first, or a comment's Private Reply",
      request: pageMessage,
      meter: () => ({ message: 1 }),
      irreversible: true,
      verify: {
        words: (b) => ("text" in b.message ? b.message.text : b.message.attachment.payload.text),
        read: async (b, look): Promise<VerifyRead> => {
          // To a person: their one conversation (Messenger or Instagram). From a comment's
          // Private Reply: who the person is is not in the input, so the newest conversations.
          const to = "id" in b.recipient ? b.recipient.id : null;
          const reads = await Promise.allSettled(
            (["messenger", "instagram"] as const).map((platform) =>
              look(`/${b.pageId}/conversations`, {
                platform,
                limit: 25,
                ...(to ? { user_id: to } : {}),
              }),
            ),
          );
          const ok = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
          const failed = reads.find((r) => r.status === "rejected");
          if (!ok.length && failed?.status === "rejected") throw failed.reason;
          const convs = ok.flatMap((b2) => arr(rec(b2).data));
          return {
            // With the person known, any message not from them is ours. Without, only the
            // Page's own id is known, which Messenger uses and Instagram does not.
            rows: dmRows(ok, (from) => (to ? from !== to : from === b.pageId)),
            order: to ? "newest" : "ranked",
            complete:
              !!to &&
              reads.every((r) => r.status === "fulfilled") &&
              ok.every((r) => !hasNext(r)) &&
              convs.every((c) => !hasNext(rec(c).messages)),
          };
        },
      },
      sentAs: (o) => ({ id: str(rec(o).message_id), url: null }),
      // Without Advanced Access a Page messages only the app's own testers; set META_GRANTS=messaging
      // when App Review grants pages_messaging and instagram_manage_messages.
      needs: ["messaging"],
      api: async ({ pageId, ...body }, leg) =>
        post(await pageLeg(leg, pageId), `${pageId}/messages`, body),
    }),
  ],
  setup: [
    {
      name: "developer-app",
      makes: ["META_CLIENT_ID", "META_CLIENT_SECRET"],
      how: {
        workflow: "meta-developer-app",
        input: { redirectUri: WEB_REDIRECT },
      },
      summary:
        "On developers.facebook.com: a Business app with Facebook Login for Business, Marketing API and Instagram products, the redirect URI; keep the app id and secret",
    },
    {
      name: "consent",
      makes: ["META_ACCESS_TOKEN"],
      needs: ["META_CLIENT_ID", "META_CLIENT_SECRET"],
      how: { oauth: metaOAuth },
      summary:
        "Consent once as the person who admins the Page and the ad account; the 60-day long-lived token is kept (run again when it lapses)",
    },
  ],
};
