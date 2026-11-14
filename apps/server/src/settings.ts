import {
  resolveCloudInstallId,
  type KeyProvider, type KekEnvIdentity, type MicrosoftDeviceClient,
} from "@trafficflow/core";
import { aiProviderEnv, type AiProviderEnv } from "@trafficflow/core/ai-provider-env";
import { transactionPoolerReason } from "@trafficflow/db";
import { msOAuthEnv, pgTransportReason, type MsOAuthBootstrap } from "@trafficflow/db/cloud";
import { makeAuthConfig, type AuthConfig } from "@trafficflow/services";
import { DEFAULT_SSE, type BuildIdentitySource, type SseConfig } from "@trafficflow/api";
import {
  DEFAULT_PORT, SELF_HOST_SSE, bareAddress, buildIdentityError, buildIdentityOf,
  cookieHostsFor, environmentOf, loadAlertsEnv, loadAllowances, loadKeyRing, loadMsDevice, loadOrigin,
  loadStorageConfig, loadTlsTerminator, loadTrustedProxies, loadVapidPublicKey, requireEnv, trimmed,
  type AlertsEnv, type ExternalDoor, type StorageConfig,
} from "./config.js";
import { chosenFor, type Chosen } from "./differences.js";
import {
  DEFAULT_APP_URL, DEFAULT_COOKIE_HOSTS, DEFAULT_ORIGINS, DEFAULT_RP_ID, DEFAULT_SSE_ENABLED, PROD_SSE_LIFETIME_MS,
  PROD_SSE_POLL_MS, appOriginOf, assertBootstrapInvites, assertCookieHosts, assertNoAiProviderChoice,
  assertNoStaleStripeEnv, assertPooledUrl, csv, loadAdminConfig, loadAnthropicKey, loadSseListenUrl,
  loadStaffDbConfig, publicSignupCap, type AdminHostConfig, type StaffDbConfig,
} from "./settings/managed.js";
import { parseServiceAddress, type ServiceAddress } from "./settings/service-address.js";

/**
 * THE SETTINGS OF THE ONE API PROGRAM: every setting it reads, read once, typed.
 *
 * {@link loadSettings} is a pure function of an environment object and of what its door hands in.
 * It throws a message that names variables and never a value; the one capture is the key ring,
 * because `/health` must come up to name a broken one.
 *
 * A configuration says which service it is by the name that leads it: `OHMAIL_ORIGIN` is a
 * self-hosted server, `DATABASE_URL_POOLED` is the managed service. Exactly one must be set
 * ({@link managedBy}). What follows from that is never asked of the lead again: every block that
 * reads differently on the two takes its side from a line of `DIFFERENCES` (`differences.ts`).
 * No platform's own variable is read here: what a platform knows reaches this module through
 * {@link SettingsDoorInput}, from the one file that is the door to that platform.
 * `docs/one-server.md` lists every setting with what a plain server sets.
 */

/** What the door that starts the program hands in. Every member is required: none has a default. */
export interface SettingsDoorInput {
  /** A long-running process, or a function a platform starts per request. */
  door: "process" | "function";
  /** Reads the `BUILD_VERSION` file built beside the program; `""` when there is none. */
  buildVersionFile: () => string;
  /** The hosting platform's own id for this build, or null where the host has none. */
  platformBuildId: string | null;
  /**
   * The release this door's build is of (`1.0.12`), as that build wrote it in, or null where none
   * did. Not the build label: that names a commit.
   */
  release: string | null;
  /**
   * The hosting platform's label for this deployment (`""` when it gave none), or null for a host
   * that has no such label. `TF_ENV` is read before it.
   */
  environmentFallback: string | null;
  /** Whether this door holds an `/events` stream open. */
  sseHolds: boolean;
  /** The longest an `/events` stream may be set to live, or null where only this program ends one. */
  sseLifetimeMaxMs: number | null;
}

