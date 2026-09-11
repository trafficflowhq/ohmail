import type {
  AdminDb, AuthService, ProposalsService, WaitlistService, PlatformSignalPort,
} from "@trafficflow/services";
import type {
  AlertSink, AlertThresholds, EvaluateOptions, MsOAuthBootstrap,
} from "@trafficflow/db/cloud";
import type { FetchLike, MicrosoftDeviceClient } from "@trafficflow/core";

/**
 * The hosted half of the dependency surface, declared where only a hosted build will see it.
 * `deps.ts` describes what any host of this route table must supply; the members here exist
 * only where there are accounts to administer and a pager to answer. Declared here and merged
 * into the interfaces next door so the file every host compiles does not name modules a
 * public checkout cannot resolve. Nothing changes for the hosted deployment (the barrel names
 * this module), and absence stays safe — each member is optional and absence selects the
 * refusing branch. A local build never loads this module, so its `ApiDeps` genuinely has no
 * operator connection; code assuming otherwise fails to compile.
 */
declare module "./deps.js" {
  interface ApiServices {
    /* `auth` MOVED to `deps.ts` (Phase 3), retyped as the carved `SessionLifecycle` the
     * ceremony's `AuthService` extends: the local engine now fills the member too — a bare
     * lifecycle over its own store, for the desktop-as-host pairing surface — so the
     * declaration had to live where every host compiles. The hosted compositions still put a
     * full `AuthService` there, and `routes/shared-cloud.ts#auth` is the ONE place the wider
     * type is recovered for the twenty ceremony routes. */
    /**
     * OPTIONAL, in the same grammar as `auth` above. The proposer READS a mailbox and asks a model
     * what workflow the user keeps performing by hand, so a host with no model configured can never
     * produce one. The LOCAL engine is exactly that host: routing there is rules-only, and
     * `GET /workflows/proposals` answers "not configured" rather than an empty list that would imply
     * the question had been asked and answered "none".
     */
    proposals?: ProposalsService;
    // The funnel: `POST /waitlist` and the operator invite mint (the mint has
    // no route; it is an operator action). OPTIONAL, and for the same reason: a host that
    // does not serve the landing's signup answers 503 `waitlist_unconfigured` rather than
    // 500ing. It needs no configuration of its own — the MAILER inside it is what may be
    // absent, and `WaitlistService` handles that by recording the row and reporting
    // `mailed: false`, so `apps/api-vercel` builds one unconditionally.
    waitlist?: WaitlistService;
    /**
     * What the platform served — the read port behind `GET /internal/platform-signals/run`.
     * Optional, and the three-way distinction is the reason this slot exists rather than the
     * pass reading `process.env`:
     *  · no port — nobody wired the question (desktop, self-host): `200 {skipped}`;
     *  · a port answering `unconfigured` — we asked, there is no platform token; the board
     *    renders "5xx: not measured";
     *  · a port answering `rows` — a real measurement, and a `0` in it is a real zero.
     * The first two both write nothing, so only a typed seam can tell them apart.
     */
    platformSignals?: PlatformSignalPort;
  }
  interface ApiDeps {
    /**
     * Deployment config for `GET /internal/alerts`. ABSENT ⇒ the route answers 404 and
     * this host has no alerting surface at all, which is the correct default: a deployment
     * that has not configured a shared secret must not expose an unauthenticated endpoint
     * that runs four aggregate queries and can send mail.
     */
    alerts?: AlertsConfig;
    /**
     * Deployment config for the six `GET /admin/*` reads. ABSENT ⇒ every one
     * of them answers **404** and this host has no admin surface, which is the only safe
     * default: these endpoints project every account on the platform, and a deployment that has
     * configured no secret must not advertise an endpoint whose authentication is an empty
     * string.
     */
    admin?: AdminConfig;
    /**
     * The content-blind connection every staff surface reads on — staff tooling must be
     * structurally unable to read mail content, not merely trusted not to. A factory, not a
     * handle: minting one is an `await` (`adminDbFor` requires `SELECT subject FROM messages
     * WHERE false` to raise 42501 before branding it), cached per cold instance. Absent ⇒
     * `/admin/*` answers 404 and `/internal/alerts*` answers 503 `alerts_db_unarmed` —
     * different on purpose: an unarmed console is intentionally absent, a configured pager
     * that cannot reach its database is broken. Deliberately no fallback to
     * {@link ApiDeps.db} — that handle can read every account's mail. A rejected promise ⇒ 503.
     */
    adminDb?: () => Promise<AdminDb>;
    /**
     * The env bootstrap for the Microsoft application registration, resolved by the host and
     * passed in. Absent ⇒ no env fallback: the `oauth_provider_config` row is the only source
     * and a deployment with neither answers "not configured" rather than throwing. Not read
     * from `process.env` in the route, for {@link AdminConfig}'s reason. The accepted
     * variable names — `MICROSOFT_*` aliases included — live in `msOAuthEnv`
     * (`packages/db/src/oauth-config.ts`), called by this host and the worker, so the two
     * cannot accept different sets. The client secret is in here: never logged (`log.ts`
     * redacts on the `secret` substring); the admin console reads `secretSet` and nothing else.
     */
    msOAuth?: MsOAuthBootstrap;
    /**
     * The public client the device-code flow runs as — a separate registration, absent on
     * every composition that does not mount the device routes. Not a fallback for
     * {@link msOAuth} and never resolved from it: a confidential application's client id is
     * refused outright on the device grant (`unauthorized_client` — that grant carries no
     * secret), so an operator's confidential registration has not thereby armed this door.
     * No secret field: a public registration has none and `clientAuthFields` refuses one.
     * Absent ⇒ the device door is dark: `GET …/availability` reports `device: false` and the
     * two device routes answer 503 with the reason named.
     */
    msDevice?: MicrosoftDeviceClient;
    /**
     * The BROWSER ORIGIN this deployment's app is served from, for the one route that has to build
     * an absolute redirect the browser will follow (the OAuth bounce). Absent ⇒ it falls back to
     * `defaultOrigin(authConfig)`, which is the same value and is already validated at boot; the
     * field exists so a host that serves its app somewhere other than its first WebAuthn origin can
     * say so, and so no route ever derives an origin from the REQUEST.
     */
    appOrigin?: string;
    /**
     * How this host reaches Microsoft's token endpoint — an injected port, exactly as
     * `RemoteFetch`, `HostResolver`, `OneClickPost` and `DraftPort` are: the suite performs
     * zero external requests by design, and a guard whose result comes from "that hostname
     * does not resolve in CI" gets its exit code from the harness rather than reality.
     * Absent ⇒ `globalThis.fetch`, which every deployment uses. A test injects a fake token
     * endpoint and drives the arms that matter: a rotated refresh token, `invalid_client`,
     * a 5xx, an `id_token` with no address claim, a grant with no `offline_access`.
     */
    oauthFetch?: FetchLike;
  }
}

