import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import {
  StaticKeyProvider, kekRingFingerprint,
  type KekEnvIdentity, type KeyProvider, type OpenSendAdapter, type SendAdapter,
} from "@trafficflow/core/mail";
import { ImapAdapter, buildImapAuth, type ImapConfig, type MailboxAdapter, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
// The engine's OWN resolution of the Ohbox posture, never a second reading of it. `rules.ts` owns
// what an absent or unrecognised value means, and both hosts ask it the same question.
import { DEFAULT_OHBOX_POLICY, providerAuthservIds, resolveOhboxPolicy } from "@trafficflow/core/mail";
// After the `@trafficflow/core` block, matching every other file in this package: core first,
// then the private half. `packages/core` → `@trafficflow/db` is a real edge (`pipeline.ts` imports
// `classifyLedgerSource`, `drizzle-repo.ts` imports the tables), so this file should not be the
// module that enters that graph.
import { accountSettings, mailboxCredentials, mailboxes, type MailboxDisabledReason, type Tx } from "@trafficflow/db";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService,
  kbService, tagsService,
  makeApprovalService, makeAuthConfig, makeMailboxService, makePrivacyService,
  makeScreenerService, messageService, notifyRulesService, resolveSession,
  rulesService, searchService, sendService, snippetsService, syncService, threadService,
  triageService, workflowsService, ServiceError,
  type AuthConfig, type HostResolver, type MailboxAllowancePolicy, type PushService, type RemoteFetch,
} from "@trafficflow/services/mail";
import {
  API_VERSION, ALLOW_ANY_PROBE_HOST, createApp, DEFAULT_SSE, localRoutes,
  type ApiDeps, type ApiServices, type App,
} from "@trafficflow/api/local";
// ── THE ONE PIPELINE ────────────────────────────────────────────────────────────────────────
// `runSyncCycle` is imported, never reimplemented. There is ONE pipeline implementation and both
// the desktop engine and the hosted service run it: two engines diverge, and divergence here means
// mail filed differently on desktop than in the cloud. A local copy of this loop would be a second
// implementation of ingest ordering, cursor advancement and reconcile — exactly the defect the
// single-implementation rule exists to prevent — so the sidecar takes the dependency instead.
//
// It lives in the worker package today because the worker was its only caller. If the loop later
// moves into a package shared by both hosts, this import moves with it and nothing else here
// changes. A test in this package fails if a second copy of the loop ever appears beside it.
import { runSyncCycle, type SyncDeps } from "@trafficflow/worker/sync";
// The ORGANIZER LEASE, from the same package and for the same reason: two readings of one decision
// table is how a LOCAL install and the CLOUD service come to disagree about who organizes a
// mailbox, and disagreement here IS the dual-organizer bug.
import { readMailboxLease, LeaseUnavailableError } from "@trafficflow/worker/lease";
// The SCHEDULED-RESURFACE FLIP, from the same package and for the third instance of the same
// argument. "Resurfaces Friday at 9" is a dated promise the product makes to the user, and the
// only thing that can keep it is a pass that notices the date has arrived. On a hosted account
// the worker's cycle runs it; a standalone install has no worker at all, so this process runs the
// SAME function against the store that is authoritative here. A local reimplementation would be a
// second answer to "when is a resurface due", which is the one thing that must not differ.
import { bubbleUpPass } from "@trafficflow/worker/bubble-up";
import { createLocalAi, type LocalAi } from "./ai-provider.js";
import { localAiRoutes } from "./ai-routes.js";
import { openLocalDb, type LocalDb, type LocalDbOpenPhase, type OpenLocalDb } from "./db.js";
import { ensureLocalWorld, mintLaunchSession, type LocalWorld } from "./identity.js";
import { stampSynced } from "./sync-stamp.js";
import type { Diagnostic } from "./log.js";

/**
 * THE LOCAL ENGINE — `createApp(apiRoutes)` over on-disk PGlite, an `ImapAdapter` against the
 * user's own server, and the shared sync loop, assembled into one process.
 *
 * Everything a Cloud deployment configures and this one does not is an absence with a reason, not
 * an oversight. Read the service bag below as the answer to "what is Cloud, and what is mail?".
 */

/**
 * The user's own server, with the PASSWORD OPTIONAL — which is the whole shape of this type.
 *
 * Host, port and username are settings: the shell has them and passes them on every launch. The
 * password is a secret, and after first run it lives envelope-encrypted in `mailbox_credentials`
 * rather than in this process's environment. A launch that carries no password is therefore the
 * STEADY STATE and not an error, so the type has to be able to say so.
 */
export type SidecarImapConfig = Omit<ImapConfig, "auth"> & { auth: { user: string; pass?: string } };

/**
 * Whether this launch can open the user's mailbox, and if not, why not. The shell renders it as
 * the difference between "you are connected", "enter your password" and "enter it again".
 */
export type CredentialState =
  /** A password is available — from the store, or from the environment on a first run. */
  | "ready"
  /** No password anywhere. The shell asks for one; nothing is broken and nothing is lost. */
  | "absent"
  /**
   * A stored credential exists and THIS key cannot open it — a replaced keystore entry, a
   * retired key version, a corrupt envelope. Recoverable by re-entering the password, which
   * re-seals the row under the current key. See {@link createSidecar}'s resolution.
   */
  | "unreadable";

export interface SidecarConfig {
  /** Where the local mirror lives. Created if absent; locked while open. */
  dataDir: string;
  /** The user's own IMAP (and optionally SMTP) server. */
  imap: SidecarImapConfig;
  /** The mailbox address. Defaults to the IMAP username, which is what it is for most servers. */
  address?: string;
  displayName?: string;
  /** How long to wait between cycles when the mailbox is quiet. */
  pollIntervalMs?: number;
  /**
   * Diagnostics. NEVER stdout in the real process — stdout is the frame stream.
   *
   * Production passes `createSidecarLog()`, which is `packages/core`'s hardened logger. The same
   * function is handed to `readMailboxLease`, so anything the lease composition logs is redacted
   * by the same gate — which is why this stays a two-argument function and not a `Logger`.
   */
  log?: Diagnostic;
  /**
   * THE PER-INSTALL KEY RING, from the native shell's keystore. `version → 32-byte key`.
   *
   * The shell owns the keystore and this process never reaches for one: it is a Node child, and
   * giving it a native keystore module would both duplicate the encryption and break the
   * single-bundled-binary story. So exactly one thing crosses the boundary, in one direction —
   * the shell hands over the key at spawn, and the key never travels back.
   *
   * A RING and not one key, because a key that cannot be rotated is a key that cannot be revoked.
   * The shape is the one the hosted service already uses (`packages/core/src/crypto.ts`): the
   * highest version is active and encrypts new secrets, every older version stays loaded so rows
   * carrying an earlier `key_version` still decrypt, and re-encryption is lazy — a row moves to
   * the new key the next time it is written. Rotating is therefore "add the new version, keep the
   * old one until nothing references it", with no data migration and no downtime.
   *
   * **Absent ⇒ this install has no durable key**, and the consequence is deliberate and narrow:
   * nothing is sealed to disk at all. A key that dies with the process must never write down
   * something the next process cannot read, so credential storage is REFUSED rather than
   * performed badly ({@link refusingKeyProvider}). Such an install still works exactly as it did
   * before this existed — the shell passes the password on every launch.
   */
  keks?: Record<number, Buffer>;
  /** Injected for tests; production dials a real server. */
  adapterFactory?: (cfg: ImapConfig) => MailboxAdapter;
  /**
   * TEST SEAM for the ONE thing in this process that reaches a network other than the mailbox:
   * the model endpoint its owner configured. Production passes nothing and the platform's own
   * `fetch` is used.
   *
   * It is a seam rather than a module-level import so a test can prove the negative that matters
   * most — that an install with no model configured makes NO outbound request at all — by
   * counting calls rather than by reading the code and believing it.
   */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * How this install names itself in the organizer claim it writes to `ohmail/_meta`.
   *
   * The takeover prompt in Cloud's connect flow reads `ohmail on <machine> organizes this
   * mailbox`, so this has to be a name a human recognises.
   * Defaults to the machine's hostname, which is the only thing this process knows about the
   * machine without asking the shell.
   */
  machineName?: string;
  /**
   * TEST SEAM. The lease's staleness window, which no test can afford to wait out.
   * Production takes the engine's ten minutes.
   */
  leaseStaleAfterMs?: number;
  /**
   * Told what the boot is about to spend its time on, phase by phase, as it happens.
   *
   * `boot_phases` (the log line at the bottom of this constructor) is the same story told
   * afterwards, with numbers; this is the live narration `main.ts` turns into `phase` frames so
   * the window can say "Replaying recent changes…" instead of one sentence for every wait.
   * Best-effort and never awaited: a boot must not be able to fail, or slow, because somebody is
   * watching it.
   */
  onPhase?: (phase: BootPhase) => void;
}

/**
 * The boot, as the moments a person watching the window can be told about. The database phases
 * are {@link LocalDbOpenPhase}; `preparing` is everything after the store is open — identity,
 * key ring, the AI assembly, the route table — which is fast and is named so the narration never
 * just stops at the last database phase on a launch where the remainder is what is left.
 */
export type BootPhase = LocalDbOpenPhase | "preparing";

/** Why this install is not organizing its mailbox, when it is not. */
export interface OrganizerState {
  organizing: boolean;
  /** The closed-set reason, mirrored onto the local `mailboxes` row. */
  reason: MailboxDisabledReason | null;
  /** The other organizer's display name, so the UI can say WHICH machine. */
  heldBy: string | null;
}

export interface Sidecar {
  readonly app: App;
  readonly db: LocalDb;
  readonly repo: WorkerRepo;
  readonly adapter: MailboxAdapter;
  readonly world: LocalWorld;
  /** The per-launch bearer token. In memory only. */
  readonly sessionToken: string;
  /** `Request → Response`, with a fresh `ApiDeps` per call. This is what the stdio host serves. */
  handle(req: Request): Promise<Response>;
  /**
   * Run cycles until the mailbox reports no backlog, then return how many ran.
   *
   * The drain is the contract, not an optimisation: `changesSince` returns a BOUNDED batch (the
   * adapter's memory budget, sized after an unbounded one exhausted the heap), holds the folder
   * cursor while truncated, and tells the caller so. A caller that ran one cycle per poll interval
   * would take a cold mailbox from minutes to hours, one batch per interval — the hosted sync
   * worker re-kicks for exactly this reason and so does this.
   */
  syncUntilQuiet(maxCycles?: number): Promise<number>;
  /** Connect, ensure the `ohmail/*` tree exists, drain, then poll. */
  start(): Promise<void>;
  /**
   * Whether this install is currently this mailbox's organizer, and if not, who is.
   *
   * A PROPERTY, never a toggle: the shell renders it as one line and at most one action. There
   * is deliberately no setter — ceasing to organize is automatic and becoming one is an explicit
   * human action that goes through the mailbox row, not through a field on this object.
   */
  organizerState(): OrganizerState;
  /**
   * Can this install open the user's mailbox right now?
   *
   * Read fresh from the store on every call rather than cached from launch, because the answer
   * CHANGES while the process runs: the shell's whole recovery flow is to show a password field,
   * `PATCH /mailboxes/:id`, and ask again. A cached value would still say `unreadable` after the
   * user had fixed it.
   *
   * Note what it does NOT do: it never returns the password, to this caller or any other. The
   * plaintext exists in this process only as the argument `ImapAdapter` was constructed with.
   */
  credentialState(): Promise<CredentialState>;
  /**
   * Forget the stored mailbox password. Answers whether there was one to forget.
   *
   * This is what makes signing out of the LOCAL door mean something. The shell can delete its own
   * configuration file and stop this process, but the sealed credential lives inside the mirror's
   * database — and the mirror is FROZEN on a door switch rather than deleted, because the mail is
   * on the user's own server and re-pulling it is expensive and pointless. So the one thing that
   * has to go is removed here, over the bridge, leaving everything else exactly where it is.
   *
   * It does not disconnect: the adapter this launch built is already holding an authenticated
   * socket, and tearing that down mid-request is the shell's job through the process lifetime it
   * owns. The next launch has no password and serves the mirror, which is the documented no-password
   * state and not a new one.
   */
  forgetStoredLogin(): Promise<boolean>;
  /** Stop polling, let the in-flight cycle finish, close IMAP, close and unlock the database. */
  stop(): Promise<void>;
}

