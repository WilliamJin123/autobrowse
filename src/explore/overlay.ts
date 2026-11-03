/**
 * The headed overlay (designs/2026-10-27-explore-gaps.md): what the agent
 * sees and why it acts, drawn over the page for a person who watches. Boxes
 * carry the outline's ref numbers, or a marks shot's (its colours, kept until
 * the next act); the control about to be acted on flashes;
 * a terminal-style panel holds the goal, the thought, the act and a live
 * trace of every command. It sits in a closed shadow root outside `body` (so
 * the aria tree never reads it) and is taken off for every screenshot.
 * Headless, nothing is drawn.
 *
 * Decorative: it changes nothing a page, a run or a shot sees. The whole
 * panel takes the pointer: its bar (drag to move, buttons: boxes on/off,
 * minimize), its four corner grips (resize) and its body, where a click does
 * nothing. A window capture listener swallows those events before the page's
 * handlers or the recorder's observer see one; mousedown's default is
 * stopped so focus stays where it was. A person's click always lands on the
 * panel; the agent's presses pass through it. The page cannot tell the two
 * apart, so the panel goes inert (pointer-events none) only when an act's
 * target, looked up before the act, is under it or not on screen, and during
 * a hold or a drag, whose points are not known ahead. A drag holds pointer
 * capture, so the page never sees the moves. Minimized, it is a tab at the
 * left edge. Boxes off, their positions are not looked up either.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { drawsOn } from "../browser/bare.js";
import { type Hints, locate } from "../browser/locate.js";
import type { Command } from "./commands.js";
import { type Box, MARK_COLOURS } from "./marks.js";

/** One command as the trace shows it; never a typed value. */
export interface TraceRow {
  n: number;
  /** HH:MM:SS, local. */
  at: string;
  cmd: string;
  what: string;
  ok: boolean;
  ms: number;
  /** One dim line under the row: where the page went, what changed, what was read. */
  note: string;
  /** Shown when the row is opened: target, url, error. */
  detail: string[];
}

/** What the panel and boxes show; null leaves a part off. */
export interface OverlayState {
  goal: string | null;
  step: string | null;
  thought: string | null;
  /** The act under way: `click: open the pricing page`. */
  doing: string | null;
  boxes: Array<{ n: number; box: Box }>;
  target: Box | null;
  /** A command is running. */
  busy: boolean;
  /** Hands whose points are not known ahead (a hold, a drag): the panel takes no pointer. */
  held: boolean;
  /** An act's target was looked up: `aim` is where it is, null when not on screen. */
  aimed: boolean;
  aim: Box | null;
  /** The running command: picks its phase words. */
  cmd: string | null;
  /** The bar's right side: seed, pace. */
  meta: string | null;
  trace: TraceRow[];
}

const EMPTY: OverlayState = {
  goal: null,
  step: null,
  thought: null,
  doing: null,
  boxes: [],
  target: null,
  busy: false,
  held: false,
  aimed: false,
  aim: null,
  cmd: null,
  meta: null,
  trace: [],
};

/**
 * Commands that never press the page at a point. Keys go to the focus; a feed's scroll runs in a
 * `hold`; `flow`, `code` and `batch` steps begin on their own.
 */
const READS_ONLY = new Set([
  "open",
  "aria",
  "snapshot",
  "text",
  "url",
  "pages",
  "page",
  "screenshot",
  "marks",
  "overlay",
  "network",
  "html",
  "eval",
  "count",
  "read",
  "records",
  "keep",
  "note",
  "cut",
  "goal",
  "done",
  "files",
  "read_file",
  "tools",
  "save",
  "journal",
  "pause",
  "resume",
  "type",
  "key",
  "script",
  "new-ip",
  "flow",
  "code",
  "batch",
  "act",
]);
/** Acts that press their target: `flash` looks it up first. Any other command is held. */
const AIMED = new Set(["click", "fill", "place", "select", "press", "hover", "upload"]);

/** The narrowest a person can size the panel, px. */
const PANEL_MIN_W = 220;
/** A ref's box resolves this fast or is left off: a slow find never holds up a step. */
const BOX_MS = 400;
/** A draw never holds a command longer than this. */
const DRAW_MS = 1_000;
/** Rows the page keeps; the trace scrolls them by wheel. */
const TRACE_KEEP = 200;

/** What the busy line cycles through, in the order the hands do it. */
const PHASES: Record<string, string[]> = {
  click: ["locating", "aiming", "moving", "clicking"],
  fill: ["locating", "focusing", "typing"],
  type: ["typing"],
  place: ["locating", "unsealing", "typing"],
  select: ["locating", "opening", "choosing"],
  upload: ["locating", "attaching"],
  drag: ["locating", "grabbing", "dragging", "dropping"],
  open: ["resolving", "loading", "settling"],
  read: ["locating", "reading"],
  aria: ["walking tree", "outlining"],
  snapshot: ["walking tree", "outlining"],
  marks: ["measuring", "numbering"],
  key: ["pressing"],
  press: ["pressing"],
  download: ["clicking", "receiving"],
  code: ["waiting for code", "typing"],
};
/** Seconds per phase word. */
const PHASE_S = 0.55;

/** A CSS `content` cycle: the page runs no timer of ours. */
const contentKeys = (name: string, words: string[]) =>
  `@keyframes ${name}{${[...words, words.at(-1)]
    .map((w, i) => `${Math.round((i / words.length) * 1000) / 10}%{content:${JSON.stringify(w)}}`)
    .join("")}}`;

/** Wren design-language tokens, light and dark (wren/designs/2026-10-20-design-language). */
const THEMES = {
  light:
    "--canvas:#f3f1ec;--paper:#fff;--ink:#0e0e0e;--ink-2:#56564f;--ink-3:#63645e;--accent:#6a5a93;--on-accent:#faf7f2;--good:#17803d;--bad:#c31c15;" +
    "--raise:0 0 0 1px var(--hair),0 1px 2px rgb(14 14 14/.04),0 4px 14px -6px rgb(40 30 70/.10);--lift:0 24px 56px -18px rgb(40 30 70/.28)",
  dark:
    "--canvas:#0d0d0c;--paper:#171716;--ink:#f2f0ea;--ink-2:#a9a79f;--ink-3:#8f8d86;--accent:#a596d6;--on-accent:#15121f;--good:#4cc27a;--bad:#ff6b5e;" +
    "--raise:0 0 0 1px var(--hair),0 6px 18px -8px rgb(0 0 0/.6);--lift:0 24px 56px -16px rgb(0 0 0/.55)",
};

