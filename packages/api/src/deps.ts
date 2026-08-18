/* THE MAIL-HALF ENTRY POINTS, and that is the whole of what this file may name.
 *
 * This module states what any host of the route table must supply, and it is compiled by every
 * host — including a local install built from nothing but the mail half. The identity ceremony,
 * billing, the funnel and the operator connection are declared in `deps-cloud.ts`, which augments
 * the two interfaces below and which only a hosted build loads. */
import type {
  AuthConfig, Db, KeyProvider, ServiceContext, SessionScope,
  SyncService, PushService, MailboxService, RulesService,
  MessageService, ThreadService,
  ScreenerService, ApprovalService, TriageService, SearchService, PrivacyService,
  UnsubscribeService,
  ContactsService, SnippetsService, NotifyRulesService, AwayResponderService,
  AttachmentsService, KbService, TagsService, DraftsService, DraftingService, SendService,
  WorkflowsService, ProfileImportService,
} from "@trafficflow/services/mail";
/* `OAuthTokenProvider` from the MAIL entry, never the root barrel: this file is compiled by every
 * host, including the shipped local engine, and the root barrel's export surface reaches the model
 * half (`ai/*`) that may never leave this workspace. The port lives in `adapters/imap-auth.ts`. */
/* The session LIFECYCLE — the machinery half of the auth service (Phase 3), from the entry
 * every host may compile: no ceremony, no Cloud schema, no barrel side effects. The hosted
 * `AuthService` extends this class, so a hosted bag's member IS one. */
import type { SessionLifecycle } from "@trafficflow/services/auth";
import type {
  DraftPort, OpenSendAdapter, KekEnvIdentity, Logger, OAuthTokenProvider,
} from "@trafficflow/core/mail";
/* What a completed SMTP login proved. From the adapter entrypoint rather than the mail barrel
 * because it belongs to the dial, and `imap-probe.ts` — the only implementor — imports it there. */
import type { SmtpLoginProof } from "@trafficflow/core/adapters/imap";
/* The add-time probe's SSRF/port gate. Type-only, so this stays a one-way dependency at runtime —
 * `imap-probe.ts` imports `ApiDeps` from here, and only its TYPES travel back. */
import type { ProbeHostGuard } from "./imap-probe.js";
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

/** What a mint hands the browser: a ticket id and the exact way to put bytes at it. */
export interface StagedUploadGrantWire {
  /** The ticket id — what a later send references in place of the bytes. */
  id: string;
  uploadUrl: string;
  uploadMethod: string;
  /** Sent verbatim on the upload. Opaque: the storage wire is the server's business. */
  uploadHeaders: Record<string, string>;
  /** ISO-8601. When the staged bytes stop existing. */
  expiresAt: string;
}

/**
 * HOW A HOST STAGES ATTACHMENT BYTES OUT OF THE REQUEST BODY — a port, and OPTIONAL, and the
 * optionality is the security property rather than a convenience.
 *
 * Attachment bytes used to ride the send request base64-encoded, which bound every hosted send to
 * the serverless body limit and made the compose surface promise 3 MB whatever the sender's own
 * submission server announced. A host that has object storage behind it supplies this port; the
 * browser then uploads directly and the send carries a reference.
 *
 * **A LOCAL INSTALL MUST NOT SUPPLY IT, AND STRUCTURALLY CANNOT WANT TO.** Its send handler runs in
 * the same process as its own SMTP dial — there is no request body between the compose form and
 * the wire, so there is nothing to stage around — and staging would mean a standalone desktop
 * install sending somebody's attachment bytes to the hosted service's storage. Absent, the mint
 * route is not mounted at all (it is on the hosted route table only) and `SendService` refuses a
 * request that names staged references rather than sending a message without its files.
 *
 * Declared HERE rather than in `deps-cloud.ts` because `routes/drafts.ts` is the ONE send handler
 * and both hosts compile it: the shared handler has to be able to say it may be handed this, and
 * the local composition's answer is `undefined`.
 */
