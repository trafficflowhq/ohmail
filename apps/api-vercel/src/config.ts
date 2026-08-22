import {
  keyProviderFromEnv, kekEnvIdentity, assertAnthropicKey,
  type KeyProvider, type KekEnvIdentity,
} from "@trafficflow/core";
import { DEFAULT_SSE, type SseConfig } from "@trafficflow/api";
// One definition of "unusable as the serverless runtime connection", shared with the
// build gate in `next.config.mjs` (duplicated there in JS, because it cannot import TS).
// `transactionPoolerReason` is its mirror: the LISTEN URL must NOT be the transaction pooler.
import { runtimeUrlReason, providerFamily, transactionPoolerReason } from "@trafficflow/db";
import { msOAuthEnv, type MsOAuthBootstrap } from "@trafficflow/db/cloud";
import { makeAuthConfig, type AuthConfig } from "@trafficflow/services";

/**
 * Deployment configuration for the serverless API host.
 *
 * Nothing is read from `process.env` at module scope: {@link loadHostConfig} is a pure
 * function of an environment object — testable without mutating the process — and
 * {@link hostState} resolves it exactly once per cold instance.
 */

/**
 * Prod default for the browser surfaces.
 *
 * The rpID is the REGISTRABLE DOMAIN `ohmail.app` because one credential store has to span
 * the product AND `admin.ohmail.app` — a passkey scoped to the product's own host alone
 * would be refused by the browser on the admin console, and staff would need a second one.
 * `origins.ts` enforces the coverage relation at construction.
 *
 * **`https://ohmail.app` IS the product origin now — the single-origin merge made it so —
 * and that is a deliberate reversal.** It used to be refused outright: the landing lived
 * there, and the standing rule was that the landing is never an auth origin. The landing and the app are the same
 * deployment on the same hostname today, so that rule has no subject left — `origins.ts`
 * (`NEVER_AUTH_HOSTS`) works through what replaced it and what was genuinely lost.
 *
 * `admin.ohmail.app` is NOT defaulted here and is added through `TF_AUTH_ORIGINS` on the
 * deployment that wants it, unchanged by the merge.
 */
export const DEFAULT_RP_ID = "ohmail.app";
export const DEFAULT_ORIGINS = ["https://ohmail.app"];
/**
 * Hosts on which the `tf_session` COOKIE is an accepted credential.
 *
 * All three are browser surfaces: `ohmail.app` and `admin.ohmail.app` are where the
 * session is used, and `api.ohmail.app` is the target of the webapp's same-origin rewrite
 * — a rewrite sends the proxied request with the API's own Host, so the API sees
 * `api.ohmail.app` for traffic whose cookies are genuinely first-party to `ohmail.app`.
 *
 * It is an ALLOW-list, so anything not on it — the platform's own deployment URL, any
 * preview alias, a host we have not thought about yet — is bearer-only. That is the safe
 * direction: a forgotten surface cannot accidentally start honouring an ambient browser
 * credential.
 *
 * **`app.ohmail.app` was removed in the single-origin merge and its absence is the assertion.** It is a 308 to
 * `ohmail.app` now and serves nothing, so a request asserting it is either a stale client
 * or a forgery; either way it must not be a cookie surface. Since `allowCookieAuthForRequest`
 * requires EVERY asserted host to be listed, leaving it on would also have meant a proxy
 * still forwarding `X-Forwarded-Host: app.ohmail.app` could keep cookie mode alive on a
 * hostname nobody serves.
 *
 * **What the single-domain rename cost here, stated rather than buried.** Under the
 * previous domain the API answered on TWO hostnames: `api.mailoh.app` for the browser (on
 * this list) and `api.mailoh.io` for native/desktop clients (deliberately NOT on it, so
 * an ambient cookie could not be a credential on the surface the native apps use). The
 * rename to one main domain leaves a single `api.ohmail.app`, so that structural split is
 * gone: native clients now reach a host that IS a cookie host. In practice they still
 * authenticate by bearer — macOS/Tauri/Expo hold no cookie jar for this origin and send
 * no `Origin` header — so nothing changes about how they authenticate; what is lost is
 * the guarantee that they COULDN'T have used a cookie. Restoring it means giving the
 * native surface its own hostname again; that is a deliberate follow-up, not an oversight,
 * and the single-origin merge explicitly did NOT touch the API host while changing the browser one.
 */
export const DEFAULT_COOKIE_HOSTS = ["api.ohmail.app", "ohmail.app", "admin.ohmail.app"];

/**
 * Loopback names a local run may use as a cookie host. Nothing else outside
 * {@link DEFAULT_COOKIE_HOSTS} is permissible — see {@link assertCookieHosts}.
 */
const LOOPBACK_COOKIE_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Every host `TF_COOKIE_HOSTS` is allowed to name. Compiled, not configured. */
export const PERMITTED_COOKIE_HOSTS = [...DEFAULT_COOKIE_HOSTS, ...LOOPBACK_COOKIE_HOSTS];

/**
 * `TF_COOKIE_HOSTS` may only SELECT from {@link PERMITTED_COOKIE_HOSTS}; it may not extend it.
 *
 * Without this the bearer-only boundary is a convention: one environment edit — or one bad
 * paste — could add a surface that has no CSRF story at all (the platform's own deployment
 * URL, a preview alias, the legacy `api.mailoh.*` names shipped clients are pinned to) and
 * it would start honouring an ambient browser cookie. Nothing in the deployment would
 * report it, because "the allow-list is what decides" was the whole design.
 *
 * There is deliberately NO env-var escape hatch. Adding a genuine new browser surface is
 * never an env-only change anyway — it needs `TF_AUTH_ORIGINS` (the auth config validates
 * rpID against the public-suffix list), the webapp's rewrite target, and DNS — so an override would buy no operational
 * speed and would reintroduce exactly the hole it is guarding. Widening the product means
 * editing this list, in a commit, in review.
 *
 * @throws when any listed host is not a compiled browser surface.
 */
export function assertCookieHosts(hosts: string[]): string[] {
  const permitted = new Set(PERMITTED_COOKIE_HOSTS.map((h) => h.toLowerCase()));
  for (const h of hosts) {
    const bare = h.trim().toLowerCase().replace(/:\d+$/, "");
    if (!permitted.has(bare)) {
      // Names the VARIABLE and the permitted set (compiled and public), never the rejected
      // value — `/health` publishes config errors as `detail`, and the moment one config
      // error echoes `env[X]` the pattern gets copied to a variable holding a secret.
      throw new Error(
        `TF_COOKIE_HOSTS may only name a compiled browser surface: ${PERMITTED_COOKIE_HOSTS.join(", ")}`,
      );
    }
  }
  return hosts;
}

/**
 * SSE poll interval in production — a cost control.
 *
 * `DEFAULT_SSE.pollMs` is 2 s, which is right for a deterministic test and ruinous on a
 * platform that bills per invocation-second: every open tab is a live function running
 * `max(seq)` on each poll while holding one pooler connection. 8 s is 4× cheaper and still
 * well inside a human's idea of "instant" — and the client engine treats SSE as a LOSSY,
 * content-free wake signal, so `GET /sync` is what actually carries data.
 */
export const PROD_SSE_POLL_MS = 8_000;

/**
 * SSE is OFF on this host unless `TF_SSE=1`.
 *
 * "Put SSE behind a flag" is the standing rule, and the obvious flag (`NEXT_PUBLIC_SSE`) lives in the
 * CLIENT bundle — which is not a control at all: `/events` is reachable by anyone with a
 * session, and every open stream is a function billed for its whole lifetime, reconnecting
 * forever. The switch that decides whether this deployment spends money has to be on the
 * server. Beta ships polling (`GET /sync`), which the client engine treats as fully
 * equivalent because SSE is a lossy, content-free wake signal.
 */
export const DEFAULT_SSE_ENABLED = false;

