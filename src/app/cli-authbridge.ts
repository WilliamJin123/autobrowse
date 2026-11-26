/**
 * `autobrowse authbridge …` (designs/2026-11-25-authbridge.md): save a profile's sign-in, list
 * what is kept, restore a version into a profile. JSON out; counts and sizes, never values.
 * Every browser here is headless, local and its own: these runs never save through the runner hook.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { SITE_LOGINS } from "../auth/sites.js";
import type { SignInBridge } from "../authbridge/bridge.js";
import {
  applySnapshot,
  originsOf,
  type SignInSnapshot,
  signedOut,
  siteOfProfile,
  storedOrigins,
} from "../authbridge/snapshot.js";
import { assertProfileFree } from "../browser/browsers.js";
import type { FlowPage } from "../browser/flow-api.js";
import { assertNotReserved } from "../browser/reserve.js";
import { expandHome } from "../google/auth.js";
import type { Settings } from "./config.js";
import { bridgeFor, machineName } from "./services-authbridge.js";
import { browserOptions } from "./services-browser.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function bridgeOf(settings: Settings): SignInBridge {
  const b = bridgeFor(settings);
  if (!b)
    throw new Error(
      "authbridge: needs SHOTS_BUCKET, and AUTOBROWSE_MACHINE on a machine that is not a Mac",
    );
  return b;
}

const dirOf = (settings: Settings, profile: string) =>
  join(expandHome(settings.profilesDir), profile);

/** navigator.platform of Chrome on this OS: what a snapshot's `platform` is checked against. */
export function platformHere(os: NodeJS.Platform = process.platform): string {
  if (os === "darwin") return "MacIntel";
  if (os === "win32") return "Win32";
  return "Linux x86_64";
}

/**
 * Why a snapshot may not fit here: sites bind a session to the platform and the IP. A null exit
 * (the machine's own line) matches only on the machine that saved it.
 */
export function misfits(
  meta: { platform: string; exit: string | null; machine: string },
  here: { platform: string; exit: string | null; machine: string | null },
): string[] {
  const out: string[] = [];
  if (meta.platform !== here.platform) out.push(`platform ${here.platform} ≠ ${meta.platform}`);
  if (meta.exit !== here.exit) out.push(`exit ${here.exit ?? "direct"} ≠ ${meta.exit ?? "direct"}`);
  else if (meta.exit === null && meta.machine !== here.machine)
    out.push(`direct line of ${here.machine ?? "this machine"} ≠ ${meta.machine}`);
  return out;
}

/** A headless local runner on exactly the named profile: no remap, no save hook, no sign-in. */
async function onProfile<O>(
  settings: Settings,
  profile: string,
  name: string,
  run: (fp: FlowPage) => Promise<O>,
): Promise<O> {
  const { onChromeFolder } = await import("../browser/engines.js");
  const { flowRunner } = await import("../browser/flow.js");
  const { defineFlow } = await import("../browser/flow-api.js");
  const { runLeg } = await import("../engine/leg.js");
  const { signIns: _skip, own: _own, ...opts } = browserOptions(settings, { headless: true });
  const runner = flowRunner(
    {
      ...opts,
      tier: "local",
      // the folder `dirOf` names: Chrome's (Chromium in a container), whatever the site map says
      engine: onChromeFolder(settings.browserEngine) ? settings.browserEngine : "chrome",
      profile,
      profileName: async (n) => n,
      providerProfile: async () => null,
    },
    { pace: null },
  );
  return runLeg(
    runner,
    defineFlow<undefined, O>({ site: profile, name, run: (fp) => run(fp) }),
    undefined,
  );
}

