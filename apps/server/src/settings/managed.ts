import { assertAnthropicKey } from "@trafficflow/core";
// One definition of "unusable as the pooled runtime connection", shared with the build gate in
// the function door's `next.config.mjs` (duplicated there in JS, because it cannot import TS).
// `transactionPoolerReason` is its mirror: the LISTEN URL must NOT be the transaction pooler.
import { runtimeUrlReason, transactionPoolerReason } from "@trafficflow/db";
import { pgTransportReason } from "@trafficflow/db/cloud";

/**
 * The managed service's setting blocks: what a configuration led by `DATABASE_URL_POOLED` reads
 * and a self-hosted server does not. Each is a pure function of an environment object, called
 * once by `loadSettings`. Every refusal names the VARIABLE and never echoes its value.
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
  const reason = transactionPoolerReason(raw) ?? pgTransportReason(raw);
  // Names the VARIABLE and the reason, never the value — the rule with no exceptions.
  if (reason) throw new Error(`DATABASE_URL_SESSION cannot hold a LISTEN: ${reason}`);
  return raw;
}

/**
 * What this host needs to serve the six admin reads. One field since the
 * pager/console split: the blind connection is the settings' `staff.db`,
 * loaded on its own ({@link loadStaffDbConfig}), and this block is the
 * console's credential and nothing else. The console's server-side proxy
 * presents the secret as `Authorization: Bearer …`; no browser ever holds
 * it, and no session is consulted on those routes
 * (`packages/api/src/routes/admin.ts` states the authorization model).
 */
export interface AdminHostConfig {
  /** `TF_ADMIN_SECRET`. A DIFFERENT value from `TF_ALERT_SECRET` — see {@link loadAdminConfig}. */
  secret: string;
  /**
   * `STAFF_ASSERTION_SIGNING_KEY` and `STAFF_ASSERTION_KID`, raw. Parsed by `deps.ts`; either
   * absent (or a key that is not Ed25519) leaves the assertion mint answering
   * `503 assertion_unarmed` while the rest of the console works.
   */
  assertionKey?: string;
  assertionKid?: string;
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

export const csv = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

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
  const reason = runtimeUrlReason(url) ?? pgTransportReason(url);
  if (reason) throw new Error(`DATABASE_URL_POOLED is unusable: ${reason}`);
  return url;
}

/**
 * The default app origin — the product's ONE origin. It was `https://app.ohmail.app`, which is
 * now a 308 to this. It backs `TF_APP_URL` for the OAuth bounce
 * (the settings' `origin.appOrigin`) and the mail links (`customerMail.links`).
 */
export const DEFAULT_APP_URL = "https://ohmail.app";

/**
 * `TF_APP_URL` as a bare origin, or `null` when it is unusable.
 *
 * Swallowing the refusal is deliberate: a refused value is null, and the OAuth bounce falls back to
 * the first auth origin, itself validated at load. What must NOT happen is a
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
export function assertBootstrapInvites(env: NodeJS.ProcessEnv, environment: string): Set<string> {
  const codes = csv(env.TF_INVITE_CODES);
  if (codes.length === 0) return new Set<string>();

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
 * THE PROVIDER CHOICE IS A SELF-HOST SETTING, AND THIS HOST NEVER TAKES IT. Managed AI runs on
 * Anthropic within the plan's credits; `TF_AI_PROVIDER` here, whatever it says, is a self-host
 * variable deployed to the wrong place — refused like a leftover STRIPE_* variable rather than
 * ignored. This host never reads the self-host resolver. The message names the variable only.
 */
export function assertNoAiProviderChoice(env: NodeJS.ProcessEnv): void {
  if (env.TF_AI_PROVIDER !== undefined) {
    throw new Error(
      "TF_AI_PROVIDER is set on this host, which runs managed AI on Anthropic within the plan's " +
        "credits. Remove it — the provider choice belongs to a self-hosted server",
    );
  }
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
  const unusable = runtimeUrlReason(url) ?? pgTransportReason(url);
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

  return {
    admin: {
      secret,
      assertionKey: env.STAFF_ASSERTION_SIGNING_KEY?.trim() || undefined,
      assertionKid: env.STAFF_ASSERTION_KID?.trim() || undefined,
    },
    unarmed: null,
  };
}
