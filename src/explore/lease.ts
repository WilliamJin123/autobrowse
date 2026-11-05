/**
 * An explore session is a lease on its browser profile. Nobody driving it for
 * `DEFAULT_IDLE_MINUTES` (no command running or sent, no page load) closes it,
 * journal kept. A command that runs longer never does.
 * A scheduled write on the same profile (the desk posting) takes it after
 * `TAKE_IDLE_MINUTES` instead of waiting; a held session (`--hold`, teach)
 * is never taken (`browser/profile-wait`).
 */
export const DEFAULT_IDLE_MINUTES = 10;
export const TAKE_IDLE_MINUTES = 3;

/**
 * How long a session may sit with no command. Paused: four times the idle time (a person is at
 * a hand step). Its Claude session gone: `TAKE_IDLE_MINUTES` at most, since nobody is left to
 * drive it; a person at the window keeps it by loading pages.
 */
export const leaseMs = (idleMs: number, s: { paused: boolean; ownerGone: boolean }): number =>
  s.paused ? idleMs * 4 : s.ownerGone ? Math.min(idleMs, TAKE_IDLE_MINUTES * 60_000) : idleMs;

/** True while the process exists (ours or not). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