/** Mail to customers: one setting, whichever transport the configuration names. */
export interface CustomerMail {
  transport: { kind: "smtp"; url: string } | { kind: "resend"; apiKey: string };
  from: string;
  replyTo: string | null;
  /** Where a mail's links point. `allowedOrigins` null means the mail service's own list. */
  links: {
    appUrl: string; siteUrl: string; adminUrl: string | null; supportEmail: string;
    allowedOrigins: string[] | null;
  };
}

export type DatabaseSettings =
  /** The operator's own Postgres: one pool this program owns, and the server migrates it. */
  | { kind: "owned"; url: string; listenUrl: string }
  /** The managed database through its pooler; `listenUrl` is a session connection that holds the LISTEN, or null. */
  | { kind: "pooled"; url: string; listenUrl: string | null };

export interface Settings {
  door: "process" | "function";
  /**
   * THE MARKER: this configuration is the managed service's (`DATABASE_URL_POOLED` leads it). Nothing
   * branches on it but `chosenFor` (`differences.ts`): ask a line of the list instead.
   */
  managed: boolean;
  /** `TF_ENV`, else the door's label, else `production`: the first word of every alert. */
  environment: string;
  origin: {
    /** The browser origin links and redirects use; null only when `TF_APP_URL` was refused. */
    appOrigin: string | null;
    rpID: string;
    cookieHosts: string[];
    authConfig: AuthConfig;
  };
  database: DatabaseSettings;
  keyRing: { provider: KeyProvider; identity: KekEnvIdentity | null; error: string | null; retiredThrough: number };
  /** `release` is what `GET /hello` states, null where the door's build stated none; `version` is `/health`'s label. */
  build: { version: string; source: BuildIdentitySource; error: string | null; release: string | null };
  sse: SseConfig;
  customerMail: CustomerMail | null;
  storage: StorageConfig | null;
  ai:
    | { kind: "metered-anthropic"; apiKey: string }
    | { kind: "operator"; env: AiProviderEnv; timeoutMs: number | null }
    | null;
  /** The entitlements program and its bearer, as a whole, or null: nothing is metered. */
  entitlements: { address: ServiceAddress; secret: string } | null;
  alerts: (AlertsEnv & { cronSecret: string | null }) | null;
  /** The platform scheduler's credential for the scheduled routes, or null. Managed only. */
  cronSecret: string | null;
  /** The staff door: its console credential and its content-blind connection. Null on a plain server. */
  staff: {
    admin: AdminHostConfig | null; adminError: string | null;
    db: StaffDbConfig | null; dbError: string | null;
  } | null;
  msOAuth: MsOAuthBootstrap;
  msDevice: MicrosoftDeviceClient | null;
  network: {
    port: number; trustedProxies: readonly string[]; externalDoor: ExternalDoor;
    probeAllowPrivate: boolean; pushAllowPrivate: boolean;
  };
  push: { vapidPublicKey: string | null };
  lifecycle: { connectReminder: "log" | "send"; connectReminderSince: string | null; connectAttempts: "off" | "record" };
  /** `TF_API_CLOCKS=1`: the passes a scheduler pokes run on this program's own clock. Off by default. */
  clocks: { inProcess: boolean };
  /** Who this deployment is to a mailbox it organizes (`resolveCloudInstallId`). */
  installId: string;
}

const present = (env: NodeJS.ProcessEnv, key: string): boolean => trimmed(env, key) !== "";

/** The two names that lead a configuration. */
export const PLAIN_LEAD = "OHMAIL_ORIGIN";
export const MANAGED_LEAD = "DATABASE_URL_POOLED";

/**
 * Names only the managed service reads and no self-hosted file carries. Beside `OHMAIL_ORIGIN`
 * each one says the configuration was meant for the managed service: read as a self-hosted server
 * it would migrate the database, meter nothing and ask no verified address, with the name ignored.
 */
