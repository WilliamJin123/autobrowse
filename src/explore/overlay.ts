/**
 * The headed overlay (designs/2026-10-27-explore-gaps.md, 2026-11-04-overlay-out-of-page.md):
 * what the agent sees and why it acts, for a person who watches. Boxes carry the outline's ref
 * numbers, or a marks shot's (its colours, kept until the next act); the control about to be
 * acted on flashes; a panel holds the goal, the thought, the act and a live trace.
 *
 * Out of the page: a native macOS window (`overlay-host.ts`) glued over the Chrome window's
 * viewport draws all of it. No node, style, global or main-world script of ours in the page;
 * geometry is read through CDP in an isolated world. A person's click on the panel never reaches
 * the page, an agent's CDP press never meets the panel, and no CDP shot or film has it.
 * Headless or off macOS, nothing is drawn.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import { type Hints, locate } from "../browser/locate.js";
import type { Command } from "./commands.js";
import { type Box, MARK_COLOURS } from "./marks.js";
import { type HostEvent, nativeHost, type OverlayHost } from "./overlay-host.js";

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
  /** The running command: picks its phase words. */
  cmd: string | null;
  /** The bar's right side: seed, pace. */
  meta: string | null;
  trace: TraceRow[];
  /** A yes-or-no for the person at the window (keep a sign-in): two buttons, answered once. */
  ask: { id: number; text: string; yes: string; no: string } | null;
}

const EMPTY: OverlayState = {
  goal: null,
  step: null,
  thought: null,
  doing: null,
  boxes: [],
  target: null,
  busy: false,
  cmd: null,
  meta: null,
  trace: [],
  ask: null,
};

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
  "html,body{margin:0;background:transparent;overflow:hidden;height:100%}",
  ".wrap{--hair:color-mix(in srgb,var(--ink) 11%,transparent);--fill:color-mix(in srgb,var(--ink) 5%,transparent);--tint:color-mix(in srgb,var(--accent) 12%,transparent);--ease:cubic-bezier(.16,1,.3,1);--spring:cubic-bezier(.34,1.4,.64,1)}",
  `.wrap.light{${THEMES.light}}`,
  `.wrap.dark{${THEMES.dark}}`,
  `.wrap.term{--accent:${T.accent}}`,
  // As the marks shot draws them (marks.ts layerScript); `.marks` scales page px to the window's.
  ".marks{position:fixed;left:0;top:0;transform-origin:0 0}",
  ".box{position:absolute;border:2px solid}",
  ".tag{position:absolute;left:-2px;font:bold 11px/14px monospace;color:#fff;padding:0 3px}",
  // The target locks on (from 8px out), then a ring leaves it; --sx/--sy: 8px of scale per side.
  ".target{position:absolute;border:2px solid var(--accent);border-radius:6px;animation:aim .32s var(--spring) both}",
  '.target::after{content:"";position:absolute;inset:-2px;border:2px solid var(--accent);border-radius:8px;opacity:0;animation:ring 1.3s var(--ease) .15s infinite}',
  "@keyframes aim{from{opacity:0;transform:scale(var(--sx),var(--sy))}}",
  "@keyframes ring{from{opacity:.6;transform:none}to{opacity:0;transform:scale(var(--sx),var(--sy))}}",
  "svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}",
  ".tui{position:fixed;display:flex;flex-direction:column;max-width:calc(100vw - 12px);cursor:default;user-select:none;-webkit-user-select:none;container-type:inline-size}",
  ".tab{position:fixed;left:0;top:50%;transform:translateY(-50%);height:56px;cursor:pointer}",
  ".bar{display:flex;align-items:center;white-space:nowrap}",
  ".bar .fill{flex:1}",
  ".grip{position:absolute}",
  // a button in a corner (trace folded, minimize) takes the press, not the grip under it
  ".btn{position:relative;z-index:1}",
  '.phase::after{content:"";animation:ph var(--d) steps(1) forwards;animation-delay:var(--t)}',
  '.dots::after{content:"";animation:dots 1.8s steps(1) infinite}',
  contentKeys("dots", ["", ".", "..", "..."]),
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
  // after the folding panel reaches the edge
  ".tab.enter.late{animation-delay:.24s;animation-fill-mode:backwards}",
  "@keyframes peek{from{transform:translate(-100%,-50%)}}",
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
  ".doing>:last-child{font-weight:600}",
  ".verb{flex:none;color:var(--accent);background:var(--tint);border-radius:5px;padding:0 5px;font-weight:500;font-size:.92em;line-height:1.45}",
  // A line whose words changed rises in; the same words redrawn stay still.
  ".in{animation:rise .24s var(--ease)}",
  "@keyframes rise{from{opacity:0;transform:translateY(3px)}}",
  ".live{color:var(--ink-3);font-size:.92em}",
  // A question: tinted, outlined; the yes filled in the accent.
  ".ask{margin:4px 0 2px;padding:6px 8px;border-radius:9px;background:var(--tint);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 30%,transparent);display:flex;flex-wrap:wrap;align-items:center;gap:6px;overflow-wrap:anywhere}",
  ".ask .q{flex:1 1 160px;font-weight:600}",
  ".ask .go{flex:none;padding:2px 10px;border-radius:999px;cursor:pointer;font-weight:600;color:var(--ink-2);background:var(--fill)}",
  ".ask .go.yes{color:var(--on-accent);background:var(--accent)}",
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
  // the target leads, the verb follows (William, 11-04)
  ".row .cmd{grid-column:2;color:var(--ink-3)}",
  ".row .what{grid-column:3;font-weight:600;overflow-wrap:anywhere}",
  ".row.failed .what{color:var(--bad)}",
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
  `.ask{margin:2px 0;border:1px solid ${T.accent};padding:2px 4px;display:flex;flex-wrap:wrap;gap:6px}`,
  ".ask .q{flex:1 1 160px}",
  `.ask .go{cursor:pointer;color:${T.accent}}`,
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

