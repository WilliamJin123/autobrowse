import * as restate from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";
import { defineFlow, FlowFailed, type FlowRunner } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";
import {
  BROWSER_CODE,
  BROWSER_FLOWS,
  browserService,
  terminalLeg,
} from "../src/engine/browser-service.js";

const flow = defineFlow<{ x: number }, string>({ site: "s", name: "f", run: async () => "ok" });

describe("browser service", () => {
  it("a person needed or a broken flow is terminal with artifacts; the rest retries", async () => {
    const human: FlowRunner = {
      run: async () => {
        const e = new NeedsHuman("s: captcha");
        e.artifacts = { screenshot: "/a.png" };
        throw e;
      },
    };
    const err = await terminalLeg(human, flow, { x: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(restate.TerminalError);
    expect((err as restate.TerminalError).code).toBe(BROWSER_CODE.needsHuman);
    expect(JSON.parse((err as Error).message)).toMatchObject({
      artifacts: { screenshot: "/a.png" },
    });
    const broken: FlowRunner = {
      run: async () => {
        throw new FlowFailed("s/f", new Error("no row"), {});
      },
    };
    expect(
      (
        (await terminalLeg(broken, flow, { x: 1 }).catch(
          (e: unknown) => e,
        )) as restate.TerminalError
      ).code,
    ).toBe(BROWSER_CODE.failed);
    const flaky: FlowRunner = {
      run: async () => {
        throw new Error("ECONNRESET");
      },
    };
    await expect(terminalLeg(flaky, flow, { x: 1 })).rejects.toThrow(/ECONNRESET/);
    await expect(terminalLeg(flaky, flow, { x: 1 })).rejects.not.toBeInstanceOf(
      restate.TerminalError,
    );
  });
  it("names the fixed legs site/name and builds the service", () => {
    expect(Object.keys(BROWSER_FLOWS).sort()).toEqual([
      "account/reset-mail-probe",
      "calcom/api-key",
      "chatgpt/ask",
      "dblp/api",
      "discord/bot-token",
      "discord/invite",
      "facebook/oauth-consent",
      "fb-public/marketplace",
      "fingerprint/check",
      "gemini/ask",
      "google-admin/dkim-generate",
      "google-admin/dkim-start",
      "google-admin/workspace-logo",
      "google-scholar/author",
      "google-scholar/search",
      "google/maps-reviews",
      "google/oauth-consent",
      "google/profile-photo",
      "google/youtube-community-post",
      "google/youtube-studio-analytics",
      "google/youtube-thumbnail",
      "hubspot/connector-keys",
      "indeed/job",
      "indeed/search",
      "instagram/comment",
      "instagram/create-post",
      "instagram/explore",
      "instagram/feed",
      "instagram/follow",
      "instagram/following",
      "instagram/like",
      "instagram/oauth-consent",
      "instagram/people",
      "instagram/post",
      "instagram/post-comments",
      "instagram/profile",
      "instagram/profile-name",
      "instagram/reels",
      "instagram/saved",
      "instagram/search",
      "instagram/threads-consent",
      "instagram/threads-follow",
      "instagram/threads-following",
      "instagram/threads-like",
      "instagram/threads-reply",
      "instagram/threads-search",
      "intuit/connector-keys",
      "jobber/connector-keys",
      "learn/quiz-attempt",
      "learn/quiz-review",
      "learn/quizzes",
      "linkedin/activity",
      "linkedin/audience",
      "linkedin/comment",
      "linkedin/company",
      "linkedin/company-jobs",
      "linkedin/company-people",
      "linkedin/company-posts",
      "linkedin/connect",
      "linkedin/connections",
      "linkedin/create-post",
      "linkedin/dashboard",
      "linkedin/developer-app",
      "linkedin/feed",
      "linkedin/follow",
      "linkedin/inbox",
      "linkedin/like",
      "linkedin/list-posts",
      "linkedin/message",
      "linkedin/notifications",
      "linkedin/oauth-consent",
      "linkedin/post",
      "linkedin/post-analytics",
      "linkedin/post-comments",
      "linkedin/post-stats",
      "linkedin/profile",
      "linkedin/relationship",
      "linkedin/search-people",
      "linkedin/search-posts",
      "linkedin/withdraw",
      "loom/delete",
      "loom/rename",
      "loom/upload",
      "npm/create-org",
      "npm/granular-token",
      "npm/trusted-publisher",
      "openreview/api",
      "outlook/oauth-consent",
      "perplexity/ask",
      "pinterest/board",
      "pinterest/search",
      "pinterest/user",
      "reddit/comment",
      "reddit/message",
      "reddit/profile-name",
      "reddit/read",
      "reddit/submit",
      "reddit/subscribe",
      "tiktok/comment",
      "tiktok/create-post",
      "tiktok/explore",
      "tiktok/follow",
      "tiktok/following",
      "tiktok/like",
      "tiktok/notifications",
      "tiktok/oauth-consent",
      "tiktok/post-comments",
      "tiktok/profile-name",
      "tiktok/search",
      "tiktok/user",
      "tiktok/video-analytics",
      "tiktok/videos",
      "upwork/job",
      "upwork/search",
      "web/google",
      "web/google-place",
      "web/proof-shot",
      "x/bookmarks",
      "x/follow",
      "x/following",
      "x/home",
      "x/like",
      "x/likes",
      "x/list-posts",
      "x/lists",
      "x/oauth-consent",
      "x/people",
      "x/post",
      "x/posts",
      "x/profile",
      "x/profile-name",
      "x/reply",
      "x/search",
      "x/thread",
      "x/trending",
      "youtube/transcript",
    ]);
    const svc = browserService({ runner: { run: async () => "ok" as never } });
    expect(svc.name).toBe("browser");
  });
});
