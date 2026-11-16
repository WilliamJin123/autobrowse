/** `autobrowse desktop …`: the desktop leg from a terminal (a look, a click, root setup). */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { localDesktop, rootHelper, rootSetupCommands } from "../desktop/mac.js";
import { snapText } from "../desktop/types.js";
import { DEFAULT_IDLE_MINUTES } from "../explore/lease.js";
import { expandHome } from "../google/auth.js";
import type { Settings } from "./config.js";

export function registerDesktopCommands(
  program: Command,
  scratchDir: string,
  settings: Settings,
): void {
  const desktop = program
    .command("desktop")
    .description("The desktop outside the browser: apps, menus, dialogs, root commands");
  desktop
    .command("setup")
    .description(
      "Say what the desktop leg still needs (Accessibility for this terminal, the root helper) and how to grant it",
    )
    .action(async () => {
      const d = localDesktop();
      const p = await d.permissions();
      console.log(`accessibility: ${p.accessibility ? "granted" : "missing"}`);
      if (!p.accessibility) {
        console.log(
          "  System Settings → Privacy & Security → Accessibility → add the app running this (Terminal, iTerm, VS Code).",
        );
        await d.shell(
          'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
        );
      }
      console.log(`root: ${p.root ? "ready" : "missing"}`);
      if (!p.root) {
        const file = join(scratchDir, "autobrowse-root");
        writeFileSync(file, rootHelper(), { mode: 0o755 });
        console.log(
          "  run once (asks for your password); every root command is logged to the file the helper names:",
        );
        for (const c of rootSetupCommands(userInfo().username, file)) console.log(`  ${c}`);
      }
    });
  desktop
    .command("windows [app]")
    .description("Open windows: id, app, title, bounds; the id goes to `snapshot`")
    .action(async (app: string | undefined) => {
      for (const w of await localDesktop().windows(app))
        console.log(
          `${w.id}\t${w.app}\t${w.title}\t${w.bounds.x},${w.bounds.y} ${w.bounds.w}×${w.bounds.h}${w.focused ? "\tfocused" : ""}`,
        );
    });
  desktop
    .command("snapshot <window>")
    .description("One window's controls, role and name per line with refs, like `aria`")
    .action(async (window: string) => {
      console.log(snapText((await localDesktop().snapshot(window)).nodes));
    });
  desktop
    .command("start <name>")
    .description(
      "A desktop session on a loopback port: explore's protocol and steering (os, pause, resume, note, save, close) over native windows, no browser",
    )
    .option("--port <port>", "loopback port", "9095")
    .option(
      "--idle <minutes>",
      "close after this long with no command (journal kept); 0 = never",
      String(DEFAULT_IDLE_MINUTES),
    )
    .option("--hold", "never idle-close: you stop it")
    .option("--fresh", "start over: drop the journal a session that died left")
    .option("--no-overlay", "draw no panel over the window")
    .action(
      async (
        name: string,
        o: { port: string; idle: string; hold?: boolean; fresh?: boolean; overlay: boolean },
      ) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name))
          throw new Error("name: lowercase letters, digits and -, starting with a letter");
        const port = Number(o.port);
        const { tokenFileFor } = await import("../explore/journal.js");
        const tokenFile = tokenFileFor(port);
        const { openSessions } = await import("../explore/stop.js");
        const held = openSessions().find((x) => x.port === port);
        if (held)
          throw new Error(
            `port ${port}: ${held.site} (pid ${held.pid}) holds it. End it: autobrowse stop ${port}`,
          );
        if (existsSync(tokenFile)) rmSync(tokenFile, { force: true });
        const recordingsDir = expandHome(settings.recordingsDir);
        const journalFile = join(recordingsDir, `.desktop-${name}`, `journal-port-${port}.jsonl`);
        if (o.fresh) rmSync(journalFile, { force: true });
        const { approverFor, gmailFor } = await import("./services.js");
        const { claudeOwner } = await import("./cli-record.js");
        const { startDesktopSession } = await import("../desktop/session.js");
        const approve = approverFor(settings, gmailFor(settings));
        const s = await startDesktopSession({
          name,
          port,
          recordingsDir,
          tokenFile,
          journalFile,
          idleMinutes: o.hold ? 0 : Number(o.idle),
          overlay: o.overlay,
          owner: claudeOwner(),
          ...(approve ? { approve } : {}),
        });
        // the token stays in its owner-only file: logs get pasted
        console.log(
          `desktop session ${name} on http://127.0.0.1:${s.port}\ntoken file ${tokenFile}`,
        );
        if (s.resumedFrom)
          console.log(`resumed ${s.resumedFrom.acts} journaled acts; --fresh starts over`);
        await s.done;
        console.log(`desktop session ${name} closed`);
      },
    );
}
