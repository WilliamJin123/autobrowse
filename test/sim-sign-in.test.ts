/**
 * Sign-ins against a simulated site in a real headless Chromium
 * (designs/2026-11-26-branching-sign-ins.md, Proof 5). Each case checks the
 * site never locked the account. The heal writer is scripted; nothing calls a model.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Credential, memoryCredentials } from "credvault";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeSource } from "../src/auth/codes.js";
import { LoginFailed, loginProvider, type SignInHealAsk } from "../src/auth/login.js";
import { fileSignInHolds } from "../src/auth/sign-in-holds.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import type { Repairer } from "../src/browser/repair.js";
import { walkLogin } from "../src/walks/login.js";
import {
  type HealProposal,
  type HealWriter,
  healSignIn,
  withHeal,
} from "../src/walks/login-heal.js";
import { type WalkSpec, walkSpecSchema } from "../src/walks/spec.js";
import { type SimSite, simSite } from "./sim-site/server.js";

const USER = { role: "textbox", name: "/username/i" };
const PASS = { role: "textbox", name: "/^password$/i" };
const LOG_IN = { role: "button", name: "/^log in$/i" };
const CODE = { role: "textbox", name: "/security code/i" };

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The sim's sign-in walk, as a repo file would write it. */
const simWalk = (origin: string): WalkSpec =>
  walkSpecSchema.parse({
    site: "sim",
    name: "login",
    goal: "signed in to sim",
    start: `${origin}/login`,
    screens: [
      { name: "feed", looks: "the feed", at: `/^${re(origin)}\\/feed/`, goal: true },
      {
        name: "rejected",
        looks: "the form says the password is wrong",
        says: "/password was incorrect/i",
        refused: { says: "password rejected", case: "password" },
      },
      {
        name: "locked",
        looks: "the account is locked",
        says: "/account is locked/i",
        refused: { says: "account locked", case: "account" },
      },
      {
        name: "login-form",
        looks: "username and password boxes",
        at: "/\\/login(\\?|$)/",
        shows: [PASS],
        ops: [
          { kind: "username", goal: "type username", field: USER },
          { kind: "password", goal: "type password", field: PASS, submit: LOG_IN },
        ],
      },
      {
        name: "code",
        looks: "a security code box",
        at: "/two_factor/",
        // a wrong code shows the box again
        once: false,
        ops: [
          {
            kind: "one-time-code",
            goal: "type the code",
            kinds: ["totp"],
            field: CODE,
            submit: { role: "button", name: "Confirm" },
            send: { role: "button", name: "Send code" },
          },
        ],
      },
    ],
  });

/** Codes in turn, each newer than the last ask. */
const codesOf = (list: string[]): CodeSource & { asked: number } => {
  const src = {
    asked: 0,
    offers: (kind: string) => kind === "totp",
    inbox: () => null,
    get: async () => list[Math.min(src.asked++, list.length - 1)] ?? null,
  };
  return src;
};

const writerOf = (p: HealProposal | null): HealWriter => ({ id: "script", propose: async () => p });

const sites: SimSite[] = [];
afterEach(async () => {
  for (const s of sites.splice(0)) await s.close();
});

async function sim(over: Parameters<typeof simSite>[0] = {}) {
  const s = await simSite(over);
  sites.push(s);
  return s;
}

interface Run {
  outcome?: string;
  err?: unknown;
  heals: Promise<unknown>[];
  asks: SignInHealAsk[];
}

