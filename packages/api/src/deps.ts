/* THE MAIL-HALF ENTRY POINTS, and that is the whole of what this file may name.
 *
 * This module states what any host of the route table must supply, and it is compiled by every
 * host — including a local install built from nothing but the mail half. The identity ceremony,
 * billing, the funnel and the operator connection are declared in `deps-cloud.ts`, which augments
 * the two interfaces below and which only a hosted build loads. */
import type {
  AuthConfig, Db, KeyProvider, SessionScope,
  SyncService, PushService, MailboxService, RulesService,
  MessageService, ThreadService,
  ScreenerService, ApprovalService, TriageService, SearchService, PrivacyService,
  UnsubscribeService,
  ContactsService, SnippetsService, NotifyRulesService, AwayResponderService,
  AttachmentsService, KbService, TagsService, DraftsService, DraftingService, SendService,
  WorkflowsService,
} from "@trafficflow/services/mail";
/* `OAuthTokenProvider` from the MAIL entry, never the root barrel: this file is compiled by every
 * host, including the shipped local engine, and the root barrel's export surface reaches the model
 * half (`ai/*`) that may never leave this workspace. The port lives in `adapters/imap-auth.ts`. */
import type {
  DraftPort, OpenSendAdapter, KekEnvIdentity, Logger, OAuthTokenProvider,
} from "@trafficflow/core/mail";
/* What a completed SMTP login proved. From the adapter entrypoint rather than the mail barrel
 * because it belongs to the dial, and `imap-probe.ts` — the only implementor — imports it there. */
import type { SmtpLoginProof } from "@trafficflow/core/adapters/imap";
/* The spend gate's PORT, from the root barrel. `@trafficflow/db/cloud` is the half that answers,
 * and a route table must be able to say it may be handed a gate without depending on the ledger. */
import type { AiCreditGate } from "@trafficflow/db";

/**
 * Builds the per-request AI spend gate. `db` is the request's handle and `accountId`
 * comes from the resolved SESSION, never from the body (contract §1.9).
 */
export type AiCreditGateFactory = (db: Db, accountId: string) => AiCreditGate;

/**
 * HOW A HOST ADMITS AN IMAP CONNECTION, as a port rather than as an import.
 *
 * `acquireImapSlot`/`releaseImapSlot` count through a per-address attempt counter, and that table
 * is created by the CLOUD migration journal. Two consequences, and the second is the one that made
 * this a port:
 *
 *  · A local install's database is built from the MAIL journal alone, so the table is not there.
 *    Both call sites — the add-time probe and the attachment adapter — are mounted by the local
 *    API, so a desktop user fetching an attachment was reaching a counter over a table that does
 *    not exist. That is a defect this seam fixes, not one it introduces.
 *  · The desktop engine is bundled from these modules and is SHIPPED. A static import of the
 *    counter puts `@trafficflow/db/cloud` — billing, the ledger, the staff handle, the whole
 *    hosted schema — into the artifact, whatever the code does at runtime.
 *
 * REQUIRED, with no default, deliberately. A default of "always admit" would silently uncap a
 * hosted deployment that forgot to wire it, which is the failure the counter exists to prevent;
 * a default of the db-backed pair would reinstate the import edge. Each host says what it means:
 * the hosted API passes the counter, and `apps/sidecar` passes an always-admit with its reason
 * written next to it.
 */
export interface ImapAdmissionPort {
  /** `false` means REFUSE — the caller must not dial. Throwing means the counter itself failed. */
  acquire(db: Db, input: { mailboxId: string; max: number; now: Date }): Promise<boolean>;
  release(db: Db, mailboxId: string, now: Date): Promise<void>;
}

/**
 * The typed service bag on `ApiDeps`. The test helper and each host construct these once and
 * expose them here so handlers never new-up a service.
 * `sync` is optional — the handler falls back to the `syncService` singleton.
 */
