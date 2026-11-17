// Copied from wren packages/runtime/src/pg/registry.ts at dc80ecd28, unchanged: edit there, then copy (designs/2026-11-16-local-runner.md).
/**
 * Reads Restate SDK definitions (`restate.service` / `restate.object`) as they are: one definition
 * runs on either executor. The SDK hangs each handler's wrapper on a local `Symbol("Handler")`.
 */
import type * as restate from "@restatedev/restate-sdk";

/** HandlerKind in the SDK: 0 service, 1 exclusive, 2 shared, 3 workflow. */
export const KIND = { SERVICE: 0, EXCLUSIVE: 1, SHARED: 2, WORKFLOW: 3 } as const;

export interface RetryPolicy {
  maxAttempts?: number | undefined;
  onMaxAttempts?: "pause" | "kill" | undefined;
  initialInterval?: number | restate.Duration | undefined;
  maxInterval?: number | restate.Duration | undefined;
  exponentiationFactor?: number | undefined;
}

/** The SDK's HandlerWrapper, the part we call. */
export interface Wrapper {
  kind: number;
  options?: {
    input?: restate.Serde<unknown>;
    output?: restate.Serde<unknown>;
    retryPolicy?: RetryPolicy;
    ingressPrivate?: boolean;
    metadata?: Record<string, string>;
  };
  invoke(context: unknown, input: Uint8Array): Promise<Uint8Array>;
}

export interface Handler {
  service: string;
  name: string;
  object: boolean;
  exclusive: boolean;
  /** Not callable from the ingress (the door): only from another handler. */
  private: boolean;
  wrapper: Wrapper;
  retry: RetryPolicy | undefined;
  serde: restate.Serde<unknown> | undefined;
}

type Def = {
  name: string;
  _kind?: string;
  service?: Record<string, unknown>;
  object?: Record<string, unknown>;
  options?: {
    retryPolicy?: RetryPolicy;
    serde?: restate.Serde<unknown>;
    ingressPrivate?: boolean;
  };
};

const wrapperOf = (fn: unknown): Wrapper | undefined => {
  if (typeof fn !== "function") return undefined;
  const sym = Object.getOwnPropertySymbols(fn).find((s) => s.description === "Handler");
  return sym ? ((fn as unknown as Record<symbol, Wrapper>)[sym] as Wrapper) : undefined;
};

/** One handler as the console's Call form reads it (was Restate's admin `/services` + OpenAPI). */
export interface HandlerSpec {
  service: string;
  handler: string;
  kind: "service" | "object";
  /** Callable through the door. */
  public: boolean;
  /** The handler's `metadata` option (`effect`: spends, sends, posts). */
  metadata: Readonly<Record<string, string>>;
  /** Input JSON schema, when its serde declares one (`serde.schema(zod)`). */
  input?: unknown;
}

export class Registry {
  private handlers = new Map<string, Handler>();
  readonly services = new Map<string, { object: boolean }>();

  constructor(defs: readonly unknown[]) {
    for (const d of defs as Def[]) {
      const object = d._kind === "object";
      if (d._kind !== "service" && !object)
        throw new Error(`rt: ${d.name}: only services and objects`);
      this.services.set(d.name, { object });
      for (const [name, fn] of Object.entries((object ? d.object : d.service) ?? {})) {
        const wrapper = wrapperOf(fn);
        if (!wrapper) throw new Error(`rt: ${d.name}/${name}: not an SDK handler`);
        this.handlers.set(`${d.name}/${name}`, {
          service: d.name,
          name,
          object,
          exclusive: object && wrapper.kind === KIND.EXCLUSIVE,
          private: wrapper.options?.ingressPrivate ?? d.options?.ingressPrivate ?? false,
          wrapper,
          retry: wrapper.options?.retryPolicy ?? d.options?.retryPolicy,
          serde: d.options?.serde,
        });
      }
    }
  }

  list(): Handler[] {
    return [...this.handlers.values()];
  }

  /** Every handler with its kind, visibility, metadata and input schema. */
  specs(): HandlerSpec[] {
    return this.list().map((h) => {
      const schema = (h.wrapper.options?.input ?? h.serde)?.jsonSchema;
      return {
        service: h.service,
        handler: h.name,
        kind: h.object ? "object" : "service",
        public: !h.private,
        metadata: h.wrapper.options?.metadata ?? {},
        ...(schema === undefined ? {} : { input: schema }),
      };
    });
  }

  get(service: string, handler: string): Handler | undefined {
    return this.handlers.get(`${service}/${handler}`);
  }
}