/**
 * SSE stream lifetime in production — how long one `/events` invocation runs before it closes
 * cleanly and lets `EventSource` reconnect on the `retry:` hint.
 *
 * `DEFAULT_SSE.lifetimeMs` is 30 s, which was chosen to fit under the catch-all route's
 * `maxDuration = 60` and is the right size for a deterministic test. As a production cadence
 * it means every open tab re-invokes the function twice a minute — 120 cold-ish starts an hour
 * per stream, each one a new baseline `max(seq)` read. `/events` now has its OWN route module
 * (`app/events/route.ts`, `maxDuration` {@link EVENTS_MAX_DURATION_S}) so the stream may run
 * long: 270 s keeps a 30-second margin under the route's 300, and the margin is the point —
 * the server must end the stream, not the platform, because a platform kill is a dropped
 * socket the client reads as an error, while a clean close is an ordinary reconnect.
 *
 * `TF_SSE_LIFETIME_MS` overrides it (integer, 5 s to {@link MAX_SSE_LIFETIME_MS}); the ceiling
 * is validated here precisely so a generous-looking value cannot silently hand the close back
 * to the platform's timer.
 */
export const PROD_SSE_LIFETIME_MS = 270_000;
/** `maxDuration` of `app/events/route.ts`, in seconds. Named here so config can respect it. */
export const EVENTS_MAX_DURATION_S = 300;
/** The most a configured lifetime may be: the route's duration minus a margin for the close. */
export const MAX_SSE_LIFETIME_MS = (EVENTS_MAX_DURATION_S - 10) * 1_000;

/**
 * THE LISTEN CONNECTION — `DATABASE_URL_SESSION`, or `null` when this deployment has none.
 *
 * `/events` gets its pushed wakes from a per-instance `LISTEN ohmail_change_log`
 * (`src/wake-hub.ts`), and that LISTEN cannot ride the runtime connection: `DATABASE_URL_POOLED`
 * is a TRANSACTION-mode pooler, which multiplexes statements across backends, so a LISTEN
 * there subscribes a backend the next statement has already left — it fails silently, which is
 * the worst available way for it to fail. Session mode (port 5432 on the same pooler host) pins
 * one backend per client connection, so notifications flow for the connection's whole life.
 *
 * Absent ⇒ `null` ⇒ streams run on their poll loop alone: a legitimate state (it is exactly the
 * pre-push behaviour), so it must not throw. PRESENT BUT TRANSACTION-MODE throws at load: that
 * is a deployment someone configured wrong, and the failure it would otherwise produce — wakes
 * that never arrive, on a host that looks healthy — cannot be diagnosed later. The same
 * some-is-a-throw / none-is-a-null rule every other block here follows.
 */
export function loadSseListenUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.DATABASE_URL_SESSION ?? "").trim();
  if (raw === "") return null;
  const reason = transactionPoolerReason(raw);
  // Names the VARIABLE and the reason, never the value — the rule with no exceptions.
  if (reason) throw new Error(`DATABASE_URL_SESSION cannot hold a LISTEN: ${reason}`);
  return raw;
}

export interface HostConfig {
  /** The `-pooler` connection string — `makePooledDb`, `prepare:false`. */
  databaseUrlPooled: string;
  /** Real, or {@link poisonedKeyProvider} when the KEK environment is unusable. */
  keyProvider: KeyProvider;
  /** The ring identity `/health` publishes for the risk-2 comparison; null when broken. */
  kek: KekEnvIdentity | null;
  /** Why {@link HostConfig.kek} is null, verbatim from the key-ring loader. Never key material. */
  kekError: string | null;
  authConfig: AuthConfig;
  sse: SseConfig;
  /**
   * The session-mode connection `/events`' per-instance LISTEN rides, or `null` on a
   * deployment that has none — which streams on the poll loop alone. See {@link loadSseListenUrl}.
   */
  sseListenUrl: string | null;
  cookieHosts: string[];
  /** Build identity for `/health` — the deployment's commit sha where available. */
  version: string;
  /**
   * Why {@link HostConfig.version} is not a real build identity, on a host where that is not
   * acceptable. Non-null ⇒ `/health` answers 503 `build_identity_unknown`.
   */
  buildError: string | null;
  /**
   * The PRIVATE BILLING PLANE, or `null` on a deployment with no billing at all.
   *
   * Two variables, all-or-nothing on one asymmetry: "none" is a legitimate pre-launch
   * state (`/billing/*` answers 503 `billing_unconfigured`), "some" is a deployment someone
   * tried to configure and got wrong — a URL with no secret is a client every plane call 401s,
   * and a secret with no URL is nothing at all. This is the ONLY billing composition since the
   * billing extraction: the in-process Stripe block is deleted, and {@link assertNoStaleStripeEnv} is
   * what makes a leftover `STRIPE_*` variable a refused deploy rather than silent decoration.
   */
  billingPlane: BillingPlaneHostConfig | null;
  /** Alerting, or `null` when `TF_ALERT_SECRET` is unset (`/internal/alerts` 404s). */
  alerts: AlertsHostConfig | null;
  /**
   * The admin console's shared secret, or `null` when `TF_ADMIN_SECRET` is
   * unset, in which case all six `GET /admin/*` reads answer 404 and this deployment has no
   * admin console at all. That is the correct default for a host nobody has armed: those six
   * endpoints project every account on the platform.
   */
  admin: AdminHostConfig | null;
  /**
   * Why {@link HostConfig.admin} is null, or null when the admin console is armed.
   *
   * Published by `/health` as `adminFault` and NOT a `healthFault`: an unarmed staff console
   * must not take the product host out of rotation. See `HealthConfig.adminError`.
   */
  adminError: string | null;
  /**
   * The content-blind connection every staff surface reads on, loaded INDEPENDENTLY
   * of {@link HostConfig.admin}.
   *
   * Present ⇒ `buildDeps` mints `adminDb`. That is what `/internal/alerts*` needs, and it now
   * needs nothing else from the console's half of the environment. See
   * {@link loadStaffDbConfig}.
   */
  staffDb: StaffDbConfig | null;
  /** Why {@link HostConfig.staffDb} is null. Carried into `adminError` when the console asked. */
  staffDbError: string | null;
  /**
   * The ENV BOOTSTRAP for the Microsoft application registration (cloud migration 0009
   * created the row it defers to).
   *
   * ALWAYS PRESENT and possibly all-empty, unlike {@link HostConfig.admin} and
   * {@link HostConfig.billingPlane}, which are `null` when unarmed. The difference is that those two
   * decide whether a SURFACE EXISTS (a 404 for a console nobody armed, a 503 for a billing
   * deployment that is pre-launch), and this decides nothing: the authority is the
   * `oauth_provider_config` row, and env is only what a deployment with no row falls back to. A
   * `null` here would make "no env" and "no host support" the same value, and the onboarding route's
   * refusal already distinguishes the three real states through `ResolvedOAuthConfig.source`.
   *
   * The variable NAMES — including the `MICROSOFT_*` aliases — are resolved by `msOAuthEnv` in
   * `packages/db`, which the WORKER also calls, so the two hosts cannot accept different sets.
   */
  msOAuth: MsOAuthBootstrap;
  /**
   * WHERE THIS DEPLOYMENT'S APP LIVES — the absolute origin the OAuth bounce redirects a browser to.
   *
   * `TF_APP_URL`, through {@link assertAppUrl}, which already validates exactly this: a bare
   * first-party `https` origin with no path, query, fragment or embedded credentials, *"because it is
   * a REDIRECT TARGET, so it is validated like one"*. That sentence was written for Stripe's return
   * URL — which lives on the PLANE now, validated there by the same rule — and this is the same
   * job: the consent bounce is the other high-trust moment where an arbitrary string would be an
   * open redirect.
   *
   * `null` ⇒ the route falls back to `defaultOrigin(authConfig)`, the first `TF_AUTH_ORIGINS` entry.
   * That fallback is SAFE rather than merely convenient: `assertOriginConfig` validates it at boot
   * and the rpID must cover it, so it cannot be a foreign host. It is a fallback and not the primary
   * source because `TF_AUTH_ORIGINS` is a LIST whose ordering nothing else depends on, and a
   * redirect target inherited from position 0 of an unrelated list is a value nobody would think to
   * check when reordering it.
   */
  appOrigin: string | null;
  /**
   * **THE PAGER IS CONFIGURED AND CANNOT RUN.** Non-null exactly when
   * {@link HostConfig.alerts} is armed and {@link HostConfig.staffDb} is not.
   *
   * Published by `/health` as `alertsFault`, at HTTP 200 and with `ok` still true, for
   * `loadAlertsConfig`'s reason: an observability feature must never cause the outage it exists
   * to report. It is a SEPARATE field from {@link HostConfig.adminError} because the two say
   * different things to whoever reads them — "the console is off" is a Monday problem, "the
   * pager is off" is an outage nobody is told about — and the old code could only say the first.
   */
  alertsError: string | null;
  /**
   * The provider family of {@link HostConfig.databaseUrlPooled}, published by `/health` as
   * `dbProvider`. One of three fixed strings, never a host or a credential.
   *
   * Not a fault: a self-hoster on their own Postgres reads `unrecognized` and is perfectly
   * healthy. What it makes visible is the state that went unnoticed for a day — the connection
   * guards recognising nothing about the provider they are supposedly guarding.
   */
  dbProvider: string;
  /**
   * Transactional customer mail, or `null` when this deployment has no
   * `RESEND_API_KEY` + `MAIL_FROM`.
   *
   * Deliberately promoted OUT of {@link AlertsHostConfig}, where it first lived. The mailer
   * predates alerting and is not part of it: it is what sends the waitlist confirmation and
   * the beta invite, and gating those on `TF_ALERT_SECRET` — the pager's shared secret —
   * would have meant that arming or disarming the pager silently turned CUSTOMER mail on or
   * off. `loadAlertsConfig` now reads this same block rather than building its own, so the
   * two can no longer disagree about which mailer key or which link origins are in use.
   */
  mail: MailHostConfig | null;
  /**
   * The validated `ANTHROPIC_API_KEY`, or `null` on a deployment with no managed AI.
   *
   * `null` is a legitimate state (a preview, a rules-only deployment): `POST /messages/:id/draft`
   * answers **503 `drafter_unconfigured`** (this doc once claimed 500 `drafter_unconfigured` while the
   * code actually threw 500 `internal`; the two now agree). It also now costs more than the
   * AI suggestion: `POST /workflows/:id/run` REFUSES a workflow containing a `draft_reply` step
   * with the same 503 rather than answering 202 for work the drain cannot do. A key that is
   * PRESENT but not shaped like an Anthropic key throws at load — see {@link loadAnthropicKey}.
   *
   * Set this on the WORKER and on this host in the SAME change: the API's copy is
   * only a proxy for the worker's, and the two divergent states are described in
   * `WorkflowsService.assertRunnable`.
   */
  anthropicApiKey: string | null;
  /**
   * WHERE STAGED ATTACHMENT BYTES GO, or `null` on a deployment with no object storage.
   *
   * `null` is a legitimate state and it degrades honestly: `POST /attachments/staging` answers
   * 503 `unavailable`, the browser falls back to putting attachment bytes in the send request as
   * it always did, and everything under the old 3 MB request-body ceiling keeps working. What is
   * lost is exactly what staging bought — a send bigger than the serverless body limit.
   *
   * ALL-OR-NOTHING, like {@link HostConfig.billingPlane}: a URL with no service key is a deployment
   * that would mint grants nothing can sign, so the three variables are read as one block.
   */
  attachmentStaging: AttachmentStagingHostConfig | null;
  /** `production` / `preview` / `development` — the first word of every alert. */
  environment: string;
}

