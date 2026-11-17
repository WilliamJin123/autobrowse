/**
 * Outline → source. Templates only: every line here is one the domain
 * workflow already has by hand, so what comes out reads like what a
 * person would write, and compiles against the library. Secrets are read
 * with `deps.secrets.get` outside `fx.run`, so they never enter the
 * journal; shell output is reduced to an exit code for the same reason.
 * The test that comes with it runs a dry run over the plan example.
 */
import { planLocator, renderLocator } from "../browser/locate.js";
import { INTERACTIVE_COMMANDS } from "../deps/shell.js";
import {
  type DesktopOutlineOp,
  HINT_TEXTS,
  type OpValue,
  type Outline,
  type OutlineOp,
  type OutlineStep,
  PLACEHOLDER,
} from "./outline.js";
import { camel } from "./structure.js";

export interface RenderOptions {
  /** Module the generated files import the library from. */
  lib?: string;
}

export interface Rendered {
  /** Relative file name → source. */
  files: Record<string, string>;
}

const q = (s: string) => JSON.stringify(s);

/** The hosts a workflow's browser steps open, in order, once each. */
export const hostsOf = (o: Pick<Outline, "steps">): string[] => [
  ...new Set(
    o.steps.flatMap((s) => {
      // a `{field}` in the host is the plan's: no fixed host
      const host = s.kind === "browser" && s.url && URL.canParse(s.url) ? new URL(s.url).host : "";
      return host && !host.includes("{") && !host.includes("%7B") ? [host] : [];
    }),
  ),
];
const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** Multiline banner comment. */
function banner(lines: string[]): string {
  return `/**\n${lines.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */`;
}

function renderValue(v: OpValue): string {
  switch (v.from) {
    case "plan":
      return `input.${v.field}`;
    case "secret":
      return `input.${v.key}`;
    case "literal":
      return q(v.text);
  }
}