export const MANAGED_ONLY_NAMES = [
  "TF_AUTH_ORIGINS", "TF_RP_ID", "TF_COOKIE_HOSTS", "DATABASE_URL_ADMIN", "TF_ADMIN_SECRET", "CRON_SECRET",
  "TF_PUBLIC_SIGNUP", "TF_INVITE_CODES",
] as const;

/**
 * Which service this configuration is, or a refusal. One lead, never both and never neither: a
 * configuration that lost its lead does not start as the other service, and one that carries the
 * managed service's names under the server's lead does not start as a self-hosted server.
 */
function managedBy(env: NodeJS.ProcessEnv): boolean {
  const plain = present(env, PLAIN_LEAD);
  const managed = present(env, MANAGED_LEAD);
  if (plain && managed) {
    throw new Error(
      `${PLAIN_LEAD} and ${MANAGED_LEAD} are both set: ${PLAIN_LEAD} is a self-hosted server's setting and ` +
        `${MANAGED_LEAD} the managed service's — one configuration is one of the two`,
    );
  }
  if (!plain && !managed) {
    throw new Error(
      `missing required env var ${PLAIN_LEAD} (a self-hosted server), or ${MANAGED_LEAD} (the managed service)`,
    );
  }
  const stray = plain ? MANAGED_ONLY_NAMES.filter((name) => present(env, name)) : [];
  if (stray.length > 0) {
    const many = stray.length > 1;
    throw new Error(
      `${stray.join(", ")} ${many ? "are" : "is"} set beside ${PLAIN_LEAD}: ${many ? "those are settings" : "that is a setting"} ` +
        `of the managed service, whose configuration ${MANAGED_LEAD} leads, and a self-hosted server would start with ` +
        `${many ? "them" : "it"} ignored — unset ${many ? "them" : "it"}, or lead with ${MANAGED_LEAD}`,
    );
  }
  return managed;
}

/**
 * The entitlements block, or null. The pair is one marker: `BILLING_PLANE_SECRET` present at all
 * (an emptied value included) without `ENTITLEMENTS_URL` is a managed deployment that would meter
 * nothing, and refuses; so does the address without its bearer. A self-hosted server sets neither.
 *
 * With neither, the managed service runs unmetered: every account then has unlimited mailboxes
 * and AI. That is a preview or a test, so what would cost refuses beside it: the service's own AI
 * key, and open sign-up. A deployment that lost both names does not start serving on them.
 */
function loadEntitlements(env: NodeJS.ProcessEnv, metering: Chosen["metering"]): Settings["entitlements"] {
  const raw = trimmed(env, "ENTITLEMENTS_URL");
  const secretSet = env.BILLING_PLANE_SECRET !== undefined;
  if (metering === "never") {
    if (raw !== "" || secretSet) {
      throw new Error(
        `${raw !== "" ? "ENTITLEMENTS_URL" : "BILLING_PLANE_SECRET"} is set beside ${PLAIN_LEAD}: it belongs to the ` +
          "managed service, and a self-hosted server meters nothing — unset it",
      );
    }
    return null;
  }
  if (raw === "") {
    if (secretSet) {
      throw new Error(
        "BILLING_PLANE_SECRET is set without ENTITLEMENTS_URL — a server beside the entitlements program meters " +
          "every AI action through it, and without the address would meter none: set ENTITLEMENTS_URL, or unset " +
          "BILLING_PLANE_SECRET",
      );
    }
    const costly = [
      ...(present(env, "ANTHROPIC_API_KEY") ? ["ANTHROPIC_API_KEY"] : []),
      ...(trimmed(env, "TF_PUBLIC_SIGNUP") === "1" ? ["TF_PUBLIC_SIGNUP"] : []),
    ];
    if (costly.length > 0) {
      const many = costly.length > 1;
      throw new Error(
        `${costly.join(", ")} ${many ? "are" : "is"} set without ENTITLEMENTS_URL and BILLING_PLANE_SECRET — with no ` +
          "entitlements program nothing limits an account's mailboxes or counts its AI, so the managed service " +
          `does not start with ${many ? "them" : "it"}: set the pair, or unset ${many ? "them" : "it"}`,
      );
    }
    return null;
  }
  const secret = trimmed(env, "BILLING_PLANE_SECRET");
  if (secret === "") {
    throw new Error(
      "ENTITLEMENTS_URL is set without BILLING_PLANE_SECRET, which is never a valid deployment: " +
        "the entitlements endpoints belong to that program, and its bearer is that secret.",
    );
  }
  if (secret.length < 24) throw new Error("BILLING_PLANE_SECRET must be at least 24 characters");
  return { address: parseServiceAddress("ENTITLEMENTS_URL", raw), secret };
}

