import {
  keyProviderFromEnv, kekEnvIdentity, assertAnthropicKey,
  type KeyProvider, type KekEnvIdentity,
} from "@trafficflow/core";
import { transactionPoolerReason, providerFamily } from "@trafficflow/db";
import { msOAuthEnv, type MsOAuthBootstrap } from "@trafficflow/db/cloud";
import { makeAuthConfig, type AuthConfig } from "@trafficflow/services";
import { DEFAULT_SSE, type SseConfig } from "@trafficflow/api";

/**
 * Deployment configuration for the STANDALONE SELF-HOST SERVER — one long-running process an
 * operator runs on their own box, against their own Postgres, behind their own proxy.
 *
 * Nothing is read from `process.env` at module scope: {@link loadServerConfig} is a pure function
 * of an environment object, resolved exactly ONCE at boot by `index.ts`. Unlike the serverless
 * host — which must stay up to let `/health` name a config fault — this process may simply REFUSE
 * TO START on a misshapen value: a crash-looping container with the reason on stderr is the
 * operator-visible failure here, and it happens before the migrator touches anything. The one
 * deliberate exception is the KEK (captured, poisoned provider, `/health` 503s naming it), because
 * a broken key ring must not hide the health endpoint that reports it.
 *
 * EVERY refusal names the VARIABLE and NEVER echoes its value. No exceptions: an origin can embed
 * credentials, a connection string always does, and the pattern gets copied.
 */

/**
 * Loopback names a same-box run may present as `Host`. Everything else outside the origin's own
 * host is bearer-only — see {@link cookieHostsFor}. Mirrors the managed host's loopback set.
 */
export const LOOPBACK_COOKIE_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"] as const;

/**
 * The hosts on which the `tf_session` COOKIE is an accepted credential: the ONE host
 * `OHMAIL_ORIGIN` names, plus loopback for the same-box `http://localhost` run.
 *
 * This deliberately does NOT reuse the managed host's `assertCookieHosts` — that function admits
 * only a COMPILED `ohmail.app` allow-list (`PERMITTED_COOKIE_HOSTS`), which is exactly right for
 * the deployment it guards and meaningless for an operator origin. What it PRESERVES is that
 * function's semantics: a list of one operator host, derived from configuration reviewed at boot,
 * and NEVER widened by anything a request asserts — `allowCookieAuthForRequest` reads request
 * hosts only to turn cookie auth OFF. There is no `TF_COOKIE_HOSTS` here at all: a second browser
 * origin is a second `OHMAIL_ORIGIN` decision, not an env append.
 */
export function cookieHostsFor(origin: string): string[] {
  const host = new URL(origin).hostname.toLowerCase();
  return [host, ...LOOPBACK_COOKIE_HOSTS.filter((h) => h !== host)];
}

/**
 * Whether this host accepts cookie authentication, per REQUEST HOST — the managed host's exact
 * rule, restated over the operator's one-host list: EVERY asserted host (request URL, `Host`,
 * every `X-Forwarded-Host` value) must be on the allow-list, and there must be at least one.
 * A forged or foreign `X-Forwarded-Host` is therefore strictly SUBTRACTIVE — it can turn cookies
 * off and never on — and an unknown host degrades to bearer-only rather than 421: an
 * unrecognised surface cannot honour an ambient browser credential, and a native client keeps
 * working.
 */
export function allowCookieAuthForRequest(req: Request, cookieHosts: string[]): boolean {
  let fromUrl = "";
  try {
    fromUrl = new URL(req.url).host;
  } catch {
    /* not absolute — the header sources still apply */
  }
  const asserted = [...new Set(
    [
      fromUrl,
      req.headers.get("host") ?? "",
      ...(req.headers.get("x-forwarded-host") ?? "").split(","),
    ]
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter((h) => h.length > 0),
  )];
  if (asserted.length === 0) return false;       // no host assertion at all ⇒ fail closed
  const allowed = new Set(cookieHosts.map((h) => h.trim().toLowerCase()));
  return asserted.every((h) => allowed.has(h));
}

