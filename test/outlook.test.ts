import { describe, expect, it } from "vitest";
import { outlookOauthConsent } from "../src/browser/flows/outlook-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { SITES } from "../src/sites/index.js";
import { runConsent } from "../src/sites/oauth.js";
import { outlook, outlookOAuth } from "../src/sites/outlook.js";
import { fakePage } from "./auth-fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;

describe("outlook site API", () => {
  it("is a registered site under Graph's shape whose legs are catalogued", () => {
    expect(SITES.map((s) => s.site)).toContain("outlook");
    expect(outlook.origin).toBe("https://graph.microsoft.com");
    expect(outlookOAuth.consent).toEqual({ flow: "outlook/oauth-consent" });
    expect(BROWSER_FLOWS["outlook/oauth-consent"]).toBe(outlookOauthConsent);
    expect(outlook.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /me",
      "GET /me/messages",
      "GET /me/messages/{id}",
      "POST /me/sendMail",
      "POST /me/messages/{id}/reply",
      "GET /me/events",
      "POST /me/events",
    ]);
    expect(outlook.routes.filter((r) => r.irreversible).map((r) => r.path)).toEqual([
      "/me/sendMail",
      "/me/messages/{id}/reply",
      "/me/events",
    ]);
    expect(outlook.setup.map((s) => s.name)).toEqual(["app-registration", "consent"]);
    expect(outlook.setup[1]?.needs).toEqual(["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]);
  });

  it("reads mail with OData knobs and sends with the bearer; the message id is escaped in the path", async () => {
    const calls: Array<{ method: string; url: string; auth: string; body: string }> = [];
    const http = httpClient({
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url,
          auth: String(new Headers(init?.headers).get("authorization")),
          body: String(init?.body ?? ""),
        });
        return new Response(JSON.stringify({ value: [] }), {
          status: /sendMail|reply/.test(url) ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const leg = { token: "tok", http };
    const list = outlook.routes.find((r) => r.path === "/me/messages");
    await list?.api?.({ $filter: "isRead eq false", $top: 5 }, leg);
    const read = outlook.routes.find((r) => r.path === "/me/messages/{id}");
    await read?.api?.({ id: "AAMk/1=" }, leg);
    const send = outlook.routes.find((r) => r.path === "/me/sendMail");
    const sent = await send?.api?.(
      {
        message: {
          subject: "hi",
          body: { contentType: "Text", content: "hello" },
          toRecipients: [{ emailAddress: { address: "a@b.c" } }],
        },
        saveToSentItems: true,
      },
      leg,
    );
    expect(sent).toEqual({ sent: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://graph.microsoft.com/v1.0/me/messages?%24filter=isRead+eq+false&%24top=5",
      "GET https://graph.microsoft.com/v1.0/me/messages/AAMk%2F1%3D",
      "POST https://graph.microsoft.com/v1.0/me/sendMail",
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(JSON.parse(calls[2]?.body ?? "{}").message.subject).toBe("hi");
  });

  it("walks the consent: mailbox, authorize, Accept, land", async () => {
    const authorize =
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A9400%2Foauth%2Fcallback&state=s";
    let url = "https://outlook.live.com/mail/0/";
    const opened: string[] = [];
    const { fp, acts } = fakePage({
      text: ["Permissions requested wren wants to: Read and write your mail"],
      present: (h) => /accept/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9400/oauth/callback?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      opened.push(u);
      url = u;
    };
    const out = await outlookOauthConsent.run(fp, { url: authorize });
    expect(opened).toEqual(["https://outlook.live.com/mail/0/", authorize]);
    expect(acts.map(line)).toEqual(["click /^(accept|yes|continue)$/i"]);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9400\/oauth\/callback\?code=abc/);
  });

  it("the authorize URL asks the common tenant for offline access with query response mode", async () => {
    const http = httpClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    const env: Record<string, string> = { MICROSOFT_CLIENT_ID: "c", MICROSOFT_CLIENT_SECRET: "s" };
    const out = await runConsent(outlookOAuth, {
      http,
      env: (n) => env[n],
      port: 9422,
      open: async ({ url }) => {
        const u = new URL(url);
        expect(u.origin + u.pathname).toBe(
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        );
        expect(u.searchParams.get("client_id")).toBe("c");
        expect(u.searchParams.get("response_mode")).toBe("query");
        expect(u.searchParams.get("scope")).toContain("offline_access");
        await fetch(
          `http://127.0.0.1:9422/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
        );
      },
    });
    expect(out).toMatchObject({ refreshToken: "rt", accessToken: "at", expiresIn: 3600 });
  });
});