/**
 * The staging bucket and the credential that reaches it.
 *
 * `serviceKey` is the SERVICE-ROLE key, and it is the only credential that touches this bucket:
 * the bucket is private, has no public read, and no anon-key policy grants anything on it. The
 * browser receives a signed URL minted with this key and scoped to one object — never the key.
 *
 * A DEDICATED bucket, never one anything else writes to. Its contents are other people's
 * outgoing attachments for 24 hours, and a bucket shared with, say, avatars would put a retention
 * sweep with a `DELETE` in it next to objects nobody meant to expire.
 */
export interface AttachmentStagingHostConfig {
  /** `https://<ref>.supabase.co` — the project origin, no path. */
  url: string;
  /** Service-role key. Never logged, never published, never sent to a browser. */
  serviceKey: string;
  /** The dedicated staging bucket's name. */
  bucket: string;
}

/**
 * What this host needs to be the second alert driver.
 *
 * `secret` is the only REQUIRED part: without it there is no endpoint at all. Everything
 * else is a sink, and a host with a secret and no sink is a legitimate (if useless) state
 * that the pass reports as `undeliverable: true` rather than hiding.
 */
export interface AlertsHostConfig {
  /** `TF_ALERT_SECRET` — the shared secret the scheduler presents. */
  secret: string;
  /**
   * `CRON_SECRET` — VERCEL'S OWN, presented as `Authorization: Bearer …` on every Vercel Cron
   * invocation, and accepted by `GET /internal/alerts/run` alongside {@link secret}.
   *
   * `null` when unset or shorter than 24 characters, exactly like the others: the platform
   * cron then gets a 401 rather than a weak credential being honoured on a public URL.
   * `assertAlertingArmed` in `next.config.mjs` is what stops a PRODUCTION build reaching that
   * state — an unauthenticated cron would fail silently for ever, which is the whole disease.
   */
  cronSecret: string | null;
  /** `TF_ALERT_WEBHOOK_URL` — ntfy / Slack / Discord / PagerDuty. */
  webhookUrl: string | null;
  /**
   * `TF_ALERT_EMAIL` — the operator address for the mail sink. Requires a configured
   * mailer (`RESEND_API_KEY` + `MAIL_FROM`); without one the sink is simply not built,
   * because a mail sink that always answers `skipped` would stamp `notified_at` on alerts
   * nobody received.
   */
  operatorEmail: string | null;
  mail: MailHostConfig | null;
  /**
   * The PUSH arm — the pager's SECOND VENDOR
   * (`TF_ALERT_TELEGRAM_BOT_TOKEN` + `TF_ALERT_TELEGRAM_CHAT_ID`), or `null`.
   *
   * This host is the ONLY observer of `worker_down`, so its own delivery path being
   * single-vendor is the sharper version of the same problem: a mail-vendor outage that
   * coincides with a dead worker is total silence, and those two are not independent events —
   * a bad enough day takes both. The push arm shares nothing with the mailer: another company,
   * another network, another credential, and a device push rather than a message into a
   * mailbox this product serves.
   *
   * NOT all-or-nothing, unlike {@link MailHostConfig}: neither variable exists for any other
   * purpose here, so a half-set pair is a fault to name rather than a mailer to protect. The
   * arm itself refuses every delivery and says which half is missing — `alert-push.ts` rules
   * the states, and the same object arms the worker.
   */
  telegram: { botToken: string | null; chatId: string | null } | null;
}

/**
 * What this host needs to serve the six admin READS.
 *
 * ONE field since the pager/console split. It used to carry `databaseUrl` too, which is how the console's
 * credential ended up gating the construction of a handle the PAGER also needs: see
 * {@link loadStaffDbConfig} for the split and the outage shape it removes. The blind
 * connection is now {@link HostConfig.staffDb}, loaded on its own; this block is the console's
 * credential and nothing else.
 *
 * The console's server-side proxy presents the secret as `Authorization: Bearer …`; no browser
 * ever holds it, and no session is ever consulted on those routes
 * (`packages/api/src/routes/admin.ts` explains why that is the whole authorization model and
 * what its ceiling is).
 */
export interface AdminHostConfig {
  /** `TF_ADMIN_SECRET`. A DIFFERENT value from `TF_ALERT_SECRET` — see {@link loadAdminConfig}. */
  secret: string;
}

/**
 * {@link loadAdminConfig}'s answer: the block, or the REASON there is none.
 *
 * Exactly one of the two is non-null. The reason exists because the absence has to be
 * diagnosable: with the surface unarmed there is no `/admin/*` endpoint left that could report
 * its own absence, so `/health` publishes it as `adminFault` (non-fatal — see
 * `HealthConfig.adminError`).
 */
export interface AdminLoad {
  admin: AdminHostConfig | null;
  unarmed: string | null;
}

/**
 * The CONTENT-BLIND CONNECTION, and the ONE variable that decides whether it exists.
 *
 * `DATABASE_URL_ADMIN` names `ohmail_admin`, the column-granted role that cannot read message
 * content — staff operate the platform without the power to read anyone's mail. It is what
 * `/admin/*` reads on AND what `/internal/alerts*` — the pager — reads and writes on.
 */