/**
 * SSE on this host is ON, unconditionally — a long-running server pays nothing per open stream
 * beyond one poll query per {@link SELF_HOST_SSE_POLL_MS}, so the managed host's cost flag has no
 * subject here and there is deliberately no `TF_SSE` variable to forget. The lifetime keeps the
 * managed cadence (the client's `EventSource` reconnects on the `retry:` hint either way), and
 * the poll is the staleness floor when the LISTEN is down.
 */
export const SELF_HOST_SSE_POLL_MS = 5_000;
export const SELF_HOST_SSE_LIFETIME_MS = 270_000;
export const SELF_HOST_SSE: SseConfig = {
  ...DEFAULT_SSE,
  pollMs: SELF_HOST_SSE_POLL_MS,
  lifetimeMs: SELF_HOST_SSE_LIFETIME_MS,
  enabled: true,
};

/**
 * THE REQUEST-BODY CEILING of the hand-rolled adapter, in bytes — refused as 413 by
 * `src/http.ts`, from the declared `Content-Length` where there is one and from a counting
 * transform where there is not (a chunked body that lies is cut off mid-stream).
 *
 * 50 MB. The only large request on this API is a send whose attachment bytes ride inline as
 * base64; everything else is small JSON. The number is derived, not felt: the send surface below
 * must clear this cap after the ~4/3 base64 inflation plus the JSON envelope.
 */
export const BODY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The send surface's ceiling in RAW attachment bytes — what `SendService` compares against the
 * smaller of this and the sending mailbox's own announced SIZE. 32 MB raw encodes to ~42.7 MB of
 * base64, which clears {@link BODY_MAX_BYTES} with megabytes to spare for the JSON envelope.
 * Declared explicitly (the absent case is the hosted 3 MB constant — the strict branch for a
 * host nobody has read; this one has been read). Once object storage is armed, staged sends
 * bypass this entirely, exactly as they do on the managed host.
 */
export const SELF_HOST_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Slowloris ceilings for the node:http server — ruled point 4, beside the body cap. */
export const SERVER_HEADERS_TIMEOUT_MS = 30_000;
export const SERVER_REQUEST_TIMEOUT_MS = 300_000;

export const DEFAULT_PORT = 8080;

/** The SMTP block — parsed by {@link loadSmtpConfig}, wired as `SmtpMailer` behind the auth
 *  ceremony's `MailService` in `deps.ts` (`customerMailerFor`). Absent ⇒ mailer null, and the
 *  composition works: invites verify through the consumed token, not through mail. */
export interface SmtpConfig {
  /** `smtp://user:pass@host:port` or `smtps://…` — nodemailer's URL form. Never logged. */
  url: string;
  from: string;
  replyTo: string | null;
}

/**
 * Object storage — parsed by {@link loadStorageConfig}, wired through the env-kind factory
 * (`stagingStorageFor` in `deps.ts`) into the bag's `attachmentStaging` member. When this is
 * null the staging port stays ABSENT from the service bag, `POST /attachments/staging` answers
 * 503, `/hello` reports `staging: false`, and inline sends carry the bytes — the load-bearing-
 * absence semantics the compositions already have.
 */
export type StorageConfig =
  | { kind: "supabase"; url: string; serviceKey: string; bucket: string }
  | {
    kind: "s3"; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string;
    bucket: string;
    /** The endpoint upload GRANTS are addressed to — `S3_PUBLIC_ENDPOINT`, defaulted to
     *  `OHMAIL_ORIGIN`. Used ONLY when the grant's URL is built
     *  (`makeS3StagingStorage.signUpload`); the service wire (download, delete) stays on
     *  {@link endpoint}. The default is the whole point: the web app may only talk to its own
     *  origin (CSP `connect-src 'self'`), so browser uploads ride the reverse proxy's
     *  `/<bucket>/*` route — same-origin for the browser, Host preserved for the signature.
     *  An off-origin value here therefore serves NON-BROWSER clients only; the browser refuses
     *  it before the store ever sees the request (.env.example states this to the operator). */
    publicEndpoint: string;
  };

