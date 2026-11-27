/**
 * A walk as data: the screens a goal passes through on a site, each known by
 * its URL shape and landmarks, each with the ops done there. Built from runs
 * that reached the goal (walks/build.ts) and run by one interpreter
 * (walks/flow.ts) as a screens walk (browser/screens.ts): the page decides
 * which screen comes next, so a run that took another branch adds a screen,
 * not a script. Plain JSON a person can edit, one file per walk:
 * `walks/<site>/<name>.json` beside the owner's other state.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { CODE_KINDS } from "../auth/codes.js";
import { PROVIDERS } from "../auth/providers.js";
import { fieldSchema, hintsSchema, opSchema, valueSchema } from "../compiler/outline.js";
import { baseSite } from "../runs/log.js";

/** 2 adds profile values, field defaults and options, and `{field}` in URLs, hints and selects. 1 still loads. */
export const WALK_VERSION = 2;
/** How deep walks may nest: a walk op inside a walk inside a walk… */
export const MAX_DEPTH = 4;
/** Rows one `each` op runs, at most. */
export const MAX_EACH = 500;

const NAME = /^[a-z][a-z0-9-]*$/;
const SITE = /^[a-z0-9][a-z0-9._-]*$/i;
/** `/source/flags`, or a plain source matched without case. */
export function regexOf(s: string): RegExp {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1] as string, m[2]) : new RegExp(s, "i");
}

/** A regex as a string, checked on load (`regexOf`). */
export const patternSchema = z.string().refine((s) => {
  try {
    regexOf(s);
    return true;
  } catch {
    return false;
  }
}, "not a regular expression");

/** A placed secret's name as the explore server takes it: `code`, `google.password`, `google-admin.code`. */
const SECRET_KEY = /^[a-z][\w-]*(@[\w-]+)?(\.[a-zA-Z]\w*)*$/;

/** Who runs it: the same walk fills in whoever's profile is loaded (`--profile`). */
export const PROFILE_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "phoneLocal",
  "birthday",
  "gender",
  "address1",
  "address2",
  "city",
  "region",
  "regionCode",
  "postal",
  "country",
  "countryName",
] as const;
export type ProfileFieldName = (typeof PROFILE_FIELDS)[number];

/** A typed value: plan field, secret, literal, or (v2) the runner's profile. */
export const walkValueSchema = z.union([
  ...valueSchema.options,
  z.object({ from: z.literal("profile"), field: z.enum(PROFILE_FIELDS) }),
]);
export type WalkValue = z.infer<typeof walkValueSchema>;

/** A field's default: the text, or a day relative to the run (`today+3d`, `today-1d MM/DD/YYYY`). */
export const RELATIVE_DAY = /^today([+-]\d+)d(?: (YYYY-MM-DD|MM\/DD\/YYYY))?$/;
export const walkFieldSchema = fieldSchema.extend({
  /** Used when the run is given none; absent: the run asks for it. */
  default: z.string().optional(),
  /** The values it may take (a select's options). */
  options: z.array(z.string()).optional(),
});
export type WalkField = z.infer<typeof walkFieldSchema>;

/** `{key}` in an open URL, a click's hints or a select's value: that field's value. */
export const FIELD_REF = /\{([a-z][a-zA-Z0-9]*)\}/g;

/** `name` on this site, or `site/name`. */
const WALK_REF = /^([a-z0-9][a-z0-9._-]*\/)?[a-z][a-z0-9-]*$/;

const [clickOp, fillOp, selectOp, pressOp, uploadOp, ...restOps] = opSchema.options;

/** One whole field, `{key}`: its value is the thing (a URL, a match number). */
const WHOLE_REF = /^\{[a-z][a-zA-Z0-9]*\}$/;
const AS = /^[a-z][a-zA-Z0-9]*$/;