export interface StaffDbConfig {
  /**
   * The `-pooler` connection string for `ohmail_admin`.
   *
   * **There is no `?? databaseUrlPooled` anywhere on this path and there must never be.** A
   * fallback would mean that forgetting one environment variable silently serves the staff
   * console from the connection that can read every account's mail — "absent configuration
   * selects the dangerous branch", which is this repository's recurring failure shape.
   */
  url: string;
}

/**
 * {@link loadStaffDbConfig}'s answer: the connection, or the REASON there is none. Exactly one
 * of the two is non-null.
 */
export interface StaffDbLoad {
  staffDb: StaffDbConfig | null;
  refusal: string | null;
}

/** Mailer configuration, present only when the whole block is. */
export interface MailHostConfig {
  apiKey: string;
  from: string;
  replyTo: string | null;
  appUrl: string;
  siteUrl: string;
  adminUrl: string;
  supportEmail: string;
}

export type HostState =
  | { ok: true; cfg: HostConfig }
  | { ok: false; error: string; version: string };

const csv = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const buildVersion = (env: NodeJS.ProcessEnv): string =>
  env.VERCEL_GIT_COMMIT_SHA?.trim() || env.TF_BUILD_VERSION?.trim() || "dev";

/**
 * A PRODUCTION deployment must be able to say which build it is.
 *
 * `version: "dev"` in production means no commit sha (a CLI deploy from a worktree carries no
 * git metadata) and no `TF_BUILD_VERSION`, so the first question of any incident — "which build
 * is serving this?" — has no answer, and the KEK/schema comparisons `/health` publishes lose the
 * anchor that makes them comparable between hosts. This is reported, not thrown: darkening the
 * host over a missing label would be absurd, and `/health` is the only channel that can say it.
 * `VERCEL_ENV` is set by the platform (`production` / `preview` / `development`), so previews
 * and local runs are unaffected.
 */
const buildIdentityError = (env: NodeJS.ProcessEnv, version: string): string | null =>
  env.VERCEL_ENV?.trim() === "production" && version === "dev"
    ? "no build identity: set TF_BUILD_VERSION (or deploy from git so VERCEL_GIT_COMMIT_SHA is present)"
    : null;

/**
 * Reject a connection that cannot serve as the POOLED one — a direct database endpoint, or
 * a pooler in session mode.
 *
 * The mirror image of `assertSessionUrl` in `packages/db/src/setup-prod.ts`. Handing the
 * direct URL to `makePooledDb` "works" — which is exactly the problem: every warm
 * serverless instance then holds a real Postgres backend instead of a pooler slot, and the
 * failure shows up as the provider refusing connections under precisely the concurrency the
 * pooler exists to absorb.
 *
 * **This used to be scoped to one provider's hostnames and therefore stopped guarding the
 * day production moved to another provider** — measured, not supposed. The rule now lives in
 * `runtimeUrlReason` (`packages/db/src/session-url.ts`), which recognises the managed poolers
 * by their URL shapes and still fails OPEN on an unrecognised host, so it cannot false-positive
 * on a local Postgres under `pnpm dev` or on a provider it never named. That fail-open property
 * is what makes it safe for this function to THROW.
 */
export function assertPooledUrl(url: string): string {
  const reason = runtimeUrlReason(url);
  if (reason) throw new Error(`DATABASE_URL_POOLED is unusable: ${reason}`);
  return url;
}

/**
 * Whether this host accepts cookie authentication, decided per REQUEST HOST.
 *
 * One deployment answers on several hostnames — `api.ohmail.app` (the webapp's rewrite
 * target, and the legacy `api.mailoh.*` names still pinned into shipped clients), plus the
 * platform's own deployment URL every rollback and platform probe uses — so the decision
 * cannot be a build-time flag: it is a property of the hostname the request arrived on.
 * The port is stripped (`localhost:3002`) and the comparison is case-insensitive, because
 * DNS is.
 */
export function allowCookieAuthFor(host: string | null, cookieHosts: string[]): boolean {
  if (!host) return false;                       // no Host header ⇒ fail closed
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  return cookieHosts.some((h) => h.trim().toLowerCase() === bare);
}

/**
 * Every hostname this request ASSERTS it was addressed to, normalized the way
 * {@link allowCookieAuthFor} compares them. Three READ SITES, but only two distinct facts:
 *
 *  1. **the request URL's host** — `req.url` is absolute here, and under a Node server the
 *     framework CONSTRUCTS it from the inbound `Host` header, so sources 1 and 2 normally
 *     carry the identical value. It is read separately anyway because it is the only one
 *     that survives `new Request(url, …)`: `Host` is a FORBIDDEN header name in fetch, so a
 *     Request constructed in-process carries none at all, and reading the header alone made
 *     every unit-level request look hostless (= bearer-only) no matter which host it named.
 *  2. **the `Host` header**, when the runtime exposes one.
 *  3. **every `X-Forwarded-Host` value** — a request through the webapp's rewrite carries
 *     two truths: the socket was opened to `api.ohmail.app`, and the browser typed
 *     `ohmail.app`. Proxies comma-join when they append, so the header is split.
 *
 * So the only genuinely INDEPENDENT input is `X-Forwarded-Host`, and the `every` in
 * {@link allowCookieAuthForRequest} makes it strictly subtractive — it can turn cookies off
 * and never on. `Host` itself is not defended against and cannot be: on Vercel it is the
 * platform's ROUTING KEY, so a request claiming `Host: api.ohmail.app` is delivered to
 * whatever project owns that name — "arrive on the bearer-only host while asserting the
 * cookie host" is not a reachable state in production. (It is reachable under a bare
 * `next start`, which serves every Host; that is an artefact of self-hosting, and it grants
 * nothing, since forging Host requires already holding the session value, which authenticates
 * by `Authorization: Bearer` on every host regardless. A browser cannot forge Host at all,
 * and the cookie this split protects is host-only + SameSite=Strict, so it is never sent
 * anywhere but its own origin.)
 *
 * A hostless or unparseable URL contributes nothing rather than throwing; an empty result
 * is what {@link allowCookieAuthForRequest} turns into a refusal.
 */
export function assertedHosts(req: Request): string[] {
  let fromUrl = "";
  try {
    fromUrl = new URL(req.url).host;
  } catch {
    /* not absolute — the header sources still apply */
  }
  const raw = [
    fromUrl,
    req.headers.get("host") ?? "",
    ...(req.headers.get("x-forwarded-host") ?? "").split(","),
  ];
  return [...new Set(
    raw.map((h) => h.trim().toLowerCase().replace(/:\d+$/, "")).filter((h) => h.length > 0),
  )];
}

/**
 * THE cookie-auth decision for a request. One function, so the rule is mechanical.
 *
 * **The rule: EVERY asserted host must be on the allow-list, and there must be at least
 * one.** Anything else is bearer-only.
 *
 * Why "every" and not "the Host header":
 *  - Through the webapp rewrite the pair is (`api.ohmail.app`, `ohmail.app`) and BOTH are
 *    listed, so the intended path works whether or not Vercel forwards the original host.
 *  - `X-Forwarded-Host` is a header a client can simply type. Honouring it alone would let
 *    `curl -H 'X-Forwarded-Host: api.ohmail.app' https://api.ohmail.app/...` switch the
 *    bearer-only surface into cookie mode — the single thing this split exists to prevent.
 *    Requiring agreement makes a forged value strictly subtractive: it can only ever turn
 *    cookies OFF.
 *  - A preview deployment (the platform's generated preview hostname) proxying to the
 *    production API therefore gets bearer-only rather than a live cookie surface. That is
 *    deliberate: preview aliases are not auth origins, and `TF_AUTH_ORIGINS` would refuse
 *    them anyway.
 *
 * **Unknown host ⇒ BEARER-ONLY, not 421/404.** The alternative — refusing to serve a host
 * we do not recognise — would take out the platform's own deployment URL (which every
 * rollback and every platform health probe uses) and every future host on the day it is
 * added rather than the day it is misconfigured. Bearer-only is the fail-closed direction
 * that still serves: an unrecognised surface cannot honour an ambient browser credential,
 * so `withCsrf` is unreachable there by construction, and a native client keeps working.
 * The cost of the other choice is an outage; the cost of this one is nothing.
 */
export function allowCookieAuthForRequest(req: Request, cookieHosts: string[]): boolean {
  const asserted = assertedHosts(req);
  if (asserted.length === 0) return false;       // no host assertion at all ⇒ fail closed
  return asserted.every((h) => allowCookieAuthFor(h, cookieHosts));
}

