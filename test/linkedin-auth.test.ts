import { describe, expect, it } from "vitest";
import { linkedinOauthConsent } from "../src/browser/flows/linkedin-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { linkedinOAuth } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;

describe("linkedin/oauth-consent", () => {
  const authorize =
    "https://www.linkedin.com/oauth/v2/authorization?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";

  it("is the site's consent leg and a catalogued flow", () => {
    expect(linkedinOAuth.consent).toEqual({ flow: "linkedin/oauth-consent" });
    expect(BROWSER_FLOWS["linkedin/oauth-consent"]).toBe(linkedinOauthConsent);
  });

  it("opens the feed, then the authorize URL, presses Allow and lands", async () => {
    let url = "https://www.linkedin.com/feed/";
    const opened: string[] = [];
    const { fp, acts } = fakePage({
      text: ["new-tool would like to access some of your LinkedIn info"],
      present: (h) => /allow/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      opened.push(u);
      url = u;
    };
    const out = await linkedinOauthConsent.run(fp, { url: authorize });
    expect(opened).toEqual(["https://www.linkedin.com/feed/", authorize]);
    expect(acts.map(line)).toEqual(["click /^(allow|continue)$/i"]);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9876\/cb\?code=abc/);
  });

  it("re-opens the authorize URL without allowWall when LinkedIn shows its login under it", async () => {
    let url = "https://www.linkedin.com/feed/";
    const opens: Array<{ url: string; allowWall: boolean }> = [];
    const { fp } = fakePage({
      text: ["new-tool would like to access"],
      present: (h) => /allow/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u, o) => {
      opens.push({ url: u, allowWall: Boolean(o?.allowWall) });
      // The first authorize open lands on the login page; the runner's sign-in (second open) does not.
      url = opens.length === 2 ? "https://www.linkedin.com/uas/login?session_redirect=x" : u;
    };
    await linkedinOauthConsent.run(fp, { url: authorize });
    expect(opens.map((o) => o.allowWall)).toEqual([false, true, false]);
  });

  it("hands a refusal to a person", async () => {
    const { fp } = fakePage({
      text: ["Bummer, something went wrong: invalid redirect_uri"],
      present: () => false,
      url: authorize,
    });
    fp.open = async () => {};
    await expect(linkedinOauthConsent.run(fp, { url: authorize })).rejects.toThrow(/refused/);
  });
});
