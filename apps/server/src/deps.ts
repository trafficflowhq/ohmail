import {
  users, providerFamily, UNMETERED, UNMETERED_ACCESS, accessOf, isMetered, pricingOf, parkedAccountsOf,
  type AccessPort, type AiPricingMarker, type EntitlementsComposition, type ParkedAccountsReader,
  type SpendPort, type Tx,
} from "@trafficflow/db";
import type { AccountsAtCapReader, PlaneOpsReader, RetiredKekReferences } from "@trafficflow/db/cloud";
import {
  HOSTED_IMAP_ADMISSION, webhookAlertSink, telegramAlertSink, refusingAlertSink,
  recordApiFault, entitlementsFaultRecorder, accountsAtCapOf, planeOpsReaderOf, ALERT_PARKED_READ_BOUND,
  resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER,
  makeSupabaseStagingStorage, makeS3StagingStorage,
  // The organizer's last completed pass, for the filing strip (mail 0097).
  organizerCycleReader,
  acquireCeilingHandle, SESSION_ACQUIRE_TIMEOUT_MS, makePooledDb, readDbTls, alertHeartbeatFor,
  makeEntitlementsClient, refundObligationsOn, heldStorageLimitOf, freshConnectProbe,
  kekRetiredReferences, retiredVersionInUseFault, retiredVersionUnreadFault,
  adminDbFor, attestStaffDbFault,
  type AdminDb, type AlertHeartbeat, type AlertSink, type AttachmentStagingStorage,
  type EntitlementsClient, type FreshConnectReading,
} from "@trafficflow/db/cloud";
import {
  makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  MicrosoftTokenProvider, UNMETERED_STORAGE_CAP,
  type AnthropicCallReport, type ClassifierPort, type DraftPort, type FetchLike, type Logger,
  type UpdateSecretPort,
} from "@trafficflow/core";
import { portsOf, transportFor, type AiProviderEnv } from "@trafficflow/core/ai-provider-env";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { makePushEndpointGuard } from "@trafficflow/core/net";
import {
  makeAuthService, makeMailboxService, makeScreenerService, makeApprovalService,
  makePrivacyService, makeUnsubscribeService, nodeOneClickPost,
  nodeRemoteFetch, nodeHostResolver, scryptHasher,
  syncService, makePushService, rulesService, messageService, threadService, triageService,
  searchService, contactsService, snippetsService, notifyRulesService, awayResponderService,
  attachmentsService, kbService, tagsService, draftsService, makeDraftingService, sendService,
  FolderOpsService, scheduleService, keepScheduledFilesSealed,
  workflowsService, proposalsService, redeemInviteGrant,
  makeAttachmentStagingPort, MailService, SmtpMailer, ResendMailer, mailAlertSink, dbFreeMailAlertSink,
  dbRecipientLimiter, makeWaitlistService, throttleKeysFor, liveBodyAdmitter,
  type ServiceContext,
} from "@trafficflow/services";
// The policy TYPE lives on the mail entry (the sidecar imports it there too); the full barrel
// above is still loaded by this app — which is exactly why the explicit allowance below exists.
import type { MailboxAllowancePolicy } from "@trafficflow/services/mail";
import type { PairingTokenMinted } from "@trafficflow/services";
import {
  makeProbeHostGuard, ALLOW_ANY_PROBE_HOST, apiAlertSinkSummary, API_FAULT_RECORD_BUDGET_MS,
  staffSigningKeyOf, nodeMailDns, connectAttemptRecorder,
} from "@trafficflow/api";
import type { ApiDeps, ApiServices, ChangeWakeHub } from "@trafficflow/api";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";
import { allowCookieAuthForRequest } from "./cookie-auth.js";
import {
  serverConfigOf, BODY_MAX_BYTES, SELF_HOST_SEND_MAX_TOTAL_BYTES,
  type ServerConfig, type StorageConfig,
} from "./config.js";
import { wiringOf, type Wiring } from "./differences.js";
import type { CustomerMail } from "./settings.js";
import { privateNetworkFetch } from "./settings/private-network-fetch.js";
import { ensureSetupTokenInvariant } from "./setup-token.js";

/**
 * THE ONE WIRING: the service bag and the per-request {@link ApiDeps} of the API program, for the
 * managed service and for a self-hosted server, behind either door.
 *
 * Two lifetimes. Everything with the program's lifetime — the bag, the database port, the wake
 * hub, the token provider, the pager's arms — is a {@link Runtime}, built once by `program.ts`.
 * Per request only `session`, `requestId`, `idempotency` and the cookie decision vary.
 *
 * What the managed service does differently is taken from `cfg.chosen` (`differences.ts`), one
 * member per line of that list; `cfg` has no marker to ask. What a function does differently from
 * a long-running process is {@link DoorInput}, and every member of it is required.
 */

type Db = PostgresJsDatabase<typeof schema>;

/** What the door that serves the program hands in. No member has a default. */
export interface DoorInput {
  logger: Logger;
  /** The largest request body the door's transport delivers: the ceiling of the one inline-attachment route. */
  bodyMaxBytes: number;
  /** The send surface's ceiling in raw attachment bytes, derived from {@link bodyMaxBytes}. */
  sendSurfaceMaxTotalBytes: number;
  /** How long one request may run before its host ends it, or null for a process nothing ends. */
  invocationBudgetMs: number | null;
  /** Build the costly services on first use (a function's cold start) or before the first request. */
  lazyServices: boolean;
  /** End the connection after an answer that left request bytes unread (the node adapter needs it). */
  closeUndrained: boolean;
  /** Hands work that outlives an answer to the host, which freezes a function once it answers; or null. */
  afterAnswer: ((work: Promise<unknown>) => void) | null;
  /** Where a first-run setup token minted while serving is printed. */
  onSetupTokenMinted: (minted: PairingTokenMinted) => void;
}

/** The database as the program holds it: one owned pool, or the module-cached pooled handle. */
export interface DbPort {
  /** The handle a request runs on. */
  request(): Db;
  /** The same pool behind the session doors' short wait to begin (`withSessionAcquireCeiling`). */
  session(): Db;
  /** A handle that waits `ms` at most to begin: for a write made after something already failed. */
  brief(ms: number): Db;
  /** `/health`'s question whether a NEW connection is admitted, where a pooler can refuse one. */
  freshConnect: (() => Promise<FreshConnectReading>) | null;
}

/**
 * The two session doors' handle (`withSessionAcquireCeiling`): the process pool behind a 5 s wait
 * to begin, the managed host's number. One per pool, built on the first session request.
 */
const sessionHandles = new WeakMap<Db, Db>();

/** One pool this program owns: a request, a session door and a fault write all ride it. */
export function ownedDbPort(db: Db): DbPort {
  return {
    request: () => db,
    session: () => {
      let handle = sessionHandles.get(db);
      if (!handle) {
        handle = acquireCeilingHandle(db, SESSION_ACQUIRE_TIMEOUT_MS);
        sessionHandles.set(db, handle);
      }
      return handle;
    },
    // One session-capable pool per process: nothing to re-acquire.
    brief: () => db,
    freshConnect: null,
  };
}

/** `/health`'s fresh-connection probe, one per connection string, so its memo is the instance's. */
const freshProbes = new Map<string, () => Promise<FreshConnectReading>>();

/**
 * The pooled handle. `makePooledDb` is module-cached per connection string, so every call here is
 * the same pool and nothing is held: a ceiling is a property of the HANDLE, and costs no connection.
 */
export function pooledDbPort(url: string): DbPort {
  let probe = freshProbes.get(url);
  if (!probe) {
    probe = freshConnectProbe(url);
    freshProbes.set(url, probe);
  }
  return {
    request: () => makePooledDb(url),
    session: () => makePooledDb(url, { acquireTimeoutMs: SESSION_ACQUIRE_TIMEOUT_MS }),
    // A FRESH handle with a short ceiling: the branch answering `503 db_busy` is the one whose
    // handle just refused an acquire, and an abandoned write must not queue in front of the next request.
    brief: (ms) => makePooledDb(url, { acquireTimeoutMs: ms }),
    freshConnect: probe,
  };
}

