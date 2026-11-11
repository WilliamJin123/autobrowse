/**
 * Our tabs in the person's own browser (OpenCLI audit U10). Each opens in a background
 * window of its own: their active tab keeps focus. A ledger names each tab's owner process;
 * a tab whose owner died (a killed CLI, a crash before `close`) is closed at the next attach.
 * Only ledger tabs are ever closed: their own tabs are never touched.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";

export interface OwnTab {
  /** The owner process. */
  pid: number;
  targetId: string;
  /** The browser's data dir: one ledger serves several browsers. */
  browser: string;
  at: string;
}

export const ownTabsFile = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse"), "own-tabs.json");

export function readTabs(file: string): OwnTab[] {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeTabs(file: string, rows: OwnTab[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 1)}\n`);
  renameSync(tmp, file); // atomic: two attaches never read half a file
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // alive, another user's
  }
};

export function addTab(file: string, tab: OwnTab): void {
  writeTabs(file, [...readTabs(file).filter((t) => t.targetId !== tab.targetId), tab]);
}

export function dropTab(file: string, targetId: string): void {
  const rows = readTabs(file);
  const left = rows.filter((t) => t.targetId !== targetId);
  if (left.length !== rows.length) writeTabs(file, left);
}

/**
 * Close this browser's ledger tabs whose owner is dead; drop their rows. A target already
 * gone (closed by the person) is dropped too. Returns the closed target ids.
 */
export async function reapTabs(
  cdp: Pick<CDPSession, "send">,
  file: string,
  browser: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<string[]> {
  const rows = readTabs(file);
  const dead = rows.filter((t) => t.browser === browser && !alive(t.pid));
  if (dead.length === 0) return [];
  const { targetInfos } = await cdp.send("Target.getTargets");
  const open = new Set(targetInfos.map((t) => t.targetId));
  const closed: string[] = [];
  for (const t of dead) {
    if (!open.has(t.targetId)) continue;
    const ok = await cdp
      .send("Target.closeTarget", { targetId: t.targetId })
      .then((r) => r.success)
      .catch(() => false);
    if (ok) closed.push(t.targetId);
  }
  const gone = new Set(dead.map((t) => t.targetId));
  // Re-read: another attach may have written since.
  writeTabs(
    file,
    readTabs(file).filter((t) => !gone.has(t.targetId)),
  );
  return closed;
}

/** A blank background tab, as a Playwright page; in a window of its own unless `sameWindow`. */
export async function backgroundTab(
  context: BrowserContext,
  cdp: Pick<CDPSession, "send">,
  timeoutMs = 15_000,
  o: { sameWindow?: boolean } = {},
): Promise<{ page: Page; targetId: string }> {
  // Only tabs that appear now are checked: the person's tabs get no CDP session of ours.
  const fresh: Page[] = [];
  let wake = () => {};
  const on = (p: Page) => {
    fresh.push(p);
    wake();
  };
  context.on("page", on);
  try {
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      newWindow: !o.sameWindow,
      background: true,
    });
    const end = Date.now() + timeoutMs;
    for (let i = 0; Date.now() < end; ) {
      for (; i < fresh.length; i++) {
        const p = fresh[i] as Page;
        if ((await targetOf(p).catch(() => null)) === targetId) return { page: p, targetId };
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 250);
      });
    }
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw new Error("the new background tab never showed up as a page");
  } finally {
    context.off("page", on);
  }
}

async function targetOf(page: Page): Promise<string> {
  const s = await page.context().newCDPSession(page);
  try {
    return (await s.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await s.detach().catch(() => undefined);
  }
}
