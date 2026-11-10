/** One Instagram media container body: the Graph host (`meta`) and the Instagram-login host (`instagram`) take the same fields. */
import { z } from "zod";

const id = z.string().regex(/^[0-9]+$/, "a numeric Instagram id");

export const igContainer = z.object({
  igUserId: id,
  image_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  media_type: z.enum(["IMAGE", "REELS", "STORIES", "CAROUSEL"]).optional(),
  caption: z.string().max(2200).optional(),
  children: z.array(id).optional(),
  is_carousel_item: z.boolean().optional(),
  cover_url: z.string().url().optional(),
  share_to_feed: z.boolean().optional(),
  /** A Reel's cover frame, in ms from the start (ignored when `cover_url` is set). */
  thumb_offset: z.number().int().min(0).optional(),
  /** Up to three accounts invited as collaborators. */
  collaborators: z
    .array(z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "an Instagram username"))
    .min(1)
    .max(3)
    .optional(),
  /** A Reel's audio name (only for original audio). */
  audio_name: z.string().min(1).optional(),
  /** Trial Reel (REELS only): non-followers see it first. MANUAL = graduate in the app; SS_PERFORMANCE = Instagram graduates it if it performs. */
  trial_params: z.object({ graduation_strategy: z.enum(["MANUAL", "SS_PERFORMANCE"]) }).optional(),
});
