import { describe, expect, it } from "vitest";
import { captureArgs, cropOf, ELEVATOR, finishArgs, ourWindows } from "../src/film/screen.js";

describe("screen-record", () => {
  it("crops to the union of Chrome's windows, in video px, inside the frame, even sides", () => {
    const frame = { w: 3024, h: 1964 };
    expect(
      cropOf(
        [
          { x: 22, y: 33, w: 1280, h: 884 },
          { x: 300, y: 100, w: 1300, h: 500 },
        ],
        2,
        frame,
      ),
    ).toEqual({ x: 44, y: 66, w: 2980, h: 1768 });
    // off the screen's edge: clamped
    expect(cropOf([{ x: -408, y: 33, w: 1920, h: 877 }], 2, frame)).toEqual({
      x: 0,
      y: 66,
      w: 3024,
      h: 1754,
    });
    expect(cropOf([], 2, frame)).toBeNull();
    expect(cropOf([{ x: 10, y: 10, w: 20, h: 20 }], 2, frame)).toBeNull();
  });

  it("crops to our browsers' windows; the person's own Chrome only when none of ours shows", () => {
    const w = (pid: number, owner = "Google Chrome") => ({
      owner,
      pid,
      x: pid,
      y: 0,
      w: 100,
      h: 100,
    });
    const all = [w(1), w(2), w(3, "Chromium"), w(4, "Ghostty")];
    expect(ourWindows(all, new Set([2, 3])).map((b) => b.x)).toEqual([2, 3]);
    expect(ourWindows(all, new Set([9])).map((b) => b.x)).toEqual([1, 2, 3]);
  });

  it("captures the main screen with the real cursor and its clicks, no audio device", () => {
    const a = captureArgs("/t/raw.mp4", 30, 5);
    expect(a.join(" ")).toContain(
      "-f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 30 -i Capture screen 0:none -t 5",
    );
    expect(captureArgs("/t/raw.mp4", 30)).not.toContain("-t");
  });

  it("the finish crops, loops the bed under the video and fades it out at the end", () => {
    const a = finishArgs({
      raw: "r.mp4",
      out: "o.mp4",
      seconds: 20,
      crop: { x: 44, y: 66, w: 2560, h: 1768 },
      music: "m.mp3",
    });
    const graph = a[a.indexOf("-filter_complex") + 1];
    expect(graph).toBe(
      "[0:v]crop=2560:1768:44:66[v];[1:a]volume=0.35,afade=t=in:d=1,afade=t=out:st=17.50:d=2.5[a]",
    );
    expect(a.join(" ")).toContain("-stream_loop -1 -i m.mp3");
    expect(a.join(" ")).toContain("-map [v] -map [a]");
    expect(a.slice(a.indexOf("-t"), a.indexOf("-t") + 2)).toEqual(["-t", "20.00"]);
    // no crop: the video is copied, not encoded again
    const plain = finishArgs({
      raw: "r.mp4",
      out: "o.mp4",
      seconds: 8,
      crop: null,
      music: "m.mp3",
    });
    expect(plain.join(" ")).toContain("-map 0:v -map [a]");
    expect(plain.join(" ")).toContain("-c:v copy");
    expect(ELEVATOR.credit).toContain("Creative Commons: By Attribution 4.0");
  });
});