export interface ApiServices {
  sync?: SyncService;
  push: PushService;
  /** See {@link ImapAdmissionPort}. */
  imapAdmission: ImapAdmissionPort;
  /**
   * The SMTP dial the connect-time SMTP probe uses. OPTIONAL with a real default
   * (`verifySmtpLogin`, on the TLS floor) — injected by the test harness so a route test never
   * opens a submission socket, the same way `ImapAdapter.prototype.connect` is spied for the
   * IMAP side.
   */
  smtpVerify?: (
    smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } },
  ) => Promise<SmtpLoginProof | void>;
  mailbox: MailboxService;
  rules: RulesService;
  message: MessageService;
  thread: ThreadService;
  screener: ScreenerService; // constructed WITHOUT an adapter — IMAP moves defer to the sync worker
  approval: ApprovalService; // constructed WITHOUT an adapter — IMAP moves defer to the sync worker
  triage: TriageService;
  search: SearchService;     // hybrid lexical+fuzzy search (RRF)
  privacy: PrivacyService;   // spy-pixel blocker + image proxy (injected RemoteFetch)
  /**
   * RFC 8058 one-click unsubscribe. OPTIONAL, and its absence is a first-class state in the
   * same grammar as `billing`: the service requires a decision no host can default — which
   * authserv-ids the account's provider signs `Authentication-Results` with — so a deployment
   * that has not made it answers 503 `unsubscribe_unconfigured` and every other route is
   * untouched. The hosted API does not build one yet; see `shared.ts#unsubscribes`.
   */
  unsubscribe?: UnsubscribeService;
  contacts: ContactsService; // contacts + contact/thread notes (REST-only)
  snippets: SnippetsService; // compose-time canned-text library
  notify: NotifyRulesService;// opt-into-notifications list
  away: AwayResponderService;// the single per-account autoresponder
  attachments: AttachmentsService; // on-demand attachment fetch + download-all (bytes never stored)
  kb: KbService;             // Knowledge Base CRUD + dedicated lexical retrieval (REST-only)
  tags: TagsService;         // the account's own labels, keyed by message (never an IMAP folder)
  drafts: DraftsService;     // manual compose drafts (emits `draft` change_log in-tx)
  // AI draft-from-history. `drafting` assembles the sensitivity-safe context + stores
  // the draft; `drafter` is the INJECTED DraftPort (a mock in tests, a model-backed
  // adapter in a deployment that has one). A model needs an API key, which is
  // deployment config, so `drafter` is optional and the route 500s cleanly when it is
  // absent — the same seam the classifier uses.
  drafting?: DraftingService;
  drafter?: DraftPort;
  /**
   * The AI SPEND GATE factory. A factory rather than an instance because a
   * gate is per-ACCOUNT and the account is only known once `withSession` has resolved the
   * request, while this bag is built once per cold instance.
   *
   * Its ABSENCE means the deployment is unmetered, and that is the honest default for a host
   * with no billing configured — but it also means `POST /messages/:id/draft` stops requiring
   * an `Idempotency-Key`, so the two must be wired together (the hosted API does).
   */
  aiCredits?: AiCreditGateFactory;
  // Gated idempotent send. The route reads `Idempotency-Key` itself (400 if absent)
  // and is NOT idempotent-marked; SendService owns the `outbound_sends` reservation.
  // The API passes `openSendAdapter = makeSendAdapter` per-call; tests inject a
  // fake/GreenMail send spy.
  sends?: SendService;
  // Workflow automation storage + CRUD + run enqueue. REST-only: no change_log /
  // EntityType growth. `POST /workflows/:id/run` is idempotent-marked and the service
  // writes the `idempotency_keys` row in-tx, like MessageService.move.
  // Nothing here drains the `pending` runs it enqueues; that runner is not built yet.
  workflows: WorkflowsService;
  // AI workflow proposals. `GET /workflows/proposals` lists the OPEN ones; the model
  // port is injected into the WORKER cron that generates them, not into the API, so the
  // API only reads and dismisses. REST-only.
  // Optional send-adapter factory override. Prod leaves this unset → the route uses
  // `makeSendAdapter` (decrypt both imap+smtp creds → connected ImapAdapter). Tests
  // inject a fake/GreenMail spy here to count `send` calls + drive `messageInSent`.
  sendAdapter?: OpenSendAdapter;
  /**
   * THIS HOST'S PLATFORM CEILING on total attachment bytes in one send — or `null` for a host that
   * has none, which is the local engine.
   *
   * It is deps-level rather than a route constant because `routes/drafts.ts` is the ONE send
   * handler and both hosts mount it. The hosted deployment declares
   * `SEND_ATTACHMENT_MAX_TOTAL_BYTES` — its serverless body limit expressed in raw bytes. A local
   * install declares `null`: it runs `SendService` in the same process as its own SMTP dial, so
   * nothing between the compose form and the wire imposes a request-body limit and the only
   * ceiling that exists is the mail server's own (`mailboxes.smtp_max_size_bytes`, mail 0055).
   *
   * ABSENT is neither of those — it is a host that has not been read, and
   * {@link SendDeps.surfaceMaxTotalBytes} resolves it to the same 3 MB constant rather than to
   * "unbounded". Both live hosts declare themselves, so the absent case is what a NEW host gets
   * before anybody has thought about it, and it is deliberately the strict branch.
   */
  sendSurfaceMaxTotalBytes?: number | null;
}

