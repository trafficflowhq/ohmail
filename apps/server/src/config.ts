import {
  KEK_RETIRED_ENV, keyProviderFromEnv, kekEnvIdentity, kekRetiredThroughFromEnv, msDeviceEnv,
  type KeyProvider, type KekEnvIdentity, type MicrosoftDeviceClient,
} from "@trafficflow/core";
import type { AiProviderEnv } from "@trafficflow/core/ai-provider-env";
import type { MsOAuthBootstrap } from "@trafficflow/db/cloud";
import { makeAuthConfig, normalizeRecipient, type AuthConfig } from "@trafficflow/services";
import { DEFAULT_SSE, type SseConfig, type BuildIdentitySource } from "@trafficflow/api";
import { parseTlsTerminatorList, parseTrustedProxyEntry, splitTrustedProxyList, type TlsTerminatorRefusal } from "./http.js";
import { loadSettings, type Settings, type SettingsDoorInput } from "./settings.js";

/**
 * THE SETTING BLOCKS OF A SELF-HOSTED SERVER — one long-running process an operator runs on their
 * own box, against their own Postgres, behind their own proxy — and the blocks every host reads
 * the same way (the pager's, object storage, build identity, the proxies). `settings.ts` calls each
 * once; the names an operator has in a `.env` are read here, under those names.
 *
 * Nothing is read from `process.env` at module scope: every reader is a pure function of an
 * environment object. A long-running process may simply REFUSE TO START on a misshapen value: a
 * crash-looping container with the reason on stderr is the operator-visible failure, and it happens
 * before the migrator touches anything. The one deliberate exception is the KEK (captured, poisoned
 * provider, `/health` 503s naming it), because a broken key ring must not hide the health endpoint
 * that reports it. `TF_KEK_RETIRED` is not that exception: it is a setting a self-hosted server does
 * not support yet, not a broken ring, so it refuses.
 *
 * EVERY refusal names the VARIABLE and NEVER echoes its value. No exceptions: an origin can embed
 * credentials, a connection string always does, and the pattern gets copied.
 *
 * {@link ServerConfig} and {@link loadServerConfig} are the settings under the flat names this
 * server's modules and tests have always read.
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

/** The cookie decision per request: one rule for every door (`cookie-auth.ts`). */
export { allowCookieAuthForRequest } from "./cookie-auth.js";

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

/** The SMTP block (`SMTP_URL` + `MAIL_FROM`, read with the mail setting in `settings.ts`). Absent ⇒
 *  mailer null, and the composition works: invites verify through the consumed token, not through mail. */
export interface SmtpConfig {
  /** `smtp://user:pass@host:port` or `smtps://…` — nodemailer's URL form. Never logged. */
  url: string;
  from: string;
  replyTo: string | null;
}