/** The terminal look's tokens: Wren dark, as the TUI had them before the panel (2026-10-28). */
const T = {
  canvas: "#0d0d0c",
  paper: "#171716",
  ink: "#f2f0ea",
  ink2: "#a9a79f",
  ink3: "#8f8d86",
  accent: "#a596d6",
  onAccent: "#15121f",
  good: "#4cc27a",
  bad: "#ff6b5e",
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Lucide paths (ISC), 24-unit box, drawn at one size and stroke. */
const ICONS = {
  term: "m4 17 6-6-6-6M12 19h8",
  boxes:
    "M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1",
  moon: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  min: "M5 12h14",
  chevron: "m6 9 6 6 6-6",
};

/** Prefix each rule's selectors; one rule a string, at-rules as they are. */
const scope = (prefix: string, rules: string[]) =>
  rules.map((r) =>
    r.startsWith("@")
      ? r
      : r.replace(/^[^{]+/, (sel) =>
          sel
            .split(",")
            .map((x) => `${prefix} ${x.trim()}`)
            .join(","),
        ),
  );

/** Both looks: the page's boxes, the layer's frame, the motion rules. Only transform and opacity move. */
const SHARED_CSS = [
  "*{box-sizing:border-box}",
  ".wrap{--hair:color-mix(in srgb,var(--ink) 11%,transparent);--fill:color-mix(in srgb,var(--ink) 5%,transparent);--tint:color-mix(in srgb,var(--accent) 12%,transparent);--ease:cubic-bezier(.16,1,.3,1);--spring:cubic-bezier(.34,1.4,.64,1)}",
  `.wrap.light{${THEMES.light}}`,
  `.wrap.dark{${THEMES.dark}}`,
  `.wrap.term{--accent:${T.accent}}`,
  // As the marks shot draws them (marks.ts layerScript).
  ".box{position:fixed;border:2px solid}",
  ".tag{position:absolute;left:-2px;font:bold 11px/14px monospace;color:#fff;padding:0 3px}",
  // The target locks on (from 8px out), then a ring leaves it; --sx/--sy: 8px of scale per side.
  ".target{position:fixed;border:2px solid var(--accent);border-radius:6px;animation:aim .32s var(--spring) both}",
  '.target::after{content:"";position:absolute;inset:-2px;border:2px solid var(--accent);border-radius:8px;opacity:0;animation:ring 1.3s var(--ease) .15s infinite}',
  "@keyframes aim{from{opacity:0;transform:scale(var(--sx),var(--sy))}}",
  "@keyframes ring{from{opacity:.6;transform:none}to{opacity:0;transform:scale(var(--sx),var(--sy))}}",
  "svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}",
  ".tui{position:fixed;display:flex;flex-direction:column;max-width:calc(100vw - 12px);cursor:default;user-select:none;-webkit-user-select:none;container-type:inline-size}",
  ".tui:not(.inert){pointer-events:auto}",
  ".tui.inert{opacity:.6}",
  ".tab{position:fixed;left:0;top:50%;transform:translateY(-50%);height:56px;cursor:pointer}",
  ".tab:not(.inert){pointer-events:auto}",
  ".bar{display:flex;align-items:center;white-space:nowrap}",
  ".bar .fill{flex:1}",
  ".grip{position:absolute}",
  '.phase::after{content:"";animation:ph var(--d) steps(1) forwards;animation-delay:var(--t)}',
  '.dots::after{content:"";animation:dots 1.8s steps(1) infinite}',
  contentKeys("dots", ["", ".", "..", "..."]),
  ".rule .btn{pointer-events:auto}",
  ".tui.inert .rule .btn{pointer-events:none}",
  ".rows{display:grid;align-content:start;overflow-y:auto;overflow-anchor:none;overscroll-behavior:contain;scrollbar-width:thin}",
  ".tui.sized .rows{flex:1;min-height:0;max-height:none}",
  ".row{display:grid;grid-column:1/-1;grid-template-columns:subgrid}",
  // Each look places the cells by column in its own order; a definite row keeps them on one line.
  ".row>:not(.note){grid-row:1}",
  ".row .note{grid-row:2;overflow-wrap:anywhere}",
  "@media (prefers-reduced-motion:reduce){.target,.target::after,.in,.enter,.row.new{animation:none!important}.shim{animation:none!important;background:none!important;color:inherit!important}*{transition:none!important}}",
];

/** The panel: a floating macOS-style sheet, light or dark, purple accents (2026-11-03). */
const PANEL_CSS = [
  '.tui{background:color-mix(in srgb,var(--paper) 86%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.8);backdrop-filter:blur(24px) saturate(1.8);font:12px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",Figtree,system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;border-radius:14px;box-shadow:var(--raise),var(--lift);transform-origin:0 100%}',
  ".tab{background:color-mix(in srgb,var(--paper) 86%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.8);backdrop-filter:blur(24px) saturate(1.8);width:14px;border-radius:0 10px 10px 0;box-shadow:var(--raise),var(--lift);transition:width .2s var(--ease)}",
  // Width scales the type and the inset: 12px wide open, 10.5px at the narrowest.
  ".tui>*{--g:clamp(6px,2.4cqi,10px);font-size:clamp(10.5px,calc(8.5px + .9cqi),12px)}",
  '.num{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.9em;font-variant-numeric:tabular-nums}',
  ".tab:hover{width:20px}",
  '.tab::after{content:"";position:absolute;left:5px;top:18px;width:3px;height:20px;border-radius:2px;background:var(--hair)}',
  ".tab.busy::after{background:var(--accent);animation:breathe 1.4s var(--ease) infinite}",
  "@keyframes breathe{50%{opacity:.35}}",
  ".tab.enter{animation:peek .28s var(--ease)}",
  "@keyframes peek{from{transform:translate(-100%,-50%)}}",
  ".tui.enter{animation:pop .36s var(--spring)}",
  "@keyframes pop{from{opacity:0;transform:translateX(-10px) scale(.96)}}",
  ".bar{gap:6px;padding:5px 4px 2px var(--g);cursor:grab}",
  ".bar .name{font-weight:650;letter-spacing:-.01em}",
  ".bar .state,.bar .k,.bar .meta{min-width:0;color:var(--ink-3);overflow:hidden}",
  ".bar .state.run{color:var(--accent);font-weight:600}",
  ".btn{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:999px;color:var(--ink-2);cursor:pointer;transition:background-color .15s var(--ease),color .15s var(--ease)}",
  ".btn svg{width:14px;height:14px;transition:transform .22s var(--ease)}",
  ".btn:hover{background:var(--fill);color:var(--ink)}",
  ".btn.on{color:var(--accent)}",
  ".btn.on:hover{background:var(--tint)}",
  ".btn.folded svg{transform:rotate(-90deg)}",
  // Corners size the panel; no mark, and they straddle the rounded edge, as a macOS window's.
  ".grip{width:18px;height:18px}",
  ".grip.se{right:-4px;bottom:-4px;cursor:nwse-resize}",
  ".grip.sw{left:-4px;bottom:-4px;cursor:nesw-resize}",
  ".grip.ne{right:-4px;top:-4px;cursor:nesw-resize}",
  ".grip.nw{left:-4px;top:-4px;cursor:nwse-resize}",
  ".body{display:flex;flex-direction:column;gap:1px;padding:2px var(--g) 6px}",
  ".goal{font-weight:650;line-height:1.3;letter-spacing:-.01em;overflow-wrap:anywhere}",
  ".thought{color:var(--ink-2);overflow-wrap:anywhere}",
  ".doing{display:flex;align-items:baseline;gap:5px;overflow-wrap:anywhere}",
  ".verb{flex:none;color:var(--accent);background:var(--tint);border-radius:5px;padding:0 5px;font-weight:600;font-size:.92em;line-height:1.45}",
  // A line whose words changed rises in; the same words redrawn stay still.
  ".in{animation:rise .24s var(--ease)}",
  "@keyframes rise{from{opacity:0;transform:translateY(3px)}}",
  ".live{color:var(--ink-3);font-size:.92em}",
  // The busy words: a light passing through them, on one clock across redraws.
  ".shim{background:linear-gradient(90deg,var(--ink-3) 35%,var(--accent) 50%,var(--ink-3) 65%) 0 0/300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shim 1.8s linear infinite}",
  "@keyframes shim{from{background-position:100% 0}to{background-position:0 0}}",
  ".rule{display:flex;align-items:center;gap:5px;padding:2px 4px 0 var(--g);border-top:1px solid var(--hair);color:var(--ink-2);font-weight:600;font-size:.92em}",
  ".rule .t{color:var(--ink-3);font-weight:500}",
  ".rule .btn{width:20px;height:20px}",
  // n, act, what, clock, ms. Newest row first. A failed act is red; no status mark.
  ".rows{grid-template-columns:auto auto minmax(0,1fr) auto auto;scrollbar-color:var(--hair) transparent;padding:1px 0 4px;max-height:280px}",
  ".row{align-items:baseline;padding:1px var(--g);transition:background-color .15s var(--ease)}",
  ".row:hover{background:var(--fill)}",
  ".row .n{grid-column:1;color:var(--ink-3);text-align:right}",
  ".row .mk{display:none}",
  ".row .cmd{grid-column:2;font-weight:600}",
  ".row.failed .cmd{color:var(--bad)}",
  ".row .what{grid-column:3;color:var(--ink-2);overflow-wrap:anywhere}",
  ".row .at{grid-column:4}",
  ".row .ms{grid-column:5}",
  ".row>:not(:first-child):not(.note){padding-left:6px}",
  ".row .at,.row .ms{color:var(--ink-3);text-align:right}",
  ".row .note{grid-column:3/-1;padding-left:6px;color:var(--ink-3);font-size:.92em;line-height:1.25}",
  ".row .note.no{color:var(--bad)}",
  ".row.new{animation:fresh 1.2s var(--ease)}",
  "@keyframes fresh{from{background-color:var(--tint)}}",
  // Narrow: the clock and the bar's words go; the act, its target and ms stay, the note takes the width.
  "@container (max-width:360px){.wrap.panel .row .at,.wrap.panel .bar .meta,.wrap.panel .bar .k,.wrap.panel .bar .state{display:none}.wrap.panel .rows .row .note{grid-column:2/-1}}",
];

/** The terminal look: the TUI as it was before the panel, kept as a mode (William, 2026-11-03). */
const TERM_CSS = [
  `.tui{font:12px/1.4 "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:${T.ink};background:${T.canvas} repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,transparent 1px 3px);border:1px solid ${T.accent};box-shadow:0 0 0 1px #000,0 10px 32px rgba(0,0,0,.55),0 0 22px rgba(165,150,214,.14);text-shadow:0 0 6px rgba(165,150,214,.22)}`,
  ".tui>*{--g:clamp(3px,1.6cqi,8px);font-size:clamp(10px,calc(8px + .9cqi),12px)}",
  `.tab{width:10px;background:${T.canvas};border:1px solid ${T.accent};border-left:0;border-radius:0 5px 5px 0;box-shadow:0 4px 14px rgba(0,0,0,.4);transition:width .15s}`,
  `.tab:hover{width:16px;background:${T.accent}}`,
  `.tab.busy::after{content:"";position:absolute;left:2px;top:25px;width:4px;height:4px;border-radius:50%;background:${T.accent};animation:tblink 1s steps(2) infinite}`,
  `.bar{gap:var(--g);padding:2px var(--g);background:${T.paper};border-bottom:1px solid ${T.accent};cursor:move}`,
  `.bar .name{font-weight:700;color:${T.accent};letter-spacing:.04em}`,
  `.bar .state{color:${T.ink3}}`,
  `.bar .state.run{color:${T.accent};animation:tblink 1s steps(2) infinite}`,
  `.bar .meta{color:${T.ink3};font-size:.88em}`,
  `.grip{width:12px;height:12px;border:0 solid ${T.accent};opacity:.45}`,
  ".tui:hover .grip{opacity:1}",
  ".grip.se{right:-1px;bottom:-1px;cursor:nwse-resize;border-width:0 2px 2px 0;opacity:1}",
  ".grip.sw{left:-1px;bottom:-1px;cursor:nesw-resize;border-width:0 0 2px 2px}",
  ".grip.ne{right:-1px;top:-1px;cursor:nesw-resize;border-width:2px 2px 0 0}",
  ".grip.nw{left:-1px;top:-1px;cursor:nwse-resize;border-width:2px 0 0 2px}",
  `.live{color:${T.ink3}}`,
  `.spin::before{content:"${SPIN[0]}";color:${T.accent};animation:tspin .8s steps(1) infinite}`,
  `.spin.slow::before{animation-duration:1.6s;color:${T.ink3}}`,
  contentKeys("tspin", SPIN),
  `.btn{color:${T.ink3};cursor:pointer;padding:0 2px}`,
  `.btn:hover{color:${T.onAccent};background:${T.accent};text-shadow:none}`,
  `.btn.on{color:${T.accent}}`,
  ".body{padding:4px var(--g) 5px}",
  `.k{color:${T.ink3}}`,
  `.goal{color:${T.ink};font-weight:700}`,
  `.thought{color:${T.ink2}}`,
  `.doing{color:${T.accent}}`,
  `.cursor{display:inline-block;width:.6em;height:1.05em;margin-left:2px;vertical-align:-2px;background:${T.accent};animation:tblink 1s steps(2) infinite}`,
  "@keyframes tblink{50%{opacity:0}}",
  `.rule{display:flex;gap:var(--g);color:${T.ink3};padding:0 var(--g);border-top:1px solid ${T.paper}}`,
  `.rule .t{color:${T.ink3}}`,
  // n, clock, act, what, ✓/✗, ms.
  `.rows{grid-template-columns:auto auto auto minmax(0,1fr) auto auto;scrollbar-color:${T.ink3} transparent;padding:1px 0 3px;max-height:220px}`,
  ".row{padding:0 var(--g)}",
  `.row .n{grid-column:1;color:${T.ink3};text-align:right}`,
  `.row .at{grid-column:2;color:${T.ink3}}`,
  `.row .cmd{grid-column:3;color:${T.accent}}`,
  `.row .what{grid-column:4;color:${T.ink}}`,
  ".row .mk{grid-column:5}",
  `.row .ms{grid-column:6;color:${T.ink3};text-align:right}`,
  ".row>:not(:first-child):not(.note){padding-left:var(--g)}",
  `.row .note{grid-column:4/-1;padding-left:var(--g);color:${T.ink3};font-size:.92em;line-height:1.3}`,
  `.row .note.no{color:${T.bad};opacity:.85}`,
  `.row .mk.ok{color:${T.good}}`,
  `.row .mk.no{color:${T.bad}}`,
  ".row.new{animation:tfresh 1.2s ease-out}",
  "@keyframes tfresh{from{background:rgba(165,150,214,.28)}to{background:transparent}}",
  // Mono and four buttons: the seed goes before it would be cut.
  "@container (max-width:480px){.wrap.term .bar .meta{display:none}}",
  "@container (max-width:360px){.wrap.term .row .at{display:none}.wrap.term .rows .row .note{grid-column:3/-1}}",
];

const CSS = [
  ...SHARED_CSS,
  ...scope(".wrap.panel", PANEL_CSS),
  ...scope(".wrap.term", TERM_CSS),
].join("");

/** How a person left the panel: carried into each new document. */
interface Prefs {
  /** Folded to a tab at the left edge. */
  min: boolean;
  trace: boolean;
  /** The boxes and the flashing target drawn; off, they are not looked up either. */
  marks: boolean;
  /** null: the system's. */
  theme: "light" | "dark" | null;
  /** The floating panel, or the old terminal look. */
  look: "panel" | "term";
  /** Top-left corner, px; null = bottom left. */
  x: number | null;
  y: number | null;
  /** Panel width and height, px; `sized` once a person dragged the grip. */
  w: number;
  h: number;
  sized: boolean;
}

/** In the page, once a document: the layer and its handlers; `ui.draw` updates it in place. */
const installScript = (attr: string, prefs: Prefs) => `(() => {
  const K = '__${attr}';
  if (window[K] && window[K].draw) return;
  const ui = window[K] = { ...${JSON.stringify(prefs)}, lastN: -1, host: null };
  ui.prefs = () => ({ min: ui.min, trace: ui.trace, marks: ui.marks, theme: ui.theme, look: ui.look, x: ui.x, y: ui.y, w: ui.w, h: ui.h, sized: ui.sized });
  const el = (tag, cls, text, css) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (css) e.style.cssText = css; return e; };
  const COLOURS = ${JSON.stringify(MARK_COLOURS)};
  const at = (b) => 'left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px;';
  // In the viewport, at least a corner of the bar.
  const clamp = () => {
    if (ui.x == null) return;
    ui.x = Math.round(Math.max(0, Math.min(innerWidth - 60, ui.x)));
    ui.y = Math.round(Math.max(0, Math.min(innerHeight - 24, ui.y)));
  };
  const host = el('div', null, null, 'position:fixed;inset:0;z-index:2147483647;pointer-events:none');
  host.setAttribute('${attr}', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style', null, ${JSON.stringify(CSS)});
  // The running command's phase words: one keyframes rule, swapped per command.
  const phase = el('style');
  const marks = el('div');
  // Folded: a tab peeking from the left edge, the page free around it.
  const tab = el('div', 'tab');
  tab.setAttribute('data-a', 'min');
  tab.title = 'autobrowse: open';
  const tui = el('div', 'tui');
  const bar = el('div', 'bar'), body = el('div', 'body'), rule = el('div', 'rule'), rows = el('div', 'rows');
  tui.append(bar, body, rule, rows);
  for (const c of ['nw', 'ne', 'sw', 'se']) {
    const g = el('div', 'grip ' + c);
    g.dataset.c = c;
    tui.appendChild(g);
  }
  const wrap = el('div', 'wrap');
  wrap.append(marks, tab, tui);
  root.append(style, phase, wrap);
  const ICONS = ${JSON.stringify(ICONS)};
  const icon = (d) => { const e = el('span'); e.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'; return e.firstChild; };
  const dark = () => ui.theme ? ui.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  // Capture on window runs before the page's document listeners and the observer.
  const KINDS = ['pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave',
    'mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave',
    'click','dblclick','auxclick','contextmenu','wheel','touchstart','touchend','touchmove','pointercancel'];
  for (const k of KINDS) window.addEventListener(k, (e) => {
    if (!ui.host || e.target !== ui.host) return;
    e.stopImmediatePropagation();
    const hit = root.elementFromPoint(e.clientX, e.clientY);
    // The grip sizes, the bar moves; capture keeps every move on us until the button lifts.
    if (k === 'pointerdown' && ui.tuiEl && hit && !hit.closest('.btn')) {
      const r = ui.tuiEl.getBoundingClientRect();
      const g = hit.closest('.grip');
      // A top or left corner moves that edge; the opposite corner stays put.
      if (g) ui.drag = { kind: 'size', x: e.clientX, y: e.clientY, r, l: g.dataset.c[1] === 'w', t: g.dataset.c[0] === 'n' };
      else if (hit.closest('.bar')) ui.drag = { kind: 'move', x: e.clientX - r.left, y: e.clientY - r.top };
      if (ui.drag) {
        ui.tuiEl.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    if (ui.drag) {
      if (k === 'pointermove' && ui.drag.kind === 'size') {
        const d = ui.drag, r = d.r, dx = e.clientX - d.x, dy = e.clientY - d.y;
        const w = d.l ? r.width - dx : r.width + dx, h = d.t ? r.height - dy : r.height + dy;
        ui.w = Math.round(Math.max(${PANEL_MIN_W}, Math.min(d.l ? r.right : innerWidth - r.left, w)));
        ui.h = Math.round(Math.max(60, Math.min(d.t ? r.bottom : innerHeight - r.top, h)));
        ui.x = Math.round(d.l ? r.right - ui.w : r.left);
        ui.y = Math.round(d.t ? r.bottom - ui.h : r.top);
        ui.sized = true;
        const st = ui.tuiEl.style;
        st.width = ui.w + 'px';
        st.height = ui.h + 'px';
        st.left = ui.x + 'px';
        st.top = ui.y + 'px';
        st.bottom = 'auto';
        ui.tuiEl.classList.add('sized');
      } else if (k === 'pointermove') {
        ui.x = e.clientX - ui.drag.x;
        ui.y = e.clientY - ui.drag.y;
        clamp();
        ui.tuiEl.style.left = ui.x + 'px';
        ui.tuiEl.style.top = ui.y + 'px';
        ui.tuiEl.style.bottom = 'auto';
      } else if (k === 'pointerup' || k === 'pointercancel') ui.drag = null;
      e.preventDefault();
      return;
    }
    // The trace scrolls by hand; the page under it never does.
    if (k === 'wheel' && hit && hit.closest('.rows')) rows.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rows.clientHeight : 1);
    // mousedown's default moves focus.
    if (k === 'mousedown' || k === 'click' || k === 'auxclick' || k === 'contextmenu' || k === 'dblclick' || k === 'wheel') e.preventDefault();
    if (k !== 'click') return;
    const a = hit && hit.closest('[data-a]');
    if (!a) return;
    const act = a.getAttribute('data-a');
    // Opening springs the panel out of the tab; folding slides the tab in.
    if (act === 'min') { ui.min = !ui.min; ui.enter = ui.min ? 'tab' : 'tui'; }
    else if (act === 'look') ui.look = ui.look === 'term' ? 'panel' : 'term';
    else if (act === 'marks') ui.marks = !ui.marks;
    else if (act === 'trace') ui.trace = !ui.trace;
    else if (act === 'theme') ui.theme = dark() ? 'light' : 'dark';
    ui.paint();
  }, { capture: true, passive: false });
  // Off for a shot: the node leaves the document; its rows and scroll come back with it.
  ui.hide = () => {
    if (!host.isConnected) return;
    ui.top = rows.scrollTop;
    host.remove();
    ui.host = null;
  };
  const show = () => {
    if (host.isConnected) return;
    document.documentElement.appendChild(host);
    ui.host = host;
    rows.scrollTop = ui.top || 0;
  };
  const rowOf = (r) => {
    const row = el('div', 'row' + (r.ok ? '' : ' failed'));
    row.appendChild(el('span', 'n num', String(r.n)));
    // ✓/✗: the terminal look's column; the panel shows a failure by its colour.
    row.appendChild(el('span', 'mk ' + (r.ok ? 'ok' : 'no'), r.ok ? '✓' : '✗'));
    row.appendChild(el('span', 'cmd', r.cmd));
    row.appendChild(el('span', 'what', r.what));
    row.appendChild(el('span', 'at num', r.at));
    row.appendChild(el('span', 'ms num', r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'));
    if (r.note) row.appendChild(el('span', 'note' + (r.ok ? '' : ' no'), r.note));
    return row;
  };
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Newest first. Scrolled down, the rows in view stay put; at the top, the newest shows.
  const add = (list, reset) => {
    if (reset) rows.textContent = '';
    // The rows as data: what a test or a later read sees.
    ui.rows = (reset ? list : (ui.rows || []).concat(list)).slice(-${TRACE_KEEP});
    if (!list.length) return;
    const was = reset ? 0 : rows.scrollTop, h = rows.scrollHeight;
    const fresh = document.createDocumentFragment();
    for (let i = list.length - 1; i >= 0; i--) fresh.appendChild(rowOf(list[i]));
    for (const old of rows.querySelectorAll('.new')) old.classList.remove('new');
    fresh.firstChild.classList.add('new');
    rows.insertBefore(fresh, rows.firstChild);
    while (rows.childElementCount > ${TRACE_KEEP}) rows.lastChild.remove();
    rows.scrollTop = was > 0 ? was + rows.scrollHeight - h : 0;
    // At the top, the new rows push the list down: one transform per row in view, no layout.
    const dh = rows.scrollHeight - h;
    if (!reset && was === 0 && dh > 0 && ui.look !== 'term' && !still()) {
      const kids = [...rows.children].slice(0, 24), o = { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' };
      kids.forEach((k, i) => k.animate(i < list.length
        ? [{ transform: 'translateY(-' + dh + 'px)', opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'translateY(-' + dh + 'px)' }, { transform: 'none' }], o));
    }
  };
  ui.paint = () => {
    const s = ui.s;
    show();
    const term = ui.look === 'term';
    // A command's phase words run on from when it began, across redraws.
    if (s.busy && !ui.wasBusy) ui.since = Date.now();
    ui.wasBusy = s.busy;
    const since = ((Date.now() - (ui.since || Date.now())) / 1000).toFixed(2);
    if (phase.textContent !== s.ph.keys) phase.textContent = s.ph.keys;
    wrap.className = 'wrap ' + (term ? 'term' : 'panel ' + (dark() ? 'dark' : 'light'));
    // Boxes redrawn only when they change: a redraw never restarts the target's lock-on.
    const mk = JSON.stringify([ui.marks, s.boxes, s.target]);
    if (mk !== ui.marksKey) {
      ui.marksKey = mk;
      marks.textContent = '';
      if (ui.marks) {
        for (const { n, box } of s.boxes) {
          const c = COLOURS[n % COLOURS.length];
          const b = el('div', 'box', null, at(box) + 'border-color:' + c);
          b.appendChild(el('div', 'tag', String(n), (box.y < 16 ? 'top:0' : 'top:-16px') + ';background:' + c));
          marks.appendChild(b);
        }
        const t = s.target;
        if (t) marks.appendChild(el('div', 'target', null, at(t) + '--sx:' + (1 + 16 / Math.max(t.w, 1)).toFixed(3) + ';--sy:' + (1 + 16 / Math.max(t.h, 1)).toFixed(3)));
      }
    }
    const enter = ui.enter;
    ui.enter = null;
    let panel = tab;
    if (ui.min) {
      tui.style.display = 'none';
      tab.style.display = '';
      tab.className = 'tab' + (s.busy ? ' busy' : '') + (enter === 'tab' ? ' enter' : '');
      ui.tuiEl = null;
    } else {
      tab.style.display = 'none';
      clamp();
      const place = ui.x == null ? 'left:12px;bottom:12px' : 'left:' + ui.x + 'px;top:' + ui.y + 'px';
      tui.className = 'tui' + (s.busy ? ' busy' : '') + (ui.sized ? ' sized' : '') + (enter === 'tui' ? ' enter' : '');
      tui.style.cssText = place + ';width:' + ui.w + 'px' + (ui.sized ? ';height:' + ui.h + 'px' : '');
      ui.tuiEl = panel = tui;
      bar.textContent = '';
      body.textContent = '';
      rule.textContent = '';
      const tbtn = (a, t, tip, cls) => { const b = el('span', 'btn' + (cls ? ' ' + cls : ''), t); b.setAttribute('data-a', a); b.title = tip; return b; };
      const btn = (a, d, tip, cls) => { const b = el('span', 'btn' + (cls ? ' ' + cls : '')); b.appendChild(icon(d)); b.setAttribute('data-a', a); b.title = tip; return b; };
      if (term) {
        bar.appendChild(el('span', 'name', '▌autobrowse'));
        bar.appendChild(el('span', 'state' + (s.busy ? ' run' : ''), s.busy ? '● run' : '○ idle'));
        if (s.step) bar.appendChild(el('span', 'k', 'step ' + s.step));
        bar.appendChild(el('span', 'fill'));
        if (s.meta) bar.appendChild(el('span', 'meta', s.meta));
        bar.appendChild(tbtn('look', '[▤]', 'panel look'));
        bar.appendChild(tbtn('marks', ui.marks ? '[◆]' : '[◇]', ui.marks ? 'hide the boxes' : 'show the boxes', ui.marks ? 'on' : ''));
        bar.appendChild(tbtn('min', '[_]', 'minimize'));
        const line = (k, cls, t) => { const d = el('div'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', cls, t)); return d; };
        if (s.goal) body.appendChild(line('goal ', 'goal', s.goal));
        if (s.thought) body.appendChild(line('» ', 'thought', s.thought));
        if (s.doing) body.appendChild(line('$ ', 'doing', s.doing));
        const live = el('div', 'live');
        if (s.busy) {
          live.appendChild(el('span', 'spin'));
          live.appendChild(el('span', 'phase', ' ', '--d:' + s.ph.n * ${PHASE_S} + 's;--t:-' + since + 's'));
          live.appendChild(el('span', 'dots'));
        } else if (s.goal) {
          live.appendChild(el('span', 'spin slow'));
          live.appendChild(el('span', '', ' thinking'));
          live.appendChild(el('span', 'dots'));
        } else {
          live.appendChild(el('span', 'k', '$ waiting for the agent'));
          live.appendChild(el('span', 'cursor'));
        }
        body.appendChild(live);
        rule.appendChild(el('span', 't', '─ trace'));
        rule.appendChild(el('span', 't', String(s.count)));
        rule.appendChild(el('span', 'fill', null, 'flex:1'));
        rule.appendChild(tbtn('trace', ui.trace ? '[▾]' : '[▸]', ui.trace ? 'fold the trace' : 'show the trace'));
      } else {
        bar.appendChild(el('span', 'name', 'autobrowse'));
        bar.appendChild(el('span', 'state' + (s.busy ? ' run' : ''), s.busy ? 'Running' : 'Idle'));
        if (s.step) bar.appendChild(el('span', 'k', 'Step ' + s.step));
        if (s.meta) bar.appendChild(el('span', 'meta num', s.meta));
        bar.appendChild(el('span', 'fill'));
        bar.appendChild(btn('look', ICONS.term, 'Terminal look'));
        bar.appendChild(btn('marks', ICONS.boxes, ui.marks ? 'Hide the boxes' : 'Show the boxes', ui.marks ? 'on' : ''));
        bar.appendChild(btn('theme', dark() ? ICONS.sun : ICONS.moon, dark() ? 'Light' : 'Dark'));
        bar.appendChild(btn('min', ICONS.min, 'Minimize'));
        // Words that changed since the last draw rise in; the rest hold still.
        const seen = ui.seen || {};
        ui.seen = { goal: s.goal, thought: s.thought, doing: s.doing };
        const fade = (k) => (seen[k] !== s[k] ? ' in' : '');
        if (s.goal) body.appendChild(el('div', 'goal' + fade('goal'), s.goal));
        if (s.thought) body.appendChild(el('div', 'thought' + fade('thought'), s.thought));
        if (s.doing) {
          // "click: open the pricing page": the verb as a chip.
          const i = s.doing.indexOf(': ');
          const d = el('div', 'doing' + fade('doing'));
          if (i > 0) d.appendChild(el('span', 'verb', s.doing.slice(0, i)));
          d.appendChild(el('span', '', i > 0 ? s.doing.slice(i + 2) : s.doing));
          body.appendChild(d);
        }
        // The busy line: the hands' phase while a command runs; between commands, the agent's turn.
        // The shimmer runs on the wall clock, so a redraw continues it instead of restarting it.
        const live = el('div', 'live');
        const shim = (t) => el('span', 'shim', t, 'animation-delay:-' + ((Date.now() % 1800) / 1000).toFixed(2) + 's');
        if (s.busy) {
          const w = shim();
          w.append(el('span', 'phase', '', '--d:' + s.ph.n * ${PHASE_S} + 's;--t:-' + since + 's'), el('span', 'dots'));
          live.appendChild(w);
        } else if (s.goal) {
          const w = shim('Thinking');
          w.appendChild(el('span', 'dots'));
          live.appendChild(w);
        } else live.appendChild(el('span', '', 'Waiting for the agent'));
        body.appendChild(live);
        rule.appendChild(el('span', '', 'Activity'));
        rule.appendChild(el('span', 't num', String(s.count)));
        rule.appendChild(el('span', 'fill', null, 'flex:1'));
        rule.appendChild(btn('trace', ICONS.chevron, ui.trace ? 'Fold the activity' : 'Show the activity', ui.trace ? '' : 'folded'));
      }
      rows.style.display = ui.trace && s.count ? '' : 'none';
    }
    // Inert only when the agent's press could land on the panel; 16px of room around it.
    const r = panel.getBoundingClientRect(), a = s.aim, m = 16;
    const under = !a || (a.x < r.right + m && a.x + a.w > r.left - m && a.y < r.bottom + m && a.y + a.h > r.top - m);
    if (s.held || (s.aimed && under)) panel.classList.add('inert');
    return ui.prefs();
  };
  /** \`from\`: the newest row the caller thinks the page holds; -1 sends them all. */
  ui.draw = (s, list, from, last) => {
    if (from >= 0 && from !== ui.lastN) return { need: true };
    ui.s = s;
    show();
    add(list, from < 0);
    ui.lastN = last;
    return ui.paint();
  };
})()`;

/** Sentence case for a phase word. */
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const clipLine = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** One session's overlay; `enabled` false makes every call a no-op. */
export function overlayFor(startOn: boolean) {
  // `toggle` flips it for the session's life.
  let enabled = startOn;
  // A random attribute name: the page sees a node, never one that names us.
  const attr = `data-o${randomBytes(4).toString("hex")}`;
  let state: OverlayState = { ...EMPTY };
  let drawn = false;
  /** Commands and holds in flight, nested (a flow's steps inside its `flow` command): held or not. */
  const running: boolean[] = [];
  const settle = () => {
    state.busy = running.length > 0;
    state.held = running.includes(true);
  };
  let prefs: Prefs = {
    min: false,
    trace: true,
    marks: true,
    theme: null,
    look: "panel",
    x: null,
    y: null,
    w: 460,
    h: 320,
    sized: false,
  };
  /** The newest row the page holds; -1: none known, so the next draw sends every row. */
  let sentN = -1;
  const run = (page: Page, script: string) =>
    Promise.race([
      page.evaluate(script).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), DRAW_MS).unref()),
    ]);
  const K = `window['__${attr}']`;
  /** Each draw sends the state and the rows the page lacks; a new document gets the layer first. */
  const paint = async (page: Page, s: OverlayState | undefined) => {
    if (!s) {
      const got = await run(
        page,
        `(() => { const ui = ${K}; if (ui && ui.hide) { ui.hide(); return ui.prefs(); } })()`,
      );
      if (got && typeof got === "object") prefs = got as Prefs;
      return;
    }
    const { trace, ...rest } = s;
    const words = PHASES[s.cmd ?? ""];
    const view = {
      ...rest,
      count: trace.length,
      ph: { keys: contentKeys("ph", (words ?? ["working"]).map(cap)), n: words?.length ?? 1 },
    };
    const last = trace.at(-1)?.n ?? 0;
    const call = (from: number) => {
      const rows = trace.filter((r) => r.n > from).map(({ detail: _, ...r }) => r);
      return `(() => { const ui = ${K}; return ui && ui.draw ? ui.draw(${JSON.stringify(view)}, ${JSON.stringify(rows)}, ${from}, ${last}) : 'gone'; })()`;
    };
    let got = await run(page, call(sentN));
    if (got === "gone") {
      await run(page, installScript(attr, prefs));
      got = await run(page, call(-1));
    } else if (got && typeof got === "object" && "need" in got) got = await run(page, call(-1));
    if (got && typeof got === "object" && !("need" in got)) {
      prefs = got as Prefs;
      sentN = last;
    }
  };
  const draw = async (page: Page) => {
    if (!enabled) return;
    await paint(page, state);
    drawn = true;
    drawsOn(page, (fn) => off(page, fn));
  };
  /** `fn` runs with the layer off: a screenshot shows the page, not us. */
  const off = async <T>(page: Page, fn: () => Promise<T>): Promise<T> => {
    if (!enabled || !drawn) return fn();
    await paint(page, undefined);
    try {
      return await fn();
    } finally {
      await draw(page);
    }
  };
  /** The boxes button as the page has it now: a click since the last draw counts. */
  const marksOn = async (page: Page): Promise<boolean> => {
    const on = await Promise.race([
      page.evaluate(`(window['__${attr}'] || {}).marks`).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), BOX_MS).unref()),
    ]);
    if (typeof on === "boolean") prefs = { ...prefs, marks: on };
    return prefs.marks;
  };
  const boxOf = async (page: Page, hints: Hints): Promise<Box | null> => {
    const b = await locate(page, hints)
      .boundingBox({ timeout: BOX_MS })
      .catch(() => null);
    if (!b) return null;
    const view = page.viewportSize();
    if (view && (b.x + b.width < 0 || b.y + b.height < 0 || b.x > view.width || b.y > view.height))
      return null;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  return {
    get enabled() {
      return enabled;
    },
    /** On or off at any time; off takes the layer down and keeps the trace for when it comes back. */
    async toggle(page: Page, on: boolean): Promise<{ drawn: boolean }> {
      enabled = on;
      if (on) await draw(page);
      else if (drawn) {
        drawn = false;
        await paint(page, undefined);
      }
      return { drawn: on };
    },
    /** Panel fields from a caller (the agent's goal, step, thought); `refs` boxes the outline's controls. */
    async set(
      page: Page,
      patch: {
        [K in "goal" | "step" | "thought" | "doing"]?: string | null | undefined;
      } & {
        refs?: Array<{ n: number; hints: Hints }> | undefined;
        clear?: boolean | undefined;
      },
    ): Promise<{ drawn: boolean; boxes?: number }> {
      if (!enabled) return { drawn: false };
      const { refs, clear, ...fields } = patch;
      if (clear)
        state = {
          ...EMPTY,
          trace: state.trace,
          busy: state.busy,
          held: state.held,
          cmd: state.cmd,
          meta: state.meta,
        };
      for (const [k, v] of Object.entries(fields))
        if (v !== undefined) (state as unknown as Record<string, unknown>)[k] = clipLine(v, 240);
      if (refs && !(await marksOn(page))) state.boxes = [];
      else if (refs) {
        const boxes = await Promise.all(refs.map((r) => boxOf(page, r.hints)));
        state.boxes = refs.flatMap((r, i) => {
          const box = boxes[i];
          return box ? [{ n: r.n, box }] : [];
        });
      }
      await draw(page);
      // Boxes off: no count, so a 0 never reads as controls missing.
      return { drawn: true, ...(prefs.marks ? { boxes: state.boxes.length } : {}) };
    },
    /** A marks shot's numbered boxes stay on the page; the boxes button shows and hides them. */
    async marked(page: Page, boxes: Array<{ n: number; box: Box }>): Promise<void> {
      if (!enabled) return;
      state.boxes = boxes;
      await draw(page);
    },
    /** The bar's right side (seed, pace); drawn with the next change. */
    tag(meta: string | null): void {
      state.meta = meta;
    },
    /** A command starts; one whose points are not known ahead makes the panel inert before it can press. */
    async begin(page: Page, cmd?: string): Promise<void> {
      if (!enabled) return;
      running.push(!cmd || !(READS_ONLY.has(cmd) || AIMED.has(cmd)));
      settle();
      state.cmd = cmd ?? null;
      if (drawn) await draw(page);
    },
    /** A command ended: its row joins the trace and the panel takes clicks again. */
    async end(page: Page, row: Omit<TraceRow, "n" | "at">): Promise<void> {
      if (!enabled) return;
      const n = (state.trace.at(-1)?.n ?? 0) + 1;
      const at = new Date().toTimeString().slice(0, 8);
      state.trace = [...state.trace, { ...row, n, at }].slice(-TRACE_KEEP);
      running.pop();
      settle();
      if (!state.busy) state.cmd = null;
      // The row holds the act now; the line waits for the next.
      state.doing = null;
      await draw(page);
    },
    /** Hands that may touch the page outside a command (a wait that clears a banner, a scroll): inert, no row. */
    async hold<T>(page: Page, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      const was = state.held;
      running.push(true);
      settle();
      if (!was && drawn) await draw(page);
      try {
        return await fn();
      } finally {
        running.pop();
        settle();
        if (!was && drawn) await draw(page);
      }
    },
    /** Before an act: the target flashes and the panel says what is done. */
    /** `thought`: the act's goal; it stays on the panel until the next one. */
    async flash(page: Page, hints: Hints, doing: string, thought?: string): Promise<void> {
      if (!enabled) return;
      if (thought) state.thought = clipLine(thought, 240);
      // Looked up with boxes off too: it decides whether the panel lets the press through.
      state.aim = await boxOf(page, hints);
      state.aimed = true;
      state.target = (await marksOn(page)) ? state.aim : null;
      state.doing = clipLine(doing, 160);
      await draw(page);
    },
    /** After an act: the page may have changed, so its boxes go; the panel stays. */
    async after(page: Page): Promise<void> {
      if (!enabled || !drawn) return;
      state.target = null;
      state.aim = null;
      state.aimed = false;
      state.boxes = [];
      await draw(page);
    },
    /** A new document wiped the layer: the panel comes back, without boxes. */
    async loaded(page: Page): Promise<void> {
      if (!drawn) return;
      return this.after(page);
    },
    around: off,
    /** The session ends: nothing of ours stays on the page. */
    async remove(page: Page): Promise<void> {
      if (!drawn) return;
      drawn = false;
      state = { ...EMPTY };
      sentN = -1;
      drawsOn(page, null);
      await paint(page, undefined);
    },
  };
}

