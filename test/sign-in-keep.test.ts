import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialInput } from "credvault";
import { describe, expect, it } from "vitest";
import { startExplore } from "../src/explore/server.js";
import {
  applyKeep,
  askLine,
  isNameField,
  isPasswordField,
  type KeepStore,
  planKeep,
  signInHolder,
  siteFor,
} from "../src/explore/sign-in-keep.js";
import { buildDraft, draftsDirOf, dropDraft, findDraft, listDrafts } from "../src/walks/drafts.js";

const hint = (
  o: Partial<{ name: string; id: string; placeholder: string; inputType: string }>,
) => ({
  name: o.name ?? null,
  id: o.id ?? null,
  placeholder: o.placeholder ?? null,
  inputType: o.inputType ?? null,
});

/** The credential store in memory, as `creds` keeps it. */
function memStore(seed: Record<string, Partial<Credential>> = {}) {
  const m = new Map<string, Credential>(
    Object.entries(seed).map(([k, v]) => [k, { passkeys: [], ...v } as Credential]),
  );
  const store: KeepStore & { m: typeof m } = {
    m,
    get: async (s) => m.get(s) ?? null,
    put: async (s, c: CredentialInput) => {
      m.set(s, { passkeys: [], ...c } as Credential);
    },
    list: async () => [...m.keys()],
  };
  return store;
}

describe("sign-in fields", () => {
  it("tells a password from a code and a name field", () => {
    expect(isPasswordField(hint({ inputType: "password" }))).toBe(true);
    expect(isPasswordField(hint({ name: "Password" }))).toBe(true);
    expect(isPasswordField(hint({ inputType: "password", name: "Verification code" }))).toBe(false);
    expect(isNameField(hint({ inputType: "email" }))).toBe(true);
    expect(isNameField(hint({ name: "Phone number, username, or email" }))).toBe(true);
    expect(isNameField(hint({ name: "Search" }))).toBe(false);
    expect(isNameField(hint({ inputType: "checkbox", name: "Remember login" }))).toBe(false);
    expect(siteFor("instagram.com")).toBe("instagram");
    expect(siteFor("google.com")).toBe("google");
  });
});

describe("signInHolder", () => {
  it("pairs a name and a password across two pages; nothing is taken before the submit", () => {
    const h = signInHolder();
    expect(
      h.typed(hint({ inputType: "email" }), "ada@site.test", "https://accounts.site.test/a"),
    ).toBe(false);
    expect(h.typed(hint({ inputType: "password" }), "pw1", "https://www.site.test/b")).toBe(false);
    expect(h.take()).toBeNull();
    expect(h.acted()).toBe(true);
    expect(h.acted()).toBe(false);
    expect(h.take()).toEqual({ host: "site.test", username: "ada@site.test", password: "pw1" });
    expect(h.take()).toBeNull();
  });

  it("a retyped password replaces the held one; a form still shown disarms", () => {
    const h = signInHolder();
    h.typed(hint({ name: "username" }), "ada", "https://x.test/");
    h.typed(hint({ inputType: "password" }), "wrong", "https://x.test/");
    h.acted();
    h.disarm();
    h.typed(hint({ inputType: "password" }), "right", "https://x.test/");
    h.acted();
    expect(h.take()?.password).toBe("right");
  });

  it("asks the page for a name the site filled; a no is kept for the session", () => {
    const h = signInHolder();
    expect(h.typed(hint({ inputType: "password" }), "pw", "https://x.test/")).toBe(true);
    h.named("https://x.test/", " ada ");
    h.acted();
    const got = h.take();
    expect(got?.username).toBe("ada");
    h.decline("x.test");
    h.typed(hint({ inputType: "password" }), "pw", "https://x.test/");
    expect(h.acted()).toBe(false);
  });
});