/**
 * The panel's document, in the native window's web view (overlay-host.ts): the boxes and the
 * panel, sized to the viewport. Only the panel's rect takes the mouse; it posts that rect and
 * the prefs to the host after each change.
 */
export const panelHtml = (
  prefs: Prefs,
) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style><style id="ph"></style></head><body><script>(() => {
  const ui = window.ui = { ...${JSON.stringify(prefs)} };
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
  // The running command's phase words: one keyframes rule, swapped per command.
  const phase = document.getElementById('ph');
  const marks = el('div', 'marks');
  // Folded: a tab peeking from the left edge.
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
  document.body.append(wrap);
  const ICONS = ${JSON.stringify(ICONS)};
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); return s; };
  const dark = () => ui.theme ? ui.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  // The host: the rect that takes the mouse, and the prefs (boxes on or off) for the session.
  const post = () => {
    const r = (ui.min ? tab : tui).getBoundingClientRect();
    const m = { rect: [r.x, r.y, r.width, r.height], prefs: ui.prefs() };
    if (ui.answer) { m.answer = ui.answer; ui.answer = null; }
    try { window.webkit.messageHandlers.host.postMessage(m); } catch {}
  };
  // a rect read mid-animation (peek, spring) is not where it lands
  for (const n of [tab, tui]) for (const k of ['animationend', 'transitionend']) n.addEventListener(k, post);
  // The grip sizes, the bar moves; capture keeps every move on us until the button lifts.
  tui.addEventListener('pointerdown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('.btn')) return;
    const r = tui.getBoundingClientRect();
    const g = t.closest('.grip');
    // A top or left corner moves that edge; the opposite corner stays put.
    if (g) ui.drag = { kind: 'size', x: e.clientX, y: e.clientY, r, l: g.dataset.c[1] === 'w', t: g.dataset.c[0] === 'n' };
    else if (t.closest('.bar')) ui.drag = { kind: 'move', x: e.clientX - r.left, y: e.clientY - r.top };
    if (ui.drag) { tui.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  tui.addEventListener('pointermove', (e) => {
    const d = ui.drag;
    if (!d) return;
    const st = tui.style;
    if (d.kind === 'size') {
      const r = d.r, dx = e.clientX - d.x, dy = e.clientY - d.y;
      const w = d.l ? r.width - dx : r.width + dx, h = d.t ? r.height - dy : r.height + dy;
      ui.w = Math.round(Math.max(${PANEL_MIN_W}, Math.min(d.l ? r.right : innerWidth - r.left, w)));
      ui.h = Math.round(Math.max(60, Math.min(d.t ? r.bottom : innerHeight - r.top, h)));
      ui.x = Math.round(d.l ? r.right - ui.w : r.left);
      ui.y = Math.round(d.t ? r.bottom - ui.h : r.top);
      ui.sized = true;
      st.width = ui.w + 'px';
      st.height = ui.h + 'px';
      tui.classList.add('sized');
    } else {
      ui.x = e.clientX - d.x;
      ui.y = e.clientY - d.y;
      clamp();
    }
    st.left = ui.x + 'px';
    st.top = ui.y + 'px';
    st.bottom = 'auto';
  });
  const drop = () => { if (ui.drag) { ui.drag = null; post(); } };
  tui.addEventListener('pointerup', drop);
  tui.addEventListener('pointercancel', drop);
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('[data-a]') : null;
    if (!a || !ui.s) return;
    const act = a.getAttribute('data-a');
    // Opening springs the panel out of the tab; folding slides the tab in.
    if (act === 'min') { ui.min = !ui.min; ui.enter = ui.min ? 'tab' : 'tui'; }
    else if (act === 'look') ui.look = ui.look === 'term' ? 'panel' : 'term';
    else if (act === 'marks') ui.marks = !ui.marks;
    else if (act === 'trace') ui.trace = !ui.trace;
    else if (act === 'theme') ui.theme = dark() ? 'light' : 'dark';
    else if ((act === 'yes' || act === 'no') && ui.s.ask) { ui.answer = { id: ui.s.ask.id, yes: act === 'yes' }; ui.s.ask = null; }
    ui.paint();
  });
  // The viewport (the window) changed size: the panel stays in it.
  addEventListener('resize', () => { if (ui.s) ui.paint(); });
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
    const term = ui.look === 'term';
    // A command's phase words run on from when it began, across redraws.
    if (s.busy && !ui.wasBusy) ui.since = Date.now();
    ui.wasBusy = s.busy;
    const since = ((Date.now() - (ui.since || Date.now())) / 1000).toFixed(2);
    if (phase.textContent !== s.ph.keys) phase.textContent = s.ph.keys;
    wrap.className = 'wrap ' + (term ? 'term' : 'panel ' + (dark() ? 'dark' : 'light'));
    // Page px to window px: the page's zoom over ours.
    marks.style.transform = 'scale(' + (s.dpr || devicePixelRatio) / devicePixelRatio + ')';
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
    // Fold and open: the panel shrinks into the tab and grows out of it (panel look only).
    const genie = !term && !still();
    // the tab's point in the panel's own px (layout box: a running animation does not move it)
    const toTab = () => (-tui.offsetLeft) + 'px ' + (innerHeight / 2 - tui.offsetTop) + 'px';
    const FOLDED = 'scale(.03,.14)';
    if (ui.min) {
      let late = false;
      if (enter === 'tab' && genie && ui.tuiEl) {
        // a copy folds; the real panel is gone at once, so the host's rect is the tab's
        ui.ghost?.remove();
        const g = ui.ghost = tui.cloneNode(true);
        g.style.pointerEvents = 'none';
        g.style.transformOrigin = toTab();
        wrap.appendChild(g);
        g.animate([
          { transform: 'none', opacity: 1 },
          { transform: 'scale(.42,.6)', opacity: .95, offset: .55 },
          { transform: FOLDED, opacity: 0 },
        ], { duration: 300, easing: 'cubic-bezier(.55,0,.8,.2)', fill: 'forwards' }).onfinish = () => g.remove();
        late = true;
      }
      tui.style.display = 'none';
      tab.style.display = '';
      tab.className = 'tab' + (s.busy ? ' busy' : '') + (enter === 'tab' ? ' enter' + (late ? ' late' : '') : '');
      ui.tuiEl = null;
    } else {
      tab.style.display = 'none';
      clamp();
      const place = ui.x == null ? 'left:12px;bottom:12px' : 'left:' + ui.x + 'px;top:' + ui.y + 'px';
      tui.className = 'tui' + (s.busy ? ' busy' : '') + (ui.sized ? ' sized' : '');
      // a redraw mid-open keeps the origin
      tui.style.cssText = place + ';width:' + ui.w + 'px' + (ui.sized ? ';height:' + ui.h + 'px' : '') + (ui.origin ? ';transform-origin:' + ui.origin : '');
      if (enter === 'tui' && genie) {
        ui.ghost?.remove();
        tui.style.transformOrigin = ui.origin = toTab();
        tui.animate([
          { transform: FOLDED, opacity: 0 },
          { opacity: 1, offset: .3 },
          { transform: 'none', opacity: 1 },
        ], { duration: 420, easing: 'cubic-bezier(.2,1.12,.36,1)' }).onfinish = () => { ui.origin = null; post(); };
      }
      ui.tuiEl = tui;
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
      if (s.ask) {
        const q = el('div', 'ask');
        q.appendChild(el('span', 'q', s.ask.text));
        const go = (a, t) => { const b = el('span', 'go ' + a, term ? '[' + t + ']' : t); b.setAttribute('data-a', a); return b; };
        q.append(go('yes', s.ask.yes), go('no', s.ask.no));
        body.appendChild(q);
      }
      rows.style.display = ui.trace && s.count ? '' : 'none';
    }
    post();
    return ui.prefs();
  };
  /** \`reset\`: the rows are all of them, not the new ones. */
  ui.draw = (s, list, reset) => {
    if (s.ask && s.ask.id !== ui.askId) { ui.askId = s.ask.id; if (ui.min) { ui.min = false; ui.enter = 'tui'; } }
    ui.s = s;
    add(list, reset);
    return ui.paint();
  };
})()</script></body></html>`;

/** Sentence case for a phase word. */
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const clipLine = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** Where the page's window is and how its viewport sits in it; read through CDP, never in the page's world. */
export interface Geometry {
  /** The browser process: tells several Chromes apart. 0: unknown. */
  pid: number;
  windowId: number;
  bounds: { x: number; y: number; w: number; h: number };
  view: { outerW: number; outerH: number; innerW: number; innerH: number; dpr: number };
}

const cdps = new WeakMap<Page, { cdp: CDPSession; world?: number | undefined }>();
const pids = new WeakMap<BrowserContext, Promise<number>>();
const VIEW =
  "({outerW:outerWidth,outerH:outerHeight,innerW:innerWidth,innerH:innerHeight,dpr:devicePixelRatio})";

const pidOf = (ctx: BrowserContext): Promise<number> => {
  let p = pids.get(ctx);
  if (!p) {
    p = (async () => {
      const s = await ctx.browser()?.newBrowserCDPSession();
      if (!s) return 0;
      const r = (await s.send("SystemInfo.getProcessInfo")) as {
        processInfo: Array<{ type: string; id: number }>;
      };
      await s.detach().catch(() => undefined);
      return r.processInfo.find((x) => x.type === "browser")?.id ?? 0;
    })().catch(() => 0);
    pids.set(ctx, p);
  }
  return p;
};

/** An isolated world's read: the page's own getters, observers and CSP never see it. */
async function inWorld(c: { cdp: CDPSession; world?: number | undefined }): Promise<unknown> {
  for (let i = 0; i < 2; i++) {
    if (c.world === undefined) {
      const { frameTree } = (await c.cdp.send("Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      const w = (await c.cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "autobrowse-overlay",
      })) as { executionContextId: number };
      c.world = w.executionContextId;
    }
    const r = (await c.cdp
      .send("Runtime.evaluate", { contextId: c.world, expression: VIEW, returnByValue: true })
      .catch(() => null)) as { result?: { value?: unknown }; exceptionDetails?: unknown } | null;
    if (r?.result?.value && !r.exceptionDetails) return r.result.value;
    // a new document took the world with it
    c.world = undefined;
  }
  return null;
}

export async function geometryOf(page: Page): Promise<Geometry | null> {
  try {
    let c = cdps.get(page);
    if (!c) {
      c = { cdp: await page.context().newCDPSession(page) };
      cdps.set(page, c);
    }
    const [{ windowId, bounds }, view, pid] = await Promise.all([
      c.cdp.send("Browser.getWindowForTarget") as Promise<{
        windowId: number;
        bounds: { left?: number; top?: number; width?: number; height?: number };
      }>,
      inWorld(c),
      pidOf(page.context()),
    ]);
    if (!view) return null;
    const b = {
      x: bounds.left ?? 0,
      y: bounds.top ?? 0,
      w: bounds.width ?? 0,
      h: bounds.height ?? 0,
    };
    return { pid, windowId, bounds: b, view: view as Geometry["view"] };
  } catch {
    // not Chromium, or the page went
    return null;
  }
}

/** A host that draws but never finds Chrome's window: under Wayland, its windows are not X11's. */
const NOT_FOUND = "the overlay cannot find Chrome's window (Wayland?)";
const FOUND_MS = 3_000;

export interface OverlayDeps {
  /** The window that draws; default the native host (macOS). */
  host?: (why: (reason: string) => void) => Promise<OverlayHost | null>;
  /** Default `geometryOf`. */
  geometry?: (page: Page) => Promise<Geometry | null>;
}

/** One session's overlay; `enabled` false makes every call a no-op. */
export function overlayFor(startOn: boolean, deps: OverlayDeps = {}) {
  // `toggle` flips it for the session's life.
  let enabled = startOn;
  let state: OverlayState = { ...EMPTY };
  let drawn = false;
  /** Commands in flight, nested (a flow's steps inside its `flow` command). */
  let running = 0;
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
  /** The newest row the window holds; -1: none, so the next draw sends every row. */
  let sentN = -1;
  let host: OverlayHost | null = null;
  let opening: Promise<OverlayHost | null> | null = null;
  /** Why nothing is drawn: no host for this platform, Wayland, a host that died. */
  let why: string | null = null;
  /** The page the window follows, and the Chrome window it was matched to. */
  let followed: Page | null = null;
  let windowKey: string | null = null;
  let dpr = 0;
  /** Targets sent, and the newest the host found: a gap past FOUND_MS sets `why`. */
  let targets = 0;
  let found = 0;
  const geometry = deps.geometry ?? geometryOf;
  /** Questions out, by id: the panel's button answers one. */
  const asking = new Map<number, (yes: boolean | null) => void>();
  let askN = 0;
  const answered = (id: number, yes: boolean | null) => {
    const done = asking.get(id);
    if (!done) return;
    asking.delete(id);
    if (state.ask?.id === id) state.ask = null;
    done(yes);
  };

  const onEvent = (e: HostEvent) => {
    const a = e.t === "js" ? (e.answer as { id?: unknown; yes?: unknown } | undefined) : undefined;
    if (a && typeof a.id === "number") answered(a.id, a.yes === true);
    if (e.t === "js" && e.prefs && typeof e.prefs === "object") prefs = e.prefs as Prefs;
    // Chrome's window changed size (full screen, an infobar) or went: measure again.
    else if (e.t === "lost") windowKey = null;
    else if (e.t === "found") {
      found = targets;
      if (why === NOT_FOUND) why = null;
    }
    if ((e.t === "moved" || e.t === "lost") && followed) void place(followed);
  };
  const open = (): Promise<OverlayHost | null> => {
    if (opening) return opening;
    const p: Promise<OverlayHost | null> = (deps.host ?? nativeHost)((r) => {
      why = r;
    }).then((h) => {
      // closed while it started: this host is nobody's, so it goes
      if (opening !== p) {
        h?.close();
        return null;
      }
      host = h;
      if (h) {
        h.on(onEvent);
        // toggled off while it started: that `hide` found no host
        if (!enabled) h.send({ t: "hide" });
        h.send({ t: "html", html: panelHtml(prefs) });
      }
      return h;
    });
    opening = p;
    return p;
  };
  const close = () => {
    host?.close();
    host = null;
    opening = null;
    followed = null;
    windowKey = null;
    sentN = -1;
  };
  /** The window over the page's viewport: which Chrome window, and its insets now. */
  const place = async (page: Page) => {
    const g = await Promise.race([
      geometry(page),
      new Promise<null>((r) => setTimeout(() => r(null), DRAW_MS).unref()),
    ]);
    if (!g || !host) return;
    const key = `${g.pid}:${g.windowId}`;
    if (key !== windowKey) {
      windowKey = key;
      host.send({ t: "target", pid: g.pid, ...g.bounds });
      const n = ++targets;
      setTimeout(() => {
        if (host && targets === n && found < n) why = NOT_FOUND;
      }, FOUND_MS).unref();
    }
    host.send({ t: "view", ...g.view });
    dpr = g.view.dpr;
  };
  /** Each draw sends the state and the rows the window lacks. */
  const paint = async (page: Page): Promise<boolean> => {
    // before the host starts: a context closed meanwhile still ends it
    if (followed !== page) {
      followed = page;
      windowKey = null;
      page.once("close", () => {
        if (followed === page) host?.send({ t: "hide" });
      });
      page.context().once("close", close);
    }
    const h = await open();
    if (!h) return false;
    await place(page);
    const { trace, ...rest } = state;
    const words = PHASES[state.cmd ?? ""];
    const view = {
      ...rest,
      dpr,
      count: trace.length,
      ph: { keys: contentKeys("ph", (words ?? ["working"]).map(cap)), n: words?.length ?? 1 },
    };
    const last = trace.at(-1)?.n ?? 0;
    const rows = trace.filter((r) => r.n > sentN).map(({ detail: _, ...r }) => r);
    h.send({
      t: "js",
      js: `ui.draw(${JSON.stringify(view)}, ${JSON.stringify(rows)}, ${sentN < 0})`,
    });
    sentN = last;
    return true;
  };
  const draw = async (page: Page): Promise<boolean> => {
    if (!enabled) return false;
    drawn = await paint(page);
    return drawn;
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
    /** Why nothing is drawn while on (no host, Wayland, a host that died); null when it draws. */
    get why() {
      return why;
    },
    /** On or off at any time; off hides the window and keeps the trace for when it comes back. */
    async toggle(page: Page, on: boolean): Promise<{ drawn: boolean; why?: string }> {
      enabled = on;
      if (!on) {
        host?.send({ t: "hide" });
        drawn = false;
        return { drawn: false };
      }
      host?.send({ t: "show" });
      const ok = await draw(page);
      return ok ? { drawn: true } : { drawn: false, ...(why ? { why } : {}) };
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
    ): Promise<{ drawn: boolean; boxes?: number; why?: string }> {
      if (!enabled) return { drawn: false };
      const { refs, clear, ...fields } = patch;
      if (clear)
        state = {
          ...EMPTY,
          trace: state.trace,
          busy: state.busy,
          cmd: state.cmd,
          meta: state.meta,
          ask: state.ask,
        };
      for (const [k, v] of Object.entries(fields))
        if (v !== undefined) (state as unknown as Record<string, unknown>)[k] = clipLine(v, 240);
      if (refs && !prefs.marks) state.boxes = [];
      else if (refs) {
        const boxes = await Promise.all(refs.map((r) => boxOf(page, r.hints)));
        state.boxes = refs.flatMap((r, i) => {
          const box = boxes[i];
          return box ? [{ n: r.n, box }] : [];
        });
      }
      if (!(await draw(page))) return { drawn: false, ...(why ? { why } : {}) };
      // Boxes off: no count, so a 0 never reads as controls missing.
      return { drawn: true, ...(prefs.marks ? { boxes: state.boxes.length } : {}) };
    },
    /** A marks shot's numbered boxes stay drawn; the boxes button shows and hides them. */
    async marked(page: Page, boxes: Array<{ n: number; box: Box }>): Promise<void> {
      if (!enabled) return;
      state.boxes = boxes;
      await draw(page);
    },
    /** The bar's right side (seed, pace); drawn with the next change. */
    tag(meta: string | null): void {
      state.meta = meta;
    },
    /** A command starts: the busy line runs its phase words. */
    async begin(page: Page, cmd?: string): Promise<void> {
      if (!enabled) return;
      running++;
      state.busy = true;
      state.cmd = cmd ?? null;
      if (drawn) await draw(page);
    },
    /** A command ended: its row joins the trace. */
    async end(page: Page, row: Omit<TraceRow, "n" | "at">): Promise<void> {
      if (!enabled) return;
      const n = (state.trace.at(-1)?.n ?? 0) + 1;
      const at = new Date().toTimeString().slice(0, 8);
      state.trace = [...state.trace, { ...row, n, at }].slice(-TRACE_KEEP);
      running = Math.max(0, running - 1);
      state.busy = running > 0;
      if (!state.busy) state.cmd = null;
      // The row holds the act now; the line waits for the next.
      state.doing = null;
      await draw(page);
    },
    /** Before an act: the target flashes (boxes on) and the panel says what is done. */
    /** `thought`: the act's goal; it stays on the panel until the next one. */
    async flash(page: Page, hints: Hints, doing: string, thought?: string): Promise<void> {
      if (!enabled) return;
      if (thought) state.thought = clipLine(thought, 240);
      state.target = prefs.marks ? await boxOf(page, hints) : null;
      state.doing = clipLine(doing, 160);
      await draw(page);
    },
    /** After an act: the page may have changed, so its boxes go; the panel stays. */
    async after(page: Page): Promise<void> {
      if (!enabled || !drawn) return;
      state.target = null;
      state.boxes = [];
      await draw(page);
    },
    /** A new document: its boxes go. */
    async loaded(page: Page): Promise<void> {
      if (!drawn) return;
      return this.after(page);
    },
    /**
     * A yes-or-no on the panel; true on the yes button, false on the no. null at once when
     * nothing draws (off, no host), or when `ms` pass unanswered.
     */
    async ask(
      page: Page,
      text: string,
      o: { yes?: string; no?: string; ms?: number } = {},
    ): Promise<boolean | null> {
      if (!enabled) return null;
      const id = ++askN;
      const answer = new Promise<boolean | null>((resolve) => asking.set(id, resolve));
      state.ask = {
        id,
        text: clipLine(text, 240) ?? "",
        yes: o.yes ?? "Keep",
        no: o.no ?? "Not now",
      };
      if (!(await draw(page))) {
        answered(id, null);
        return null;
      }
      const late = setTimeout(() => {
        answered(id, null);
        if (followed) void draw(followed);
      }, o.ms ?? 180_000);
      late.unref();
      const yes = await answer;
      clearTimeout(late);
      if (followed && drawn) await draw(followed);
      return yes;
    },
    /** The session ends: the window goes and its process exits. */
    async remove(_page: Page): Promise<void> {
      for (const id of [...asking.keys()]) answered(id, null);
      drawn = false;
      state = { ...EMPTY };
      running = 0;
      close();
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
  const ch = a.changed as
    | { added?: unknown[]; gone?: number; more?: number; changed?: unknown[] }
    | undefined;
  const added = (ch?.added?.length ?? 0) + (ch?.more ?? 0);
  const flips = ch?.changed?.length ?? 0;
  const n = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).length : null);
  const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return [
    seen.to !== seen.from ? `→ ${shortUrl(seen.to)}` : null,
    ch && (added || ch.gone)
      ? `+${added} −${ch.gone ?? 0} controls`
      : ch && !flips
        ? "no change"
        : null,
    // P6: state only ([empty] -> [filled]), never a value
    flips ? plural(flips, "state change") : null,
    n("pageErrors") ? plural(n("pageErrors") ?? 0, "page error") : null,
    a.article === true ? "article" : a.article === false ? "not an article" : null,
    typeof a.text === "string" ? `${a.text.length} chars read` : null,
    c.cmd === "errors" && typeof a.total === "number" ? plural(a.total, "page error") : null,
    c.cmd === "proof" && n("flags") !== null ? plural(n("flags") ?? 0, "flag") : null,
    // network: counts only; bodies and cookies stay out of the panel
    c.cmd === "network" && n("calls") !== null ? plural(n("calls") ?? 0, "call group") : null,
    c.cmd === "network" && n("found") !== null
      ? `found in ${plural(n("found") ?? 0, "call")}`
      : null,
    c.cmd === "network" && "body" in a ? "1 call, body hidden" : null,
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