/** One sign-in in a fresh headless browser; the error comes back as a value. */
async function signIn(
  s: SimSite,
  dir: string,
  o: {
    cred?: Partial<Credential>;
    codes?: CodeSource;
    writer?: HealWriter;
    repairer?: Repairer;
    /** The clock for holds and heals. */
    now?: () => Date;
  } = {},
): Promise<Run> {
  const out: Run = { heals: [], asks: [] };
  const runner = flowRunner(
    {
      tier: "local",
      engine: "chromium",
      profilesDir: join(dir, "profiles"),
      artifactsDir: join(dir, "artifacts"),
      headless: true,
    },
    { pace: null, person: false, ...(o.repairer ? { repairer: o.repairer } : {}) },
  );
  const login = loginProvider([walkLogin(simWalk(s.origin), { healDir: join(dir, "walks") })], {
    credentials: memoryCredentials({
      sim: { username: "user-a", password: "pw-a-1", ...o.cred } as Credential,
    }),
    codes: o.codes ?? codesOf([]),
    holds: fileSignInHolds(join(dir, "holds.json")),
    ...(o.now ? { now: o.now } : {}),
    heal: (ask) => {
      out.asks.push(ask);
      const p = healSignIn(o.writer ?? writerOf(null), ask, o.now?.());
      out.heals.push(p);
      return p;
    },
  });
  await runner.run(
    defineFlow<undefined, void>({
      site: "sim",
      name: "sign-in",
      async run(fp) {
        try {
          out.outcome = await login(fp, "sim");
        } catch (err) {
          out.err = err;
        }
      },
    }),
    undefined,
  );
  await Promise.all(out.heals);
  return out;
}

const tmp = () => mkdtempSync(join(tmpdir(), "sim-sign-in-"));