/**
 * Injectable SSE configuration. Prod defaults keep a `/events` connection
 * bounded; tests pass tiny values for deterministic frames. The poll uses a DISCRETE query
 * (borrow-and-release), holding no DB connection between polls.
 *
 * `enabled` and the two caps are COST controls, not ergonomics. On a
 * per-invocation-second platform every open `/events` tab is a live function for its whole
 * lifetime, reconnecting forever, and nothing in the protocol asks the client's permission:
 * one page in a loop, or a client build with the flag flipped on, is an unbounded bill and a
 * pooler-exhaustion vector at the same time. Beta therefore ships SSE **off server-side**
 * (the client already treats it as a lossy, content-free wake signal, so `GET /sync` polling
 * is a complete substitute) and, when it is turned on, refuses to open more than
 * `maxPerAccount` streams from one account or `maxPerInstance` in one warm instance.
 */
export interface SseConfig {
  heartbeatMs: number;
  pollMs: number;
  lifetimeMs: number;
  /**
   * Whether `GET /events` streams at all. `false` ⇒ 503 `sse_disabled`, which
   * `EventSource` treats as a terminal failure (it does not reconnect on a non-200), so a
   * client with the flag on does not hammer the endpoint. Default `true` for the historical
   * behaviour and every existing test; the hosted API turns it OFF unless `TF_SSE=1`.
   */
  enabled?: boolean;
  /** Max concurrent streams per ACCOUNT (429 beyond it). A human has a few tabs, not fifty. */
  maxPerAccount?: number;
  /** Max concurrent streams in ONE warm instance — the per-instance backstop (503 beyond it). */
  maxPerInstance?: number;
}

export const DEFAULT_SSE: SseConfig = {
  heartbeatMs: 15_000,
  pollMs: 2_000,
  lifetimeMs: 30_000,
  enabled: true,
  maxPerAccount: 4,
  maxPerInstance: 50,
};

/**
 * What `GET /health` publishes about the host itself.
 *
 * `kek` is the {@link KekEnvIdentity} — `{ active, count, fingerprint }` — and it is
 * the SAME object, from the SAME `kekEnvIdentity()` in `@trafficflow/core`, that the
 * worker renders at its own `/health`. That is the point: a KEK that differs between the
 * API host and the worker makes every `mailbox_credentials` row undecryptable on one of
 * them, with no error until a mailbox is touched. Comparing the two `/health`
 * responses must be sufficient to see it, and all THREE fields must match — the
 * fingerprint covers the whole ring, `active` is what new writes persist as `key_version`.
 *
 * Absent on `ApiDeps`, the route falls back to `kekEnvIdentity(process.env)` and
 * {@link API_VERSION}, so a host that forgets to inject still reports truthfully.
 */
