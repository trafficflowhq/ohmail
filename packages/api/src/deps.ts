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
  AttachmentsService, KbService, TagsService, FolderOpsService, DraftsService, DraftingService, SendService,
  ScheduleService,
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
  DraftPort, OpenSendAdapter, KekEnvIdentity, Logger, OAuthTokenProvider, StorageCap,
} from "@trafficflow/core/mail";
/* What a completed SMTP login proved. From the adapter entrypoint rather than the mail barrel
 * because it belongs to the dial, and `imap-probe.ts` — the only implementor — imports it there. */
import type { SmtpLoginProof } from "@trafficflow/core/adapters/imap";
/* The add-time probe's SSRF/port gate. Type-only, so this stays a one-way dependency at runtime —
 * `imap-probe.ts` imports `ApiDeps` from here, and only its TYPES travel back. */
import type { ProbeHostGuard } from "./imap-probe.js";
/* The spend gate's PORT, from the root barrel. `@trafficflow/db/cloud` is the half that answers,
 * and a route table must be able to say it may be handed a gate without depending on the ledger. */
import type { EntitlementsComposition } from "@trafficflow/db";

/**
 * How a host admits an IMAP connection, as a port rather than an import.
 * `acquireImapSlot`/`releaseImapSlot` count through a table created by the cloud journal, and
 * a local install's database is built from the mail journal alone — a desktop attachment
 * fetch was reaching a counter over a table that does not exist. A static import would also
 * pull `@trafficflow/db/cloud` — the whole hosted schema — into the shipped engine artifact.
 * Required, with no default: "always admit" would silently uncap a hosted deployment that
 * forgot to wire it, and a db-backed default would reinstate the import edge. Each host says
 * what it means — the hosted API passes the counter, `apps/sidecar` an always-admit.
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
 * How a host stages attachment bytes out of the request body — a port, optional, and the
 * optionality is the security property. Bytes used to ride the send request base64-encoded,
 * binding every hosted send to the serverless body limit. A host with object storage supplies
 * this; the browser uploads directly and the send carries a reference. A local install must
 * not supply it: its send handler runs in the same process as its own SMTP dial (nothing to
 * stage around), and staging would send a standalone install's bytes to the hosted service's
 * storage. Absent, the mint route is not mounted and `SendService` refuses staged references.
 * Declared here because `routes/drafts.ts` is the one send handler both hosts compile.
 */
export interface AttachmentStagingPort {
  /** Mint one ticket + upload grant. Writes the row BEFORE the object can exist; see the service. */
  mint(input: {
    accountId: string; filename: string; contentType: string; sizeBytes: number; now: Date;
    /**
     * The caller's `Idempotency-Key`, REQUIRED. The ticket's id is this key's digest, so a retry
     * after a lost response resolves to the same row and the same object path rather than minting
     * a second grant against a bucket somebody pays for.
     */
    idempotencyKey: string;
  }): Promise<StagedUploadGrantWire>;
  /**
   * The two-phase staged-bytes source `SendService` reads through — `declare` (metadata, so an
   * over-cap send is refused before any transfer, and so the duplicate fingerprint can name the
   * files without reaching for them) and `fetch` (the bytes, re-measured).
   */
  source: {
    declare(
      accountId: string, ids: readonly string[],
    ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date; filename: string; contentType: string }>>;
    fetch(
      accountId: string, ids: readonly string[], now: Date,
    ): Promise<Array<{ filename: string; contentType: string; content: Buffer }>>;
  };
}

