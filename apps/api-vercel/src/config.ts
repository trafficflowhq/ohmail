import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  keyProviderFromEnv, kekEnvIdentity, assertAnthropicKey,
  type KeyProvider, type KekEnvIdentity,
} from "@trafficflow/core";
import { DEFAULT_SSE, type SseConfig, type BuildIdentitySource } from "@trafficflow/api";
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
 * Prod default for the browser surfaces. The rpID is the registrable domain
 * `ohmail.app` because one credential store has to span the product and
 * `admin.ohmail.app`; a passkey scoped to the product host alone would be
 * refused on the admin console. `origins.ts` enforces the coverage relation
 * at construction. `https://ohmail.app` is the product origin since the
 * single-origin merge (`NEVER_AUTH_HOSTS` in `origins.ts` covers what
 * replaced the old landing rule). `admin.ohmail.app` is not defaulted here;
 * it is added via `TF_AUTH_ORIGINS` on the deployment that wants it.
 */
export const DEFAULT_RP_ID = "ohmail.app";
export const DEFAULT_ORIGINS = ["https://ohmail.app"];
/**
 * Hosts on which the `tf_session` cookie is an accepted credential. All three
 * are browser surfaces: `ohmail.app`, `admin.ohmail.app`, and
 * `api.ohmail.app` — the target of the webapp's same-origin rewrite, which
 * forwards with the API's own Host. An allow-list: anything not on it (the
 * platform's deployment URL, a preview alias) is bearer-only, so a forgotten
 * surface cannot honour an ambient browser credential. `app.ohmail.app` is a
 * 308 now and must stay off the list: `allowCookieAuthForRequest` requires
 * every asserted host to be listed. Native clients authenticate by bearer.
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
 * `TF_COOKIE_HOSTS` may only select from {@link PERMITTED_COOKIE_HOSTS}; it
 * may not extend it. Otherwise one environment edit could add a surface with
 * no CSRF story and it would start honouring an ambient browser cookie.
 * There is deliberately no env-var escape hatch: a genuine new browser
 * surface needs `TF_AUTH_ORIGINS`, the webapp rewrite and DNS anyway, so
 * widening the product means editing this list, in a commit, in review.
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
 * SSE stream lifetime in production: how long one `/events` invocation runs
 * before closing cleanly so `EventSource` reconnects on the `retry:` hint.
 * `/events` has its own route module (`app/events/route.ts`, `maxDuration`
 * {@link EVENTS_MAX_DURATION_S}); 270 s keeps a 30-second margin under the
 * route's 300, and the margin is the point — the server must end the stream,
 * not the platform: a platform kill is a dropped socket the client reads as
 * an error, a clean close is an ordinary reconnect. `TF_SSE_LIFETIME_MS`
 * overrides it (integer, 5 s to {@link MAX_SSE_LIFETIME_MS}).
 */
export const PROD_SSE_LIFETIME_MS = 270_000;
/** `maxDuration` of `app/events/route.ts`, in seconds. Named here so config can respect it. */
export const EVENTS_MAX_DURATION_S = 300;
/** The most a configured lifetime may be: the route's duration minus a margin for the close. */
export const MAX_SSE_LIFETIME_MS = (EVENTS_MAX_DURATION_S - 10) * 1_000;

