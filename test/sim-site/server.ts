/**
 * A local sign-in site that changes on command (designs/2026-11-26-branching-sign-ins.md,
 * Proof 5): renamed controls, a new page between steps, a wrong password, a wrong code
 * and a resend, a page no screen knows, a password box that is not one, another origin.
 * It counts bad secrets and locks the account the way a real site does.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SimConfig {
  userLabel: string;
  passLabel: string;
  submitText: string;
  /** `text`: a password box that is not `input[type=password]`. */
  passType: "password" | "text";
  password: string;
  /** Where a good password goes. */
  after: "feed" | "code" | "interstitial" | "odd";
  /** Where the interstitial's Continue goes. */
  afterInterstitial: "feed" | "odd";
  /** The one code the site takes. */
  code: string;
  /** Bad passwords before the account locks. */
  lockAfter: number;
  /** `/login` sends the browser to this origin instead (a wrong origin). */
  loginAt: string | null;
}

export interface SimCounts {
  badPasswords: number;
  goodPasswords: number;
  badCodes: number;
  sends: number;
  /** Every password the site got, good or bad. */
  passwords: number;
  locked: boolean;
}

export interface SimSite {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  config: SimConfig;
  counts: SimCounts;
  set(c: Partial<SimConfig>): void;
  close(): Promise<void>;
}

const DEFAULTS: SimConfig = {
  userLabel: "Username",
  passLabel: "Password",
  submitText: "Log in",
  passType: "password",
  password: "pw-a-1",
  after: "feed",
  afterInterstitial: "feed",
  code: "246810",
  lockAfter: 3,
  loginAt: null,
};

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

export async function simSite(over: Partial<SimConfig> = {}): Promise<SimSite> {
  const config: SimConfig = { ...DEFAULTS, ...over };
  const counts: SimCounts = {
    badPasswords: 0,
    goodPasswords: 0,
    badCodes: 0,
    sends: 0,
    passwords: 0,
    locked: false,
  };
  let signedIn = false;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://sim");
    const send = (html: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const go = (path: string) => {
      res.writeHead(303, { location: path });
      res.end();
    };
    const at = `${req.method} ${url.pathname}`;
    if (counts.locked && url.pathname !== "/locked") return go("/locked");
    switch (at) {
      case "GET /login": {
        if (config.loginAt) return go(`${config.loginAt}/login`);
        if (signedIn) return go("/feed");
        const said = url.searchParams.get("e")
          ? "<p role=alert>Sorry, your password was incorrect.</p>"
          : "";
        return send(
          page(
            "Log in",
            `<h1>Log in to Sim</h1>${said}<form method=post action=/login>
<label for=u>${config.userLabel}</label><input id=u name=u autocomplete=username>
<label for=p>${config.passLabel}</label><input id=p name=p type=${config.passType}>
<button type=submit>${config.submitText}</button></form>`,
          ),
        );
      }
      case "POST /login": {
        const f = await form(req);
        counts.passwords += 1;
        if (f.get("p") !== config.password) {
          counts.badPasswords += 1;
          if (counts.badPasswords >= config.lockAfter) {
            counts.locked = true;
            return go("/locked");
          }
          return go("/login?e=1");
        }
        counts.goodPasswords += 1;
        if (config.after === "feed") signedIn = true;
        return go(`/${config.after === "code" ? "two_factor" : config.after}`);
      }
      case "GET /two_factor": {
        const said = url.searchParams.get("e")
          ? "<p role=alert>That code isn't right. Send a new code.</p>"
          : url.searchParams.get("sent")
            ? "<p>We sent a new code.</p>"
            : "";
        return send(
          page(
            "Security code",
            `<h1>Enter your security code</h1>${said}<form method=post action=/two_factor>
<label for=c>Security code</label><input id=c name=c autocomplete=one-time-code inputmode=numeric maxlength=6>
<button type=submit>Confirm</button></form>
<form method=post action=/send><button type=submit>Send code</button></form>`,
          ),
        );
      }
      case "POST /two_factor": {
        const f = await form(req);
        if (f.get("c") !== config.code) {
          counts.badCodes += 1;
          return go("/two_factor?e=1");
        }
        signedIn = true;
        return go("/feed");
      }
      case "POST /send":
        counts.sends += 1;
        return go("/two_factor?sent=1");
      case "GET /interstitial":
        return send(
          page(
            "Before you go on",
            `<h1>Before you go on</h1><p>We updated our terms.</p>
<form method=post action=/interstitial><button type=submit>Continue to app</button></form>`,
          ),
        );
      case "POST /interstitial":
        if (config.afterInterstitial === "feed") signedIn = true;
        return go(`/${config.afterInterstitial}`);
      case "GET /odd":
        return send(page("New", "<h1>Something new</h1><button>Something new</button>"));
      case "GET /feed":
        if (!signedIn) return go("/login");
        return send(page("Feed", "<h1>Your feed</h1><nav><a href=/me>Profile</a></nav>"));
      case "GET /locked":
        return send(page("Locked", "<h1>Your account is locked</h1>"));
      default:
        return send(page("Not found", "<h1>Not found</h1>"), 404);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    config,
    counts,
    set: (c) => Object.assign(config, c),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
