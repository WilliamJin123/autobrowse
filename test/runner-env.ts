/**
 * The local runner for a test (was Restate in Docker): a temp SQLite file, every turn replayed
 * after each step as Restate's `alwaysReplay`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as clients from "@restatedev/restate-sdk-clients";
import { startRunner } from "../src/runtime/index.js";
import type { RuntimeStore } from "../src/runtime/store.js";

export interface TestRunner {
  ingress(): clients.Ingress;
  store: RuntimeStore;
  /** Restate admin's kill: the row and its open children end with 409. */
  kill(invocationId: string): Promise<boolean>;
  stop(): Promise<void>;
}

export async function startTestRunner(
  services: readonly unknown[],
  o: { replay?: boolean } = {},
): Promise<TestRunner> {
  const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  const runner = await startRunner({
    file: join(dir, "runner.db"),
    services,
    replay: o.replay ?? true,
    pollMs: 20,
    concurrency: 16,
    log: () => {},
  });
  return {
    ingress: () => runner.ingress,
    store: runner.store,
    kill: (id) => runner.store.kill(id),
    async stop() {
      await runner.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
