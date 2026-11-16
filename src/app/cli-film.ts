/**
 * `autobrowse film <tape> --out <dir>`: type a tape in a filmed terminal; each command it runs
 * films its own browser into the same take (designs/2026-10-24-film.md).
 * `autobrowse obs start|stop|status`: OBS records the screen (overlay and cursor included).
 */
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { contactSheet, takePanes } from "../browser/film.js";
import { loadTape } from "../film/tape.js";
import { expandHome } from "../google/auth.js";

export function registerFilmCommand(program: Command): void {
  program
    .command("film <tape>")
    .description(
      "Type a tape in a filmed terminal; each browser its commands open films itself into the same take",
    )
    .requiredOption("--out <dir>", "the take folder (must hold no panes yet)")
    .action(async (file: string, o: { out: string }) => {
      const dir = expandHome(o.out);
      if ((await takePanes(dir)).length) {
        console.error(`film: ${dir} holds a take already; pick a new folder`);
        process.exitCode = 1;
        return;
      }
      // Playwright loads here, not at every CLI start.
      const { filmTape } = await import("../film/director.js");
      const take = await filmTape(await loadTape(file), {
        tape: file,
        dir,
        log: (line) => console.error(line),
      });
      console.log(`take ${take.dir}: ${take.panes.join(", ")}`);
    });
  program
    .command("film-sheet <video>")
    .description(
      "Contact sheets of a video beside it: the first frame and each scene change, 4x4 a sheet (`<name>-sheet-NN.png`)",
    )
    .action(async (video: string) => {
      const file = expandHome(video);
      const sheets = await contactSheet(file, file.replace(/\.[^./]+$/, ""));
      console.log(JSON.stringify({ sheets: sheets.map((f) => join(dirname(file), f)) }));
    });
  const obs = program
    .command("obs")
    .description(
      "Record the screen with OBS over its websocket: its scene, folder and format (opens OBS if closed)",
    );
  obs
    .command("start")
    .description("Start recording")
    .option("--scene <name>", "switch OBS to this scene first")
    .action(async (o: { scene?: string }) => {
      const { obsStart } = await import("../film/obs.js");
      console.log(JSON.stringify(await obsStart(o.scene ? { scene: o.scene } : {})));
    });
  obs
    .command("stop")
    .description("Stop recording; prints the file")
    .option("--out <file>", "move the recording here")
    .action(async (o: { out?: string }) => {
      const { obsStop } = await import("../film/obs.js");
      console.log(JSON.stringify(await obsStop(o.out ? { out: expandHome(o.out) } : {})));
    });
  obs
    .command("status")
    .description("Recording or not, for how long, the scene and the scenes there are")
    .action(async () => {
      const { obsStatus } = await import("../film/obs.js");
      console.log(JSON.stringify(await obsStatus()));
    });
}