/** A click's `nth` may be a field (`{nth}`): which of the matches, per row of an `each`. */
const walkHintsSchema = hintsSchema.extend({
  nth: z
    .union([z.number().int().nonnegative(), z.string().regex(WHOLE_REF)])
    .nullable()
    .optional(),
});

/** The outline's ops, plus what a walk adds: a page to open, a captcha, another walk. */
export const walkOpSchema = z.discriminatedUnion("kind", [
  clickOp.extend({ hints: walkHintsSchema }),
  fillOp.extend({ value: walkValueSchema }),
  selectOp,
  pressOp,
  uploadOp.extend({ file: walkValueSchema }),
  ...restOps,
  z.object({
    kind: z.literal("open"),
    goal: z.string(),
    /** A URL, or one whole field (`{link}`) holding a URL: a row's link in an `each`. */
    url: z.union([z.string().url(), z.string().regex(WHOLE_REF)]),
  }),
  /**
   * A script that acts where no locator reaches (a click a page hides from
   * pointers): a function of `el` on the element `hints` find, or an
   * expression on the page with no hints. Gated like a click. With `as`, a
   * function on the page (no hints) whose answer is kept under `as` as text
   * (JSON when not a string): an API the signed-in page can call.
   */
  z
    .object({
      kind: z.literal("eval"),
      goal: z.string(),
      hints: hintsSchema.optional(),
      js: z.string().min(1),
      irreversible: z.boolean(),
      as: z.string().regex(AS).optional(),
    })
    .refine((o) => !(o.as && o.hints), "an eval with `as` runs on the page: no hints"),
  /**
   * Choose options by their text in one region (a quiz question): a checkbox
   * that differs is clicked, a radio only turned on, then all are read back.
   * `choices`: one value or a JSON list, with `{field}`s. `region.css` is a
   * Playwright selector (`xpath=` too) the options chain under; `row` is the
   * option's ancestor that holds its text, `label` the part of it to read.
   */
  z.object({
    kind: z.literal("pick"),
    goal: z.string(),
    region: z.object({ css: z.string().min(1), frame: z.string().nullable().optional() }),
    row: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    choices: z.string().min(1),
  }),
  /**
   * The page shows `hints` (text and name may hold `{field}`s), or the file
   * name of `file` (one whole field, as an upload's path), within `ms`; else
   * the walk stops for a person. A check after an act the page may refuse.
   */
  z
    .object({
      kind: z.literal("see"),
      goal: z.string(),
      hints: hintsSchema.optional(),
      file: z.string().regex(WHOLE_REF).optional(),
      ms: z.number().int().positive().optional(),
    })
    .refine((o) => !o.hints !== !o.file, "a see names hints or file, one of them"),
  /** A file the page links to, fetched with its sign-in: `url` (relative, may hold `{field}`s) or the `href` at `hints`; kept under `as`. */
  z.object({
    kind: z.literal("download"),
    goal: z.string(),
    hints: hintsSchema.optional(),
    url: z.string().min(1).optional(),
    as: z.string().regex(AS),
  }),
  /** `box`: the captcha's frame; in a sign-in a person solves it until the box is gone. */
  z.object({ kind: z.literal("captcha"), goal: z.string(), box: hintsSchema.optional() }),
  /** Login walks only: the credential's username into `field`. */
  z.object({ kind: z.literal("username"), goal: z.string(), field: hintsSchema }),
  /**
   * Login walks only: the credential's password into `field` (a password box), then
   * `submit`. The form back after it with nothing known fails; never a retype.
   */
  z.object({
    kind: z.literal("password"),
    goal: z.string(),
    field: hintsSchema,
    submit: hintsSchema,
    keepSignedIn: hintsSchema.optional(),
  }),
  /**
   * Login walks only: a code of the first kind the credential can get, into `field`,
   * then `submit`. `send` is pressed first when it shows; a second ask takes a newer code.
   */
  z.object({
    kind: z.literal("one-time-code"),
    goal: z.string(),
    kinds: z.array(z.enum(CODE_KINDS)).min(1),
    field: hintsSchema,
    submit: hintsSchema,
    send: hintsSchema.optional(),
    hint: z.string().optional(),
  }),
  /** Login walks only: our stored passkey answers; the ceremony completes on the click. */
  z.object({ kind: z.literal("passkey"), goal: z.string(), start: hintsSchema }),
  /**
   * Login walks only: the provider's button (`button`, else its own readings), its
   * sign-in in the popup or redirect, back on the site. Its screen counts only
   * when the credential signs in `via` this provider.
   */
  z.object({
    kind: z.literal("provider"),
    goal: z.string(),
    provider: z.enum(PROVIDERS),
    button: hintsSchema.optional(),
    /** The account at the provider; default the credential's username when it says `via`. */
    account: z.string().optional(),
  }),
  /** Another walk, by `name` on this site or `site/name`: a sign-in inside a setup. */
  z.object({
    kind: z.literal("walk"),
    goal: z.string(),
    walk: z.string().regex(WALK_REF),
  }),
  /**
   * Another walk once per row: the rows of an earlier `records` op, or one per
   * line (or JSON array item) of a plan field. Each run gets the row's fields
   * as its plan, `with` mapping them (`{ url: "{link}" }`), and `i`: the
   * row's number from 0. What it reads joins the row, kept under `as`. A row
   * that fails keeps its `error`.
   */
  z.object({
    kind: z.literal("each"),
    goal: z.string(),
    over: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    walk: z.string().regex(WALK_REF),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    with: z.record(z.string(), z.string()).optional(),
    /** Rows run, at most; the rest are left out and counted. */
    max: z.number().int().positive().max(MAX_EACH).optional(),
  }),
]);
export type WalkOp = z.infer<typeof walkOpSchema>;