/**
 * The listed origins: `TF_AUTH_ORIGINS` + `TF_RP_ID`, the compiled cookie hosts, `TF_APP_URL`, and
 * with them how later accounts arrive (the bootstrap invite set, open sign-up and its cap).
 */
function listedOrigins(env: NodeJS.ProcessEnv, environment: string): Settings["origin"] {
  const origins = csv(env.TF_AUTH_ORIGINS);
  // Read before the validator runs: each of these refuses in its own words.
  const inviteCodes = assertBootstrapInvites(env, environment);
  const cap = publicSignupCap(env);
  let authConfig: AuthConfig;
  try {
    // `makeAuthConfig` runs `assertOriginConfig`, so a bad rpID/origin pair is refused here and
    // never surprises a request.
    authConfig = makeAuthConfig({
      rpID: trimmed(env, "TF_RP_ID") || DEFAULT_RP_ID,
      origin: origins.length > 0 ? origins : DEFAULT_ORIGINS,
      inviteCodes,
      publicSignup: trimmed(env, "TF_PUBLIC_SIGNUP") === "1",
      publicSignupCap: cap,
    });
  } catch {
    // The validator quotes what it refused, and a value pasted here can carry a password: the
    // function door publishes a refused start on `/health`. Fixed text, as `loadOrigin` has it.
    throw new Error(
      "TF_AUTH_ORIGINS and TF_RP_ID are not usable as the auth origins: each origin must be a bare https " +
        "origin on a DNS name (or loopback http), and TF_RP_ID a bare host that every origin is, or is under",
    );
  }
  const cookieHosts = assertCookieHosts(csv(env.TF_COOKIE_HOSTS));
  return {
    // A refused TF_APP_URL is null: the OAuth bounce then falls back to the first auth origin.
    appOrigin: appOriginOf(env),
    rpID: authConfig.rpID,
    cookieHosts: cookieHosts.length > 0 ? cookieHosts : DEFAULT_COOKIE_HOSTS,
    authConfig,
  };
}

/** The one origin an operator names: its host is the passkey id and, with loopback, the only cookie host. */
function oneOrigin(env: NodeJS.ProcessEnv): Settings["origin"] {
  const { origin, rpID, authConfig } = loadOrigin(env);
  return { appOrigin: origin, rpID, cookieHosts: cookieHostsFor(origin), authConfig };
}

function ownedDatabase(env: NodeJS.ProcessEnv): DatabaseSettings {
  const url = requireEnv(env, "DATABASE_URL");
  // A transaction-mode pooler cannot hold the migrator's advisory lock or the change-wake LISTEN.
  // The reasons are static and never quote the URL.
  const reason = transactionPoolerReason(url) ?? pgTransportReason(url);
  if (reason) throw new Error(`DATABASE_URL is unusable on this host: ${reason}`);
  return { kind: "owned", url, listenUrl: url };
}

/**
 * Which build this is, and why that answer cannot be trusted, or null. The platform's id cannot
 * disagree with what runs; the file is an input to the build; `TF_BUILD_VERSION` is a label beside
 * it. The managed service refuses a production deployment that cannot say which build it is; a
 * self-hosted server reports only a label that came from the variable.
 */