export interface AttachmentStagingPort {
  /** Mint one ticket + upload grant. Writes the row BEFORE the object can exist; see the service. */
  mint(input: {
    accountId: string; filename: string; contentType: string; sizeBytes: number; now: Date;
  }): Promise<StagedUploadGrantWire>;
  /**
   * The two-phase staged-bytes source `SendService` reads through — `declare` (metadata, so an
   * over-cap send is refused before any transfer) and `fetch` (the bytes, re-measured).
   */
  source: {
    declare(
      accountId: string, ids: readonly string[],
    ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date }>>;
    fetch(
      accountId: string, ids: readonly string[], now: Date,
    ): Promise<Array<{ filename: string; contentType: string; content: Buffer }>>;
  };
}

/**
 * Builds the staging port over THIS REQUEST's database handle, exactly as
 * {@link AiCreditGateFactory} does over the same handle: the service bag is per cold instance and
 * a database handle is not, so the bag holds the factory and the handler holds the port.
 */
export type AttachmentStagingFactory = (db: Db) => AttachmentStagingPort;

/**
 * The typed service bag on `ApiDeps`. The test helper and each host construct these once and
 * expose them here so handlers never new-up a service.
 * `sync` is optional — the handler falls back to the `syncService` singleton.
 */
export interface ApiServices {
  sync?: SyncService;
  /**
   * The session LIFECYCLE — refresh rotation with reuse detection, logout, the device list and
   * its revoke, and `establishPairedDevice` (what the pairing redeem mints through). OPTIONAL,
   * in the same grammar as `unsubscribe`: absence is a first-class state, and every route that
   * reads it answers a clean refusal rather than 500ing into a stack.
   *
   * Declared HERE — the mail-half surface — as the CARVED base class, not the full ceremony
   * (Phase 3). Two different hosts fill it:
   *  · every HOSTED composition puts its full `AuthService` here, which `extends`
   *    `SessionLifecycle`, so the twenty ceremony routes keep working through the accessor in
   *    `routes/shared-cloud.ts` and nothing hosted changes shape;
   *  · the LOCAL engine puts a bare `SessionLifecycle` over its own store here, which is what
   *    lets the desktop-as-host door pair devices, rotate their bearer pairs and revoke them
   *    WITHOUT the ceremony, the Cloud schema, or the barrel's side effects entering the
   *    shipped bundle.
   * Session RESOLUTION is unaffected either way — `withSession` calls the standalone
   * `resolveSession` against the `sessions` table, never this member.
   */
  auth?: SessionLifecycle;
  /**
   * The INVITE-grant redeem (`redeemInviteGrant`), as a port. OPTIONAL, and its absence is the
   * honest state of any composition whose database lacks the Cloud-half `invites` table: the
   * `/pair/redeem` invite arm answers `validation_failed` instead of a 42P01 dressed as a 500.
   * The self-host composition — the only one that mounts `/pair*` today — wires the real
   * function from the full barrel; the desktop-host door (the desktop-host door, next slice) deliberately never does.
   * A port rather than an import so `routes/pair.ts` stays compilable and shippable from the
   * mail half alone — the same reason the session mint above arrives through the bag.
   */
  inviteRedeem?: (
    ctx: ServiceContext, input: { token: string; email: string },
  ) => Promise<{ code: string; email: string; expiresAt: Date }>;
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
  /**
   * The add-time IMAP/SMTP probe's SSRF/port gate — see {@link ProbeHostGuard}. The hosted
   * deployment wires the ENFORCING policy (`makeProbeHostGuard(nodeHostResolver)`), which refuses a
   * host that resolves to a private/loopback/link-local/CGNAT address and a non-mail port before
   * any dial. The desktop/local engine wires `ALLOW_ANY_PROBE_HOST` — a LAN mail server on a
   * non-standard port is legitimate there and this process opens sockets only on the user's own
   * machine. ABSENT resolves to `ALLOW_ANY_PROBE_HOST` (the local-safe default); the hosted
   * deployment's own dependency wiring MUST set the enforcing one, and does.
   */
  probeHostGuard?: ProbeHostGuard;
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
  /**
   * The portable profile's confirm-import surface. OPTIONAL with a singleton fallback
   * (`routes/shared.ts#profileImport`) because the service is stateless — the mailbox read it
   * needs arrives per call, built by the route from the live adapter — so no host has anything
   * to construct. Present in the bag only when a test wants a spy in its place.
   */
  profileImport?: ProfileImportService;
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
  /**
   * See {@link AttachmentStagingPort}. Present on a host with object storage; ABSENT on a local
   * install, where its absence is what keeps the standalone door from staging to Cloud storage.
   */
  attachmentStaging?: AttachmentStagingFactory;
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
 * THE PER-INSTANCE `change_log` WAKE FAN-OUT — what turns `GET /events` from a poll relay into
 * a push relay.
 *
 * The host that can hold a `LISTEN` builds ONE of these per warm instance — one session-mode
 * Postgres connection, never one per stream; session slots are pinned backends and the scarce
 * resource — and every open `/events` stream on the instance subscribes its account
 * here. A NOTIFY from `recordChanges` (`packages/db/src/change-log.ts`, CHANGE_LOG_CHANNEL)
 * fans out in process to exactly the streams whose account it names.
 *
 * IT IS A HINT, NOT A DEPENDENCY, on both sides of this interface:
 *
 *  · A host with no hub (`deps.changeWake` absent — the local sidecar host, a deployment with
 *    no session-mode URL, every existing test) gets the route's own serialized poll loop and
 *    nothing else, which is exactly the pre-hub behaviour.
 *  · A hub whose LISTEN is down delivers nothing and the poll still carries the stream. The
 *    route never asks the hub whether it is healthy; missed wakes are indistinguishable from
 *    quiet, and the poll is what bounds the staleness either way.
 *
 * `subscribe` MUST NOT THROW (a broken hub is a hub that delivers nothing), and the returned
 * unsubscribe must be idempotent — the route calls it from `stop()`, which can run twice
 * (lifetime close racing a client cancel).
 */
export interface ChangeWakeHub {
  subscribe(accountId: string, onWake: (seq: bigint) => void): () => void;
}

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
   * RUN THE CONTENT-BLIND ATTESTATION AND PUBLISH ITS RESULT, non-fatally.
   *
   * A capability, not a value: `/health` calls it and merges a `staffDbFault` string when it
   * returns one. It awaits the memoised staff-handle factory, so it pays the census + bite
   * round trips only on the first `/health` per cold instance and is instant thereafter; it
   * never throws and never makes `/health` 503 — an over-privileged `DATABASE_URL_ADMIN` is a
   * dark console, not a reason to take the product host out of rotation, exactly as
   * {@link HealthConfig.adminError} is.
   *
   * It is the counterpart to `adminError`: that names the STATIC refusals (missing var, equal to
   * the runtime URL, unusable for serverless), which are visible at boot; this names the one an
   * absent-var check cannot see — a plausible role whose EFFECTIVE privileges exceed the
   * allowlist — which previously surfaced only as a per-request 503 the first time the console
   * was loaded. Absent on hosts with no blind connection (desktop, an unarmed deployment).
   */
  staffDbAttestation?: (() => Promise<string | null>) | null;
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
  /**
   * **WHICH BILLING COMPOSITION THIS HOST IS SERVING.** One of two fixed strings, on
   * `dbProvider`'s exact pattern: an injected identity, never a fault, never a 503.
   *
   *  · `"plane"`        — this host reaches a billing service over HTTP;
   *  · `"unconfigured"` — no billing service is configured and `/billing/*` answers 503.
   *
   * (`"in-process"` — the Stripe SDK running in this same process — left the vocabulary when
   * that composition was deleted; billing code lives in its own service now.)
   *
   * It exists because the failure mode of a billing-environment change is CAMOUFLAGED: a host
   * that lost its billing configuration degrades to `billing_unconfigured`, which is also the
   * legitimate pre-launch answer, so nothing else distinguishes "not configured yet" from
   * "misconfigured by the last deploy". Two spaced `/health` reads after any deploy catch it
   * through this field. Published on the unhealthy branches too — a dark host is exactly when
   * the marker is worth most.
   *
   * Safe to publish for `dbProvider`'s reason: fixed strings only, no URL, no secret.
   */
  billing?: "plane" | "unconfigured" | null;
}