/**
 * Builds the staging port over THIS REQUEST's database handle, exactly as
 * the retired `aiCredits` factory did over the same handle: the bag is per cold instance and
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
   * The session lifecycle — refresh rotation with reuse detection, logout, the device list
   * and its revoke, and `establishPairedDevice`. Optional in `unsubscribe`'s grammar: absence
   * is a first-class state and every route that reads it answers a clean refusal. Declared
   * here as the carved base class, not the full ceremony. Hosted compositions put their full
   * `AuthService` here (it `extends` `SessionLifecycle`, so the ceremony routes keep working
   * through `routes/shared-cloud.ts`); the local engine puts a bare `SessionLifecycle` over
   * its own store, pairing devices without the ceremony or the Cloud schema entering the
   * bundle. Session resolution is unaffected: `withSession` calls `resolveSession`, never this.
   */
  auth?: SessionLifecycle;
  /**
   * The INVITE-grant redeem (`redeemInviteGrant`), as a port. OPTIONAL, and its absence is the
   * honest state of any composition whose database lacks the Cloud-half `invites` table: the
   * `/pair/redeem` invite arm answers `validation_failed` instead of a 42P01 dressed as a 500.
   * The self-host composition wires the real function from the full barrel; the desktop-host
   * door (`routes/desktop-host.ts`, which mounts the redeem) deliberately never does.
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
    smtp: {
      host: string; port: number; secure: boolean; auth: { user: string; pass: string };
      /** The addresses the deployment's {@link ProbeHostGuard} cleared, when it cleared any. The
       * dial connects to one of these and never re-resolves `host` — see `ImapConfig.pin`. */
      pin?: readonly string[];
    },
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
  /**
   * The folder VERBS (stage 2: create / rename / delete) — records user commands in
   * `folder_ops` and rings the doorbell; the WORKER executes them under the organizer lease.
   * OPTIONAL: a host without a worker lane (the standalone local door) wires none, and the
   * /folders verbs answer 500 `folder ops service not configured` there — the pane that could
   * reach them is withheld on that surface anyway (FOLDERS-SPEC.md §17).
   */
  folderOps?: FolderOpsService;
  drafts: DraftsService;     // manual compose drafts (emits `draft` change_log in-tx)
  // SEND LATER's two verbs (mail 0077): `POST`/`DELETE /drafts/:id/schedule` — a draft-state
  // transition, no network, no reservation. The WORKER's scheduled-send pass is the sender.
  // OPTIONAL like `folderOps` and for the same shape of reason: a host wired before this
  // service existed answers 500 `schedule service not configured` rather than crashing at boot.
  schedules?: ScheduleService;
  // AI draft-from-history. `drafting` assembles the sensitivity-safe context + stores
  // the draft; `drafter` is the INJECTED DraftPort (a mock in tests, a model-backed
  // adapter in a deployment that has one). A model needs an API key, which is
  // deployment config, so `drafter` is optional and the route 500s cleanly when it is
  // absent — the same seam the classifier uses.
  drafting?: DraftingService;
  drafter?: DraftPort;
  /* THE AI SPEND GATE IS NO LONGER A MEMBER OF THIS BAG. It was `aiCredits`, a factory over the
   * request's handle building a gate per account, and every route that spent had to know which
   * terms its call site spends on. The spend half of `entitlementsPort` answers it now: one
   * declaration per host, the terms per call site read from the shared table, and the route hands
   * a call site an `action` and a bare attempt key. `spendOf` in `routes/shared.ts` is where the
   * three states — a port, `UNMETERED`, and an unfinished composition — are told apart. */
  /**
   * Who answers "may this account use the service, and within what limits" — an entitlements
   * port, or the literal `UNMETERED` for a host that operates no such program. Declared here
   * rather than `deps-cloud.ts` because every host fills it: the desktop engine and the
   * self-host server say `UNMETERED` out loud, which is the distinction the member keeps —
   * absent is a composition nobody finished, unmetered is a deployment that means it. Absent
   * gates nothing and offers no manage link (`entitlementsOf` in `routes/shared.ts` tells the
   * three states apart). `entitlementsPort`, not `entitlements` — the shorter name is the
   * hosted billing service in `deps-cloud.ts`.
   */
  entitlementsPort?: EntitlementsComposition;
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
   * This host's platform ceiling on total attachment bytes in one send — or `null` for a host
   * that has none, which is the local engine. Deps-level rather than a route constant because
   * `routes/drafts.ts` is the one send handler and both hosts mount it. The hosted deployment
   * declares `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (its serverless body limit in raw bytes); a
   * local install declares `null` — the only ceiling is the mail server's own
   * (`mailboxes.smtp_max_size_bytes`, mail 0055). Absent is neither: a host that has not been
   * read, which {@link SendDeps.surfaceMaxTotalBytes} resolves to the same 3 MB constant
   * rather than to "unbounded" — the strict branch, deliberately.
   */
  sendSurfaceMaxTotalBytes?: number | null;
  /**
   * See {@link AttachmentStagingPort}. Present on a host with object storage; ABSENT on a local
   * install, where its absence is what keeps the standalone door from staging to Cloud storage.
   */
  attachmentStaging?: AttachmentStagingFactory;
  /**
   * The account's managed storage cap, as the send route's sent-copy projection needs it.
   * Declared by every live host: the hosted deployment resolves it from the subscription row
   * (`storageCapOf`), the local engine and the self-host server type `UNMETERED_STORAGE_CAP`.
   * Absent is a host nobody has read, and it resolves to refusal, not to unmetered — the
   * route substitutes a resolver that throws, costing exactly the sent-copy projection
   * (swallow-and-log; the send answered `sent` already, and the worker's Sent-folder pass is
   * the metered backstop). For a storage cap the absent-config default is the dangerous branch.
   */
  storageCapOf?: (ctx: ServiceContext) => Promise<StorageCap>;
}

/**
 * Injectable SSE configuration. Prod defaults keep a `/events` connection bounded; tests pass
 * tiny values for deterministic frames. The poll uses a discrete borrow-and-release query,
 * holding no DB connection between polls. `enabled` and the two caps are cost controls: on a
 * per-invocation-second platform every open `/events` tab is a live function for its whole
 * lifetime, reconnecting forever — one page in a loop is an unbounded bill and a
 * pooler-exhaustion vector. SSE ships off server-side (the client treats it as a lossy,
 * content-free wake signal, so `GET /sync` polling is a complete substitute); turned on, the
 * route refuses more than `maxPerAccount` streams per account or `maxPerInstance` per instance.
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
 * The per-instance `change_log` wake fan-out — what turns `GET /events` from a poll relay
 * into a push relay. The host that can hold a LISTEN builds one per warm instance — one
 * session-mode connection, never one per stream — and every open `/events` stream subscribes
 * its account; a NOTIFY from `recordChanges` (`packages/db/src/change-log.ts`) fans out in
 * process. A hint, not a dependency, on both sides: a host with no hub gets the route's own
 * poll loop (the pre-hub behaviour), and a hub whose LISTEN is down delivers nothing while
 * the poll bounds the staleness. `subscribe` must not throw, and the returned unsubscribe
 * must be idempotent — the route calls it from `stop()`, which can run twice.
 */
export interface ChangeWakeHub {
  subscribe(accountId: string, onWake: (seq: bigint) => void): () => void;
}

/**
 * One pager arm's standing verdict, as `GET /health` publishes it. A structural mirror of
 * `AlertSinkHealth` (`packages/db/src/alerts.ts`), deliberately not an import: this file is
 * compiled by every host, the shipped local engine included, and that type belongs to the
 * hosted half. The mirror cannot drift silently — the projector that fills it
 * (`apiAlertSinkSummary`) is annotated with this type. The projection is written field by
 * field, and that is load-bearing: structural assignability accepts a wider object and
 * `JSON.stringify` publishes what an object holds — forwarding rows would put a later-added
 * field, a vendor's own error sentence among the candidates, onto a public endpoint.
 */
export interface AlertArmHealth {
  /** The sink's name (`"webhook"`, `"telegram"`, `"mail"`). Not an endpoint and not a credential. */
  name: string;
  /** Its most recent CLOSED code, or null — this instance has never attempted it. */
  outcome: "ok" | "misconfigured" | "refused" | "unreachable" | "timeout" | "threw" | null;
  /** Consecutive failures of THIS arm, cleared by a success of its own and by nothing else. */
  consecutiveFailures: number;
  /** Delivery attempts this instance has made on this arm. `0` ⇒ never exercised here. */
  attempts: number;
  /** When this arm last accepted, ISO-8601, or null. */
  lastOkAt: string | null;
}

/**
 * THE WHOLE PAGER, as `GET /health` publishes it: which arms exist, and what this instance has
 * seen them do.
 *
 * Two fields and not one, because they have different lifetimes and only saying so keeps the
 * numbers honest — see {@link AlertSinkSummary.passes}.
 */
export interface AlertSinkSummary {
  /**
   * Every configured arm, in composition order. `[]` is a statement, not an absence: this
   * host has no way to page anybody. Exactly one entry is the single-vendor pager — the
   * state that delivers every page correctly right up to its vendor's outage and then
   * delivers nothing, with no failed delivery to escalate and no arm left to carry the
   * escalation. Instance-independent: it is the composition, so the names and the count read
   * the same from any instance of this deployment.
   */
  arms: AlertArmHealth[];
  /**
   * How many alert passes this instance has run. The per-arm counters in
   * {@link AlertSinkSummary.arms} are one warm instance's delivery streak, so a cold instance
   * reports `attempts: 0` for an arm that has delivered for months; `passes: 0` says the
   * counters beside it are cold rather than that the pager is dead. Run, not "completed": a
   * pass counts from the moment it could mutate the streak, so a pass that mutated the arms
   * and then failed is counted — counting completions let a supported failure publish fresh
   * per-arm counters beside `passes: 0`. The residual looseness runs the harmless way:
   * `passes` can over-report activity, never under-report it.
   */
  passes: number;
}

/**
 * What `GET /health` publishes about the host itself. `kek` is the {@link KekEnvIdentity} —
 * `{ active, count, fingerprint }` — the same object, from the same `kekEnvIdentity()` in
 * `@trafficflow/core`, that the worker renders at its own `/health`. That is the point: a KEK
 * that differs between the API host and the worker makes every `mailbox_credentials` row
 * undecryptable on one of them, with no error until a mailbox is touched. Comparing the two
 * `/health` responses must be sufficient to see it, and all three fields must match. Absent
 * on `ApiDeps`, the route falls back to `kekEnvIdentity(process.env)` and
 * {@link API_VERSION}, so a host that forgets to inject still reports truthfully.
 */
/**
 * Where {@link HealthConfig.version} came from, ordered by how tightly each is bound to the
 * artifact — same four values and meaning as the worker's `BuildIdentitySource`
 * (`apps/worker/src/build-version.ts`): `"platform"` (the platform's own git metadata),
 * `"file"` (a build-identity file written into the deployed tree — an input to the artifact),
 * `"variable"` (an operator-set project variable that can go stale while an old build keeps
 * serving), `"none"`. A deploy from a `git archive` extraction carries no `.git`, so the
 * platform sets no sha and the host falls through; the source is published beside the value
 * so a consumer can tell a stale label from an identity read out of the artifact.
 */
export type BuildIdentitySource = "platform" | "file" | "variable" | "none";

export interface HealthConfig {
  /** Build identity — the deployment's commit sha where the platform provides one. */
  version: string;
  /**
   * Where {@link HealthConfig.version} came from — see {@link BuildIdentitySource}. Absent on a
   * host that has not adopted per-source resolution; `/health` then omits the provenance rather
   * than guessing one.
   */
  buildSource?: BuildIdentitySource | null;
  /**
   * Which schema this host is supposed to have. Absent means both journals — every hosted
   * deployment. `"mail"` is the local engine: it migrates the mail journal alone and has no
   * billing ledger, no passkey challenge store, no staff directory; probed against the full
   * set it would answer `503 schema_incomplete` forever about a database that is complete for
   * what it is. Declared by the host rather than sniffed from the database: inferring the
   * tier from what is missing would make a genuinely half-migrated hosted deployment — the
   * reachable mail-committed/cloud-failed state — indistinguishable from a healthy desktop
   * install, the exact state the probe exists to catch.
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
   * Why this deployment has no staff surface, or null when it has one. Present ⇒ `/health`
   * publishes `adminFault: <reason>` and every `/admin/*` route answers 404 — the only
   * channel that can say so, since an unarmed surface has no endpoint left to report its own
   * absence. It does not make `/health` answer 503, deliberately: `healthFault` is for faults
   * that make the deployment unfit to serve users (a wrong database, an unusable KEK); an
   * unarmed staff console is not one, and a 503 would take the product out of rotation over
   * an internal tool's configuration. The fault is named in a body one curl reads.
   */
  adminError?: string | null;
  /**
   * Why this deployment has no staff surface, or null when it has one. Present ⇒ `/health`
   * publishes `adminFault: <reason>` and every `/admin/*` route answers 404 — the only
   * channel left, since an unarmed surface has no endpoint to report its own absence. It
   * does not make `/health` answer 503: `healthFault` is for faults that make the deployment
   * unfit to serve users (a wrong database, an unusable KEK); an unarmed staff console is
   * not one, and a 503 would take the product out of rotation over an internal tool's
   * configuration. The fault is named in a body one curl reads.
   */
  staffDbAttestation?: (() => Promise<string | null>) | null;
  /**
   * Run the content-blind attestation and publish its result, non-fatally. A capability, not
   * a value: `/health` calls it and merges a `staffDbFault` string when one returns. It
   * awaits the memoised staff-handle factory (census + bite round trips on the first
   * `/health` per cold instance only), never throws, and never makes `/health` 503 — an
   * over-privileged `DATABASE_URL_ADMIN` is a dark console, not a reason to take the product
   * out of rotation. The counterpart to `adminError`: that names the static refusals visible
   * at boot; this names what an absent-var check cannot see — a plausible role whose
   * effective privileges exceed the allowlist. Absent on hosts with no blind connection.
   */
  alertsError?: string | null;
  /**
   * The pager is configured and cannot run. Present ⇒ `/health` publishes
   * `alertsFault: <reason>` and the three `/internal/alerts*` routes answer 503
   * `alerts_db_unarmed`. Set when the alerting block is armed and the content-blind
   * connection is not — "the console is off" is a Monday problem, "nothing is watching the
   * worker" is an outage nobody is paged for. It does not make `/health` 503, for
   * {@link HealthConfig.adminError}'s reason, only more so. Three rings: the routes answer
   * non-2xx so the scheduled CI health check goes red and mails the operator, and the hosted
   * API's build configuration refuses to build a production host that could reach the state.
   */
  dbProvider?: string | null;
  /**
   * Which provider family this host's runtime connection belongs to — one of the fixed
   * strings `providerFamily` returns (`packages/db/src/session-url.ts`), `"unrecognized"`
   * included. Not a fault, never a 503. The connection guards it accompanies once recognised
   * a managed Postgres by the then-current provider's hostname — a provider move made every
   * guard unconditionally true-negative while every fixture stayed green. `"unrecognized"`
   * on the live host says the refusals have become decoration, turning "read `/health` after
   * a deploy" into the tripwire. Safe to publish: an identity, one of three fixed strings —
   * no host, no port, no role, no credential.
   */
  entitlements?: "configured" | "unmetered" | null;
