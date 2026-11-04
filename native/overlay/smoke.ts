/**
 * Live proof of the overlay host on this machine (CI's matrix, or by hand): headed Chrome, the
 * real host, real OS clicks. Passes when the host finds Chrome's window, the panel's buttons work,
 * the page never loses focus or sees an event, and a click beside the panel reaches the page.
 * Usage: tsx native/overlay/smoke.ts <out dir> [--no-input]   (screenshots go to <out dir>)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { overlayFor } from "../../src/explore/overlay.js";
import { type HostEvent, nativeHost, type OverlayHost } from "../../src/explore/overlay-host.js";

const out = process.argv[2] ?? join(tmpdir(), "overlay-smoke");
const input = !process.argv.includes("--no-input");
mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const os = process.platform;

/** A real click at screen pixels, through the OS (not CDP: the page must not be the sender); a hover first, as a person's. */
function click(x: number, y: number): void {
  if (os === "linux")
    execFileSync("xdotool", ["mousemove", "--sync", `${x}`, `${y}`, "sleep", "0.15", "click", "1"]);
  else if (os === "win32")
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);' -Name U -Namespace W; [W.U]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 150; [W.U]::mouse_event(2, 0, 0, 0, 0); [W.U]::mouse_event(4, 0, 0, 0, 0)`,
    ]);
  else execFileSync(process.env.OVERLAY_CLICK ?? "click", [`${x}`, `${y}`]);
}

function hostAlive(): boolean {
  try {
    if (os === "win32")
      return execFileSync("tasklist", ["/FI", "IMAGENAME eq overlay-host*"])
        .toString()
        .includes("overlay-host");
    execFileSync("pgrep", ["-f", "overlay-host"]);
    return true;
  } catch {
    return false;
  }
}

