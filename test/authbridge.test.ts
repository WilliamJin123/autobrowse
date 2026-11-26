/**
 * authbridge (designs/2026-11-25-authbridge.md): the save rules over a folder store with a fake
 * context, and one real cold profile saved and restored into a fresh one on a local origin.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aesGcmCipher } from "credvault";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { misfits, platformHere } from "../src/app/cli-authbridge.js";
import { machineName } from "../src/app/services-authbridge.js";
import { HeldElsewhere, signInBridge } from "../src/authbridge/bridge.js";
import {
  applySnapshot,
  type BrowserState,
  openSnapshot,
  sealSnapshot,
  signedOut,
  storedOrigins,
  takeSnapshot,
} from "../src/authbridge/snapshot.js";
import { dirSnapshotStore, PointerMoved } from "../src/authbridge/store.js";

const cipher = aesGcmCipher(Buffer.alloc(32, 7));
const tmp = () => mkdtempSync(join(tmpdir(), "authbridge-"));

const cookie = (name: string, domain: string): BrowserState["cookies"][number] => ({
  name,
  value: "v",
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});

/** Enough of a BrowserContext for a save: its state and one open page. */
function fakeContext(cookies: BrowserState["cookies"]) {
  const page = {
    isClosed: () => false,
    evaluate: async () => ({ userAgent: "UA", platform: "MacIntel" }),
  };
  return {
    storageState: async () => ({ cookies, origins: [] }),
    pages: () => [page],
    newPage: async () => page,
  } as never;
}

function bridgeOn(dir: string, machine: string, now = () => new Date("2026-11-25T12:00:00Z")) {
  const lines: string[] = [];
  const bridge = signInBridge({
    store: dirSnapshotStore(join(dir, "store")),
    cipher: async () => cipher,
    machine,
    exitFor: () => null,
    indexFile: join(dir, `${machine}.json`),
    log: (l) => lines.push(l),
    now,
  });
  return { bridge, lines };
}

describe("authbridge save rules", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const fresh = () => {
    const d = tmp();
    dirs.push(d);
    return d;
  };

  it("saves, seals and loads back; the saver holds the profile", async () => {
    const dir = fresh();
    const { bridge } = bridgeOn(dir, "mac");
    const r = await bridge.save("github@me", fakeContext([cookie("user_session", "github.com")]), {
      why: "cli",
    });
    expect(r.saved).toBe(true);
    const [p] = await bridge.list();
    expect(p).toMatchObject({
      profile: "github@me",
      holder: "mac",
      cookies: 1,
      platform: "MacIntel",
    });
    const snap = await bridge.load("github@me");
    expect(snap?.state.cookies[0]?.name).toBe("user_session");
  });

  it("refuses a save from a machine that does not hold the profile, until a take", async () => {
    const dir = fresh();
    const mac = bridgeOn(dir, "mac").bridge;
    const box = bridgeOn(dir, "box").bridge;
    const ctx = fakeContext([cookie("user_session", "github.com")]);
    await mac.save("github@me", ctx, { why: "cli" });
    await expect(box.save("github@me", ctx, { why: "cli" })).rejects.toBeInstanceOf(HeldElsewhere);
    await box.take("github@me");
    expect((await box.save("github@me", ctx, { why: "cli" })).saved).toBe(true);
    await expect(mac.save("github@me", ctx, { why: "cli" })).rejects.toBeInstanceOf(HeldElsewhere);
  });

  it("a pointer write with a stale tag loses", async () => {
    const store = dirSnapshotStore(join(fresh(), "store"));
    const meta = { profile: "a", version: "1", holder: "mac" } as never;
    await store.setPointer("a", meta, null);
    await expect(store.setPointer("a", meta, null)).rejects.toBeInstanceOf(PointerMoved);
  });

  it("never makes a signed-out state the newest, unless forced", async () => {
    const dir = fresh();
    const { bridge } = bridgeOn(dir, "mac");
    const out = fakeContext([cookie("_gh_sess", "github.com")]);
    expect(await bridge.save("github@me", out, { why: "cli" })).toEqual({
      saved: false,
      reason: "signed-out",
    });
    expect((await bridge.save("github@me", out, { why: "cli", force: true })).saved).toBe(true);
  });

  it("runner: saves after a sign-in, refreshes daily only where it can prove a sign-in", async () => {
    const dir = fresh();
    let at = new Date("2026-11-25T12:00:00Z");
    const { bridge } = bridgeOn(dir, "mac", () => at);
    // no session-cookie table for this site: a refresh cannot tell in from out
    await bridge.afterRun("acme@me", fakeContext([cookie("s", "acme.test")]), false);
    expect(await bridge.list()).toEqual([]);
    await bridge.afterRun("acme@me", fakeContext([cookie("s", "acme.test")]), true);
    expect((await bridge.list()).map((p) => p.why)).toEqual(["sign-in"]);

    const gh = fakeContext([cookie("user_session", "github.com")]);
    await bridge.afterRun("github@me", gh, false);
    expect((await bridge.list("github@me"))[0]?.why).toBe("first");
    at = new Date("2026-11-25T13:00:00Z");
    expect(bridge.due("github@me", false)).toBe(false);
    expect(bridge.due("github@me", true)).toBe(true);
    at = new Date("2026-11-26T13:00:00Z");
    await bridge.afterRun("github@me", gh, false);
    expect((await bridge.list("github@me"))[0]?.versions).toHaveLength(2);
  });

  it("a held profile never fails the run: logged and checked", async () => {
    const dir = fresh();
    const gh = fakeContext([cookie("user_session", "github.com")]);
    await bridgeOn(dir, "mac").bridge.save("github@me", gh, { why: "cli" });
    const box = bridgeOn(dir, "box");
    await box.bridge.afterRun("github@me", gh, true);
    expect(box.lines.join("\n")).toMatch(/held by mac/);
  });
});

