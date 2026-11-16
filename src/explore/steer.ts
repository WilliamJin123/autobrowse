/**
 * A person's steering of an agent session (designs/2026-11-16-autocomp-desktop.md D2): the panel's
 * Pause and Resume, the agent's own pause, notes, and the refusal of a command sent before a person
 * acted. One copy for explore (a page) and the desktop session (a window); the scene says where.
 */

/** What a resume compares: where the agent's hand is, and the controls there. */
export interface Scene {
  /** A page URL, or the front window (app plus id). */
  where(): string | Promise<string>;
  /** The controls, masked; null when this scene cannot list them. */
  rows(): Promise<string[] | null>;
  /** `where` as an answer shows it. */
  short(where: string): string;
  /** The answer's key for `where`: `url` or `window`. */
  key: string;
  /** In the notes: "page" or "window". */
  noun: string;
  /**
   * What counts as the person acting while paused: their counted acts (a page's recorder sees each),
   * or any change of the rows (a window has no recorder). Default "hand".
   */
  actedBy?: "hand" | "change";
}

export type SteerRow = { kind: "pause" } | { kind: "resume" } | { kind: "note"; text: string };

/** The person's Pause or Resume from the panel, or a note to the agent. */
export type Steer = { pause: boolean } | { note: string };

export interface SteerDeps {
  scene: Scene;
  journal(row: SteerRow): void;
  /** Draw the held state on the panel; null clears it. */
  held(h: { since: number; arming: boolean } | null): Promise<void>;
  /** Notes the person wrote since the last answer; taking them marks them read. */
  takeNotes(): string[];
  /** Commands in flight. */
  busy(): number;
  now(): number;
  change(before: readonly string[], after: readonly string[]): PageChange;
  redact(text: string): string;
  /** How long the panel's Pause holds a command; default 10 min (under cmd.sh's 900 s resend). */
  holdMs?: number;
}

const HOLD_MS = 600_000;
/** Rows the diff returns; `snapshot` has the rest. */
const CHANGED_ROWS = 40;

export interface PageChange {
  /** Interactive elements (one `snapshot` row each) that are new since before the act. */
  added: string[];
  /** How many rows went away. */
  gone: number;
  /** Rows still there whose state changed (`[checked]`, `[disabled]`, `[filled]`…): `row: [old] -> [new]`. */
  changed?: string[];
  /** Added rows past the cap. */
  more?: number;
}

/** What an act changed, as a multiset diff of snapshot rows. */
export function pageChange(before: readonly string[], after: readonly string[]): PageChange {
  const left = new Map<string, number>();
  for (const r of before) left.set(r, (left.get(r) ?? 0) + 1);
  const fresh: string[] = [];
  for (const r of after) {
    const n = left.get(r) ?? 0;
    if (n) left.set(r, n - 1);
    else fresh.push(r);
  }
  // a gone row and a new row alike but for state: one row that changed
  const goneBy = new Map<string, string[]>();
  for (const [r, n] of left)
    for (let i = 0; i < n; i++) goneBy.set(rowKey(r), [...(goneBy.get(rowKey(r)) ?? []), r]);
  const added: string[] = [];
  const changed: string[] = [];
  for (const r of fresh) {
    const was = goneBy.get(rowKey(r))?.shift();
    if (was === undefined) added.push(r);
    else {
      left.set(was, (left.get(was) ?? 0) - 1);
      changed.push(`${rowKey(r)}: ${rowState(was) || "[]"} -> ${rowState(r) || "[]"}`);
    }
  }
  const gone = [...left.values()].reduce((a, b) => a + b, 0);
  return {
    added: added.slice(0, CHANGED_ROWS),
    gone,
    ...(changed.length ? { changed: changed.slice(0, CHANGED_ROWS) } : {}),
    ...(added.length > CHANGED_ROWS ? { more: added.length - CHANGED_ROWS } : {}),
  };
}

// an aria line with children ends in `:` after its state
const STATE_TAIL = /(?: \[[^\]]*\])+:?$/;
/** A snapshot row without its trailing `[state]` tokens. */
const rowKey = (r: string) => r.replace(STATE_TAIL, "");
const rowState = (r: string) => (STATE_TAIL.exec(r)?.[0] ?? "").replace(/:$/, "").trim();

const changedAny = (c: PageChange | null): boolean =>
  !!c && (c.added.length > 0 || c.gone > 0 || (c.changed?.length ?? 0) > 0);