/** Code as a template when it can be one, so the flow shows it as code (raw if it holds a backslash); else a string. */
function renderCode(code: string): string {
  if (/`|\$\{|\\$/.test(code)) return q(code);
  return `${code.includes("\\") ? "String.raw" : ""}\`${code.replace(/^\n|\n$/g, "")}\``;
}

/** A records op as an object literal: the checked extractor, kept in the flow's source. */
function renderRecordsOp(op: Extract<OutlineOp, { kind: "records" }>): string {
  const { code, sample: _, ...rest } = op;
  const head = Object.entries(rest)
    .map(([k, v]) => `      ${k}: ${JSON.stringify(v)},`)
    .join("\n");
  return `{\n${head}\n      sample: [],\n      code: ${renderCode(code)},\n    }`;
}

/** One op as one statement, indented for a flow's body. */
/** Plan field types the recording shows; values stay strings, as a fill types them. */
const KINDS = {
  text: { zod: "z.string().min(1)", sample: null },
  email: { zod: "z.email()", sample: "you@example.com" },
  url: { zod: "z.url()", sample: "https://example.com" },
  date: { zod: "z.iso.date()", sample: "2026-01-31" },
  number: { zod: 'z.string().regex(/^-?\\d+(\\.\\d+)?$/, "a number")', sample: "1" },
  file: { zod: "fileField()", sample: null },
} as const;
type Kind = keyof typeof KINDS;

/** A field's type from the inputs it fills or uploads: a field used as two kinds stays text. */
export function fieldKinds(o: Outline): Map<string, Kind> {
  const seen = new Map<string, Set<Kind>>();
  const add = (field: string, kind: Kind) =>
    seen.set(field, (seen.get(field) ?? new Set<Kind>()).add(kind));
  for (const step of o.steps) {
    if (step.kind !== "browser") continue;
    for (const op of step.ops) {
      if (op.kind === "upload" && op.file.from === "plan") add(op.file.field, "file");
      if (op.kind !== "fill" || op.value.from !== "plan") continue;
      const t = op.hints.inputType;
      add(
        op.value.field,
        t === "email" || t === "url" || t === "date" || t === "number" ? t : "text",
      );
    }
  }
  return new Map(
    [...seen].map(([k, set]) => [k, set.size === 1 ? ([...set][0] ?? "text") : "text"]),
  );
}

export function renderOp(op: OutlineOp): string {
  if (op.kind === "human") return `    fp.human(${q(op.reason)});`;
  if (op.kind === "ai")
    throw new Error(`an ai op runs in a walk; compile does not render it (${op.goal})`);
  if (op.kind === "records") return `    out.${op.as} = await records(fp, ${renderRecordsOp(op)});`;
  if (op.kind === "code") {
    const plan = op.plan.map((f) => `${f}: input.${f}`).join(", ");
    return `    out.${op.as} = (await runCode(fp, { plan: { ${plan} }, code: ${renderCode(op.code)} })).rows;`;
  }
  const plan = planLocator(op.hints);
  const hints = `{ ${Object.entries(op.hints)
    .filter(([, v]) => v)
    .map(
      ([k, v]) => `${k}: ${typeof v === "number" ? v : template(String(v), (f) => `input.${f}`)}`,
    )
    .join(", ")} }`;
  const locatorNote = plan ? ` // ${renderLocator(plan)}` : " // TODO: no usable hints";
  if (op.kind === "read" && op.match) {
    const m = `(await fp.read(${hints})).match(new RegExp(${q(op.match)}, "i"))`;
    return `    { const m = ${m}; if (m) out.${op.as} = m[1] ?? m[0]; }${locatorNote}`;
  }
  if (op.kind === "read") return `    out.${op.as} = await fp.read(${hints});${locatorNote}`;
  // Through the input, not the result: the flow's return value is journaled, the sink is not.
  if (op.kind === "keep")
    return `    await input.sink.put(${q(op.env)}, await fp.read(${hints}));${locatorNote}`;
  const opts = `{ goal: ${q(op.goal)}${op.kind === "click" && op.irreversible ? ", irreversible: true" : ""} }`;
  const opSrc =
    op.kind === "click"
      ? `{ kind: "click" }`
      : op.kind === "fill"
        ? `{ kind: "fill", value: ${renderValue(op.value)} }`
        : op.kind === "select"
          ? `{ kind: "select", value: ${q(op.value)} }`
          : op.kind === "upload"
            ? `{ kind: "upload", files: [${renderValue(op.file)}] }`
            : op.kind === "hover"
              ? `{ kind: "hover" }`
              : `{ kind: "press", key: ${q(op.key)} }`;
  return `    await fp.act(${opSrc}, ${hints}, ${opts});${locatorNote}`;
}

/** `{project}` in a step URL or a hint is the plan field `project`. */
export const URL_FIELD = PLACEHOLDER;

/** Text as source: a plain string, or a template when it names plan fields (`expr` renders one). */
function template(text: string, expr: (field: string) => string): string {
  PLACEHOLDER.lastIndex = 0;
  if (!PLACEHOLDER.test(text)) return q(text);
  PLACEHOLDER.lastIndex = 0;
  const body = text
    .replace(/[`\\]/g, "\\$&")
    .replace(/\$\{/g, "\\${")
    .replace(PLACEHOLDER, (_m, f: string) => `\${${expr(f)}}`);
  return `\`${body}\``;
}

/** A step URL as source; a plan field in it is URL-encoded. */
const renderUrl = (url: string): string => template(url, (f) => `encodeURIComponent(input.${f})`);

/** Plan fields and secrets one flow needs, in order of first use. */
export function flowInputs(step: Extract<OutlineStep, { kind: "browser" }>) {
  const fields: string[] = [];
  const secrets: string[] = [];
  const named = (text: string) => {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const f = m[1] as string;
      if (!fields.includes(f)) fields.push(f);
    }
  };
  named(step.url ?? "");
  for (const op of step.ops) {
    if (op.kind === "code") for (const f of op.plan) if (!fields.includes(f)) fields.push(f);
    if ("hints" in op)
      for (const k of HINT_TEXTS) if (typeof op.hints[k] === "string") named(op.hints[k]);
    const value = op.kind === "fill" ? op.value : op.kind === "upload" ? op.file : null;
    if (!value) continue;
    if (value.from === "plan" && !fields.includes(value.field)) fields.push(value.field);
    if (value.from === "secret" && !secrets.includes(value.key)) secrets.push(value.key);
  }
  return { fields, secrets };
}

function renderBrowserStep(o: Outline, step: Extract<OutlineStep, { kind: "browser" }>): string {
  const id = camel(step.name);
  const Input = `${pascal(step.name)}Input`;
  const { fields, secrets } = flowInputs(step);
  const keeps = step.ops.some((op) => op.kind === "keep");
  const inputLines = [
    ...[...fields, ...secrets].map((k) => `  ${k}: string;`),
    ...(keeps ? ["  sink: SecretSink;"] : []),
  ];
  const inputType = inputLines.length
    ? `export interface ${Input} {\n${inputLines.join("\n")}\n}`
    : `export type ${Input} = Record<string, never>;`;
  const reads = step.ops.filter(
    (op) => op.kind === "read" || op.kind === "records" || op.kind === "code",
  );
  // Only reads: it may run beside other reads on the profile (U15). `code` may act, so it is not one.
  const readOnly =
    step.ops.length > 0 &&
    step.ops.every((op) => op.kind === "read" || op.kind === "records") &&
    !step.irreversible &&
    !secrets.length;
  const out = step.ops.some((op) => op.kind === "records" || op.kind === "code")
    ? "Record<string, unknown>"
    : "Record<string, string>";
  const flowLines = [
    ...(step.url ? [`    await fp.open(${renderUrl(step.url)});`] : []),
    ...(reads.length ? [`    const out: ${out} = {};`] : []),
    ...step.ops.map(renderOp),
    ...(reads.length ? ["    return out;"] : []),
  ];
  const secretLines = secrets.map(
    (k) =>
      `    // Outside fx.run on purpose: the journal must never hold it.\n    const ${k} = await deps.secrets.get(${q(k)});`,
  );
  const inputArgs = [
    ...fields.map((f) => `${f}: plan.${f}`),
    ...secrets,
    ...(keeps ? ["sink: deps.sink"] : []),
  ].join(", ");
  const gate = step.irreversible
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description || "irreversible"})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  const proof = step.proof
    ? `    // TODO proof: ${step.proof}`
    : "    // TODO: prove the result through an API read where one exists.";
  return `${inputType}

const ${id}Flow = defineFlow<${Input}, ${reads.length ? out : "void"}>({
  site: ${q(o.site)},
  name: ${q(step.name)},${readOnly ? "\n  reads: true," : ""}
  async run(fp${inputArgs ? ", input" : ""}) {
${flowLines.join("\n") || "    void fp;"}
  },
});

const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ fx, deps${fields.length ? ", plan" : ""}${step.irreversible ? ", gate" : ""} }) {
${gate}${secretLines.length ? `${secretLines.join("\n")}\n` : ""}    ${reads.length ? "const out = " : ""}await fx.run(${q(`browser ${step.name}`)}, () => deps.browser.run(${id}Flow, { ${inputArgs} }));
${proof}
    return done(${reads.length ? "JSON.stringify(out)" : q(step.description || step.name)});
  },
};`;
}