export function registerAuthbridgeCommands(program: Command, settings: Settings): void {
  const ab = program
    .command("authbridge")
    .description("Sign-in snapshots: save a profile's sign-in sealed in S3, restore it anywhere");

  ab.command("save <profile>")
    .description("Save the profile's sign-in now (cookies, localStorage, IndexedDB), sealed")
    .option("--force", "save even when the site's session cookies are gone")
    .action(async (profile: string, o: { force?: boolean }) => {
      const bridge = bridgeOf(settings);
      const dir = dirOf(settings, profile);
      if (!existsSync(dir))
        throw new Error(`${profile}: no such profile in ${settings.profilesDir}`);
      const r = await onProfile(settings, profile, "authbridge-save", async (fp) => {
        const ctx = fp.page.context();
        // a cold profile: storage is collected only for origins this process visited
        const visit = [...new Set([...originsOf(await ctx.cookies()), ...storedOrigins(dir)])];
        return bridge.save(profile, ctx, {
          why: "cli",
          visit,
          ...(o.force ? { force: true } : {}),
        });
      });
      out({ profile, ...r });
      if (!r.saved) process.exitCode = 1;
    });

  ab.command("list [profile]")
    .description("What is kept: every profile's newest version, or one profile's versions")
    .action(async (profile?: string) => {
      out(await bridgeOf(settings).list(profile));
    });

  ab.command("show <profile>")
    .description("One version's meta (default the newest): counts and origins, never values")
    .option("--version <v>", "a version from `authbridge list <profile>`")
    .action(async (profile: string, o: { version?: string }) => {
      const snap = await bridgeOf(settings).load(profile, o.version);
      if (!snap) throw new Error(`${profile}: nothing kept${o.version ? ` at ${o.version}` : ""}`);
      out({ ...snap.meta, signedOut: signedOut(profile, snap.state) });
    });

  ab.command("restore <profile>")
    .description(
      "Put a version (default the newest) into the profile; same name moves the holder here",
    )
    .option("--version <v>", "a version from `authbridge list <profile>`")
    .option("--into <name>", "restore into another profile: a copy, both share one session")
    .option("--replace", "the target folder exists: move it aside (kept), restore into a new one")
    .option("--force", "restore although the platform or exit differs from the snapshot's")
    .option("--no-check", "skip opening the site's home to check the sign-in")
    .action(
      async (
        profile: string,
        o: { version?: string; into?: string; replace?: boolean; force?: boolean; check: boolean },
      ) => {
        const bridge = bridgeOf(settings);
        const snap = await bridge.load(profile, o.version);
        if (!snap)
          throw new Error(`${profile}: nothing kept${o.version ? ` at ${o.version}` : ""}`);
        const target = o.into ?? profile;
        const move = target === profile;
        const here = {
          platform: platformHere(),
          exit: browserOptions(settings).egress?.exitFor(target)?.name ?? null,
          machine: machineName(),
        };
        const differs = misfits(snap.meta, here);
        if (differs.length && !o.force)
          throw new Error(
            `${target}: ${differs.join("; ")} (sites may ask again); --force restores anyway`,
          );
        const dir = dirOf(settings, target);
        let aside: string | null = null;
        if (existsSync(dir)) {
          // setStorageState leaves storage of origins it never visited: restore into an empty folder
          if (!o.replace)
            throw new Error(`${target}: the profile folder exists; --replace moves it aside first`);
          assertNotReserved(target, dir);
          await assertProfileFree(dir, target);
          aside = `${dir}.before-restore-${snap.meta.version}-${Date.now()}`;
          renameSync(dir, aside);
        }
        let check: Awaited<ReturnType<typeof checkSignIn>>;
        try {
          check = await onProfile(settings, target, "authbridge-restore", async (fp) => {
            await applySnapshot(fp.page.context(), snap);
            return checkSignIn(fp, snap, o.check);
          });
        } catch (err) {
          undo(dir, aside);
          throw err;
        }
        const ok = check.sessionCookies && check.signedIn !== false;
        // a failed restore leaves the target as it was; a move takes the holder only once it works
        if (!ok) undo(dir, aside);
        else if (move) await bridge.take(profile);
        out({
          profile,
          version: snap.meta.version,
          into: target,
          kind: move ? "move" : "copy",
          restored: ok,
          ...(aside ? { movedAside: ok ? aside : null } : {}),
          ...(differs.length ? { forced: differs } : {}),
          ...check,
          ...(move || !ok ? {} : { note: `${target} and ${profile} now share one session` }),
        });
        if (!ok) process.exitCode = 1;
      },
    );
}

/** The new folder goes; the one moved aside comes back. */
function undo(dir: string, aside: string | null): void {
  rmSync(dir, { recursive: true, force: true });
  if (aside) renameSync(aside, dir);
}

/** After a restore: the session cookies are there, and the site's home passes its own check. */
async function checkSignIn(
  fp: FlowPage,
  snap: SignInSnapshot,
  open: boolean,
): Promise<{ cookies: number; sessionCookies: boolean; signedIn: boolean | null; home?: string }> {
  const cookies = await fp.page.context().cookies();
  const sessionCookies = !signedOut(snap.meta.profile, { cookies, origins: [] });
  const spec = SITE_LOGINS.find((l) => l.site === siteOfProfile(snap.meta.profile));
  if (!open || !spec?.loggedIn) return { cookies: cookies.length, sessionCookies, signedIn: null };
  // no login hook here: a wall is a signed-out answer, never a sign-in
  await fp.open(spec.home, { allowWall: true });
  return {
    cookies: cookies.length,
    sessionCookies,
    signedIn: await spec.loggedIn(fp),
    home: spec.home,
  };
}