/**
 * Every configured pager arm on this host, and whether it is actually delivering. A capability,
 * not a value: the memory is the alert driver's own delivery streak, in the route module that
 * mutates it, and deriving the summary at call time stops it drifting from the streak the pass
 * wrote. The worker names its arms in a startup line; a serverless host has none, and it is the
 * only observer of a dead worker. Absent means no pager by construction and publishes no key;
 * present with `arms: []` is the opposite claim — meant to page and cannot — so the hosted host
 * injects unconditionally. No vendor prose: names, closed codes, counts and timestamps only; this
 * endpoint is reachable by anyone.
 */
  alertSinks?: (() => AlertSinkSummary) | null;
}

/**
 * What `GET /hello` publishes about the host — server identity and capability negotiation.
 * The route serves this descriptor verbatim (plus the constant `product` and a defaulted
 * `apiVersion`), so each composition states its own truth at its composition root: the
 * hosted deployment says `"managed"`, a standalone server `"selfhost"`, the desktop engine
 * `"local"`. No environment fallback and no sniffing — a host that injects nothing gets a
 * 503 rather than a guessed flavor, because a client's server picker trusts this endpoint to
 * decide which ceremonies exist here. Every field is a capability, never a configuration
 * echo; nothing here is per-account or secret — the endpoint is unauthenticated by design.
 */