function renderTerminalStep(step: Extract<OutlineStep, { kind: "terminal" }>): string {
  const id = camel(step.name);
  const lines = step.commands.map((cmd, i) =>
    INTERACTIVE_COMMANDS.test(cmd)
      ? `    // \`${cmd}\` is interactive; a person runs it.\n    throw new NeedsHuman(${q(`run \`${cmd}\` by hand, then play`)});`
      : `    await sh(${i}, ${q(cmd)});`,
  );
  const gate = step.irreversible
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  return `const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ fx, deps${step.irreversible ? ", gate" : ""} }) {
${gate}    // Only the exit code is journaled: command output can hold tokens.
    const sh = async (i: number, cmd: string) => {
      const { code } = await fx.run(\`sh \${i}\`, () => deps.shell.run(cmd).then((r) => ({ code: r.code })));
      if (code !== 0) throw new Error(\`\\\`\${cmd}\\\` exited \${code}\`);
    };
${lines.join("\n")}
    return done(${q(step.description)});
  },
};`;
}

/** A typed value in a desktop step: plan fields off the plan, secrets fetched outside the journal. */
function renderDesktopValue(v: OpValue): string {
  switch (v.from) {
    case "plan":
      return `plan.${v.field}`;
    case "secret":
      return v.key;
    case "literal":
      return q(v.text);
  }
}

/** Object source with its keys in order; `undefined` and null entries left out. */
const objSrc = (entries: [string, string | undefined][]): string =>
  `{ ${entries.flatMap(([k, v]) => (v === undefined ? [] : [`${k}: ${v}`])).join(", ")} }`;
const windowSrc = (w: { app: string; title: string }) =>
  objSrc([
    ["app", q(w.app)],
    ["title", q(w.title)],
  ]);
const controlSrc = (c: { role: string; name: string; nativeId: string | null }) =>
  objSrc([
    ["role", q(c.role)],
    ["name", q(c.name)],
    ["nativeId", c.nativeId === null ? undefined : q(c.nativeId)],
  ]);
const headedSrc = (h: boolean) => (h ? "true" : undefined);

/** The journaled `DesktopOp` an outline op replays, as source. */
function desktopOpSrc(op: DesktopOutlineOp): string | null {
  switch (op.kind) {
    case "launch":
      return objSrc([
        ["op", q("launch")],
        ["app", q(op.app)],
        ["fresh", op.fresh ? "true" : undefined],
        ["args", op.args.length ? JSON.stringify(op.args) : undefined],
      ]);
    case "click":
      return objSrc([
        ["op", q("click")],
        ["window", windowSrc(op.window)],
        ["control", controlSrc(op.control)],
        ["headed", headedSrc(op.headed)],
      ]);
    case "type":
      return objSrc([
        ["op", q("type")],
        ["window", windowSrc(op.window)],
        ["control", op.control ? controlSrc(op.control) : undefined],
        ["text", renderDesktopValue(op.value)],
        ["human", op.human ? "true" : undefined],
        ["headed", headedSrc(op.headed)],
      ]);
    case "key":
      return objSrc([
        ["op", q("key")],
        ["combo", q(op.combo)],
        ["window", op.window ? windowSrc(op.window) : undefined],
        ["headed", headedSrc(op.headed)],
      ]);
    case "place":
      return objSrc([
        ["op", q("place")],
        ["window", windowSrc(op.window)],
        ["x", String(op.x)],
        ["y", String(op.y)],
        ["w", String(op.w)],
        ["h", String(op.h)],
      ]);
    case "focus":
      return objSrc([
        ["op", q("focus")],
        ["window", windowSrc(op.window)],
      ]);
    case "wait":
      return objSrc([
        ["op", q("wait")],
        ["window", windowSrc(op.window)],
        ["text", q(op.text)],
        ["timeoutS", op.timeoutS === null ? undefined : String(op.timeoutS)],
      ]);
    case "waitFile":
      return objSrc([
        ["op", q("waitFile")],
        ["file", q(op.file)],
        ["timeoutS", op.timeoutS === null ? undefined : String(op.timeoutS)],
      ]);
    case "sleep":
    case "shell":
      return null;
  }
}

function renderDesktopOp(op: DesktopOutlineOp, i: number): string {
  if (op.kind === "sleep") return `    await fx.sleep(${op.ms}); // ${op.goal}`;
  if (op.kind === "shell")
    return `    await sh(${i}, ${q(op.command)}${op.root ? ", true" : ""}); // ${op.goal}`;
  // The journal keeps only that the op ran: never typed text, never a window id.
  return `    await fx.run(${q(`desktop ${i} ${op.kind}`)}, () => hands.run(${desktopOpSrc(op)}).then(() => undefined)); // ${op.goal}`;
}

function renderDesktopStep(step: Extract<OutlineStep, { kind: "desktop" }>): string {
  const id = camel(step.name);
  const secrets = [
    ...new Set(
      step.ops.flatMap((op) =>
        op.kind === "type" && op.value.from === "secret" ? [op.value.key] : [],
      ),
    ),
  ];
  const usesPlan = step.ops.some((op) => op.kind === "type" && op.value.from === "plan");
  const anyShell = step.ops.some((op) => op.kind === "shell");
  const anyHands = step.ops.some((op) => op.kind !== "shell" && op.kind !== "sleep");
  const gate = step.irreversible
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description || "irreversible"})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  const secretLines = secrets.map(
    (k) =>
      `    // Outside fx.run on purpose: the journal must never hold it.\n    const ${k} = await deps.secrets.get(${q(k)});`,
  );
  const hands = anyHands ? "    const hands = desktopHands(deps.desktop);\n" : "";
  const shell = anyShell
    ? `    // Only the exit code is journaled: command output can hold tokens.
    const sh = async (i: number, cmd: string, root = false) => {
      const { code } = await fx.run(\`desktop \${i} shell\`, () => deps.desktop.shell(cmd, root).then((r) => ({ code: r.code })));
      if (code !== 0) throw new Error(\`\\\`\${cmd}\\\` exited \${code}\`);
    };
`
    : "";
  const ctx = ["fx", "deps", ...(usesPlan ? ["plan"] : []), ...(step.irreversible ? ["gate"] : [])];
  return `const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ ${ctx.join(", ")} }) {
${gate}${secretLines.length ? `${secretLines.join("\n")}\n` : ""}${hands}${shell}${step.ops.map(renderDesktopOp).join("\n")}
    return done(${q(step.description || step.name)});
  },
};`;
}