/** Ops only a login walk runs: they type the credential's secrets. */
export const LOGIN_OPS = new Set<WalkOp["kind"]>([
  "username",
  "password",
  "one-time-code",
  "passkey",
  "provider",
]);
/** Ops that type a secret: their screen runs only on a page its recognizer matched. */
export const SECRET_OPS = new Set<WalkOp["kind"]>(["password", "one-time-code"]);
/** The name a walk must have for login ops: one per site. */
export const LOGIN_WALK = "login";

export const screenSpecSchema = z.object({
  name: z.string().regex(NAME),
  /** One line a person would say about it. */
  looks: z.string(),
  /** Its URL shape (`urlShape`: host and path, ids as `*`); null: any page. */
  url: z.string().nullable().default(null),
  /** All on the page (`lookAt` landmarks): it is this screen. */
  landmarks: z.array(z.string()).max(12).default([]),
  /** The URL matches this regex (`/source/flags`). */
  at: patternSchema.optional(),
  /** Each shows on the page. */
  shows: z.array(hintsSchema).optional(),
  /** None shows (a dashboard has no password box). */
  hides: z.array(hintsSchema).optional(),
  /** The page's text matches this regex. */
  says: patternSchema.optional(),
  ops: z.array(walkOpSchema).default([]),
  goal: z.boolean().optional(),
  /**
   * The site turned the try away: the walk fails with `LoginFailed` and this case's hold.
   * Case `password` types the previous password once first, when the credential has one.
   */
  refused: z
    .object({ says: z.string().min(1), case: z.enum(["password", "code", "account"]) })
    .optional(),
  /** A step only a person can pass: they act in the window, then the walk goes on. */
  person: z.object({ why: z.string().min(1) }).optional(),
  /** Login walks: counts only when the credential can get this kind of code (a two-factor way to pick). */
  needs: z.enum(CODE_KINDS).optional(),
  /** Screens that must be done first: the second visit to a page, or a page two screens share. */
  after: z.array(z.string().regex(NAME)).optional(),
  /** Done at most once per walk (the default); false for a page that may come back (a next page). */
  once: z.boolean().optional(),
  /** How many of the runs it was built from passed through it. */
  seen: z.number().int().nonnegative().default(0),
});
export type ScreenSpec = z.infer<typeof screenSpecSchema>;