export interface HealthConfig {
  /** Build identity — the deployment's commit sha where the platform provides one. */
  version: string;
  /**
   * WHICH SCHEMA THIS HOST IS SUPPOSED TO HAVE. Absent means both journals, which is every
   * hosted deployment.
   *
   * `"mail"` is the LOCAL engine: it migrates the mail journal alone and has no billing ledger,
   * no passkey challenge store and no staff directory — nor should it, they belong to a service its
   * owner has no account with. Probed against the full set it answers `503 schema_incomplete` on
   * every request for ever, which reads as "somebody forgot to migrate" about a database that is
   * complete for what it is.
   *
   * Declared by the host rather than sniffed from the database, deliberately: inferring the tier
   * from what is missing would make a genuinely half-migrated hosted deployment — the reachable
   * mail-committed/cloud-failed state — indistinguishable from a healthy desktop install, and
   * that is the exact state the probe exists to catch.
   */
  schemaTier?: "all" | "mail";
  /** Absent ⇒ this host has no usable KEK; see {@link HealthConfig.kekError}. */
  kek?: KekEnvIdentity | null;
  /**
   * Why {@link HealthConfig.kek} is absent. Present ⇒ `/health` answers 503: a host that
   * cannot decrypt mailbox credentials is not healthy, and this is the only place an
   * operator can learn that before a user hits it. It carries the key loader's own message
   * (which names the offending VARIABLE, never its value).
   */
  kekError?: string | null;
  /**
   * Why this deployment cannot identify its own build. Present ⇒ `/health` answers 503
   * `build_identity_unknown`: a PRODUCTION deployment reporting `version: "dev"` cannot be
   * correlated with a commit, so "which build is serving this?" — the first question of every
   * incident, and the anchor for the KEK and schema comparisons above — has no answer. Set by
   * the host when the platform says this is a production deployment and it can find neither a
   * commit sha nor an explicit `TF_BUILD_VERSION`. Non-production hosts and the test harness
   * leave it null.
   */
  buildError?: string | null;
  /**
   * Why this deployment has no STAFF surface, or null when it has one.
   *
   * Present ⇒ `/health` publishes `adminFault: <reason>` and every `/admin/*` route answers
   * 404. It is the only channel that can say so: with the surface unarmed there is no admin
   * endpoint left to report its own absence, and the console renders six error panels that
   * name a network failure rather than the configuration that caused it.
   *
   * **It does NOT make `/health` answer 503, and that is deliberate.** `healthFault` is for
   * faults that make the deployment unfit to serve USERS — a wrong database, an unusable KEK,
   * an unidentifiable build. An unarmed staff console is not one: 503 here would take the
   * product out of rotation over the configuration of an internal tool, which is precisely the
   * failure `loadAlertsConfig` refuses by name ("an observability feature causing the outage it
   * exists to report"). The fault is named, loudly, in a body an operator reads with one curl.
   */
  adminError?: string | null;
  /**
   * **THE PAGER IS CONFIGURED AND CANNOT RUN.**
   *
   * Present ⇒ `/health` publishes `alertsFault: <reason>` and the three `/internal/alerts*`
   * routes answer 503 `alerts_db_unarmed`. Set by the host when its alerting block is armed and
   * the content-blind connection is not — the state that used to be reported, if at all, as a
   * CONSOLE fault, which is a different sentence: "the admin console is off" is a Monday
   * problem, "nothing is watching the worker" is an outage nobody is paged for.
   *
   * **It does NOT make `/health` answer 503**, for the same reason {@link
   * HealthConfig.adminError} does not, only more so: this field exists precisely because the
   * observability configuration is broken, and taking the product out of rotation over it would
   * be the observability feature causing the outage it exists to report.
   *
   * The reporting is three-ring and this is only the first: the routes answer non-2xx, so the
   * scheduled CI health check's `curl --fail-with-body` goes red and mails the operator without
   * anything in this repo having to work, and the hosted API's build configuration refuses to
   * build a production host that could reach the state at all.
   */
  alertsError?: string | null;
  /**
   * **WHICH PROVIDER FAMILY THIS HOST'S RUNTIME CONNECTION BELONGS TO.**
   *
   * One of the fixed strings `providerFamily` returns (`packages/db/src/session-url.ts`),
   * including `"unrecognized"`. Not a fault, and it never makes `/health` answer 503.
   *
   * It exists because the connection guards it accompanies **stopped guarding for a day and
   * nothing reported it.** Those guards recognised a managed Postgres connection by matching the
   * hostname of the provider in use at the time; the day the deployment moved to a different
   * provider, every one of them became unconditionally true-negative. Every unit test that
   * covered them stayed green, because every fixture named the old provider — a test cannot know
   * that a deployment changed provider. This field can: `"unrecognized"` on the live host says
   * the refusals have become decoration, which turns the existing "read `/health` after a
   * deploy" step into the tripwire instead of something an operator has to remember at the next
   * migration.
   *
   * Safe to publish for `kek`'s reason: it is an IDENTITY, one of three fixed strings. It carries
   * no host, no port, no role and no credential — the connection string's message is never
   * forwarded here precisely because it does.
   */
  dbProvider?: string | null;
}

export type SessionVia = "cookie" | "bearer";