/**
 * The key provider for an install with NO durable key: it refuses instead of encrypting.
 *
 * Modelled on the hosted API's `poisonedKeyProvider`, and here for a sharper reason. A launch-
 * scoped key that is allowed to encrypt produces a `mailbox_credentials` row that is already
 * garbage by the time anyone reads it — the write succeeds, the API answers 200, the shell stops
 * passing the password, and the failure surfaces on the NEXT launch as a mailbox that cannot be
 * opened. Refusing at the moment of the write turns that into an error the user sees while they
 * are still looking at the password field.
 *
 * `503` and not `500`: the request was well-formed and the server is the thing that is not ready.
 * The code is the same one the log line uses, so the two are greppable together.
 */
export function refusingKeyProvider(): KeyProvider {
  const refuse = (): never => {
    throw new ServiceError(
      "install_key_absent", 503,
      "this install has no durable key, so a password cannot be stored on this machine. " +
        "Nothing was written down: a key that dies with the process would seal a credential " +
        "the next launch could not open.",
    );
  };
  return {
    encrypt: async () => refuse(),
    decrypt: async () => refuse(),
    currentKeyVersion: () => refuse(),
  };
}

/**
 * The image proxy's egress, refused.
 *
 * The spy-pixel blocker exists so remote content is fetched only when the user asks. On Cloud the
 * fetch goes out from our server. On desktop it would go out from the user's own machine, where
 * every socket this process opens is meant to sit behind an ALLOW-LIST — their IMAP/SMTP server,
 * their own AI endpoint, nothing else — so that a message can never make the machine it is read on
 * talk to a host of the sender's choosing. That allow-list is not built yet, so the honest default
 * until it lands is to refuse: a blocked pixel is the product working, an un-allow-listed request
 * is not.
 */
const REFUSING_REMOTE_FETCH: RemoteFetch = {
  async fetch() {
    return { status: 502, contentType: null, body: new Uint8Array(0) };
  },
};

/**
 * The SSRF gate resolves a hostname itself so it can refuse a name that points at
 * a private or loopback address, so a resolver is REQUIRED rather than optional.
 * This host has no egress to spend on the lookup, so it answers "nothing", which
 * the gate treats as "did not resolve" — a refusal one step earlier than
 * {@link REFUSING_REMOTE_FETCH}. Both stay: the allow-list replaces them together,
 * and until then a blocked pixel is the product working.
 */
const REFUSING_RESOLVER: HostResolver = {
  async resolve() {
    return [];
  },
};

/**
 * The LOCAL service bag.
 *
 * Present: the mail domain. Absent, deliberately, each one meaning something:
 *  · `billing` / `waitlist` — Cloud is what you pay for; the desktop tier is free and has no
 *    signup at all. Both answer 503 when absent, which is the truth about this host.
 *  · `aiCredits` — the ledger is Cloud's revenue-first spend gate. Desktop is BYO key or a local
 *    model, so there is no allowance to meter and an absent gate means unmetered, not ungated.
 *  · `drafter` / `classifier` — PRESENT ONLY WHEN THIS INSTALL HAS A VERIFIED MODEL of its
 *    owner's own (`ai-provider.ts`), and absent the rest of the time. Absence rather than a port
 *    that refuses, deliberately: the route table already answers `503 drafter_unconfigured` for
 *    an absent drafter, so "this install has no model" keeps ONE name in the vocabulary every
 *    host shares. Rules-only is the product's floor and a complete mail organizer on its own; a
 *    model adds to it and is never a prerequisite for it.
 *  · `sends` / `sendAdapter` — PRESENT. `sends` is the shared `SendService` — the same gated,
 *    crash-safe idempotent send Cloud runs, reused rather than reimplemented — and `sendAdapter`
 *    is the local factory ({@link createSidecar}'s `openLocalSend`) that opens SMTP+IMAP for one
 *    send. It differs from the hosted `makeSendAdapter` in exactly one place: the SMTP transport
 *    COORDINATES (host/port/implicit-TLS) come from `config.imap.smtp` — the `OHMAIL_SMTP_*` the
 *    shell set — while the AUTH is the SAME single sealed credential the IMAP side decrypts. One
 *    secret per mailbox; the environment carries the server, never the password.
 *  · `alerts` / `admin` — an operator surface on a single user's laptop is nothing but attack
 *    surface. Absent ⇒ 404, which is the correct answer.
 *  · `proposals` — the proposer asks a model what workflow the user keeps doing by hand. No model
 *    is configured here, so it could only ever answer "none", which is a different claim from
 *    "nobody asked". Absent is the honest one, and it keeps the drafting and taxonomy prompts out
 *    of this artifact entirely.
 *
 * `screener` and `approval` are built WITHOUT an adapter, exactly as the serverless host builds
 * them: a decision writes desired state and the physical IMAP move is done by the loop's
 * reconcile pass. On Cloud that separates a serverless function from the worker; here they are one
 * process, and keeping the deferral is what stops the local build acquiring a second write path
 * into IMAP that Cloud does not have.
 */
/**
 * **THE DESKTOP TIER HAS NO MAILBOX LIMIT, AND NOWHERE TO READ ONE FROM.**
 *
 * The hosted gate takes a `SELECT … FOR UPDATE` over the subscription table — the lock that
 * serializes concurrent creates against a plan's count. A local install migrates the mail journal
 * alone, so no subscription table exists here and none must: it belongs to a service the person
 * running this machine has no account with. Left on the default gate, every mailbox write here
 * fails with a `relation … does not exist` error naming that missing table, which is how this
 * was found.
 *
 * ── WHY IT LIVES IN THIS FILE ─────────────────────────────────────────────────────────────
 *
 * This is the only permissive allowance policy in the repository, and it is defined in the
 * desktop engine rather than exported from `@trafficflow/services` **so that the hosted API has
 * no name for it.** A bypass the Cloud host cannot import is a bypass it cannot take by accident:
 * there is no config value, no environment variable and no flag that reaches it — reaching it
 * requires an import of `apps/sidecar`, which nothing serverless does or could.
 *
 * It is the free tier stated once, in the same list as `billing`, `waitlist` and `aiCredits`
 * above, for the same reason: absent metering here means UNMETERED, not ungated. What still gates
 * a local mailbox is everything that is not about money — the active-address unique index, the
 * IMAP probe, and the organizer lease that keeps exactly one organizer per mailbox.
 */