function loadBuild(
  env: NodeJS.ProcessEnv, door: SettingsDoorInput, rule: Chosen["buildIdentity"], environment: string,
): Omit<Settings["build"], "release"> {
  const platform = door.platformBuildId?.trim();
  const id = platform
    ? { version: platform, source: "platform" as const }
    : buildIdentityOf(env, door.buildVersionFile);
  if (rule === "reported") return { ...id, error: buildIdentityError(id.source) };
  // A door with a platform label is production when the platform says so; one without, when the
  // operator's label does, which is `production` unless `TF_ENV` says otherwise.
  const production = door.environmentFallback === null
    ? environment === "production"
    : door.environmentFallback.trim() === "production";
  if (!production) return { ...id, error: null };
  if (id.source === "none" || id.version === "dev") {
    return {
      ...id,
      error: "no build identity: the BUILD_VERSION file is absent from this deployment and neither the " +
        "platform's build id nor TF_BUILD_VERSION is set",
    };
  }
  if (id.source === "variable") {
    return {
      ...id,
      error: "build identity came from TF_BUILD_VERSION, not from the deployment: the BUILD_VERSION file is " +
        "absent from this build, so `version` names whatever the variable was last set to and may name a " +
        "build this deployment was never built from",
    };
  }
  return { ...id, error: null };
}

/**
 * The `/events` block. `always`: served, at the self-hosted cadence, and no variable is read.
 * `behind-flag`: off unless `TF_SSE=1`, a slower poll, a lifetime the operator may set. Whether a
 * stream is held open is the door's, on both.
 */
function loadSse(env: NodeJS.ProcessEnv, door: SettingsDoorInput, events: Chosen["events"]): SseConfig {
  if (events === "always") return { ...SELF_HOST_SSE, ...(door.sseHolds ? {} : { holds: false }) };
  const pollMs = present(env, "TF_SSE_POLL_MS") ? Number(env.TF_SSE_POLL_MS) : PROD_SSE_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1_000) throw new Error("TF_SSE_POLL_MS must be an integer >= 1000");
  const lifetimeMs = present(env, "TF_SSE_LIFETIME_MS") ? Number(env.TF_SSE_LIFETIME_MS) : PROD_SSE_LIFETIME_MS;
  const max = door.sseLifetimeMaxMs;
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 5_000 || (max !== null && lifetimeMs > max)) {
    // The ceiling matters where a platform ends the invocation: the server must end the stream first.
    throw new Error(max === null
      ? "TF_SSE_LIFETIME_MS must be an integer >= 5000"
      : `TF_SSE_LIFETIME_MS must be an integer between 5000 and ${max}`);
  }
  return {
    ...DEFAULT_SSE, pollMs, lifetimeMs,
    enabled: trimmed(env, "TF_SSE") === "1" ? true : DEFAULT_SSE_ENABLED,
    holds: door.sseHolds,
  };
}

/**
 * Mail to customers: `SMTP_URL` or `RESEND_API_KEY`, with `MAIL_FROM`. Neither is no mailer, which
 * is a working configuration; half a block, or both transports, refuses.
 */