/** The API alert arm's secret and channels — parsed by {@link loadAlertsEnv}. */
export interface AlertsEnv {
  secret: string;
  webhookUrl: string | null;
  /** `TF_ALERT_EMAIL`: the one operator address the alert mail goes to, over {@link SmtpConfig}. */
  email: string | null;
  /** `TF_ALERT_TELEGRAM_BOT_TOKEN` + `TF_ALERT_TELEGRAM_CHAT_ID`; a half-set pair is the sink's to refuse. */
  telegram: { botToken: string | null; chatId: string | null };
  /** `TF_ALERT_HEARTBEAT_URL`: the dead-man GET after every completed pass (`alert-heartbeat.ts`). */
  heartbeatUrl: string | null;
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
  /** What every member below is read from (`settings.ts`); the one wiring reads this. */
  settings: Settings;
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
  /** Where {@link version} came from — the file the host bundler bakes, the variable, or none. */
  buildSource: BuildIdentitySource;
  /** Why {@link version} cannot be trusted as an identity, or null — see {@link buildIdentityError}. */
  buildError: string | null;
  sse: SseConfig;
  smtp: SmtpConfig | null;
  storage: StorageConfig | null;
  /** The operator's model (`aiProviderEnv`), or `null` for rules alone. */
  ai: AiProviderEnv | null;
  /** `TF_AI_TIMEOUT_MS`, or `null` for the per-call defaults in `deps.ts`. */
  aiTimeoutMs: number | null;
  /**
   * The API alert arm, armed by `TF_ALERT_SECRET` (24+ chars) alone: the intake routes and the
   * in-process pass (`alert-clock.ts`). Its channels use the organizer's spellings; `email` mails
   * through {@link smtp}, so it needs that block. `null` ⇒ the routes answer 404 and no pass runs.
   */
  alerts: AlertsEnv | null;
  msOAuth: MsOAuthBootstrap;
  /**
   * `MS_DEVICE_CLIENT_ID` (+ optional `MS_DEVICE_TENANT`) — the PUBLIC application the device-code
   * door runs as, or `null` when this install has not armed it.
   *
   * THIS IS THE VARIABLE THAT TURNS THE SECOND MICROSOFT DOOR ON, and it exists because the route
   * that reads it ships in the same change. It is not a fallback for {@link msOAuth} and is never
   * derived from it: a confidential application's client id is refused outright on the device grant
   * (that grant carries no secret, so Entra answers `unauthorized_client`), so an operator with
   * their own BYO registration has NOT thereby armed this door, and treating one as the other would
   * turn a complete, working registration into a device flow that always fails.
   *
   * `null` ⇒ `GET /mailboxes/oauth/microsoft/availability` reports `device: false`, the settings
   * pane offers nothing, and the two device routes answer 503 naming this variable. There is no
   * secret field, because a public registration has none.
   */
  msDevice: MicrosoftDeviceClient | null;
  /** `TF_PROBE_ALLOW_PRIVATE=1` — see {@link loadServerConfig}. Absent means ENFORCE. */
  probeAllowPrivate: boolean;
  /**
   * `TF_VAPID_PUBLIC_KEY` — the public half of this install's wake-signing keypair, or null.
   * Served to clients; never a secret. The PRIVATE half is the organizer's alone.
   */
  vapidPublicKey: string | null;
  /** `TF_PUSH_ALLOW_PRIVATE=1` — see {@link loadServerConfig}. Absent means ENFORCE. */
  pushAllowPrivate: boolean;
  /** `TF_TRUSTED_PROXIES` — see {@link loadTrustedProxies}. Empty means no peer's header is believed. */
  trustedProxies: readonly string[];
  /** Which front door the proxy runs, and its terminator list — see {@link loadTlsTerminator}. */
  externalDoor: ExternalDoor;
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
    deriveSubkey: () => fail(),
  };
}

export const trimmed = (env: NodeJS.ProcessEnv, key: string): string => (env[key] ?? "").trim();

/**
 * Why `TF_KEK_RETIRED` refuses the boot here. Cloud's hosts check at boot and on `/health` that no stored
 * secret still names a retired version; this one has neither check, so it takes no retirement at all.
 * The variable is named, never its value, and the advice keeps every key that may still be needed.
 */
export const KEK_RETIRED_REFUSED =
  `${KEK_RETIRED_ENV} is set, and a self-hosted server does not retire key versions yet: it cannot check that no ` +
  `stored secret still needs one. Unset ${KEK_RETIRED_ENV} and set again every TF_KEK_V<n> it retired; those keys ` +
  "still open what was sealed under them.";

/**
 * WHICH BUILD THIS IS — the worker's source order minus the platform arm (nothing hosts this
 * process): the `BUILD_VERSION` file `scripts/bundle-host.mjs` writes into the layout, then
 * `TF_BUILD_VERSION`, then `dev`. The file wins so a compose-override variable can no longer
 * silently outrank the identity baked into the image; the variable remains a fallback for a
 * bundle run outside the recipes, and is REPORTED as such (see {@link buildIdentityError}).
 * `file` is the door's reader of that file (`index.ts`): it needs `import.meta`, which the
 * function door's bundler cannot carry, so it is handed in and never defined here.
 */
export const buildIdentityOf = (
  env: NodeJS.ProcessEnv,
  file: () => string,
): { version: string; source: BuildIdentitySource } => {
  const fromFile = file().trim();
  if (fromFile) return { version: fromFile, source: "file" };
  const variable = trimmed(env, "TF_BUILD_VERSION");
  if (variable) return { version: variable, source: "variable" };
  return { version: "dev", source: "none" };
};