/**
 * A {@link KeyProvider} that refuses to do anything, installed when the KEK environment is
 * unusable.
 *
 * The alternative — throwing out of config load — takes `/health` down with it, and
 * `/health` is the one thing that can TELL an operator the KEK is wrong (risk 2). So the
 * host stays up, `/health` answers 503 naming the fault, and any route that genuinely needs
 * key material fails loudly rather than quietly writing rows nobody can decrypt.
 */
export function poisonedKeyProvider(reason: string): KeyProvider {
  const fail = (): never => {
    throw new Error(`KEK unavailable on this host: ${reason}`);
  };
  return {
    encrypt: async () => fail(),
    decrypt: async () => fail(),
    currentKeyVersion: () => fail(),
  };
}

/**
 * The default app origin — the product's ONE origin. It was `https://app.ohmail.app`,
 * which is now a 308 to this. Since the billing extraction the Checkout/Portal return URLs are
 * built on the PLANE from its own `APP_URL`; here this backs `TF_APP_URL` for the OAuth
 * bounce ({@link HostConfig.appOrigin}) and the mail links ({@link loadMailConfig}).
 */
export const DEFAULT_APP_URL = "https://ohmail.app";

/**
 * `TF_APP_URL` as a bare origin, or `null` when it is unusable.
 *
 * Swallowing the refusal is deliberate — see {@link HostConfig.appOrigin}. What must NOT happen is a
 * malformed value becoming the redirect target, and `assertAppUrl` throwing is what prevents that;
 * what also must not happen is this becoming a fifth reason a production host will not boot.
 */
export function appOriginOf(env: NodeJS.ProcessEnv): string | null {
  try {
    return assertAppUrl((env.TF_APP_URL ?? "").trim() || DEFAULT_APP_URL);
  } catch {
    return null;
  }
}

/**
 * Registrable domains `TF_APP_URL` may belong to. First-party only.
 *
 * One entry, not two: {@link assertAppUrl} matches `host === d || host.endsWith("." + d)`,
 * so `ohmail.app` already covers every first-party subdomain, and listing a subdomain
 * alongside its own parent said nothing the parent did not.
 */
export const APP_URL_ALLOWED_DOMAINS = ["ohmail.app"] as const;

/**
 * `TF_APP_URL` is a REDIRECT TARGET, so it is validated like one.
 *
 * It becomes the absolute origin the OAuth consent bounce sends a browser to and the base of
 * every transactional-mail link. Accepting an arbitrary string there is an open redirect on a
 * high-trust moment, and a typo'd or hostile value cannot be detected later: the redirect looks
 * exactly like the correct one. (The Stripe Checkout/Portal return URLs this validation was
 * first written for are the PLANE's `APP_URL` now, validated there by the same rule.)
 *
 * Refused, each for its own reason: a non-`https` scheme (`javascript:`/`data:` are redirect
 * payloads); embedded credentials (`https://a:b@host`, which browsers render deceptively); a
 * query or fragment (they would collide with the params consumers append); a PATH (the value is
 * interpolated as `${appUrl}/<route>`, so a path is either silently dropped or silently doubled
 * — refusing says so at boot instead of at the end of a flow); and any host outside the
 * first-party registrable domains, which is the check that actually stops the redirect leaving
 * the product. A bare trailing slash is fine and the result is normalized to an origin.
 */
export function assertAppUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TF_APP_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw new Error("TF_APP_URL must use https");
  if (url.username || url.password) throw new Error("TF_APP_URL must not embed credentials");
  if (url.search || url.hash) throw new Error("TF_APP_URL must not carry a query string or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "TF_APP_URL must be a bare origin with no path — it is interpolated as " +
        "`${TF_APP_URL}/<route>`, where a path would be silently doubled",
    );
  }
  const host = url.hostname.toLowerCase();
  const firstParty = APP_URL_ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!firstParty) {
    throw new Error(
      `TF_APP_URL must be a first-party host — one of ${APP_URL_ALLOWED_DOMAINS.join(", ")} ` +
        "or a subdomain of one (it is a redirect target and a mail-link base)",
    );
  }
  return url.origin;
}

/**
 * **THIS HOST HOLDS NO STRIPE CREDENTIAL, AND A LEFTOVER ONE IS A REFUSED DEPLOY.**
 *
 * The billing extraction's whole point is that Stripe keys are off this host entirely: the
 * private plane holds them, and this host reaches it through `BILLING_PLANE_URL` +
 * `BILLING_PLANE_SECRET`. After that cutover, a `STRIPE_*` variable in this environment is not
 * configuration — it is either a live secret that should have been removed (a credential parked
 * on a host that no longer needs it) or the first half of someone re-arming the deleted
 * in-process composition. Neither may be silent: this is the successor of the old rule that
 * refused a deployment arming both billing compositions at once, restated for a world where one
 * of the two no longer exists. The legitimate rollback direction is the mirror image — re-add
 * `STRIPE_*` AND redeploy the pre-extraction build, which carries the code these variables
 * belong to.
 *
 * Matched by PREFIX, not by a fixed list, so `STRIPE_PORTAL_CONFIGURATION_ID` — the optional
 * seventh — and any future spelling are caught too. The message names VARIABLES and never a
 * value (the rule with no exceptions): it surfaces in `/health`'s `detail`, which is public.
 */
export function assertNoStaleStripeEnv(env: NodeJS.ProcessEnv): void {
  const stale = Object.keys(env)
    .filter((k) => k.startsWith("STRIPE_") && (env[k] ?? "").trim() !== "")
    .sort();
  if (stale.length > 0) {
    throw new Error(
      `Stripe variables are set on this host, which holds no Stripe code since the billing ` +
        `extraction: ${stale.join(", ")}. Billing is configured through BILLING_PLANE_URL + ` +
        "BILLING_PLANE_SECRET; remove the STRIPE_* variables (they belong on the plane), or " +
        "roll back by redeploying the pre-extraction build that reads them",
    );
  }
}

/**
 * What this host needs to reach the private billing plane. Present or absent as a
 * WHOLE — see {@link loadBillingPlaneConfig}.
 */
export interface BillingPlaneHostConfig {
  /** The plane's origin (`https://…`), normalized — no path, no query, no credentials. */
  url: string;
  /** `BILLING_PLANE_SECRET` — the bearer every `/v1/*` call presents. ≥ 24 chars. */
  secret: string;
}

/** The two variables that make up the plane block. Both present, or both absent. */
const BILLING_PLANE_VARS = ["BILLING_PLANE_URL", "BILLING_PLANE_SECRET"] as const;

/**
 * The plane block — **both, or none**, on the same asymmetry as the rest of billing: "none" is a deployment with no
 * billing (legitimate: a preview, a local run, a pre-launch host), "some" is a deployment
 * someone tried to configure and got wrong, and each half-state is quietly catastrophic — a URL
 * with no secret is a client whose every call 401s, which the webhook relay correctly maps to
 * 503 and Stripe retries into for three days while the host looks healthy.
 *
 * The URL is validated as the server-to-server target it is: `https` only (the bearer rides
 * every request), no embedded credentials, no query/fragment, and NO PATH — the client appends
 * `/v1/…`, so a path would be silently doubled on every call. Normalized to an origin.
 *
 * Every message names the VARIABLE and never the value (the rule with no exceptions).
 */
export function loadBillingPlaneConfig(env: NodeJS.ProcessEnv): BillingPlaneHostConfig | null {
  const present = BILLING_PLANE_VARS.filter((v) => (env[v] ?? "").trim() !== "");
  if (present.length === 0) return null;
  if (present.length < BILLING_PLANE_VARS.length) {
    const missing = BILLING_PLANE_VARS.filter((v) => !present.includes(v));
    throw new Error(
      "The billing plane is PARTIALLY configured, which is never a valid deployment: set both " +
        `of ${BILLING_PLANE_VARS.join(", ")} or neither. Missing: ${missing.join(", ")}`,
    );
  }

  const secret = env.BILLING_PLANE_SECRET!.trim();
  if (secret.length < 24) {
    // There is no rate limit and no lockout behind the plane's compare, so the secret's LENGTH
    // is the only thing between a guesser and a server that can mint Checkout sessions.
    throw new Error("BILLING_PLANE_SECRET must be at least 24 characters");
  }

  const raw = env.BILLING_PLANE_URL!.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BILLING_PLANE_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw new Error("BILLING_PLANE_URL must use https — the bearer rides every request");
  if (url.username || url.password) throw new Error("BILLING_PLANE_URL must not embed credentials");
  if (url.search || url.hash) throw new Error("BILLING_PLANE_URL must not carry a query string or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "BILLING_PLANE_URL must be a bare origin with no path — the client appends /v1/…, " +
        "so a path would be silently doubled",
    );
  }

  return { url: url.origin, secret };
}

