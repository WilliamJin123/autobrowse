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

/** Lucide paths (ISC), 24-unit box, drawn at one size and stroke. */
const ICONS = {
  boxes:
    "M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1",
  moon: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  min: "M5 12h14",
  chevron: "m6 9 6 6 6-6",
  ok: "M20 6 9 17l-5-5",
  no: "M18 6 6 18M6 6l12 12",
};

/** How a person left the panel: carried into each new document. */
interface Prefs {
  /** Folded to a tab at the left edge. */
  min: boolean;
  trace: boolean;
  /** The boxes and the flashing target drawn; off, they are not looked up either. */
  marks: boolean;
  /** null: the system's. */
  theme: "light" | "dark" | null;
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
  ui.prefs = () => ({ min: ui.min, trace: ui.trace, marks: ui.marks, theme: ui.theme, x: ui.x, y: ui.y, w: ui.w, h: ui.h, sized: ui.sized });
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
  const style = el('style', null, [
        '*{box-sizing:border-box}',
        '.wrap{--hair:color-mix(in srgb,var(--ink) 11%,transparent);--fill:color-mix(in srgb,var(--ink) 5%,transparent);--tint:color-mix(in srgb,var(--accent) 12%,transparent);--ease:cubic-bezier(.16,1,.3,1)}',
        '.wrap.light{${THEMES.light}}',
        '.wrap.dark{${THEMES.dark}}',
        // As the marks shot draws them (marks.ts layerScript).
        '.box{position:fixed;border:2px solid}',
        '.tag{position:absolute;left:-2px;font:bold 11px/14px monospace;color:#fff;padding:0 3px}',
        '.target{position:fixed;border:2px solid var(--accent);border-radius:6px;animation:pulse 1.1s var(--ease) infinite}',
        '@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}100%{box-shadow:0 0 0 12px transparent}}',
        'svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}',
        // A floating panel: frosted paper, hairline, lifted. The whole panel takes the pointer.
        '.tui,.tab{background:color-mix(in srgb,var(--paper) 86%,transparent);-webkit-backdrop-filter:blur(24px) saturate(1.8);backdrop-filter:blur(24px) saturate(1.8)}',
        '.tui{position:fixed;display:flex;flex-direction:column;max-width:calc(100vw - 12px);cursor:default;user-select:none;-webkit-user-select:none;',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Figtree,system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;',
        'border-radius:14px;box-shadow:var(--raise),var(--lift)}',
        // Width scales the type and the inset: 13px wide open, 11px at the narrowest.
        '.tui{container-type:inline-size}',
        '.tui>*{--g:clamp(8px,3cqi,12px);font-size:clamp(11px,calc(9px + .9cqi),13px)}',
        '.tui:not(.inert){pointer-events:auto}',
        '.tui.inert{opacity:.6}',
        '.tab{position:fixed;left:0;top:50%;transform:translateY(-50%);width:14px;height:56px;cursor:pointer;border-radius:0 10px 10px 0;box-shadow:var(--raise),var(--lift);transition:width .2s var(--ease)}',
        '.tab:not(.inert){pointer-events:auto}',
        '.tab:hover{width:20px}',
        '.tab::after{content:"";position:absolute;left:5px;top:18px;width:3px;height:20px;border-radius:2px;background:var(--hair)}',
        '.tab.busy::after{top:25px;width:6px;height:6px;left:4px;border-radius:50%;background:var(--accent);animation:beat 1.2s var(--ease) infinite}',
        '@keyframes beat{50%{opacity:.45}}',
        '.bar{display:flex;align-items:center;gap:8px;padding:8px 6px 4px var(--g);cursor:grab;white-space:nowrap}',
        '.bar .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ink-3);opacity:.5}',
        '.bar .dot.run{background:var(--accent);opacity:1;animation:beat 1.2s var(--ease) infinite}',
        '.bar .name{font-weight:650;letter-spacing:-.01em}',
        '.bar .state,.bar .k{min-width:0;color:var(--ink-3);overflow:hidden}',
        '.bar .fill{flex:1}',
        '.rule .meta{color:var(--ink-3);font-weight:400;font-size:.92em;font-variant-numeric:tabular-nums}',
        '.btn{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:999px;color:var(--ink-2);cursor:pointer;transition:background .15s var(--ease),color .15s var(--ease)}',
        '.btn:hover{background:var(--fill);color:var(--ink)}',
        '.btn.on{color:var(--accent)}',
        '.btn.on:hover{background:var(--tint)}',
        '.btn.folded svg{transform:rotate(-90deg)}',
        // Corners size the panel; no mark, and they straddle the rounded edge, as a macOS window's.
        '.grip{position:absolute;width:18px;height:18px}',
        '.grip.se{right:-4px;bottom:-4px;cursor:nwse-resize}.grip.sw{left:-4px;bottom:-4px;cursor:nesw-resize}',
        '.grip.ne{right:-4px;top:-4px;cursor:nesw-resize}.grip.nw{left:-4px;top:-4px;cursor:nwse-resize}',
        '.body{display:flex;flex-direction:column;gap:4px;padding:4px var(--g) 12px}',
        '.goal{font-weight:650;font-size:1.08em;line-height:1.3;letter-spacing:-.01em;overflow-wrap:anywhere}',
        '.thought{color:var(--ink-2);overflow-wrap:anywhere}',
        '.doing{display:flex;align-items:baseline;gap:6px;overflow-wrap:anywhere}',
        '.verb{flex:none;color:var(--accent);background:var(--tint);border-radius:6px;padding:0 6px;font-weight:600;font-size:.92em;line-height:1.5}',
        '.live{display:flex;align-items:center;gap:6px;color:var(--ink-3);font-size:.92em;margin-top:2px}',
        '.spin{flex:none;width:11px;height:11px;border-radius:50%;border:1.5px solid var(--hair);border-top-color:var(--accent);animation:spin .8s linear infinite}',
        '.spin.slow{animation-duration:1.6s;border-top-color:var(--ink-3)}',
        '@keyframes spin{to{transform:rotate(1turn)}}',
        '.phase::after{content:"";animation:ph var(--d) steps(1) forwards;animation-delay:var(--t)}',
        '.dots::after{content:"";animation:dots 1.8s steps(1) infinite}',
        '${contentKeys("dots", ["", ".", "..", "..."])}',
        '.rule{display:flex;align-items:center;gap:6px;padding:4px 6px 2px var(--g);border-top:1px solid var(--hair);color:var(--ink-2);font-weight:600;font-size:.92em}',
        '.rule .t{color:var(--ink-3);font-weight:500;font-variant-numeric:tabular-nums}',
        '.rule .btn{pointer-events:auto;width:24px;height:24px}',
        '.tui.inert .rule .btn{pointer-events:none}',
        '.rows{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto auto;align-content:start;overflow-y:auto;overflow-anchor:none;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--hair) transparent;padding:0 0 6px;max-height:220px}',
        '.tui.sized .rows{flex:1;min-height:0;max-height:none}',
        // Hover fill inset and rounded; the words keep the panel's inset.
        '.row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:baseline;margin:0 6px;padding:5px calc(var(--g) - 6px);border-radius:8px;transition:background .15s var(--ease)}',
        '.row:hover{background:var(--fill)}',
        '.row .st{grid-column:1;align-self:center;display:grid;place-items:center;width:14px;height:14px;border-radius:50%;color:var(--paper)}',
        '.row .st svg{width:10px;height:10px;stroke-width:3}',
        '.row .st.ok{background:var(--good)}.row .st.no{background:var(--bad)}',
        '.row .cmd{grid-column:2;font-weight:600}.row .what{grid-column:3;color:var(--ink-2);overflow-wrap:anywhere}.row .at{grid-column:4}.row .ms{grid-column:5}',
        '.row>:not(:first-child):not(.note){padding-left:8px}',
        '.row .at,.row .ms{color:var(--ink-3);font-size:.88em;font-variant-numeric:tabular-nums;text-align:right}',
        '.row .note{grid-column:3/-1;padding-left:8px;color:var(--ink-3);font-size:.88em;line-height:1.3;overflow-wrap:anywhere}',
        '.row .note.no{color:var(--bad)}',
        // Narrow: the clock and the seed go; the act, its target, the mark and ms stay, the note takes the width.
        '@container (max-width:360px){.row .at,.rule .meta,.bar .k,.bar .state{display:none}.rows .row .note{grid-column:2/-1}}',
        '.row.new{animation:fresh 1.2s var(--ease)}',
        '@keyframes fresh{from{background:var(--tint)}}',
  ].join(''));
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
    if (act === 'min') ui.min = !ui.min;
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
    const row = el('div', 'row');
    const st = el('span', 'st ' + (r.ok ? 'ok' : 'no'));
    st.appendChild(icon(r.ok ? ICONS.ok : ICONS.no));
    st.title = r.ok ? 'done' : 'failed';
    row.appendChild(st);
    row.appendChild(el('span', 'cmd', r.cmd));
    row.appendChild(el('span', 'what', r.what));
    row.appendChild(el('span', 'at', r.at));
    row.appendChild(el('span', 'ms', r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'));
    if (r.note) row.appendChild(el('span', 'note' + (r.ok ? '' : ' no'), r.note));
    return row;
  };
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
  };
  ui.paint = () => {
    const s = ui.s;
    show();
    // A command's phase words run on from when it began, across redraws.
    if (s.busy && !ui.wasBusy) ui.since = Date.now();
    ui.wasBusy = s.busy;
    const since = ((Date.now() - (ui.since || Date.now())) / 1000).toFixed(2);
    if (phase.textContent !== s.ph.keys) phase.textContent = s.ph.keys;
    wrap.className = 'wrap ' + (dark() ? 'dark' : 'light');
    marks.textContent = '';
    if (ui.marks) {
      for (const { n, box } of s.boxes) {
        const c = COLOURS[n % COLOURS.length];
        const b = el('div', 'box', null, at(box) + 'border-color:' + c);
        b.appendChild(el('div', 'tag', String(n), (box.y < 16 ? 'top:0' : 'top:-16px') + ';background:' + c));
        marks.appendChild(b);
      }
      if (s.target) marks.appendChild(el('div', 'target', null, at(s.target)));
    }
    let panel = tab;
    if (ui.min) {
      tui.style.display = 'none';
      tab.style.display = '';
      tab.className = 'tab' + (s.busy ? ' busy' : '');
      ui.tuiEl = null;
    } else {
      tab.style.display = 'none';
      clamp();
      const place = ui.x == null ? 'left:12px;bottom:12px' : 'left:' + ui.x + 'px;top:' + ui.y + 'px';
      tui.className = 'tui' + (s.busy ? ' busy' : '') + (ui.sized ? ' sized' : '');
      tui.style.cssText = place + ';width:' + ui.w + 'px' + (ui.sized ? ';height:' + ui.h + 'px' : '');
      ui.tuiEl = panel = tui;
      bar.textContent = '';
      bar.appendChild(el('span', 'dot' + (s.busy ? ' run' : '')));
      bar.appendChild(el('span', 'name', 'autobrowse'));
      bar.appendChild(el('span', 'state', s.busy ? 'Running' : 'Idle'));
      if (s.step) bar.appendChild(el('span', 'k', 'Step ' + s.step));
      bar.appendChild(el('span', 'fill'));
      const btn = (a, d, tip, cls) => { const b = el('span', 'btn' + (cls ? ' ' + cls : '')); b.appendChild(icon(d)); b.setAttribute('data-a', a); b.title = tip; return b; };
      bar.appendChild(btn('marks', ICONS.boxes, ui.marks ? 'Hide the boxes' : 'Show the boxes', ui.marks ? 'on' : ''));
      bar.appendChild(btn('theme', dark() ? ICONS.sun : ICONS.moon, dark() ? 'Light' : 'Dark'));
      bar.appendChild(btn('min', ICONS.min, 'Minimize'));
      body.textContent = '';
      if (s.goal) body.appendChild(el('div', 'goal', s.goal));
      if (s.thought) body.appendChild(el('div', 'thought', s.thought));
      if (s.doing) {
        // "click: open the pricing page": the verb as a chip.
        const i = s.doing.indexOf(': ');
        const d = el('div', 'doing');
        if (i > 0) d.appendChild(el('span', 'verb', s.doing.slice(0, i)));
        d.appendChild(el('span', '', i > 0 ? s.doing.slice(i + 2) : s.doing));
        body.appendChild(d);
      }
      // The busy line: the hands' phase while a command runs; between commands, the agent's turn.
      const live = el('div', 'live');
      if (s.busy) {
        live.appendChild(el('span', 'spin'));
        const w = el('span');
        w.append(el('span', 'phase', '', '--d:' + s.ph.n * ${PHASE_S} + 's;--t:-' + since + 's'), el('span', 'dots'));
        live.appendChild(w);
      } else if (s.goal) {
        live.appendChild(el('span', 'spin slow'));
        const w = el('span', '', 'Thinking');
        w.appendChild(el('span', 'dots'));
        live.appendChild(w);
      } else live.appendChild(el('span', '', 'Waiting for the agent'));
      body.appendChild(live);
      rule.textContent = '';
      rule.appendChild(el('span', '', 'Activity'));
      rule.appendChild(el('span', 't', String(s.count)));
      rule.appendChild(el('span', 'fill', null, 'flex:1'));
      if (s.meta) rule.appendChild(el('span', 'meta', s.meta));
      rule.appendChild(btn('trace', ICONS.chevron, ui.trace ? 'Fold the activity' : 'Show the activity', ui.trace ? '' : 'folded'));
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
