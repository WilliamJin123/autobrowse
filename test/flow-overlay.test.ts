import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { overlayOn } from "../src/app/services-signin.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import type { OverlayHost } from "../src/explore/overlay-host.js";

const PAGE = "<title>t</title><input aria-label=Card><button>Pay</button><p id=total>Total 12</p>";

/** The overlay's window as a recorder: each `ui.draw` line it gets, run against a plain `ui`. */
const recorder = () => {
  const ui = {
    s: null as Record<string, unknown> | null,
    rows: [] as unknown[],
    draw(s: Record<string, unknown>, list: unknown[], reset: boolean) {
      ui.s = s;
      ui.rows = reset ? list : [...ui.rows, ...list];
    },
  };
  let made = 0;
  const host = async (): Promise<OverlayHost> => {
    made++;
    return {
      send: (o) => {
        if (o.t === "js") new Function("ui", o.js as string)(ui);
      },
      on: () => undefined,
      close: () => undefined,
    };
  };
  return {
    host,
    seen: () => (ui.s ? { ...ui.s, trace: ui.rows } : null),
    get made() {
      return made;
    },
  };
};

describe("the overlay on a flow run", () => {
  const server = createServer((_q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end(PAGE),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pay?token=t`),
    ),
  );
  afterAll(() => server.close());
  const runnerWith = (
    overlay: boolean | undefined,
    overlayHost: ReturnType<typeof recorder>["host"],
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-flow-overlay-"));
    return flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, overlayHost, ...(overlay === undefined ? {} : { overlay }) },
    );
  };
  const pay = (seen: () => void) =>
    defineFlow<string, void>({
      site: "scratch",
      name: "pay",
      async run(fp, url) {
        await fp.open(url);
        await fp.act(
          { kind: "fill", value: "4242424242424242" },
          { role: "textbox", name: "Card" },
          { goal: "type the card" },
        );
        await fp.read({ css: "#total" });
        await fp.act({ kind: "click" }, { role: "button", name: "Pay" }, { goal: "pay" });
        seen();
      },
    });

  it("draws a row per step with its goal, never a typed value or a query", async () => {
    const url = await ready;
    let s: {
      goal: string;
      trace: Array<{ cmd: string; what: string; ok: boolean; note: string }>;
    } | null = null;
    const r = recorder();
    await runnerWith(true, r.host).run(
      pay(() => {
        s = r.seen() as typeof s;
      }),
      url,
    );
    expect(s).not.toBeNull();
    const got = s as unknown as NonNullable<typeof s>;
    expect(got.goal).toBe("scratch/pay");
    expect(got.trace.map((r) => [r.cmd, r.ok])).toEqual([
      ["open", true],
      ["fill", true],
      ["read", true],
      ["click", true],
    ]);
    expect(got.trace[1]?.what).toContain("type the card");
    expect(got.trace[2]?.note).toBe("8 chars read");
    expect(JSON.stringify(got)).not.toContain("4242");
    expect(JSON.stringify(got)).not.toContain("token");
  }, 60_000);

  it("is off unless asked", async () => {
    let s: unknown = "unset";
    const r = recorder();
    await runnerWith(undefined, r.host).run(
      pay(() => {
        s = r.seen();
      }),
      await ready,
    );
    expect(s).toBeNull();
    expect(r.made).toBe(0);
  }, 60_000);

  it("is on headed, off for a film or the desk, and a flag wins", () => {
    const at = (overlay: string, film?: string) => ({ overlay, film }) as never;
    expect(overlayOn(at("auto"), { headless: false })).toBe(true);
    expect(overlayOn(at("auto", "/f"), { headless: false })).toBe(false);
    expect(overlayOn(at("auto"), {})).toBe(false);
    expect(overlayOn(at("on"), {})).toBe(true);
    expect(overlayOn(at("auto", "/f"), { overlay: true })).toBe(true);
  });
});
