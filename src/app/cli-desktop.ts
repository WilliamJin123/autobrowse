/** `autobrowse desktop …`: the desktop leg from a terminal (a look, a click, root setup). */
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { localDesktop, rootHelper, rootSetupCommands } from "../desktop/mac.js";
import { snapText } from "../desktop/types.js";

export function registerDesktopCommands(program: Command, scratchDir: string): void {
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
}