/**
 * The authenticated identity `withSession` attaches to a request. It is the
 * `resolveSession` core (@trafficflow/services) plus `via` — how the token
 * arrived — which `withCsrf` consults (cookie auth is double-submit-guarded,
 * bearer is exempt). `accountId`/`userId` come from the session row, NEVER the
 * body (contract §1.9). `scope` also comes from the row: `withSession`
 * admits `'enrollment'` only on `enrollmentOk` routes, so a handler that receives a
 * session can assume it is entitled to be there.
 */
export interface ResolvedSession {
  accountId: string;
  userId: string;
  sessionId: string;
  lastTwofaAt: Date | null;
  scope: SessionScope;
  via: SessionVia;
  /**
   * When this user's address was proven, or `null` for an unproven one. Comes from
   * `resolveSession`'s `users` JOIN, so it costs no extra query, and it is read by exactly one
   * thing: `withSpendGate`. A handler on a route whose `cost` is not one of the permissive
   * classes can assume it is non-null, for the same reason `scope` lets it assume enrollment
   * was handled.
   */
  emailVerifiedAt: Date | null;
}

/**
 * Set by `withIdempotency` when a valid `Idempotency-Key` is present on an
 * idempotent route with no prior stored response. The handler's service records
 * the idempotency row inside its own mutation tx — atomically — keyed by these.
 */
export interface IdempotencyContext {
  key: string;
  requestHash: string;
}

/**
 * The per-request container handed to every handler and middleware. It is
 * MUTABLE: `withRequestId` fills `requestId`, `withSession` sets `session`, and
 * `withIdempotency` sets `idempotency`. Tests construct one directly around a
 * PGlite `Db`; a hosted deployment builds one per request around a pooled Postgres `Db`.
 */
export interface ApiDeps {
  db: Db;
  now: () => Date;
  requestId: string;
  session: ResolvedSession | null;
  authConfig: AuthConfig;
  keyProvider: KeyProvider;
  /**
   * Exchange/M365 OAuth2 token source, per invocation. Absent ⇒ this host does not do oauth: an
   * oauth mailbox refuses at {@link buildImapAuth} rather than sending its refresh token as a
   * password. Present (wired from `MS_OAUTH_*` when onboarding lands) ⇒ the IMAP + SMTP dialers mint
   * access tokens through it. A password mailbox never touches it.
   */
  oauth?: OAuthTokenProvider;
  /** Set by `withIdempotency`; consumed by the handler's service. */
  idempotency?: IdempotencyContext | null;
  /** Typed service bag; populated as services land. */
  services?: ApiServices;
  /** SSE timings for `GET /events`; falls back to {@link DEFAULT_SSE}. */
  sse?: SseConfig;
  /**
   * Whether the `tf_session` COOKIE is an accepted credential on this deployment.
   * Default (absent or true) is the historical behaviour: cookie OR bearer.
   *
   * `false` makes the host BEARER-ONLY — `readSessionToken` ignores the cookie
   * entirely, so an ambient cookie cannot authenticate a request. That is the whole
   * mechanism behind `api.ohmail.app`: it is the native/desktop surface, reached by
   * clients that hold a bearer token from the OAuth2 PKCE flow and that are not
   * browsers, so there is no ambient credential to be abused cross-site and
   * `withCsrf` becomes a no-op BY CONSTRUCTION (`via` can never be `"cookie"`).
   * `api.ohmail.app` — the host the webapp's same-origin rewrite proxies to — keeps
   * cookies, because there the cookie is genuinely first-party.
   *
   * Note it is not merely "prefer bearer": a request presenting BOTH is treated as
   * bearer-only, and a request presenting only a cookie is 401, not 403 — it carries
   * no credential this deployment recognises.
   */
  allowCookieAuth?: boolean;
  /** What `GET /health` reports about this host (version + KEK ring identity). */
  health?: HealthConfig;
  /**
   * The structured logger for THIS request.
   *
   * `withRequestId` binds `requestId` onto it, so every line a handler or middleware writes
   * downstream carries the id the client also received in `x-request-id`. That is the whole
   * point: a user reporting "my send failed at 14:32" hands over one value that selects
   * every line of that request.
   *
   * Optional and defaulting to {@link silentLogger}: a route table must not print to a
   * host's stdout because the host forgot to inject one, and no test should have to mute a
   * global. A hosted deployment injects a real logger.
   */
  logger?: Logger;
}


