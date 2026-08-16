import type {
  AdminDb, AuthService, ProposalsService, BillingPlanePort, EntitlementsService, WaitlistService,
} from "@trafficflow/services";
import type { AlertSink, AlertThresholds, MsOAuthBootstrap } from "@trafficflow/db/cloud";
import type { FetchLike } from "@trafficflow/core";

/**
 * THE HOSTED HALF OF THE DEPENDENCY SURFACE, declared where only a hosted build will see it.
 *
 * `deps.ts` describes what any host of this route table must supply. Most of it is the mail half
 * and is the same everywhere; a few members exist only where there are accounts to administer,
 * subscriptions to bill and a pager to answer. Those members name the identity ceremony, the
 * billing service, the funnel and the content-blind operator connection — modules a local install
 * neither has nor may have.
 *
 * They were declared in `deps.ts` itself, which meant the file every host compiles named all four
 * of them. A type-only reference emits nothing, and it is still a private module named in source
 * and an import a public checkout could not resolve. So they are declared HERE and merged into the
 * interfaces next door.
 *
 * ── WHAT THIS DOES NOT CHANGE ─────────────────────────────────────────────────────────────
 *
 * Nothing about the hosted deployment: it loads the package barrel, the barrel names this module,
 * and every hosted route sees exactly the members it always saw. And nothing about the SAFETY of
 * an absent member — each one is optional and each one's absence already selects the refusing
 * branch (a 404 for a surface nobody armed, a 503 for a pager that cannot reach its database).
 * That grammar is unchanged; only where the members are declared has moved.
 *
 * A local build never loads this module, so its `ApiDeps` genuinely has no operator connection
 * and no billing service — not "has one that is undefined". Code assuming otherwise fails to
 * compile rather than failing at request time.
 */
declare module "./deps.js" {
  interface ApiServices {
    /**
     * OPTIONAL, in the same grammar as `unsubscribe` and `billing` below: its absence is a
     * first-class state, not a misconfiguration.
     *
     * The AUTH SERVICE ESTABLISHES sessions — register, verify a password, enrol a factor, run the
     * OAuth ceremony. Only the 20 auth routes read it, and a host that does not mount them never
     * touches it. The LOCAL engine is exactly that host: it mints one session per launch for the
     * shell that spawned it, and the machine's own login is the boundary.
     *
     * Session RESOLUTION is unaffected and still required — `withSession` calls the standalone
     * `resolveSession` against the `sessions` table, never this field. So a host with no `auth`
     * still authenticates every request it serves; it simply has no way to create an account.
     */
    auth?: AuthService;
    /**
     * OPTIONAL, in the same grammar as `auth` above. The proposer READS a mailbox and asks a model
     * what workflow the user keeps performing by hand, so a host with no model configured can never
     * produce one. The LOCAL engine is exactly that host: routing there is rules-only, and
     * `GET /workflows/proposals` answers "not configured" rather than an empty list that would imply
     * the question had been asked and answered "none".
     */
    proposals?: ProposalsService;
    // The BILLING PLANE PORT: how this host reaches the Stripe machinery, which lives in a
    // separate PRIVATE plane service — this member is the HTTP
    // client of it (`entitlements/plane-client.ts`); no Stripe SDK exists in this repository.
    // OPTIONAL, and its absence is a first-class state rather than a misconfiguration: a
    // deployment with no billing environment is pre-launch, so `/billing/*` answers 503
    // `billing_unconfigured` and every other route (and `/health`) is untouched.
    // `apps/api-vercel` builds it lazily and ONLY when the whole plane block is present — a
    // PARTIAL environment throws at cold start instead, because a host that accepts checkouts
    // while its webhook is unconfigured takes money it can never turn into credits.
    // Most tests omit it; the billing tests inject a fake, exactly as `StripePort` was faked
    // before the extraction (the suite performs zero external requests — no test dials the plane).
    billingPlane?: BillingPlanePort;
    // The OPEN half of the same seam: the entitlements service (checkout preflight,
    // status read, the webhook's claim+apply, erasure's cancel). Port-free by construction —
    // it holds no network capability; routes compose it with `billingPlane` at the call site.
    // Set together with `billingPlane` by every host that has a billing environment: the two
    // members are one capability, and `apps/api-vercel` arms both from one config block.
    entitlements?: EntitlementsService;
    // The funnel: `POST /waitlist` and the operator invite mint (the mint has
    // no route; it is an operator action). OPTIONAL like `billing`, and for the same reason: a host that
    // does not serve the landing's signup answers 503 `waitlist_unconfigured` rather than
    // 500ing. It needs no configuration of its own — the MAILER inside it is what may be
    // absent, and `WaitlistService` handles that by recording the row and reporting
    // `mailed: false`, so `apps/api-vercel` builds one unconditionally.
    waitlist?: WaitlistService;
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
     * THE CONTENT-BLIND CONNECTION every staff surface reads on — staff tooling must be
     * structurally unable to read mail content, not merely trusted not to.
     *
     * A FACTORY and not a handle, because minting one is an `await`: `adminDbFor` probes the
     * connection (`SELECT subject FROM messages WHERE false` must raise 42501) before it will
     * brand it, and `buildDeps` is synchronous and runs on the path of every request. The probe
     * result is cached per cold instance, so the cost is one round trip on the first staff
     * request an instance serves and nothing thereafter.
     *
     * ABSENT ⇒ every `/admin/*` route answers **404**, exactly as a missing secret does, and the
     * three `/internal/alerts*` routes answer **503 `alerts_db_unarmed`**. The two answers differ
     * on purpose: a console nobody armed is an intentionally absent surface, while a
     * PAGER that is configured and cannot reach a database is broken, and a dead-man's switch
     * that 404s is indistinguishable from one that was never meant to exist.
     *
     * There is deliberately no fallback to {@link ApiDeps.db}: "absent configuration selects the
     * dangerous branch" is this repository's recurring failure shape, and here the dangerous
     * branch is the handle that can read every account's mail.
     *
     * A REJECTED promise ⇒ 503. That is the case a presence check cannot see — the runtime URL
     * pasted into `DATABASE_URL_ADMIN` — and it is why the probe exists at all.
     */
    adminDb?: () => Promise<AdminDb>;
    /**
     * The ENV BOOTSTRAP for the Microsoft application registration, resolved by the
     * host from its own environment and passed in. ABSENT ⇒ this host has no env fallback, so the
     * `oauth_provider_config` row is the only source and a deployment with neither answers
     * "not configured" rather than throwing.
     *
     * It is here and not read from `process.env` in the route for the reason {@link AdminConfig}
     * gives: a route that reaches into the environment makes every test of it depend on the
     * runner's ambient variables and makes a host unable to state what it is configured with. The
     * ACCEPTED VARIABLE NAMES — and the `MICROSOFT_*` aliases — live in one place
     * (`msOAuthEnv`, `packages/db/src/oauth-config.ts`), which both this host and the worker call,
     * so the two cannot accept different sets.
     *
     * The client SECRET is in here. It is never logged (`log.ts` redacts on the `secret` substring),
     * never projected by any route, and never returned to the admin console — which reads
     * `secretSet: boolean` and nothing else.
     */
    msOAuth?: MsOAuthBootstrap;
    /**
     * The BROWSER ORIGIN this deployment's app is served from, for the one route that has to build
     * an absolute redirect the browser will follow (the OAuth bounce). Absent ⇒ it falls back to
     * `defaultOrigin(authConfig)`, which is the same value and is already validated at boot; the
     * field exists so a host that serves its app somewhere other than its first WebAuthn origin can
     * say so, and so no route ever derives an origin from the REQUEST.
     */
    appOrigin?: string;
    /**
     * HOW THIS HOST REACHES MICROSOFT'S TOKEN ENDPOINT — an injected port, exactly as
     * `RemoteFetch`, `HostResolver`, `OneClickPost` and `DraftPort` are, and for the same reason:
     * the suite performs zero external requests by design, and a guard whose result comes from
     * "that hostname does not resolve in CI" is a guard whose exit code comes from the harness rather
     * than from reality.
     *
     * ABSENT ⇒ `globalThis.fetch`, which is what every deployment uses. A test injects a fake token
     * endpoint and can then drive the arms that matter: a rotated refresh token, an `invalid_client`,
     * a 5xx, an `id_token` with no address claim, a grant with no `offline_access`.
     */
    oauthFetch?: FetchLike;
  }
}

