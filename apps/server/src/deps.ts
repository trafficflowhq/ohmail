import { users, providerFamily, UNMETERED, UNMETERED_ACCESS, parkedAccountsOf, type Tx } from "@trafficflow/db";
import { readDbTls, alertHeartbeatFor, type AlertHeartbeat } from "@trafficflow/db/cloud";
import {
  acquireImapSlot, releaseImapSlot, webhookAlertSink, telegramAlertSink, refusingAlertSink,
  recordApiFault, accountsAtCapOf, planeOpsReaderOf,
  resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER,
  makeSupabaseStagingStorage, makeS3StagingStorage,
  // The organizer's last completed pass, for the filing strip (mail 0097).
  organizerCycleReader,
  acquireCeilingHandle, SESSION_ACQUIRE_TIMEOUT_MS,
  type AlertSink, type AttachmentStagingStorage,
} from "@trafficflow/db/cloud";
import {
  resolveCloudInstallId,
  makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  MicrosoftTokenProvider, UNMETERED_STORAGE_CAP,
  type AnthropicCallReport, type ClassifierPort, type DraftPort, type FetchLike, type Logger,
  type UpdateSecretPort,
} from "@trafficflow/core";
import { portsOf, transportFor } from "@trafficflow/core/ai-provider-env";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { makePushEndpointGuard } from "@trafficflow/core/net";
import {
  makeAuthService, makeMailboxService, makeScreenerService, makeApprovalService,
  makePrivacyService, makeUnsubscribeService, nodeOneClickPost,
  nodeRemoteFetch, nodeHostResolver, scryptHasher,
  syncService, makePushService, rulesService, messageService, threadService, triageService,
  searchService, contactsService, snippetsService, notifyRulesService, awayResponderService,
  attachmentsService, kbService, tagsService, draftsService, draftingService, sendService,
  FolderOpsService, scheduleService,
  workflowsService, proposalsService, redeemInviteGrant,
  makeAttachmentStagingPort, MailService, SmtpMailer, mailAlertSink, dbFreeMailAlertSink, dbRecipientLimiter,
} from "@trafficflow/services";
// The policy TYPE lives on the mail entry (the sidecar imports it there too); the full barrel
// above is still loaded by this app — which is exactly why the explicit allowance below exists.
import type { MailboxAllowancePolicy } from "@trafficflow/services/mail";
import type { PairingTokenMinted } from "@trafficflow/services";
import { makeProbeHostGuard, ALLOW_ANY_PROBE_HOST, apiAlertSinkSummary } from "@trafficflow/api";
import type { ApiDeps, ApiServices, ChangeWakeHub } from "@trafficflow/api";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";
import {
  allowCookieAuthForRequest, SELF_HOST_SEND_MAX_TOTAL_BYTES,
  type ServerConfig, type SmtpConfig, type StorageConfig,
} from "./config.js";
import { ensureSetupTokenInvariant } from "./setup-token.js";

/**
 * The per-request {@link ApiDeps} for the standalone self-host server.
 *
 * ONE process, ONE lifetime for almost everything: the service bag, the owned pool, the wake hub
 * and the logger are built once at boot (`index.ts`) and threaded here as {@link ServerRuntime};
 * per request only `session`, `requestId`, `idempotency` and the host's cookie decision vary.
 * This is `apps/api-vercel/src/deps.ts` re-stated for a host with no cold starts — deliberately a
 * SECOND composition root rather than an extraction of the first: two shapes controlled by CI
 * (the bag-parity suite compares the service bags key for key) beat one shared shape whose
 * every self-host edit would churn the managed deployment.
 */

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

type Db = PostgresJsDatabase<typeof schema>;

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

/** `"ohmail <no-reply@x>"` → `no-reply@x` — the bare address inside an RFC5322 display form. */
const bareAddress = (from: string): string => {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
};