/**
 * The LISTEN connection — `DATABASE_URL_SESSION`, or `null` when this
 * deployment has none. `/events` gets pushed wakes from a per-instance
 * `LISTEN ohmail_change_log` (`src/wake-hub.ts`), and that LISTEN cannot ride
 * `DATABASE_URL_POOLED`: a transaction-mode pooler multiplexes statements
 * across backends, so the LISTEN subscribes a backend the next statement has
 * already left — it fails silently. Session mode pins one backend per client
 * connection. Absent ⇒ `null` ⇒ streams run on their poll loop alone (a
 * legitimate state); present but transaction-mode throws at load.
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
   * Where {@link HostConfig.version} came from — platform | file | variable | none. See
   * {@link buildIdentityOf}; published on `/health` beside `version` so a `variable` answer
   * (an operator-typed label, not one read out of the deployed artifact) is distinguishable
   * from one the platform or a build-time file can vouch for.
   */
  buildSource: BuildIdentitySource;
  /**
   * Why {@link HostConfig.version} is not a real build identity, on a host where that is not
   * acceptable. Non-null ⇒ `/health` answers 503 `build_identity_unknown`.
   */
  buildError: string | null;
  /**
   * WHERE THIS HOST ASKS ABOUT AN ACCOUNT'S STANDING, or `null` when it asks nobody — in which
   * case every account is unmetered and unbounded, which is a DECLARATION and not a gap.
   *
   * Asymmetric on purpose: a URL with no secret is a client every call 401s, so it throws at
   * cold start; a secret with no URL is simply an unmetered host, because that variable is the
   * program's own bearer and an environment may hold it for another reason.
   */
  entitlements: EntitlementsHostConfig | null;
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
   * The env bootstrap for the Microsoft application registration (cloud
   * migration 0009 created the row it defers to). Always present and possibly
   * all-empty, unlike {@link HostConfig.admin} and
   * {@link HostConfig.entitlements}: the authority is the
   * `oauth_provider_config` row, and env is only what a deployment with no
   * row falls back to; `ResolvedOAuthConfig.source` distinguishes the states.
   * The variable names — `MICROSOFT_*` aliases included — are resolved by
   * `msOAuthEnv` in `packages/db`, which the worker also calls.
   */
  msOAuth: MsOAuthBootstrap;
  /**
   * What the vendors charge — the credentials the six-hourly platform-cost
   * pass asks with. Always present and possibly all-empty: `null` would make
   * "no credential" and "this host does not do costs" the same value, and the
   * cost board must tell them apart. A host composing no port answers
   * `200 {skipped}` on `/internal/platform-costs/run`; one with a port and no
   * credential asks, gets `unconfigured`, and the board renders "not
   * configured". Read here and nowhere else — a route reaching into
   * `process.env` makes every test depend on the runner's ambient variables.
   */
  /**
   * `CRON_SECRET` — the platform's own scheduler credential, at the top level
   * and not inside {@link alerts}: the cost pass is a scheduled route with
   * nothing to do with alerting, and reading the credential off the alerting
   * block let an unrelated optional feature decide whether costs were
   * collected at all. `alerts.cronSecret` is the same value, kept for the
   * alerting routes. `null` when unset or shorter than 24 characters — there
   * is no rate limit behind the compare on a public URL.
   */
  cronSecret: string | null;
  /**
   * The absolute origin the OAuth bounce redirects a browser to. `TF_APP_URL`
   * through {@link assertAppUrl}: it is a redirect target, so it is validated
   * like one — an arbitrary string here is an open redirect on a high-trust
   * moment. `null` ⇒ the route falls back to `defaultOrigin(authConfig)`, the
   * first `TF_AUTH_ORIGINS` entry — safe because `assertOriginConfig`
   * validates it at boot and the rpID must cover it, so it cannot be a
   * foreign host.
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
   * `RESEND_API_KEY` + `MAIL_FROM`. Kept out of {@link AlertsHostConfig}: the
   * mailer sends the waitlist confirmation and the beta invite, and gating
   * those on `TF_ALERT_SECRET` would let arming the pager silently turn
   * customer mail on or off. `loadAlertsConfig` reads this same block, so the
   * two cannot disagree about the mailer key or link origins.
   */
  mail: MailHostConfig | null;
  /**
   * The validated `ANTHROPIC_API_KEY`, or `null` on a deployment with no
   * managed AI. `null` is legitimate: `POST /messages/:id/draft` answers
   * 503 `drafter_unconfigured`, and `POST /workflows/:id/run` refuses a
   * workflow containing a `draft_reply` step with the same 503 rather than
   * answering 202 for work the drain cannot do. A key present but not shaped
   * like an Anthropic key throws at load — {@link loadAnthropicKey}. Set it
   * on the worker and on this host in the same change; the divergent states
   * are described in `WorkflowsService.assertRunnable`.
   */
  anthropicApiKey: string | null;
  /**
   * Where staged attachment bytes go, or `null` on a deployment with no
   * object storage. `null` degrades honestly: `POST /attachments/staging`
   * answers 503 `unavailable`, the browser falls back to inline attachment
   * bytes, and everything under the 3 MB request-body ceiling keeps working —
   * what is lost is a send bigger than the serverless body limit.
   * All-or-nothing like {@link HostConfig.entitlements}: a URL with no
   * service key would mint grants nothing can sign, so the three variables
   * are read as one block.
   */
  attachmentStaging: AttachmentStagingHostConfig | null;
  /** `production` / `preview` / `development` — the first word of every alert. */
  environment: string;
}