/**
 * What the six `GET /admin/*` reads need. Built by the host from its environment, never read
 * from `process.env` inside a route. One secret: the caller is the admin console's own
 * server-side proxy — not a browser, not a person — so the secret never leaves the two
 * deployments that hold it. What it does not buy is an identity: no per-person revocation, no
 * actor to record — which is why this surface ships the reads and no write (a write needs a
 * name for the `audit_log` row). It must differ from {@link AlertsConfig.secret}: sharing
 * them would mean rotating the pager revokes staff access and vice versa.
 */
export interface AdminConfig {
  /**
   * The shared secret the proxy presents as `Authorization: Bearer <secret>`.
   *
   * Compared in CONSTANT TIME (`packages/api/src/secret-auth.ts`). There is no rate limit and
   * no lockout behind it, so its LENGTH is the only thing between a guesser and every
   * account's metadata — the host loader refuses anything shorter than 24 characters.
   */
  secret: string;
  /** `production` / `preview` — echoed as `OverviewSnapshot.environment`. */
  environment?: string;
  /**
   * How long a single admin read may take before the wrapper returns a bounded 503 instead of
   * riding to the platform's ~60 s gateway limit as a 504 — the shape of a real dashboard outage.
   * Defaults to `ADMIN_READ_TIMEOUT_MS` in `routes/admin.ts`; production leaves it unset. It is
   * here — a config field, not a `process.env` read in the route — so a test can drive the
   * timeout deterministically without waiting the production duration.
   */
  readTimeoutMs?: number;
}

/**
 * What `GET /internal/alerts` needs. Built by the HOST from its environment, never read
 * from `process.env` inside a route.
 */
export interface AlertsConfig {
  /**
   * The shared secret the scheduler presents as `Authorization: Bearer <secret>`.
   *
   * This is the whole authentication story for the endpoint, deliberately: the caller is a
   * cron, not a person, so there is no session to resolve and no user to be. It is compared
   * in CONSTANT TIME (`timingSafeEqual`) because a length-and-prefix-leaking `===` on a
   * value an attacker can retry indefinitely is exactly the shape of a recoverable secret.
   */
  secret: string;
  /**
   * The platform scheduler's own secret — Vercel's `CRON_SECRET`, presented as
   * `Authorization: Bearer <CRON_SECRET>` on every cron invocation. Accepted by
   * `GET /internal/alerts/run` only, compared with the same constant-time compare. A second
   * credential rather than pasting {@link AlertsConfig.secret} into the platform's box,
   * because the lifetimes differ: `CRON_SECRET` belongs to one deployment's scheduler, the
   * alert secret is also held by the scheduled CI workflow. Both grant the same capability,
   * so nothing is lost if an operator sets them equal. Absent ⇒ only
   * {@link AlertsConfig.secret} is accepted — correct for a host with no platform cron.
   */
  cronSecret?: string;
  /** Sinks that actually reach a human. Empty ⇒ the response reports `undeliverable: true`. */
  sinks?: readonly AlertSink[];
  environment?: string;
  /** Shards that must have a live leader. Defaults to `[0]` — the shipped configuration. */
  shards?: readonly number[];
  /** Overrides for the arch doc's thresholds. Tests use tiny values; production uses none. */
  thresholds?: Partial<AlertThresholds>;
  /**
   * THE TWO POPULATIONS THE RULES CANNOT READ FROM THIS DATABASE — who is parked, and who is at
   * their storage cap. Both are limits whoever operates the service sets, so both arrive as
   * readers the host composes; ABSENT means nobody is parked and nobody is at a cap, which is
   * the truth on a deployment that meters nothing and the fail-open direction on one that does.
   */
  parkedAccounts?: EvaluateOptions["parkedAccounts"];
  accountsAtCap?: EvaluateOptions["accountsAtCap"];
  repeatMs?: number;
}
