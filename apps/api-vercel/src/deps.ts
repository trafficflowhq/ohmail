import { noticeSinkFor, setNoticeSink, IDEMPOTENCY_TTL_MS, type Tx } from "@trafficflow/db";
import { makePooledDb } from "@trafficflow/db/cloud";
import {
  adminDbFor, attestStaffDbFault, makeAiCreditGate, resetAdminDbs, webhookAlertSink,
  telegramAlertSink,
  assertWeightedScheduleActive, grantSetupCredits, withSetupPool,
  acquireImapSlot, releaseImapSlot, balanceOf, storageCapOf,
  resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER,
  // The staging BUCKET client. It sits beside the `attachment_staging` rows rather than with the
  // send path, because the retention sweep's caller is the worker, which may not depend on
  // `@trafficflow/services`. This host is the one place that needs both halves.
  makeSupabaseStagingStorage,
  type AdminDb, type AlertSink,
} from "@trafficflow/db/cloud";
import {
  createLogger, makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  MicrosoftTokenProvider, UNMETERED_STORAGE_CAP,
  type Logger, type FetchLike, type UpdateSecretPort,
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
  makeEntitlementsService, makeBillingPlaneClient,
  MailService, ResendMailer, mailAlertSink, dbRecipientLimiter, makeWaitlistService,
  type ServiceContext,
} from "@trafficflow/services";
import { makeProbeHostGuard, apiAlertSinkSummary } from "@trafficflow/api";
import type { AiCreditGateFactory, ApiDeps, ApiServices, ChangeWakeHub } from "@trafficflow/api";
import { allowCookieAuthForRequest, type HostConfig } from "./config.js";
import { makeChangeWakeHub } from "./wake-hub.js";

/**
 * The per-request {@link ApiDeps} for the serverless host.
 *
 * Two lifetimes, deliberately separated:
 *
 *  • **Per cold instance** — the service bag and the pooled `Db`. Services are stateless
 *    (`ServiceContext` carries the request's identity, clock and requestId), and
 *    `makePooledDb` is module-cached per connection string precisely so a WARM instance
 *    reuses one connection instead of opening a new one per invocation and storming the pooler.
 *    Rebuilding either per request would be pure waste — and in `makeAuthService`'s case
 *    actively harmful: it memoises the decoy password hash per HASHER to keep the
 *    unknown-email path constant-time, and a fresh service per request is what turned that
 *    into a ~2× timing oracle before the auth hardening pass.
 *
 *  • **Per request** — `session` (filled by `withSession`), `requestId` (by
 *    `withRequestId`), `idempotency` (by `withIdempotency`), and `allowCookieAuth`, which
 *    depends on the HOST the request arrived on.
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
 * Where a billing failure becomes something a human can find.
 *
 * The webhook's failure path was correct and completely silent: 500, `billing_events.status =
 * 'failed'`, retried by Stripe for ~3 days, and then nothing — a customer who paid, a grant that
 * never landed, and a green test suite. This is the one place in the host that turns that into an
 * external signal.
 *
 * `console.error` is not a placeholder for "we will do this properly later": on this host it is
 * the log stream Vercel indexes and alerts on, so a single grep-able token (`billing_alert`) with
 * a fixed shape is exactly what a log-drain rule needs. What it may carry is bounded by the
 * `BillingAlert` type — a code, an event id, a type, an account id — and never a payload, a
 * message, or anything that could quote a connection string. A real pager still belongs
 * to the observability owner; this makes the gap actionable instead of invisible in the meantime.
 */