export const UNMETERED_MAILBOX_ALLOWANCE: MailboxAllowancePolicy = async () => {
  /* No plan, no count, no lock. The desktop tier is free and its limit is the user's disk. */
};

/**
 * PUSH HAS NO LOCAL STORE, and saying so is the honest version of what was already happening.
 *
 * `PushService` reads and writes the push registration table, which the CLOUD migration journal
 * creates. A local database is built from the MAIL journal alone (`db.ts`), so the table is not
 * there: every call to the real service from a desktop install was a query against a relation
 * that does not exist, answered as a 500. This refuses in the vocabulary the routes already
 * speak, and it keeps `@trafficflow/db/cloud` — billing, the ledger, the staff handle — out of
 * the shipped engine bundle, which a static import of the real service would put there.
 *
 * A desktop notification is the shell's to raise from the local event stream; it does not need a
 * subscription registered with a server.
 */
const LOCAL_PUSH: PushService = {
  async subscribe() {
    throw new ServiceError("not_found", 404, "push subscriptions are a Cloud feature");
  },
  async unsubscribe() {
    throw new ServiceError("not_found", 404, "push subscriptions are a Cloud feature");
  },
} as unknown as PushService;

/**
 * A local install ADMITS, always, and the reason is not that the cap does not matter.
 *
 * The counter behind {@link ImapAdmissionPort} lives in a per-address attempt table the Cloud
 * journal creates, which this database does not have. What the cap protects against is a
 * MULTI-TENANT burst: many
 * accounts' attachment fetches plus a worker, in two processes that share no lock, against one
 * provider's per-account connection limit. Here there is one user, one process, and
 * `attachments-adapter.ts`'s in-process semaphore — which runs FIRST and is not affected by this
 * — already bounds how many sockets that one user can open at a time.
 */
const LOCAL_IMAP_ADMISSION = {
  acquire: async () => true,
  release: async () => {},
};

/**
 * The service bag, rebuilt PER REQUEST so the two AI slots can be present or absent according to
 * what this install can actually do at the moment it is asked.
 *
 * Per request rather than once per launch because the answer changes while the process runs:
 * somebody saves a key, the endpoint stops answering, a verification succeeds. A bag built at
 * launch would freeze that answer, and a route would then either offer a model that is gone or
 * refuse one that has been configured — both of which are worse than the small cost of rebuilding
 * a handful of stateless service objects. Every service in it is either an imported singleton or
 * a constructor that only stores its arguments; there is no per-request work here beyond the
 * object literal.
 *
 * `ai` is `undefined` for a host that has no AI at all, which is what the tests that predate this
 * pass — and it is the same shape as an install that has simply not configured one.
 */