function loadCustomerMail(env: NodeJS.ProcessEnv, theOrigin: string | null): CustomerMail | null {
  const smtpUrl = trimmed(env, "SMTP_URL");
  const resendKey = trimmed(env, "RESEND_API_KEY");
  const from = trimmed(env, "MAIL_FROM");
  if (smtpUrl !== "" && resendKey !== "") {
    throw new Error("SMTP_URL and RESEND_API_KEY are both set: mail to customers goes one way — unset one");
  }
  if (smtpUrl === "" && resendKey === "") {
    if (from === "") return null;
    throw new Error("mail is PARTIALLY configured: MAIL_FROM is set without SMTP_URL (or RESEND_API_KEY) — set both or neither");
  }
  if (from === "") {
    throw new Error(`mail is PARTIALLY configured: set both of ${smtpUrl !== "" ? "SMTP_URL" : "RESEND_API_KEY"}, MAIL_FROM or neither`);
  }
  if (smtpUrl !== "") {
    let parsed: URL;
    try {
      parsed = new URL(smtpUrl);
    } catch {
      throw new Error("SMTP_URL must be a URL of the form smtp[s]://user:pass@host:port");
    }
    if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") {
      throw new Error("SMTP_URL must use the smtp: or smtps: scheme");
    }
  }
  const replyTo = trimmed(env, "MAIL_REPLY_TO") || null;
  return {
    transport: smtpUrl !== "" ? { kind: "smtp", url: smtpUrl } : { kind: "resend", apiKey: resendKey },
    from,
    replyTo,
    links: theOrigin !== null
      // One origin is the whole of a self-hosted server: every link names it, and it is the only
      // permitted link base.
      ? {
        appUrl: theOrigin, siteUrl: theOrigin, adminUrl: null,
        supportEmail: replyTo ?? bareAddress(from), allowedOrigins: [theOrigin],
      }
      : {
        appUrl: trimmed(env, "MAIL_APP_URL") || DEFAULT_APP_URL,
        siteUrl: trimmed(env, "MAIL_SITE_URL") || "https://ohmail.app",
        adminUrl: trimmed(env, "TF_ADMIN_URL") || "https://admin.ohmail.app",
        supportEmail: trimmed(env, "MAIL_SUPPORT_EMAIL") || "support@ohmail.app",
        allowedOrigins: null,
      },
  };
}

const atLeast24 = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const raw = trimmed(env, key);
  return raw.length >= 24 ? raw : null;
};

/** `TF_API_CLOCKS=1`, and what it needs: the routes it drives are armed, and one copy can lead. */
function loadClocks(
  env: NodeJS.ProcessEnv, door: SettingsDoorInput, alerts: Settings["alerts"], database: DatabaseSettings,
): Settings["clocks"] {
  if (trimmed(env, "TF_API_CLOCKS") !== "1") return { inProcess: false };
  if (door.door === "function") {
    throw new Error("TF_API_CLOCKS is set on a host that runs per request: it keeps no clock — unset it");
  }
  if (alerts === null) {
    throw new Error("TF_API_CLOCKS needs TF_ALERT_SECRET (24+ characters): the passes it drives are armed by it");
  }
  if (database.listenUrl === null) {
    throw new Error("TF_API_CLOCKS needs DATABASE_URL_SESSION: one copy leads the clocks, on a session it holds");
  }
  return { inProcess: true };
}