/**
 * The staging bucket and the credential that reaches it. `serviceKey` is the
 * service-role key and the only credential that touches the bucket: it is
 * private, no public read, no anon-key policy. The browser receives a signed
 * URL scoped to one object — never the key. A dedicated bucket, never one
 * anything else writes to: its contents are outgoing attachments for 24
 * hours, and a shared bucket would put the retention sweep's `DELETE` next
 * to objects nobody meant to expire.
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
   * The push arm — the pager's second vendor (`TF_ALERT_TELEGRAM_BOT_TOKEN` +
   * `TF_ALERT_TELEGRAM_CHAT_ID`), or `null`. This host is the only observer
   * of `worker_down`, and a mail-vendor outage that coincides with a dead
   * worker is total silence, so the push arm shares nothing with the mailer:
   * another company, another network, another credential. Not all-or-nothing,
   * unlike {@link MailHostConfig}: a half-set pair is a fault to name — the
   * arm refuses every delivery and says which half is missing
   * (`alert-push.ts` rules the states; the same object arms the worker).
   */
  telegram: { botToken: string | null; chatId: string | null } | null;
}

/**
 * What this host needs to serve the six admin reads. One field since the
 * pager/console split: the blind connection is {@link HostConfig.staffDb},
 * loaded on its own ({@link loadStaffDbConfig}), and this block is the
 * console's credential and nothing else. The console's server-side proxy
 * presents the secret as `Authorization: Bearer …`; no browser ever holds
 * it, and no session is consulted on those routes
 * (`packages/api/src/routes/admin.ts` states the authorization model).
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

/**
 * A `BUILD_VERSION` file at this app's project root, written into the
 * deployed tree at deploy time (as `apps/worker/src/build-version.ts` reads
 * the worker's). `process.cwd()`, not `__dirname` and not `import.meta.url`:
 * this package is CommonJS, so `tsc -b tsconfig.check.json` refuses
 * `import.meta` (TS1470), and `__dirname` inside a webpack chunk is the
 * chunk's own directory, not this source file's. `process.cwd()` is the
 * platform's documented pattern; this app's Vercel Root Directory is
 * `apps/api-vercel`, the directory the deploy step writes the file into.
 */