/**
 * Why the identity cannot be trusted, or null. One arm, unlike the managed host's and the
 * worker's: `"none"` is NOT reported here, because this process defaults `TF_ENV` to
 * `production` and an operator running from a working tree answers `dev` honestly — their
 * siblings' rule would darken every source run over a label. A variable-sourced label is the
 * hazard: it lives beside the process, not in it, and can name a build this one never was.
 */
export const buildIdentityError = (source: BuildIdentitySource): string | null =>
  source === "variable"
    ? "build identity came from TF_BUILD_VERSION, not from this build: the BUILD_VERSION file " +
      "is absent, so `version` names whatever the variable was last set to and may name a build " +
      "this process was never built from"
    : null;

export function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
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
export function loadOrigin(env: NodeJS.ProcessEnv): { origin: string; rpID: string; authConfig: AuthConfig } {
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

/**
 * `TF_TRUSTED_PROXIES`: the peers whose `x-forwarded-for` names the client — addresses, CIDRs and
 * host names, separated by commas or spaces. Unset or empty trusts no peer, the strict branch, and
 * there is no default here: the bundled compose names its own proxy. An address or CIDR that does
 * not parse refuses the boot, naming the entry's position and never its text. A host name never
 * does, because the proxy it names may start after this server.
 */
export function loadTrustedProxies(env: NodeJS.ProcessEnv): string[] {
  const entries = splitTrustedProxyList(trimmed(env, "TF_TRUSTED_PROXIES"));
  entries.forEach((entry, i) => {
    const parsed = parseTrustedProxyEntry(entry);
    if ("problem" in parsed) throw new Error(`TF_TRUSTED_PROXIES entry ${i + 1} is not usable: ${parsed.problem}`);
  });
  return entries;
}

/** The header the bundled proxy writes its own socket peer into (`deploy/selfhost/proxy/routes.caddy`). */
export const PROXY_PEER_HEADER = "x-ohmail-proxy-peer";

/** `forwarded_address_collapsed`: true for an untrusted peer, a terminator that sent no header, and 0.0.0.0/32. */
export const COLLAPSED_SENTENCE =
  "the proxy took no forwarded address from this peer, so every visitor arriving through it shares this one address; " +
  "if it is your terminator, name it in OHMAIL_TLS_TERMINATOR and have it set X-Forwarded-For";

/**
 * The proxy's front door. `tls`: the proxy terminates TLS and `OHMAIL_TLS_TERMINATOR` means nothing.
 * `external`: `OHMAIL_EXTERNAL_TLS` is non-empty (compose's `:+` test), and `raw` is the value as
 * written: the terminator list the proxy trusts, or {@link TLS_TERMINATOR_GATEWAY} (no `entries`),
 * which the proxy's entrypoint reads as its network's gateway.
 */
export type ExternalDoor = { door: "tls" } | { door: "external"; raw: string; entries: readonly string[] };

/** The one word `OHMAIL_TLS_TERMINATOR` may be, as the whole value: the proxy's own network gateway. */
export const TLS_TERMINATOR_GATEWAY = "gateway";

/** Unset on the external door; `deploy/selfhost/proxy/entrypoint.sh` refuses with the same sentence. */
export const TLS_TERMINATOR_UNSET_REFUSED =
  "OHMAIL_TLS_TERMINATOR is unset on the external door, so nothing says whose X-Forwarded-For to believe: " +
  "set it to gateway for a terminator on this box that sets that header (OHMAIL_BIND left at 127.0.0.1), " +
  "to your terminator's addresses or CIDRs separated by single spaces, or to 0.0.0.0/32 for a relay that adds none.";

/** What to write instead, per refused shape. The value itself is never echoed. */
const TLS_TERMINATOR_FIX: Record<TlsTerminatorRefusal, string> = {
  comma: "separates entries with a comma: separate them with single spaces — a comma stops the proxy",
  line: "spans more than one line: put the entries on one line, separated by single spaces",
  mapped: "is an IPv4 address written in IPv6 form: the proxy reads it as IPv6 and the api as IPv4 — write the IPv4 form",
  word: "is a word, not an address: a Caddy keyword such as private_ranges means something to the proxy and nothing to the api, and the proxy takes no host names — write addresses or CIDRs",
  whitespace: "uses whitespace other than single spaces between entries — write the entries on one line, separated by single spaces",
  malformed: "is not an address or a CIDR — write addresses or CIDRs separated by single spaces, or 0.0.0.0/32 to trust no terminator",
};

/**
 * `OHMAIL_EXTERNAL_TLS` and `OHMAIL_TLS_TERMINATOR`, the two values compose hands the proxy and
 * this server alike. The proxy decides whose `X-Forwarded-For` to believe; this server refuses to
 * start on a list the proxy would read differently ({@link parseTlsTerminatorList}), and on no value
 * at all, which the proxy refuses too: there is no default trust. On the TLS door the value is ignored.
 */
export function loadTlsTerminator(env: NodeJS.ProcessEnv): ExternalDoor {
  if ((env.OHMAIL_EXTERNAL_TLS ?? "") === "") return { door: "tls" };
  // UNTRIMMED: the proxy's entrypoint and Caddy read the value exactly as compose hands it over.
  const raw = env.OHMAIL_TLS_TERMINATOR ?? "";
  if (raw === TLS_TERMINATOR_GATEWAY) return { door: "external", raw, entries: [] };
  const parsed = parseTlsTerminatorList(raw);
  if (!parsed.ok) {
    const which = parsed.position > 0 ? `OHMAIL_TLS_TERMINATOR entry ${parsed.position}` : "OHMAIL_TLS_TERMINATOR";
    // Entries are single-space separated once a refusal names a position, so the split finds the one refused.
    if (parsed.refusal === "word" && raw.split(" ")[parsed.position - 1] === TLS_TERMINATOR_GATEWAY) {
      throw new Error(`${which} is gateway, which stands only as the whole value: in a list, write the gateway's address instead`);
    }
    throw new Error(`${which} ${TLS_TERMINATOR_FIX[parsed.refusal]}`);
  }
  if (parsed.entries.length === 0) throw new Error(TLS_TERMINATOR_UNSET_REFUSED);
  return { door: "external", raw, entries: parsed.entries };
}

/**
 * The API alert arm, or null. The managed host's grammar for the secret: a short one arms NOTHING
 * (an endpoint whose authentication is four characters is worse than no endpoint), and absence
 * means the `/internal/alerts` routes answer 404 and no pass runs here — the channels are then
 * not read. `TF_ALERT_EMAIL` mails through this server's SMTP block, so set without one, or not
 * one plain address, it refuses the boot: a mail arm that silently is not there, or refuses every
 * page, is a pager that looks configured and reaches nobody.
 */
export function loadAlertsEnv(env: NodeJS.ProcessEnv, hasMailer: boolean): AlertsEnv | null {
  const secret = trimmed(env, "TF_ALERT_SECRET");
  if (secret.length < 24) return null;
  const email = trimmed(env, "TF_ALERT_EMAIL") || null;
  if (email !== null && !hasMailer) {
    throw new Error(
      "TF_ALERT_EMAIL is set but this server has no mailer: set SMTP_URL (or RESEND_API_KEY) and MAIL_FROM, or unset TF_ALERT_EMAIL",
    );
  }
  if (email !== null && normalizeRecipient(email) === null) {
    throw new Error("TF_ALERT_EMAIL must be one plain email address — no display name, quotes or list");
  }
  return {
    secret,
    webhookUrl: trimmed(env, "TF_ALERT_WEBHOOK_URL") || null,
    email,
    telegram: {
      botToken: trimmed(env, "TF_ALERT_TELEGRAM_BOT_TOKEN") || null,
      chatId: trimmed(env, "TF_ALERT_TELEGRAM_CHAT_ID") || null,
    },
    heartbeatUrl: trimmed(env, "TF_ALERT_HEARTBEAT_URL") || null,
  };
}

const SUPABASE_STORAGE_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TF_ATTACHMENT_STAGING_BUCKET"] as const;
const S3_STORAGE_VARS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const;

/**
 * Bucket names the staging bucket may NOT take: the reverse proxy's API prefixes
 * (`deploy/selfhost/proxy/Caddyfile`'s `@api` matcher, exactly). Browser uploads ride
 * `/<bucket>/*` on the ONE origin, and the proxy matches these segments FIRST — a bucket
 * named `api` would send every presigned PUT to the API server instead of the store: the
 * grant mints fine (presigning is local), and the upload fails one hop later with a status
 * nothing can explain. Refused at boot, where the message can name the rename that fixes it.
 */
const RESERVED_BUCKET_NAMES = new Set(["api", "auth", "events", "health", "hello", "pair", "internal"]);

/** The `supabase` kind's block, once all three variables are known to be set. */
function supabaseStorage(env: NodeJS.ProcessEnv): StorageConfig {
  // A project ORIGIN, not a path: the client appends the storage paths.
  const url = trimmed(env, "SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[^/?#]+$/.test(url)) throw new Error("SUPABASE_URL must be a bare https origin");
  return {
    kind: "supabase",
    url,
    serviceKey: trimmed(env, "SUPABASE_SERVICE_ROLE_KEY"),
    bucket: trimmed(env, "TF_ATTACHMENT_STAGING_BUCKET"),
  };
}

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
export function loadStorageConfig(env: NodeJS.ProcessEnv, origin: string): StorageConfig | null {
  const kind = trimmed(env, "TF_STORAGE_KIND");
  const anySet = (vars: readonly string[]): string[] => vars.filter((v) => trimmed(env, v) !== "");
  if (kind === "") {
    // `S3_PUBLIC_ENDPOINT` is optional under the s3 kind but still a storage variable: set with
    // no kind it means the operator configured storage and the factory would ignore it.
    const stray = [...anySet(S3_STORAGE_VARS), ...anySet(["S3_PUBLIC_ENDPOINT"])];
    if (stray.length > 0) {
      throw new Error(
        `storage variables are set but TF_STORAGE_KIND is not (set it to "s3"): ${stray.join(", ")}`,
      );
    }
    // The three Supabase variables with no kind are the older spelling of `supabase`, which the
    // organizer reads the same way: all three is that kind, none is no storage, some refuses.
    const legacy = anySet(SUPABASE_STORAGE_VARS);
    if (legacy.length === 0) return null;
    if (legacy.length < SUPABASE_STORAGE_VARS.length) {
      throw new Error(
        `object storage is PARTIALLY configured: set all of ${SUPABASE_STORAGE_VARS.join(", ")} or none — set: ${legacy.join(", ")}`,
      );
    }
    return supabaseStorage(env);
  }
  const requireAll = (vars: readonly string[]): void => {
    const missing = vars.filter((v) => trimmed(env, v) === "");
    if (missing.length > 0) {
      throw new Error(`TF_STORAGE_KIND=${kind} needs all of ${vars.join(", ")} — missing: ${missing.join(", ")}`);
    }
  };
  if (kind === "supabase") {
    requireAll(SUPABASE_STORAGE_VARS);
    return supabaseStorage(env);
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
      throw new Error("S3_ENDPOINT must be an absolute http(s) URL, e.g. http://rustfs:9000");
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
 * The key ring, captured and never thrown: `/health` names a broken one. `retirement` is whether a
 * retired mark is read (and checked on `/health`) or refuses the start.
 */
export function loadKeyRing(env: NodeJS.ProcessEnv, retirement: "refused" | "read"): Settings["keyRing"] {
  // A self-hosted server retires no key version yet: thrown, so nothing starts on a partial ring.
  if (retirement === "refused" && trimmed(env, KEK_RETIRED_ENV) !== "") throw new Error(KEK_RETIRED_REFUSED);
  try {
    const provider = keyProviderFromEnv(env);
    const identity = kekEnvIdentity(env);
    if (!identity) throw new Error("TF_KEK_V1 is required on this host (it encrypts mailbox credentials at rest)");
    return { provider, identity, error: null, retiredThrough: retirement === "read" ? kekRetiredThroughFromEnv(env) : 0 };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { provider: poisonedKeyProvider(error), identity: null, error, retiredThrough: 0 };
  }
}

/**
 * The deployment's own label: `TF_ENV`, else what the door's host says, else `production`. It is
 * the first word of every alert and decides whether the managed invite bootstrap is refused.
 * Never an organizer identity (`resolveCloudInstallId` derives that).
 */
export function environmentOf(env: NodeJS.ProcessEnv, doorLabel: string | null): string {
  return trimmed(env, "TF_ENV") || (doorLabel ?? "").trim() || "production";
}

/**
 * The two private-network switches of a self-hosted server. Absent means ENFORCE on both.
 *
 * `TF_PROBE_ALLOW_PRIVATE=1` (the exact string) lets the add-time IMAP/SMTP probe dial a mail
 * server on the LAN; without it private, loopback and link-local targets and non-mail ports are
 * refused before the socket opens. `TF_PUSH_ALLOW_PRIVATE=1` lets a wake be POSTed to a
 * distributor on the LAN (an `ntfy` beside the server). Two variables on purpose: "may an
 * interactive probe dial my LAN mail server, once, behind a step-up session" and "may a background
 * process POST to my LAN, unattended, for as long as a registration lives" are different
 * questions, and one variable would have decided both.
 */
export function loadAllowances(env: NodeJS.ProcessEnv): { probeAllowPrivate: boolean; pushAllowPrivate: boolean } {
  return {
    probeAllowPrivate: trimmed(env, "TF_PROBE_ALLOW_PRIVATE") === "1",
    pushAllowPrivate: trimmed(env, "TF_PUSH_ALLOW_PRIVATE") === "1",
  };
}

/**
 * This install's VAPID **public** key, served by `GET /push/vapid-key`, or null. Never a secret.
 * `TF_VAPID_PRIVATE_KEY` is deliberately NOT read by the API: the organizer signs a wake, a
 * request handler never does.
 */
export function loadVapidPublicKey(env: NodeJS.ProcessEnv): string | null {
  return trimmed(env, "TF_VAPID_PUBLIC_KEY") || null;
}

/**
 * The PUBLIC client for the device-code door, through the one reader the organizer also calls:
 * the two processes must agree on the spelling, or an install arms the API's door and not the
 * refresh that keeps it alive.
 */
export function loadMsDevice(env: NodeJS.ProcessEnv): MicrosoftDeviceClient | null {
  return msDeviceEnv(env);
}

/** `"ohmail <no-reply@x>"` → `no-reply@x` — the bare address inside an RFC5322 display form. */
export const bareAddress = (from: string): string => {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
};

/** A process door with no build under it. */
const NO_BUILD: SettingsDoorInput = {
  door: "process", buildVersionFile: () => "", platformBuildId: null, release: null, environmentFallback: null,
  sseHolds: true, sseLifetimeMaxMs: null,
};

/**
 * {@link ServerConfig} for a self-hosted environment: the settings (`settings.ts`) under the flat
 * names this server's own modules and tests read. Nothing is read from the environment here.
 * `door` is what the process door hands in (`build-release.ts`); a caller that has none (a test
 * in a checkout, which is no build) reads the label from the variable or `dev` and states no release.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv, door: SettingsDoorInput = NO_BUILD): ServerConfig {
  return serverConfigOf(loadSettings(env, door));
}

export function serverConfigOf(settings: Settings): ServerConfig {
  const mail = settings.customerMail;
  return {
    settings,
    origin: settings.origin.appOrigin ?? "",
    rpID: settings.origin.rpID,
    authConfig: settings.origin.authConfig,
    cookieHosts: settings.origin.cookieHosts,
    databaseUrl: settings.database.url,
    port: settings.network.port,
    keyProvider: settings.keyRing.provider,
    kek: settings.keyRing.identity,
    kekError: settings.keyRing.error,
    version: settings.build.version,
    buildSource: settings.build.source,
    buildError: settings.build.error,
    sse: settings.sse,
    smtp: mail?.transport.kind === "smtp" ? { url: mail.transport.url, from: mail.from, replyTo: mail.replyTo } : null,
    storage: settings.storage,
    ai: settings.ai?.kind === "operator" ? settings.ai.env : null,
    aiTimeoutMs: settings.ai?.kind === "operator" ? settings.ai.timeoutMs : null,
    alerts: settings.alerts,
    msOAuth: settings.msOAuth,
    msDevice: settings.msDevice,
    probeAllowPrivate: settings.network.probeAllowPrivate,
    vapidPublicKey: settings.push.vapidPublicKey,
    pushAllowPrivate: settings.network.pushAllowPrivate,
    trustedProxies: settings.network.trustedProxies,
    externalDoor: settings.network.externalDoor,
    environment: settings.environment,
    bodyMaxBytes: BODY_MAX_BYTES,
    headersTimeoutMs: SERVER_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
  };
}
