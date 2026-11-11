import { describe, expect, it } from "vitest";
import { errorOf, exitCodeOf } from "../src/errors.js";
import { realRungs } from "../src/reach/ladder.js";
import {
  checkUrl,
  followChecked,
  guardedLookup,
  NetRefused,
  type NetRules,
  refusedAddress,
} from "../src/reach/net-guard.js";

const mac: NetRules = { loopback: true, private: false, allowDomains: [] };
const server: NetRules = { ...mac, loopback: false };
const resolvesTo = (ip: string) => async () => [{ address: ip }];

describe("refusedAddress", () => {
  it.each([
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "fd00::1",
    "fe80::1",
    "::",
    "::ffff:10.0.0.1",
    "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
    "64:ff9b::a9fe:a9fe", // NAT64 of the same
    "64:ff9b::192.168.0.1",
  ])("refuses %s", (ip) => {
    expect(refusedAddress(ip, mac)).not.toBeNull();
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111", "2002:0808:0808::1"])("allows %s", (ip) => {
    expect(refusedAddress(ip, mac)).toBeNull();
  });

  it("loopback follows the rule", () => {
    expect(refusedAddress("127.0.0.1", mac)).toBeNull();
    expect(refusedAddress("::1", mac)).toBeNull();
    expect(refusedAddress("127.0.0.1", server)).toMatch(/loopback/);
    expect(refusedAddress("::ffff:127.0.0.1", server)).toMatch(/loopback/);
  });

  it("private opens with its rule", () => {
    expect(refusedAddress("192.168.1.1", { ...mac, private: true })).toBeNull();
  });
});

describe("checkUrl", () => {
  it("refuses other schemes; the browser also takes about: and data:", async () => {
    await expect(checkUrl("file:///etc/passwd", { rules: mac })).rejects.toThrow(/scheme file:/);
    await expect(checkUrl("about:blank", { rules: mac })).rejects.toThrow(NetRefused);
    await checkUrl("about:blank", { rules: mac, browser: true });
    await checkUrl("data:text/html,<p>x</p>", { rules: mac, browser: true });
    await expect(checkUrl("javascript:1", { rules: mac, browser: true })).rejects.toThrow(/scheme/);
  });

  it("refuses a public name that resolves to a private address", async () => {
    await expect(
      checkUrl("https://evil.example/", { rules: mac, lookup: resolvesTo("169.254.169.254") }),
    ).rejects.toThrow(/evil\.example → 169\.254\.169\.254/);
    await checkUrl("https://ok.example/", { rules: mac, lookup: resolvesTo("93.184.215.14") });
  });

  it("reads IP literals and localhost without DNS", async () => {
    const lookup = async () => {
      throw new Error("no DNS here");
    };
    await expect(checkUrl("http://[fd00::1]/", { rules: mac, lookup })).rejects.toThrow(/private/);
    await checkUrl("http://localhost:9090/", { rules: mac, lookup });
    await expect(checkUrl("http://app.localhost/", { rules: server, lookup })).rejects.toThrow(
      /loopback/,
    );
  });

  it("allowDomains matches by suffix", async () => {
    const rules = { ...mac, allowDomains: ["example.com"] };
    const lookup = resolvesTo("93.184.215.14");
    await checkUrl("https://example.com/a", { rules, lookup });
    await checkUrl("https://www.example.com/a", { rules, lookup });
    await expect(checkUrl("https://badexample.com/", { rules, lookup })).rejects.toThrow(
      /NET_ALLOW_DOMAINS/,
    );
  });
});

describe("followChecked", () => {
  const reply = (status: number, location?: string) => ({
    status,
    headers: { get: (n: string) => (n === "location" ? (location ?? null) : null) },
  });

  it("refuses a redirect into a private address before fetching it", async () => {
    const asked: string[] = [];
    const get = async (u: string) => {
      asked.push(u);
      return u.startsWith("https://8.8.8.8")
        ? reply(302, "http://169.254.169.254/latest")
        : reply(200);
    };
    await expect(followChecked("https://8.8.8.8/start", get, mac)).rejects.toThrow(NetRefused);
    expect(asked).toEqual(["https://8.8.8.8/start"]);
  });

  it("follows public hops and names the last", async () => {
    const get = async (u: string) => (u.endsWith("/a") ? reply(301, "/b") : reply(200));
    const res = await followChecked("https://8.8.8.8/a", get, mac);
    expect(res.finalUrl).toBe("https://8.8.8.8/b");
  });
});

describe("guardedLookup", () => {
  it("refuses at connect time", async () => {
    const lookup = guardedLookup(server);
    const err = await new Promise<Error | null>((done) =>
      lookup("localhost", {}, (e) => done(e as Error | null)),
    );
    expect(err).toBeInstanceOf(NetRefused);
  });
});

describe("ladder", () => {
  it("the plain rung refuses a redirect to the metadata address", async () => {
    const rungs = realRungs({
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        })) as never,
    });
    await expect(rungs.plain("https://8.8.8.8/")).rejects.toThrow(NetRefused);
  });
});

describe("error contract", () => {
  it("maps to url_refused, 403, not retryable", () => {
    const e = errorOf(new NetRefused("http://10.0.0.1/", "private"));
    expect(e).toMatchObject({ code: "url_refused", status: 403, retryable: false });
    expect(exitCodeOf(e)).toBe(77);
  });
});
