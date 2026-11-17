// Copied from wren packages/runtime/src/promise.ts at dc80ecd28; one edit: imports ./core/promise.js.
/**
 * `RestatePromise` statics that serve both executors: the Postgres runtime's durable promises go
 * to its turn (the deciding index is journaled); anything else goes to the SDK.
 */
import * as sdk from "@restatedev/restate-sdk";
import { Durable } from "./core/promise.js";

const ours = (xs: readonly unknown[]) =>
  xs.find((x): x is Durable<unknown> => x instanceof Durable);

export type RestatePromise<T> = sdk.RestatePromise<T>;
export const RestatePromise: typeof sdk.RestatePromise = {
  resolve: (v: unknown) => (v instanceof Durable ? v : sdk.RestatePromise.resolve(v)),
  reject: (r: sdk.TerminalError) => sdk.RestatePromise.reject(r),
  all: (xs: readonly unknown[]) => {
    const d = ours(xs);
    return d
      ? d.host.combine("all", xs as Durable<unknown>[])
      : sdk.RestatePromise.all(xs as never);
  },
  race: (xs: readonly unknown[]) => {
    const d = ours(xs);
    return d
      ? d.host.combine("race", xs as Durable<unknown>[])
      : sdk.RestatePromise.race(xs as never);
  },
  any: (xs: readonly unknown[]) => {
    const d = ours(xs);
    return d
      ? d.host.combine("any", xs as Durable<unknown>[])
      : sdk.RestatePromise.any(xs as never);
  },
  allSettled: (xs: readonly unknown[]) => {
    const d = ours(xs);
    return d
      ? d.host.combine("allSettled", xs as Durable<unknown>[])
      : sdk.RestatePromise.allSettled(xs as never);
  },
} as unknown as typeof sdk.RestatePromise;

export const isRestatePromise: typeof sdk.isRestatePromise = <T>(
  p: Promise<T>,
): p is sdk.RestatePromise<T> => p instanceof Durable || sdk.isRestatePromise(p);