/**
 * What the six `GET /admin/*` reads need. Built by the HOST from its environment, never read
 * from `process.env` inside a route.
 *
 * ── ONE SECRET, AND WHAT THAT BUYS AND COSTS ──────────────────────────────────────────────
 * The caller is the admin console's own SERVER-SIDE proxy — not a browser and not a
 * person: the secret never leaves the two deployments that hold it.
 * There is no session to resolve, and inventing a staff account would mean a phishable
 * credential in `users` plus a role column this read surface has no business adding.
 *
 * What it does NOT buy: an identity. No per-person revocation, no actor to record, no read
 * audit. That is precisely why this surface ships the READS and no write — a write needs a
 * name to put in the `audit_log` row, and a shared secret has none.
 *
 * It MUST be a different value from {@link AlertsConfig.secret}: sharing them would mean
 * rotating the pager revokes staff access, and rotating staff access silences the pager.
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
   * The PLATFORM SCHEDULER's own secret — Vercel's `CRON_SECRET`, which it presents as
   * `Authorization: Bearer <CRON_SECRET>` on every cron invocation. Accepted by
   * `GET /internal/alerts/run` only, and compared with the same constant-time compare.
   *
   * A SECOND credential rather than a requirement that the operator paste
   * {@link AlertsConfig.secret} into Vercel's box, because these have different lifetimes:
   * `CRON_SECRET` belongs to one deployment's scheduler, while the alert secret is also held
   * by GitHub Actions. One value in two places means rotating either one silences a driver
   * nobody was thinking about — the failure `AdminConfig` refuses outright. Both grant the
   * SAME capability (run the pass), so unlike the admin/alert pair there is nothing to gain
   * from forbidding them to be equal, and nothing lost if an operator sets them the same.
   *
   * Absent ⇒ only {@link AlertsConfig.secret} is accepted, which is the correct state for a
   * host with no platform cron.
   */
  cronSecret?: string;
  /** Sinks that actually reach a human. Empty ⇒ the response reports `undeliverable: true`. */
  sinks?: readonly AlertSink[];
  environment?: string;
  /** Shards that must have a live leader. Defaults to `[0]` — the shipped configuration. */
  shards?: readonly number[];
  /** Overrides for the arch doc's thresholds. Tests use tiny values; production uses none. */
  thresholds?: Partial<AlertThresholds>;
  repeatMs?: number;
}
