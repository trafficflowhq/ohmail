import {
  noticeSinkFor, setNoticeSink, UNMETERED, accessOf, isMetered,
  type EntitlementsComposition, type SpendPort, type Tx,
} from "@trafficflow/db";
import {
  API_MAX_DURATION_MS, makePooledDb, recordApiFault,
  makeEntitlementsClient,
} from "@trafficflow/db/cloud";
import { adminDbFor, attestStaffDbFault, resetAdminDbs, webhookAlertSink, telegramAlertSink, acquireImapSlot, releaseImapSlot, resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER, // The staging BUCKET client. It sits beside the `attachment_staging` rows rather than with the
  // send path, because the retention sweep's caller is the worker, which may not depend on
  // `@trafficflow/services`. This host is the one place that needs both halves.
  makeSupabaseStagingStorage, // The organizer's last completed pass, for the filing strip (mail 0097).
  organizerCycleReader, type AdminDb, type AlertSink } from "@trafficflow/db/cloud";
import { assertWeightedScheduleActive } from "@trafficflow/db";
import {
  resolveCloudInstallId,
  createLogger, makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  MicrosoftTokenProvider, UNMETERED_STORAGE_CAP,
  type Logger, type FetchLike, type UpdateSecretPort,
  type AnthropicCallReport,
} from "@trafficflow/core";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { makePushEndpointGuard } from "@trafficflow/core/net";
import {
  makeAuthService, makeMailboxService, makeScreenerService, makeApprovalService,
  makePrivacyService, makeUnsubscribeService, nodeOneClickPost,
  nodeRemoteFetch, nodeHostResolver, scryptHasher,
  syncService, makePushService, rulesService, messageService, threadService, triageService,
  searchService, contactsService, snippetsService, notifyRulesService, awayResponderService,
  attachmentsService, kbService, tagsService, folderOpsService, draftsService, draftingService, sendService,
  scheduleService,
  SEND_ATTACHMENT_MAX_TOTAL_BYTES,
  makeAttachmentStagingPort,
  workflowsService, proposalsService,
  MailService, ResendMailer, mailAlertSink, dbRecipientLimiter, makeWaitlistService,
  type ServiceContext,
  makePlatformSignalPort,
} from "@trafficflow/services";
import {
  makeProbeHostGuard, apiAlertSinkSummary, API_FAULT_RECORD_BUDGET_MS,
} from "@trafficflow/api";
import type { ApiDeps, ApiServices, ChangeWakeHub } from "@trafficflow/api";
import { allowCookieAuthForRequest, type HostConfig } from "./config.js";
import { makeChangeWakeHub } from "./wake-hub.js";

/**
 * The per-request {@link ApiDeps} for the serverless host. Two lifetimes: per cold instance,
 * the service bag and the pooled `Db` (`makePooledDb` is module-cached per connection string
 * so a warm instance reuses one connection; `makeAuthService` memoises the decoy password
 * hash per hasher to keep the unknown-email path constant-time — rebuilding it per request
 * is a timing oracle); per request, `session`, `requestId`, `idempotency`, and
 * `allowCookieAuth`, which depends on the host the request arrived on.
 */

let servicesCache: { key: object; services: ApiServices } | null = null;

/**
 * The per-instance wake hub, memoised per HostConfig for the service bag's reason: the hub IS
 * the "one LISTEN connection per instance" invariant, so building one per request would be one
 * pinned session-mode backend per request — the exact exhaustion `wake-hub.ts` exists to avoid.
 */
let wakeHubCache: { key: object; hub: ChangeWakeHub } | null = null;

function wakeHubFor(cfg: HostConfig): ChangeWakeHub {
  if (wakeHubCache && wakeHubCache.key === cfg) return wakeHubCache.hub;
  const hub = makeChangeWakeHub(cfg.sseListenUrl!, hostLogger(cfg));
  wakeHubCache = { key: cfg, hub };
  return hub;
}

/**
 * Where a billing failure becomes something a human can find: the webhook's failure path is
 * correct and silent (500, `billing_events.status = 'failed'`, retried by Stripe, then
 * nothing), and this is the one place that turns it into an external signal. `console.error`
 * is the log stream the platform indexes, so a single greppable token (`billing_alert`) with
 * a fixed shape is what a log-drain rule needs. What it may carry is bounded by the
 * `BillingAlert` type — a code, an event id, a type, an account id — never a payload or
 * anything that could quote a connection string.
 */
/**
 * The service bag. Keyed on the config object so a test that loads a different environment
 * gets a different bag, while production — one config per cold instance — builds it once.
 */
function servicesFor(cfg: HostConfig): ApiServices {
  if (servicesCache && servicesCache.key === cfg) return servicesCache.services;
  const services = buildServices(cfg);
  servicesCache = { key: cfg, services };
  return services;
}

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