/**
 * What `GET /hello` publishes about the host — server identity and capability negotiation.
 *
 * The route serves this descriptor VERBATIM (plus the constant `product` and a defaulted
 * `apiVersion`), so each composition states its own truth at its composition root, exactly as
 * {@link HealthConfig} is injected: the hosted deployment says `"managed"`, a standalone server
 * says `"selfhost"`, the desktop engine says `"local"`. There is no environment fallback and no
 * sniffing — a host that injects nothing gets a 503 from the route rather than a guessed flavor,
 * because a capability answer that guesses is worse than none: a client's server picker trusts
 * this endpoint to decide which ceremonies exist here.
 *
 * Every field is a CAPABILITY, never a configuration echo: which sign-in ceremonies this server
 * offers, which optional surfaces answer, whether the first account still has to be created.
 * Nothing here is per-account and nothing here is a secret — the endpoint is unauthenticated by
 * design, so the descriptor must hold nothing an anonymous stranger may not learn.
 */
export interface HelloConfig {
  /**
   * Which composition is serving: the hosted service, an operator-run standalone server, or a
   * desktop install's own engine. A fixed string per composition root, never derived per request.
   */
  flavor: "managed" | "selfhost" | "local";
  /**
   * The wire-contract version of the API surface. Defaults to {@link API_VERSION} — every
   * composition compiles the same route table, so the default is the truth unless a host has a
   * reason to say otherwise.
   */
  apiVersion?: string;
  /**
   * Whether this server still has to run its first-account ceremony. A capability form is
   * allowed because the honest answer on a standalone server is a database fact (zero users)
   * that can change between requests; a fixed `false` is correct for compositions whose account
   * lifecycle lives elsewhere. The capability must not throw; if it does anyway, the route
   * answers 503 rather than guessing in either direction — a fresh box hidden behind
   * `needsSetup: false` never gets set up, and an established box behind `true` invites a
   * takeover attempt.
   */
  needsSetup: boolean | (() => Promise<boolean>);
  /** The sign-in ceremonies this server offers. */
  auth: {
    /** Password sign-in (`POST /auth/login`) is mounted and answered here. */
    password: boolean;
    /** TOTP second-factor enrollment/verification is available. */
    totp: boolean;
    /** WebAuthn (passkey) second-factor is available. */
    webauthn: boolean;
    /** Registration without an invite code is open. */
    publicSignup: boolean;
  };
  /** The optional surfaces a client may rely on here. */
  features: {
    /** `GET /events` streams (SSE enabled server-side); off, clients poll `/sync`. */
    sse: boolean;
    /** `POST /attachments/staging` mints upload grants (object storage is armed). */
    staging: boolean;
    /** A model is configured, so the AI surfaces can answer. */
    ai: boolean;
    /** The pairing-token ceremony (`/pair*`) is mounted here. */
    pairing: boolean;
  };
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
   * The per-instance `change_log` wake fan-out for `GET /events`, or absent on a host that
   * cannot hold a LISTEN (transaction-pooled connections cannot — a transaction-mode pooler
   * multiplexes statements across backends, so a LISTEN lands on a backend the next statement
   * has already left). Absent ⇒ the route's own poll loop is the only wake source, which is
   * the pre-hub behaviour exactly. See {@link ChangeWakeHub}.
   */
  changeWake?: ChangeWakeHub | null;
  /**
   * THE VERIFIED-ADDRESS PRODUCT POLICY — does this composition require a PROVEN address
   * before the costly route classes (`work`, `connection`, `paid` — everything outside
   * `UNVERIFIED_MAY_REACH`)? Consumed by exactly one thing: `withSpendGate`.
   *
   * A composition-root decision, not a route option, because the honest answer differs by
   * deployment while the route table is identical everywhere. The hosted service requires it —
   * an unverified account must not be able to generate meaningful cost against OUR bill — and
   * states `true` explicitly. An operator-run standalone server may compose it OFF: there the
   * IMAP credential a mailbox add presents already proves mailbox ownership, the account email
   * is a login identifier on a box the operator pays for, and accounts arriving through a
   * pairing invite legitimately start unverified (see `routes/self-host.ts`, obligation 4).
   *
   * ABSENT ⇒ REQUIRE, and only the exact boolean `false` relaxes. The default direction is
   * non-negotiable: a host that never heard of this field must get the strict gate, because an
   * absent config value that relaxes a gate is a misconfiguration that presents as working. A
   * garbage value from a JavaScript composition root is treated as absent for the same reason
   * an unrecognised `CostClass` is refused.
   */
  requireVerifiedForProduct?: boolean;
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
   * What `GET /hello` reports about this host — see {@link HelloConfig}. Absent, the route
   * answers 503 `hello_unconfigured` rather than inventing a flavor.
   */
  hello?: HelloConfig;
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