export function loadSettings(env: NodeJS.ProcessEnv, door: SettingsDoorInput): Settings {
  const managed = managedBy(env);
  // Everything below that differs between the two services asks a line of the list, never the lead.
  const chosen = chosenFor(managed);
  const environment = environmentOf(env, door.environmentFallback);

  // How later accounts arrive (`signup`) is read with the listed origins: one origin has pairing
  // invites and nothing to configure.
  const origin = chosen.origin === "one-origin" ? oneOrigin(env) : listedOrigins(env, environment);

  const database: DatabaseSettings = chosen.database === "owned"
    ? ownedDatabase(env)
    : { kind: "pooled", url: assertPooledUrl(requireEnv(env, MANAGED_LEAD)), listenUrl: loadSseListenUrl(env) };

  const portRaw = trimmed(env, "PORT");
  const port = portRaw === "" ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const keyRing = loadKeyRing(env, chosen.keyRetirement);
  const customerMail = loadCustomerMail(env, chosen.mailLinks === "the-origin" ? origin.appOrigin : null);

  // A leftover payments variable is a refused start where no payments code may be near.
  if (chosen.paymentVariables === "refused") assertNoStaleStripeEnv(env);
  let ai: Settings["ai"];
  if (chosen.ai === "metered") {
    // The provider choice is the operator's of a self-hosted server: here it refuses.
    assertNoAiProviderChoice(env);
    const apiKey = loadAnthropicKey(env);
    ai = apiKey === null ? null : { kind: "metered-anthropic", apiKey };
  } else {
    // The worker's rule for the same variable: a non-negative integer, never echoed.
    const timeoutRaw = trimmed(env, "TF_AI_TIMEOUT_MS");
    const timeoutMs = timeoutRaw === "" ? null : Number(timeoutRaw);
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
      throw new Error("TF_AI_TIMEOUT_MS must be a non-negative integer of milliseconds");
    }
    const operator = aiProviderEnv(env);
    ai = operator === null ? null : { kind: "operator", env: operator, timeoutMs };
  }

  // The credential of the scheduler that pokes the passes, where one does.
  const cronSecret = chosen.sendClock === "poked" ? atLeast24(env, "CRON_SECRET") : null;
  const alertsEnv = loadAlertsEnv(env, customerMail !== null);
  const alerts = alertsEnv === null ? null : { ...alertsEnv, cronSecret };

  const allowances = loadAllowances(env);
  const staffed = chosen.staffDoor === "blind-role";
  const staffDb = staffed ? loadStaffDbConfig(env) : null;
  const admin = staffed ? loadAdminConfig(env) : null;
  const dials = chosen.privateDials === "operator-switch";

  return {
    door: door.door,
    managed,
    environment,
    origin,
    database,
    keyRing,
    // A blank release is none: `/hello` must never state an empty one.
    build: { ...loadBuild(env, door, chosen.buildIdentity, environment), release: door.release?.trim() || null },
    sse: loadSse(env, door, chosen.events),
    customerMail,
    storage: loadStorageConfig(env, origin.appOrigin ?? DEFAULT_APP_URL),
    ai,
    entitlements: loadEntitlements(env, chosen.metering),
    alerts,
    cronSecret,
    staff: staffDb && admin
      ? { admin: admin.admin, adminError: admin.unarmed, db: staffDb.staffDb, dbError: staffDb.refusal }
      : null,
    // One resolver for the worker and both services, so they cannot accept different variable
    // sets (MS_OAUTH_* canonical, MICROSOFT_* aliases).
    msOAuth: msOAuthEnv(env),
    msDevice: chosen.deviceCodeDoor ? loadMsDevice(env) : null,
    network: {
      port,
      trustedProxies: loadTrustedProxies(env),
      externalDoor: loadTlsTerminator(env),
      // A self-hosted server's two switches. The managed service never dials a private address,
      // whatever its environment holds: both read false there.
      probeAllowPrivate: dials && allowances.probeAllowPrivate,
      pushAllowPrivate: dials && allowances.pushAllowPrivate,
    },
    push: { vapidPublicKey: loadVapidPublicKey(env) },
    lifecycle: {
      // Customer mail ships log-only: a mistyped value logs, it never sends.
      connectReminder: chosen.funnel && trimmed(env, "TF_CONNECT_REMINDER") === "send" ? "send" : "log",
      connectReminderSince: chosen.funnel ? trimmed(env, "TF_CONNECT_REMINDER_SINCE") || null : null,
      // Records only on the exact word, as the reminder sends only on its own.
      connectAttempts: chosen.funnel && trimmed(env, "TF_CONNECT_ATTEMPTS") === "record" ? "record" : "off",
    },
    clocks: loadClocks(env, door, alerts, database),
    installId: resolveCloudInstallId(env),
  };
}

/** Which build this is, for a door that must answer before its settings loaded. Never throws. */
export function buildVersionOf(env: NodeJS.ProcessEnv, door: SettingsDoorInput): string {
  return door.platformBuildId?.trim() || buildIdentityOf(env, door.buildVersionFile).version;
}

/* The managed blocks and the cookie rule, for the function door's own names (`apps/api-vercel`). */
export * from "./settings/managed.js";
export { allowCookieAuthFor, allowCookieAuthForRequest, assertedHosts } from "./cookie-auth.js";
export { isPrivateServiceName, parseServiceAddress, type ServiceAddress, type ServiceTransport } from "./settings/service-address.js";