export interface ServerConfig {
  /** The ONE absolute browser origin this install serves (`OHMAIL_ORIGIN`), canonicalized. */
  origin: string;
  /** WebAuthn relying-party id — the origin's own hostname, derived, never configured apart. */
  rpID: string;
  authConfig: AuthConfig;
  /** See {@link cookieHostsFor}: the origin's host + loopback, list-of-one semantics. */
  cookieHosts: string[];
  /** Plain `DATABASE_URL` — the operator's own Postgres. Session-capable by nature; there is
   *  deliberately NO `assertPooledUrl` here (that guard rejects everything that is not a managed
   *  pooler, which is exactly what an operator's database is). */
  databaseUrl: string;
  port: number;
  keyProvider: KeyProvider;
  kek: KekEnvIdentity | null;
  kekError: string | null;
  version: string;
  sse: SseConfig;
  smtp: SmtpConfig | null;
  storage: StorageConfig | null;
  anthropicApiKey: string | null;
  alerts: { secret: string; webhookUrl: string | null } | null;
  msOAuth: MsOAuthBootstrap;
  /** `TF_PROBE_ALLOW_PRIVATE=1` — see {@link loadServerConfig}. Absent means ENFORCE. */
  probeAllowPrivate: boolean;
  /** `TF_PUSH_ALLOW_PRIVATE=1` — see {@link loadServerConfig}. Absent means ENFORCE. */
  pushAllowPrivate: boolean;
  environment: string;
  bodyMaxBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * A {@link KeyProvider} that refuses to do anything, installed when the KEK environment is
 * unusable — the managed host's pattern, for the managed host's reason: the boot must reach
 * `/health`, which is the one thing that can TELL the operator the KEK is wrong. Any route that
 * genuinely needs key material fails loudly instead of writing rows nobody can decrypt.
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

const trimmed = (env: NodeJS.ProcessEnv, key: string): string => (env[key] ?? "").trim();

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = trimmed(env, key);
  if (v === "") throw new Error(`missing required env var ${key}`);
  return v;
}

/**
 * `OHMAIL_ORIGIN` → the canonical origin + the derived rpID, refused without echoing.
 *
 * The value must be a bare absolute origin — `https://mail.example.com`, or `http://localhost[:p]`
 * for the same-box run (http is a secure context only on loopback, and WebAuthn refuses it
 * anywhere else). The full ruleset — no path/query/credentials, DNS-named rpID, public-suffix
 * refusal — is `makeAuthConfig`'s own `assertOriginConfig`, the SAME validator the managed host
 * and the sidecar construct through. Its messages can embed the offending value, so every throw
 * from it is re-thrown here as a FIXED sentence naming only the variable and the rule.
 */
function loadOrigin(env: NodeJS.ProcessEnv): { origin: string; rpID: string; authConfig: AuthConfig } {
  const raw = requireEnv(env, "OHMAIL_ORIGIN");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OHMAIL_ORIGIN must be an absolute http(s) origin, e.g. https://mail.example.com");
  }
  if (url.username || url.password) throw new Error("OHMAIL_ORIGIN must not embed credentials");
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("OHMAIL_ORIGIN must be a bare origin — no path, query or fragment");
  }
  const rpID = url.hostname.toLowerCase();
  try {
    const authConfig = makeAuthConfig({
      rpID,
      origin: [url.origin],
      // No bootstrap invite set, EVER, on this composition: the first account is the boot-minted
      // setup token (routes/self-host.ts, obligation 3), and every later account is a pairing
      // invite. And no public signup, ever — there is no TF_PUBLIC_SIGNUP to set here.
      inviteCodes: new Set<string>(),
      publicSignup: false,
    });
    return { origin: url.origin, rpID, authConfig };
  } catch {
    // The underlying validator's message may quote the value (an origin can embed credentials in
    // the general case), so the refusal here is fixed text.
    throw new Error(
      "OHMAIL_ORIGIN is not usable as the auth origin: it must be a DNS-named https origin " +
      "(or loopback http for a same-box run) — IP literals and bare public suffixes cannot " +
      "back WebAuthn, and the hostname doubles as the passkey rpID",
    );
  }
}