describe("planKeep", () => {
  const held = { host: "instagram.com", username: "W.Jin1", password: "pw" };
  const today = "2026-11-11";

  it("a new account goes under site@label", async () => {
    const s = memStore();
    const plan = await planKeep(s, "instagram", held, today);
    expect(plan).toEqual({ name: "instagram@w.jin1", outcome: "new" });
    await applyKeep(s, plan, held);
    expect(s.m.get("instagram@w.jin1")).toMatchObject({ username: "W.Jin1", password: "pw" });
    expect(askLine(plan)).toBe("Keep this sign-in for instagram@w.jin1?");
  });

  it("the same password stored is left; a different one goes under a dated name", async () => {
    const s = memStore({ "instagram@main": { username: "w.jin1", password: "pw" } });
    expect(await planKeep(s, "instagram", held, today)).toEqual({
      name: "instagram@main",
      outcome: "same",
    });
    const other = { ...held, password: "new" };
    const plan = await planKeep(s, "instagram", other, today);
    expect(plan).toEqual({ name: "instagram@main-2026-11-11", outcome: "dated" });
    await applyKeep(s, plan, other);
    expect(s.m.get("instagram@main")?.password).toBe("pw");
    expect(s.m.get("instagram@main-2026-11-11")?.password).toBe("new");
    // a second change the same day: never over the first
    expect((await planKeep(s, "instagram", { ...held, password: "third" }, today)).name).toBe(
      "instagram@main-2026-11-11-2",
    );
    expect(askLine(plan)).toContain("instagram@main has another password");
  });

  it("an account with no password (a provider's button) gets it and keeps its other ways in", async () => {
    const s = memStore({ github: { username: "ada@site.test", via: "google" } });
    const h = { host: "github.com", username: "ada@site.test", password: "pw" };
    const plan = await planKeep(s, "github", h, today);
    expect(plan).toEqual({ name: "github", outcome: "added" });
    await applyKeep(s, plan, h);
    expect(s.m.get("github")).toMatchObject({ via: "google", password: "pw" });
  });

  it("another address with the same local part gets the whole address as its label", async () => {
    const s = memStore({ "x@ada": { username: "ada@one.test", password: "a" } });
    const plan = await planKeep(
      s,
      "x",
      { host: "x.com", username: "ada@two.test", password: "b" },
      today,
    );
    expect(plan).toEqual({ name: "x@ada-two.test", outcome: "new" });
  });
});

describe("hand sign-in and teach on by default, end to end", () => {
  const server = createServer((q, r) => {
    const u = new URL(q.url ?? "/", "http://x");
    const page = (body: string) =>
      r
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><title>t</title>${body}`);
    if (u.pathname === "/home") return page("<h1>Welcome back</h1><p>Signed in.</p>");
    return page(
      `<h1>Sign in</h1><form method="post" action="/home"><label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" name="password" type="password"><button>Log in</button></form>`,
    );
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const type = (id: string, v: string) =>
    `const i = document.getElementById('${id}'); i.focus(); i.value = '${v}'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true}));`;
  const byHand = (steps: string[]) =>
    steps.map((js, i) => `setTimeout(() => { ${js} }, ${1000 + i * 700});`).join("\n");

  it("holds the typed sign-in out of the journal, keeps it on a yes, and drafts a walk from the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-signin-"));
    const runs = join(dir, "runs");
    const walks = join(dir, "walks");
    const store = memStore();
    const handRuns: Array<{ run: string; acts: number; outcome: string }> = [];
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
    try {
      const ex = await startExplore({
        site: "localhost",
        port: 9800 + Math.floor(Math.random() * 150),
        recordingsDir: join(dir, "recordings"),
        runs,
        credentials: store,
        onHandRun: (r) => handRuns.push(r),
        browser: {
          tier: "local",
          channel: "chromium",
          profilesDir: join(dir, "profiles"),
          artifactsDir: join(dir, "artifacts"),
          headless: true,
        },
      });
      try {
        await ex.exec({ cmd: "open", url });
        await ex.exec({
          cmd: "eval",
          js: byHand([
            type("u", "ada"),
            // spelled backwards: the eval text in the journal must not hold it either
            `const p = document.getElementById('p'); p.focus(); p.value = 'wp-terc3s'.split('').reverse().join(''); p.dispatchEvent(new Event('input', {bubbles: true})); p.dispatchEvent(new Event('change', {bubbles: true}));`,
            "document.querySelector('button').click();",
          ]),
        });
        await sleep(8_000);
        // headless: no panel to ask on, so it waits for a terminal; never the value
        expect(await ex.heldSignIns()).toEqual([{ name: "localhost@ada", outcome: "new" }]);
        expect(await ex.keepSignIn("localhost@ada")).toBe(true);
        expect(await ex.heldSignIns()).toEqual([]);
      } finally {
        await ex.exec({ cmd: "close" }).catch(() => undefined);
        await ex.done;
      }
      expect(store.m.get("localhost@ada")).toMatchObject({
        username: "ada",
        password: "s3cret-pw",
      });
      // the password is in no file explore wrote
      const files = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
        );
      for (const f of files(dir).filter((f) => /\.(jsonl?|txt|md)$/.test(f)))
        expect(readFileSync(f, "utf8")).not.toContain("s3cret-pw");

      expect(handRuns).toHaveLength(1);
      expect(handRuns[0]?.acts).toBeGreaterThan(0);
      const d = buildDraft(runs, walks, { site: "localhost", run: handRuns[0]?.run as string });
      expect(d?.spec.secrets.length).toBeGreaterThan(0);
      expect(d?.file.startsWith(draftsDirOf(walks))).toBe(true);
      const listed = listDrafts(walks);
      expect(listed).toHaveLength(1);
      expect(findDraft(walks, `localhost/${listed[0]?.name}`)?.run).toBe(handRuns[0]?.run);
      dropDraft(walks, listed[0] as { site: string; name: string });
      expect(listDrafts(walks)).toEqual([]);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