/** Fake windows for the generated test: every window an op names, with the controls it uses. */
export function fakeWindowsOf(o: Outline): string {
  const wins = new Map<string, { app: string; title: string; rows: [string, string][] }>();
  const at = (w: { app: string; title: string }) => {
    const k = `${w.app}\u0000${w.title}`;
    const e = wins.get(k) ?? { app: w.app, title: w.title, rows: [] };
    wins.set(k, e);
    return e;
  };
  const row = (w: { app: string; title: string }, r: [string, string]) => {
    const e = at(w);
    if (!e.rows.some((x) => x[0] === r[0] && x[1] === r[1])) e.rows.push(r);
  };
  for (const s of o.steps) {
    if (s.kind !== "desktop") continue;
    for (const op of s.ops) {
      if (op.kind === "click") row(op.window, [op.control.role, op.control.name]);
      else if (op.kind === "type")
        row(op.window, op.control ? [op.control.role, op.control.name] : ["textfield", ""]);
      else if (op.kind === "wait") row(op.window, ["text", op.text]);
      else if (op.kind === "key" && op.window) at(op.window);
      else if (op.kind === "place" || op.kind === "focus") at(op.window);
      else if (op.kind === "launch") at({ app: op.app, title: "" });
    }
  }
  // A launch with no other op names its app's window by an empty title piece; drop it when a titled one exists.
  const list = [...wins.values()].filter(
    (w) => w.title !== "" || ![...wins.values()].some((x) => x.app === w.app && x.title !== ""),
  );
  return `[${list.map((w, i) => `fakeWindow(${q(`w-${i + 1}`)}, ${q(w.app)}, ${q(w.title || w.app)}, ${JSON.stringify(w.rows)})`).join(", ")}]`;
}