const billingAlert = (alert: {
  stage: string; code: string; stripeEventId: string | null;
  eventType: string | null; accountId: string | null;
}): void => {
  console.error(JSON.stringify({ evt: "billing_alert", ...alert }));
};

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
 * Turn one bag entry into a LAZY, memoised getter.
 *
 * Most services in this bag are stateless singletons that cost nothing to name, but two are
 * not: `makeAuthService` runs scrypt over a decoy password on construction (the constant-time
 * unknown-email path) and `makeMailboxService`/`makePrivacyService` pull their own dependency
 * graphs. Building all of them eagerly meant a bare `GET /health` — a probe that touches no
 * service at all — paid for the scrypt warm-up on every cold start, on the critical path of the
 * one request that must answer fast.
 *
 * The getter memoises on first access, so the property that matters is preserved exactly: the
 * decoy hash is computed ONCE PER HASHER and shared by every later request on this instance.
 * Rebuilding per request is what turned the unknown-email path into a ~2× timing oracle, and
 * this is not that — it is the same single construction, deferred until something needs it.
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
    // THIS HOST HAS A REQUEST-BODY LIMIT, AND THIS IS IT, IN RAW ATTACHMENT BYTES.
    //
    // Attachment bytes ride the send request base64-encoded, so their total has to clear the
    // platform's ~4.5 MB body cap with room for the JSON envelope and the ~1.33× inflation; 3 MB
    // of raw bytes encodes to about 4 MB. `SendService` then caps a send at the SMALLER of this
    // and what the sending mailbox's own submission server announced, so a provider that accepts
    // less than this binds the send to the provider's number rather than to ours.
    //
    // Declared rather than left to the default, even though the default is this same constant. The
    // absent case exists for a host that has not been read and must therefore get the strict
    // branch; this deployment HAS been read, and a reader should be able to see which of the two
    // states it is in.
    sendSurfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
    // THE METERED STORAGE CAP — this is the hosted deployment, the one composition that reads
    // the subscription row instead of typing UNMETERED_STORAGE_CAP. It feeds the send route's
    // sent-copy projection; the sync worker threads the same read into ordinary ingest, so
    // whichever path commits an own-sent copy first, the cap it consulted is the same one.
    // `null` from the read is the documented fail-open for an account with no subscription row
    // at all (the roster keeps such accounts syncing; storage follows), and it maps to the
    // typed unmetered value rather than leaking a second spelling of it.
    storageCapOf: async (ctx: ServiceContext) => {
      const cap = await storageCapOf(ctx.db as never, ctx.accountId, ctx.now());
      return cap === null ? UNMETERED_STORAGE_CAP : cap;
    },
    // ── AND THIS IS THE WAY ROUND IT ────────────────────────────────────────────────────
    //
    // The ceiling above is a fact about this host's REQUEST BODY, so the way past it is a
    // transport with no request body in it: the browser mints a grant here, PUTs the bytes
    // straight into a private bucket, and the send carries a reference. `SendService` then reads
    // the surface as explicitly uncapped for such a send and the sending mailbox's own announced
    // `SIZE` is the only ceiling left.
    //
    // A FACTORY over the request's database handle, like `aiCredits` above: the bag is per cold
    // instance and a handle is not. ABSENT on a deployment with no storage environment, and the
    // absence is load-bearing — the mint route answers 503, the client falls back to inline
    // bytes, and a send naming staged references is refused rather than sent without its files.
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
    // The AI SPEND GATE, wired BEFORE any live model is. That order is the whole
    // point: a host that can call a model but cannot meter it is the state the billing boundary
    // exists to prevent. `drafter` (the Anthropic DraftPort) stays ABSENT, so the route still
    // 500s cleanly on a deployment with no model; when it is wired, the meter is already here.
    //
    // A FACTORY, because a gate is per-account and this bag is per cold instance. Its presence
    // also makes `Idempotency-Key` mandatory on `POST /messages/:id/draft`: the
    // attempt key that scopes the debit must be the client's own.
    //
    // `retryWindowMs: IDEMPOTENCY_TTL_MS` is the one non-default option, and it is the only
    // gate that gets it. Half of a `debit_draft` source is the CLIENT's `Idempotency-Key`
    // (`draft:<messageId>:<hash(key)>`), so without a bound a client replaying one key would
    // mint unlimited free drafts: every replay answers `duplicate`, proceeds, calls the model
    // and stores a new draft, for ever, charging once. Bounding the free-retry window to
    // exactly as long as the HTTP layer still honours that key makes a genuine retry free and
    // a replay a year later new intent that pays. The classify gate deliberately has NO window
    // — its source is derived from immutable mail, so a re-sync months later is the same work.
    aiCredits: ((db, accountId) =>
      makeAiCreditGate(db as unknown as Tx, accountId, {
        reason: "debit_draft", retryWindowMs: IDEMPOTENCY_TTL_MS,
      })) satisfies AiCreditGateFactory,
    // `sendAdapter` is deliberately ABSENT: leaving it unset is what makes the send route use
    // the real `makeSendAdapter`. A test injects it; production must not fake it.
    sends: sendService,
    workflows: workflowsService,
    proposals: proposalsService,
  };

  // The CONSTRUCTED ones, deferred. `auth` is the expensive one (scrypt over the decoy
  // password); the other three build dependency graphs no health probe needs.
  // `mail` is handed in so `register`'s public path can send the verification (or
  // `account_exists`) mail that is the ONLY continuation of a constant 202, and so
  // `verifyEmail`/`resendVerification` exist at all. It is the same cached `MailService` the
  // waitlist uses, never a bare `ResendMailer` (a service holding the port holds an unthrottled
  // mail-bomb primitive — `packages/services/src/mail/port.ts` states the rule).
  //
  // `null` on a deployment with no mailer, and `AuthService.register` turns that into
  // `503 signup_unavailable` when the open gate is on rather than creating accounts whose
  // verification link can never be sent. `customerMailerFor` cannot throw, so a malformed
  // `MAIL_APP_URL` costs the deployment its open signup and nothing else.
  lazily(bag, "auth", () => makeAuthService({
    config: authConfig, keyProvider, passwordHasher: scryptHasher,
    mail: customerMailerFor(cfg),
  }));
  // Envelope-encrypts mailbox credentials with the SAME provider the worker decrypts them
  // with — the KEK ring identity on `/health` is what proves those agree (risk 2).
  //
  // `onCreated` is the setup grant: every hosted mailbox connect writes its one-time,
  // screening-only, 90-day credit pool in the SAME transaction as the row (cloud 0021,
  // `setup-grant.ts`). Hosted-only by construction — the local tiers construct this service
  // without the hook, exactly as they pass their own `allowance`.
  lazily(bag, "mailbox", () => makeMailboxService({ keyProvider, onCreated: grantSetupCredits }));
  // NO adapter injected, so a screener or approval decision leaves
  // `folder_state` pending and the WORKER applies the IMAP move. The serverless host never
  // opens IMAP to apply organization — one organizer per mailbox is the rule.
  //
  // The screener gate is `debit_classify`, not `debit_draft`: its pre-suggestion IS a
  // classification, and the meter was wired here BEFORE the model, so the day the classifier
  // landed the charge was already in front of it. That day is now: suggestions are persisted
  // and generation happens only on `POST /screener/suggest` over an explicit, priced sender
  // set — the two prerequisites the old "deliberately not wired" note in the drafter block
  // named. `list` cannot reach the classifier at all (it is destructured out of the read-only
  // deps), so wiring it here cannot recreate the model-call-per-scroll defect.
  //
  // Per-call budget: a batch is at most `MAX_SUGGEST_SENDERS` serial classifies inside one
  // Vercel invocation (`maxDuration 60`), and the run is resumable — spend is recorded per
  // message, and the client renders a partial run honestly. So each call gets a TIGHT
  // deadline and one retry rather than the worker's patient 30 s: a slow model fails one
  // sender's suggestion, never the invocation.
  const anthropicApiKey = cfg.anthropicApiKey;
  // ── THE ARMING GUARD: the PRODUCTION managed-AI arm refuses a FLAT debit schedule ──────────
  //
  // "Managed AI must not arm before the weighted prices land" was a rule in prose, which is to
  // say it was one revert away from being untrue. Here it is mechanical, and it sits at the
  // hoist rather than at each arm so that BOTH the Screener's classifier below and the drafter
  // further down are covered by one statement — a guard per arm is a guard the third arm forgets.
  //
  // The condition is the PRODUCTION shape specifically: a model key AND the billing plane. The
  // plane is what makes this host the metered one — it is where subscriptions, invoices and
  // therefore the allowance actually exist. A host holding a key with no plane is a preview or a
  // self-host shape, where there is no ledger for a mis-priced debit to land in and refusing to
  // boot would buy nothing.
  //
  // A hard throw, against the standing counter-argument that `loadAlertsConfig` answers with a
  // soft `null` because a throw here means 503 on every request. That trade is right for alerting
  // and wrong for this: a deployment that can call a model and prices a draft like a
  // classification charges a fifteenth of its cost to every customer for as long as it serves,
  // and unlike a missing alert route that is not recoverable after the fact. Refusing to serve is
  // the cheaper failure. After the weighted schedule shipped it passes by construction; it exists
  // for the revert.
  if (anthropicApiKey && cfg.billingPlane) assertWeightedScheduleActive();
  lazily(bag, "screener", () => makeScreenerService({
    /* -- THIS HOST IS KILLED BY A PLATFORM, AND IT IS THE ONLY ONE THAT IS -------------------
     *
     * `maxDuration = 60` on the catch-all route this bag serves. `ScreenerService.suggest` admits
     * a sender's purchase only while there is time left to finish the model call and the write
     * that follows it, and that window means nothing without this number — so it is stated here,
     * beside the route that declares it, rather than assumed inside the service. The self-hosted
     * server and the desktop's own engine state nothing and are admitted without a deadline,
     * which is correct: nothing kills a request in either of them.
     */
    invocationBudgetMs: 60_000,
    // `exclusive: true` — closes the concurrent double-purchase race a money review found,
    // and the ONE option this gate takes.
    //
    // The ledger makes a second concurrent purchase of the same message FREE; it cannot make it
    // not happen. `duplicate` means "this work is already paid for", which is a fact about the
    // past, so a caller still inside its model call and a genuine free retry arrive looking
    // identical — and the second one was waved through to a paid model call nobody bought. This
    // route is where that is unbounded: it is `idempotent: true`, so DISTINCT `Idempotency-Key`s
    // never collapse against each other, and `middleware.ts` records that the control for
    // invocation cost is an edge rate limit this deployment does not have.
    //
    // With it on, the loser is refused BEFORE the model, waits briefly for the holder's verdict
    // and serves that instead. The worker's auto-suggest pass sets the same option against the
    // same ledger source, which is what makes the cron/press collision — the reaching of this
    // that needs no unusual behaviour from anyone — close on both sides rather than one.
    // `withSetupPool` — the Screener draws each mailbox's screening-only setup grant BEFORE the
    // main balance. Only the two Screener arms wear this wrapper (this one and the worker's
    // auto-suggest gate); drafting, the proposer and workflow steps never see it, which is what
    // makes the pool screening-only in mechanism rather than in prose.
    credits: (db, accountId) =>
      withSetupPool(db, accountId,
        makeAiCreditGate(db, accountId, { reason: "debit_classify", exclusive: true })),
    // WHAT IS LEFT, so the summary after a run can answer "and how much have I got?" without
    // the client keeping a shadow ledger. `balanceOf` is the O(1) `credit_balances` read and
    // never a `SUM` over the ledger — see its own note. It is wired HERE, in the host that has
    // a ledger, because `screener-service.ts` must compile in a deployment that has none: the
    // service names the reader it may be handed and imports nothing from `@trafficflow/db/cloud`.
    remaining: (db, accountId) => balanceOf(db, accountId),
    ...(anthropicApiKey ? {
      classifier: makeHaikuClassifier({
        client: makeAnthropicClient({
          apiKey: anthropicApiKey,
          timeoutMs: 10_000,
          maxRetries: 1,
          onUsage: (r) => { console.log(JSON.stringify({ event: "ai_call", ...r })); },
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

  // ── AUTO-UNSUBSCRIBE, WIRED. THIS HOST ANSWERED 503 UNTIL NOW ──────────────────────────
  //
  // `POST /messages/:id/unsubscribe` has been mounted and unreachable in production since the
  // service landed: `shared.ts#unsubscribes` throws 503 `unsubscribe_unconfigured` when the bag
  // has no service, and this bag had none. The route was not broken — it was never built.
  //
  // The second real outbound port on this host, after the image proxy, and it takes the SAME
  // `nodeHostResolver` for the same reason: the SSRF gate's DNS port is required at
  // construction so it can never quietly default to `node:dns` inside a service. A sender's
  // one-click URL is a caller-influenced host, so the gate is the only thing standing between a
  // `List-Unsubscribe` header and a request to the metadata service.
  //
  // ── PER-MAILBOX AUTHSERV TRUST — the empty literal that used to sit here was the gap ────
  //
  // `trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS` stood here, correctly documented as "this
  // deployment has not decided whose `Authentication-Results` to believe" — and the residual it
  // named (a forged `From` chooses whose list the button leaves) stayed live until this line.
  // The decision is now made, and it is per MAILBOX rather than per deployment, because one
  // service instance serves mailboxes at different providers: `mailboxProviderAuthservIds`
  // reads the IMAP host off the message's own mailbox credential row and maps Gmail/Microsoft
  // to their signing authserv-id. Unknown providers still resolve to the empty set, and the
  // authenticity policy's demote-only rule means that blocks nothing — the self-hosted tail
  // routes exactly as before, pending its own decision.
  //
  // Lazy like the rest: `makeNodeOneClickPost` builds an AbortController factory and a fetch
  // closure a `GET /health` cold start has no reason to pay for.
  lazily(bag, "unsubscribe", () => makeUnsubscribeService({
    post: nodeOneClickPost,
    resolver: nodeHostResolver,
    trustedAuthservIdsFor: mailboxProviderAuthservIds,
  }));

  // Billing, and ONLY when the whole plane block is present. Absent ⇒ neither
  // member is on the bag, so `/billing/*` answers 503 `billing_unconfigured` and nothing else
  // on this host notices. TWO members from ONE block, armed together always: `billingPlane` is
  // the HTTP client of the PRIVATE plane (`plane-client.ts` — since the billing extraction the
  // only composition; the in-process Stripe arm is deleted and `config.ts` refuses a leftover
  // `STRIPE_*` variable at cold start), `entitlements` the open service that holds every
  // table and every transaction. Lazy like the other constructed services: a client a
  // `GET /health` cold start has no reason to build.
  if (cfg.billingPlane) {
    const planeCfg = cfg.billingPlane;
    lazily(bag, "billingPlane", () => makeBillingPlaneClient({
      baseUrl: planeCfg.url,
      secret: planeCfg.secret,
    }));
    lazily(bag, "entitlements", () => makeEntitlementsService({ alert: billingAlert }));
  }

  // THE LIVE DRAFTER. `POST /messages/:id/draft` calls this; absent, the route 500s
  // cleanly, which is the state this host shipped in until now.
  //
  // Lazy, like every other constructed service: `makeAnthropicClient` builds a closure and a
  // retry policy that a `GET /health` cold start has no reason to pay for.
  //
  // `onUsage` goes to `console.log` as one JSON line per metered call, so the token counts
  // behind each metered action are on record. Vercel's log drain makes `ai_call` greppable.
  //
  // THE SCREENER'S CLASSIFIER IS DELIBERATELY NOT WIRED IN THIS BLOCK, and the reason is
  // written down so nobody "finishes the job" by adding one. The hazard this guarded against —
  // a model call per eligible held row on EVERY `list`, re-fetched on every poll, scroll and
  // reload, charged once and billed to us for ever — was closed by persisting suggestions and
  // generating them only on `POST /screener/suggest` over an explicit, priced sender set; the
  // classifier is therefore constructed inside the screener block above, behind that surface,
  // and `list` cannot reach it at all. This client here is tuned for a single drafting call
  // (25 s, one retry), not for a batch of classifications.
  if (anthropicApiKey) {
    lazily(bag, "drafter", () => makeSonnetDrafter(makeAnthropicClient({
      apiKey: anthropicApiKey,
      // A Vercel function has `maxDuration 60`; a drafting request that outlives it is a 504
      // the client cannot distinguish from a hang. One retry inside 25 s leaves room for the
      // context assembly that precedes it and for the draft write that follows.
      timeoutMs: 25_000,
      maxRetries: 1,
      onUsage: (r) => { console.log(JSON.stringify({ event: "ai_call", ...r })); },
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
 * The `MailService` customer mail goes through, or `null`.
 *
 * Separate from {@link alertSinksFor}'s instance on purpose: that one is constructed with an
 * `operatorEmail` and exists to reach a pager, this one has none and exists to reach a
 * customer. Sharing it would mean `sendOperatorAlert`'s "the recipient is configuration,
 * never an argument" guarantee and the waitlist's recipient handling lived in one object
 * whose configuration served two different threat models.
 *
 * ── IT CANNOT THROW ──────────────────────────────────────────────────────────────────────
 *
 * Same rule as the alert sinks, and for a stronger reason. `MailService`'s constructor
 * validates its link bases at boot and throws on a bad one — correct for a mail composition
 * root, catastrophic here, because this runs inside `buildServices` on the path of every
 * request. A malformed `MAIL_APP_URL` must cost the deployment its outbound mail, not its
 * availability. A service that could not be built is simply absent, and `WaitlistService`
 * already treats that as "record the row, report `mailed: false`".
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
 * The alert sinks this host can actually reach, built once per cold instance.
 *
 * TWO of them, on purpose, and they share no vendor: a JSON webhook (a phone push) and
 * operator mail. The redundancy exists because a delivery path that fails silently is
 * indistinguishable from no delivery path, so the pager does not get to have exactly one.
 *
 * Cached on the config object like the service bag: `new ResendMailer(...)` builds an HTTP
 * client, and the alert route is called every few minutes by a scheduler on a warm instance.
 *
 * ── IT CANNOT THROW, AND THAT IS DELIBERATE ──────────────────────────────────────────────
 *
 * `MailService`'s constructor validates its link bases at boot and throws on a bad one — the
 * right behaviour for the composition root of a mail feature, and the wrong behaviour here.
 * This runs inside `buildDeps`, on the path of EVERY request, so a malformed `TF_ADMIN_URL`
 * would 500 the entire deployment. An observability feature must never be able to cause the
 * outage it exists to report, so a sink that cannot be constructed is simply not added: the
 * pass then reports `undeliverable`, the scheduled workflow sees it, and the product serves.
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
        // A LIMITER, NOT A DATABASE.
        //
        // This used to be `db: makePooledDb(cfg.databaseUrlPooled) as never`: the unrestricted
        // runtime handle, captured for the lifetime of the process inside a graph that only
        // ever runs behind a staff credential, with a double assertion silencing the type that
        // said so. `sendOperatorAlert` uses it for exactly one thing — claiming an
        // `auth_throttle` slot — so that is what it is handed. The connection stays here, in
        // the composition root, which is the same shape the `/admin/*` callbacks take.
        //
        // It cannot move onto the blind handle instead: `ohmail_admin` has no grant on
        // `auth_throttle`, and inventing one would widen the staff role to buy nothing.
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
      version: cfg.version, kek: cfg.kek, kekError: cfg.kekError, buildError: cfg.buildError,
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
      // Which billing composition this host serves, on dbProvider's pattern. Reads the
      // SAME config member `buildServices` arms from, so the marker cannot disagree with the
      // wiring. Since the billing extraction the vocabulary is two-valued: "plane" or
      // "unconfigured" ("in-process" left with the deleted Stripe arm).
      billing: cfg.billingPlane ? "plane" : "unconfigured",
      // THE PAGER'S ARMS, published where an operator already looks. The worker announces its
      // arms in a startup line and warns when there is exactly one; this host has no startup
      // line, so until now its per-arm delivery health was reachable only through the
      // `/internal/alerts` response — behind the scheduler's credential, on the one host that is
      // the sole observer of a dead worker.
      //
      // UNCONDITIONAL, `cfg.alerts` null included, and that is the deliberate half: `arms: []` is
      // then the loud statement that this hosted deployment cannot page anybody. Gating it on
      // `cfg.alerts` would make the key vanish in exactly that state, and nothing else reports it
      // — `alertsError` only fires when the alert credential IS configured, so a deployment that
      // lost `TF_ALERT_SECRET` would read as a healthy one with a shorter body.
      //
      // A closure, so the streak is read at `/health` time rather than frozen per request, and
      // `alertSinksFor` is the same cached list `deps.alerts` hands the pass — one composition,
      // not a second opinion about what this host's arms are.
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
     * The OAuth token source, now WIRED. An earlier phase left this absent with a note saying it
     * would be wired "when onboarding lands"; onboarding has landed.
     *
     * PER INVOCATION, which is the whole reason it is built here and not in `servicesFor`: the token
     * cache is keyed by mailbox and a serverless invocation serves one request, so a per-request
     * instance is exactly the right lifetime — it spares a redundant token POST when the same
     * mailbox is dialled twice in one request (a send that also appends to Sent) and caches nothing
     * across requests, where a stale token would be a liability rather than a saving.
     *
     * Built UNCONDITIONALLY, for the reason the worker's own construction states: the refusal for a
     * missing client secret has to NAME the missing variable, and that only happens if the provider
     * exists to be asked. A password-only deployment never invokes it — an `authType: "oauth2"`
     * credential row is the only thing that reaches `fetchAccessToken`.
     */
    oauth: oauthProviderFor(cfg, db),
    /* The token-endpoint port. Production is Node's global `fetch`; it is left ABSENT
     * rather than assigned, so the route's own fallback is the single expression that names it. */
  };
}

/**
 * The per-invocation Microsoft token source.
 *
 * `resolveClient` reads the CONFIG STORE on every refresh, with env as the fallback, through the same
 * resolver the worker and the onboarding routes use. That is what makes a client secret rotated in
 * the admin console take effect without a redeploy — and, more importantly, what makes it impossible
 * for this host and the worker to sign with different clients.
 *
 * The rotation write targets the mailbox's OWN imap credential row and is the only write this port
 * makes, identical to the worker's.
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
       * THIS HOST HAS ONE DOOR, AND SAYS SO.
       *
       * The managed deployment serves the REDIRECT ceremony and does not mount the device-code
       * routes, so no mailbox here can hold a token from the public registration — and it reads no
       * `MS_DEVICE_CLIENT_ID`, because a variable nothing here would use is a variable that does
       * nothing. A `want` of `"public"` therefore means something impossible has happened (a row
       * carrying a `clientKind` this host never wrote), and the honest answer is to resolve the
       * confidential registration and let the token client refuse the mismatch by name — which it
       * does, before any request reaches Microsoft, rather than sending a doomed refresh whose
       * `invalid_client` would read as a Microsoft outage.
       *
       * `kind` is stated rather than left to default for exactly that check's benefit.
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
