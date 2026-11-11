import { describe, expect, it } from "vitest";
import { banHit } from "./ban-signals.js";

describe("ban signals", () => {
  it("reads the account's own limit per site", () => {
    expect(
      banHit(
        "linkedin@wren",
        "https://www.linkedin.com/feed/",
        "Hi. We've restricted your account temporarily",
      ),
    ).toMatchObject({ site: "linkedin", kind: "restricted" });
    expect(
      banHit("x", "https://x.com/home", "Your account is suspended and is not permitted to post"),
    ).toMatchObject({ kind: "suspended" });
    expect(banHit("x", "https://x.com/account/access", "")).toMatchObject({
      kind: "restricted",
      said: "https://x.com/account/access",
    });
    expect(banHit("instagram", "https://www.instagram.com/accounts/suspended/", "")?.kind).toBe(
      "suspended",
    );
    expect(
      banHit(
        "reddit",
        "https://www.reddit.com/",
        "you're doing that too much. try again in 9 minutes",
      )?.kind,
    ).toBe("limit");
    expect(banHit("youtube", "https://www.google.com/sorry/index?continue=x", "")?.kind).toBe(
      "limit",
    );
  });

  it("another person's suspended profile is not ours; an unknown site has none", () => {
    expect(
      banHit(
        "x",
        "https://x.com/someone",
        "Account suspended. X suspends accounts that violate the X Rules",
      ),
    ).toBeNull();
    expect(
      banHit("reddit", "https://www.reddit.com/user/u", "This account has been suspended"),
    ).toBeNull();
    expect(banHit("example", "https://example.com", "your account is suspended")).toBeNull();
  });

  it("says the words around the match", () => {
    const hit = banHit(
      "tiktok",
      "https://www.tiktok.com/",
      `${"a ".repeat(100)}You are visiting too fast. Please slow down.`,
    );
    expect(hit?.said).toMatch(/^a .*visiting too fast\. Please slow down\.$/);
  });
});