function shot(name: string, x: number, y: number, w: number, h: number): void {
  const f = join(out, `${os}-${name}.png`);
  try {
    if (os === "linux")
      execFileSync("import", ["-window", "root", "-crop", `${w}x${h}+${x}+${y}`, f]);
    else if (os === "win32")
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap ${w}, ${h}; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save('${f}')`,
      ]);
    else execFileSync("screencapture", ["-x", `-R${x},${y},${w},${h}`, f]);
  } catch (e) {
    console.log(`shot ${name} failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ovl-")), {
  headless: false,
  viewport: null,
  args: [
    // fits 1024x768 less a taskbar (the Windows runner's screen)
    "--window-size=1000,680",
    "--window-position=10,10",
    ...(os === "linux" ? ["--ozone-platform=x11"] : []),
  ],
});
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setContent(`<body style="margin:0;font:16px sans-serif;background:#f4f4f6">
<h1 style="margin:40px">A page under the overlay</h1>
<button id=b style="position:absolute;left:560px;top:220px;width:180px;height:56px">Save</button><script>
window.hits={blur:0,focus:0,vis:0,ptr:0,clicks:0};
addEventListener('blur',()=>hits.blur++);addEventListener('focus',()=>hits.focus++);
document.addEventListener('visibilitychange',()=>hits.vis++);
for(const k of ['pointerdown','mousedown','click','wheel'])addEventListener(k,()=>hits.ptr++,true);
b.onclick=()=>hits.clicks++;
</script>`);
  await page.bringToFront();
  await page.mouse.move(0, 0);
  let host: OverlayHost | null = null;
  const events: HostEvent[] = [];
  let why = "";
  const o = overlayFor(true, {
    host: async (w) => {
      host = await nativeHost((r) => {
        why = r;
        w(r);
      });
      host?.on((e) => events.push(e));
      return host;
    },
  });
  const r = await o.set(page, {
    goal: "prove the overlay on this OS",
    step: "1 of 1",
    refs: [{ n: 1, hints: { role: "button", name: "Save" } }],
  });
  check(r.drawn, `drawn ${JSON.stringify(r)} ${why}`);
  if (!host) throw new Error(`no host: ${why}`);
  const h = host as OverlayHost;
  await o.end(page, { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] });
  for (let i = 0; i < 50 && !events.some((e) => e.t === "found"); i++) await sleep(100);
  check(
    events.some((e) => e.t === "found"),
    `found Chrome's window (${events.map((e) => e.t).join(",")})`,
  );
  await sleep(800);

  const cdp = await ctx.newCDPSession(page);
  const { bounds } = (await cdp.send("Browser.getWindowForTarget")) as {
    bounds: { left: number; top: number; width: number; height: number };
  };
  // geometry from an isolated world: the page's own getters never see it
  const { frameTree } = (await cdp.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  const world = (await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id })) as {
    executionContextId: number;
  };
  const v = (
    (await cdp.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      returnByValue: true,
      expression: "({oh:outerHeight,ow:outerWidth,ih:innerHeight,iw:innerWidth})",
    })) as { result: { value: { oh: number; ow: number; ih: number; iw: number } } }
  ).result.value;
  // frame border (Windows' invisible 8 px, Linux's 4 px), as core.rs: left, right and bottom
  const b = v.ow - v.iw <= 16 ? (v.ow - v.iw) / 2 : 0;
  const vx = bounds.left + b;
  const vy = bounds.top + (v.oh - v.ih) - b;
  const snap = (name: string) => shot(name, vx, vy, v.iw, v.ih);

  const probe = async () => {
    const n = events.length;
    h.send({
      t: "js",
      js: "webkit.messageHandlers.host.postMessage({probe: Object.fromEntries([...document.querySelectorAll('[data-a]')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [b.getAttribute('data-a'), [r.x + r.width / 2, r.y + r.height / 2]]; }))})",
    });
    for (let i = 0; i < 40 && !events.slice(n).some((e) => e.probe); i++) await sleep(50);
    return (events.slice(n).find((e) => e.probe)?.probe ?? {}) as Record<string, [number, number]>;
  };
  const p0 = await probe();
  check(Object.keys(p0).length > 0, `the panel answers (${Object.keys(p0).join(",")})`);
  await sleep(400); // the compositor's first frame
  snap("0-drawn");
  const hits = () =>
    page.evaluate("({...hits, has: document.hasFocus()})") as Promise<
      Record<string, number | boolean>
    >;
  const prefs = () =>
    [...events].reverse().find((e) => e.prefs)?.prefs as Record<string, unknown> | undefined;

  if (input) {
    const press = async (a: string) => {
      const p = await probe();
      const at = p[a];
      if (!at) return check(false, `${a} is shown`);
      click(Math.round(vx + at[0]), Math.round(vy + at[1]));
      await sleep(600);
    };
    await press("theme");
    const t1 = prefs()?.theme;
    check(t1 !== undefined && t1 !== null, `theme button: prefs.theme ${String(t1)}`);
    snap("1-theme");
    await press("theme");
    await press("look");
    snap("2-look");
    await press("look");
    await press("min");
    check(prefs()?.min === true, "min button minimizes");
    snap("3-min");
    // the tab: at the left edge, mid height
    click(Math.round(vx + 6), Math.round(vy + v.ih / 2));
    await sleep(700);
    check(prefs()?.min === false, "the tab opens it again");
    const s1 = await hits();
    check(
      s1.blur === 0 && s1.ptr === 0 && s1.has === true,
      `page untouched by panel clicks ${JSON.stringify(s1)}`,
    );
    // beside the panel: the click goes through to the page
    const bb = await page.locator("#b").boundingBox();
    if (bb) click(Math.round(vx + bb.x + bb.width / 2), Math.round(vy + bb.y + bb.height / 2));
    await sleep(600);
    const s2 = await hits();
    check(s2.clicks === 1, `a click beside the panel reaches the page ${JSON.stringify(s2)}`);
    snap("4-after");
  }

  await o.remove(page);
  await sleep(1500);
  check(!hostAlive(), "no host process left");
} catch (e) {
  fails.push((e as Error).message);
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  await ctx.close();
}
writeFileSync(join(out, `${os}-result.json`), JSON.stringify({ fails }, null, 2));
process.exit(fails.length ? 1 : 0);