const buildVersionFile = (): string => {
  try {
    return readFileSync(join(process.cwd(), "BUILD_VERSION"), "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * Which build this is; the source order is the design (the worker's
 * `buildIdentityOf` argues the same):
 *  1. `VERCEL_GIT_COMMIT_SHA` — the platform's git metadata; it cannot
 *     disagree with what runs. Absent on a `git archive` deploy (no `.git`).
 *  2. {@link buildVersionFile} — an input to the artifact, not state beside it.
 *  3. `TF_BUILD_VERSION`, last — an operator variable that can report a new
 *     sha while an old build serves. Every term is trimmed: a whitespace-only
 *     value must fall through, not become an identity.
 */
export const buildIdentityOf = (
  env: NodeJS.ProcessEnv,
  file: () => string = buildVersionFile,
): { version: string; source: BuildIdentitySource } => {
  const platform = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (platform) return { version: platform, source: "platform" };
  const fromFile = file().trim();
  if (fromFile) return { version: fromFile, source: "file" };
  const variable = env.TF_BUILD_VERSION?.trim();
  if (variable) return { version: variable, source: "variable" };
  return { version: "dev", source: "none" };
};

export const buildVersion = (env: NodeJS.ProcessEnv, file: () => string = buildVersionFile): string =>
  buildIdentityOf(env, file).version;

/**
 * A production deployment must say which build it is, honestly. `version:
 * "dev"` in production means no source answered — "which build is serving?"
 * has no answer and `/health`'s KEK/schema comparisons lose their anchor.
 * Reported, not thrown; `VERCEL_ENV` gates it, so previews are unaffected.
 * A `source: "variable"` answer is reported too: the value is the operator's
 * intent, not an identity read out of the artifact — and do not close it by
 * updating `TF_BUILD_VERSION`; the next git-archive deploy with no
 * `BUILD_VERSION` file reports the same false confidence.
 */
export const buildIdentityError = (
  env: NodeJS.ProcessEnv,
  version: string,
  source: BuildIdentitySource = version === "dev" ? "none" : "file",
): string | null => {
  if (env.VERCEL_ENV?.trim() !== "production") return null;
  if (source === "none" || version === "dev") {
    return "no build identity: apps/api-vercel/BUILD_VERSION is absent from this deployment " +
      "and neither VERCEL_GIT_COMMIT_SHA nor TF_BUILD_VERSION is set";
  }
  if (source === "variable") {
    return "build identity came from TF_BUILD_VERSION, not from the deployment: " +
      "apps/api-vercel/BUILD_VERSION is absent from this build, so `version` names whatever " +
      "the variable was last set to and may name a build this deployment was never built from";
  }
  return null;
};

/**
 * Reject a connection that cannot serve as the pooled one — a direct
 * database endpoint, or a pooler in session mode. The mirror image of
 * `assertSessionUrl` in `packages/db/src/setup-prod.ts`: handing the direct
 * URL to `makePooledDb` "works", then every warm instance holds a real
 * Postgres backend instead of a pooler slot and the provider refuses
 * connections under load. The rule lives in `runtimeUrlReason`
 * (`packages/db/src/session-url.ts`), which recognises managed poolers by
 * URL shape and fails open on an unrecognised host, making a throw safe.
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
 * Every hostname this request asserts, normalized the way
 * {@link allowCookieAuthFor} compares them: the request URL's host (the only
 * one that survives `new Request(url, …)` — `Host` is a forbidden fetch
 * header), the `Host` header when the runtime exposes one, and every
 * `X-Forwarded-Host` value (proxies comma-join, so it is split). Only
 * `X-Forwarded-Host` is independent input; the `every` in
 * {@link allowCookieAuthForRequest} makes a forged value strictly
 * subtractive. A hostless URL contributes nothing; empty ⇒ refusal.
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
 * The cookie-auth decision. The rule: every asserted host must be on the
 * allow-list, and there must be at least one; anything else is bearer-only.
 * "Every", not "the Host header": the webapp-rewrite pair (`api.ohmail.app`,
 * `ohmail.app`) is fully listed, while a typed `X-Forwarded-Host` can only
 * turn cookies off — honoured alone it would switch the bearer-only surface
 * into cookie mode. Unknown host ⇒ bearer-only, not 421/404: refusing would
 * take out the platform's own deployment URL, while bearer-only still serves
 * and cannot honour an ambient browser credential.
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
 * The default app origin — the product's ONE origin. It was `https://app.ohmail.app`, which is
 * now a 308 to this. It backs `TF_APP_URL` for the OAuth bounce
 * ({@link HostConfig.appOrigin}) and the mail links ({@link loadMailConfig}).
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
 * `TF_APP_URL` is a redirect target, so it is validated like one: it becomes
 * the origin the OAuth consent bounce sends a browser to and the base of
 * every transactional-mail link. Refused: a non-`https` scheme, embedded
 * credentials, a query or fragment (they collide with appended params), a
 * path (the value is interpolated as `${appUrl}/<route>`), and any host
 * outside the first-party registrable domains — the check that stops the
 * redirect leaving the product. A bare trailing slash is fine; the result is
 * normalized to an origin.
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
 * This host holds no payment credential, and a leftover one is a refused
 * deploy: there is no payments code on this server, so a `STRIPE_*` variable
 * here is either a live secret that should have been removed or the first
 * half of re-arming something that is not here — neither may be silent.
 * Matched by prefix, not a fixed list, so any spelling is caught. The
 * message names variables and never a value: it surfaces in `/health`'s
 * `detail`, which is public.
 */
export function assertNoStaleStripeEnv(env: NodeJS.ProcessEnv): void {
  const stale = Object.keys(env)
    .filter((k) => k.startsWith("STRIPE_") && (env[k] ?? "").trim() !== "")
    .sort();
  if (stale.length > 0) {
    throw new Error(
      `Stripe variables are set on this host, which holds no payments code: ` +
        `${stale.join(", ")}. Remove them — they belong to whoever operates the service, not ` +
        "to this server",
    );
  }
}

/** What this host needs to reach an entitlements program. Present or absent as a WHOLE. */
export interface EntitlementsHostConfig {
  /** The program's origin (`https://…`), normalized — no path, no query, no credentials. */
  url: string;
  /** `BILLING_PLANE_SECRET` — the program's own bearer, per its wire contract. >= 24 chars. */
  secret: string;
}

/**
 * The entitlements block: `ENTITLEMENTS_URL` plus the program's OWN secret.
 *
 * One program, one credential — its wire contract names `BILLING_PLANE_SECRET` as the bearer,
 * and the variable keeps that name because the program does. A second variable holding
 * the same value is a second thing to rotate and a second way for the two to disagree.
 */
const ENTITLEMENTS_VARS = ["ENTITLEMENTS_URL", "BILLING_PLANE_SECRET"] as const;

/**
 * The entitlements block, validated on {@link loadBillingPlaneConfig}'s
 * terms. `ENTITLEMENTS_URL` unset ⇒ no client and this host answers from its
 * own tables. Set without the secret is a host someone configured wrong,
 * refused at cold start rather than request time: a client whose every call
 * 401s would fail open — every account allowed, silently. Every message
 * names the variable and never the value.
 */
export function loadEntitlementsConfig(env: NodeJS.ProcessEnv): EntitlementsHostConfig | null {
  if ((env.ENTITLEMENTS_URL ?? "").trim() === "") return null;
  if ((env.BILLING_PLANE_SECRET ?? "").trim() === "") {
    throw new Error(
      "ENTITLEMENTS_URL is set without BILLING_PLANE_SECRET, which is never a valid deployment: "
        + "the entitlements endpoints belong to that program, and its bearer is that secret.",
    );
  }
  const secret = env.BILLING_PLANE_SECRET!.trim();
  if (secret.length < 24) {
    throw new Error("BILLING_PLANE_SECRET must be at least 24 characters");
  }
  const raw = env.ENTITLEMENTS_URL!.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ENTITLEMENTS_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw new Error("ENTITLEMENTS_URL must use https — the bearer rides every request");
  if (url.username || url.password) throw new Error("ENTITLEMENTS_URL must not embed credentials");
  if (url.search || url.hash) throw new Error("ENTITLEMENTS_URL must not carry a query string or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "ENTITLEMENTS_URL must be a bare origin with no path — the client appends /v1/…, " +
        "so a path would be silently doubled",
    );
  }
  return { url: url.origin, secret };
}

/**
 * `TF_INVITE_CODES`, and a hard refusal to boot production with one. A
 * static bootstrap code is plaintext, reusable, non-expiring and bound to no
 * address: `AuthService.register` consults it when the `invites` table does
 * not recognise a code, so a holder can register arbitrary addresses and
 * read 201-vs-409 as an account-existence oracle — what migration 0020's
 * email-bound invites removed. The escape hatch is a first boot: deploy once
 * with `TF_INVITE_BOOTSTRAP_ACK` set to the same value, register, remove
 * both. Non-production is unchanged; there the bootstrap is legitimate.
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
 * Absent or empty ⇒ `null` ⇒ uncapped — a cap nobody chose is a number
 * waiting to lock the funnel. A malformed value throws rather than falling
 * back to uncapped: an operator who typed `1oo` is trying to limit signups,
 * and reading the typo as "no limit" does the opposite of what they asked,
 * with no signal. The variable is named and its value never echoed — the
 * same rule as `TF_SSE_POLL_MS`.
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
 * `assertOriginConfig` refuses, a nonsense poll interval, a HALF-configured entitlements
 * block, a leftover `STRIPE_*` variable — throws,
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
  const { version, source: buildSource } = buildIdentityOf(env);
  const mail = loadMailConfig(env);
  const alerts = loadAlertsConfig(env);
  const admin = loadAdminConfig(env);
  const staff = loadStaffDbConfig(env);

  // A leftover STRIPE_* variable is a cold-start throw rather than decoration: there is no
  // payments code here to read it (see assertNoStaleStripeEnv).
  assertNoStaleStripeEnv(env);
  const entitlements = loadEntitlementsConfig(env);
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
    buildSource,
    buildError: buildIdentityError(env, version, buildSource),
    entitlements,
    alerts,
    admin: admin.admin,
    adminError: admin.unarmed,
    staffDb: staff.staffDb,
    staffDbError: staff.refusal,
    // The registration's env bootstrap, resolved ONCE here (not per request, and never
    // inside a route). `msOAuthEnv` accepts the canonical `MS_OAUTH_*` names and the `MICROSOFT_*`
    // aliases a live environment may hold, and it is the same function the worker calls.
    msOAuth: msOAuthEnv(env),
    // The vendor cost credentials, resolved ONCE here like every other block. Always an object,
    // possibly with every member absent — see the field's own note.
    cronSecret: ((): string | null => {
      const raw = env.CRON_SECRET?.trim();
      return raw && raw.length >= 24 ? raw : null;
    })(),
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
 * The staging bucket's three variables, read as one block — all three or
 * none. A URL with no key mints grants nothing can sign; a key with no
 * bucket names no destination; half a configuration is a mint route that
 * answers 201 while uploads fail in the browser. It does not throw on a
 * partial configuration, unlike {@link loadAnthropicKey}: a missing staging
 * variable costs only sends over 3 MB, visible at the compose form, and a
 * boot refusal would take the whole API down for a feature the product
 * worked without.
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
 * The Anthropic key, validated at boot. Absent ⇒ `null`: this host has no
 * drafter. Present ⇒ it must be shaped like an Anthropic key or the host
 * refuses to start: a deployment handed the wrong secret cannot detect it
 * later — the drafting path answers 503 `ai_unavailable` on a model fault,
 * so a mailer key pasted here would look healthy and tell every customer to
 * try again later, forever. The message names the variable and never the
 * value; config errors surface in `/health`'s public `detail`.
 */
export function loadAnthropicKey(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (raw === "") return null;
  return assertAnthropicKey(raw);
}

/**
 * Load the alerting block, or `null`. `TF_ALERT_SECRET` is the switch:
 * absent ⇒ `null` ⇒ `POST /internal/alerts` answers 404. The mail sink is
 * all-or-nothing (`TF_ALERT_EMAIL` without `RESEND_API_KEY` builds nothing
 * rather than a mailer that answers `skipped` forever). A short secret is
 * refused — a public URL with no lockout. It refuses by returning null, not
 * throwing: a throw reaches `loadHostState` and 503s every request, and
 * alerting must never cause the outage it exists to report. The refusal is
 * visible anyway: the endpoint 404s and the scheduled workflow's curl goes red.
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
 * The transactional mailer block, or `null`. All-or-nothing on the two
 * things a send physically needs (`RESEND_API_KEY`, `MAIL_FROM`): a
 * half-configured mailer would construct, answer `skipped` forever, and look
 * configured. Everything else defaults to the product's real origins, and
 * `MailService`'s constructor validates every base against
 * `DEFAULT_LINK_ORIGINS` at boot. It does not throw on a partial block, for
 * `loadAlertsConfig`'s reason: missing mail must never darken the whole API —
 * it degrades to "signups recorded, mail not sent" (`mailed: false`).
 */
/**
 * The content-blind staff connection. Its own loader, apart from {@link loadAdminConfig}:
 * `TF_ADMIN_SECRET` is a credential (who may call `/admin/*`), `DATABASE_URL_ADMIN` a
 * capability (what any staff surface may see) — split so an unarmed console cannot silence
 * the pager. Refused: unset (deliberately no fallback to `DATABASE_URL_POOLED`), equal to
 * `DATABASE_URL_POOLED` (the boot attestation in `adminDbFor` catches every other spelling),
 * or unusable for the serverless runtime (`runtimeUrlReason` — reported, not thrown; no staff
 * surface is worth a deployment-wide 503). `test/alerting-armed.test.ts` checks parity with
 * the `next.config.mjs` build gate; every message names the variable, never its value.
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
 * Load the admin console's block, or say why there is none. Both `TF_ADMIN_SECRET` and a
 * usable {@link loadStaffDbConfig} are required; either absent ⇒ `admin: null` ⇒ every
 * `GET /admin/*` answers 404. The dependency runs one way — the console requires the blind
 * connection, never the reverse — so `/internal/alerts*` is unaffected by this function.
 * Refuses by returning null, not throwing (`loadAlertsConfig`'s rule: a throw would 503 the
 * deployment). Its own refusals: a secret shorter than 24 characters (no rate limit or
 * lockout behind the compare) and a secret equal to `TF_ALERT_SECRET` (one value would give
 * two credentials one lifetime). Every message names the variable, never its value.
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