/** A clock a test moves: holds and the daily heal limit read it. */
function clock(start = Date.parse("2026-11-27T00:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), pass: (ms: number) => (t += ms) };
}
const HOUR = 3_600_000;
const CONTINUE = { role: "button", name: "Continue to app" };
const continueHeal = (): HealProposal => ({
  name: "terms",
  looks: "a terms page with a continue button",
  ops: [{ kind: "click", goal: "go on past the terms", hints: CONTINUE }],
});
const failed = (r: Run) => r.err as LoginFailed;

describe("sign-in on the simulated site", () => {
  it("signs in through the form", async () => {
    const s = await sim();
    const r = await signIn(s, tmp());
    expect(r.err).toBeUndefined();
    expect(r.outcome).toBe("signed-in");
    expect(s.counts).toMatchObject({ goodPasswords: 1, badPasswords: 0, locked: false });
  }, 60_000);

  it("a security code after the password", async () => {
    const s = await sim({ after: "code" });
    const r = await signIn(s, tmp(), { codes: codesOf(["246810"]) });
    expect(r.outcome).toBe("signed-in");
    expect(s.counts).toMatchObject({ badCodes: 0, locked: false });
  }, 60_000);

  it("a wrong code, then a new one: signed in, the password typed once", async () => {
    const s = await sim({ after: "code" });
    const r = await signIn(s, tmp(), { codes: codesOf(["000000", "246810"]) });
    expect(r.err).toBeUndefined();
    expect(r.outcome).toBe("signed-in");
    expect(s.counts).toMatchObject({ badCodes: 1, passwords: 1, locked: false });
  }, 60_000);

  it("codes the site never takes: the try stops by the third, held as case code", async () => {
    const s = await sim({ after: "code" });
    const dir = tmp();
    const r = await signIn(s, dir, { codes: codesOf(["000000"]) });
    expect(failed(r)).toBeInstanceOf(LoginFailed);
    expect(fileSignInHolds(join(dir, "holds.json")).get("sim")?.case).toBe("code");
    expect(s.counts.badCodes).toBeLessThanOrEqual(3);
    expect(s.counts).toMatchObject({ passwords: 1, locked: false });
  }, 60_000);

  it("a wrong password: typed once, case password, and the next try is held", async () => {
    const s = await sim();
    const dir = tmp();
    const c = clock();
    const r = await signIn(s, dir, { cred: { password: "wrong-1" }, now: c.now });
    expect(failed(r)).toBeInstanceOf(LoginFailed);
    expect(failed(r).case).toBe("password");
    c.pass(HOUR);
    const again = await signIn(s, dir, { cred: { password: "wrong-1" }, now: c.now });
    expect(String(again.err)).toMatch(/no sign-in till/);
    expect(s.counts).toMatchObject({ passwords: 1, locked: false });
    expect(r.asks).toEqual([]);
  }, 60_000);

  it("a wrong password with a previous one on file: the previous once, then stop", async () => {
    const s = await sim();
    const r = await signIn(s, tmp(), {
      cred: { password: "wrong-1", previousPassword: "wrong-0" },
    });
    expect(failed(r).case).toBe("password");
    expect(s.counts).toMatchObject({ passwords: 2, locked: false });
  }, 60_000);

  it("a page no screen knows fails the try and asks for a heal from that page", async () => {
    const s = await sim({ after: "odd" });
    const r = await signIn(s, tmp());
    expect(failed(r)).toBeInstanceOf(LoginFailed);
    expect(failed(r).message).toMatch(/does not know/);
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]?.url).toBe(`${s.origin}/odd`);
    expect(r.asks[0]?.snapshot).toMatch(/Something new/);
    expect(r.asks[0]?.steps).toContain("login-form");
    expect(s.counts.locked).toBe(false);
  }, 60_000);

  it("a new page between steps: the heal's trial screen gets the next try through and is kept", async () => {
    const s = await sim({ after: "interstitial" });
    const dir = tmp();
    const c = clock();
    const one = await signIn(s, dir, { writer: writerOf(continueHeal()), now: c.now });
    expect(failed(one).message).toMatch(/does not know/);
    await expect(one.heals[0]).resolves.toMatchObject({ status: "added", screen: "heal-terms" });
    c.pass(HOUR);
    const two = await signIn(s, dir, { now: c.now });
    expect(two.err).toBeUndefined();
    expect(two.outcome).toBe("signed-in");
    const healed = withHeal(simWalk(s.origin), join(dir, "walks"));
    expect([healed.kept, healed.trial]).toEqual([["heal-terms"], []]);
    expect(s.counts).toMatchObject({ goodPasswords: 2, locked: false });
  }, 90_000);

  it("a trial screen on a try that fails on its own is dropped", async () => {
    const s = await sim({ after: "interstitial", afterInterstitial: "odd" });
    const dir = tmp();
    const c = clock();
    await signIn(s, dir, { writer: writerOf(continueHeal()), now: c.now });
    c.pass(HOUR);
    const two = await signIn(s, dir, { now: c.now });
    expect(failed(two).message).toMatch(/does not know/);
    const healed = withHeal(simWalk(s.origin), join(dir, "walks"));
    expect([healed.kept, healed.trial]).toEqual([[], []]);
    expect(s.counts.locked).toBe(false);
  }, 90_000);

  it("two failed heals in 7 days stop heal for the site", async () => {
    const s = await sim({ after: "odd" });
    const dir = tmp();
    const c = clock();
    const buy = { kind: "click", goal: "buy", hints: { role: "button", name: "Buy now" } };
    const statuses: unknown[] = [];
    for (const writer of [
      writerOf(null),
      writerOf({ ...continueHeal(), ops: [buy] }),
      writerOf(continueHeal()),
    ]) {
      const r = await signIn(s, dir, { writer, now: c.now });
      statuses.push(((await r.heals[0]) as { status: string } | undefined)?.status);
      c.pass(25 * HOUR);
    }
    expect(statuses).toEqual(["none", "refused", "stopped"]);
    expect(s.counts.locked).toBe(false);
  }, 120_000);

  it("a password box that is not input[type=password]: nothing typed, nothing sent", async () => {
    const s = await sim({ passType: "text" });
    const r = await signIn(s, tmp());
    expect(failed(r)).toBeInstanceOf(LoginFailed);
    expect(s.counts).toMatchObject({ passwords: 0, locked: false });
  }, 60_000);

  it("a sign-in page on another origin: the password never goes in", async () => {
    const s = await sim();
    s.set({ loginAt: s.origin.replace("127.0.0.1", "localhost") });
    const r = await signIn(s, tmp());
    expect(r.outcome).not.toBe("signed-in");
    expect(s.counts).toMatchObject({ passwords: 0, locked: false });
  }, 60_000);

  it("a renamed box: the repairer's fix finds it and the sign-in goes on", async () => {
    const s = await sim({ userLabel: "Email or phone" });
    const asked: string[] = [];
    const repairer: Repairer = {
      id: "script",
      propose: async (req) => {
        asked.push(req.goal);
        return { hints: { role: "textbox", name: "Email or phone" }, reason: "renamed" };
      },
    };
    const r = await signIn(s, tmp(), { repairer });
    expect(r.err).toBeUndefined();
    expect(r.outcome).toBe("signed-in");
    expect(asked).toEqual(["type username"]);
    expect(s.counts).toMatchObject({ goodPasswords: 1, locked: false });
  }, 60_000);
});
