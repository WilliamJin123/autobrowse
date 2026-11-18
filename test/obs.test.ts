import { describe, expect, it } from "vitest";
import { deadCapture, obsLogin } from "../src/film/obs.js";

describe("obsLogin", () => {
  const cfg = (o: object) => JSON.stringify({ server_enabled: true, server_port: 4455, ...o });
  it("reads the port and the password OBS keeps", () => {
    expect(obsLogin(cfg({ auth_required: true, server_password: "pw" }), {})).toEqual({
      url: "ws://127.0.0.1:4455",
      password: "pw",
    });
  });
  it("sends no password when OBS asks for none", () => {
    expect(
      obsLogin(cfg({ auth_required: false, server_password: "pw", server_port: 4460 }), {}),
    ).toEqual({
      url: "ws://127.0.0.1:4460",
    });
  });
  it("lets the env win", () => {
    expect(
      obsLogin(cfg({ auth_required: true, server_password: "pw" }), {
        OBS_WEBSOCKET_URL: "ws://box:4455",
        OBS_WEBSOCKET_PASSWORD: "env",
      }),
    ).toEqual({ url: "ws://box:4455", password: "env" });
  });
  it("says how to turn the websocket on", () => {
    expect(() => obsLogin(cfg({ server_enabled: false }), {})).toThrow(/WebSocket Server Settings/);
  });
  it("defaults with no config", () => {
    expect(obsLogin(null, {})).toEqual({ url: "ws://127.0.0.1:4455" });
  });
});

describe("deadCapture", () => {
  it("finds a screen stream macOS ended", () => {
    const log = [
      "17:10:55.655:     - source: 'film display' (screen_capture)",
      '16:45:12.418: [ mac-screencapture ]: Stream stopped with error -3805 ("Failed during stream due to application connection being interrupted")',
    ].join("\n");
    expect(deadCapture(log)).toMatch(/-3805/);
  });

  it("passes a live log", () => {
    expect(deadCapture("17:34:19.977: ==== Recording Start ====")).toBeNull();
  });
});