/** Both, or neither. Half an SMTP block is a mailer that looks configured and sends nothing. */
function loadSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const url = trimmed(env, "SMTP_URL");
  const from = trimmed(env, "MAIL_FROM");
  if (url === "" && from === "") return null;
  if (url === "" || from === "") {
    throw new Error("SMTP is PARTIALLY configured: set both of SMTP_URL, MAIL_FROM or neither");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SMTP_URL must be a URL of the form smtp[s]://user:pass@host:port");
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") {
    throw new Error("SMTP_URL must use the smtp: or smtps: scheme");
  }
  return { url, from, replyTo: trimmed(env, "MAIL_REPLY_TO") || null };
}

const SUPABASE_STORAGE_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TF_ATTACHMENT_STAGING_BUCKET"] as const;
const S3_STORAGE_VARS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;

/**
 * Bucket names the staging bucket may NOT take: the reverse proxy's API prefixes
 * (`deploy/selfhost/Caddyfile`'s `@api` matcher, exactly). Browser uploads ride
 * `/<bucket>/*` on the ONE origin, and the proxy matches these segments FIRST — a bucket
 * named `api` would send every presigned PUT to the API server instead of the store: the
 * grant mints fine (presigning is local), and the upload fails one hop later with a status
 * nothing can explain. Refused at boot, where the message can name the rename that fixes it.
 */
const RESERVED_BUCKET_NAMES = new Set(["api", "auth", "events", "health", "hello", "pair", "internal"]);

/**
 * The storage block behind the env-KIND factory (Ruling 3): `TF_STORAGE_KIND` selects
 * `supabase` | `s3`, an UNKNOWN kind refuses at boot, and the selected kind's variables are
 * all-or-nothing. Storage variables present with NO kind refuse too — silently ignoring them
 * would be a deployment that looks configured and stages nothing.
 *
 * `origin` is `OHMAIL_ORIGIN`, already canonicalized: it is the s3 arm's default
 * `publicEndpoint`, because on the reference compose the store is reachable from a browser only
 * through the proxy's own origin. The variable itself is validated exactly as `S3_ENDPOINT` is
 * — an upload grant is LOCAL key derivation, so a malformed public endpoint would otherwise
 * surface one step late, as every browser upload failing.
 */