/**
 * `TF_INVITE_CODES`, and A HARD REFUSAL TO BOOT PRODUCTION WITH ONE.
 *
 * The static bootstrap set is a plaintext, reusable, non-expiring code bound to no address.
 * `AuthService.register` consults it whenever the `invites` table does not recognise a code,
 * so a holder can register ARBITRARY addresses — and read the 201-vs-409 answer as a clean
 * account-existence oracle over any address they care to type. That primitive is the exact
 * one migration 0020's email-bound invite rows were built to remove; the bootstrap path
 * re-opens it for as long as the variable is set.
 *
 * The docs already said "production runs with it empty". Nothing enforced that. The default
 * being empty is not enforcement — it is a hope about which environment variables somebody
 * sets in a dashboard at 2am, and the failure mode is silent: no log line, no health signal,
 * an oracle that nobody notices is open. So the deployment refuses to start instead.
 *
 * The escape hatch is a FIRST BOOT, not an environment: to open the very first account on a
 * fresh database, deploy once with `TF_INVITE_BOOTSTRAP_ACK` set to the same value, register,
 * then remove BOTH. Two variables rather than one because the point is that it cannot happen
 * by accident, and an acknowledgement that has to be typed twice is not an accident.
 *
 * Non-production (`preview`, `development`, a test env) is unchanged: the whole value of the
 * bootstrap is having a way in on a database with no invite rows, and a preview deployment is
 * where that is legitimate.
 */
export function assertBootstrapInvites(env: NodeJS.ProcessEnv): Set<string> {
  const codes = csv(env.TF_INVITE_CODES);
  if (codes.length === 0) return new Set<string>();

  const environment = env.TF_ENV?.trim() || env.VERCEL_ENV?.trim() || "production";
  if (environment !== "production") return new Set(codes);

  const ack = (env.TF_INVITE_BOOTSTRAP_ACK ?? "").trim();
  if (ack && ack === (env.TF_INVITE_CODES ?? "").trim()) return new Set(codes);

  throw new Error(
    "TF_INVITE_CODES is set on a PRODUCTION deployment. That set is plaintext, reusable, " +
    "bound to no address and never expires, so it re-opens the account-existence oracle the " +
    "email-bound `invites` table exists to close. Unset it and mint invites with " +
    "`pnpm invite mint --email …`. If this really is a first boot on an empty database, set " +
    "TF_INVITE_BOOTSTRAP_ACK to the identical value, open the first account, then remove both.",
  );
}

/**
 * `TF_PUBLIC_SIGNUP_CAP`, the capacity valve behind open registration.
 *
 * Absent or empty ⇒ `null` ⇒ uncapped, which is the honest default: a cap nobody chose is
 * not a safety feature, it is a number waiting to lock the product's own funnel at an
 * arbitrary moment.
 *
 * A malformed value THROWS rather than falling back to uncapped. That direction is the
 * whole point: an operator who typed `TF_PUBLIC_SIGNUP_CAP=1oo` is trying to LIMIT signups,
 * and silently reading their typo as "no limit at all" would do the exact opposite of what
 * they asked for, with no signal. The variable is NAMED and its value is never echoed —
 * the same rule `TF_SSE_POLL_MS` states, for the same reason.
 */
export function publicSignupCap(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.TF_PUBLIC_SIGNUP_CAP ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("TF_PUBLIC_SIGNUP_CAP must be a non-negative integer, or unset for no cap");
  }
  return n;
}

/**
 * Build the host configuration from an environment.
 *
 * A broken KEK is captured (poisoned provider + `kekError`) rather than thrown, so the
 * host stays diagnosable. Everything else — a missing database URL, an rpID/origin pair
 * `assertOriginConfig` refuses, a nonsense poll interval, a HALF-configured billing plane, a
 * leftover `STRIPE_*` variable — throws,
 * because none of it can be reported meaningfully and all of it is a deploy-time mistake.
 */
export function loadHostConfig(env: NodeJS.ProcessEnv): HostConfig {
  const databaseUrlPooled = assertPooledUrl(requireEnv(env, "DATABASE_URL_POOLED"));

  const origins = csv(env.TF_AUTH_ORIGINS);
  // `makeAuthConfig` runs `assertOriginConfig`, so a bad rpID/origin pair — or anything
  // under `ohmail.app` — is a CONFIG failure here and never a request-time surprise.
  const authConfig = makeAuthConfig({
    rpID: env.TF_RP_ID?.trim() || DEFAULT_RP_ID,
    origin: origins.length > 0 ? origins : DEFAULT_ORIGINS,
    inviteCodes: assertBootstrapInvites(env),
    publicSignup: env.TF_PUBLIC_SIGNUP?.trim() === "1",
    publicSignupCap: publicSignupCap(env),
  });

  let keyProvider: KeyProvider;
  let kek: KekEnvIdentity | null;
  let kekError: string | null = null;
  try {
    keyProvider = keyProviderFromEnv(env);
    const identity = kekEnvIdentity(env);
    if (!identity) throw new Error("TF_KEK_V1 is required on the API host (it decrypts mailbox credentials)");
    kek = identity;
  } catch (err) {
    kekError = err instanceof Error ? err.message : String(err);
    keyProvider = poisonedKeyProvider(kekError);
    kek = null;
  }

  const pollMs = env.TF_SSE_POLL_MS?.trim() ? Number(env.TF_SSE_POLL_MS) : PROD_SSE_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1_000) {
    // Names the VARIABLE, never its value. That rule has no exceptions here even though a poll
    // interval is harmless: the moment one config error echoes `env[X]`, the pattern gets copied
    // to a variable that holds a secret, and `/health` publishes config errors as `detail`.
    throw new Error("TF_SSE_POLL_MS must be an integer >= 1000");
  }
  const lifetimeMs = env.TF_SSE_LIFETIME_MS?.trim() ? Number(env.TF_SSE_LIFETIME_MS) : PROD_SSE_LIFETIME_MS;
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 5_000 || lifetimeMs > MAX_SSE_LIFETIME_MS) {
    // The CEILING is the load-bearing half: a lifetime past the events route's `maxDuration`
    // hands the close to the platform's timer, and a platform kill is a dropped socket the
    // client reads as an error, where a server close is an ordinary reconnect.
    throw new Error(`TF_SSE_LIFETIME_MS must be an integer between 5000 and ${MAX_SSE_LIFETIME_MS}`);
  }
  // `TF_SSE=1` is the only way this host streams (see DEFAULT_SSE_ENABLED).
  const sseEnabled = env.TF_SSE?.trim() === "1" ? true : DEFAULT_SSE_ENABLED;

  const cookieHosts = assertCookieHosts(csv(env.TF_COOKIE_HOSTS));
  const version = buildVersion(env);
  const mail = loadMailConfig(env);
  const alerts = loadAlertsConfig(env);
  const admin = loadAdminConfig(env);
  const staff = loadStaffDbConfig(env);

  // The plane is the ONLY billing composition, and a leftover STRIPE_* variable is a
  // cold-start throw rather than decoration (see assertNoStaleStripeEnv). This succeeds the old
  // both-compositions-armed refusal: the in-process block no longer exists to be double-armed, so
  // what is left to refuse is a live Stripe credential parked on a host that no longer reads it.
  assertNoStaleStripeEnv(env);
  const billingPlane = loadBillingPlaneConfig(env);
  return {
    databaseUrlPooled,
    keyProvider,
    kek,
    kekError,
    authConfig,
    sse: { ...DEFAULT_SSE, pollMs, lifetimeMs, enabled: sseEnabled },
    // The LISTEN url is loaded regardless of `sseEnabled` so a bad value is a deploy-time error
    // in both states, but `buildDeps` only constructs the hub when SSE actually streams.
    sseListenUrl: loadSseListenUrl(env),
    cookieHosts: cookieHosts.length > 0 ? cookieHosts : DEFAULT_COOKIE_HOSTS,
    version,
    buildError: buildIdentityError(env, version),
    billingPlane,
    alerts,
    admin: admin.admin,
    adminError: admin.unarmed,
    staffDb: staff.staffDb,
    staffDbError: staff.refusal,
    // The registration's env bootstrap, resolved ONCE here (not per request, and never
    // inside a route). `msOAuthEnv` accepts the canonical `MS_OAUTH_*` names and the `MICROSOFT_*`
    // aliases a live environment may hold, and it is the same function the worker calls.
    msOAuth: msOAuthEnv(env),
    // Validated by assertAppUrl (a redirect target). A value it REFUSES falls back to
    // `defaultOrigin(authConfig)` rather than failing boot: this is not a new reason for a host to
    // refuse to start, and the fallback is itself a boot-validated first-party origin.
    appOrigin: appOriginOf(env),
    // Read from the URL `assertPooledUrl` just accepted, so what `/health` reports is the
    // connection this host actually dials — not a separate parse that could disagree with it.
    dbProvider: providerFamily(databaseUrlPooled),
    // The pager is armed by the alert credential AND the blind connection; when the
    // first is present and the second is not, this is the only thing on the host that says so.
    alertsError: alerts && staff.refusal
      ? `alerting is configured but DARK: ${staff.refusal} — /internal/alerts* answer 503 ` +
        "alerts_db_unarmed and no alert pass runs on this deployment"
      : null,
    mail,
    anthropicApiKey: loadAnthropicKey(env),
    attachmentStaging: loadAttachmentStagingConfig(env),
    environment: env.TF_ENV?.trim() || env.VERCEL_ENV?.trim() || "production",
  };
}

