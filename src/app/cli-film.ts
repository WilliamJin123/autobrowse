/**
 * `autobrowse film <tape> --out <dir>`: type a tape in a filmed terminal; each command it runs
 * films its own browser into the same take (designs/2026-10-24-film.md).
 * `autobrowse screen-record`: the main screen as an mp4, cropped to Chrome, music optional.
 */
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { contactSheet, takePanes } from "../browser/film.js";
import { loadTape } from "../film/tape.js";
import { expandHome } from "../google/auth.js";

export function registerFilmCommand(program: Command, profilesDir: () => string): void {
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
  program
    .command("screen-record")
    .description(
      "Record the Mac's main screen as an mp4, cropped to our browsers' windows; --music adds a bed (default: elevator music, CC BY)",
    )
    .requiredOption("--out <file>", "the mp4 to write")
    .option("--seconds <n>", "stop after this long (else Ctrl-C)", (v) => Number(v))
    .option("--fps <n>", "frames a second", (v) => Number(v), 30)
    .option("--music [file]", "a music bed: a file, or bare for the elevator track")
    .option("--whole-screen", "keep the whole screen, not only our browsers' windows")
    .action(
      async (o: {
        out: string;
        seconds?: number;
        fps: number;
        music?: string | true;
        wholeScreen?: boolean;
      }) => {
        const { screenRecord } = await import("../film/screen.js");
        const r = await screenRecord({
          out: expandHome(o.out),
          seconds: o.seconds,
          fps: o.fps,
          music: o.music === true ? "elevator" : (o.music ?? null),
          crop: o.wholeScreen ? "screen" : "chrome",
          profilesDir: profilesDir(),
          log: (line) => console.error(line),
        });
        console.log(JSON.stringify(r));
      },
    );
}