export type Overlay = ReturnType<typeof overlayFor>;

const hintLabel = (h: Record<string, unknown>): string => {
  const said = h.name ?? h.text ?? h.placeholder ?? h.id ?? h.testId ?? h.href ?? h.css;
  return [h.role, said === undefined ? null : `"${String(said)}"`, h.mark ? `mark ${h.mark}` : null]
    .filter(Boolean)
    .join(" ");
};

/** Host and path: a query string may carry a token. */
const shortUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
};

/** What a command left: the page before and after, and its answer. */
export interface TraceSeen {
  from: string;
  to: string;
  answer?: unknown;
}

/** The dim line: counts and a path, never a value read or typed. */
function noteOf(c: Command, failed: unknown, seen: TraceSeen | undefined): string {
  if (failed)
    return (
      clipLine((failed instanceof Error ? failed.message : String(failed)).split("\n")[0], 90) ?? ""
    );
  if (!seen) return "";
  const a = (seen.answer ?? {}) as Record<string, unknown>;
  const ch = a.changed as { added?: unknown[]; gone?: number; more?: number } | undefined;
  const added = (ch?.added?.length ?? 0) + (ch?.more ?? 0);
  return [
    seen.to !== seen.from ? `→ ${shortUrl(seen.to)}` : null,
    ch && (added || ch.gone) ? `+${added} −${ch.gone ?? 0} controls` : ch ? "no change" : null,
    typeof a.text === "string" ? `${a.text.length} chars read` : null,
    typeof a.aria === "string" ? `${a.aria.split("\n").length} lines` : null,
    c.cmd === "type" || c.cmd === "fill" || c.cmd === "place" ? "typed, value hidden" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A command as one trace row: what it aimed at, never a typed value. */
export function traceRow(
  c: Command,
  failed: unknown,
  ms: number,
  seen?: TraceSeen,
): Omit<TraceRow, "n" | "at"> {
  const f = c as unknown as Record<string, unknown>;
  const hints = (f.hints ?? null) as Record<string, unknown> | null;
  const aim =
    c.cmd === "open"
      ? shortUrl(String(f.url))
      : c.cmd === "place"
        ? `${String(f.secret)} → ${hints ? hintLabel(hints) : "focus"}`
        : c.cmd === "type"
          ? `${String(f.text ?? "").length} chars`
          : c.cmd === "key" || c.cmd === "press"
            ? String(f.key)
            : c.cmd === "batch"
              ? `${(f.cmds as unknown[]).length} commands`
              : c.cmd === "os"
                ? String((f.act as { kind?: string }).kind)
                : String(f.as ?? f.env ?? f.name ?? f.outcome ?? (hints ? hintLabel(hints) : ""));
  const what = typeof f.goal === "string" && f.goal ? `${f.goal} · ${aim}` : aim;
  const detail = [
    ...(hints ? [`target ${JSON.stringify(hints)}`] : []),
    ...(failed
      ? [`error ${clipLine(failed instanceof Error ? failed.message : String(failed), 400)}`]
      : []),
  ];
  return {
    cmd: c.cmd,
    what: clipLine(what, 200) ?? "",
    ok: !failed,
    ms: Math.round(ms),
    note: noteOf(c, failed, seen),
    detail,
  };
}
