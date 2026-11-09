// The desk's pull from wren's door (src/app/door-pull.ts): a fake door, real SDK handlers.
import * as restate from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";
import { type Call, type DoorPost, plainContext, pullFromDoor } from "../src/app/door-pull.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString());
const call = (handler: string, input: unknown, extra: Partial<Call> = {}): Call => ({
  id: `inv_${handler}`,
  attempt: 1,
  service: "desk",
  handler,
  input: b64(input),
  headers: { "x-caller": "wren:test" },
  cancel: false,
  ...extra,
});
const quiet = () => {};

/** A door that hands out `queue` once, then nothing; records every post. */
function fakeDoor(queue: Call[], answer?: (path: string, body: unknown) => unknown) {
  const posts: { path: string; body: Record<string, unknown>; headers?: Record<string, string> }[] =
    [];
  let handed = false;
  const door: DoorPost = async (path, body, headers) => {
    posts.push({ path, body: body as Record<string, unknown>, ...(headers ? { headers } : {}) });
    if (path === "/rt/register") return { status: 200, text: "{}" };
    if (path === "/rt/claim") {
      if (handed) {
        await new Promise((r) => setTimeout(r, 20));
        return { status: 200, text: JSON.stringify({ calls: [] }) };
      }
      handed = true;
      return { status: 200, text: JSON.stringify({ calls: queue }) };
    }
    if (path === "/rt/renew") return { status: 200, text: JSON.stringify({ cancel: false }) };
    if (path === "/rt/finish") return { status: 200, text: "{}" };
    const a = answer?.(path, body);
    return a === undefined
      ? { status: 404, text: JSON.stringify({ message: "nope" }) }
      : { status: 200, text: JSON.stringify(a) };
  };
  const finished = () => posts.filter((p) => p.path === "/rt/finish");
  return { door, posts, finished };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};

const desk = restate.service({
  name: "desk",
  handlers: {
    status: async (ctx: restate.Context, req: { site: string }) => ({
      site: req.site,
      by: ctx.request().headers.get("x-caller"),
      id: ctx.request().id,
      step: await ctx.run("read", () => "ok"),
    }),
    refuse: async () => {
      throw new restate.TerminalError("no such site", { errorCode: 400 });
    },
    flaky: async () => {
      throw new Error("site down");
    },
    hidden: restate.handlers.handler({ ingressPrivate: true }, async () => 1),
  },
  options: { retryPolicy: { maxAttempts: 7 } },
});

describe("pullFromDoor", () => {
  it("registers each handler, runs a call and finishes with its value", async () => {
    const f = fakeDoor([call("status", { site: "linkedin" })]);
    const p = await pullFromDoor({
      door: f.door,
      services: [desk],
      retry: { maxAttempts: 1500 },
      concurrency: 2,
      log: quiet,
    });
    await until(() => f.finished().length === 1);
    await p.stop();
    expect(f.posts[0]).toEqual({
      path: "/rt/register",
      body: {
        services: [
          {
            name: "desk",
            handlers: [
              { name: "status", private: false },
              { name: "refuse", private: false },
              { name: "flaky", private: false },
              { name: "hidden", private: true },
            ],
          },
        ],
      },
    });
    const fin = f.finished()[0]?.body as { id: string; attempt: number; value: string };
    expect(fin.id).toBe("inv_status");
    expect(unb64(fin.value)).toEqual({
      site: "linkedin",
      by: "wren:test",
      id: "inv_status",
      step: "ok",
    });
  });

  it("a TerminalError ends the call; any other error fails it on the service's policy", async () => {
    const f = fakeDoor([call("refuse", {}), call("flaky", {})]);
    const p = await pullFromDoor({
      door: f.door,
      services: [desk],
      retry: { maxAttempts: 1500 },
      concurrency: 4,
      log: quiet,
    });
    await until(() => f.finished().length === 2);
    await p.stop();
    const by = new Map(f.finished().map((x) => [x.body.id, x.body]));
    expect(by.get("inv_refuse")).toMatchObject({
      error: { message: "no such site", code: 400 },
      terminal: true,
    });
    expect(by.get("inv_flaky")).toMatchObject({
      error: { message: "site down" },
      terminal: false,
      retry: { maxAttempts: 7 },
    });
  });

  it("a door that refuses the register does not stop the desk: it registers later, then claims", async () => {
    const f = fakeDoor([call("status", { site: "x" })]);
    let refusals = 2;
    const door: DoorPost = (path, body, headers) =>
      path === "/rt/register" && refusals-- > 0
        ? Promise.resolve({ status: 404, text: "old build" })
        : f.door(path, body, headers);
    const logs: string[] = [];
    const p = await pullFromDoor({
      door,
      services: [desk],
      retry: {},
      concurrency: 1,
      retryMs: 5,
      log: (m) => logs.push(m),
    });
    await until(() => f.finished().length === 1);
    await p.stop();
    expect(logs.filter((m) => m === "door pull: register refused")).toHaveLength(2);
    expect(f.posts.map((x) => x.path).slice(0, 2)).toEqual(["/rt/register", "/rt/claim"]);
  });

  it("a call wren cancelled before it ran ends with 409, unrun", async () => {
    const f = fakeDoor([call("status", { site: "x" }, { cancel: true })]);
    const p = await pullFromDoor({
      door: f.door,
      services: [desk],
      retry: {},
      concurrency: 1,
      log: quiet,
    });
    await until(() => f.finished().length === 1);
    await p.stop();
    expect(f.finished()[0]?.body).toMatchObject({
      error: { message: "cancelled", code: 409 },
      terminal: true,
    });
  });

  it("a handler the desk does not have is a terminal 404", async () => {
    const f = fakeDoor([call("gone", {})]);
    const p = await pullFromDoor({
      door: f.door,
      services: [desk],
      retry: {},
      concurrency: 1,
      log: quiet,
    });
    await until(() => f.finished().length === 1);
    await p.stop();
    expect(f.finished()[0]?.body).toMatchObject({ error: { code: 404 }, terminal: true });
  });
});

