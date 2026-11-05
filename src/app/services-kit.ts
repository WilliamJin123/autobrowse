/** Two helpers every services-* file leans on: a setting that must be set, and a client made on first use. */
import type { SSMClient } from "@aws-sdk/client-ssm";
import { Unrecoverable } from "../engine/effects.js";
import type { AwsConfig } from "../owner.js";

export function required<T>(value: T | undefined, env: string): T {
  if (value === undefined) throw new Unrecoverable(`${env} is required`);
  return value;
}

/**
 * Build a client the first time a step touches it, so a worker starts
 * with whatever credentials it has and a missing one fails the step that
 * needs it (a clear `X is required` in the run), not the whole process.
 */
export function lazy<T extends object>(make: () => T): T {
  let real: T | null = null;
  return new Proxy({} as T, {
    get(_t, prop) {
      real ??= make();
      const v = Reflect.get(real, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}

/**
 * As `lazy`, for a client whose package loads at first use (an AWS SDK
 * client costs a CLI start 50–130 ms). Only for clients whose every member
 * in use is an async method: each call waits for `make`, then runs.
 */
export function later<T extends object>(make: () => Promise<T>): T {
  let real: Promise<T> | null = null;
  return new Proxy({} as T, {
    get(_t, prop) {
      // Not a thenable: an `await` on the client must give the client.
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        real ??= make();
        const client = await real;
        return (Reflect.get(client, prop) as (...a: unknown[]) => unknown).apply(client, args);
      };
    },
  });
}

/** The owner's SSM client; the SDK loads at its first `send`. */
export function lateSsm(config: () => AwsConfig): SSMClient {
  return later(async () => new (await import("@aws-sdk/client-ssm")).SSMClient(config()));
}