function loadStorageConfig(env: NodeJS.ProcessEnv, origin: string): StorageConfig | null {
  const kind = trimmed(env, "TF_STORAGE_KIND");
  const anySet = (vars: readonly string[]): string[] => vars.filter((v) => trimmed(env, v) !== "");
  if (kind === "") {
    // `S3_PUBLIC_ENDPOINT` is optional under the s3 kind but still a storage variable: set with
    // no kind it means the operator configured storage and the factory would ignore it.
    const stray = [...anySet(SUPABASE_STORAGE_VARS), ...anySet(S3_STORAGE_VARS), ...anySet(["S3_PUBLIC_ENDPOINT"])];
    if (stray.length > 0) {
      throw new Error(
        `storage variables are set but TF_STORAGE_KIND is not (set it to "supabase" or "s3"): ${stray.join(", ")}`,
      );
    }
    return null;
  }
  const requireAll = (vars: readonly string[]): void => {
    const missing = vars.filter((v) => trimmed(env, v) === "");
    if (missing.length > 0) {
      throw new Error(`TF_STORAGE_KIND=${kind} needs all of ${vars.join(", ")} — missing: ${missing.join(", ")}`);
    }
  };
  if (kind === "supabase") {
    requireAll(SUPABASE_STORAGE_VARS);
    const url = trimmed(env, "SUPABASE_URL").replace(/\/+$/, "");
    if (!/^https:\/\/[^/?#]+$/.test(url)) throw new Error("SUPABASE_URL must be a bare https origin");
    return {
      kind: "supabase",
      url,
      serviceKey: trimmed(env, "SUPABASE_SERVICE_ROLE_KEY"),
      bucket: trimmed(env, "TF_ATTACHMENT_STAGING_BUCKET"),
    };
  }
  if (kind === "s3") {
    requireAll(S3_STORAGE_VARS);
    // The endpoint is validated AT BOOT because a presign is local key derivation: a malformed
    // endpoint would otherwise arm the bag, `/hello` would advertise staging, and the FIRST MINT
    // would commit its ticket row (consuming quota) before URL construction finally rejected the
    // value — an error one step later than this process's contract allows, on every mint.
    const endpoint = trimmed(env, "S3_ENDPOINT");
    let endpointUrl: URL | null = null;
    try {
      endpointUrl = new URL(endpoint);
    } catch { /* refused below */ }
    if (!endpointUrl || (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:")
      || endpointUrl.hostname === "") {
      throw new Error("S3_ENDPOINT must be an absolute http(s) URL, e.g. http://minio:9000");
    }
    if (endpointUrl.username || endpointUrl.password) {
      throw new Error("S3_ENDPOINT must not embed credentials — they belong in S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    // OPTIONAL, defaulted to the one origin browsers already talk to — the reverse proxy's
    // `/<bucket>/*` route makes the bundled store reachable there, and the web app's CSP
    // allows nothing off-origin anyway. An explicit value serves non-browser clients only.
    const publicRaw = trimmed(env, "S3_PUBLIC_ENDPOINT");
    let publicEndpoint = origin;
    if (publicRaw !== "") {
      let publicUrl: URL | null = null;
      try {
        publicUrl = new URL(publicRaw);
      } catch { /* refused below */ }
      if (!publicUrl || (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:")
        || publicUrl.hostname === "") {
        throw new Error("S3_PUBLIC_ENDPOINT must be an absolute http(s) URL a browser can reach, e.g. https://mail.example.com");
      }
      if (publicUrl.username || publicUrl.password) {
        throw new Error("S3_PUBLIC_ENDPOINT must not embed credentials — it is handed to browsers verbatim");
      }
      publicEndpoint = publicRaw;
    }
    const bucket = trimmed(env, "S3_BUCKET");
    if (RESERVED_BUCKET_NAMES.has(bucket.toLowerCase())) {
      throw new Error(
        `S3_BUCKET must not be named "${bucket}" — browser uploads travel /<bucket>/* on this ` +
          "install's own origin, and that path prefix belongs to the API. Pick another bucket " +
          'name (the default is "ohmail-staging").',
      );
    }
    return {
      kind: "s3",
      endpoint,
      region: trimmed(env, "S3_REGION"),
      accessKeyId: trimmed(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: trimmed(env, "S3_SECRET_ACCESS_KEY"),
      bucket,
      publicEndpoint,
    };
  }
  throw new Error('TF_STORAGE_KIND must be "supabase" or "s3" (or unset for no object storage)');
}

/**
 * Build the whole configuration, or THROW with a message that names variables and no values.
 * A broken KEK is captured rather than thrown (see {@link poisonedKeyProvider}); everything
 * else refuses the boot, before any connection is opened.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const { origin, rpID, authConfig } = loadOrigin(env);

  const databaseUrl = requireEnv(env, "DATABASE_URL");
  // The one shape a self-host DATABASE_URL can be wrong in that nothing downstream would report
  // coherently: a transaction-mode pooler cannot hold the migrator's advisory lock semantics OR
  // the change-wake LISTEN. The reason strings are static and never quote the URL.
  const poolerReason = transactionPoolerReason(databaseUrl);
  if (poolerReason) throw new Error(`DATABASE_URL is unusable on this host: ${poolerReason}`);

  const portRaw = trimmed(env, "PORT");
  const port = portRaw === "" ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  let keyProvider: KeyProvider;
  let kek: KekEnvIdentity | null;
  let kekError: string | null = null;
  try {
    keyProvider = keyProviderFromEnv(env);
    const identity = kekEnvIdentity(env);
    if (!identity) throw new Error("TF_KEK_V1 is required on this host (it encrypts mailbox credentials at rest)");
    kek = identity;
  } catch (err) {
    kekError = err instanceof Error ? err.message : String(err);
    keyProvider = poisonedKeyProvider(kekError);
    kek = null;
  }

  const anthropicRaw = trimmed(env, "ANTHROPIC_API_KEY");

  const alertSecret = trimmed(env, "TF_ALERT_SECRET");

  return {
    origin,
    rpID,
    authConfig,
    cookieHosts: cookieHostsFor(origin),
    databaseUrl,
    port,
    keyProvider,
    kek,
    kekError,
    version: trimmed(env, "TF_BUILD_VERSION") || "dev",
    sse: SELF_HOST_SSE,
    smtp: loadSmtpConfig(env),
    storage: loadStorageConfig(env, origin),
    // Present ⇒ shaped like an Anthropic key or the boot refuses (the mistyped key would
    // otherwise present as a healthy host whose every draft says "try again later").
    anthropicApiKey: anthropicRaw === "" ? null : assertAnthropicKey(anthropicRaw),
    // The managed host's exact grammar: a short secret arms NOTHING (an endpoint whose
    // authentication is four characters is worse than no endpoint), and absence means the two
    // /internal/alerts routes answer 404.
    alerts: alertSecret.length >= 24
      ? { secret: alertSecret, webhookUrl: trimmed(env, "TF_ALERT_WEBHOOK_URL") || null }
      : null,
    // The SAME resolver the worker and the managed host call, so the three cannot accept
    // different variable sets (MS_OAUTH_* canonical, MICROSOFT_* aliases).
    msOAuth: msOAuthEnv(env),
    /**
     * The add-time IMAP/SMTP probe's SSRF gate. ENFORCING by default — this is a multi-user
     * server and the probe dials a host a signed-in family member typed, so private/loopback/
     * link-local targets and non-mail ports are refused before the socket opens, exactly as on
     * the managed host. `TF_PROBE_ALLOW_PRIVATE=1` (the exact string) relaxes it to ALLOW-ANY
     * for the install whose mail server legitimately lives on the LAN — an explicit operator
     * decision, because the absent value must select the strict branch.
     */
    probeAllowPrivate: trimmed(env, "TF_PROBE_ALLOW_PRIVATE") === "1",
    /**
     * The UnifiedPush wake endpoint's SSRF gate — `TF_PROBE_ALLOW_PRIVATE`'s sibling, and a
     * SEPARATE variable rather than a reuse of it, deliberately. The two answer different
     * questions: "may an interactive probe dial my LAN mail server, once, behind a step-up
     * session" and "may a background process POST to my LAN, unattended, for as long as a
     * registration lives". An operator who said yes to the first has not said yes to the second,
     * and one variable would have decided both.
     *
     * ENFORCING by default (https-only, public addresses only). `TF_PUSH_ALLOW_PRIVATE=1` — the
     * exact string — relaxes it for the install whose distributor is genuinely on the LAN (an
     * `ntfy` beside the server), which is the shape self-hosting is for. Absent selects strict,
     * because a security default nobody chose is not a default.
     */
    pushAllowPrivate: trimmed(env, "TF_PUSH_ALLOW_PRIVATE") === "1",
    environment: trimmed(env, "TF_ENV") || "production",
    bodyMaxBytes: BODY_MAX_BYTES,
    headersTimeoutMs: SERVER_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
  };
}