describe("plainContext", () => {
  const ctx = (state = { cancel: false }, answer?: (path: string, body: unknown) => unknown) => {
    const f = fakeDoor([], answer);
    return {
      f,
      ctx: plainContext(call("x", {}), f.door, state, quiet) as unknown as restate.Context,
    };
  };

  it("a capped run retries, then throws a TerminalError, as Restate", async () => {
    const { ctx: c } = ctx();
    let n = 0;
    const p = c.run(
      "write",
      async () => {
        n++;
        throw new Error("refused");
      },
      { maxRetryAttempts: 3, initialRetryInterval: { milliseconds: 1 } },
    );
    await expect(p).rejects.toBeInstanceOf(restate.TerminalError);
    expect(n).toBe(3);
  });

  it("a write run capped at one try runs once", async () => {
    const { ctx: c } = ctx();
    let n = 0;
    await expect(
      c.run(
        "send",
        async () => {
          n++;
          throw new Error("timeout");
        },
        { maxRetryAttempts: 1 },
      ),
    ).rejects.toThrow("timeout");
    expect(n).toBe(1);
  });

  it("an uncapped run throws its error: the call retries whole", async () => {
    const { ctx: c } = ctx();
    const p = c.run("read", async () => {
      throw new Error("blip");
    });
    await expect(p).rejects.not.toBeInstanceOf(restate.TerminalError);
  });

  it("a cancel stops at the next step", async () => {
    const state = { cancel: false };
    const { ctx: c } = ctx(state);
    expect(await c.run("a", () => 1)).toBe(1);
    state.cancel = true;
    await expect(c.run("b", () => 2)).rejects.toMatchObject({ code: 409 });
  });

  it("clients call through the door with the idempotency key and delay", async () => {
    const { f, ctx: c } = ctx(undefined, (path) =>
      path.endsWith("/send?delay=5000ms") ? { invocationId: "inv_1" } : { results: [] },
    );
    const got = await c
      .serviceClient<{ renew: (x: unknown) => Promise<unknown> }>({ name: "desk" })
      .renew({ names: ["a"] }, restate.rpc.opts({ idempotencyKey: "remake a 1" }));
    expect(got).toEqual({ results: [] });
    c.serviceSendClient<{ renew: (x: unknown) => Promise<unknown> }>({ name: "desk" }).renew(
      { names: ["b"] },
      restate.rpc.sendOpts({ idempotencyKey: "remake b 1", delay: { seconds: 5 } }),
    );
    await until(() => f.posts.length === 2);
    expect(f.posts).toEqual([
      { path: "/desk/renew", body: { names: ["a"] }, headers: { "idempotency-key": "remake a 1" } },
      {
        path: "/desk/renew/send?delay=5000ms",
        body: { names: ["b"] },
        headers: { "idempotency-key": "remake b 1" },
      },
    ]);
  });

  it("a door refusal is a TerminalError with its status; an unknown ctx member throws by name", async () => {
    const { ctx: c } = ctx();
    await expect(
      c.serviceClient<{ nope: () => Promise<unknown> }>({ name: "desk" }).nope(),
    ).rejects.toMatchObject({ code: 404, message: "nope" });
    expect(() => (c as unknown as { objectClient: unknown }).objectClient).toThrow(
      "ctx.objectClient is not served here",
    );
  });
});
