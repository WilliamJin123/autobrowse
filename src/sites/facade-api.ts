import type { DoneActs } from "../browser/attempt.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import type { Strategy } from "../browser/ladder.js";
import type { Render } from "../browser/render.js";
import type { HttpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import type { JsonSchema } from "../engine/inputs.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Approver } from "../gates/payment.js";
import type { SpentKeys } from "../reach/key-ring.js";
import type { KeysDep } from "../reach/key-source.js";
import type { ErrorCode } from "../ui/http.js";
import type { Proof, RunAs } from "../workflows/proof.js";
import type { BreakerState } from "./breaker.js";
import type { CallCache } from "./call-cache.js";
import type { DailyCaps, Hold, MeteredCall } from "./caps.js";
import type { Effective, LimitStore, SiteLimits } from "./limits.js";
import type { MintedTokens } from "./oauth.js";
import type { RefusedToken } from "./refused.js";
import type { RenewReport } from "./renew.js";
import type { Access, Method, SetupStep, SiteApi, Standing } from "./types.js";
import type { UploadSessions } from "./uploads.js";
import type { NoVerify, RouteVerify } from "./verdict.js";

export interface SiteFacadeDeps {
  http: HttpClient;
  /** Where keys and tokens are read from (process.env on the box, the .env locally). */
  env: (name: string) => string | undefined;
  /** Where setup puts what it made. */
  sink: SecretSink;
  /** Access tokens minted by any process on this machine, reused instead of minted again. */
  minted?: MintedTokens;
  runner: FlowRunner;
  flow(name: string): BrowserFlow<never, unknown> | null;
  /** Compiled workflows by name, run in-process with gates approved (the caller gated the route). */
  compiled?: {
    get(name: string): Promise<AnyWorkflow | null>;
    run(workflow: AnyWorkflow, plan: Record<string, unknown>, as?: RunAs): Promise<CompiledRun>;
  };
  /** Loopback port for OAuth redirects. */
  oauthPort?: number;
  /**
   * The browser profile that holds an account of a site (`google@will` for
   * will@x.dev), so its consent runs signed in as it; the flow's own site
   * when absent (the chooser then picks).
   */
  profileFor?: (site: string, account: string) => Promise<string | null>;
  /**
   * The identity provider a site's accounts sign in at (`google` for a site
   * whose consent is Google's); null when its accounts are its own (LinkedIn).
   */
  providerOf?: (site: SiteApi) => string | null;
  /**
   * The account a call or setup step is for when the caller names none: the
   * person's account for the site's (or step's) purpose at the provider the
   * consent signs in with; null means the site's own token and profile.
   */
  accountFor?: (site: SiteApi, step?: SetupStep) => Promise<string | null>;
  now?: () => number;
  /** Kept read answers (call-cache.ts); none: every call reads the site. */
  cache?: CallCache;
  /**
   * Who says yes to a route that commits money (the spend policy, then the
   * person). Absent: every such call is refused, as the browser's gate is
   * without a channel.
   */
  approve?: Approver | null;
  /** Counts routes' `meter` against the site's `caps`, per account per day, and books `pace` slots; absent: nothing is capped. */
  caps?: DailyCaps;
  /** The operator's limits over each site's `caps`, `accountCaps` and `pace` (`limits.json`); absent: the defaults. */
  limits?: LimitStore;
  /** Paid keys out of credit (`reach/key-ring.ts`), for `capsPerKey` and api legs that rotate keys. */
  spent?: SpentKeys;
  /** The vault's keys and their audit (`reach/key-source.ts`); absent, paid keys are the env names and no use is audited. */
  keys?: KeysDep;
  /** Resumable upload sessions by durable call, so a rerun call resumes its bytes. */
  uploads?: UploadSessions;
  /** A page in a stealth browser, for the fetch ladder's render and exit rungs (`browser/render.ts`). */
  render?: Render;
  /** Irreversible API calls already started, by durable call: a rerun of one is refused. */
  started?: DoneActs;
  /** How a paced call waits for its slot (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The username behind a credential name the caller used for an account
   * (`linkedin@research`, or `linkedin` for the site's own): null when the
   * name is not one, and the account is taken as an address.
   */
  accountOf?: (site: string, name: string) => Promise<string | null>;
  /** An API leg answered with the token kept under `name`: a refusal of it is over. */
  worked?: (name: string) => void;
  /** The site's words when the value kept under `name` was refused; null when it may be called. */
  held?: (name: string) => string | null;
}

export type CompiledRun = Pick<Proof, "status" | "steps" | "output">;

export interface RouteRow {
  method: Method;
  path: string;
  summary: string;
  /** How it answers right now: the API, the browser, or nothing yet (`missing` says what). */
  via: "api" | "browser" | "none";
  missing?: string;
  /** Why this leg: for good, or what it waits on (`sites/standing.ts`). Absent: the API, nothing gated. */
  standing?: Standing;
  /** `read` or `write` (`accessOf`). */
  access: Access;
  /** A laddered browser leg's ways, in order (`browser/ladder`). */
  strategies?: readonly Strategy[];
  /** Ported from OpenCLI: `clis/<site>/<file>@<sha>`. */
  ported?: string;
  irreversible: boolean;
  /** Can commit money: gated on the person before the API leg. */
  spends: boolean;
  /** What the request takes, as JSON Schema: body for writes, query + path params for reads. */
  request: JsonSchema;
}

export interface SetupRow extends Pick<SetupStep, "name" | "makes" | "needs" | "summary"> {
  done: boolean;
  /** Needs not yet present. */
  blockedOn: string[];
  /** The flow this step runs, when nobody has recorded it yet. */
  unrecorded?: string;
  /** What the step's flow is handed; `--input` overrides any key. */
  input?: Record<string, unknown>;
}

export interface SiteRow {
  site: string;
  origin: string;
  /** A bearer can be minted now. */
  authed: boolean;
  routes: RouteRow[];
  /** What its routes wait on, by id. */
  blockers?: NonNullable<SiteApi["blockers"]>;
  setup: SetupRow[];
  probe?: SiteApi["probe"];
  /** Its tokens the platform refused, open incidents (`refused.ts`); absent when none are kept. */
  refused?: RefusedToken[];
}

/** Who is calling, for the caps ledger: `caller` as the caller names itself, `invocation` its Restate id. */
export interface CallFrom {
  caller?: string | null;
  invocation?: string;
  /** Run the browser leg up to its last safe step and answer `{armed}`; nothing is sent. */
  arm?: boolean;
  /** An earlier `arm`'s id: run the leg in its tab. Without it, the newest arm on the same path. */
  armId?: string;
  /** A send's verify read: metered in the site's `verify` bucket, not the route's own. */
  verify?: boolean;
  /** Skip the kept answer: read the site now (the answer is kept for the next caller). */
  fresh?: boolean;
}

/** What `arm` answers: an id for the call to carry, or null when there is nothing to warm. */
export interface Armed {
  armed: string | null;
  until?: string;
}

export interface CapsReport {
  day: string;
  /** By `site|account|bucket`; today's only (a past day keeps its calls, not its counts). */
  used: Record<string, number>;
  /** Tries by the same key: `used` plus the failures that reached the site. */
  tried: Record<string, number>;
  /** Buckets held now (the site undid an act): when each hold ends and its step. */
  held: Record<string, Hold>;
  calls: MeteredCall[];
}

/**
 * What a keyed write needs from its route to settle (`service.ts`, `send-journal.ts`): whether it
 * publishes, how a verify read proves it, and the id and link of what it made.
 */
export interface SendSpec {
  irreversible: boolean;
  /** Absent: the route declares nothing, so an unclear end stays `unknown`. */
  verify?: RouteVerify<unknown> | NoVerify;
  sentAs?: (output: unknown) => { id: string | null; url: string | null };
  /** The route's own input for this request: path params and query folded in, defaults applied. */
  parse(path: string, input: Record<string, unknown>): unknown;
}

export interface LimitsRow extends Effective {
  site: string;
  set: SiteLimits;
}

export interface SiteFacade {
  list(): Promise<SiteRow[]>;
  /** API-leg breakers that have seen a fault or a trip in this process (breaker.ts). */
  breakers?(): BreakerState[];
  status(site: string): Promise<SiteRow>;
  /** One call as the official API takes it: path params in the path, query for reads, body for writes. */
  call(
    site: string,
    method: Method,
    path: string,
    input: Record<string, unknown>,
    account?: string | null,
    from?: CallFrom,
  ): Promise<unknown>;
  /**
   * The route a write would hit, as a keyed call settles it. Throws `SiteError` 404 for a path
   * that is no route. Absent on a stand-in: the call then has no verify read.
   */
  sendSpec?(site: string, method: Method, path: string): SendSpec;
  /** A day's capped reads (today when absent): what each bucket used and every metered call, who asked. */
  caps(day?: string, site?: string): CapsReport;
  /** Each capped or paced site's limits now (`effective`), and what `limits.json` sets of them (`set`). */
  limits(site?: string): LimitsRow[];
  /** Change one site's limits in `limits.json` (`LimitStore.edit`); 404 for an unknown site. */
  editLimits(
    site: string,
    fn: (l: SiteLimits) => SiteLimits,
  ): { before: SiteLimits; after: SiteLimits; path: string };
  /** Run one setup step; what it makes lands in the sink (under the account's name, with one). */
  setup(
    site: string,
    step: string,
    account?: string | null,
    /** Force the browser profile the step runs in (a second profile for the same account). */
    profile?: string | null,
    /** Over the step's own input, key by key: a token's name, scopes, expiry for this run. */
    input?: Record<string, unknown>,
    /** `replace`: yes to the question a step asks when a name it makes holds a value. */
    o?: { replace?: boolean },
  ): Promise<{ made: readonly string[] }>;
  /**
   * Make again every kept token that lapses within the renew window, by the
   * setup step and account that made it; `dry` only says which. Absent when
   * nothing lists what is kept.
   */
  renew?(o?: { dry?: boolean; names?: readonly string[] }): Promise<RenewReport>;
  /**
   * End the grant behind a site's token at the site (`OAuthSpec.revoke`): the only way our code
   * revokes. Answers the kept names it covered, now dead; the caller makes them again.
   */
  revoke?(site: string, account?: string | null): Promise<{ revoked: string[] }>;
  /**
   * Open refused-token incidents, oldest first. Async like every other method: a facade behind
   * `holding` answers each call through a hold, so a sync answer would arrive as a Promise.
   */
  refused?(): Promise<RefusedToken[]>;
  /** Incidents no re-make was queued for yet, now marked queued: each one once. */
  claimRefused?(): Promise<RefusedToken[]>;
}

export interface CheckRow {
  site: string;
  ok: boolean;
  ms?: number;
  /** Why not: no probe, no token, or the API's answer. */
  why?: string;
  /** The error contract's code when the call threw (the probe's state). */
  code?: ErrorCode;
}