/** What a screen checks before it is the page: none means any page. */
export const checksOf = (s: ScreenSpec): number =>
  Number(s.url !== null) +
  s.landmarks.length +
  Number(!!s.at) +
  (s.shows?.length ?? 0) +
  Number(!!s.says);

/** Its acts type a secret: a password, a code, or the previous password on a refusal. */
export const typesSecret = (s: ScreenSpec): boolean =>
  s.ops.some((op) => SECRET_OPS.has(op.kind)) || s.refused?.case === "password";

export const walkSpecSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(WALK_VERSION)]).default(WALK_VERSION),
    site: z.string().regex(SITE),
    name: z.string().regex(NAME),
    /** In words: what the walk ends with. */
    goal: z.string(),
    /** When it was built; empty for a walk written in the repo. */
    built: z.string().default(""),
    /** The runs it was built from, oldest first. */
    from: z
      .array(z.object({ run: z.string(), outcome: z.string(), endedAt: z.string() }))
      .default([]),
    /** Where it opens, may hold `{field}`s; null: it starts on whatever page it is handed (a walk inside a walk). */
    start: z.string().url().nullable(),
    /** Typed values: the run's value is the example, used when the input does not give one. */
    fields: z.array(walkFieldSchema).default([]),
    secrets: z
      .array(z.object({ key: z.string().regex(SECRET_KEY), label: z.string() }))
      .default([]),
    /** A click on it creates, sends or pays: running it takes a yes. */
    irreversible: z.boolean().default(false),
    /** Login walks: domains the password may be typed on beside `start`'s (an SSO host, a sister domain). */
    origins: z.array(z.string().min(1)).optional(),
    /** Login walks: a signed-in page, opened to check a session; default `start`. */
    home: z.string().url().optional(),
    /** Login walks: the site's sign-in pages; on one, the walk runs in place (no open), so a `next` in its URL survives. */
    signInHere: patternSchema.optional(),
    /** Login walks: what setup says when it asks for the credential; default from the screens. */
    ask: z.string().min(1).optional(),
    screens: z.array(screenSpecSchema).min(1),
  })
  .superRefine((w, ctx) => {
    const names = new Set<string>();
    const login = w.name === LOGIN_WALK;
    w.screens.forEach((s, i) => {
      const at = (message: string, ...more: (string | number)[]) =>
        ctx.addIssue({ code: "custom", path: ["screens", i, ...more], message });
      if (names.has(s.name)) at("not unique", "name");
      names.add(s.name);
      const ends = [s.goal, s.refused, s.person].filter(Boolean).length;
      if (ends > 1) at("one of goal, refused and person", "name");
      if (ends && s.ops.length)
        at(s.goal ? "a goal does nothing" : "it ends the step: no ops", "ops");
      if (s.refused && !login) at("refused is for a login walk", "refused");
      if (s.needs && !login) at("needs is for a login walk", "needs");
      // A login screen with nothing to check would match every page, a secret's page among them.
      if (login && !checksOf(s)) at("a login screen needs url, landmarks, at, shows or says");
      s.ops.forEach((op, j) => {
        if (LOGIN_OPS.has(op.kind) && !login)
          at(`a ${op.kind} op runs only in a walk named ${LOGIN_WALK}`, "ops", j);
      });
    });
    if (w.origins && !login)
      ctx.addIssue({ code: "custom", path: ["origins"], message: "origins is for a login walk" });
    if (w.home && !login)
      ctx.addIssue({ code: "custom", path: ["home"], message: "home is for a login walk" });
    if (w.ask && !login)
      ctx.addIssue({ code: "custom", path: ["ask"], message: "ask is for a login walk" });
    if (w.signInHere && !login)
      ctx.addIssue({
        code: "custom",
        path: ["signInHere"],
        message: "signInHere is for a login walk",
      });
    if (!w.screens.some((s) => s.goal))
      ctx.addIssue({ code: "custom", path: ["screens"], message: "no goal screen" });
    const fields = new Set(w.fields.map((f) => f.key));
    if (fields.size < w.fields.length)
      ctx.addIssue({ code: "custom", path: ["fields"], message: "a field key is twice" });
    const secrets = new Set(w.secrets.map((s) => s.key));
    const lists = new Set(
      w.screens.flatMap((s) =>
        s.ops.flatMap((op) =>
          op.kind === "records" || op.kind === "each" || op.kind === "code" ? [op.as] : [],
        ),
      ),
    );
    w.screens.forEach((s, i) => {
      for (const a of s.after ?? [])
        if (!names.has(a))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "after"],
            message: `names no screen: ${a}`,
          });
      s.ops.forEach((op, j) => {
        if (op.kind === "download" && !op.url && !op.hints)
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: "a download needs url or hints",
          });
        const v = op.kind === "fill" ? op.value : op.kind === "upload" ? op.file : null;
        if (v?.from === "plan" && !fields.has(v.field))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: `field ${v.field} is not declared`,
          });
        if (v?.from === "secret" && !secrets.has(v.key))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: `secret ${v.key} is not declared`,
          });
        if (op.kind === "each" && !lists.has(op.over) && !fields.has(op.over))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: `${op.over} is neither a records op's rows nor a declared field`,
          });
        for (const k of fieldRefs(op))
          if (!fields.has(k))
            ctx.addIssue({
              code: "custom",
              path: ["screens", i, "ops", j],
              message: `{${k}} is not a declared field`,
            });
      });
    });
    for (const m of (w.start ?? "").replace(/%7B/gi, "{").replace(/%7D/gi, "}").matchAll(FIELD_REF))
      if (!fields.has(m[1] as string))
        ctx.addIssue({
          code: "custom",
          path: ["start"],
          message: `{${m[1]}} is not a declared field`,
        });
  });