function buildServices(cfg: HostConfig): ApiServices {
  const { authConfig, keyProvider } = cfg;
  /**
   * The cost recorder, built once per configuration and shared by both AI clients below.
   * `makePooledDb` memoises by URL, so this names the same connection `buildDeps` hands every
   * request. `host: "api"` is a literal, never derived from the environment: it is in the
   * cost table's primary key, and three processes writing under one name would make "which
   * arm stopped recording" unanswerable. On this host the recorder writes per call and the
   * client awaits the promise: a serverless process can be frozen the instant its response
   * is written, so a floating write may never land.
   */
  const onUsage = (r: AnthropicCallReport): void => {
    console.log(JSON.stringify({ event: "ai_call", ...r }));
  };
  // The stateless singletons: naming them is free, so they are plain properties.
  const bag: Record<string, unknown> = {
    sync: syncService,
    // UnifiedPush wake registrations are accepted here because this root states the endpoint
    // policy, and the policy is STRICT with no env escape: an endpoint on this host is dialled by
    // the managed worker inside the managed network, so https-only and public-addresses-only are
    // not negotiable and there is deliberately no `TF_PUSH_ALLOW_PRIVATE` read on this arm. Same
    // required-resolver rule as `probeHostGuard` below — the DNS port can never quietly default.
    push: makePushService({
      endpointGuard: makePushEndpointGuard(nodeHostResolver, { allowPrivate: false }),
    }),
    // The hosted deployment IS the thing the admission cap protects: many tenants, one connection
    // budget per upstream account, two processes (this one and the worker) that share no lock.
    imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
    // The add-time IMAP/SMTP probe's SSRF gate. ENFORCING here, because the probe dials a host the
    // caller typed and this is a multi-tenant network: a private/loopback/link-local target or a
    // non-mail port is refused before the socket opens. The resolver is `nodeHostResolver` for the
    // same reason the image proxy names it — the SSRF gate's DNS port is required at construction so
    // it can never quietly default to `node:dns`. The desktop engine wires ALLOW_ANY instead.
    probeHostGuard: makeProbeHostGuard(nodeHostResolver),
    // This host's request-body limit, in raw attachment bytes. Attachment bytes ride the send
    // request base64-encoded, so their total must clear the platform's ~4.5 MB body cap with
    // room for the JSON envelope and the ~1.33× inflation; 3 MB raw encodes to about 4 MB.
    // `SendService` caps a send at the smaller of this and what the sending mailbox's own
    // submission server announced. Declared even though it equals the default: the absent case
    // exists for a host that has not been read, and this deployment has been.
    sendSurfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
    // THE METERED STORAGE CAP — this is the hosted deployment, the one composition that reads
    // the subscription row instead of typing UNMETERED_STORAGE_CAP. It feeds the send route's
    // sent-copy projection; the sync worker threads the same read into ordinary ingest, so
    // whichever path commits an own-sent copy first, the cap it consulted is the same one.
    // `null` from the read is the documented fail-open for an account with no subscription row
    // at all (the roster keeps such accounts syncing; storage follows), and it maps to the
    // typed unmetered value rather than leaking a second spelling of it.
    storageCapOf: async (ctx: ServiceContext) => {
      const verdict = await accessOf(entitlementsComposition(), ctx.accountId);
      const cap = verdict.ok ? verdict.limits.storageBytes : null;
      return cap === null ? UNMETERED_STORAGE_CAP : cap;
    },
    // The way around that ceiling: a transport with no request body in it. The browser mints a
    // grant here, PUTs the bytes straight into a private bucket, and the send carries a
    // reference; `SendService` reads the surface as uncapped for such a send and the mailbox's
    // own announced `SIZE` is the only ceiling left. A factory over the request's database
    // handle — the bag is per cold instance, a handle is not. Absent on a deployment with no
    // storage environment, and the absence is load-bearing: the mint route answers 503, the
    // client falls back to inline bytes, and a send naming staged references is refused.
    ...(cfg.attachmentStaging
      ? {
        attachmentStaging: (db: Tx) => makeAttachmentStagingPort({
          db,
          storage: makeSupabaseStagingStorage(cfg.attachmentStaging!),
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
    folderOps: folderOpsService,
    drafts: draftsService,
    // Send later's two verbs (mail 0077) — the worker's scheduled-send pass is the sender.
    schedules: scheduleService,
    drafting: draftingService,
    /* THE AI SPEND GATE IS COMPOSED ONCE, NOT PER ROUTE — see `entitlementsPort` below.
     *
     * This was `aiCredits`, a factory building a `debit_draft` gate per request with
     * `retryWindowMs: IDEMPOTENCY_TTL_MS` as its one non-default option. Both halves moved: the
     * spend half of the entitlements port answers the money question for every call site, and the
     * draft path's retry window is a property of the ACTION (`SPEND_ACTIONS.draft`) rather than of
     * whichever host happened to remember it. What did NOT move is the consequence for this
     * route: `POST /messages/:id/draft` still requires the client's `Idempotency-Key` whenever
     * something meters, because half of a draft's attempt key is that header.
     */
    // `sendAdapter` is deliberately ABSENT: leaving it unset is what makes the send route use
    // the real `makeSendAdapter`. A test injects it; production must not fake it.
    sends: sendService,
    workflows: workflowsService,
    proposals: proposalsService,
  };

  // The constructed services, deferred: `auth` runs scrypt over the decoy password; the others
  // build dependency graphs no health probe needs. `mail` is handed in so `register` can send
  // the verification (or `account_exists`) mail that is the only continuation of a constant
  // 202 — the same cached `MailService` the waitlist uses, never a bare `ResendMailer` (a
  // service holding the port holds an unthrottled mail-bomb primitive; see
  // `packages/services/src/mail/port.ts`). `null` with no mailer: `AuthService.register`
  // answers 503 `signup_unavailable` rather than creating accounts whose verification link
  // can never be sent. `customerMailerFor` cannot throw.
  lazily(bag, "auth", () => makeAuthService({
    config: authConfig, keyProvider, passwordHasher: scryptHasher,
    mail: customerMailerFor(cfg),
  }));
  // Envelope-encrypts mailbox credentials with the SAME provider the worker decrypts them
  // with — the KEK ring identity on `/health` is what proves those agree (risk 2).
  //
  lazily(bag, "mailbox", () => makeMailboxService({
    keyProvider,
    /* THE ACCESS VERDICT the allowance gate decides the LIMIT from, read before the create
       transaction opens. It reads the bag's OWN port member, so the gate and everything else that
       asks about this account's standing cannot answer differently.

       No `?? UNMETERED` fallback, deliberately: this host arms the member unconditionally below,
       so a fallback would be a branch nobody can reach and every later reader would take for a
       guarantee — while quietly being the unbounded-limit default the paid gate exists to refuse.
       An absent member here is a composition bug and says so. */
    accessOf: (accountId) => {
      const composed = bag.entitlementsPort as EntitlementsComposition | undefined;
      if (composed === undefined) {
        throw new Error("api-vercel: `entitlementsPort` is not on the service bag — the mailbox "
          + "allowance gate has no limit to read. It is armed unconditionally; this is a bug.");
      }
      return accessOf(composed, accountId);
    },
    /* WHO THIS DEPLOYMENT IS TO A MAILBOX, resolved through the SAME function the worker
       resolves it with. The release asks whether a claim is ours, which is an identity
       question; answering it with the holder's KIND accepted another Cloud deployment's claim.
       If the two ever derive different ids the hand-back is refused everywhere, which is the
       safe direction and a visible one. */
    installId: resolveCloudInstallId(process.env),
    /* WHEN THE ORGANIZER'S LAST PASS FINISHED, for the filing strip's "the last pass finished N
       seconds ago" clause (mail 0097) — the fact that separates a mailbox waiting its turn in the
       rotation from one waiting on nothing. Injected rather than imported by the builder for the
       reason `allowance` is: `worker_heartbeats` is a Cloud table and that module is inside the
       desktop engine's import closure. Passed BY REFERENCE, so the wiring is greppable. */
    lastOrganizerCycleAt: organizerCycleReader,
  }));
  // No adapter injected: a screener or approval decision leaves `folder_state` pending and
  // the worker applies the IMAP move — the serverless host never opens IMAP to apply
  // organization; one organizer per mailbox. The screener gate is `debit_classify`, not
  // `debit_draft`: its pre-suggestion is a classification. Suggestions are persisted and
  // generated only on `POST /screener/suggest` over an explicit, priced sender set; `list`
  // cannot reach the classifier (destructured out of the read-only deps), so wiring it here
  // cannot recreate a model call per scroll. A batch is at most `MAX_SUGGEST_SENDERS` serial
  // classifies inside one invocation (`maxDuration 60`), spend recorded per message, so each
  // call gets a tight deadline and one retry — a slow model fails one sender, never the run.
  const anthropicApiKey = cfg.anthropicApiKey;
  // The arming guard: the production managed-AI arm refuses a flat debit schedule. It sits at
  // the hoist so both the screener's classifier and the drafter are covered by one statement.
  // The condition is the production shape: a model key AND the billing plane (the plane is
  // where subscriptions and the allowance exist; a key with no plane is a preview or
  // self-host shape with no ledger for a mis-priced debit). A hard throw, unlike
  // `loadAlertsConfig`'s soft null: a deployment that prices a draft like a classification
  // undercharges every customer for as long as it serves, and that is not recoverable after
  // the fact. After the weighted schedule shipped it passes by construction; it exists for
  // the revert.
  if (anthropicApiKey && cfg.entitlements) assertWeightedScheduleActive();
  /**
   * THE SPEND HALF OF WHATEVER THIS HOST DECLARED, or nothing when it meters nothing.
   *
   * Read from the bag rather than composed a second time: `entitlementsPort` below is memoised,
   * and the port caches an account's access verdict, so two instances would each cache their own.
   * Called from inside a lazy factory, so the getter it reads is defined by then.
   */
  const spendHalf = (): SpendPort | undefined => {
    const composed = bag.entitlementsPort as EntitlementsComposition | undefined;
    return composed !== undefined && isMetered(composed) ? composed : undefined;
  };
  lazily(bag, "screener", () => makeScreenerService({
    /* This host is killed by a platform, and it is the only one that is: `maxDuration = 60`
     * on the catch-all route this bag serves. `ScreenerService.suggest` admits a sender's
     * purchase only while there is time to finish the model call and the write after it, and
     * that window means nothing without this number, so it is stated beside the route that
     * declares it. `API_MAX_DURATION_MS` and not a literal: it is the canonical spelling, the
     * route's `maxDuration` is pinned to it (`host-wiring.test.ts`), and the pool timeouts
     * derive from it — a second copy would drift silently when the duration changes.
     */
    invocationBudgetMs: API_MAX_DURATION_MS,
    /* THE SCREENER'S TERMS ARE THE ACTION'S, and this is where they used to be chosen.
     *
     * The exclusive claim that closes the concurrent double-purchase race, and the `withSetupPool`
     * wrapper that draws each mailbox's screening-only grant before the main balance, were both
     * composed HERE — and the worker had to compose the same two, from its own code, for the cron
     * half of the same call site. A host that got one of them wrong gave the Screener another call
     * site's terms; that disagreement was a real defect, in which setup-funded spends skipped the
     * claim entirely. Both now come from `SPEND_ACTIONS.screener`, which the entitlements program
     * reads from its own copy of the same table.
     */
    // The spend half of whatever this host declared, read off the bag so there is ONE port per
    // process — it caches its access verdicts, and a second instance would cache separately.
    ...(spendHalf() ? { credits: spendHalf()! } : {}),
    ...(anthropicApiKey ? {
      classifier: makeHaikuClassifier({
        client: makeAnthropicClient({
          apiKey: anthropicApiKey,
          timeoutMs: 10_000,
          maxRetries: 1,
          onUsage,
        }),
      }),
    } : {}),
    // A screen-out arms auto-unsubscribe. Passed as a THUNK-free reference to the same
    // bag entry so the two paths can never end up with two different services: the drain's
    // idempotency lives in one unique index, and a second instance would still be correct,
    // but a second CONFIGURATION (a different trusted-authserv set) would not be.
    unsubscribe: bag.unsubscribe as ReturnType<typeof makeUnsubscribeService>,
  }));
  lazily(bag, "approval", () => makeApprovalService({}));
  // The image proxy's outbound fetch. Real network, by design — that is what strips a
  // tracking pixel's access to the reader's IP. This is the ONE place `nodeHostResolver`
  // is named: the SSRF gate's DNS port is required at construction precisely so it can
  // never quietly default to `node:dns` inside a service.
  lazily(bag, "privacy", () => makePrivacyService({
    remote: nodeRemoteFetch,
    resolver: nodeHostResolver,
  }));

  // Auto-unsubscribe. The second real outbound port on this host, after the image proxy, and
  // it takes the same `nodeHostResolver` for the same reason: the SSRF gate's DNS port is
  // required at construction so it can never quietly default to `node:dns` inside a service —
  // a sender's one-click URL is a caller-influenced host, so the gate is what stands between
  // a `List-Unsubscribe` header and a request to the metadata service. Authserv trust is per
  // mailbox, not per deployment: `mailboxProviderAuthservIds` reads the IMAP host off the
  // message's own credential row and maps Gmail/Microsoft to their signing authserv-id;
  // unknown providers resolve to the empty set, and the demote-only rule means that blocks
  // nothing. Lazy like the rest: a `GET /health` cold start builds none of it.
  lazily(bag, "unsubscribe", () => makeUnsubscribeService({
    post: nodeOneClickPost,
    resolver: nodeHostResolver,
    trustedAuthservIdsFor: mailboxProviderAuthservIds,
  }));

  /**
   * THE ENTITLEMENTS PORT — one of two answers, never absent on this host.
   *
   * `ENTITLEMENTS_URL` set ⇒ the HTTP client of that program. Unset ⇒ `UNMETERED`: unbounded
   * limits, and AI gated only by a configured provider key. Memoised, because the client caches
   * its access verdicts and a second instance would cache separately.
   */
  let composed: EntitlementsComposition | null = null;
  const entitlementsComposition = (): EntitlementsComposition => {
    composed ??= cfg.entitlements
      ? makeEntitlementsClient({ baseUrl: cfg.entitlements.url, secret: cfg.entitlements.secret })
      : UNMETERED;
    return composed;
  };
  lazily(bag, "entitlementsPort", () => entitlementsComposition());

  // What the platform served — the 5xx poller's read port (cloud 0030). Composed
  // unconditionally: the port itself decides whether it is configured and answers
  // `unconfigured` without a token. Gating composition on the token would collapse the two
  // states this seam separates — no port answers `skipped` ("nobody wired the question"),
  // a port with no token answers "we asked" — and only the second renders honestly as
  // "5xx: not measured". It reads `process.env` directly and narrowly: the platform token is
  // not a value `config.ts` validates, and adding one would make an absent token a boot-time
  // concern for a host that must boot fine without it. Lazy, like every constructed service.
  lazily(bag, "platformSignals", () => makePlatformSignalPort({
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
    VERCEL_SIGNAL_PROJECTS: process.env.VERCEL_SIGNAL_PROJECTS,
  }));

  // The live drafter. `POST /messages/:id/draft` calls this; absent, the route 500s cleanly.
  // Lazy: `makeAnthropicClient` builds a closure and retry policy no health probe needs.
  // `onUsage` goes both to the `console.log` line (`ai_call` is greppable in the log drain
  // and carries Anthropic's request id) and to `ai_usage_daily` through the recorder above —
  // awaited here, buffered on the worker. The screener's classifier is deliberately not
  // wired in this block: a model call per eligible held row on every `list` was the hazard,
  // closed by persisting suggestions behind `POST /screener/suggest`; the classifier is
  // constructed inside the screener block above, and this client is tuned for one drafting
  // call (25 s, one retry), not a batch of classifications.
  if (anthropicApiKey) {
    lazily(bag, "drafter", () => makeSonnetDrafter(makeAnthropicClient({
      apiKey: anthropicApiKey,
      // A Vercel function has `maxDuration 60`; a drafting request that outlives it is a 504
      // the client cannot distinguish from a hang. One retry inside 25 s leaves room for the
      // context assembly that precedes it and for the draft write that follows.
      timeoutMs: 25_000,
      maxRetries: 1,
      onUsage,
    })));
  }

  // The funnel. ALWAYS built, even with no mailer: `POST /waitlist` recording the
  // signup is the durable half and must not depend on the mailer being configured. The mailer,
  // when there is one, is wrapped in `MailService` and never handed over bare — a route
  // holding a raw `MailerPort` has an unthrottled mail-bomb primitive.
  //
  // `customerMailerFor` cannot throw (see its doc), so an unusable `MAIL_APP_URL` costs the
  // waitlist its confirmation mail and costs the deployment nothing else.
  lazily(bag, "waitlist", () => makeWaitlistService({ mail: customerMailerFor(cfg) ?? undefined }));

  return bag as unknown as ApiServices;
}

/**
 * The `MailService` customer mail goes through, or `null`. Separate from
 * {@link alertSinksFor}'s instance: that one is constructed with an `operatorEmail` and
 * exists to reach a pager; sharing one object would put two threat models in one
 * configuration. It cannot throw: `MailService`'s constructor validates its link bases and
 * throws on a bad one — correct for a composition root, catastrophic here on the path of
 * every request. A malformed `MAIL_APP_URL` must cost the deployment its outbound mail, not
 * its availability; `WaitlistService` treats the absence as "record the row, `mailed: false`".
 */
let customerMailCache: { key: object; mail: MailService | null } | null = null;

function customerMailerFor(cfg: HostConfig): MailService | null {
  if (customerMailCache && customerMailCache.key === cfg) return customerMailCache.mail;
  let mail: MailService | null = null;
  if (cfg.mail) {
    try {
      mail = new MailService({
        mailer: new ResendMailer({
          apiKey: cfg.mail.apiKey, from: cfg.mail.from, replyTo: cfg.mail.replyTo ?? undefined,
        }),
        config: {
          appUrl: cfg.mail.appUrl,
          siteUrl: cfg.mail.siteUrl,
          adminUrl: cfg.mail.adminUrl,
          supportEmail: cfg.mail.supportEmail,
          // No `operatorEmail`: this instance must not be able to mail the pager.
        },
      });
    } catch (err) {
      hostLogger(cfg).error("customer_mailer_unavailable", {
        err, reason: "transactional mail is disabled on this deployment; signups are still recorded",
      });
    }
  }
  customerMailCache = { key: cfg, mail };
  return mail;
}

/**
 * The alert sinks this host can reach, built once per cold instance. Two, sharing no vendor
 * (a JSON webhook push and operator mail): a delivery path that fails silently is
 * indistinguishable from none, so the pager does not get exactly one. Cached on the config
 * object like the service bag. It cannot throw: this runs inside `buildDeps` on the path of
 * every request, and an observability feature must never cause the outage it exists to
 * report — a sink that cannot be constructed is not added, the pass reports `undeliverable`,
 * and the product serves.
 */
let sinksCache: { key: object; sinks: AlertSink[] } | null = null;

function alertSinksFor(cfg: HostConfig): AlertSink[] {
  if (sinksCache && sinksCache.key === cfg) return sinksCache.sinks;
  const sinks: AlertSink[] = [];
  const alerts = cfg.alerts;
  if (alerts) {
    try {
      const hook = webhookAlertSink(alerts.webhookUrl ?? undefined);
      if (hook) sinks.push(hook);
      // The PUSH arm — the pager's second vendor, and this host is the only observer of a dead
      // worker, so a single-vendor delivery path here is the version of the problem that can
      // coincide with the outage it is meant to report. Built before the mail sink because it
      // needs no `MailService` and therefore cannot be the thing that throws in this block.
      const push = telegramAlertSink({
        botToken: alerts.telegram?.botToken ?? undefined,
        chatId: alerts.telegram?.chatId ?? undefined,
      });
      if (push) sinks.push(push);
      if (alerts.mail && alerts.operatorEmail) {
        const mailer = new ResendMailer({
          apiKey: alerts.mail.apiKey,
          from: alerts.mail.from,
          replyTo: alerts.mail.replyTo ?? undefined,
        });
        const service = new MailService({
          mailer,
          config: {
            appUrl: alerts.mail.appUrl,
            siteUrl: alerts.mail.siteUrl,
            adminUrl: alerts.mail.adminUrl,
            supportEmail: alerts.mail.supportEmail,
            operatorEmail: alerts.operatorEmail,
          },
        });
        // A limiter, not a database: `sendOperatorAlert` uses it for exactly one thing —
        // claiming an `auth_throttle` slot — so that is what it is handed; the unrestricted
        // runtime handle stays here in the composition root, the shape the `/admin/*`
        // callbacks take. It cannot move onto the blind handle: `ohmail_admin` has no grant
        // on `auth_throttle`, and inventing one would widen the staff role to buy nothing.
        sinks.push(mailAlertSink(service, {
          limiter: dbRecipientLimiter(makePooledDb(cfg.databaseUrlPooled)),
          now: () => new Date(),
        }));
      }
    } catch (err) {
      // Structured, and it names no value: the thing most likely to be malformed here is a
      // URL from an env var, and this line goes to a log drain.
      hostLogger(cfg).error("alert_sink_unavailable", {
        err, reason: "an alert sink could not be constructed; the pass will report undeliverable",
      });
    }
  }
  sinksCache = { key: cfg, sinks };
  return sinks;
}

/** Build the request container. `req` is the ALREADY-NORMALIZED request (see `prefix.ts`). */
export function buildDeps(req: Request, cfg: HostConfig): ApiDeps {
  const db = makePooledDb(cfg.databaseUrlPooled);
  return {
    db,
    now: () => new Date(),
    requestId: "",                 // `withRequestId` assigns one
    session: null,                 // `withSession` resolves it
    authConfig: cfg.authConfig,
    keyProvider: cfg.keyProvider,
    services: servicesFor(cfg),
    sse: cfg.sse,
    // The `/events` push relay: ONE LISTEN connection per warm instance, fanned out in process
    // (`wake-hub.ts`). Built only when this host both streams AND has a session-mode URL to
    // hold the LISTEN on; in every other state the route's poll loop is the only wake source,
    // which is the pre-push behaviour exactly.
    changeWake: cfg.sse.enabled !== false && cfg.sseListenUrl
      ? wakeHubFor(cfg)
      : null,
    allowCookieAuth: allowCookieAuthForRequest(req, cfg.cookieHosts),
    // The verified-address product policy, stated rather than defaulted: this host requires a
    // proven address before the costly route classes (`withSpendGate`). Absence already means
    // REQUIRE, so this line changes nothing today — it exists so the hosted composition is
    // never the one leaning on a fallback, and so a future default change cannot move this
    // deployment's behaviour without touching this file.
    requireVerifiedForProduct: true,
    health: {
      version: cfg.version, buildSource: cfg.buildSource, kek: cfg.kek, kekError: cfg.kekError,
      buildError: cfg.buildError,
      // Non-fatal by design: `/health` names it and still answers 200, because an unarmed
      // STAFF console is not a reason to take the product host out of rotation.
      adminError: cfg.adminError,
      // The content-blind ATTESTATION as a `/health` capability, non-fatal. Present
      // only when this host has a blind connection to attest; it awaits the SAME memoised
      // factory a staff request builds (`staffDbFor`), so the census runs once per cold instance
      // and `/health` names a wrong-but-plausible `DATABASE_URL_ADMIN` minutes before a staff
      // request would 503 on it. `attestStaffDbFault` never throws and returns only
      // catalog-safe text.
      staffDbAttestation: cfg.staffDb
        ? () => attestStaffDbFault(staffDbFor(cfg.staffDb!.url))
        : null,
      // Also non-fatal, and for the STRONGER version of the same reason: this field
      // exists because the pager is dark, and 503-ing the product over that would be the
      // observability feature causing the outage it exists to report.
      alertsError: cfg.alertsError,
      // Not a fault at all: the family of the runtime connection, so an operator reading
      // `/health` can see whether the connection guards still recognise this provider. They
      // silently did not for a day after a database-provider move.
      dbProvider: cfg.dbProvider,
      // Whether this host reaches an entitlements program at all, on dbProvider's pattern.
      // Reads the SAME config member `buildServices` arms from, so the marker cannot disagree
      // with the wiring.
      entitlements: cfg.entitlements ? "configured" : "unmetered",
      // The pager's arms, published where an operator already looks. Unconditional,
      // `cfg.alerts` null included: `arms: []` is the loud statement that this deployment
      // cannot page anybody, and gating on `cfg.alerts` would make the key vanish in exactly
      // that state — `alertsError` only fires when the credential is configured. A closure,
      // so the streak is read at `/health` time, and `alertSinksFor` is the same cached list
      // `deps.alerts` hands the pass — one composition, not a second opinion.
      alertSinks: () => apiAlertSinkSummary(alertSinksFor(cfg)),
    },
    /**
     * What `GET /push/vapid-key` answers — the PUBLIC half of the wake-signing keypair.
     *
     * Read straight from the environment because it is a per-deployment constant with no policy
     * attached: it is not a secret (every device that registers gets it, and it rides in the clear
     * in the `k=` field of every wake), so there is nothing here to gate. `TF_VAPID_PRIVATE_KEY`
     * is NOT read on this arm and must never be — the managed worker signs, this service does not,
     * and a signing key in the serverless surface would be a capability with no caller.
     */
    vapidPublicKey: (process.env.TF_VAPID_PUBLIC_KEY ?? "").trim() || null,
    // What `GET /hello` answers — this host's capability statement, on `health`'s injection
    // pattern. Every feature flag reads the SAME config member the wiring arms from, so the
    // negotiation cannot disagree with what the routes actually do.
    hello: {
      flavor: "managed",
      // The account lifecycle lives on this service permanently: there is no first-account
      // ceremony to run, whatever the user count says.
      needsSetup: false,
      auth: {
        // The full auth surface is mounted and armed here; open registration is the one
        // ceremony that is a configuration rather than a constant.
        password: true,
        totp: true,
        webauthn: true,
        // BOTH halves of the ceremony, not just the flag: with the open gate on and no
        // customer mailer, `AuthService.register` refuses 503 `signup_unavailable` (the
        // verification mail is the only continuation of its constant 202), so a descriptor
        // reading the flag alone would announce a ceremony this host cannot complete. The
        // SAME memoised mailer `makeAuthService` is handed decides the answer here.
        publicSignup: cfg.authConfig.publicSignup && customerMailerFor(cfg) !== null,
      },
      features: {
        // The same flag that decides whether `GET /events` streams (503 `sse_disabled` off).
        sse: cfg.sse.enabled === true,
        // Armed with the staging bucket: `POST /attachments/staging` answers 503 without it.
        staging: cfg.attachmentStaging !== null,
        // Armed with the model key: the draft/suggest surfaces answer 503 without it.
        ai: cfg.anthropicApiKey !== null,
        // The pairing ceremony is mounted on this table (managed device pairing — the webapp's
        // Devices pane mints, a phone redeems for a bearer pair). A CONSTANT, unlike the three
        // flags above, because the mount is structural: `apiRoutes` carries the routes in every
        // deployment of this host, with no environment arm to read. Device-pair only in effect —
        // this bag wires no `services.inviteRedeem`, so both invite arms refuse; the descriptor
        // still says `true` because the capability the picker gates on IS device pairing.
        pairing: true,
      },
    },
    // `withRequestId` binds `requestId` onto this, so every line downstream carries the
    // id the client also got back in `x-request-id`. Built per request because the binding is
    // per request; the underlying sink is `console.log`, so this costs three closures.
    logger: hostLogger(cfg),
    /**
     * WHERE THIS HOST'S 5xx GO TO BE COUNTED (cloud 0033). `arm: "api"` is a literal for
     * `aiUsage`'s reason above — two processes under one name make "which host" unanswerable.
     *
     * A FRESH pooled handle, not the request's `db`: the branch answering `503 db_busy` is the
     * one whose handle just refused an acquire, so recording through it would be a second
     * refusal by construction. Same module-cached pool, so no extra connection.
     */
    faultLog: {
      record: async (fault) => {
        await recordApiFault(
          // A SHORT ACQUIRE CEILING ON THIS HANDLE, which is the other half of
          // `API_FAULT_RECORD_BUDGET_MS`. The middleware bounds how long the write may delay the
          // answer; this bounds how long the abandoned write goes on waiting afterwards. Without
          // it a refused insert sits on `POOLED_ACQUIRE_TIMEOUT_MS` (15 s) holding a queue slot
          // in front of the next request's own query, on the one pool a starved instance has.
          //
          // `makePooledDb`'s `acquireTimeoutMs` exists for exactly this: the ceiling is a
          // property of the HANDLE, not the pool, so this costs no connection and changes
          // nothing for any other caller of the same module-cached pool.
          makePooledDb(cfg.databaseUrlPooled, {
            acquireTimeoutMs: API_FAULT_RECORD_BUDGET_MS,
          }) as unknown as Tx,
          { ...fault, arm: "api" },
        );
      },
    },
    cronSecret: cfg.cronSecret,
    alerts: cfg.alerts
      ? {
        secret: cfg.alerts.secret,
        // `?? undefined` and not `?? ""`: the run route treats an empty string as "no cron
        // credential configured", and a config that says `null` must not become a second
        // accepted secret whose value is the empty string.
        cronSecret: cfg.alerts.cronSecret ?? undefined,
        sinks: alertSinksFor(cfg),
        environment: cfg.environment,
      }
      : undefined,
    // ABSENT ⇒ every `GET /admin/*` answers 404 — a deployment with no
    // `TF_ADMIN_SECRET` has no admin console, which is the state every host is in until
    // somebody arms it deliberately.
    admin: cfg.admin ? { secret: cfg.admin.secret, environment: cfg.environment } : undefined,
    // The content-blind staff connection, armed by `DATABASE_URL_ADMIN` ALONE.
    //
    // It used to read `cfg.admin.databaseUrl`, which meant the console's credential decided
    // whether the PAGER had a database. It does not any more: `loadAdminConfig` requires this
    // half, this half requires nothing of `loadAdminConfig`, so an unarmed console leaves
    // `/internal/alerts*` running. A ternary and not a `??`: there is no value this may fall
    // back to, because the only other handle in this process is the one that can read every
    // account's mail.
    adminDb: cfg.staffDb ? staffDbFor(cfg.staffDb.url) : undefined,
    /**
     * The ENV BOOTSTRAP for the Microsoft application registration. Passed as data, so
     * no route reads `process.env`; the accepted variable NAMES (and the `MICROSOFT_*` aliases) are
     * resolved once in `loadHostConfig` through the same `msOAuthEnv` the worker calls.
     */
    msOAuth: cfg.msOAuth,
    /* The OAuth bounce's redirect target. `?? undefined` and not `?? ""`: the route reads an ABSENT
     * value as "fall back to `defaultOrigin(authConfig)`", and an empty string would make
     * `new URL(path, "")` throw inside a redirect handler. */
    appOrigin: cfg.appOrigin ?? undefined,
    /**
     * The OAuth token source, per invocation — the token cache is keyed by mailbox and a
     * serverless invocation serves one request, so a per-request instance spares a redundant
     * token POST when the same mailbox is dialled twice (a send that also appends to Sent)
     * and caches nothing across requests, where a stale token is a liability. Built
     * unconditionally: the refusal for a missing client secret has to name the variable,
     * which only happens if the provider exists to be asked; a password-only deployment
     * never invokes it.
     */
    oauth: oauthProviderFor(cfg, db),
    /* The token-endpoint port. Production is Node's global `fetch`; it is left ABSENT
     * rather than assigned, so the route's own fallback is the single expression that names it. */
  };
}

/**
 * The per-invocation Microsoft token source. `resolveClient` reads the config store on every
 * refresh, env as fallback, through the same resolver the worker and onboarding routes use —
 * a client secret rotated in the admin console takes effect without a redeploy, and this
 * host and the worker cannot sign with different clients. The rotation write targets the
 * mailbox's own imap credential row and is the only write this port makes.
 */
function oauthProviderFor(cfg: HostConfig, db: ApiDeps["db"]): MicrosoftTokenProvider {
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
       * This host has one door: the managed deployment serves the redirect ceremony and does
       * not mount the device-code routes, so no mailbox here holds a token from the public
       * registration, and it reads no `MS_DEVICE_CLIENT_ID`. A `want` of `"public"` means a
       * row carrying a `clientKind` this host never wrote; the honest answer is to resolve
       * the confidential registration and let the token client refuse the mismatch by name —
       * before any request reaches Microsoft. `kind` is stated for that check's benefit.
       */
      void want;
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
 * One probed staff handle per connection string, per cold instance.
 *
 * `adminDbFor` already memoises the PROBE; this memoises the closure so `buildDeps` — which
 * runs on the path of every request — allocates nothing. Nothing connects until a staff route
 * is actually served.
 */
const staffDbs = new Map<string, () => Promise<AdminDb>>();

function staffDbFor(url: string): () => Promise<AdminDb> {
  let held = staffDbs.get(url);
  if (!held) {
    held = adminDbFor(url);
    staffDbs.set(url, held);
  }
  return held;
}

/** One base logger per cold instance; `withRequestId` children it per request. */
let loggerCache: { key: object; logger: Logger } | null = null;
function hostLogger(cfg: HostConfig): Logger {
  if (loggerCache && loggerCache.key === cfg) return loggerCache.logger;
  const logger = createLogger({
    service: "api",
    fields: { environment: cfg.environment, version: cfg.version },
  });
  // `@trafficflow/db` DROPS Postgres notices until a host installs a sink, so without this the
  // API's notices are silent rather than structured. Installed here because this function already
  // owns the once-per-cold-instance lifetime; a warm instance reuses the cached logger, so the sink
  // stays valid for the life of the instance. Only `severity` and `code` cross the boundary — the
  // notice's own prose can carry row values, which is the whole point of the module.
  setNoticeSink(noticeSinkFor(logger));
  loggerCache = { key: cfg, logger };
  return logger;
}

/** Test seam: drop the cached service bag. */
export function resetServices(): void {
  servicesCache = null;
  sinksCache = null;
  loggerCache = null;
  // Cleared with the logger it was built from: a sink outliving its logger would keep a torn-down
  // test's logger alive and attribute the next test's notices to it.
  setNoticeSink(null);
  customerMailCache = null;
  // Both halves: the closure cache here and the PROBE cache in `@trafficflow/db`. A test
  // that points one URL at a different role must not be answered by a handle probed against
  // the previous one.
  staffDbs.clear();
  resetAdminDbs();
}