function localServices(
  authConfig: AuthConfig,
  keyProvider: KeyProvider,
  openSendAdapter: OpenSendAdapter,
  ai?: LocalAi,
): ApiServices {
  const classifier = ai?.classifier();
  const drafter = ai?.drafter();
  return {
    sync: syncService,
    // THE GATED IDEMPOTENT SEND, and the SAME `SendService` Cloud runs — the `outbound_sends`
    // reservation, the pre-minted Message-ID, the verify-by-Sent recovery and `SEND_STALE_AFTER_MS`
    // are all the shared implementation. Only the transport differs, and that difference is
    // `sendAdapter` below: `openLocalSend` builds SMTP from `config.imap.smtp` and authenticates
    // with the one sealed credential the IMAP side decrypts. Forking a second sender here is
    // exactly the divergence the one-pipeline rule forbids on the receive side, for the same reason.
    sends: sendService,
    sendAdapter: openSendAdapter,
    // NO PLATFORM CEILING ON ATTACHMENT BYTES, and that is a fact about this host rather than a
    // preference. The hosted API runs behind a serverless request-body limit, and the 3 MB
    // constant in `SendService` is that limit expressed in raw bytes — reasoned entirely from a
    // deployment this process is not. Here the compose form, this handler and the SMTP dial are
    // one process: there is no request body anywhere between them, so the only ceiling that
    // exists is the one the user's own submission server announced
    // (`mailboxes.smtp_max_size_bytes`, mail 0055), which `SendService` applies.
    //
    // `null` is a DECLARATION and not an absence — an install that said nothing would get the
    // hosted constant, which is the stricter branch and the right default for a host that has
    // not been read. Until a local install's server has been probed the column is NULL and this
    // still resolves to 3 MB, so the loose direction is unreachable without a measurement.
    sendSurfaceMaxTotalBytes: null,
    push: LOCAL_PUSH,
    imapAdmission: LOCAL_IMAP_ADMISSION,
    // The add-time probe's SSRF gate is a no-op on a local install: a desktop user's own mail
    // server may sit on a LAN address or a non-standard port, and this process opens sockets only
    // on the user's own machine, so there is no cross-tenant network to protect. Named explicitly,
    // never a default — the hosted deployment wires the enforcing `makeProbeHostGuard` instead.
    probeHostGuard: ALLOW_ANY_PROBE_HOST,
    mailbox: makeMailboxService({ keyProvider, allowance: UNMETERED_MAILBOX_ALLOWANCE }),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    // The classifier reaches the SUGGEST half only; the read half is constructed without one and
    // could not call a model even through a cast. `credits` stays absent — this tier is free, so
    // there is no allowance to meter and an absent gate means unmetered rather than ungated.
    screener: makeScreenerService(classifier ? { classifier } : {}),
    // `drafting` is ALWAYS present and `drafter` only when there is a model, which is the pairing
    // the route expects rather than an oversight. The two are different things: `drafting`
    // assembles the sensitivity-safe context and stores the result, `drafter` is the model. The
    // route resolves the model as an ARGUMENT to the drafting call, so an absent drafter refuses
    // with `503 drafter_unconfigured` before any retrieval happens — while an absent DRAFTING
    // service would answer `500 not configured`, which says a host is broken about a host that is
    // merely free of a model.
    drafting: draftingService,
    ...(drafter ? { drafter } : {}),
    approval: makeApprovalService({}),
    triage: triageService,
    search: searchService,
    privacy: makePrivacyService({ remote: REFUSING_REMOTE_FETCH, resolver: REFUSING_RESOLVER }),
    contacts: contactsService,
    snippets: snippetsService,
    notify: notifyRulesService,
    away: awayResponderService,
    attachments: attachmentsService,
    kb: kbService,
    tags: tagsService,
    drafts: draftsService,
    workflows: workflowsService,
  };
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * A DRAIN'S WALL-CLOCK SHAPE, from the per-cycle durations it measured.
 *
 * This is the number that attributes desktop CPU and quit lag. A drain runs its inner cycles
 * back-to-back (only a `setTimeout(0)` yield between them), so a drain that TAKES longer than the
 * poll interval is, over the poll period, a high-duty loop — and quit closes the engine's stdin and
 * waits for the in-flight cycle to finish, so `slowestMs` is also the floor on how long an ordinary
 * quit blocks. Both symptoms trace to per-cycle cost, which is why it is measured here rather than
 * guessed. `slowestMs` is the max, not the sum, because it is the single cycle a quit waits on and
 * the sharpest read on the account-wide-modseq folder-diff (an iCloud mailbox re-scans every
 * watched folder whenever any of them changed). Pure so it can be tested without standing up IMAP.
 */
export function summarizeDrain(cycleMs: readonly number[]): { cycles: number; totalMs: number; slowestMs: number } {
  let totalMs = 0;
  let slowestMs = 0;
  for (const ms of cycleMs) {
    totalMs += ms;
    if (ms > slowestMs) slowestMs = ms;
  }
  return { cycles: cycleMs.length, totalMs, slowestMs };
}

export async function createSidecar(config: SidecarConfig): Promise<Sidecar> {
  const log = config.log ?? ((): void => undefined);
  const now = config.now ?? ((): Date => new Date());
  const address = config.address ?? config.imap.auth.user;

  // ── THE BOOT CLOCK ────────────────────────────────────────────────────────────────────────
  //
  // The shell shows "Opening your mailbox" for exactly as long as this function is awaited: both
  // doors serve the bridge only after the constructor returns (`main.ts`), so every second the
  // window spends on that screen is a second spent between here and the `boot_phases` line at the
  // bottom. It brackets the WHOLE function, which is what makes the phases below answerable —
  // whatever the four named phases do not account for is the remainder, and a remainder that
  // dominates is itself the finding.
  const tBoot = Date.now();
  const opened: OpenLocalDb = await openLocalDb(config.dataDir, {
    log,
    ...(config.onPhase ? { onPhase: config.onPhase } : {}),
  });
  // Everything after the store: identity, the key ring, the AI assembly, the route table. Named
  // so the narration a window renders never just stops at the last database phase.
  config.onPhase?.("preparing");
  try {
    const db = opened.db;
    const tWorld = Date.now();
    const world = await ensureLocalWorld(db, { address, ...(config.displayName ? { displayName: config.displayName } : {}), now: now() });
    const session = await mintLaunchSession(db, world, now());
    // The two identity writes, together: the mailbox row this install serves and the launch
    // session the shell will authenticate with. Measured as one phase because they are one
    // question — what it costs to establish who this launch is — and neither is separable from
    // the other in the failure this instrumentation exists to attribute.
    const worldMs = Date.now() - tWorld;
    if (session.revoked > 0) log("stale_sessions_revoked", { count: session.revoked });

    // rpID/origin are required by `makeAuthConfig` and validated at construction. Nothing local
    // performs a WebAuthn ceremony — there is no browser and no RP — but the config is built
    // through the real validator rather than hand-assembled, so a host that one day DOES enrol a
    // passkey cannot start from an unvalidated one.
    const authConfig = makeAuthConfig({ rpID: "localhost", origin: "http://localhost" });

    // ── THE KEY RING, OR AN HONEST REFUSAL ────────────────────────────────────────────────
    //
    // There is no third option here on purpose. The engine used to mint a key per launch and
    // carry on, which was defensible only while nothing encrypted was ever written down — and
    // that stopped being true the moment credential entry landed. A per-launch key and a stored
    // credential compose into silent data loss: the write succeeds and the next launch cannot
    // read it.
    const ring = config.keks ?? {};
    const versions = Object.keys(ring).map(Number).filter((v) => Number.isInteger(v) && v >= 1);
    const durableKey = versions.length > 0;
    const keyProvider: KeyProvider = durableKey ? new StaticKeyProvider(ring) : refusingKeyProvider();
    /**
     * What `/health` publishes about the key — a fingerprint and two integers, never key
     * material. Identical in shape and derivation to the hosted service's, so an operator
     * comparing a desktop install with a Cloud account is doing a literal JSON diff rather than
     * learning a second vocabulary. It is also the only way to SEE a rotation happen: `active`
     * moves to the new version and `fingerprint` changes with the ring.
     */
    const kekIdentity: KekEnvIdentity | null = durableKey
      ? { active: Math.max(...versions), count: versions.length, fingerprint: kekRingFingerprint(ring) }
      : null;

    if (!durableKey) {
      // ── THIS EVENT WAS CALLED `ephemeral_kek`, AND THE NAME WAS THE HAZARD ────────────────
      //
      // An event named after key material invites a field carrying it: the next person adding
      // detail to "the ephemeral KEK line" is one keystroke from `kek: buf`. The name states the
      // DECISION — a per-install key was absent — and the fields state the two facts an operator
      // can act on: WHICH variable was not set, and what that costs. `configVar` carries the NAME
      // of the variable and never its value, and the shared logger has a test pinning exactly
      // that distinction. Nothing here can reach a key: there is no key on this branch to reach.
      log("install_key_absent", {
        configVar: "OHMAIL_KEK",
        reason:
          "no per-install key was supplied by the host, so nothing can be stored encrypted on " +
          "this machine. The mailbox password is not written down and must be supplied on every " +
          "launch; storing one is refused rather than performed under a key that dies with this " +
          "process.",
      });
    }

    /**
     * THIS INSTALL'S OWN AI — a key its owner holds, a model on this machine, or nothing.
     *
     * Assembled before the app because the route table it contributes is part of the app, and
     * because reading the stored settings once here is what lets every accessor downstream be
     * synchronous: the request path decides whether a drafter EXISTS while it builds its
     * dependency bag, rather than discovering it inside a handler.
     *
     * `canStoreKey` is the same fact `keyProvider` already encodes — a refusing provider means
     * this install has no durable key — but stated as a value rather than inferred from a throw,
     * so the settings surface can say so BEFORE offering a field it would have to refuse.
     */
    const ai = await createLocalAi({
      dataDir: config.dataDir,
      keyProvider,
      canStoreKey: durableKey,
      log,
      now,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    const app = createApp([...localRoutes, ...localAiRoutes(ai)]);

    /**
     * A FRESH `ApiDeps` PER REQUEST. `ApiDeps` is mutable by design — `withRequestId` writes
     * `requestId`, `withSession` writes `session`, `withIdempotency` writes `idempotency` — so a
     * shared object would leak one request's identity into the next. It is the same shape the
     * client engine's contract tests build when they drive `app.handle` directly.
     */
    const depsFor = (): ApiDeps => ({
      db,
      now,
      requestId: "",
      session: null,
      authConfig,
      keyProvider,
      // Rebuilt per request so the AI slots reflect what this install can do NOW — see
      // `localServices`. `openLocalSend` (below) is the send transport, resolving the sealed
      // credential fresh per send.
      services: localServices(authConfig, keyProvider, openLocalSend, ai),
      // BEARER ONLY. There is no browser here, so there is no ambient cookie to abuse — and with
      // `via` structurally unable to be "cookie", `withCsrf` becomes a no-op by construction
      // rather than by a check. Same posture as `api.ohmail.app`.
      allowCookieAuth: false,
      // SSE OFF, and this one is load-bearing for the transport rather than a preference: a frame
      // carries a COMPLETE response, and `GET /events` never completes. Disabled, it answers a
      // finite 503 that `HttpAdapter` already tolerates (it treats SSE as an optional wake signal
      // and polls `/sync` regardless). See the note in `protocol.ts`.
      sse: { ...DEFAULT_SSE, enabled: false },
      /**
       * `/health` PUBLISHES THE KEY'S IDENTITY, in the hosted service's own shape.
       *
       * `{ active, count, fingerprint }` — a digest and two integers, never key material. It is
       * what makes a rotation observable from outside the process: after the shell installs a new
       * version, `active` moves and `fingerprint` changes, and an install still running on the old
       * ring says so without anybody having to read a key to find out.
       *
       * `kekError` is deliberately never set. On the hosted side it makes `/health` answer 503,
       * which is right for a server that cannot decrypt anybody's credentials; here the same
       * condition means "this user has not typed their password yet", and a mail app that reports
       * itself dead because it is waiting for a password would be lying about the mirror it is
       * quite happily still serving.
       */
      // `schemaTier: "mail"` because this install migrated the mail journal and nothing else
      // (`db.ts`). Without it `/health` probes for the hosted billing ledger and answers 503
      // `schema_incomplete` for ever — about a database that is complete for what it is.
      health: { version: API_VERSION, kek: kekIdentity, schemaTier: "mail" },
    });

    /* ══════════════════════════════════════════════════════════════════════════════════════
       THE STORED LOGIN — what makes a restart survivable
       ══════════════════════════════════════════════════════════════════════════════════════

       The division of labour across the host boundary, stated once:

         · the SHELL holds one per-install key in the OS keystore, and passes it at spawn;
         · the DATABASE holds the mailbox password, envelope-encrypted under that key;
         · the environment carries the password EXACTLY ONCE, on the launch the user types it.

       Before this, the password travelled in the environment on every launch — same-uid readable
       process state for as long as the engine ran — and the alternative of keeping it in the
       keystore directly was rejected: one key per install scales to any number of mailboxes,
       whereas one keystore item per mailbox is a second credential-at-rest design competing with
       the envelope the hosted service already uses.

       ── WHAT THE KEY DOES AND DOES NOT PROTECT ─────────────────────────────────────────────

       It wraps `mailbox_credentials` and nothing else. The local mirror is an ordinary
       unencrypted database, so losing the key costs the stored password and NOT the mail — and
       the mail was never the thing at risk anyway, because the mailbox on the user's own server
       is the master and the mirror is reconstructible from it. That is why a lost key is a
       prompt and not a catastrophe: the honest recovery is to ask for the password again, and if
       the user would rather start clean, deleting the data directory re-syncs everything from
       IMAP. Neither path touches a single message on the server.

       ── AND WHY DELETING IS A CLEAN UNINSTALL ──────────────────────────────────────────────

       Two things exist on this machine: the data directory and one keystore item. Removing both
       removes the install completely, and the mailbox keeps its folders, its filing and every
       message, because the organization was never stored here — it is where the messages
       physically sit on the user's own server. */

    /** The `(mailbox, imap)` credential row, or null when the user has not supplied one yet. */
    const storedLogin = async (): Promise<{ secretEnc: string; keyVersion: number; meta: unknown } | null> => {
      const rows = await db
        .select({ secretEnc: mailboxCredentials.secretEnc, keyVersion: mailboxCredentials.keyVersion, meta: mailboxCredentials.meta })
        .from(mailboxCredentials)
        .where(and(
          eq(mailboxCredentials.mailboxId, world.mailboxId),
          eq(mailboxCredentials.transport, "imap"),
        ))
        .limit(1);
      return rows[0] ?? null;
    };

    /**
     * Remove the `(mailbox, imap)` credential row. See {@link Sidecar.forgetStoredLogin}.
     *
     * ONE ROW, AND NOTHING ELSE. Not the mailbox, not the messages, not the mirror — every one of
     * those is reconstructible from the user's own server and none of them is a secret. The
     * credential is the only thing on this machine that a person signing out is asking to be gone.
     */
    const forgetStoredLogin = async (): Promise<boolean> => {
      const had = (await storedLogin()) !== null;
      await db.delete(mailboxCredentials).where(and(
        eq(mailboxCredentials.mailboxId, world.mailboxId),
        eq(mailboxCredentials.transport, "imap"),
      ));
      log("stored_login_cleared", {
        mailboxId: world.mailboxId,
        state: had ? "removed" : "absent",
        reason: "the sealed mailbox password was removed from this install; the mirror and the " +
          "mailbox on the user's own server are untouched",
      });
      return had;
    };

    /**
     * The password this launch will use, and what the shell should be told.
     *
     * Order is deliberate: the STORE WINS over the environment, matching the rule the hosted
     * worker already follows for the same table — an environment variable seeds a credential
     * once and never overwrites a stored one. Without that precedence a stale variable left in a
     * launch script would silently outrank the password the user actually typed.
     */
    const resolveLogin = async (): Promise<{ state: CredentialState; pass: string | null }> => {
      const envPass = config.imap.auth.pass;
      const row = await storedLogin();
      if (!row) return envPass ? { state: "ready", pass: envPass } : { state: "absent", pass: null };
      try {
        const secret = await keyProvider.decrypt(row.secretEnc, row.keyVersion);
        // Route the stored row through the SHARED builder, with NO token source. A password row
        // (the only kind a desktop install writes) returns `{ user, pass }` and this validates it;
        // an oauth2 row THROWS here — the desktop has no token source in this phase — and is handled
        // below as "unreadable" rather than being decrypted and dialled with a refresh token as a
        // password. One interpreter of `authType`, on the desktop too.
        buildImapAuth((row.meta ?? {}) as CredMetaAuth, secret);
        return { state: "ready", pass: secret };
      } catch {
        // The thrown value is deliberately not logged and not inspected. It comes from AES-GCM
        // via a provider that also carries key material, and the only fact this code needs is
        // the one the branch already establishes: this key does not open that row.
        return { state: "unreadable", pass: envPass ?? null };
      }
    };

    /**
     * THE LOCAL SEND ADAPTER — the desktop counterpart to the hosted `makeSendAdapter`.
     *
     * `POST /drafts/:id/send` resolves this (via `deps.services.sendAdapter`) to open one
     * SMTP+IMAP connection for one send, and `SendService` closes it in its `finally`. It is a
     * FRESH connection per send, exactly as the hosted adapter is, so a send never contends with
     * the sync drain for the one long-lived IMAP login.
     *
     * ── ONE CREDENTIAL PER MAILBOX, AND THE SPLIT THAT ENFORCES IT ─────────────────────────────
     *
     * The SMTP transport COORDINATES — host, port, implicit-TLS — come from `config.imap.smtp`,
     * which is the `OHMAIL_SMTP_*` the shell set (`main.ts`). The AUTH does NOT: it is the SAME
     * single credential the IMAP side resolves, through the SAME `resolveLogin()` — store-wins-
     * over-environment, decrypted under this install's key. So the password the transporter
     * authenticates with is byte-for-byte the one the mailbox is synced with, and in steady state
     * (no password in the environment) its only source is the sealed store. There is deliberately
     * no second sealed SMTP secret: a mailbox has one password, and a second credential-at-rest
     * would be a second thing to seal, rotate and lose.
     *
     * This is why the hosted `makeSendAdapter` cannot simply be reused here: it reads the SMTP
     * host/port from a stored `smtp` credential row (or falls back to the IMAP host on 587), and a
     * local install has neither — its SMTP server is an environment fact, not a stored one.
     */
    const openLocalSend: OpenSendAdapter = async (): Promise<SendAdapter> => {
      const smtp = config.imap.smtp;
      if (!smtp) {
        throw new ServiceError(
          "upstream_unavailable", 502,
          "this mailbox has no SMTP server configured, so mail cannot be sent from this install",
        );
      }
      // The sealed credential, resolved the way the IMAP side resolves it. A launch that has no
      // password anywhere serves its mirror and refuses to send, rather than dialling SMTP with an
      // empty secret — the same posture `start()` takes toward IMAP.
      const { state, pass } = await resolveLogin();
      if (state !== "ready" || !pass) {
        throw new ServiceError(
          "upstream_unavailable", 502,
          "the mailbox password is not available on this install, so mail cannot be sent; " +
            "re-enter it to reconnect",
        );
      }
      const user = config.imap.auth.user;
      const sendConfig: ImapConfig = {
        ...config.imap,
        auth: { user, pass },
        smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user, pass } },
      };
      // The one test seam this file already has. On the SEND path the factory is only ever a real
      // `ImapAdapter` (or a wrapper of one), which is a full `SendAdapter` — the stub factories the
      // other sidecar tests pass never reach send, so the widening cast is sound where it is used.
      const built = config.adapterFactory ? config.adapterFactory(sendConfig) : new ImapAdapter(sendConfig);
      const adapter = built as unknown as SendAdapter & { connect(): Promise<void> };
      // Close-then-rethrow around the login window, the shape used everywhere this codebase holds
      // an IMAP login across work that can fail (`send-adapter.ts`, `attachments-adapter.ts`, the
      // sync worker): `connect()` logs in and LISTs, so a failure after login would otherwise leak
      // an authenticated socket the caller has no handle to close — worst of all on the send path,
      // where the retry that follows is a retry of a send.
      try {
        await adapter.connect();
      } catch (err) {
        await adapter.close().catch(() => { /* the connection is already broken */ });
        throw err;
      }
      return {
        send: async (msg) => ({ providerMessageId: (await adapter.send(msg)).providerMessageId }),
        messageInSent: (messageId) => adapter.messageInSent(messageId),
        close: () => adapter.close(),
      };
    };

    /**
     * FIRST RUN: seal the password the user just typed, so no later launch needs it.
     *
     * Skipped without a durable key — the whole point of the refusal above — and skipped when a
     * row already exists, which is what keeps this idempotent across every relaunch. It is NOT
     * the recovery path: a row that exists and cannot be read is left exactly as it is, and
     * re-entry through `PATCH /mailboxes/:id` is what replaces it. Overwriting here would mean a
     * launch script with a stale password could silently reseal a credential the user had
     * already corrected.
     */
    const envPass = config.imap.auth.pass;
    if (durableKey && envPass && !(await storedLogin())) {
      const sealed = await keyProvider.encrypt(envPass);
      await db.insert(mailboxCredentials).values({
        mailboxId: world.mailboxId,
        transport: "imap",
        secretEnc: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        // The same non-secret shape the hosted worker writes, so one row shape serves both.
        meta: {
          host: config.imap.host, port: config.imap.port,
          secure: config.imap.secure, user: config.imap.auth.user,
        },
        updatedAt: now(),
      });
      log("stored_login_sealed", {
        mailboxId: world.mailboxId,
        reason: "the mailbox password was encrypted into the local store under this install's " +
          "key; later launches read it back and need no password in the environment",
      });
    }

    // TWO LITERAL CALL SITES AND NOT ONE COMPUTED NAME. A guard over this package walks every
    // `log(...)` call and refuses an event name it cannot read statically, which is not pedantry:
    // a call site whose event is an expression is a call site whose FIELDS cannot be checked
    // either, and unchecked fields are how a secret reaches a log line. The guard caught this one
    // as a ternary while it was being written.
    const login = await resolveLogin();
    if (login.state === "absent") {
      log("stored_login_absent", {
        mailboxId: world.mailboxId,
        state: login.state,
        reason: "no password is stored and none was supplied, so this install serves the mirror " +
          "it already has and waits for one",
      });
    } else if (login.state === "unreadable") {
      log("stored_login_unavailable", {
        mailboxId: world.mailboxId,
        state: login.state,
        reason: "a stored password exists and this install's key does not open it; the mirror is " +
          "intact and re-entering the password re-seals it. The mailbox on the server is " +
          "untouched, and deleting the data directory re-syncs it from scratch",
      });
    }

    const repo = makeDrizzleRepo(db);
    /**
     * The adapter is built with whatever password this launch resolved, and `start()` refuses to
     * connect when there is none. A password entered AFTER the process is up therefore takes
     * effect on the next launch rather than this one — which is the shell's flow anyway (it
     * spawns the engine once the user has finished the setup sheet) and is much cheaper than
     * making a live IMAP connection's credentials mutable underneath the sync loop.
     */
    const imapConfig: ImapConfig = { ...config.imap, auth: { user: config.imap.auth.user, pass: login.pass ?? "" } };
    const adapter = config.adapterFactory ? config.adapterFactory(imapConfig) : new ImapAdapter(imapConfig);
    const syncDeps = {
      repo, adapter, accountId: world.accountId, mailboxId: world.mailboxId,
      // The same consent rule as the hosted worker: whose `Authentication-Results` this
      // mailbox may believe is a fact about the host THIS config dials — Gmail/Microsoft
      // resolve to their signing authserv-id, everything else to the empty set (demote nothing).
      trustedAuthservIds: providerAuthservIds(config.imap.host),
    };

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** One serial queue: a poll tick must never start a cycle while one is running, and `stop()`
     *  must be able to wait for whatever is in flight before closing IMAP and the database. */
    let tail: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    };

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE ORGANIZER LEASE — the LOCAL half
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // A LOCAL install cannot query the hosted database and Cloud cannot query this PGlite file,
    // so the mailbox is the only medium the two share and the claim lives in it. Everything about
    // the decision — the format, the priority table, the IO — is `packages/core`'s, and the
    // composition is `@trafficflow/worker/lease`'s. This file supplies exactly two things Cloud
    // cannot: WHO this install is, and what standing down means on a laptop.
    //
    // ── THE INSTALL ID IS THE LOCAL ACCOUNT ROW, AND THAT IS NOT A SHORTCUT ────────────────
    //
    // An install resuming its OWN role is not a takeover, and that distinction IS an install-id
    // match, so the id has to survive a crash, a reboot and a long sleep, and it has to differ
    // between two installs on two machines. `ensureLocalWorld` creates exactly one `accounts` row
    // per data directory and finds it on every later launch — that is precisely the lifetime
    // required, it is already persisted, and it is a random uuid rather than anything about the
    // user. A hostname would collide across two machines called `MacBook-Pro`; a per-launch value
    // would make every restart look like a second install arriving and hand the mailbox back and
    // forth.
    //
    // It is written into a message in the user's OWN mailbox, which is the only place it goes.
    const installId = world.accountId;
    const machineName = config.machineName ?? hostname();
    /** In memory only — the clone defence, and forgetting it on restart is what makes own-role
     *  resumption work. See `LeaseSelf` in the engine. */
    let leaseNonce: string | null = null;
    /**
     * A STAND-DOWN RECORDED ON THE ROW OUTLIVES THE PROCESS, and that is what makes a lapsed
     * Cloud subscription leave the desktop stood down rather than auto-resuming.
     *
     * The lease alone cannot: once Cloud releases its claim, `ohmail/_meta` is empty, and an empty
     * folder correctly reads as "nobody has ever organized this mailbox" — the arm that organizes.
     * Relaunching the app would then silently make this machine the thing that moves somebody's
     * mail: a forgotten install on an office machine, woken by a billing event, filing against a
     * rules store frozen at the moment it stood down. Restarting an app is not an explicit human
     * action about who organizes a mailbox.
     *
     * So a stood-down row means this install organizes nothing, and the gate is not even
     * consulted — there is nothing for it to decide. Only clearing the row does, which is the
     * "Organize from this Mac…" action.
     */
    const priorStandDown = world.standDownReason;
    let organizer: OrganizerState = priorStandDown
      ? { organizing: false, reason: priorStandDown as MailboxDisabledReason, heldBy: null }
      : { organizing: true, reason: null, heldBy: null };
    /**
     * THE EXIT FROM A STAND-DOWN — a human asked for this machine, once.
     *
     * Written by the "organize from this machine" command (`organize-here.ts`), which also clears
     * the row's stand-down so that the branch above lets the gate run at all. Both halves are
     * needed and neither is sufficient: clearing the row alone gets as far as consulting the
     * lease, and the lease then refuses a mailbox whose previous organizer left a claim behind
     * without releasing it — the crashed-machine case, which is precisely when somebody sits down
     * at another machine and asks for it. That refusal is correct in general; this stamp is the
     * fact that makes THIS case different, and it is why the action is not "clear a flag".
     *
     * It is spent the moment it succeeds, so it authorizes one becoming rather than a standing
     * right to seize this mailbox back from wherever it may go next.
     */
    let takeoverAuthorized = world.takeoverAuthorizedAt !== null;

    /**
     * Read the lease. Returns false when this install must not organize, and makes that durable.
     *
     * The loser stands down on its next cycle and STOPS SYNCING ENTIRELY — it does not keep
     * passively mirroring, because a read-only IMAP loop is half the dual-organizer bug surface:
     * it still observes folders, still feeds `adopt_external`, still burns a connection. So the
     * poll timer stops and the login closes. The APP does not: offline is a property of both
     * modes, and a frozen mirror served over the bridge is the correct product here — the local
     * database is kept, never auto-deleted, and the UI offers removal.
     *
     * The stand-down is STICKY in the local row (`status='disabled'` + the reason), and that is
     * what actually keeps a stood-down desktop from auto-resuming when Cloud lapses. The lease
     * alone could not: once Cloud releases its claim the folder is empty, and an empty folder
     * reads as "nobody has ever organized this mailbox", which organizes. The row is the memory
     * the mailbox cannot hold, and only an explicit human action clears it.
     */
    const mayOrganize = async (): Promise<boolean> => {
      // The row's memory outranks the folder. See `priorStandDown` above: this is the arm that
      // makes "the desktop does not auto-resume" survive a relaunch, and it deliberately does not
      // even read the lease — there is nothing for the gate to decide about a mailbox this install
      // has been told to stop organizing.
      if (priorStandDown) return false;
      const outcome = await readMailboxLease({
        adapter,
        self: { installId, kind: "local", displayName: machineName, lastNonce: leaseNonce },
        now: now(),
        // An explicit human choice, and the ONLY thing that distinguishes "this mailbox's last
        // organizer went quiet" from "the user wants this machine to have it". Without it the
        // lease reports such a mailbox as available and declines to take it, which is the right
        // default and the wrong answer once somebody has actually asked.
        takeover: takeoverAuthorized ? "authorized" : "none",
        ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
        log,
      });
      if (outcome.organize) {
        leaseNonce = outcome.nonce;
        organizer = { organizing: true, reason: null, heldBy: null };
        if (takeoverAuthorized) {
          // SPEND IT. One becoming, not a standing right: leaving the stamp set would let this
          // install seize the mailbox back on some later launch, after a human had deliberately
          // moved it elsewhere. Written only when there is something to clear, so an install that
          // simply keeps organizing writes nothing here on any cycle.
          try {
            await db.update(mailboxes)
              .set({ takeoverAuthorizedAt: null })
              .where(eq(mailboxes.id, world.mailboxId));
            takeoverAuthorized = false;
          } catch (err) {
            // The gate already said organize and the claim is already written. Failing to spend
            // the stamp costs one more cycle in which it is still spendable, never correctness.
            log("organizer_takeover_clear_failed", {
              err,
              reason: "this install is organizing the mailbox; the one-shot authorization could " +
                "not be cleared and will be retried on the next cycle",
            });
          }
        }
        return true;
      }

      organizer = {
        organizing: false,
        reason: outcome.reason,
        heldBy: outcome.by?.displayName ?? null,
      };
      // Standing down voids any unspent authorization, in memory and on the row below. We are not
      // the organizer, so becoming one again is a new becoming and needs a new explicit request.
      takeoverAuthorized = false;
      log("organizer_stand_down", {
        disabledReason: outcome.reason,
        heldBy: organizer.heldBy,
        reason: "another organizer holds this mailbox; this install stops syncing entirely and " +
          "keeps serving the mirror it already has",
      });
      try {
        await db.update(mailboxes)
          .set({ status: "disabled", disabledReason: outcome.reason, takeoverAuthorizedAt: null })
          .where(eq(mailboxes.id, world.mailboxId));
      } catch (err) {
        log("organizer_stand_down_write_failed", {
          err,
          reason: "this install has stopped organizing regardless; the row could not record why",
        });
      }
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await adapter.close();
      } catch (err) {
        log("adapter_close_failed", { err });
      }
      return false;
    };

    /**
     * HOW THIS MAILBOX WANTS ITS OHBOX KEPT — read fresh, once per drain.
     *
     * Two columns on `account_settings`, and both of them are inputs to filing rather than to the
     * settings screen that writes them:
     *
     *  · the POSTURE decides whether obvious bulk from a sender this mailbox has admitted is
     *    demoted out of the Ohbox. It is a RULES-path input — `EvaluateRulesInput.ohboxPolicy` is
     *    required precisely so that no caller can sit silently on the wrong side of that
     *    decision — so it is resolved on every drain whether or not a model exists. An install
     *    with no model at all still files by this posture.
     *  · the BAR is the mailbox owner's own sentence about what deserves the Ohbox. It reaches the user
     *    turn of the classifier's question and nothing else; absent, it is omitted from the
     *    payload rather than sent empty.
     *
     * ── READ EVERY DRAIN, WITH NO CACHE, AND THAT IS A DIFFERENCE FROM THE HOSTED WORKER ─────
     *
     * The worker holds these behind a short TTL because one process serves many accounts and each
     * read is a round trip to a network database. Neither is true here: one account, one mailbox,
     * and a database file in this process. What the cache would buy is nothing, and what it would
     * cost is real — a hit path no test here would ever exercise, and up to half a minute between
     * somebody editing their words in Settings and the next message being judged by them. The
     * editor is in the same window as this loop; the words should be in force on the next poll.
     *
     * ── A FAILED READ FILES LENIENTLY, AND DROPS THE BAR ─────────────────────────────────────
     *
     * `people_only` is the strict posture, and defaulting to it because a read blipped would
     * demote a real person's mail. The bar is omitted on the same fault rather than carried over
     * from a previous drain: a stale sentence in the user turn is a model judging this mailbox by
     * criteria the database no longer holds, and "no criteria" is the honest input for a drain
     * that could not read them. The event name is the hosted worker's, so one search covers both.
     */
    const screeningNow = async (): Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar">> => {
      try {
        const [row] = await db.select({
          policy: accountSettings.ohboxPolicy, bar: accountSettings.ohboxBar,
        }).from(accountSettings).where(eq(accountSettings.accountId, world.accountId)).limit(1);
        return {
          ohboxPolicy: resolveOhboxPolicy(row?.policy ?? null),
          ...(row?.bar ? { ohboxBar: row.bar } : {}),
        };
      } catch (err) {
        log("screening_pref_read_failed", {
          err,
          reason: "this mailbox's Ohbox posture could not be read, so this pass files on the " +
            "lenient default and sends no bar to a model; the next pass reads again",
        });
        return { ohboxPolicy: DEFAULT_OHBOX_POLICY };
      }
    };

    /**
     * SCHEDULED RESURFACING — the local half of a feature that was hosted-only by accident.
     *
     * A message the user put away until Friday at nine carries `state='bubbled_up'` and a
     * `bubbleUpAt`, and something has to notice when that moment arrives and flip it to
     * `resurfaced`. On a Cloud account the hosted worker's cycle does it. A STANDALONE install
     * has no worker anywhere — that is the whole shape of the free tier — so until this call
     * existed the row simply sat there, and the shortcut that says "Resurfaces {when}" with a
     * real date on it was making a promise this door could never keep.
     *
     * ── WHICH DOOR RUNS IT, AND WHY THE CLOUD DOOR DOES NOT ────────────────────────────────
     *
     * The flip belongs where the AUTHORITATIVE store is, and there is exactly one of those per
     * install. Here it is this PGlite file. On the Cloud door (`cloud-engine.ts`) it is the
     * hosted database: the worker flips the row there, `recordChange` puts a `message_state`
     * update on the feed, and `cloud-mirror.ts`'s intake upserts `state` and `bubbleUpAt`
     * straight out of the DTO — so that mirror LEARNS the resurface as an ordinary delta. Adding
     * this call there would make the desktop a second writer to a store it only reads, flipping
     * a row the next pull would overwrite anyway. So it lives on this side and only this side.
     *
     * ── AND IT IS BEHIND THE ORGANIZER GATE, WHICH IS THE SAME SENTENCE ────────────────────
     *
     * It is called from inside {@link drain}, so it runs only when this install may organize the
     * mailbox. That is not incidental placement: a stood-down install's local database is a
     * frozen mirror of a mailbox somebody else now organizes, and the resurface the user actually
     * scheduled lives in THAT organizer's store. Flipping rows in the frozen copy would surface
     * items in a database nothing maintains, and would do it in parallel with the real owner.
     *
     * ── COST ───────────────────────────────────────────────────────────────────────────────
     *
     * One indexed SELECT (`message_states_account_state_idx`) plus one UPDATE per DUE row, once
     * per drain — so it rides the existing poll cadence rather than adding a timer, and a mailbox
     * with nothing scheduled pays one probe that returns no rows. Deliberately NOT inside the
     * cycle loop: a backlog drain runs up to a hundred cycles, and the answer cannot change
     * between two of them in any way a user could perceive.
     *
     * A failure is CONTAINED. Resurfacing is one feature; the drain below is the mail arriving.
     * A store error here must not stop the second, so it is logged and the drain continues — the
     * next poll asks again, and the row stays due until it flips.
     */
    const resurfaceDue = async (): Promise<void> => {
      try {
        const { flipped, rescued } = await bubbleUpPass(
          db as unknown as Tx, now(), { accountId: world.accountId },
        );
        // Only when something moved: a settled mailbox emits this line never, which is the same
        // rule the drain summary below follows.
        if (flipped > 0 || rescued > 0) log("resurface_flipped", { flipped, rescued });
      } catch (err) {
        log("resurface_pass_failed", {
          err,
          reason: "scheduled resurfaces could not be flipped this pass; the rows stay due and " +
            "the next poll tries again, and mail continues to be filed either way",
        });
      }
    };

    /** The drain itself, ALREADY GATED. Never called from outside this closure. */
    const drain = async (maxCycles: number): Promise<number> => {
      // BEFORE the cycles, not after: a resurface is a local database fact and does not depend on
      // the mailbox being reachable, so it must survive a cycle that throws on a dead connection.
      await resurfaceDue();
      let cycles = 0;
      /** Did a cycle report an empty backlog, or did the loop simply run out of cycles? */
      let drained = false;
      // ── ONCE PER DRAIN, BESIDE THE LEASE AND FOR THE SAME REASON ───────────────────────────
      //
      // A drain is one logical pass over a backlog the adapter hands over in bounded batches, and
      // the posture it is filed under must be one posture: re-reading between two batches would
      // let a mailbox change its mind halfway through its own backlog. It is NOT hoisted into
      // `syncDeps` above, which is built once per process — that would freeze the posture for the
      // life of the engine, so an edit in Settings would need a relaunch to take effect.
      const screening = await screeningNow();
      // Per-cycle wall durations, summarized into one `sync_drain` line below — the read that
      // attributes desktop CPU and quit lag to the pipeline. `Date.now()` deliberately, not the
      // injected `now()`: a test may freeze that clock, and a frozen clock would report every
      // cycle as 0 ms.
      const cycleMs: number[] = [];
      while (!stopped && cycles < maxCycles) {
        const cycleStart = Date.now();
        // ── THE MODEL IS RESOLVED ONCE PER CYCLE AND NEVER HELD ───────────────────────────
        //
        // `classifierForCycle()` answers `undefined` when this install has no verified model AND
        // when repeated faults have made it stop asking — a revoked key, a sleeping laptop, a
        // model server somebody quit. `planChange`'s `classifier &&` then short-circuits and the
        // mail files on rules, which is the product's floor and the difference between "a
        // suggestion is missing" and "mail stopped arriving".
        //
        // Holding the port across that transition would defeat the whole arrangement: the loop
        // would keep calling a model that is not answering, and the pipeline rethrows a
        // classifier fault by design — so the cursor would never advance and the mailbox would
        // stall behind the first message the rules could not settle.
        const { hasBacklog } = await runSyncCycle({
          ...syncDeps, ...screening, classifier: ai.classifierForCycle(),
        });
        cycleMs.push(Date.now() - cycleStart);
        cycles++;
        if (!hasBacklog) { drained = true; break; }
        // Yield, so a backlog drain cannot starve the request handler sharing this event loop.
        await new Promise((r) => setTimeout(r, 0));
      }
      // One line per drain — a settled mailbox emits it every poll interval, so it stays quiet;
      // a slow or spinning drain is the line that shows it. `slowestMs` above the poll interval is
      // the signal to chase (a cycle longer than the interval is a high-duty period and a quit that
      // waits on it). Literal field keys, not a spread of the summary object: the log census refuses
      // a call site whose field set it cannot read statically. See `summarizeDrain`.
      if (cycles > 0) {
        const shape = summarizeDrain(cycleMs);
        log("sync_drain", { cycles: shape.cycles, totalMs: shape.totalMs, slowestMs: shape.slowestMs, drained });
      }
      /* HOW FAR THIS MAILBOX HAS GOT, WRITTEN DOWN. On a hosted account these two columns are the
         worker's; here this process IS the worker, and the window's sync line reads them to tell a
         first import apart from a settled mailbox. `drained` is the distinction that matters for
         the second stamp: a drain that ran out of CYCLES has not finished the import, and saying it
         had would tell somebody their mailbox was complete with half of it still on its way. See
         `sync-stamp.ts`. */
      if (cycles > 0) await stampSynced(db, world.mailboxId, now(), drained);
      /* ── CHECKPOINT BEHIND EVERY DRAIN THAT WROTE, so the log never holds more than one drain. ──

         The periodic checkpointer (`db.ts`) bounds the write-ahead log to five MINUTES of churn,
         and five minutes of a first import is gigabytes — a drain is up to a hundred cycles of up
         to 32 MB each. The exposure is the quit that lands in that window: the shell kills an
         engine that has not left within its grace period, a kill skips the shutdown checkpoint,
         and the NEXT launch replays everything since the last one — measured at ~160 MB/s, so a
         couple of gigabytes is ten-plus seconds of "Opening your mailbox" that this line makes
         a checkpoint instead, at ~80 ms per hundred megabytes, off any request's path.

         AWAITED, deliberately: the next drain cannot start until this one's log is folded in, and
         `checkpoint()` never throws (see `checkpointWal`). A drain of zero cycles wrote nothing
         and skips it, so a settled mailbox costs nothing every poll. */
      if (cycles > 0) await opened.checkpoint();
      return cycles;
    };

    const syncUntilQuiet = async (maxCycles = 100): Promise<number> =>
      serialize(async () => {
        // ── THE GATE, IMMEDIATELY BEFORE `runSyncCycle` ────────────────────────────────────
        //
        // Once per DRAIN and not once per inner cycle: the loop is one logical pass over a
        // backlog the adapter hands over in bounded batches, and re-reading the lease between
        // two batches of the same drain would be an APPEND and an EXPUNGE per batch against the
        // user's own mailbox for a claim nothing could have changed. The poll timer re-enters
        // here, so the re-verification interval is a poll interval.
        //
        // It is on the PUBLIC entry point rather than only in `start()`, because `Sidecar`
        // exposes this method: a gate the caller can skip by calling the other function is not a
        // gate.
        //
        // `stopped` FIRST, and this is a defect the sidecar test found rather than a precaution:
        // a stand-down closes the IMAP login, so a later `syncUntilQuiet()` would read the lease
        // over a dead connection and throw `LeaseUnavailableError` out of a public method whose
        // honest answer is "this install organizes nothing". `stop()` reaches the same state.
        if (stopped) return 0;
        if (!(await mayOrganize())) return 0;
        return drain(maxCycles);
      });

    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        void syncUntilQuiet()
          .catch((err: unknown) => {
            // A failed cycle is a bad network or a sleeping laptop, not a reason to stop being a
            // mail app. Offline is a property of this mode: the organizer pauses and the viewer
            // stays complete — the API keeps serving the mirror over the bridge either way.
            log("sync_cycle_failed", { err });
          })
          .finally(schedule);
      }, config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      timer.unref?.();
    };

    // ── WHERE THE "OPENING YOUR MAILBOX" SECONDS WENT ─────────────────────────────────────
    //
    // Measurement only: nothing above this line behaves differently for its sake. The four named
    // phases are the awaited work this constructor is made of, and `totalReadyMs` brackets all of
    // it, so `totalReadyMs` minus the four is the unnamed remainder — the AI assembly, the key
    // ring, the credential resolution and the route table. Naming the phases rather than folding
    // them into one duration is the whole point: `mailbox_attached` in the worker exists because a
    // single start-to-finish number could not say which phase dominated.
    //
    // Emitted at constructor exit rather than per phase, deliberately. A phase line written as
    // each phase completes would report progress on a launch that never finishes, but it would
    // also put four more lines on every ordinary launch, and the question this answers — which
    // phase owns the wait — is only answerable once all of them have a number.
    log("boot_phases", {
      pgliteOpenMs: opened.timings.pgliteOpenMs,
      adoptBaselineMs: opened.timings.adoptBaselineMs,
      migrateMs: opened.timings.migrateMs,
      worldMs,
      totalReadyMs: Date.now() - tBoot,
    });

    return {
      app,
      db,
      repo,
      adapter,
      world,
      sessionToken: session.token,
      handle: async (req) => {
        // ── ONE ROUTE AHEAD OF THE TABLE, AND WHY IT IS NOT IN THE TABLE ────────────────────
        //
        // `DELETE /local/stored-login` is a DESKTOP-ONLY action: forget the password sealed on
        // THIS machine. `packages/api`'s route table is shared with the hosted service, where the
        // idea has no meaning — there is no per-install key and no local store to forget from — so
        // adding it there would be hosted surface invented for a desktop lifecycle.
        //
        // It carries the same gate every other request on this transport carries: the per-launch
        // bearer, resolved by the same `resolveSession` the middleware chain runs. The bearer is
        // added shell-side and never reaches the window, so a page cannot compose this call itself.
        const url = new URL(req.url);
        if (req.method === "DELETE" && url.pathname === "/local/stored-login") {
          const header = req.headers.get("authorization");
          const token = header && /^Bearer\s+/i.test(header)
            ? header.replace(/^Bearer\s+/i, "").trim()
            : "";
          const core = token ? await resolveSession(db, token, now()) : null;
          if (!core) {
            return new Response(
              JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }),
              { status: 401, headers: { "content-type": "application/json" } },
            );
          }
          const cleared = await forgetStoredLogin();
          return new Response(JSON.stringify({ cleared }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return app.handle(req, depsFor());
      },
      syncUntilQuiet,
      organizerState: () => organizer,
      credentialState: async () => (await resolveLogin()).state,
      forgetStoredLogin,
      async start() {
        // ── NO PASSWORD, NO CONNECTION — AND THAT IS NOT A FAILED LAUNCH ──────────────────
        //
        // Offline is a property of this mode: the organizer is paused and the viewer is
        // complete, so the bridge keeps serving the mirror and the shell shows a password
        // field. Throwing here instead would make a missing password look like a broken app,
        // and a mailbox whose key was replaced would be unrecoverable rather than one prompt
        // away. Deliberately BEFORE `connect()`: an empty password is a login attempt the
        // server will refuse, and a refused login on some providers counts toward a lockout.
        if (login.state !== "ready" || !login.pass) return;
        await adapter.connect();
        // ── EVERYTHING BELOW RUNS ON AN AUTHENTICATED SOCKET, SO IT IS WRAPPED ──────────────
        //
        // `connect()` LOGS IN and then LISTs, and `apps/sidecar/src/main.ts` answers a rejected
        // `start()` by LOGGING it and continuing to serve the mirror — deliberately, because a
        // first sync of a real mailbox takes minutes and a UI that waits for it looks broken. The
        // two compose into a leak: before this `catch`, a throw from the lease gate, from
        // `ensureFolders` or from the first drain left an authenticated login open with no handle
        // anywhere that could close it, for the life of the process.
        //
        // iCloud caps concurrent connections per account, and a laptop shares that budget with
        // Apple Mail and the user's phone — so a leaked login is not merely untidy, it is the
        // mailbox eventually refusing to connect, in somebody else's app.
        //
        // A `catch` and NOT a `finally`: the whole point of a healthy launch is that the login
        // survives it. The poll timer, `syncUntilQuiet()` and the organizer claim all run on this
        // connection. Tests assert both directions — the login released when `start()` throws,
        // and the login still open when it returns.
        //
        // The shape is the one used everywhere else this codebase holds an IMAP login across work
        // that can fail — `packages/api/src/send-adapter.ts:68-71`,
        // `packages/api/src/attachments-adapter.ts:36-41` and the hosted sync worker all
        // close-then-rethrow the ORIGINAL error around exactly this window.
        try {
          // ── THE LEASE IS READ BEFORE THE FIRST MOVE, AND `ensureFolders` IS A MOVE ────────
          //
          // Reconnect is learn-then-act: the local engine reads the organizer lease BEFORE its
          // first move. Creating the `ohmail/*` tree in a mailbox Cloud is organizing is a write
          // this install has no business making, and reconnect-after-sleep is exactly when a
          // mailbox is most likely to have changed hands. Gated here and drained through the
          // already-gated inner `drain`, so a launch reads the lease ONCE rather than claiming
          // twice before it has done any work.
          //
          // A lease we could not READ is not a lease we lost. Offline is a property of both modes,
          // so an unreachable `ohmail/_meta` must leave a usable app rather than a failed launch:
          // the organizer is paused, the viewer is complete, and the poll timer asks again. It is
          // exempted BY CLASS, the same way the hosted sync worker exempts it — never by
          // inspecting a message. The login is deliberately KEPT here: it is the connection the
          // next poll asks over, and it is the one non-throwing exit from this window that has
          // further work to do.
          let permitted: boolean;
          try {
            permitted = await serialize(mayOrganize);
          } catch (err) {
            if (!(err instanceof LeaseUnavailableError)) throw err;
            // `err` and not `err.message`, and this is the sharpest case for that rule:
            // `LeaseUnavailableError` is constructed with `{ cause: err }` around an ImapFlow
            // failure, so its message quotes the folder and the driver's response. The logger
            // reduces it to `errorClass: "LeaseUnavailableError"` — which is the exemption this
            // catch block is ABOUT, so the log now names the class the code branched on.
            log("start_lease_unavailable", {
              err,
              reason: "the organizer lease could not be read, so this install organizes nothing " +
                "yet; the mirror is served and the next poll asks again",
            });
            schedule();
            return;
          }
          if (!permitted) {
            // ── A STAND-DOWN REMEMBERED ON THE ROW MUST ALSO STOP BURNING A CONNECTION ─────
            //
            // A stood-down install STOPS SYNCING ENTIRELY — it does not keep passively
            // mirroring, and it must not keep burning a connection either. A stand-down decided
            // by the LEASE closes the login inside `mayOrganize`; a stand-down decided by
            // `priorStandDown` returns from the gate before the lease is read at all — the arm
            // that keeps a lapsed Cloud subscription from auto-resuming the desktop across a
            // relaunch — so it reached none of that code. The relaunch of a stood-down install
            // therefore logged in and held the socket for the life of the process while
            // organizing nothing: no throw, no log line, no poll timer, and the only leak of
            // this family that is deterministic rather than error-dependent.
            //
            // Keyed on `priorStandDown` rather than closing unconditionally, so the lease arm is
            // not closed twice — and the GATE stays in one place. Testing the row here instead
            // would be a second reading of "may this install organize", which is exactly what
            // `mayOrganize`'s header refuses.
            if (priorStandDown) {
              try {
                await adapter.close();
              } catch (err) {
                log("adapter_close_failed", { err });
              }
            }
            return;
          }
          // Before the first cycle, always: the pipeline routes into `ohmail/*` and a move to a
          // folder the server does not have fails. The hosted sync worker does the same thing at
          // attach time.
          await adapter.ensureFolders();
          await serialize(() => drain(100));
          schedule();
        } catch (err) {
          // The ORIGINAL error, rethrown — `main.ts` decides what a failed launch means, and it
          // must not be told the connection failed to close when what failed was the drain.
          await adapter.close().catch(() => { /* the connection is already broken */ });
          throw err;
        }
      },
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          await tail;
        } catch {
          /* already logged at source */
        }
        try {
          await adapter.close();
        } catch (err) {
          log("adapter_close_failed", { err });
        }
        await opened.close();
      },
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly, or the next launch
    // finds a directory it cannot open and a message about a process that is already gone.
    await opened.close();
    throw err;
  }
}