export type WalkSpec = z.infer<typeof walkSpecSchema>;
/** A walk as a repo file writes it: defaults left out (`src/walks/logins/<site>.ts`). */
export type WalkSpecInput = z.input<typeof walkSpecSchema>;

/** Where a value comes from, in a word or two: `fixed`, `plan.note`, `profile.email`, `secret password`. */
export const valueSource = (v: WalkValue): string =>
  v.from === "literal"
    ? "fixed"
    : v.from === "plan"
      ? `plan.${v.field}`
      : v.from === "profile"
        ? `profile.${v.field}`
        : `secret ${v.key}`;

/** The text of an op that may name `{field}`s: an open or download URL, a click's hints, a select's value, a pick. */
function refText(op: WalkOp): string {
  if (op.kind === "open") return op.url.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  if (op.kind === "click")
    return [op.hints.text, op.hints.name, typeof op.hints.nth === "string" ? op.hints.nth : null]
      .filter(Boolean)
      .join("\n");
  if (op.kind === "download") return op.url ?? "";
  if (op.kind === "select") return op.value;
  if (op.kind === "pick") return `${op.region.css}\n${op.choices}`;
  if (op.kind === "code") return op.plan.map((f) => `{${f}}`).join("\n");
  if (op.kind === "see")
    return [op.hints?.text, op.hints?.name, op.file].filter(Boolean).join("\n");
  return "";
}

/** The fields an op names in braces. */
export const fieldRefs = (op: WalkOp): string[] =>
  [...refText(op).matchAll(FIELD_REF)].map((m) => m[1] as string);

export const walkFile = (dir: string, site: string, name: string): string => {
  const s = baseSite(site);
  if (!SITE.test(s)) throw new Error(`site "${site}" cannot name a walks folder`);
  if (!NAME.test(name)) throw new Error(`"${name}" is not a walk name (kebab-case)`);
  return join(dir, s, `${name}.json`);
};