describe("authbridge restore checks", () => {
  const meta = { platform: "MacIntel", exit: null, machine: "mac" };
  it("a direct line matches only on the machine that saved it", () => {
    expect(misfits(meta, { platform: "MacIntel", exit: null, machine: "mac" })).toEqual([]);
    expect(misfits(meta, { platform: "MacIntel", exit: null, machine: "box" })).toHaveLength(1);
    expect(misfits(meta, { platform: "Linux x86_64", exit: "us", machine: "box" })).toHaveLength(2);
    expect(
      misfits({ ...meta, exit: "us" }, { platform: "MacIntel", exit: "us", machine: "box" }),
    ).toEqual([]);
  });

  it("names Chrome's platform per OS", () => {
    expect(platformHere("darwin")).toBe("MacIntel");
    expect(platformHere("linux")).toBe("Linux x86_64");
  });

  it("the holder name comes from AUTOBROWSE_MACHINE first", () => {
    expect(machineName({ AUTOBROWSE_MACHINE: " box-1 " })).toBe("box-1");
  });

  it("tells signed out by the site's session cookies; unknown sites are never 'out'", () => {
    expect(signedOut("github@me", { cookies: [cookie("x", "github.com")], origins: [] })).toBe(
      true,
    );
    expect(signedOut("acme@me", { cookies: [], origins: [] })).toBe(false);
  });
});

describe("authbridge on a real profile", () => {
  let server: Server;
  let origin: string;
  const dirs: string[] = [];
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><body>ok</body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("saves a cold profile's cookie, localStorage and IndexedDB and restores them into a new one", async () => {
    const a = tmp();
    const b = tmp();
    dirs.push(a, b);
    const seed = await chromium.launchPersistentContext(a, { headless: true });
    try {
      const page = seed.pages()[0] ?? (await seed.newPage());
      await page.goto(origin);
      await seed.addCookies([
        { name: "sid", value: "sid_seed_s1", url: origin, expires: 4102444800 },
      ]);
      // page code as text: the test project has no DOM types
      await page.evaluate(`(async () => {
        localStorage.setItem("token", "tok_seed_t1");
        await new Promise((ok, no) => {
          const req = indexedDB.open("app", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("kv");
          req.onsuccess = () => {
            const tx = req.result.transaction("kv", "readwrite");
            tx.objectStore("kv").put("idb_seed_i1", "key");
            tx.oncomplete = () => ok();
            tx.onerror = () => no(tx.error);
          };
          req.onerror = () => no(req.error);
        });
      })()`);
    } finally {
      await seed.close();
    }

    expect(storedOrigins(a)).toContain(origin);
    const cold = await chromium.launchPersistentContext(a, { headless: true });
    let sealed: string;
    try {
      const snap = await takeSnapshot(cold, {
        profile: "local@me",
        machine: "mac",
        exit: null,
        why: "cli",
        visit: storedOrigins(a),
      });
      expect(snap.meta.origins).toContain(origin);
      sealed = sealSnapshot(snap, cipher);
    } finally {
      await cold.close();
    }
    // `_` is outside base64 and the envelope: a hit is a leak, never chance
    for (const plain of ["sid_seed_s1", "tok_seed_t1", "idb_seed_i1"])
      expect(sealed).not.toContain(plain);

    const into = await chromium.launchPersistentContext(b, { headless: true });
    try {
      await applySnapshot(into, openSnapshot(sealed, cipher));
      const page = into.pages()[0] ?? (await into.newPage());
      await page.goto(origin);
      const got = await page.evaluate(`(async () => ({
        cookie: document.cookie,
        token: localStorage.getItem("token"),
        idb: await new Promise((ok, no) => {
          const req = indexedDB.open("app", 1);
          req.onsuccess = () => {
            const get = req.result.transaction("kv").objectStore("kv").get("key");
            get.onsuccess = () => ok(get.result);
            get.onerror = () => no(get.error);
          };
          req.onerror = () => no(req.error);
        }),
      }))()`);
      expect(got).toEqual({ cookie: "sid=sid_seed_s1", token: "tok_seed_t1", idb: "idb_seed_i1" });
    } finally {
      await into.close();
    }
  });
});