/**
 * **THE UNMETERED MAILBOX ALLOWANCE, stated where the OBLIGATION is lodged.**
 *
 * `routes/self-host.ts` obligation 1: this app loads the full `@trafficflow/services` barrel
 * (auth and erasure need it), and LOADING THAT BARREL registers the hosted PAID gate as the
 * process-wide default allowance. This explicit `allowance:` argument to `makeMailboxService`
 * below is therefore the only thing between a self-host boot and `POST /mailboxes` refusing
 * every mailbox with a subscription error on a server that has no subscriptions — a defect
 * class this product has shipped once already, one composition over. The boot-ceremony pg test
 * adds TWO mailboxes with zero billing env and shows the reverted-to-default composition red.
 *
 * It lives HERE, in the app, following the sidecar's design without importing it
 * (`UNMETERED_MAILBOX_ALLOWANCE`, apps/sidecar/src/engine.ts): the hosted API must have no name
 * for a permissive policy, so none is exported from `@trafficflow/services` and none is imported
 * across apps. What still gates a mailbox is everything that is not about money: the
 * active-address unique index, the IMAP probe, the admission counter, and the organizer lease.
 */
export const SELF_HOST_MAILBOX_ALLOWANCE: MailboxAllowancePolicy = async () => {
  /* No plan, no count, no lock. The operator pays for their own box; the limit is their disk. */
};

/**
 * THE ENV-KIND FACTORY over the two staging-storage implementations (Ruling 3): `supabase`
 * selects the managed host's client verbatim, `s3` the SigV4 client RustFS and AWS both speak.
 * The switch is EXHAUSTIVE over {@link StorageConfig} — an unknown kind cannot reach here at all,
 * because `loadStorageConfig` already refused it at boot (config.test.ts pins that refusal), and
 * a kind added to the union without an arm here is a compile error, not a runtime surprise.
 *
 * `fetchImpl` is the same injection seam both implementations already expose, threaded through
 * so the factory test can PROVE which arm it armed by watching the wire instead of trusting a
 * label. Production passes nothing.
 */
export function stagingStorageFor(
  storage: StorageConfig, fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  switch (storage.kind) {
    case "supabase":
      return makeSupabaseStagingStorage(
        { url: storage.url, serviceKey: storage.serviceKey, bucket: storage.bucket }, fetchImpl,
      );
    case "s3":
      return makeS3StagingStorage({
        endpoint: storage.endpoint,
        region: storage.region,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
        bucket: storage.bucket,
        // The browser-facing half of the split (S3_PUBLIC_ENDPOINT, default OHMAIL_ORIGIN):
        // upload grants alone are addressed — and therefore SigV4-signed — against it.
        publicEndpoint: storage.publicEndpoint,
      }, fetchImpl);
  }
}

/**
 * The `MailService` over the configured transport: the customer instance, or with `operatorEmail`
 * the pager's mail arm. One construction, two instances — sharing one object would put two threat
 * models in one configuration. Throws on an unusable block (its callers' contracts differ).
 */
function mailServiceFor(cfg: Wiring, mail: CustomerMail, operatorEmail?: string): MailService {
  const mailer = mail.transport.kind === "smtp"
    ? new SmtpMailer({ url: mail.transport.url, from: mail.from, replyTo: mail.replyTo ?? undefined })
    : new ResendMailer({ apiKey: mail.transport.apiKey, from: mail.from, replyTo: mail.replyTo ?? undefined });
  return new MailService({
    mailer,
    config: {
      appUrl: mail.links.appUrl,
      siteUrl: mail.links.siteUrl,
      ...(mail.links.adminUrl ? { adminUrl: mail.links.adminUrl } : {}),
      supportEmail: mail.links.supportEmail,
      // A self-hosted origin must be NAMED as a permitted link base: the default list is the
      // managed product's own origins, and "mail links wherever an env var points" must stay a
      // property nobody acquires by accident (mail-service.ts states the rule).
      ...(mail.links.allowedOrigins ? { allowedOrigins: mail.links.allowedOrigins } : {}),
      ...(operatorEmail ? { operatorEmail } : {}),
    },
    // The recipient slots' keyer, on the key ring this program runs with; the pager's slot needs none.
    throttleKeys: throttleKeysFor(cfg.keyRing.provider),
  });
}

/**
 * The `MailService` customer mail goes through, or `null` with no mail setting, which is a WORKING
 * configuration: a pairing invite never needs mail, and open sign-up refuses 503 without a mailer.
 * No `operatorEmail`: this instance must not be able to mail the pager.
 *
 * An unusable block refuses where a refusal is the visible failure and costs nothing else: a
 * process that has not started. A function builds this on the path of a request, where a throw
 * would cost the deployment its availability over its outbound mail; there it is logged and null.
 * Every message is a fixed sentence: a mail setting embeds a credential.
 */