/**
 * The `MailService` customer mail goes through on this host, or `null` when the operator set no
 * SMTP block — the managed composition's `customerMailerFor`, restated over `SmtpMailer`.
 *
 * `null` is a WORKING configuration, not a degraded one: the pairing invite path never needs
 * mail (verification rides the consumed token's own `confers_verified` record), and the only
 * surface that hard-requires a mailer — open public signup — does not exist on this composition
 * at all, so the 503-on-the-open-gate degradation inside `AuthService.register` is compiled-in
 * caution rather than a reachable state. What a mailer ADDS is the ordinary verification flow
 * for addresses that arrive unverified, `resendVerification`, and the new-device sign-in notice.
 *
 * Unlike the managed host's version this one THROWS on an unusable block, deliberately: there,
 * construction runs on the path of every request and a bad value must cost mail rather than
 * availability; here it runs once at boot, and config.ts's contract is that a misshapen value
 * refuses the start with the variable named. Every message on that path is a fixed sentence —
 * `SmtpMailer`'s own refusals name no value, because `SMTP_URL` embeds a credential.
 *
 * The link bases are all {@link ServerConfig.origin}: one origin is the whole point of this
 * composition, and it was validated at boot, so `MailService`'s own base assertion cannot add a
 * second refusal. `supportEmail` — the address templates tell people to write to — is the
 * operator's `MAIL_REPLY_TO` when set (a mailbox a human reads), else the bare `MAIL_FROM`.
 */