export interface HelloConfig {
  /**
   * Which composition is serving: the hosted service, an operator-run standalone server, a
   * desktop install's own engine (its window's private door), or that same engine's
   * desktop-host door — the surface a paired phone reaches (Phase 3). A fixed string per
   * composition root, never derived per request. Widening this union is an additive contract
   * change: every client that switches on it must be told, and the contract tests that pin the
   * wire shape move in the same commit.
   */
  flavor: "managed" | "selfhost" | "local" | "desktop-host";
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
  /**
   * The platform scheduler's own credential (`CRON_SECRET`), independent of the alerting block.
   * Absent or `null` ⇒ this host has no cron credential; a scheduled route then falls back to
   * whatever gate it has of its own, and answers 404 only when it has none at all.
   */
  cronSecret?: string | null;
  /**
   * On a `credentialSubject` route, the account the presented CREDENTIAL resolved to — set through
   * `ServiceContext.noteCredentialAccount` by the seam that minted or rotated the session, and
   * read by `createApp.handle` to name the response. Absent means the response established
   * nothing for anybody (a refused sign-in, a challenge with no tokens in it), and the account
   * header is then omitted. Never read on any other route.
   */
  credentialAccount?: string | null;
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
   * The verified-address product policy — does this composition require a proven address
   * before the costly route classes (`work`, `connection`, `paid`)? Consumed by exactly one
   * thing: `withSpendGate`. A composition-root decision, not a route option: the hosted
   * service requires it (an unverified account must not generate cost against our bill) and
   * states `true`; an operator-run standalone server may compose it off — there the IMAP
   * credential already proves mailbox ownership (`routes/self-host.ts`, obligation 4).
   * Absent ⇒ require, and only the exact boolean `false` relaxes: an absent value that
   * relaxes a gate is a misconfiguration that presents as working. Garbage is absent.
   */
  requireVerifiedForProduct?: boolean;
  /**
   * Whether the `tf_session` cookie is an accepted credential on this deployment. Default
   * (absent or true) is cookie OR bearer. `false` makes the host bearer-only —
   * `readSessionToken` ignores the cookie entirely, so an ambient cookie cannot authenticate
   * a request. That is the mechanism behind the native/desktop surface: its clients hold a
   * bearer token from the OAuth2 PKCE flow and are not browsers, so `withCsrf` is a no-op by
   * construction (`via` can never be `"cookie"`). Not merely "prefer bearer": a request
   * presenting both is treated as bearer-only, and a cookie-only request is 401, not 403 —
   * it carries no credential this deployment recognises.
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
   * This deployment's VAPID public key, base64url — what `GET /push/vapid-key` serves. A
   * UnifiedPush connector cannot register without one, so the phone has to be able to ask.
   * The private half is read by the organizer and nothing else: no request handler has any
   * business signing a wake, and keeping the signing key out of the serverless surface is
   * cheaper than auditing that nothing there reaches for it. Absent or `null` means this host
   * has no keypair and the route answers `{ publicKey: null }` — a real answer, not an error.
   * Deliberately not a `/hello` feature flag: a boolean there and a key here could disagree,
   * and a client would be told the capability exists by one route and refused it by the other.
   */
  vapidPublicKey?: string | null;
  /**
   * The structured logger for this request. `withRequestId` binds `requestId` onto it, so
   * every line a handler or middleware writes downstream carries the id the client also
   * received in `x-request-id` — a user reporting "my send failed at 14:32" hands over one
   * value that selects every line of that request. Optional and defaulting to
   * {@link silentLogger}: a route table must not print to a host's stdout because the host
   * forgot to inject a logger, and no test should have to mute a global.
   */
  logger?: Logger;
  /** See {@link ApiFaultLogPort}. */
  faultLog?: ApiFaultLogPort;
}

/**
 * WHERE A 5xx GOES TO BE COUNTED — a port, because this file ships inside the desktop engine
 * and may never name a Cloud table (`DB_ACQUIRE_TIMEOUT_ERROR`'s reason, one file over).
 *
 * ABSENT and FAILING are two states and both are named. Absent is the desktop and every local
 * install: no such table, nothing recorded, nothing said. Present-and-throwing is a hosted
 * board going dark, and the envelope logs it once. Collapsing them would either spam a desktop
 * log or hide a broken board.
 */
export interface ApiFaultLogPort {
  /**
   * Never throws, never rejects, and never changes the answer. The envelope awaits it — a
   * serverless invocation is killed the moment it returns, so a floating promise here would
   * record nothing on precisely the platform this table exists for — but it awaits it behind the
   * implementation's own deadline, and a fault that cannot be recorded must still be answered.
   */
  record(fault: {
    route: string; method: string; status: number;
    errorClass: string; requestId: string | null; at: Date;
  }): Promise<void>;
}