export function steering(d: SteerDeps) {
  const { scene, journal, now } = d;
  const holdMs = d.holdMs ?? HOLD_MS;
  let paused = false;
  /** Who paused: the agent's own `pause`, or the person's Pause on the panel (only they resume it). */
  let pausedBy: "agent" | "person" | null = null;
  let waiters: Array<() => void> = [];
  /** Acts a person did by hand since the last pause. */
  let handActs = 0;
  /** Pause pressed while a command ran: it takes hold when that command ends (a flow or batch included). */
  let holdArmed = false;
  /** The scene when the person paused: what their resume compares. */
  let holdFrom: { since: number; where: string; rows: string[] | null } | null = null;
  /** The last person pause, resumed: a command sent before `at` answers with it instead of running. */
  let steered: { at: number; acted: boolean; view: Record<string, unknown> } | null = null;
  /** The pause's scene capture, while it runs. */
  let capturing: Promise<void> = Promise.resolve();

  const resume = () => {
    paused = false;
    pausedBy = null;
    for (const w of waiters) w();
    waiters = [];
  };
  const unpaused = () =>
    paused ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve();

  const personPause = async () => {
    holdArmed = false;
    paused = true;
    pausedBy = "person";
    handActs = 0;
    const since = now();
    // a resume during the capture waits for it: else it has nothing to compare
    capturing = (async () => {
      holdFrom = {
        since,
        where: await scene.where(),
        rows: await scene.rows().catch(() => null),
      };
    })();
    await capturing;
    journal({ kind: "pause" });
    journal({ kind: "note", text: "a person paused the agent from the panel" });
    await d.held({ since, arming: false });
  };
  const personResume = async () => {
    if (holdArmed && !paused) {
      holdArmed = false;
      await d.held(null);
      return;
    }
    if (pausedBy !== "person") return;
    await capturing;
    const from = holdFrom ?? { since: now(), where: await scene.where(), rows: null };
    holdFrom = null;
    const where = await scene.where();
    const after = from.rows ? await scene.rows().catch(() => null) : null;
    const changed = from.rows && after ? d.change(from.rows, after) : null;
    const moved = where !== from.where;
    steered = {
      at: now(),
      acted: handActs > 0 || moved || (scene.actedBy === "change" && changedAny(changed)),
      view: {
        pausedS: Math.round((now() - from.since) / 1000),
        acts: handActs,
        ...(moved ? { from: scene.short(from.where) } : {}),
        [scene.key]: scene.short(where),
        ...(changed ? { changed } : {}),
      },
    };
    journal({ kind: "resume" });
    resume();
    await d.held(null);
  };

  return {
    paused: () => paused,
    pausedBy: () => pausedBy,
    handActs: () => handActs,
    /** A person's act while paused (the page's recorder); the session decides what counts. */
    handAct() {
      handActs++;
    },
    unpaused,
    /** Resolves when nobody holds the session. */
    resumed: unpaused,
    /** The agent's `pause`: null when it paused, else the answer (the person holds it). */
    agentPause(): { paused: true; by: "person" } | null {
      if (pausedBy === "person") return { paused: true, by: "person" };
      paused = true;
      pausedBy = "agent";
      handActs = 0;
      journal({ kind: "pause" });
      return null;
    },
    /** The agent's `resume`. */
    agentResume():
      | { paused: true; by: "person"; note: string }
      | { paused: false; handActs: number } {
      if (pausedBy === "person")
        return {
          paused: true,
          by: "person",
          note: "A person paused you from the panel; only they resume it. Your next command waits for them.",
        };
      journal({ kind: "resume" });
      resume();
      return { paused: false, handActs };
    },
    /** The panel's buttons and note box. */
    onSteer(s: Steer): void {
      if ("note" in s) {
        journal({ kind: "note", text: `person: ${d.redact(s.note)}` });
        return;
      }
      if (!s.pause) return void personResume();
      if (paused) {
        // the agent's own pause becomes the person's: only they resume it now
        pausedBy = "person";
        const since = now();
        capturing = (async () => {
          holdFrom ??= {
            since,
            where: await scene.where(),
            rows: await scene.rows().catch(() => null),
          };
        })();
        void capturing.then(() => d.held({ since, arming: false }));
      } else if (d.busy() > 0) {
        holdArmed = true;
        void d.held({ since: now(), arming: true });
      } else void personPause();
    },
    /** A command just ended: Pause pressed mid-command takes hold now, before the next one starts. */
    async afterCommand(): Promise<void> {
      if (d.busy() === 0 && holdArmed) await personPause();
    },
    /** A command under the person's Pause: held until Resume, then refused if they changed things. */
    async heldAnswer(arrived: number): Promise<unknown | null> {
      // held under Pause: it came before the resume, whatever the clock says (same ms)
      const wasHeld = pausedBy === "person";
      if (wasHeld) {
        const since = holdFrom?.since ?? now();
        const go = await Promise.race([
          unpaused().then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), holdMs).unref()),
        ]);
        if (!go)
          return {
            ok: false,
            held: true,
            steer: {
              pausedS: Math.round((now() - since) / 1000),
              note: "A person paused you from the panel and has not resumed in 10 min. Your command did not run; send it again later.",
            },
          };
      }
      if (!steered || (!wasHeld && arrived >= steered.at)) return null;
      const notes = d.takeNotes();
      if (!steered.acted && !notes.length) return null;
      return {
        ran: false,
        steer: {
          ...steered.view,
          ...(notes.length ? { notes } : {}),
          note: `A person paused you from the panel and acted or wrote to you. Your command did not run. Read the ${scene.noun} and their notes, then go on from where they left it.`,
        },
      };
    },
  };
}

export type Steering = ReturnType<typeof steering>;