export function customerMailerFor(cfg: ServerConfig): MailService | null {
  if (!cfg.smtp) return null;
  try {
    // No `operatorEmail`: this instance exists to reach the box's users, and without the address
    // `sendOperatorAlert` skips. The pager's mail arm is a SECOND instance (alertSinksFor).
    return smtpMailServiceFor(cfg, cfg.smtp);
  } catch (err) {
    // Boot refusal, config.ts's grammar: the variable, the rule, never the value. The inner
    // message is one of our own fixed sentences (SmtpMailer/assertUsableFrom echo nothing).
    throw new Error(
      `SMTP is configured but not usable — check SMTP_URL and MAIL_FROM: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * A `MailService` over this server's SMTP block: the customer instance, or with `operatorEmail`
 * the pager's mail arm. One construction, two instances — sharing one object would put two threat
 * models in one configuration. Throws on an unusable block (its callers' contracts differ).
 */
function smtpMailServiceFor(cfg: ServerConfig, smtp: SmtpConfig, operatorEmail?: string): MailService {
  return new MailService({
    mailer: new SmtpMailer({ url: smtp.url, from: smtp.from, replyTo: smtp.replyTo ?? undefined }),
    config: {
      appUrl: cfg.origin,
      siteUrl: cfg.origin,
      supportEmail: smtp.replyTo ?? bareAddress(smtp.from),
      // The operator origin must be NAMED as a permitted link base — the default list is the
      // managed product's own origins, and "mail links wherever an env var points" must stay
      // a property nobody acquires by accident (mail-service.ts states the rule).
      allowedOrigins: [cfg.origin],
      ...(operatorEmail ? { operatorEmail } : {}),
    },
  });
}

/** Everything with process lifetime, built once by `index.ts` and handed to every request. */
export interface ServerRuntime {
  cfg: ServerConfig;
  db: Db;
  services: ApiServices;
  changeWake: ChangeWakeHub | null;
  /** One long-lived token provider — see {@link oauthProviderFor}. */
  oauth: MicrosoftTokenProvider;
  /** Where a setup token minted OUTSIDE boot gets printed — see {@link needsSetupFor}. */
  onSetupTokenMinted: (minted: PairingTokenMinted) => void;
  logger: Logger;
  /** The API alert arm's sinks ({@link alertSinksFor}), built once: the routes and the clock share them. */
  alertSinks: AlertSink[];
  /** The last-resort page's arms ({@link alertArmsFor}): the same arms, the mail one database-free. */
  alertLastResortSinks?: AlertSink[];
  /** `TF_ALERT_HEARTBEAT_URL`, built once ({@link alertHeartbeatForServer}). Absent: off. */
  alertHeartbeat?: AlertHeartbeat;
  /**
   * The handle the API alert pass and its reads run on: this process's pool. This host has one
   * role and no content-blind one, so it is `AlertsConfig.db`. Null only where a test stubs it
   * absent — `/health` then names `alertsFault`, as the routes answer 503.
   */
  alertDb: (() => Promise<Tx>) | null;
}

/**
 * The service bag — built ONCE at boot (no cold starts, so no lazy getters: paying the scrypt
 * decoy warm-up before `listen()` is strictly better than paying it on the first sign-in, and
 * `makeAuthService`'s decoy hash stays computed once per process exactly as the timing-oracle
 * note in the managed composition requires).
 *
 * `entitlementsPort` is DECLARED here rather than absent, and that is the one member of this bag
 * whose absence would have meant something different: `UNMETERED` says this operator runs no
 * entitlements program, where an absent member says nobody finished the composition.
 *
 * WHAT IS ABSENT, against the managed bag, each on purpose (the bag-parity test freezes this
 * list): `waitlist` (no funnel) and `platformSignals` (one hosting platform's request-log API,
 * which a box the operator runs does not have). The subscription members this sentence used to
 * name are on NEITHER bag now — they left with the machinery — so they are not exceptions here
 * either. AI metering is not a member at all: it is the spend half of `entitlementsPort`, which
 * this bag fills with `UNMETERED` above — the operator supplies the model key and pays the model
 * bill themselves, and no spend is ever composed here.
 * `attachmentStaging` is conditional, not absent: armed from `cfg.storage` through the env-kind
 * factory when the operator configured object storage, and absent otherwise (absence ⇒ the mint
 * route answers 503 and sends carry inline bytes — load-bearing, `deps.ts` in packages/api
 * states the semantics).
 */
export function buildServerServices(cfg: ServerConfig, db: Db): ApiServices {
  const { authConfig, keyProvider } = cfg;
  // Built ONCE for the process — the storage client is stateless config + a signing key, and one
  // instance serving every request is the long-running host's shape (the managed bag constructs
  // per cold instance for the same reason).
  const stagingStorage = cfg.storage ? stagingStorageFor(cfg.storage) : null;
    /**
   * THE AI CALL LOG. One line per classification, carrying the provider's request id and the
   * arithmetic — the operator's own record of what their own key is spent on. There is no cost
   * TABLE on this box: usage accounting belongs to whoever meters, and nothing here does.
   */
  const onUsage = (r: AnthropicCallReport): void => {
    console.log(JSON.stringify({ event: "ai_call", ...r }));
  };
  /* ONE mailer for this composition: auth's ceremonies and the customer-mail key share it,
     the way the managed side shares its cached `MailService`. */
  const customerMail = customerMailerFor(cfg);
  const bag: Record<string, unknown> = {
    sync: syncService,
    // UnifiedPush wake registrations, with THIS install's endpoint policy. Strict by default; the
    // operator's explicit TF_PUSH_ALLOW_PRIVATE=1 relaxes it for a distributor on their own LAN.
    // A SEPARATE variable from `TF_PROBE_ALLOW_PRIVATE` on purpose — see config.ts for why one
    // value must not decide both. The organizer reads the same variable, so the two processes
    // cannot disagree about whether a registered endpoint is dialable.
    push: makePushService({
      endpointGuard: makePushEndpointGuard(nodeHostResolver, { allowPrivate: cfg.pushAllowPrivate }),
    }),
    // This deployment is in the admission cap's exact position: several users, one connection
    // budget per upstream account, TWO processes (this one and the organizer) that share no
    // lock. The counter's table exists here — this host runs both journals.
    imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
    // ENFORCING by default; the operator's explicit TF_PROBE_ALLOW_PRIVATE=1 selects the
    // desktop's allow-any for a LAN mail server. See config.ts for the argument.
    probeHostGuard: cfg.probeAllowPrivate
      ? ALLOW_ANY_PROBE_HOST
      : makeProbeHostGuard(nodeHostResolver, { privateSwitch: "TF_PROBE_ALLOW_PRIVATE" }),
    // Asked only where the guard cleared nothing (the switch above set): is a no-TLS mail server
    // on this network? Plaintext is offered for such a server only, per protocol.
    probeScopeResolver: nodeHostResolver,
    // What the operator of THIS server can change, named in a certificate refusal on its own network.
    probeOperatorTrust: "NODE_EXTRA_CA_CERTS",
    // The adapter's own body cap expressed in raw attachment bytes — config.ts derives the pair.
    sendSurfaceMaxTotalBytes: SELF_HOST_SEND_MAX_TOTAL_BYTES,
    // UNMETERED STORAGE, on SELF_HOST_MAILBOX_ALLOWANCE's exact argument above: the operator
    // pays for their own disk, and a value somebody WROTE is the only admissible spelling of
    // that — a bag that declared nothing gets the send route's refusing resolver, never a
    // silent unmetered.
    storageCapOf: async () => UNMETERED_STORAGE_CAP,
    // ── AND THIS IS THE WAY ROUND THAT CAP, when the operator armed object storage ──────────
    // The browser mints a grant, PUTs the bytes straight into the bucket (RustFS on the compose;
    // any S3 endpoint or a Supabase project via TF_STORAGE_KIND), and the send carries a
    // reference — the managed transport verbatim, behind the same factory-over-the-request-db
    // shape. ABSENT when no storage is configured, and the absence is load-bearing: the mint
    // route answers 503, `/hello` reports `staging: false` (it reads THIS member), and inline
    // sends keep working under the body cap above.
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
    // The folder VERBS (stage 2) — wired here because this host HAS a worker lane (the
    // self-host compose runs the same worker image), so the commands it records are executed;
    // `ApiDeps.folderOps`' "a host without a worker lane wires none" carve-out is about the
    // desktop's standalone door, not this one. Found missing by `bag-parity.test.ts` — the
    // verbs slice wired the managed bag and never this one, so a self-host user's folder
    // create/rename/delete answered 500 `folder ops service not configured`.
    folderOps: new FolderOpsService(),
    drafts: draftsService,
    // Send later's two verbs (mail 0077) — this host's own worker lane runs the sender pass.
    schedules: scheduleService,
    drafting: draftingService,
    sends: sendService,
    workflows: workflowsService,
    proposals: proposalsService,
    // Register/verify/factors/OAuth ceremony. `mail` is the SmtpMailer behind MailService when
    // the operator set the SMTP block, and `null` otherwise — a WORKING state, not a gap: the
    // pairing invite path never needs mail (routes/self-host.ts obligation 3 — verification
    // rides the consumed token's own record), and open signup does not exist here. See
    // customerMailerFor for what a mailer adds and why its failure refuses the boot.
    auth: makeAuthService({
      config: authConfig, keyProvider, passwordHasher: scryptHasher, mail: customerMail,
    }),
    // The same `MailService` under the key the managed composition uses, so the two service bags
    // carry one shape — `bag-parity.test.ts` reads them key for key. Nothing on this composition
    // owes a lifecycle notice: no verdict, no wall, nothing to send. A deployment that ever
    // carries one mails through the operator's own SMTP block rather than a second mailer.
    customerMail: customerMail ?? undefined,
    // The `/pair/redeem` invite arm's bridge to the Cloud-half `invites` table — present HERE
    // because this composition's database holds that table (obligation 3, routes/self-host.ts);
    // absent on any deployment that lacks it, where the route answers `validation_failed`.
    inviteRedeem: redeemInviteGrant,
    // Unmetered, stated: no plan, no limit, no manage page, and AI on the operator's own keys.
    entitlementsPort: UNMETERED,
    // Envelope-encrypts mailbox credentials with the SAME provider the organizer decrypts with —
    // the KEK identity on the two /health responses is what proves they agree. The explicit
    // allowance is obligation 1; see SELF_HOST_MAILBOX_ALLOWANCE above.
    mailbox: makeMailboxService({
      keyProvider, allowance: SELF_HOST_MAILBOX_ALLOWANCE,
      // Declared, not absent — see the sidecar's own line for why the two differ.
      accessOf: async () => UNMETERED_ACCESS,
      // The same identity the organizer half writes — see `resolveCloudInstallId`.
      installId: resolveCloudInstallId(process.env),
      /* WHEN THE ORGANIZER'S LAST PASS FINISHED (mail 0097). Wired HERE too and not only on the
         managed API: the self-host tier runs the worker beside this process and writes the same
         heartbeat, so it can answer the strip's "the last pass finished N seconds ago" clause
         exactly as the managed deployment does. Leaving it off would have made an operator's own
         stack the one place that cannot tell a turn from a stall. */
      lastOrganizerCycleAt: organizerCycleReader,
    }),
    // NO adapter injected: a screener/approval decision leaves folder_state pending and the
    // ORGANIZER (apps/worker, running beside this process) applies the IMAP move — one organizer
    // per mailbox is the rule, and this server never opens IMAP to apply organization.
    approval: makeApprovalService({}),
    // The image proxy's outbound fetch — real network by design (that is what strips a tracking
    // pixel's access to the reader's IP), SSRF-gated by the required resolver.
    privacy: makePrivacyService({ remote: nodeRemoteFetch, resolver: nodeHostResolver }),
    // RFC 8058 one-click unsubscribe, per-mailbox authserv trust — the managed wiring verbatim.
    unsubscribe: makeUnsubscribeService({
      post: nodeOneClickPost,
      resolver: nodeHostResolver,
      trustedAuthservIdsFor: mailboxProviderAuthservIds,
    }),
  };

  // The screener: classifier only when the operator configured a model; NO credit gate and no
  // `remaining` reader — this tier is unmetered by design (the operator's key, the operator's
  // model bill), which is the sidecar's grammar exactly. A screen-out arms auto-unsubscribe
  // through the same instance the bag holds, so the two paths cannot diverge in configuration.
  const ai = serverAiPorts(cfg, onUsage);
  bag.screener = makeScreenerService({
    ...(ai.classifier ? { classifier: ai.classifier } : {}),
    unsubscribe: bag.unsubscribe as ReturnType<typeof makeUnsubscribeService>,
  });

  // THE LIVE DRAFTER, armed by the same choice the descriptor reads. Absent, the draft route
  // answers 503 drafter_unconfigured — the state an install with no model is honestly in.
  if (ai.drafter) bag.drafter = ai.drafter;

  return bag as unknown as ApiServices;
}

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
  const suggestMs = cfg.aiTimeoutMs ?? 10_000;
  const draftMs = cfg.aiTimeoutMs ?? 25_000;
  if (ai.provider === "anthropic") {
    const client = (timeoutMs: number) => makeAnthropicClient({
      apiKey: ai.apiKey, timeoutMs, maxRetries: 1, onUsage, fetchImpl,
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

/**
 * The API alert arm's sinks, the organizer's three by the organizer's names: the JSON webhook,
 * the Telegram push (a half-set pair is an arm that refuses every page naming the missing
 * variable), and operator mail over this server's own SMTP block — a SECOND `MailService` carrying
 * `operatorEmail` (`TF_ALERT_EMAIL`), the managed host's shape. Its one write, the per-recipient
 * limiter's `auth_throttle` slot, goes through `db`. Built once at boot. Cannot throw — an
 * observability feature must never cause the outage it exists to report.
 */
export function alertSinksFor(cfg: ServerConfig, logger: Logger, db: Db): AlertSink[] {
  return alertArmsFor(cfg, logger, db).sinks;
}

/**
 * {@link alertSinksFor}'s arms and, beside them, the last-resort page's (`alert-last-resort.ts`):
 * the same objects, names and order, except the mail arm, the same SMTP service with its
 * recipient limiter in memory (`dbFreeMailAlertSink`), since that page is sent because the
 * database is gone. Cannot throw.
 */
export function alertArmsFor(
  cfg: ServerConfig, logger: Logger, db: Db,
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
      logger.error("alert_sink_unavailable", {
        err, sink: name, reason: "an alert sink could not be constructed; it is published as refusing",
      });
      // Kept as an arm that refuses, so `/health`, the pager verdict and the other driver see it.
      const refusing = refusingAlertSink(name, `the ${name} arm could not be built at boot (alert_sink_unavailable)`);
      sinks.push(refusing);
      lastResort.push(refusing);
    }
  };
  add("webhook", () => same(webhookAlertSink(alerts.webhookUrl ?? undefined)));
  add("telegram", () => same(telegramAlertSink({
    botToken: alerts.telegram.botToken ?? undefined, chatId: alerts.telegram.chatId ?? undefined,
  })));
  // `config.ts` refused TF_ALERT_EMAIL without an SMTP block, so both are here or the arm is off.
  const { email } = alerts;
  const { smtp } = cfg;
  if (email && smtp) {
    add("mail", () => {
      const service = smtpMailServiceFor(cfg, smtp, email);
      return {
        sink: mailAlertSink(service, { limiter: dbRecipientLimiter(db), now: () => new Date() }),
        lastResort: dbFreeMailAlertSink(service),
      };
    });
  }
  return { sinks, lastResort };
}

/** `TF_ALERT_HEARTBEAT_URL`, built once at boot. An unusable value is named, never printed. */
export function alertHeartbeatForServer(cfg: ServerConfig, logger: Logger): AlertHeartbeat {
  const heartbeat = alertHeartbeatFor(cfg.alerts?.heartbeatUrl);
  if (heartbeat.state === "unusable") {
    logger.error("alert_heartbeat_unusable", {
      configVar: heartbeat.configVar, reason: "set but not one plain http(s) URL; no heartbeat is sent",
    });
  }
  return heartbeat;
}

/**
 * The Microsoft OAuth2 token source — ONE long-lived provider for the process, the WORKER's
 * lifetime rather than the serverless per-invocation one: this host has no cold starts, the
 * provider's token cache is keyed by mailbox with expiry handled inside it, and `resolveClient`
 * re-reads the config store on every refresh so a rotated client secret takes effect without a
 * restart. The rotation write targets the mailbox's own credential row and is the only write
 * this port makes.
 */
export function oauthProviderFor(cfg: ServerConfig, db: Db): MicrosoftTokenProvider {
  const updateSecret: UpdateSecretPort = (mailboxId, ciphertextEnc, keyVersion) =>
    rotateMailboxOAuthSecret(db, {
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
       * This install can legitimately hold both: a mailbox connected through the operator's own
       * confidential registration, and one connected through the shared public client's device-code
       * flow. A refresh token is only renewable by the client that obtained it, so "which door does
       * this HOST use" has no single answer and `want` — read off the credential's own meta — is the
       * question that does.
       *
       * The public arm resolves from the environment alone: there is no `oauth_provider_config` row
       * for it, and this composition mounts no admin console to manage one. `kind` is STATED on both
       * arms, because the token client re-checks that the door it asked for is the door that
       * answered, and an unlabelled return would agree only by defaulting.
       */
      if (want === "public") {
        return {
          clientId: cfg.msDevice?.clientId ?? "",
          clientSecret: "",
          defaultTenant: cfg.msDevice?.tenant || "common",
          kind: "public",
        };
      }
      const resolved = await resolveOAuthProviderConfig({
        tx: db,
        decrypt: (ct, kv) => cfg.keyProvider.decrypt(ct, kv),
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
    keyProvider: cfg.keyProvider,
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
 * The two session doors' handle (`withSessionAcquireCeiling`): the process pool behind a 5 s wait
 * to begin, the managed host's number. One per pool, built on the first session request.
 */
const sessionHandles = new WeakMap<Db, Db>();
function sessionDbOver(db: Db): Db {
  let handle = sessionHandles.get(db);
  if (!handle) {
    handle = acquireCeilingHandle(db, SESSION_ACQUIRE_TIMEOUT_MS);
    sessionHandles.set(db, handle);
  }
  return handle;
}

/** Build the per-request container. `req` is the ALREADY-NORMALIZED request (see `handler.ts`). */
export function buildDeps(req: Request, rt: ServerRuntime): ApiDeps {
  const { cfg } = rt;
  return {
    db: rt.db,
    sessionDb: () => sessionDbOver(rt.db),
    now: () => new Date(),
    requestId: "",                 // `withRequestId` assigns one
    session: null,                 // `withSession` resolves it
    authConfig: cfg.authConfig,
    keyProvider: cfg.keyProvider,
    services: rt.services,
    sse: cfg.sse,
    // ONE LISTEN for the process, fanned out per account — the extracted change-wake hub over
    // the same plain DATABASE_URL everything else dials (session-capable by nature here).
    changeWake: rt.changeWake,
    allowCookieAuth: allowCookieAuthForRequest(req, cfg.cookieHosts),
    /**
     * **OBLIGATION 4 (`routes/self-host.ts`): stated `false`, EXPLICITLY.** Accounts on this
     * server legitimately arrive unverified — a family invite is a pairing token, its redeemer
     * types their own address, nothing is mailed — and the box may have NO mailer to verify
     * with. The default is REQUIRE on purpose (an absent value must never relax a gate), so a
     * composition root that stays silent here bricks every pairing-invited account at their
     * first mailbox add: a working gate presenting as a broken server. `false` is honest for
     * the same reason requiring is honest on the hosted service — the mailbox add presents an
     * IMAP credential, which proves more about mailbox ownership than a verification mail ever
     * did, and the operator pays for their own box.
     */
    requireVerifiedForProduct: false,
    health: {
      version: cfg.version,
      // BOTH journals — this server has real sign-in, so it has the identity tables, and a
      // health probe that certified the mail half alone would bless a half-migrated database.
      schemaTier: "all",
      kek: cfg.kek,
      kekError: cfg.kekError,
      // The identity trio, resolved by config.ts (file over variable over `dev`): `buildSource`
      // is what lets an ops reader tell a baked label from an operator-typed one.
      buildSource: cfg.buildSource,
      buildError: cfg.buildError,
      // "unrecognized" on an operator's own Postgres is healthy and documented as such — the
      // field exists so the connection guards' blind spots are visible, not as a fault.
      dbProvider: providerFamily(cfg.databaseUrl),
      // Both transport hops; on an operator's own Postgres beside the server, false is the documented default.
      dbTls: (reached: boolean) => readDbTls(cfg.databaseUrl, rt.db, reached),
      // The contract with the managed host: `alertsFault` present ⇔ the routes answer 503. It reads
      // the member the gate runs on (`alerts.db` below), and index.ts always builds that handle, so
      // this is null by construction here; `alertSinks` with no arms is this host's loud signal.
      alertsError: cfg.alerts && !rt.alertDb
        ? "alerting is configured but DARK: no handle for the pass — /internal/alerts* answer 503 " +
          "alerts_db_unarmed and no alert pass runs"
        : null,
      // The arms the pass delivers to and their standing health. Absent with no TF_ALERT_SECRET:
      // no pager by construction (`HealthConfig.alertSinks`); armed with no arm, it reads `[]`.
      alertSinks: cfg.alerts ? () => apiAlertSinkSummary(rt.alertSinks) : null,
    },
    /**
     * What `GET /push/vapid-key` answers. The PUBLIC half only — see config.ts: this process never
     * reads `TF_VAPID_PRIVATE_KEY`, because nothing a request handler does needs the ability to
     * sign a wake. `null` when the operator generated no keypair, which the app renders as a
     * sentence rather than an error.
     */
    vapidPublicKey: cfg.vapidPublicKey,
    // What `GET /hello` answers — this host's capability statement. Every flag reads the SAME
    // member the wiring arms from, so the negotiation cannot disagree with what the routes do.
    hello: {
      flavor: "selfhost",
      needsSetup: needsSetupFor(rt.db, rt.onSetupTokenMinted),
      auth: {
        password: true,
        totp: true,
        webauthn: true,
        // NEVER on this composition — there is no TF_PUBLIC_SIGNUP here and must not be: the
        // first account is the boot-minted setup token, every later one a pairing invite.
        publicSignup: false,
      },
      features: {
        // Free on a long-running server; config.ts pins it enabled with no flag to forget.
        sse: cfg.sse.enabled === true,
        // Reads the BAG, not the parsed config: the descriptor must announce what the routes DO
        // (the mint route answers 503 while the port is absent), not what the environment hopes.
        // `cfg.storage` arms the bag member through the env-kind factory; this reads the member.
        staging: rt.services.attachmentStaging !== undefined,
        // That a model is configured, never which: the provider is the operator's business.
        ai: cfg.ai !== null,
        // OBLIGATION 2: the pairing routes are mounted on this table and this table only, so
        // this descriptor is the one that says true.
        pairing: true,
        // True for the same reason `pairing` is: this composition wires the image proxy's real
        // egress a few lines down (`makePrivacyService({ remote: nodeRemoteFetch, … })`), so
        // `GET /img` here fetches rather than refusing.
        remoteImages: true,
      },
    },
    logger: rt.logger,
    /**
     * WHERE THIS SERVER'S 5xx GO TO BE COUNTED (cloud 0033). `arm: "api"` — a self-hosted box
     * runs one API and one worker exactly as the managed deployment does.
     *
     * `rt.db`, not a fresh handle: one session-capable pool per process, nothing to re-acquire.
     * Wired UNCONDITIONALLY, unlike `alerts` below — this server's database carries the cloud
     * journal whole, and on a box with no pager `/health` plus this table IS the observability.
     */
    faultLog: {
      record: async (fault) => {
        await recordApiFault(rt.db as unknown as Tx, { ...fault, arm: "api" });
      },
    },
    // Armed by TF_ALERT_SECRET (≥ 24 chars); absent ⇒ the /internal/alerts routes answer 404 and
    // no alert clock runs, which is the correct surface for a box nobody armed a pager on.
    alerts: cfg.alerts
      ? {
        secret: cfg.alerts.secret,
        sinks: rt.alertSinks,
        lastResortSinks: rt.alertLastResortSinks ?? [],
        ...(rt.alertHeartbeat ? { heartbeat: rt.alertHeartbeat } : {}),
        environment: cfg.environment,
        // `null`: the bag's port is UNMETERED, so this server parks nobody and every stale
        // mailbox is on duty — the page may say its owner is not receiving mail. For the same
        // reason nobody here has a storage cap, and the rule says so rather than "no reader".
        parkedAccounts: parkedAccountsOf(UNMETERED),
        accountsAtCap: accountsAtCapOf(UNMETERED),
        // And no billing plane to read: `null`, so the plane rules are unread, never clear.
        planeOps: planeOpsReaderOf(UNMETERED),
        // The pass's handle: this host has no content-blind role (`AlertsConfig.db`).
        db: rt.alertDb ?? undefined,
      }
      : undefined,
    // NO admin and NO adminDb: selfHostRoutes carries no admin group, so no route reads across
    // accounts for a person. The one cross-account reader is the alert pass (it reads no content
    // column) on `alerts.db` above, behind TF_ALERT_SECRET. The operator's observability is
    // /health + /internal/alerts.
    msOAuth: cfg.msOAuth,
    /*
     * THE PUBLIC CLIENT — the field that arms the device-code routes this table mounts, and the only
     * composition that supplies it. `null` from the config becomes an ABSENT field rather than a
     * null one, so `deviceFlowAvailable` reads one shape and the availability read answers
     * `device: false` without a second null check.
     */
    ...(cfg.msDevice ? { msDevice: cfg.msDevice } : {}),
    appOrigin: cfg.origin,
    oauth: rt.oauth,
  };
}