export function customerMailFor(cfg: Wiring, logger: Logger): MailService | null {
  const mail = cfg.customerMail;
  if (!mail) return null;
  try {
    return mailServiceFor(cfg, mail);
  } catch (err) {
    if (cfg.door === "process") {
      throw new Error(
        mail.transport.kind === "smtp"
          ? `SMTP is configured but not usable — check SMTP_URL and MAIL_FROM: ${err instanceof Error ? err.message : String(err)}`
          : `mail is configured but not usable — check RESEND_API_KEY and MAIL_FROM: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.error("customer_mailer_unavailable", {
      err, reason: "transactional mail is disabled on this deployment; signups are still recorded",
    });
    return null;
  }
}

/** The parts of a {@link Runtime} the bag is built from. */
export interface BagParts {
  db: DbPort;
  logger: Logger;
  billing: BillingTransport;
  /** The one customer mailer of the program, built once. */
  customerMail: () => MailService | null;
}

/** Everything with the program's lifetime, built once by `program.ts` and handed to every request. */
export interface Runtime {
  cfg: Wiring;
  door: DoorInput;
  db: DbPort;
  services: ApiServices;
  /** ONE LISTEN for the program, fanned out per account; null where no stream is held. */
  changeWake: () => ChangeWakeHub | null;
  /** One long-lived token provider — see {@link oauthProvider}. */
  oauth: MicrosoftTokenProvider;
  logger: Logger;
  /** The pager's arms ({@link pagerArms}), built once: the routes and the clock share them. */
  alertSinks: AlertSink[];
  /** The last-resort page's arms: the same arms, the mail one database-free. */
  alertLastResortSinks: AlertSink[];
  /** `TF_ALERT_HEARTBEAT_URL`, built once ({@link alertHeartbeat}). Absent: off. */
  alertHeartbeat?: AlertHeartbeat;
  /**
   * The handle the alert pass runs on where the server has one role and no content-blind one
   * (`AlertsConfig.db`). Null where the staff door's role carries the pass, and where a test stubs it
   * absent — `/health` then names `alertsFault`, as the routes answer 503.
   */
  alertDb: (() => Promise<Tx>) | null;
  alertReaders: AlertReaders;
  /** The staff door's content-blind handle, or null. */
  staffDb: (() => Promise<AdminDb>) | null;
  customerMail: () => MailService | null;
  /** The entitlements client's transport, written where the client is composed; null until then, and with none. */
  billing: BillingTransport;
}

export interface BillingTransport { transport: "https" | "http-private" | null }

/**
 * Turn one bag entry into a lazy, memoised getter. Two services are expensive to build:
 * `makeAuthService` runs scrypt over a decoy password on construction, and building
 * everything eagerly made a bare `GET /health` pay that warm-up on every cold start. The
 * getter memoises on first access, so the decoy hash is still computed once per hasher and
 * shared by every later request on this instance — the same single construction, deferred.
 * Rebuilding per request is what makes the unknown-email path a timing oracle.
 */
function lazily<T>(bag: Record<string, unknown>, name: string, build: () => T): void {
  let built: { value: T } | null = null;
  Object.defineProperty(bag, name, {
    enumerable: true,
    configurable: true,
    get(): T {
      if (!built) built = { value: build() };
      return built.value;
    },
  });
}

/** The same entry, built now: a long-running process pays every warm-up before it listens. */
function eagerly<T>(bag: Record<string, unknown>, name: string, build: () => T): void {
  bag[name] = build();
}

/** This program on every usage line: a literal, never read from the environment, so the entitlements
 *  program's per-host figure cannot be written under two names. */
const USAGE_HOST = "api" as const;

/** The entitlements program's client, or `UNMETERED`. The transport it rides is written to `parts.billing`. */
function composeEntitlements(
  cfg: Wiring, door: DoorInput, parts: BagParts,
): EntitlementsComposition {
  // A self-hosted server meters nothing, stated: no plan, no limit, no manage page.
  if (cfg.chosen.metering === "never" || !cfg.entitlements) return UNMETERED;
  const { address, secret } = cfg.entitlements;
  parts.billing.transport = address.transport;
  return makeEntitlementsClient({
    baseUrl: address.origin,
    secret,
    /*
     * WHERE A CREDIT-CHECK OUTAGE GOES TO BE COUNTED (cloud 0033): the one recorder the worker
     * uses too, arm `api`, one row per call under a synthetic route. A handle with the 5xx
     * recorder's short acquire ceiling, so an abandoned insert never sits in front of the next
     * request. Awaited by the client; a failed write is a warn line, never the customer's error.
     */
    onCallFault: entitlementsFaultRecorder(
      () => parts.db.brief(API_FAULT_RECORD_BUDGET_MS) as unknown as Tx,
      "api", { log: parts.logger },
    ),
    // A function is frozen once it answers; the refresh behind a read route runs after the
    // answer, so it is handed to the host to finish.
    ...(door.afterAnswer ? { waitUntil: door.afterAnswer } : {}),
    // Plain http only to a private service name, resolved and pinned at every dial.
    ...(address.transport === "http-private"
      ? {
        fetchImpl: privateNetworkFetch(nodeHostResolver, (seen) => {
          parts.logger.info("entitlements_private_dial", { kind: seen.family === 6 ? "ipv6" : "ipv4", count: seen.addresses });
        }),
      }
      : {}),
  });
}

/**
 * The service bag. On a function the costly members are lazy getters, memoised on first use: a
 * bare `GET /health` must not pay `makeAuthService`'s scrypt warm-up on every cold start, and
 * rebuilding per request would make the unknown-email path a timing oracle. A long-running process
 * builds them all before it listens.
 */
export function buildServices(cfg: Wiring, door: DoorInput, parts: BagParts): ApiServices {
  const { chosen } = cfg;
  const { authConfig } = cfg.origin;
  const keyProvider = cfg.keyRing.provider;
  const put = door.lazyServices ? lazily : eagerly;
  // Built ONCE for the program — the storage client is stateless config + a signing key.
  const stagingStorage = cfg.storage ? stagingStorageFor(cfg.storage) : null;
  /**
   * THE PROCESS-LEVEL REPORTER, shared by both AI clients below: one `ai_call` line per model
   * call, greppable in the log drain and carrying Anthropic's request id. It records nothing.
   * What a call cost reaches the entitlements program on the RELEASE of the work that made it
   * (the Screener's and the draft's), attributed by the per-call hook the service passes and
   * priced by the program; `USAGE_HOST` names this host on those lines.
   */
  const onUsage = (r: AnthropicCallReport): void => {
    console.log(JSON.stringify({ event: "ai_call", ...r }));
  };
  // The stateless singletons: naming them is free, so they are plain properties.
  const bag: Record<string, unknown> = {
    sync: syncService,
    // UnifiedPush wake registrations, with this program's endpoint policy: https-only and public
    // addresses only. A self-hosted server may relax it for a distributor on its own LAN
    // (`TF_PUSH_ALLOW_PRIVATE=1`); the managed service never does, whatever its environment holds.
    push: makePushService({
      endpointGuard: makePushEndpointGuard(nodeHostResolver, {
        allowPrivate: chosen.privateDials === "operator-switch" && cfg.network.pushAllowPrivate,
      }),
    }),
    // Several users, one connection budget per upstream account, TWO processes (this one and the
    // organizer) that share no lock. With it, the connect probes' budget over time: nobody tries
    // passwords at a mail server back to back.
    imapAdmission: HOSTED_IMAP_ADMISSION,
    // The add-time IMAP/SMTP probe's SSRF gate. ENFORCING: the probe dials a host the caller typed,
    // so a private/loopback/link-local target or a non-mail port is refused before the socket opens.
    // The resolver is required at construction so the gate's DNS port can never quietly default.
    // The operator's explicit TF_PROBE_ALLOW_PRIVATE=1 selects allow-any for a LAN mail server.
    probeHostGuard: chosen.privateDials === "operator-switch" && cfg.network.probeAllowPrivate
      ? ALLOW_ANY_PROBE_HOST
      : makeProbeHostGuard(nodeHostResolver, chosen.privateDials === "operator-switch"
        ? { privateSwitch: "TF_PROBE_ALLOW_PRIVATE" }
        : undefined),
    ...(chosen.privateDials === "operator-switch"
      ? {
        // Asked only where the guard cleared nothing (the switch above set): is a no-TLS mail server
        // on this network? Plaintext is offered for such a server only, per protocol.
        probeScopeResolver: nodeHostResolver,
        // What the operator of THIS server can change, named in a certificate refusal on its own network.
        probeOperatorTrust: "NODE_EXTRA_CA_CERTS",
      }
      : {}),
    // The door's own request-body limit, in raw attachment bytes: attachment bytes ride the send
    // request base64-encoded, so their total must clear the body cap after the ~1.33× inflation
    // plus the JSON envelope. `SendService` caps a send at the smaller of this and what the sending
    // mailbox's own submission server announced.
    sendSurfaceMaxTotalBytes: door.sendSurfaceMaxTotalBytes,
    // A long-lived process: a send's Sent copy is retried in memory after the answer.
    ...(door.invocationBudgetMs === null ? { sendCopyOutlivesAnswer: true } : {}),
    // A delivered letter's Sent copy is kept until filed. The managed service keeps it for letters
    // WITHOUT files only: the published promise is that attachment bytes are never written down there.
    sendKeepOwedCopy: chosen.owedCopy,
    // THE STORAGE CAP. Metered, it reads the entitlements program's verdict; `null` from the read is
    // the documented fail-open for an account with no row at all, mapped to the typed unmetered
    // value. A lower limit is held 14 days (cloud 0055), as the worker's resolver applies it; a fault
    // throws into the sent-copy projection's own catch. A self-hosted server's limit is its disk,
    // and a value somebody WROTE is the only admissible spelling of that.
    storageCapOf: chosen.metering === "never"
      ? async () => UNMETERED_STORAGE_CAP
      : async (ctx: ServiceContext) => {
        const verdict = await accessOf(entitlementsComposition(), ctx.accountId);
        const limit = await heldStorageLimitOf(ctx.db as unknown as Tx, ctx.accountId, verdict, ctx.now());
        return limit === null ? UNMETERED_STORAGE_CAP : limit.capBytes;
      },
    // Load it now's admission: the service that empties letters for space bounds the loads, per account.
    ...(chosen.metering === "never" ? {} : { liveBodyAdmit: liveBodyAdmitter(throttleKeysFor(keyProvider)) }),
    // The way around the body cap: a transport with no request body in it. The browser mints a
    // grant, PUTs the bytes straight into the bucket, and the send carries a reference. A factory
    // over the request's database handle. ABSENT with no storage setting, and the absence is
    // load-bearing: the mint route answers 503, `/hello` reports `staging: false` (it reads THIS
    // member), and inline sends keep working under the body cap.
    ...(stagingStorage
      ? {
        attachmentStaging: (reqDb: Tx) => makeAttachmentStagingPort({
          db: reqDb,
          storage: stagingStorage,
        }),
      }
      : {}),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    triage: triageService,
    search: searchService,
    contacts: contactsService,
    snippets: snippetsService,
    notify: notifyRulesService,
    away: awayResponderService,
    attachments: attachmentsService,
    kb: kbService,
    tags: tagsService,
    // The folder VERBS: wired because a worker lane runs beside this program and executes the
    // commands it records.
    folderOps: new FolderOpsService(),
    drafts: draftsService,
    // Send later's two verbs (mail 0077).
    schedules: scheduleService,
    // A scheduled letter's files, sealed under this program's key ring until the letter goes (mail 0180).
    scheduledFiles: keepScheduledFilesSealed(keyProvider),
    /* The drafting call is cut before its host's kill, so a charge that bought nothing is returned
       by the request that took it (`draftWindow`); the ceiling is the door's own. */
    drafting: makeDraftingService({
      ...(door.invocationBudgetMs !== null ? { invocationBudgetMs: door.invocationBudgetMs } : {}),
      ...(chosen.ai === "metered" ? { usageHost: USAGE_HOST } : {}),
    }),
    // `sendAdapter` is deliberately ABSENT: leaving it unset is what makes the send route use
    // the real `makeSendAdapter`. A test injects it; production must not fake it.
    sends: sendService,
    workflows: workflowsService,
    proposals: proposalsService,
    // The `/pair/redeem` invite arm's bridge to the `invites` table, where later accounts arrive by
    // pairing invite; absent elsewhere, where the route answers `validation_failed`.
    ...(chosen.signup === "pairing-invites" ? { inviteRedeem: redeemInviteGrant } : {}),
  };

  /**
   * THE ENTITLEMENTS PORT — one of two answers, never absent: the HTTP client of that program, or
   * `UNMETERED` (unbounded limits, AI gated only by a configured provider key). Memoised, because
   * the client caches its access verdicts and a second instance would cache separately.
   */
  let composed: EntitlementsComposition | null = null;
  const entitlementsComposition = (): EntitlementsComposition => {
    composed ??= composeEntitlements(cfg, door, parts);
    return composed;
  };
  put(bag, "entitlementsPort", () => entitlementsComposition());

  // RFC 8058 one-click unsubscribe. A sender's one-click URL is a caller-influenced host, so the
  // SSRF gate's DNS port is required at construction. Authserv trust is per mailbox, not per
  // deployment: unknown providers resolve to the empty set, and the demote-only rule means that
  // blocks nothing.
  put(bag, "unsubscribe", () => makeUnsubscribeService({
    post: nodeOneClickPost,
    resolver: nodeHostResolver,
    trustedAuthservIdsFor: mailboxProviderAuthservIds,
  }));

  // Register/verify/factors/OAuth ceremony. `mail` is the program's one customer mailer, never a
  // bare mailer port (a service holding the port holds an unthrottled mail-bomb primitive). `null`
  // with no mailer: `AuthService.register` answers 503 `signup_unavailable` on the open gate rather
  // than creating accounts whose verification link can never be sent.
  put(bag, "auth", () => makeAuthService({
    config: authConfig, keyProvider, passwordHasher: scryptHasher,
    mail: parts.customerMail(),
  }));
  // Envelope-encrypts mailbox credentials with the SAME provider the organizer decrypts them
  // with — the KEK ring identity on `/health` is what proves those agree.
  put(bag, "mailbox", () => makeMailboxService({
    keyProvider,
    // The organizer beside this program checks a sender's own signature where a mailbox's provider
    // names no authserv-id, so a sender can be confirmed at every mailbox (`providerConfirms`).
    signatureChecks: true,
    ...(chosen.metering === "never"
      // LOADING the full services barrel registers the paid gate as the process-wide default
      // allowance: this explicit argument is the only thing between a self-hosted start and
      // `POST /mailboxes` refusing every mailbox with a subscription error.
      ? { allowance: SELF_HOST_MAILBOX_ALLOWANCE, accessOf: async () => UNMETERED_ACCESS }
      /* THE ACCESS VERDICT the allowance gate decides the LIMIT from, read before the create
         transaction opens. It reads the bag's OWN port member, so the gate and everything else that
         asks about this account's standing cannot answer differently. No `?? UNMETERED` fallback:
         the member is armed unconditionally above, and an absent one is a composition bug. */
      : {
        accessOf: (accountId: string) => {
          const port = bag.entitlementsPort as EntitlementsComposition | undefined;
          if (port === undefined) {
            throw new Error("`entitlementsPort` is not on the service bag — the mailbox "
              + "allowance gate has no limit to read. It is armed unconditionally; this is a bug.");
          }
          return accessOf(port, accountId);
        },
      }),
    /* WHO THIS DEPLOYMENT IS TO A MAILBOX, resolved through the SAME function the worker resolves
       it with. If the two ever derive different ids the hand-back is refused everywhere, which is
       the safe direction and a visible one. */
    installId: cfg.installId,
    /* WHEN THE ORGANIZER'S LAST PASS FINISHED, for the filing strip (mail 0097). Injected rather
       than imported by the builder: `worker_heartbeats` is a Cloud table and that module is inside
       the desktop engine's import closure. Passed BY REFERENCE, so the wiring is greppable. */
    lastOrganizerCycleAt: organizerCycleReader,
  }));

  /**
   * THE SPEND HALF OF WHATEVER THIS PROGRAM DECLARED, or nothing when it meters nothing. Read from
   * the bag rather than composed a second time: the port caches an account's access verdict.
   */
  const spendHalf = (): SpendPort | undefined => {
    const port = bag.entitlementsPort as EntitlementsComposition | undefined;
    return port !== undefined && isMetered(port) ? port : undefined;
  };
  /** THE ACCESS HALF OF THE SAME OBJECT — narrowed separately rather than cast. */
  const accessHalf = (): AccessPort | undefined => {
    const port = bag.entitlementsPort as EntitlementsComposition | undefined;
    return port !== undefined && isMetered(port) ? port : undefined;
  };
  // The model's two ports, built on first use: a client is a closure and a retry policy no
  // health probe needs.
  let ports: ReturnType<typeof serverAiPorts> | null = null;
  const ai = (): ReturnType<typeof serverAiPorts> => (ports ??= serverAiPorts(aiEnvOf(cfg), onUsage));
  // No adapter injected: a screener or approval decision leaves `folder_state` pending and the
  // ORGANIZER applies the IMAP move — one organizer per mailbox, and this program never opens IMAP
  // to apply organization. Suggestions are generated only on `POST /screener/suggest` over an
  // explicit, priced sender set; `list` cannot reach the classifier.
  put(bag, "screener", () => makeScreenerService({
    /* A request a host ends admits a sender's purchase only while there is time to finish the
       model call and the write after it; the window means nothing without the door's number. */
    ...(door.invocationBudgetMs !== null ? { invocationBudgetMs: door.invocationBudgetMs } : {}),
    ...(chosen.ai === "metered" ? { usageHost: USAGE_HOST } : {}),
    // The spend half, read off the bag so there is ONE port per program. Metered, the Screener's
    // terms (the exclusive claim, the setup pool) are the ACTION's (`SPEND_ACTIONS.screener`).
    ...(spendHalf() ? { credits: spendHalf()! } : {}),
    // THE SAME OBJECT, for the one read that happens only after the gate has refused: a `state`
    // refusal this account's own access view contradicts is answered 503 rather than billed.
    ...(accessHalf() ? { access: accessHalf()! } : {}),
    // THE PRICE, from the same instance. No card ⇒ no quote and no purchase.
    ...(accessHalf() ? { pricing: pricingOf(accessHalf()!) } : {}),
    ...(ai().classifier ? { classifier: ai().classifier! } : {}),
    // A screen-out arms auto-unsubscribe through the same bag entry, so the two paths can never
    // end up with two CONFIGURATIONS (a different trusted-authserv set).
    unsubscribe: bag.unsubscribe as ReturnType<typeof makeUnsubscribeService>,
  }));
  put(bag, "approval", () => makeApprovalService({}));
  // The image proxy's outbound fetch — real network by design (that is what strips a tracking
  // pixel's access to the reader's IP), SSRF-gated by the required resolver.
  put(bag, "privacy", () => makePrivacyService({ remote: nodeRemoteFetch, resolver: nodeHostResolver }));

  // THE LIVE DRAFTER, armed by the same choice the descriptor reads. Absent, the draft route
  // answers 503 drafter_unconfigured — the state an install with no model is honestly in.
  if (cfg.ai !== null) put(bag, "drafter", () => ai().drafter);

  if (chosen.funnel) {
    // The funnel. ALWAYS built there, even with no mailer: `POST /waitlist` recording the signup is
    // the durable half. The mailer, when there is one, is the program's `MailService`, never bare.
    put(bag, "waitlist", () => makeWaitlistService({
      mail: parts.customerMail() ?? undefined, throttleKeys: throttleKeysFor(keyProvider),
    }));
  }

  // The lifecycle passes' mail door: the SAME `MailService` register uses. Absent with no mailer:
  // a pass then reports owed notices as `unmailable` and claims nothing.
  put(bag, "customerMail", () => parts.customerMail() ?? undefined);

  return bag as unknown as ApiServices;
}

/** The model block as the provider reader's shape: the shipped Anthropic models, or the operator's choice. */
function aiEnvOf(cfg: Wiring): { ai: AiProviderEnv | null; aiTimeoutMs: number | null } {
  if (cfg.ai === null) return { ai: null, aiTimeoutMs: null };
  if (cfg.ai.kind === "operator") return { ai: cfg.ai.env, aiTimeoutMs: cfg.ai.timeoutMs };
  return {
    ai: { provider: "anthropic", apiKey: cfg.ai.apiKey, baseUrl: null, allowPrivate: false, classifyModel: null, draftModel: null },
    aiTimeoutMs: null,
  };
}

/**
 * The classifier's one model call on the shipped client. The suggest lane admits a sender's
 * purchase only while there is time for this call and the write after it
 * (`SUGGEST_ADMISSION`), so the pair is named here, where that ceiling is read from.
 */
export const CLASSIFIER_CALL = { timeoutMs: 10_000, maxRetries: 1 } as const;

/**
 * THE TWO PORTS THE OPERATOR'S MODEL BECOMES, or none. Anthropic is the hosted client exactly as
 * before — two clients, 10 s for a suggestion and 25 s for a draft, one retry — with the
 * operator's model names when set. Any other provider is its desktop transport through
 * `portsOf`, with no proposer anywhere on this server. `TF_AI_TIMEOUT_MS` replaces both defaults.
 */
export function serverAiPorts(
  cfg: Pick<ServerConfig, "ai" | "aiTimeoutMs">,
  onUsage: (r: AnthropicCallReport) => void,
  fetchImpl: typeof fetch = fetch,
): { classifier?: ClassifierPort; drafter?: DraftPort } {
  const ai = cfg.ai;
  if (ai === null) return {};
  const suggestMs = cfg.aiTimeoutMs ?? CLASSIFIER_CALL.timeoutMs;
  const draftMs = cfg.aiTimeoutMs ?? 25_000;
  if (ai.provider === "anthropic") {
    const client = (timeoutMs: number) => makeAnthropicClient({
      apiKey: ai.apiKey, timeoutMs, maxRetries: CLASSIFIER_CALL.maxRetries, onUsage, fetchImpl,
      ...(ai.baseUrl ? { baseUrl: ai.baseUrl, allowPrivateBaseUrl: ai.allowPrivate } : {}),
    });
    return {
      classifier: makeHaikuClassifier({ client: client(suggestMs), ...(ai.classifyModel ? { model: ai.classifyModel } : {}) }),
      drafter: makeSonnetDrafter(client(draftMs), ai.draftModel ? { model: ai.draftModel } : {}),
    };
  }
  return {
    classifier: portsOf(transportFor(ai, { fetchImpl, timeoutMs: suggestMs, onUsage })).classifier,
    drafter: portsOf(transportFor(ai, { fetchImpl, timeoutMs: draftMs, onUsage })).drafter,
  };
}

/** The pager's readers of the entitlements program: null members where nothing is metered. */
export interface AlertReaders {
  parkedAccounts: ParkedAccountsReader | null;
  accountsAtCap: AccountsAtCapReader | null;
  planeOps: PlaneOpsReader | null;
}

/**
 * THE PROGRAM'S ONE ALERT READER BAG, over its memoised client: the parked reader the alert route
 * AND the staff console read (one instance), and the at-cap and plane-ops readers the route alone
 * takes, because a pass is periodic and a console request is not. Lazy, so a request that never
 * evaluates never composes the client.
 */
export function alertReadersFor(cfg: Wiring, services: () => ApiServices, logger: Logger): AlertReaders {
  const port = () => services().entitlementsPort as EntitlementsComposition;
  const metered = cfg.chosen.metering !== "never" && cfg.entitlements !== null;
  // Once per program: whether its alert route reads the entitlements program at all.
  logger.info("plane_ops_watch", metered
    ? { state: "on" }
    : { state: "off", reason: "no ENTITLEMENTS_URL: this server reads no billing plane" });
  if (!metered) {
    // Nobody is parked and nobody has a cap, and the rules say so rather than "no reader".
    return {
      parkedAccounts: parkedAccountsOf(UNMETERED), accountsAtCap: accountsAtCapOf(UNMETERED),
      planeOps: planeOpsReaderOf(UNMETERED),
    };
  }
  return {
    // BOUNDED: this program is no roster, and a hung plane must neither hold the page only this
    // arm sends nor the console's read. An unfinished read throws, and the rule says so.
    parkedAccounts: (ids, now, recheck) => {
      const read = parkedAccountsOf(port(), ALERT_PARKED_READ_BOUND);
      return read ? read(ids, now, recheck) : Promise.resolve(new Set<string>());
    },
    accountsAtCap: (db, now) => {
      const read = accountsAtCapOf(port());
      return read ? read(db, now) : Promise.resolve({ atCap: [], read: 0, total: 0 });
    },
    // The plane's own failures, one read per pass, over the same client; never recorded as a fault.
    planeOps: () => {
      const read = planeOpsReaderOf(port());
      return read ? read() : Promise.resolve({ state: "unsupported" as const });
    },
  };
}

/**
 * The pager's arms and, beside them, the last-resort page's (`alert-last-resort.ts`): the same
 * objects, names and order, except the mail arm, which is the same service with its recipient
 * limiter in memory (`dbFreeMailAlertSink`), since that page is sent because the database is gone.
 * Three arms sharing no vendor: the JSON webhook, the Telegram push (a half-set pair is an arm that
 * refuses every page naming the missing variable), and operator mail — a SECOND `MailService`
 * carrying `operatorEmail`. Cannot throw: an observability feature must never cause the outage it
 * exists to report. An arm that cannot be built stays in the list as one that refuses, so `/health`,
 * the pager verdict and the other driver see it.
 */
export function pagerArms(
  cfg: Wiring, logger: Logger, limiterDb: () => Db,
): { sinks: AlertSink[]; lastResort: AlertSink[] } {
  const alerts = cfg.alerts;
  const sinks: AlertSink[] = [];
  const lastResort: AlertSink[] = [];
  if (!alerts) return { sinks, lastResort };
  const same = (sink: AlertSink | null) => (sink ? { sink, lastResort: sink } : null);
  const add = (name: string, build: () => { sink: AlertSink; lastResort: AlertSink } | null): void => {
    try {
      const built = build();
      if (built) { sinks.push(built.sink); lastResort.push(built.lastResort); }
    } catch (err) {
      // Structured, and it names no value: the thing most likely to be malformed is a URL from a setting.
      logger.error("alert_sink_unavailable", {
        err, sink: name, reason: "an alert sink could not be constructed; it is published as refusing",
      });
      const refusing = refusingAlertSink(name, `the ${name} arm could not be built at boot (alert_sink_unavailable)`);
      sinks.push(refusing);
      lastResort.push(refusing);
    }
  };
  add("webhook", () => same(webhookAlertSink(alerts.webhookUrl ?? undefined)));
  add("telegram", () => same(telegramAlertSink({
    botToken: alerts.telegram.botToken ?? undefined, chatId: alerts.telegram.chatId ?? undefined,
  })));
  // The settings refused TF_ALERT_EMAIL without a mailer, so both are here or the arm is off.
  const { email } = alerts;
  const mail = cfg.customerMail;
  if (email && mail) {
    add("mail", () => {
      const service = mailServiceFor(cfg, mail, email);
      return {
        // A limiter, not a database: `sendOperatorAlert` uses it for exactly one thing, claiming an
        // `auth_throttle` slot. It cannot move onto the blind handle: the staff role has no grant there.
        sink: mailAlertSink(service, { limiter: dbRecipientLimiter(limiterDb()), now: () => new Date() }),
        lastResort: dbFreeMailAlertSink(service),
      };
    });
  }
  return { sinks, lastResort };
}

/** `TF_ALERT_HEARTBEAT_URL`, built once. An unusable value is named, never printed. */
export function alertHeartbeat(cfg: Wiring, logger: Logger): AlertHeartbeat {
  const heartbeat = alertHeartbeatFor(cfg.alerts?.heartbeatUrl);
  if (heartbeat.state === "unusable") {
    logger.error("alert_heartbeat_unusable", {
      configVar: heartbeat.configVar, reason: "set but not one plain http(s) URL; no heartbeat is sent",
    });
  }
  return heartbeat;
}

/**
 * The Microsoft OAuth2 token source — ONE long-lived provider for the program: its token cache is
 * keyed by mailbox with expiry handled inside it, and `resolveClient` re-reads the config store on
 * every refresh so a rotated client secret takes effect without a restart. The rotation write
 * targets the mailbox's own credential row and is the only write this port makes.
 */
export function oauthProvider(cfg: Wiring, db: () => Db): MicrosoftTokenProvider {
  const updateSecret: UpdateSecretPort = (mailboxId, ciphertextEnc, keyVersion) =>
    rotateMailboxOAuthSecret(db(), {
      mailboxId, ciphertext: ciphertextEnc, keyVersion, now: new Date(),
    });
  return new MicrosoftTokenProvider({
    clientId: cfg.msOAuth?.clientId ?? "",
    clientSecret: cfg.msOAuth?.clientSecret ?? "",
    defaultTenant: cfg.msOAuth?.tenant || "common",
    resolveClient: async (want) => {
      /*
       * TWO REGISTRATIONS, AND THE MAILBOX SAYS WHICH ONE ISSUED ITS TOKEN.
       *
       * A server that mounts the device-code door can hold both: a mailbox connected through the
       * operator's own confidential registration, and one connected through the shared public
       * client. A refresh token is only renewable by the client that obtained it, so `want` — read
       * off the credential's own meta — is the question. The public arm resolves from the settings
       * alone. `kind` is STATED on both arms, because the token client re-checks that the door it
       * asked for is the door that answered.
       *
       * Where the door is not mounted no mailbox holds a public-client token: a `want` of
       * `"public"` is a row this program never wrote, and resolving the confidential registration
       * lets the token client refuse the mismatch by name, before any request reaches Microsoft.
       */
      if (want === "public" && cfg.chosen.deviceCodeDoor) {
        return {
          clientId: cfg.msDevice?.clientId ?? "",
          clientSecret: "",
          defaultTenant: cfg.msDevice?.tenant || "common",
          kind: "public",
        };
      }
      const resolved = await resolveOAuthProviderConfig({
        tx: db(),
        decrypt: (ct, kv) => cfg.keyRing.provider.decrypt(ct, kv),
        bootstrap: cfg.msOAuth,
        provider: MICROSOFT_PROVIDER,
      });
      return {
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        defaultTenant: resolved.tenant || cfg.msOAuth?.tenant || "common",
        kind: "confidential",
      };
    },
    keyProvider: cfg.keyRing.provider,
    updateSecret,
    fetch: globalThis.fetch as unknown as FetchLike,
  });
}

/**
 * `needsSetup` as the DATABASE FACT it is: does any user exist yet. A capability rather than a
 * boot-time boolean because the answer flips the moment the first account registers, and
 * `/hello` must tell the truth per request. It may throw — the route answers 503 rather than
 * guessing in either direction (hello.ts states why both guesses are wrong).
 *
 * It first ENFORCES the setup-token invariant (`ensureSetupTokenInvariant`): `needsSetup: true`
 * must never be advertised while the token that ceremony needs exists nowhere (the last account
 * erased itself; the boot token expired unredeemed), and a live ownerless token must never
 * survive on a server that has users (the restart-races-first-registration residue). A token
 * this path mints is printed through {@link ServerRuntime.onSetupTokenMinted} — stdout, where
 * the boot already told the operator to look.
 */
export function needsSetupFor(
  db: Db,
  onMinted: (minted: PairingTokenMinted) => void,
): () => Promise<boolean> {
  return async () => {
    await ensureSetupTokenInvariant(db, { onMinted });
    const row = await db.select({ id: users.id }).from(users).limit(1);
    return row.length === 0;
  };
}

/**
 * One probed staff handle per connection string. `adminDbFor` already memoises the PROBE; this
 * memoises the closure. Nothing connects until a staff route is actually served.
 */
const staffDbs = new Map<string, () => Promise<AdminDb>>();

export function staffDbFor(url: string): () => Promise<AdminDb> {
  let held = staffDbs.get(url);
  if (!held) {
    held = adminDbFor(url);
    staffDbs.set(url, held);
  }
  return held;
}

/** Test seam: forget the staff handles and the fresh-connection probes. */
export function resetHandles(): void {
  staffDbs.clear();
  freshProbes.clear();
}

/**
 * THE KEY-RETIREMENT CHECK for `/health` (`HealthConfig.kekRetirement`): does a stored secret still
 * name a version this ring declares retired? One read-only aggregate per sealed column, asked ONCE
 * for a definite answer — after the deploy that removed the version nothing can start naming it
 * again — and asked again after a reading that failed, which is a fault of its own: a host that
 * cannot tell is not known to be able to open its secrets. Never throws. The sentence carries no
 * count and no driver text: `/health` is public.
 */
export function kekRetirementCheck(
  retiredThrough: number, read: (retiredThrough: number) => Promise<RetiredKekReferences>,
): () => Promise<{ error: string; detail: string } | null> {
  let kept: Promise<{ error: string; detail: string } | null> | null = null;
  return async () => {
    if (kept) return kept;
    try {
      const refs = await read(retiredThrough);
      const answer = refs.total > 0
        ? { error: "kek_retired_version_in_use", detail: retiredVersionInUseFault(refs) }
        : null;
      kept = Promise.resolve(answer);
      return answer;
    } catch {
      // A failed reading is not cached and carries no driver text: the next /health asks again.
      return { error: "kek_retirement_unread", detail: retiredVersionUnreadFault(retiredThrough) };
    }
  };
}

const kekChecks = new WeakMap<Runtime, () => Promise<{ error: string; detail: string } | null>>();
function kekRetirementFor(rt: Runtime): () => Promise<{ error: string; detail: string } | null> {
  let check = kekChecks.get(rt);
  if (!check) {
    check = kekRetirementCheck(rt.cfg.keyRing.retiredThrough,
      (through) => kekRetiredReferences(rt.db.request() as unknown as Tx, through));
    kekChecks.set(rt, check);
  }
  return check;
}

/** Build the per-request container. `req` is the ALREADY-NORMALIZED request (see `handler.ts`). */
export function depsFor(req: Request, rt: Runtime): ApiDeps {
  const { cfg, door } = rt;
  const { chosen } = cfg;
  const db = rt.db.request();
  const metered = chosen.metering !== "never";
  const staff = chosen.staffDoor === "blind-role" ? cfg.staff : null;
  return {
    db,
    sessionDb: () => rt.db.session(),
    now: () => new Date(),
    requestId: "",                 // `withRequestId` assigns one
    session: null,                 // `withSession` resolves it
    authConfig: cfg.origin.authConfig,
    keyProvider: cfg.keyRing.provider,
    services: rt.services,
    sse: cfg.sse,
    // The `/events` push relay: ONE LISTEN for the program, fanned out per account. Built only
    // where streams are held AND a session-capable connection can hold the LISTEN; otherwise the
    // route's poll loop is the only wake source.
    changeWake: rt.changeWake(),
    allowCookieAuth: allowCookieAuthForRequest(req, cfg.origin.cookieHosts),
    /**
     * The verified-address product policy, STATED on both. The managed service requires a proven
     * address before the costly route classes (`withSpendGate`). A self-hosted server states
     * `false`: accounts there legitimately arrive unverified — a pairing invite mails nothing and
     * the box may have NO mailer — and the default is REQUIRE on purpose, so silence here would
     * brick every pairing-invited account at their first mailbox add. The mailbox add presents an
     * IMAP credential, which proves more about mailbox ownership than a verification mail did.
     */
    requireVerifiedForProduct: chosen.requireVerified,
    health: {
      version: cfg.build.version,
      // BOTH journals: a health probe that certified the mail half alone would bless a half-migrated database.
      schemaTier: "all",
      kek: cfg.keyRing.identity,
      kekError: cfg.keyRing.error,
      // Armed only on a ring that retired a version: `/health` answers 503 while a stored secret
      // still names one, or while the program cannot tell.
      kekRetirement: cfg.keyRing.retiredThrough > 0 ? kekRetirementFor(rt) : null,
      buildSource: cfg.build.source,
      buildError: cfg.build.error,
      ...(staff
        ? {
          // Non-fatal by design: an unarmed STAFF console is not a reason to take the product out of rotation.
          adminError: staff.adminError,
          // The content-blind ATTESTATION, non-fatal: it awaits the SAME memoised factory a staff
          // request builds, so `/health` names a wrong-but-plausible `DATABASE_URL_ADMIN` minutes
          // before a staff request would 503 on it. Never throws; catalog-safe text only.
          staffDbAttestation: rt.staffDb ? () => attestStaffDbFault(rt.staffDb!) : null,
        }
        : {}),
      // THE PAGER IS CONFIGURED AND CANNOT RUN: `alertsFault` present ⇔ the routes answer 503. At
      // HTTP 200 with `ok` still true: an observability feature must never cause the outage it
      // exists to report.
      alertsError: !cfg.alerts ? null
        : staff
          ? (staff.dbError
            ? `alerting is configured but DARK: ${staff.dbError} — /internal/alerts* answer 503 ` +
              "alerts_db_unarmed and no alert pass runs on this deployment"
            : null)
          : (!rt.alertDb
            ? "alerting is configured but DARK: no handle for the pass — /internal/alerts* answer 503 " +
              "alerts_db_unarmed and no alert pass runs"
            : null),
      // "unrecognized" on an operator's own Postgres is healthy: the field exists so the connection
      // guards' blind spots are visible, not as a fault.
      dbProvider: providerFamily(cfg.database.url),
      // Both transport hops of the runtime handle, and the entitlements client's own beside them.
      dbTls: async (reached: boolean) => Object.assign(
        await readDbTls(cfg.database.url, db, reached),
        rt.billing.transport ? { billing: { transport: rt.billing.transport } } : {},
      ),
      // Whether a NEW connection is admitted, beside the held one the probe rode.
      ...(rt.db.freshConnect ? { freshConnect: rt.db.freshConnect } : {}),
      ...(metered
        ? {
          // Whether this program reaches an entitlements program at all, read from the SAME
          // settings member the bag arms from.
          entitlements: cfg.entitlements ? "configured" as const : "unmetered" as const,
          // WHERE A QUOTE'S PRICE COMES FROM — `plane` once the program's card has been read,
          // `unpriced` while it has not, `unmetered` with no program.
          aiPricing: async (): Promise<AiPricingMarker> => {
            const composed = rt.services.entitlementsPort as EntitlementsComposition | undefined;
            if (composed === undefined || composed === UNMETERED) return "unmetered";
            return "aiPricing" in composed ? (composed as EntitlementsClient).aiPricing() : "unpriced";
          },
        }
        : {}),
      // The pager's arms and their standing health. Where a pager is expected the key is always
      // there: `arms: []` is the loud statement that this deployment cannot page anybody. On a
      // self-hosted server nobody armed a pager on, it is absent.
      alertSinks: cfg.alerts || chosen.pager === "expected" ? () => apiAlertSinkSummary(rt.alertSinks) : null,
    },
    // What `GET /push/vapid-key` answers: the PUBLIC half only. `TF_VAPID_PRIVATE_KEY` is never
    // read by this program, because nothing a request handler does needs to sign a wake.
    vapidPublicKey: cfg.push.vapidPublicKey,
    // What `GET /hello` answers — the capability statement. Every flag reads the SAME member the
    // wiring arms from, so the negotiation cannot disagree with what the routes do.
    hello: {
      flavor: chosen.flavor,
      // The release this build is of, as its door read it: not the commit `/health` names.
      ...releaseOnly(cfg.build.release),
      // A capability, not a boolean, where a setup token makes the first account: the answer
      // flips the moment that account registers.
      needsSetup: chosen.firstAccount === "setup-token" ? needsSetupFor(db, door.onSetupTokenMinted) : false,
      auth: {
        password: true,
        totp: true,
        webauthn: true,
        // BOTH halves of the ceremony, not just the flag: with the open gate on and no customer
        // mailer, `AuthService.register` refuses 503, so a descriptor reading the flag alone would
        // announce a ceremony this program cannot complete. Never set on a self-hosted server.
        publicSignup: cfg.origin.authConfig.publicSignup && rt.customerMail() !== null,
      },
      features: {
        // Whether `GET /events` streams: off is 503 `sse_disabled`, held nothing is 204.
        sse: cfg.sse.enabled === true && cfg.sse.holds !== false,
        // Reads the BAG, not the settings: the descriptor must announce what the routes DO.
        staging: rt.services.attachmentStaging !== undefined,
        // That a model is configured, never which.
        ai: cfg.ai !== null,
        // The pairing ceremony is mounted on both route tables.
        pairing: true,
        // The image proxy's real egress is wired unconditionally (`privacy` on the bag).
        remoteImages: true,
        // False for clients that predate the horizon; `/hello` adds `scheduleFilesDays` from `scheduledFiles`.
        scheduleFiles: false,
      },
    },
    logger: rt.logger,
    /**
     * WHERE THIS PROGRAM'S 5xx GO TO BE COUNTED (cloud 0033). `arm: "api"` is a literal: two
     * processes under one name make "which host" unanswerable. Through {@link DbPort.brief}: on
     * the pooled handle a fresh one with a short ceiling, not the request's own, which just refused.
     */
    faultLog: {
      record: async (fault) => {
        await recordApiFault(rt.db.brief(API_FAULT_RECORD_BUDGET_MS) as unknown as Tx, { ...fault, arm: "api" });
      },
    },
    /**
     * WHERE A SPEND THAT BOUGHT NOTHING IS REMEMBERED (cloud 0036) — composed exactly where the
     * entitlements program is: a host with no meter can owe nothing. THE REQUEST'S OWN HANDLE: this
     * row is the reason a person gets their money back, and it has to be written by the request
     * that observed the charge buying nothing, outside the drafting transaction that failed.
     */
    ...(metered && cfg.entitlements
      ? { refundObligations: refundObligationsOn(db as unknown as Tx) }
      : {}),
    ...(chosen.funnel
      ? {
        cronSecret: cfg.cronSecret,
        connectReminder: cfg.lifecycle.connectReminder,
        connectReminderSince: cfg.lifecycle.connectReminderSince,
        // How connecting a mailbox ended (cloud 0054), composed only on `TF_CONNECT_ATTEMPTS=record`.
        ...(cfg.lifecycle.connectAttempts === "record"
          ? { connectAttempts: connectAttemptRecorder(db as unknown as Tx, () => new Date(), rt.logger) }
          : {}),
        // The DNS `POST /mailboxes/discover` asks — MX and SRV only, named here and nowhere else.
        mailDns: nodeMailDns,
      }
      : {}),
    // Armed by TF_ALERT_SECRET (≥ 24 chars); absent ⇒ the /internal/alerts routes answer 404.
    alerts: cfg.alerts
      ? {
        secret: cfg.alerts.secret,
        // `?? undefined` and not `?? ""`: the run route treats an empty string as "no cron
        // credential configured", and null must not become a second accepted secret.
        cronSecret: cfg.alerts.cronSecret ?? undefined,
        sinks: rt.alertSinks,
        lastResortSinks: rt.alertLastResortSinks,
        ...(rt.alertHeartbeat ? { heartbeat: rt.alertHeartbeat } : {}),
        environment: cfg.environment,
        parkedAccounts: rt.alertReaders.parkedAccounts,
        accountsAtCap: rt.alertReaders.accountsAtCap,
        planeOps: rt.alertReaders.planeOps,
        // The pass's own handle, where the server has one role and no content-blind one
        // (`AlertsConfig.db`). With a staff door the pass runs on `adminDb` and this stays unset.
        ...(chosen.staffDoor === "none" ? { db: rt.alertDb ?? undefined } : {}),
        // A drill's ack link: the app origin, whose `/api/*` reaches this program. A refused
        // origin arms no drill rather than linking anywhere else.
        drillAckBase: cfg.origin.appOrigin ? `${cfg.origin.appOrigin}/api` : undefined,
      }
      : undefined,
    // ABSENT ⇒ every `GET /admin/*` answers 404: no staff console until somebody arms it deliberately.
    admin: staff?.admin
      ? {
        secret: staff.admin.secret,
        environment: cfg.environment,
        assertion: staffSigningKeyOf(staff.admin.assertionKey, staff.admin.assertionKid),
        // The alert route's own parked reader, so the board's sync_lag reads duty as the pager
        // does; no at-cap reader, which the console never runs.
        parkedAccounts: rt.alertReaders.parkedAccounts,
      }
      : undefined,
    // The content-blind staff connection, armed by `DATABASE_URL_ADMIN` ALONE. There is no value
    // this may fall back to: the only other handle in this program can read every account's mail.
    adminDb: rt.staffDb ?? undefined,
    // The ENV BOOTSTRAP for the Microsoft application registration, passed as data.
    msOAuth: cfg.msOAuth,
    // THE PUBLIC CLIENT that arms the device-code routes; `null` becomes an ABSENT field, so
    // `deviceFlowAvailable` reads one shape.
    ...(chosen.deviceCodeDoor && cfg.msDevice ? { msDevice: cfg.msDevice } : {}),
    /* The OAuth bounce's redirect target. `?? undefined`: the route reads an ABSENT value as "fall
     * back to `defaultOrigin(authConfig)`", and an empty string would make `new URL(path, "")` throw. */
    appOrigin: cfg.origin.appOrigin ?? undefined,
    oauth: rt.oauth,
  };
}

/** `apiVersion` only where a release is stated: `/hello` answers `0.0.0` for the rest, never a guess. */
function releaseOnly(release: string | null): { apiVersion?: string } {
  return release === null ? {} : { apiVersion: release };
}

/* ── The self-hosted server's own names, over the one wiring ─────────────────────────────────
 * `ServerRuntime` and the functions below are what this server's process door and tests call:
 * the flat config (`ServerConfig`) and one owned pool. Each is the one wiring under that name. */

/** The process door's inputs for a self-hosted server: the adapter's numbers, a process nothing ends. */
export function processDoorInput(
  logger: Logger, onSetupTokenMinted: (minted: PairingTokenMinted) => void,
): DoorInput {
  return {
    logger,
    bodyMaxBytes: BODY_MAX_BYTES,
    sendSurfaceMaxTotalBytes: SELF_HOST_SEND_MAX_TOTAL_BYTES,
    invocationBudgetMs: null,
    lazyServices: false,
    closeUndrained: true,
    afterAnswer: null,
    onSetupTokenMinted,
  };
}

/** Everything with process lifetime, as this server's process door and tests hand it over. */
export interface ServerRuntime {
  cfg: ServerConfig;
  db: Db;
  services: ApiServices;
  changeWake: ChangeWakeHub | null;
  oauth: MicrosoftTokenProvider;
  /** Where a setup token minted OUTSIDE boot gets printed — see {@link needsSetupFor}. */
  onSetupTokenMinted: (minted: PairingTokenMinted) => void;
  logger: Logger;
  alertSinks: AlertSink[];
  alertLastResortSinks?: AlertSink[];
  alertHeartbeat?: AlertHeartbeat;
  alertDb: (() => Promise<Tx>) | null;
}

const runtimes = new WeakMap<ServerRuntime, Runtime>();

/** The one wiring's {@link Runtime} for a hand-built {@link ServerRuntime}. */
export function runtimeOf(rt: ServerRuntime): Runtime {
  let runtime = runtimes.get(rt);
  if (!runtime) {
    const cfg = wiringOf(rt.cfg.settings);
    const silent = { info: () => {} } as unknown as Logger;
    runtime = {
      cfg,
      door: processDoorInput(rt.logger, rt.onSetupTokenMinted),
      db: ownedDbPort(rt.db),
      services: rt.services,
      changeWake: () => rt.changeWake,
      oauth: rt.oauth,
      logger: rt.logger,
      alertSinks: rt.alertSinks ?? [],
      alertLastResortSinks: rt.alertLastResortSinks ?? [],
      ...(rt.alertHeartbeat ? { alertHeartbeat: rt.alertHeartbeat } : {}),
      alertDb: rt.alertDb ?? null,
      // The boot line is the alert clock's to write on this door (`alertClockFor`).
      alertReaders: alertReadersFor(cfg, () => rt.services, silent),
      staffDb: null,
      customerMail: () => null,
      billing: { transport: null },
    };
    runtimes.set(rt, runtime);
  }
  return runtime;
}

export function buildDeps(req: Request, rt: ServerRuntime): ApiDeps {
  return depsFor(req, runtimeOf(rt));
}

/** The bag for a self-hosted configuration over one owned pool, built before the first request. */
export function buildServerServices(cfg: ServerConfig, db: Db): ApiServices {
  const wiring = wiringOf(cfg.settings);
  const logger = { info: () => {}, error: () => {} } as unknown as Logger;
  let mail: { value: MailService | null } | null = null;
  return buildServices(wiring, processDoorInput(logger, () => {}), {
    db: ownedDbPort(db),
    logger,
    billing: { transport: null },
    customerMail: () => (mail ??= { value: customerMailFor(wiring, logger) }).value,
  });
}

export function customerMailerFor(cfg: ServerConfig): MailService | null {
  return customerMailFor(wiringOf(cfg.settings), { error: () => {} } as unknown as Logger);
}

export function alertArmsFor(
  cfg: ServerConfig, logger: Logger, db: Db,
): { sinks: AlertSink[]; lastResort: AlertSink[] } {
  return pagerArms(wiringOf(cfg.settings), logger, () => db);
}

export function alertSinksFor(cfg: ServerConfig, logger: Logger, db: Db): AlertSink[] {
  return alertArmsFor(cfg, logger, db).sinks;
}

export function alertHeartbeatForServer(cfg: ServerConfig, logger: Logger): AlertHeartbeat {
  return alertHeartbeat(wiringOf(cfg.settings), logger);
}

export function oauthProviderFor(cfg: ServerConfig, db: Db): MicrosoftTokenProvider {
  return oauthProvider(wiringOf(cfg.settings), () => db);
}

export { serverConfigOf };