export function render(o: Outline, opts: RenderOptions = {}): Rendered {
  const lib = opts.lib ?? "@wrenautomation/autobrowse";
  const steps = o.steps.map((s) =>
    s.kind === "browser"
      ? renderBrowserStep(o, s)
      : s.kind === "terminal"
        ? renderTerminalStep(s)
        : renderDesktopStep(s),
  );
  const needsHuman = o.steps.some(
    (s) => s.kind === "terminal" && s.commands.some((c) => INTERACTIVE_COMMANDS.test(c)),
  );
  const anyGate = o.steps.some((s) => s.irreversible);
  const anyTerminal = o.steps.some((s) => s.kind === "terminal");
  const anyDesktop = o.steps.some((s) => s.kind === "desktop");
  const anyHands = o.steps.some(
    (s) => s.kind === "desktop" && s.ops.some((op) => op.kind !== "shell" && op.kind !== "sleep"),
  );
  const waitFiles = o.steps.flatMap((s) =>
    s.kind === "desktop" ? s.ops.flatMap((op) => (op.kind === "waitFile" ? [op.file] : [])) : [],
  );
  const anyKeep = o.steps.some(
    (s) => s.kind === "browser" && s.ops.some((op) => op.kind === "keep"),
  );
  const anySecret = o.secrets.length > 0;
  const anyRecords = o.steps.some(
    (s) => s.kind === "browser" && s.ops.some((op) => op.kind === "records"),
  );
  const anyCode = o.steps.some(
    (s) => s.kind === "browser" && s.ops.some((op) => op.kind === "code"),
  );
  const kinds = fieldKinds(o);
  const imports = [
    ...([...kinds.values()].includes("file") ? ["fileField"] : []),
    ...(anyRecords ? ["records"] : []),
    ...(anyCode ? ["runCode"] : []),
    "defineFlow",
    "defineWorkflow",
    "done",
    "type FlowRunner",
    ...(needsHuman ? ["NeedsHuman"] : []),
    ...(anyGate ? ["rejected"] : []),
    ...(anySecret ? ["type SecretSource"] : []),
    ...(anyTerminal ? ["type Shell"] : []),
    ...(anyDesktop ? ["type Desktop"] : []),
    ...(anyHands ? ["desktopHands"] : []),
    ...(anyKeep ? ["type SecretSink"] : []),
    "type StepDef",
  ].sort((a, b) => a.replace("type ", "").localeCompare(b.replace("type ", "")));

  const planFields = o.fields.map(
    (f) =>
      `  ${f.key}: ${KINDS[kinds.get(f.key) ?? "text"].zod}.describe(${q(f.label)}),${f.example ? ` // e.g. ${q(f.example)}` : ""}`,
  );
  const depFields = [
    "  browser: FlowRunner;",
    ...(anySecret ? ["  secrets: SecretSource;"] : []),
    ...(anyTerminal ? ["  shell: Shell;"] : []),
    ...(anyDesktop ? ["  desktop: Desktop;"] : []),
    ...(anyKeep ? ["  sink: SecretSink;"] : []),
  ];

  const index = `${banner([
    `${o.description}.`,
    `Compiled from the recording ${q(o.name)}. Edit freely: the outline was the`,
    "source until this file was written; from here on this file is.",
    ...(o.secrets.length
      ? ["", `Secrets (set as env, see SecretSource): ${o.secrets.map((s) => s.key).join(", ")}.`]
      : []),
  ])}
import { ${imports.join(", ")} } from ${q(lib)};
import { z } from "zod";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
${planFields.join("\n")}
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
${depFields.join("\n")}
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

${steps.join("\n\n")}

export const workflow = defineWorkflow<Deps, Memo>()({
  name: ${q(o.name)},
  description: ${q(o.description)},
  site: ${q(o.site)},
  hosts: ${JSON.stringify(hostsOf(o))},
  plan: planSchema,
  steps: [${o.steps.map((s) => camel(s.name)).join(", ")}],
  emptyMemo: () => ({}),
});
`;

  const example = o.fields
    .map((f) => {
      const kind = KINDS[kinds.get(f.key) ?? "text"];
      return `${f.key}: ${q(f.example ?? kind.sample ?? f.label)}`;
    })
    .join(", ");
  const depsSrc = [
    "browser: { run: async () => undefined as never }",
    ...(anySecret
      ? [`secrets: memorySecrets({ ${o.secrets.map((s) => `${s.key}: "x"`).join(", ")} })`]
      : []),
    ...(anyTerminal ? ["shell: fakeShell()"] : []),
    ...(anyDesktop
      ? [
          `desktop: fakeDesktop(${fakeWindowsOf(o)}${waitFiles.length ? `, { files: ${JSON.stringify(waitFiles)} }` : ""})`,
        ]
      : []),
    ...(anyKeep ? ["sink: memorySink()"] : []),
  ].join(", ");
  const testImports = [
    ...(anyDesktop ? ["fakeDesktop"] : []),
    ...(anyHands ? ["fakeWindow"] : []),
    ...(anyKeep ? ["memorySink"] : []),
    ...(anyTerminal ? ["fakeShell"] : []),
    "memoryEffects",
    ...(anySecret ? ["memorySecrets"] : []),
    "runFlow",
  ];
  const firstIrreversible = o.steps.find((s) => s.irreversible)?.name;
  const test = `import { describe, expect, it } from "vitest";
import { ${testImports.join(", ")} } from ${q(lib)};
import { planSchema, workflow } from "./index.js";

const deps = () => ({ ${depsSrc} });

describe(${q(o.name)}, () => {
  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, ${example} });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
${
  firstIrreversible
    ? `    expect(out.status).toBe("planned");
    expect(out.results[${q(firstIrreversible)}]?.status).toBe("planned");`
    : `    expect(out.status).toBe("done");`
}
  });
});
`;
  return { files: { "index.ts": index, "index.test.ts": test } };
}