/** Written whole or not at all: a temp file, then a rename. */
export function saveWalk(dir: string, spec: WalkSpec): string {
  const w = walkSpecSchema.parse(spec);
  const file = walkFile(dir, w.site, w.name);
  mkdirSync(join(dir, baseSite(w.site)), { recursive: true, mode: 0o700 });
  // Two runs may save one walk at once: each its own temp file.
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(w, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** One dir's walk, or null; a hand edit that breaks the schema throws. */
function loadFrom(dir: string, site: string, name: string): WalkSpec | null {
  const file = walkFile(dir, site, name);
  if (!existsSync(file)) return null;
  const parsed = walkSpecSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(
      `walk ${baseSite(site)}/${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return parsed.data;
}

/**
 * Installed mods' walk dirs (src/mods), by mod name: `<state>/mods/<mod>/walks`
 * beside the owner's own `<state>/walks`.
 */
export function modWalkDirs(dir: string): { mod: string; dir: string }[] {
  const mods = join(dirname(dir), "mods");
  if (!existsSync(mods)) return [];
  const nameOf = (d: string) => {
    try {
      return String(JSON.parse(readFileSync(join(d, "mod.json"), "utf8")).name);
    } catch {
      return basename(d);
    }
  };
  return readdirSync(mods, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(mods, d.name, "walks")))
    .map((d) => ({ mod: nameOf(join(mods, d.name)), dir: join(mods, d.name, "walks") }))
    .sort((a, b) => a.mod.localeCompare(b.mod));
}

/** A walk by `name` on `site`, or `site/name`: the owner's own, else an installed mod's; null when there is none. A hand edit that breaks the schema throws. */
export function loadWalk(dir: string, site: string, name: string): WalkSpec | null {
  const [s, n] = name.includes("/") ? (name.split("/") as [string, string]) : [site, name];
  for (const d of [dir, ...modWalkDirs(dir).map((m) => m.dir)]) {
    const w = loadFrom(d, s, n);
    if (w) return w;
  }
  return null;
}

export interface WalkListing {
  site: string;
  name: string;
  goal: string;
  screens: number;
  runs: number;
  irreversible: boolean;
  built: string;
  /** The mod it came from; absent for the owner's own. */
  mod?: string;
}

/** Every walk, by site then name: the owner's, then mods' it does not shadow; a file that does not parse is listed with its error as the goal. */
export function listWalks(dir: string): WalkListing[] {
  const own = listIn(dir);
  const taken = new Set(own.map((w) => `${w.site}/${w.name}`));
  const out = [...own];
  for (const m of modWalkDirs(dir))
    for (const w of listIn(m.dir, m.mod)) {
      if (taken.has(`${w.site}/${w.name}`)) continue;
      taken.add(`${w.site}/${w.name}`);
      out.push(w);
    }
  return out;
}

function listIn(dir: string, mod?: string): WalkListing[] {
  if (!existsSync(dir)) return [];
  const out: WalkListing[] = [];
  const from = mod ? { mod } : {};
  for (const site of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!site.isDirectory()) continue;
    for (const f of readdirSync(join(dir, site.name)).sort()) {
      if (!f.endsWith(".json")) continue;
      const name = f.slice(0, -5);
      try {
        const w = loadFrom(dir, site.name, name);
        if (w)
          out.push({
            site: w.site,
            name: w.name,
            goal: w.goal,
            screens: w.screens.length,
            runs: w.from.length,
            irreversible: w.irreversible,
            built: w.built,
            ...from,
          });
      } catch (err) {
        out.push({
          site: site.name,
          name,
          goal: `(broken: ${err instanceof Error ? err.message : String(err)})`,
          screens: 0,
          runs: 0,
          irreversible: true,
          built: "",
          ...from,
        });
      }
    }
  }
  return out;
}