/**
 * The staging bucket's three variables, read as ONE BLOCK.
 *
 * All three or none. A URL with no key mints grants nothing can sign; a key with no bucket names
 * no destination. Half a configuration would produce a deployment whose mint route answers 201 and
 * whose uploads then fail in the browser — a failure one step removed from its cause, which is
 * exactly the shape {@link loadBillingPlaneConfig}'s all-or-nothing rule exists to refuse.
 *
 * It does NOT throw on a partial configuration. That is the difference from
 * {@link loadAnthropicKey}, and the reason is what each absence costs: a mistyped Anthropic key
 * produces a host that charges nothing and tells every customer to try again later, forever, while
 * a missing staging variable produces a host whose sends over 3 MB are refused at the compose form
 * — visible immediately, and no worse than the state before this existed. A boot refusal here
 * would take the whole API down for a feature the product worked without.
 */
function loadAttachmentStagingConfig(
  env: NodeJS.ProcessEnv,
): AttachmentStagingHostConfig | null {
  const url = (env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const bucket = (env.TF_ATTACHMENT_STAGING_BUCKET ?? "").trim();
  if (!url || !serviceKey || !bucket) return null;
  // A project ORIGIN, not a path. The storage paths are appended by the client, and a value
  // carrying a path would silently produce `.../storage/v1/storage/v1/object/...`.
  if (!/^https:\/\/[^/?#]+$/.test(url)) return null;
  return { url, serviceKey, bucket };
}

/**
 * The Anthropic key, validated at BOOT.
 *
 * Absent ⇒ `null`, and this host simply has no drafter (the state it has shipped in until now).
 * Present ⇒ it must be shaped like an Anthropic key, and if it is not the host refuses to
 * start — the rule the plane applies to `STRIPE_SECRET_KEY` on its own host, for the same reason: a
 * deployment handed the wrong secret cannot detect it later. Here the undetectable version is
 * worse than usual, because the drafting path answers **503 `ai_unavailable`** on a model
 * fault: a mailer key pasted into this row would produce a host that looks healthy, charges
 * nothing, and tells every customer who asks for a draft to try again later, for ever.
 *
 * The message names the VARIABLE and never the value — config errors surface in `/health`'s
 * `detail`, which is public.
 */
export function loadAnthropicKey(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (raw === "") return null;
  return assertAnthropicKey(raw);
}

/**
 * Load the alerting block, or `null`.
 *
 * `TF_ALERT_SECRET` is the switch: absent ⇒ `null` ⇒ `POST /internal/alerts` answers 404 and
 * this deployment has no alerting surface. That is the honest default for a host nobody has
 * configured a pager for, and it is strictly safer than exposing an endpoint whose
 * authentication is an empty string.
 *
 * The mail sink is all-or-nothing, exactly like the plane block: `TF_ALERT_EMAIL` without a
 * `RESEND_API_KEY` builds nothing rather than building a mailer that answers `skipped` for
 * ever — which would look configured and deliver nothing, the precise failure mode alerting
 * exists to remove.
 *
 * A short secret is REFUSED — the endpoint runs four aggregate queries and can send mail, and
 * a four-character shared secret on a public URL is a brute-force target with no lockout
 * behind it.
 *
 * ── AND IT REFUSES BY RETURNING null, NOT BY THROWING ────────────────────────────────────
 *
 * Every other loader in this file throws, because every other one guards something whose
 * misconfiguration must stop the host (a poisoned KEK, a half-configured billing plane). This one
 * must not: a throw here reaches `loadHostState`, which turns it into `ok: false`, which
 * answers **503 to every request on the deployment**. Letting the ALERTING configuration
 * darken the product would be an observability feature causing the outage it exists to
 * report — a strictly worse failure than the one it prevents.
 *
 * Refusing quietly is not silent either, and that is the point of the third ring: with no
 * alerts config the endpoint answers 404, the scheduled GitHub workflow's `curl` gets a
 * non-2xx, the run goes red, and GitHub emails the operator. The misconfiguration is
 * reported by the one system that is not ohmail.
 */
export function loadAlertsConfig(env: NodeJS.ProcessEnv): AlertsHostConfig | null {
  const secret = env.TF_ALERT_SECRET?.trim();
  if (!secret || secret.length < 24) return null;
  const operatorEmail = env.TF_ALERT_EMAIL?.trim() || null;
  const mail = loadMailConfig(env);
  // Vercel's cron credential, under the SAME ≥24 rule and for the same reason: there is no
  // rate limit and no lockout behind the compare, so length is the only thing between a
  // guesser and a public URL that runs four aggregate queries and can send mail.
  const cronSecret = env.CRON_SECRET?.trim();
  const botToken = env.TF_ALERT_TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = env.TF_ALERT_TELEGRAM_CHAT_ID?.trim() || null;
  return {
    secret,
    cronSecret: cronSecret && cronSecret.length >= 24 ? cronSecret : null,
    webhookUrl: env.TF_ALERT_WEBHOOK_URL?.trim() || null,
    operatorEmail,
    mail: operatorEmail ? mail : null,
    // Either half present ⇒ a block, so a half-configured push arm reaches `telegramAlertSink`
    // and is REPORTED as half-configured. Folding it to null here would make the commonest
    // misconfiguration — one of two variables set — indistinguishable from never arming it.
    telegram: (botToken || chatId) ? { botToken, chatId } : null,
  };
}

/**
 * The transactional mailer block, or `null`.
 *
 * ALL-OR-NOTHING on the two things a send physically needs (`RESEND_API_KEY`, `MAIL_FROM`):
 * a half-configured mailer would construct, answer `skipped` for ever, and look configured
 * — the failure mode that is indistinguishable from working until somebody asks why nobody
 * ever got their invite.
 *
 * Everything else has a first-party default, and the defaults are the product's real
 * origins. They are not merely conventions: `MailService`'s constructor validates every
 * base against `DEFAULT_LINK_ORIGINS` at boot, so a `MAIL_APP_URL` pointing somewhere else
 * fails loudly at composition rather than rendering a plausible ohmail invite that links to
 * a stranger's site.
 *
 * It does NOT throw on a partial block, for the same reason `loadAlertsConfig` does not: a
 * missing mail configuration must never darken the whole API. It degrades to "signups are
 * recorded, mail is not sent", which `WaitlistService` reports honestly as `mailed: false`.
 */
/**
 * Load the CONTENT-BLIND STAFF CONNECTION, or say why there is none.
 *
 * ── WHY THIS IS ITS OWN LOADER, WHICH IS THE WHOLE OF THE PAGER/CONSOLE SPLIT ─────────────
 *
 * It used to live inside {@link loadAdminConfig}, after that function's three `TF_ADMIN_SECRET`
 * refusals. That ordering made the PAGER's database handle conditional on the ADMIN CONSOLE's
 * credential: a production host with a perfect alerting configuration and a missing, short, or
 * pager-shared `TF_ADMIN_SECRET` got `admin: null`, therefore no `adminDb`, therefore three
 * dark `/internal/alerts*` routes — while `/health` answered 200 and named a *console* fault.
 *
 * The two things are not one capability. `TF_ADMIN_SECRET` is a CREDENTIAL: who may call
 * `/admin/*`. `DATABASE_URL_ADMIN` is a CAPABILITY: what any staff surface, console or pager,
 * is allowed to see. Splitting them means `/internal/alerts*` arms on the alert credential plus
 * this connection, and an unarmed console cannot silence the pager.
 *
 * It does NOT move the pager onto {@link HostConfig.databaseUrlPooled}. The pager is a staff
 * surface by audience and keeps the blind handle: it needs aggregates plus `alert_state`
 * writes, which `STAFF_TABLE_GRANTS` already names. Putting the unrestricted handle back into a
 * staff-triggered graph is the disease the console's own read path just had removed from `/admin/*`.
 *
 * ── THE THREE REFUSALS ────────────────────────────────────────────────────────────────────
 *
 * **Not set.** The staff surfaces read on a second, content-blind connection; with no URL there
 * is nothing to build one from and there is deliberately no fallback to `DATABASE_URL_POOLED`.
 *
 * **Equal to `DATABASE_URL_POOLED`.** The cheap, static half of the accident the whole seam is
 * designed around — runtime credentials pasted into the admin variable. It catches only the
 * literal case; the expensive half, which catches every other spelling of the same mistake, is
 * the boot attestation in `adminDbFor`, which asks the DATABASE for the connected role's entire
 * effective capability set — every column, table privilege, role membership, relation ownership
 * and `SECURITY DEFINER` routine it can reach — and refuses to build a handle holding anything
 * the staff allowlist does not name.
 *
 * **A URL that cannot serve the serverless runtime** — a direct database endpoint, or a
 * pooler in session mode — for `assertPooledUrl`'s reason and by the same `runtimeUrlReason`
 * predicate, except that here it is reported rather than thrown, because no staff surface is
 * worth a deployment-wide 503.
 *
 * All three are STATICALLY CHECKABLE, which is why `next.config.mjs:assertAlertingArmed`
 * duplicates them and why `test/alerting-armed.test.ts` runs a behavioural parity check over
 * the pair: a build gate that accepts an environment this loader refuses is the same
 * "deployed but not watching" state in a new costume.
 *
 * Every message names the VARIABLE and never its value: `/health` publishes this string.
 */
export function loadStaffDbConfig(env: NodeJS.ProcessEnv): StaffDbLoad {
  const refuse = (refusal: string): StaffDbLoad => ({ staffDb: null, refusal });

  const url = env.DATABASE_URL_ADMIN?.trim();
  if (!url) {
    return refuse(
      "staff surface unarmed: DATABASE_URL_ADMIN is not set (it must name ohmail_admin, the " +
      "content-blind role scripts/harden-staff-role.sql creates — there is no fallback to " +
      "DATABASE_URL_POOLED)",
    );
  }
  if (url === env.DATABASE_URL_POOLED?.trim()) {
    return refuse(
      "staff surface unarmed: DATABASE_URL_ADMIN is the RUNTIME connection string — it must " +
      "name ohmail_admin, not the role that serves users",
    );
  }
  // The same `runtimeUrlReason` the product path throws on — REPORTED here, never thrown.
  // The reason string is static and never interpolates the URL: `/health` publishes it.
  const unusable = runtimeUrlReason(url);
  if (unusable) {
    return refuse(`staff surface unarmed: DATABASE_URL_ADMIN is unusable: ${unusable}`);
  }

  return { staffDb: { url }, refusal: null };
}

/**
 * Load the admin CONSOLE's block, or say why there is none.
 *
 * **BOTH `TF_ADMIN_SECRET` AND A USABLE {@link loadStaffDbConfig} ARE REQUIRED.** Either absent
 * ⇒ `admin: null` ⇒ every `GET /admin/*` answers 404 and this deployment has no admin console.
 *
 * The dependency runs one way only, and the pager/console split is what made that true: the console requires the
 * blind connection, the blind connection does not require the console. `/internal/alerts*` is
 * therefore unaffected by anything in this function.
 *
 * Refusing by returning null rather than throwing follows `loadAlertsConfig` exactly and for
 * the same reason: a throw reaches `loadHostState`, which answers **503 to every request on the
 * deployment**, and letting the ops console's configuration darken the product would be
 * strictly worse than the thing it guards. `/health` names the reason instead.
 *
 * ── ITS OWN TWO REFUSALS, AND WHY EACH IS SILENT-BUT-VISIBLE ──────────────────────────────
 *
 * **A secret shorter than 24 characters.** These six endpoints project every account on the
 * platform and there is no rate limit and no lockout behind the compare, so the secret's LENGTH
 * is the only thing between a guesser and the roster. The failure is visible immediately and
 * unmistakably: the console renders error panels naming the endpoint, on the first page load
 * after the deploy.
 *
 * **A secret equal to `TF_ALERT_SECRET`.** Sharing one value would mean rotating the pager
 * revokes staff access and rotating staff access silences the pager — two independent
 * credentials with one lifetime, discovered at the worst possible moment. It is refused here
 * rather than documented, because the way this happens is somebody pasting the value they
 * already had.
 *
 * The three connection refusals belong to {@link loadStaffDbConfig} and are reported verbatim,
 * so `/health`'s `adminFault` still names the missing variable.
 *
 * Every message names the VARIABLE and never its value: `/health` publishes this string.
 */
export function loadAdminConfig(env: NodeJS.ProcessEnv): AdminLoad {
  const unarmed = (reason: string): AdminLoad => ({ admin: null, unarmed: reason });

  const secret = env.TF_ADMIN_SECRET?.trim();
  if (!secret) return unarmed("staff surface unarmed: TF_ADMIN_SECRET is not set");
  if (secret.length < 24) {
    return unarmed("staff surface unarmed: TF_ADMIN_SECRET is shorter than 24 characters");
  }
  if (secret === env.TF_ALERT_SECRET?.trim()) {
    return unarmed(
      "staff surface unarmed: TF_ADMIN_SECRET and TF_ALERT_SECRET are the same value, which " +
      "would give the pager and staff access one lifetime",
    );
  }

  // The console may not exist without the blind connection: the alternative is a `/admin/*`
  // that has to pick a handle at request time, and the only other one in this process reads
  // every account's mail.
  const staff = loadStaffDbConfig(env);
  if (!staff.staffDb) return unarmed(staff.refusal!);

  return { admin: { secret }, unarmed: null };
}

export function loadMailConfig(env: NodeJS.ProcessEnv): MailHostConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    replyTo: env.MAIL_REPLY_TO?.trim() || null,
    appUrl: env.MAIL_APP_URL?.trim() || DEFAULT_APP_URL,
    siteUrl: env.MAIL_SITE_URL?.trim() || "https://ohmail.app",
    adminUrl: env.TF_ADMIN_URL?.trim() || "https://admin.ohmail.app",
    supportEmail: env.MAIL_SUPPORT_EMAIL?.trim() || "support@ohmail.app",
  };
}

/** {@link loadHostConfig} with its throw captured, so the request path can answer 503. */
export function loadHostState(env: NodeJS.ProcessEnv): HostState {
  try {
    return { ok: true, cfg: loadHostConfig(env) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), version: buildVersion(env) };
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") throw new Error(`missing required env var ${key}`);
  return v.trim();
}

// ── one resolved state per cold instance ──────────────────────────────────────
let cached: HostState | null = null;

/** The host state for this instance, resolved once and reused by every warm request. */
export function hostState(env: NodeJS.ProcessEnv = process.env): HostState {
  if (!cached) cached = loadHostState(env);
  return cached;
}

/** Test seam: forget the cached state so a test can load a different environment. */
export function resetHostState(): void {
  cached = null;
}
