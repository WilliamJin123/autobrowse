/** Words for a desktop act; no runtime deps so the UI can import it too. */
import type { DesktopOp } from "./types.js";

const win = (w: { app: string; title: string }) => `${w.app} "${w.title}"`;

/** One line a person reads: what the act was, with typed text hidden when it was a secret. */
export function describeOp(op: DesktopOp, redacted = false): string {
  const headed = "headed" in op && op.headed ? " (headed)" : "";
  switch (op.op) {
    case "launch":
      return `${op.fresh ? "launch a new" : "open"} ${op.app}`;
    case "click":
      return `click ${op.control.role} "${op.control.name}" in ${win(op.window)}${headed}`;
    case "type": {
      const what =
        op.secret !== undefined ? `secret ${op.secret}` : redacted ? "(redacted)" : `"${op.text}"`;
      return `type ${what}${op.control ? ` into ${op.control.role} "${op.control.name}"` : ""} in ${win(op.window)}${headed}`;
    }
    case "key":
      return `press ${op.combo}${op.window ? ` in ${win(op.window)}` : ""}${headed}`;
    case "place":
      return `place ${win(op.window)} at ${op.x},${op.y} ${op.w}×${op.h}`;
    case "focus":
      return `focus ${win(op.window)}`;
    case "wait":
      return `wait for "${op.text}" in ${win(op.window)}`;
    case "waitFile":
      return `wait for file ${op.file}`;
    case "sleep":
      return `sleep ${op.ms}ms`;
    case "shell":
      return `${op.root ? "root " : ""}shell: ${op.command}`;
  }
}
