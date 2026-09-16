import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import {
  StaticKeyProvider, kekRingFingerprint, UNMETERED_STORAGE_CAP,
  type KekEnvIdentity, type KeyProvider, type Logger, type OpenSendAdapter, type SendAdapter,
} from "@trafficflow/core/mail";
import {
  ImapAdapter, ImapConnectionClosedError, WORKER_NET_TIMEOUTS, buildImapAuth,
  type ImapConfig, type MailboxAdapter, type CredMetaAuth, type NetTimeouts,
} from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
// The engine's OWN resolution of the Ohbox posture, never a second reading of it. `rules.ts` owns
// what an absent or unrecognised value means, and both hosts ask it the same question.
import {
  DEFAULT_OHBOX_POLICY, providerAuthservIds, resolveOhboxPolicy, resolveScreeningCutoff,
} from "@trafficflow/core/mail";
// After the `@trafficflow/core` block, matching every other file in this package: core first,
// then the private half. `packages/core` → `@trafficflow/db` is a real edge (`pipeline.ts` imports
// `classifyLedgerSource`, `drizzle-repo.ts` imports the tables), so this file should not be the
// module that enters that graph.
import {
  accountSettings, closeStoodDownAppointments, exportPendingMovesOnStandDown,
  RELEASED_ORGANIZER_SEND_SENTENCE,
  mailboxCredentials, mailboxes,
  // The erasure fence's mailbox arm and its refusal class — one module for both doors, the
  // sign-out fence's rule. The class is read by the seal's catch arm, which treats an erased
  // mailbox exactly as it treats a signed-out one.
  fenceErasedMailbox, MailboxErasedError,
  // Mail 0083 — the role vocabulary and the machine-name bound. One spelling for the sidecar's
  // gate, the worker's gate and the eleven service write doors; see `db/src/organizer-role.ts`.
  organizerDisplayName, isOrganizerRole, capabilitiesColumn,
  // The write door for `organized_by_kind`, which this store carries no CHECK for: the set
  // is widenable, so a device's refusal lives here and not in the table definition.
  organizerKindColumn,
  // The entitlements composition this host declares. From the MAIL barrel — the port is pure
  // types and one literal, and the halves that answer it stay on `@trafficflow/db/cloud`.
  UNMETERED, UNMETERED_ACCESS,
  type MailboxDisabledReason, type OrganizerRole, type Tx,
  // The change log's horizons, for the ONE question the idle scheduler asks: did this drain
  // produce anything the window could see? Nothing else on this door writes to the window's
  // mirror, so an unmoved `max` IS "nothing happened" — see `changeLogMark`.
  seqBounds,
} from "@trafficflow/db";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService,
  kbService, runAwayResponderPass, runScheduledSendPass, runSendReconcilePass,
  scheduleService, tagsService,
  makeApprovalService, makeAuthConfig, makeMailboxService, makePrivacyService,
  makeScreenerService, makeUnsubscribeService, messageService, nodeHostResolver,
  nodeOneClickPost, nodeRemoteFetch, notifyRulesService, resolveSession,
  rulesService, searchService, sendService, snippetsService, syncService, threadService,
  triageService, workflowsService, ServiceError, type UnsubscribeService,
  type AuthConfig, type MailboxAllowancePolicy, type OneClickPost,
  type PushService, type RemoteFetch,
  // The sign-out fence's durable half — one module for both doors, so the engine and the shared
  // mailbox service cannot hold two versions of the same rule (`signed-out-fence.ts`).
  fenceSignedOutMailbox, signedOutMidWrite, type CredentialOrigin,
} from "@trafficflow/services/mail";
/* The session LIFECYCLE — the machinery half of the hosted auth service (establish, refresh
 * rotation with reuse detection, family revocation, devices, the paired-device mint), from the
 * `/auth` entry that carries none of the ceremony, none of the Cloud schema and none of the
 * barrel's side effects. This import is what Phase 3's pairing rides on, and its closure is
 * census-pinned by the auth entry's own module-graph test in the services package — the engine
 * bundle's artifact census is the second line. */
import { makeSessionLifecycle } from "@trafficflow/services/auth";
import {
  API_VERSION, ALLOW_ANY_PROBE_HOST, createApp, DEFAULT_SSE, errorResponse, localRoutes, makeImapProbe,
  makeSendAdapter, makeSmtpProbe, matchRoute,
  type ProbeDialer, type SmtpProbeOptions,
  type ApiDeps, type ApiServices, type App, type Route,
} from "@trafficflow/api/local";
// THE DESKTOP-HOST DOOR's route table (Phase 3): the single-user product set plus the carved
// session-lifecycle pair, the device list and the anonymous device-pair redeem — and structurally
// nothing else. Mounted below ONLY when host mode is armed; see `desktopHostRoutes`' own header
// for the exact in/out list and the obligations it puts on this composition root.
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
// The boot contract's one comparison. Its own file, with no imports, because the desktop shell's
// install model has to apply the identical rule and `apps/desktop` declares no `@trafficflow`
// dependency at all — see the header of `credential-host.ts` for why one definition, not two.
import { credentialIsForeign, credentialIsForeignSmtp, sealedHost, sealedSmtpHost } from "./credential-host.js";
import { createSignOutFence, SIGN_OUT_FENCE_WAIT_MS, type SignOutFence } from "./signout-fence.js";
// The exit from a stand-down, as a ceremony rather than a flag — the SAME function the
// `organize-here` CLI runs. See its header for why status, reason and the one-shot stamp move
// together, and this file's `handle` for why the desktop door needs a route onto it.
import { requestOrganizerTakeover } from "./organize-here.js";
// WHICH OUTBOUND PASSES THIS COMPOSITION RUNS — one table read by the pass and by the door, so
// "a phone keeps no appointments" cannot be true in one of the two places. See its header.
import { AppointmentsRefused, runsPass } from "./composition-passes.js";
import { hostPairRoutes } from "./host-pair-routes.js";
// The static half of the host door — the built browser client the QR sends a phone to, served
// beside the API out of one `handleHost`. The route table wins; this covers everything else.
// See `host-static.ts` for the traversal defense, the caching rule and the credential-page CSP.
import { createHostStatic } from "./host-static.js";
// The host door's knobs, resolved ONCE (`resolveHostConfig` — pure, never throws, degrades with
// a surfaced reason), and the door's own send-surface ceiling. See `host-listener.ts`'s header
// for the whole arrangement; the listener itself is `main.ts`'s to start.
import { HOST_SEND_MAX_TOTAL_BYTES, resolveHostConfig, type HostState } from "./host-listener.js";
// The LAN fallback's one reading and its browser-facing explainer — the API-only decision and
// the secure-context audit behind it live in `host-lan.ts`'s header.
import { resolveLanBind, serveLanFallback, type LanState } from "./host-lan.js";
import { ensureLanIdentity, type LanIdentity } from "./host-lan-tls.js";
import { localLanRoutes } from "./lan-routes.js";
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
import { runSyncCycle, type CycleCensus, type SyncDeps } from "@trafficflow/worker/sync";
/* The memo the cycle's `knownSet` takes, from its OWN subpath and not through the loop's module:
   `one-pipeline.test.ts` holds this file's value import from `@trafficflow/worker/sync` to
   `runSyncCycle` alone, because a second value out of the loop's module would be a second piece of
   the pipeline running here. This is per-attachment state, not a piece of the pipeline. */
import { KnownSetCache } from "@trafficflow/worker/known-set";

// The ORGANIZER LEASE, from the same package and for the same reason: two readings of one decision
// table is how a LOCAL install and the CLOUD service come to disagree about who organizes a
// mailbox, and disagreement here IS the dual-organizer bug.
// `releaseMailboxClaim` for the same one-implementation reason: expunging THIS install's claim
// is the act Cloud performs when it stops being entitled to organize a mailbox, and a second
// spelling of "which of these messages are mine" is how two organizers come to disagree about
// whose claim is whose. The worker's own call site (`releaseOrganizerClaim`) states the cost of
// not doing it: a fresh claim nobody holds stands another install down for the whole staleness
// window, at exactly the moment somebody has chosen to leave.
import {
  readMailboxLease, acquireLeasePermit, releaseMailboxClaim, LeaseUnavailableError,
  OrganizerStandDownError,
  leaseStoodDown, DEFAULT_STALE_AFTER_MS, type OrganizerWriteAuthority,
} from "@trafficflow/worker/lease";
// The APPEND-LESS read, straight from core: an install that has not been asked to organize must
// still be able to say who does, and `runLeaseGate` cannot answer that question without taking
// the mailbox (its empty-folder arm claims). One method, no way to write. See
// `notePeekedHolder`.
import {
  answerLeasePeek, deriveRequestKey, type LeasePeekIo,
  type LeasePeekAnswer, type LeaseOp, type OrganizerKind,
  type OrganizerIntent,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ImapAuth } from "@trafficflow/core/adapters/imap-types";
import { OrganizerProfileSync, syncProfileMirror } from "@trafficflow/worker/profile";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
// THE SYMMETRIC-TAKEOVER REQUEST DRAIN (0.14.1), from the worker's own subpath for
// the same reason `OrganizerProfileSync` is: one implementation of "apply a reader's decision" or
// "carry this install's own decisions to the mailbox", not a second one that could disagree with
// what the hosted worker does.
import {
  applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests,
} from "@trafficflow/worker/request-drain";
// The SCHEDULED-RESURFACE FLIP, from the same package and for the third instance of the same
// argument. "Resurfaces Friday at 9" is a dated promise the product makes to the user, and the
// only thing that can keep it is a pass that notices the date has arrived. On a hosted account
// the worker's cycle runs it; a standalone install has no worker at all, so this process runs the
// SAME function against the store that is authoritative here. A local reimplementation would be a
// second answer to "when is a resurface due", which is the one thing that must not differ.
import { bubbleUpPass } from "@trafficflow/worker/bubble-up";
import { screenerAutoSuggestPass } from "@trafficflow/worker/screener-auto-suggest";
import { threadJoinHealPass, type ThreadJoinHealCursor } from "@trafficflow/worker/thread-join-heal";
import { inboundQuietPass } from "@trafficflow/worker/inbound-quiet";
// The HISTORICAL-NAME REPAIR, from the same package and for the fourth instance of the same
// argument. The values it writes have to be the ones ingest would have written from the same
// headers; a second parse here would leave two populations of rows decided by different rules, and
// the disagreement would be invisible one row at a time.
import { runSenderNameBackfill } from "@trafficflow/worker/sender-name-backfill";
import { createLocalAi, type LocalAi } from "./ai-provider.js";
import { localAiRoutes } from "./ai-routes.js";
import { localAutoSuggestRoutes } from "./auto-suggest-routes.js";
import { dialect, dialectOf } from "@trafficflow/db/dialect";
import {
  openLocalDb, type LocalDb, type LocalDbOpenPhase, type MigrationProgress, type OpenLocalDb,
} from "./db.js";
import { inStoreLane } from "./store-lanes.js";

/**
 * The shape {@link SidecarConfig.store} supplies — `openLocalDb`'s own signature, named so a
 * caller can be typed against it without importing the desktop's implementation.
 */
export type OpenLocalDbFn = (
  dataDir: string,
  opts: { log?: Diagnostic; onPhase?: (phase: LocalDbOpenPhase, progress?: MigrationProgress) => void },
) => Promise<OpenLocalDb>;
import {
  endLegacyOrganizerPauses, ensureLocalWorld, loadLocalRoster, loadUnattachedLocalRoster,
  mintLaunchSession, resolveExpiredLaunchSession,
  type LocalRosterRow, type LocalWorld,
} from "./identity.js";
// ONE RUNTIME PER MAILBOX, held in a map. The record, the map and the seed decision live in
// `roster.ts`; what stays here is the assembly that fills one in and the routes that add and
// remove them. See that file's header for what is per mailbox and what is per install.
import {
  LocalRoster,
  type CredentialBlock, type CredentialState, type LocalMailboxRuntime, type MailboxConnectionState,
  type OrganizerState,
} from "./roster.js";
// Removing a mailbox takes this install's copy of its mail with it. See `local-mirror.ts` for why
// this is the sidecar's job and not `MailboxService.delete`'s.
import { mirroredFirstSyncFacts, mirroredMessageCount, wipeLocalMirror } from "./local-mirror.js";
import { stampSynced } from "./sync-stamp.js";
import { createFirstSyncReporter, createFirstSyncTracker } from "./first-sync.js";
import type { Diagnostic } from "./log.js";
import { startEngineVitals } from "./vitals.js";

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
 * The two facts that are per MAILBOX rather than per install — whether this machine can open
 * one, and whether it organizes it — live with the runtime that holds them (`roster.ts`), and
 * are re-exported here so every caller that already reads them off this module is unchanged.
 *
 * They moved because an install now answers them N times. A single `CredentialState` for the
 * process was the same statement as the mailbox's while there was one mailbox; with several it
 * would be an answer about whichever one the shell happened to ask about last.
 */
export type {
  CredentialBlock, CredentialState, FirstSyncState, MailboxConnectionState, OrganizerState,
} from "./roster.js";

/**
 * WHAT THE ENGINE HANDS A DIAL — currently the one thing an adapter cannot report by throwing.
 *
 * A record rather than a bare callback parameter so the next connection-scoped fact (a logger
 * bound to the mailbox id, a clock) is added without re-writing every double's signature. The
 * hosted worker passes the same shape to its own factory.
 */
export interface AdapterDialContext {
  /**
   * The connection died between calls. Called from an event handler, so it MUST NOT THROW and
   * must not await anything the caller depends on — see `ImapAdapter#guardAsyncErrors`, which
   * swallows whatever comes back out of it.
   */
  onConnectionError: (err: unknown) => void;
}

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
   * The ceiling the idle ladder climbs to — a TEST SEAM. Production takes
   * {@link IDLE_POLL_CEILING_MS}; a cell that wants to watch the ladder reach its top inside a
   * second sets a small one. Below {@link pollIntervalMs} it simply means "never rest".
   */
  idlePollCeilingMs?: number;
  /**
   * How long a connection has to answer an IMAP NOOP before it is treated as dead. Absent means
   * {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}; a value that is not a positive number refuses the boot.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Diagnostics. NEVER stdout in the real process — stdout is the frame stream.
   *
   * Production passes `createSidecarLog()`, which is `packages/core`'s hardened logger. The same
   * function is handed to `readMailboxLease`, so anything the lease composition logs is redacted
   * by the same gate — which is why this stays a two-argument function and not a `Logger`.
   */
  log?: Diagnostic;
  /**
   * The same diagnostics, in the shape the shared sync loop speaks — this door once ran the loop with
   * `log` unset, so every `log?.warn`/`log?.error` in the reconcile passes chained into nothing: the
   * lines describing a write the mail server did NOT accept were discarded on the one door where the
   * local database is the only other witness. A second field rather than a wider `log` because {@link
   * Diagnostic} is a narrowing forced by `readMailboxLease`, and the level it derives is a claim about
   * this package's vocabulary (`log.ts`). Production builds one `createSidecarLogger()` and passes both
   * faces (`main.ts`; the log census asserts it). Absent ⇒ the loop's diagnostics are dropped — right
   * for tests, wrong for production, which is why the guard is on `main.ts` rather than this type.
   */
  logger?: Logger;
  /**
   * The per-install key ring, from the native shell's keystore: `version → 32-byte key`. The
   * shell owns the keystore; this Node child never reaches for one — exactly one thing crosses
   * the boundary, at spawn, in one direction. A ring and not one key, because a key that cannot
   * be rotated cannot be revoked: the hosted shape (`packages/core/src/crypto.ts`) — highest
   * version encrypts, older versions still decrypt, re-encryption is lazy — so rotation needs no
   * migration. Absent ⇒ this install has no durable key and nothing is sealed to disk at all:
   * credential storage is refused rather than performed badly ({@link refusingKeyProvider}), and
   * the shell passes the password on every launch as before.
   */
  keks?: Record<number, Buffer>;
  /**
   * HOW OFTEN THE ENGINE SAMPLES ITS OWN MEMORY. Default {@link ENGINE_VITALS_INTERVAL_MS}.
   *
   * A TEST SEAM and nothing else: the shipped interval is five minutes, and a guard that proved
   * the timer by waiting for it would take five minutes to fail. Production passes nothing.
   */
  vitalsIntervalMs?: number;
  /**
   * Injected for tests; production dials a real server. The second argument is the
   * dead-connection callback, not optional furniture: `ImapAdapter` reports the one failure it
   * cannot throw — a socket dying between calls — via {@link ImapAdapterOpts.onConnectionError},
   * and the only place this engine can supply it is where the adapter is constructed. Passing it
   * through the factory gives a test double the same handle production gets (the worker's
   * `makeAdapter` shape, not a second convention). A double declaring one parameter keeps
   * working — absence of the second parameter means "this double never dies asynchronously".
   */
  adapterFactory?: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
  /**
   * THE SUBMISSION DIAL, for compositions that must be able to REFUSE one.
   *
   * `adapterFactory`'s presence already routes the smtp probe through a double that always
   * succeeds — the right default for a composition that must not open sockets. This is the seam
   * for the opposite case: proving that a refused submission server leaves the INCOMING credential
   * stored and the mailbox connected. Absent in production, where both legs dial for real.
   */
  smtpDial?: SmtpProbeOptions["dial"];
  /**
   * Test seam for the one-click unsubscribe POST — with `fetchImpl` below, one of exactly two
   * ways this process reaches a network that is not the mailbox; both exist so a test can count
   * what left the machine. Production gets `nodeOneClickPost`: the pinned, redirect-refusing,
   * body-discarding client the hosted API uses. The URL has already passed the same SSRF gate
   * (`assertPublicHttpUrl` over real DNS) — a desktop sits inside somebody's home network, and a
   * List-Unsubscribe header naming a LAN address is refused here for Cloud's reason; unlike the
   * probe, this URL is the sender's choice, never the user's own server.
   */
  oneClickPost?: OneClickPost;
  /**
   * Test seam for the IMAGE PROXY's fetch — the third non-mailbox egress, beside
   * {@link oneClickPost} and the model endpoint, and here for the same reason they are: a test
   * can count what left the machine, and drive the gate's refusals without a network. Production
   * passes nothing and gets `nodeRemoteFetch`.
   */
  imageFetch?: RemoteFetch;
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
   * How this install names its own kind in the organizer claim — `local` unless told otherwise.
   * The claim record in `ohmail/_meta` says what sort of install holds the mailbox, and every
   * other install ranks holders partly by it. A phone runs this same composition and is not a
   * desktop, so the literal became a field. Required-in-effect for every non-desktop
   * composition: an install that claims as `local` while being something else makes the holder
   * line lie on every other device — a false statement about who holds somebody's mailbox, not a
   * cosmetic slip.
   */
  organizerKind?: OrganizerKind;
  /**
   * Who this install is to the organizer lease — the local `accounts` row unless the shell knows better, and
   * on a phone it does. The lease's clone defence rests on this id: a claim bearing our id with a nonce we
   * did not write, still live, is a restored copy of us. On a desktop `world.accountId` is exactly that. A
   * phone breaks the equivalence: a restored device backup brings the app container back with the store in
   * it, so the restored copy carries the same `accountId` — two installs sharing an id are coalesced by the
   * lease into one, a second organizer nobody can see; hence the id comes from the install marker, rotated on
   * restore. Absent ⇒ `world.accountId`. It must be stable per install and differ between installs — one
   * generated per launch would read its own claim as a stranger's.
   */
  installId?: string;
  /**
   * Where the store comes from — the desktop's PGlite mirror unless the caller brings its own. A phone runs
   * this composition over SQLite through a one-statement queue, with no PGlite, lock file or filesystem
   * module; `openLocalDb` is all of those, so the phone's composition root opens its own store and hands it
   * over — the alternative being a second copy of this whole function, the fork the architecture ruling
   * exists to prevent. Optional with the desktop opener as default: `main.ts` and the test compositions say
   * nothing about a store and must go on saying nothing. The phone's bundle also substitutes `./db.js` itself
   * — two mechanisms, not redundant: the seam makes the composition correct, the substitution makes the
   * absence of PGlite a fact about the shipped file rather than a promise about branches.
   */
  store?: OpenLocalDbFn;
  /**
   * TEST SEAM. The lease's staleness window, which no test can afford to wait out.
   * Production takes the engine's ten minutes.
   */
  leaseStaleAfterMs?: number;
  /**
   * TEST SEAM. How often the portable organizer profile is re-serialized and compared against
   * what `ohmail/_meta` holds, at most (`@trafficflow/worker/profile`). Production takes the
   * composition's five minutes.
   */
  profileFlushIntervalMs?: number;
  /**
   * Told what the boot is about to spend its time on, phase by phase, as it happens.
   *
   * `boot_phases` (the log line at the bottom of this constructor) is the same story told
   * afterwards, with numbers; this is the live narration `main.ts` turns into `phase` frames so
   * the window can say "Replaying recent changes…" instead of one sentence for every wait.
   * Best-effort and never awaited: a boot must not be able to fail, or slow, because somebody is
   * watching it.
   */
  onPhase?: (phase: BootPhase, progress?: MigrationProgress) => void;
  /**
   * Host mode — this install serves its owner's other devices (Phase 3). Armed, three things
   * exist that otherwise do not: the stdio door gains the window-only pairing mint
   * (`hostPairRoutes`), `/hello` says `pairing: true`, and {@link Sidecar.handleHost} exists —
   * the desktop-host door's `Request → Response`, which the loopback listener binds and
   * `tailscale serve` publishes. Only the exact boolean `true` arms it: absent is byte-identical
   * to the pre-host build — no extra routes, no second door, `pairing: false`. An absent config
   * value must never select the dangerous branch; the disarmed composition is pinned by test in
   * both directions.
   */
  hostMode?: boolean;
  /**
   * The served origin — `https://<machine>.<tailnet>.ts.net`, what `tailscale serve` publishes and a
   * phone's browser therefore sends as `Origin` on every mutation. Threaded into the host door's
   * request-guard allow-list, and nowhere else — the stdio door's own auth config is untouched. Without
   * it, armed, the door still exists for the window and for tests driving `handleHost`, but the
   * listener refuses to start: a guard allow-listing only `http://localhost` would refuse every real
   * browser mutation as cross-site. Validated by the same `makeAuthConfig`/`assertOriginConfig` every
   * door boots through; a failing value turns host mode off for the launch with a surfaced reason
   * (`host_config_invalid`) and can never kill the stdio door.
   */
  hostOrigin?: string;
  /**
   * The loopback port the host door's listener binds — `127.0.0.1:<port>`, the target of the
   * shell's `tailscale serve` invocation. An integer in 1..65535; anything else (port 0
   * included — the serve target must not move between launches) turns host mode OFF for the
   * launch with the same surfaced reason as a bad origin. Absent ⇒ no listener.
   */
  hostPort?: number;
  /**
   * THE BUILT BROWSER CLIENT this door serves to a phone — a directory holding the host-client
   * vite arm's dist (`index.html` + hashed `assets/`), handed at spawn exactly as the data
   * directory is (`OHMAIL_HOST_ASSETS`). The shell resolves it from the packaged app's own
   * resources; nothing here trusts the value beyond probing it once (`host-static.ts`). Absent,
   * or naming no readable build, the armed door serves its API only and app routes answer one
   * plain sentence — a degradation with a logged reason (`host_assets_missing`), never a crash.
   */
  hostAssetsDir?: string;
  /**
   * THE LAN FALLBACK (`OHMAIL_LAN_BIND`) — one operator-chosen IPv4 interface address the host
   * door ALSO binds, plain HTTP, for same-network use without Tailscale. API-only by ruling:
   * the served browser client depends on secure-context APIs a plain-http network origin does
   * not provide, so this door serves `desktopHostRoutes` for native clients and an honest
   * explainer page for a browser — see `host-lan.ts`'s header for the audit. Meaningless
   * without `hostMode`; a refused value degrades the LAN half alone (`host_lan_config_invalid`)
   * and can never kill the stdio door or the Tailscale half. Absent ⇒ byte-identical to the
   * pre-LAN composition.
   */
  lanBind?: string;
}

/**
 * The boot, as the moments a person watching the window can be told about. The database phases
 * are {@link LocalDbOpenPhase}; `preparing` is everything after the store is open — identity,
 * key ring, the AI assembly, the route table — which is fast and is named so the narration never
 * just stops at the last database phase on a launch where the remainder is what is left.
 */
export type BootPhase = LocalDbOpenPhase | "preparing";


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
   * The foreground wake — re-dial every mailbox whose connection has died, now. One call for the
   * whole install, because the event is one event: the app came back to the foreground, or the
   * machine woke, and every socket this process held is stale at the same moment. Per-mailbox it
   * is {@link LocalMailboxRuntime.redial}, which restores a connection and never starts a drain.
   * Best-effort and never throws: one mailbox's dial failing must not stop the others, and a
   * wake is not a request anybody awaits. On the desktop nothing calls this — the poll's own
   * re-dial is the right cadence there; a phone's socket dies on every background, and the
   * alternative is "organizing" on screen while nothing is filed for two minutes.
   */
  wake(): Promise<void>;
  /**
   * Hand every mailbox back — the other half of {@link wake}, and only a phone has a caller. One
   * call for the whole install: the app is leaving the foreground on a platform that will not
   * let it keep running. Per mailbox it is {@link LocalMailboxRuntime.handBack}, which removes
   * the claim and writes no row. Answers one entry per mailbox rather than a single boolean:
   * "the claim was removed" and "the search was refused" are different facts, and a caller
   * rendering "handed back" must not do so for a mailbox whose claim may still stand (`null` is
   * that state). Nothing on the desktop calls this — a desktop not running is a machine switched
   * off and the lapse is right for it; a phone backgrounds many times an hour.
   */
  handBack(): Promise<readonly { mailboxId: string; released: number | null }[]>;
  /**
   * TAKE EVERY MAILBOX BACK IF NOBODY ELSE HAS IT — {@link handBack}'s other half, and only a
   * phone has a caller. Per mailbox it is {@link LocalMailboxRuntime.resume}: the hand-back is
   * cleared and one gated cycle runs, so a free mailbox is claimed and a held one is not.
   *
   * Best-effort and never throws, for {@link wake}'s reason. What it produced is read back from
   * {@link organizerStates}, which is the fact the app renders.
   */
  resume(): Promise<void>;
  /**
   * WHO HOLDS ONE MAILBOX, ASKED NOW — the engine's own APPEND-less look, in three words.
   *
   * Exists so a door in this process can DECIDE from a look instead of from the holder columns.
   * The columns are refreshed once per cycle and carry two facts in one NULL — "nobody has ever
   * organized this" and "we have not looked" — and a door that reads that NULL as free admits a
   * press over a mailbox whose claim folder it could not see. Per mailbox, because the question
   * is per mailbox; a mailbox this install does not run answers `unreadable`, which is true.
   */
  peekOrganizer(mailboxId: string): Promise<LeasePeekAnswer>;
  /**
   * The desktop-host door — `Request → Response` over `desktopHostRoutes`, the surface a paired
   * phone reaches. Present IFF host mode is armed; a disarmed install has no second door at all,
   * not a refusing one. Same engine, store and fresh-deps discipline as {@link handle}, with
   * three composition differences that ARE the door: `/hello` answers `flavor: "desktop-host"`,
   * the window-only surfaces (`/local/*`, the pairing mint) are structurally absent, and the
   * request guard allow-lists the served origin (`SidecarConfig.hostOrigin`) — a phone's browser
   * sends the MagicDNS origin on every mutation. Bound by `host-listener.ts`, started by
   * `main.ts` from {@link hostState}.
   */
  handleHost?(req: Request): Promise<Response>;
  /**
   * What the host knobs resolved to — armed or not, the served origin and port the listener
   * needs, and the surfaced reason when host mode was asked for and refused. One reading
   * (`resolveHostConfig`), exposed so `main.ts` mounts the listener from the same answer the
   * composition was built from, and so the shell can render a degraded arm as a sentence.
   */
  readonly hostState: HostState;
  /**
   * THE LAN DOOR — {@link handleHost}'s API over the operator-chosen LAN interface, with the
   * one structural difference the API-only decision is: non-API paths answer a script-free explainer,
   * NEVER the packaged browser client (`serveLanFallback` — the secure-context audit is
   * `host-lan.ts`'s header). Present IFF host mode is armed AND `lanBind` resolved; the LAN
   * listener that binds this is `host-lan.ts`'s, started by `main.ts` from {@link lanState}.
   */
  handleLan?(req: Request): Promise<Response>;
  /**
   * What the LAN knob resolved to — the chosen address, or the surfaced reason it was refused.
   * One reading (`resolveLanBind`), exposed for the same two consumers `hostState` serves.
   */
  readonly lanState: LanState;
  /**
   * The LAN door's persistent TLS identity — the key a paired phone pins, resolved once here
   * because this composition knows the data directory. `null` when no LAN address was chosen, or
   * when the identity could not be established (`lanState.reason` says so and the door stays
   * SHUT rather than falling back to cleartext). Two consumers, deliberately one value:
   * `main.ts` serves TLS with it, and `GET /local/lan/pin` hands its fingerprint to the window
   * for the pairing link. A second reading would be a second chance for the link's fingerprint
   * and the door's key to disagree — a pairing that fails at the handshake with nothing to point
   * at.
   */
  readonly lanIdentity: LanIdentity | null;
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
  /**
   * Drain ONE mailbox, by row id. Answers how many cycles ran, and 0 for an id this install does
   * not run — which is an answer and not a fault: the row may have been removed between a caller
   * reading the list and asking about it.
   */
  syncMailbox(mailboxId: string, maxCycles?: number): Promise<number>;
  /**
   * Every mailbox's organizer state, keyed by row id.
   *
   * ADDITIVE beside {@link organizerState}, which keeps answering the seed's — the shell's
   * single-mailbox surfaces are not rewritten by this, and a caller that wants the whole picture
   * asks for it explicitly. A snapshot per call, never a live map: a poll writes these fields.
   */
  organizerStates(): Record<string, OrganizerState>;
  /**
   * Whether this install can reach each mailbox's server right now, keyed by row id.
   *
   * BESIDE {@link organizerStates} and never folded into it. The two answer different questions
   * and Settings needs both: this install is still the ORGANIZER of a mailbox it cannot currently
   * REACH, and collapsing the pair would either invite somebody to take back a mailbox nobody
   * took, or let the pane go on saying "On this machine" over a socket that has been dead for an
   * hour. A snapshot per call, like its neighbour.
   */
  connectionStates(): Record<string, MailboxConnectionState>;
  /**
   * Connect, ensure the `ohmail/*` tree exists, drain, then poll — and say which mailboxes could
   * not be launched. It still does not throw for a mailbox (one dead server must not take the
   * others down), and callers that ignore the answer keep their behaviour. The answer exists
   * because a launch failure was previously only a log line: the phone's fourth door — a
   * composition standing in front of a person who just typed a password — had no way to learn
   * the server had answered no, and reported the mailbox as opened. The report is data, not a
   * flag: each entry carries the original error, so a caller classifies it with the same
   * predicates this file uses ({@link credentialsRefused}).
   */
  start(): Promise<LaunchReport>;
  /**
   * Whether this install is currently this mailbox's organizer, and if not, who is.
   *
   * A PROPERTY, never a toggle: the shell renders it as one line and at most one action. There
   * is deliberately no setter — ceasing to organize is automatic and becoming one is an explicit
   * human action that goes through the mailbox row, not through a field on this object.
   */
  organizerState(): OrganizerState;
  /**
   * Can this install open the user's mailbox right now? Read fresh from the store on every call
   * rather than cached from launch, because the answer changes while the process runs: the
   * shell's whole recovery flow is to show a password field, `PATCH /mailboxes/:id`, and ask
   * again — a cached value would still say `unreadable` after the user had fixed it. It never
   * returns the password, to this caller or any other; the plaintext exists in this process only
   * as the argument `ImapAdapter` was constructed with.
   */
  credentialState(): Promise<CredentialState>;
  /**
   * Forget the stored mailbox password; answers whether there was one to forget. The shell can
   * delete its own configuration and stop this process, but the sealed credential lives in the
   * mirror's database — and the mirror is frozen on a door switch rather than deleted, because
   * the mail is on the user's own server. So the one thing that has to go is removed here.
   *
   * IT DOES END THE LOGIN that password bought. The socket IS the credential in use: a poll timer
   * left running re-dialled from the copy the attachment still held. The sign-out epoch moves with
   * the row (`signout-fence.ts`), the live connection closes, and every later dial refuses.
   */
  forgetStoredLogin(): Promise<boolean>;
  /**
   * Stop polling, let the in-flight cycle finish, GIVE EVERY CLAIM BACK, close IMAP, close and
   * unlock the database. The release is inside each mailbox's `detach()`, between the queue
   * settling and the logout: an install that is going down organizes nothing, and a claim left to
   * age out is `DEFAULT_STALE_AFTER_MS` in which NOBODY organizes the mailbox. The ROW is
   * untouched, so the next launch claims it back unless another install has taken it.
   */
  stop(): Promise<void>;
}

/**
 * The key provider for an install with no durable key: it refuses instead of encrypting.
 * Modelled on the hosted API's `poisonedKeyProvider`, for a sharper reason: a launch-scoped key
 * allowed to encrypt produces a `mailbox_credentials` row that is garbage by the time anyone
 * reads it — the write succeeds, the shell stops passing the password, and the failure surfaces
 * on the NEXT launch as a mailbox that cannot be opened. Refusing at the write turns that into
 * an error the user sees while still looking at the password field. `503`, not `500`: the
 * request was well-formed and the server is what is not ready; the code matches the log line so
 * the two are greppable together.
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
 * THE IMAGE PROXY'S EGRESS, ARMED — the third of this process's non-mailbox egresses, and the
 * one whose trade the reader has to be told about. The SSRF gate resolves every url and refuses
 * loopback, private, link-local and CGNAT addresses before a socket is opened, and the fetch is
 * PINNED to the addresses resolution returned, so a message can never make this machine talk to
 * something on its own network. The trade: on Cloud the fetch leaves our server, here it leaves
 * the reader's own machine, so a loaded picture tells the sender the message was opened and from
 * which network. Stated in Settings, and why tracking pixels stay refused in both positions — a
 * beacon is all cost and no picture.
 */

/**
 * The LOCAL service bag. Present: the mail domain. Absent, each absence meaning something:
 * `billing`/`waitlist` (the desktop tier is free — 503, the truth about this host); AI metering
 * (declared UNMETERED on `entitlementsPort` — BYO key or local model); `drafter`/`classifier`
 * present only with a verified model the account brings itself (`ai-provider.ts`) — absence keeps the one
 * shared name, `503 drafter_unconfigured`; `sends`/`sendAdapter` present — the shared
 * `SendService`, SMTP coordinates from `config.imap.smtp`, auth from the same sealed credential;
 * `alerts`/`admin` absent; `proposals` absent (no model ⇒ "none" ≠ "nobody asked"). `screener` and
 * `approval` are built without an adapter — the loop's reconcile does the IMAP move, as on Cloud.
 */
/**
 * The desktop tier has no mailbox limit, and nowhere to read one from. The hosted gate takes `SELECT …
 * FOR UPDATE` over the subscription table; a local install migrates the mail journal alone, so that
 * table does not exist here (left on the default gate, every mailbox write failed with `relation … does
 * not exist`). It lives in this file — the only permissive allowance policy in the repository — so the
 * hosted API has no name for it: a bypass Cloud cannot import is one it cannot take by accident, and
 * reaching it requires an import of `apps/sidecar`, which nothing serverless does. The free tier stated
 * once, beside `billing` and the unmetered AI declaration. What still gates a local mailbox is
 * everything not about money: the active-address unique index, the IMAP probe, and the organizer lease.
 */
export const UNMETERED_MAILBOX_ALLOWANCE: MailboxAllowancePolicy = async () => {
  /* No plan, no count, no lock. The desktop tier is free and its limit is the user's disk. */
};

/**
 * Push has no local store, and saying so is the honest version of what already happened.
 * `PushService` reads the push registration table, which the CLOUD migration journal creates; a
 * local database is built from the mail journal alone (`db.ts`), so every call from a desktop
 * install was a query against a missing relation, answered as a 500. This refuses in the
 * vocabulary the routes already speak, and it keeps `@trafficflow/db/cloud` — billing, the
 * ledger, the staff handle — out of the shipped engine bundle, which a static import of the real
 * service would put there. A desktop notification is the shell's to raise from the local event
 * stream; it needs no subscription registered with a server.
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
 * A local install admits, always — not because the cap does not matter. The counter behind
 * {@link ImapAdmissionPort} lives in a per-address attempt table the Cloud journal creates,
 * which this database does not have. What the cap protects against is a multi-tenant burst: many
 * accounts' attachment fetches plus a worker, in two processes sharing no lock, against one
 * provider's per-account connection limit. Here there is one user, one process, and
 * `attachments-adapter.ts`'s in-process semaphore — which runs first and is unaffected — already
 * bounds how many sockets that one user can open at a time.
 */
const LOCAL_IMAP_ADMISSION = {
  acquire: async () => true,
  release: async () => {},
};

/**
 * Give this install's claim back, keeping the third answer — one function because a bare `try`/`catch` at a
 * call site collapses two of {@link releaseMailboxClaim}'s three outcomes: it removed N claims of ours; it
 * found none (a complete answer, reads as `0`); or it COULD NOT LOOK — not exotic: the release enumerates our
 * records by asking the server, and a refused search, a short walk or a folder over its ceiling all answer
 * "could not". Swallowing that told a person the mailbox was let go while our claim stood in `ohmail/_meta`,
 * and any other install stood itself down against it for the staleness window. So "could not look" is a value
 * the callers handle (`null`; a number = how many of ours were removed — `0` is an answer). The shape is the
 * worker's own; success is logged by each caller in its own sentence.
 */
async function releaseOwnClaim(
  adapter: MailboxAdapter,
  installId: string,
  mailboxId: string,
  /**
   * THE TWO NONCES THIS INSTALL CAN NAME AS ITS OWN. A release is addressed by (install, nonce), so
   * a restored image does not lose its claim to a sibling's stop; a `current` of `null` is refused
   * inside rather than widened to the id. BOTH FIELDS REQUIRED, no default: `pending` is the nonce
   * a renewal minted and never heard back about (`LeaseSelf.pendingNonce`), and an optional field
   * would let a call site forget it and clear every record EXCEPT the one holding the mailbox.
   */
  nonce: { current: string | null; pending: string | null },
  log: Diagnostic,
  reason: string,
  /** The configured window the stale term is measured against — one clock on every tier. */
  staleAfterMs?: number,
): Promise<number | null> {
  try {
    return await releaseMailboxClaim(adapter, installId, mailboxId, nonce.current, {
      ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
      ...(nonce.pending != null ? { pendingNonce: nonce.pending } : {}),
    });
  } catch (err) {
    log("organizer_claim_release_failed", { err, mailboxId, reason });
    return null;
  }
}

/**
 * How the holder of this mailbox relates to this install — by install id, and by the nonce this
 * install last armed. Read at the stand-down, where `organized_elsewhere:*` is all there is. It is
 * this site's comparison, not the gate's, and the difference is load-bearing: the gate writes a
 * nonce and decides against it (`runLeaseGate`'s confirm arms `lastNonce`), and that value never
 * reaches this scope — `leaseNonce` holds the previous nonce during a renew and `null` after a
 * restart. So `our_last_nonce` means "the holder carries the nonce we last armed" — true about this
 * install, not a claim the gate compared the same values. What it settles: `install_id` is somebody
 * else's install; every other member is this install looking at its own claim.
 */
function ownClaimTerm(
  by: { installId: string; nonce: string } | null,
  installId: string,
  lastNonce: string | null,
): "no_holder" | "install_id" | "other_nonce" | "our_last_nonce" | "no_armed_nonce" {
  if (by === null) return "no_holder";
  if (by.installId !== installId) return "install_id";
  if (lastNonce === null) return "no_armed_nonce";
  return by.nonce === lastNonce ? "our_last_nonce" : "other_nonce";
}

/**
 * The service bag, rebuilt per request so the two AI slots can be present or absent according to
 * what this install can do at the moment it is asked. Per request rather than per launch because
 * the answer changes while the process runs: somebody saves a key, the endpoint stops answering,
 * a verification succeeds — a bag built at launch would freeze that answer, and a route would
 * offer a model that is gone or refuse one just configured. Every service in it is an imported
 * singleton or a constructor that stores its arguments; no per-request work beyond the object
 * literal. `ai` is `undefined` for a host with no AI at all — the same shape as an install that
 * has simply not configured one.
 */
function localServices(
  authConfig: AuthConfig,
  keyProvider: KeyProvider,
  /**
   * THIS INSTALL'S OWN ID, and without it the hand-back is refused on the desktop whatever the
   * row says. `MailboxService.release` accepts a stranded claim only when the row's
   * `organized_by_install_id` equals `deps.installId`, and an absent one compares equal to
   * nothing — so the desktop was told it could not stop organizing a mailbox it holds. That is
   * the OTHER half of the same defect as the projection: one half records who holds it, the
   * other half is able to recognise itself. Neither works alone.
   */
  installId: string,
  openSendAdapter: OpenSendAdapter,
  unsubscribe: UnsubscribeService,
  /**
   * THE IMAGE PROXY'S FETCH — passed in rather than imported here for the reason `unsubscribe`
   * is: both are egresses, and a composition that builds its own could not be handed a counting
   * double. The call sites resolve it from the config seam.
   */
  imageFetch: RemoteFetch,
  /**
   * WHAT THIS COMPOSITION CLAIMS AS — and here it decides one thing only: whether the send-later
   * verbs may MINT an appointment. The kind rather than a boolean, so this function reads
   * `composition-passes.ts` itself and there is one answer to "does this install keep
   * appointments" rather than a derived flag a caller could compute the other way.
   */
  organizerKind: OrganizerKind,
  ai?: LocalAi,
): ApiServices {
  const classifier = ai?.classifier();
  const drafter = ai?.drafter();
  return {
    sync: syncService,
    /**
     * The session lifecycle over the local store (Phase 3) — the same establish/rotate/revoke
     * machinery Cloud runs, instantiated bare: no ceremony, because this tier has no
     * registration and no factors (the machine's own login is the boundary — the
     * `mintLaunchSession` argument in `identity.ts`), and the base class's hosted hooks answer
     * the local truth: no event table, no throttle, no enrolled factors. Wired but not yet
     * consumed by `localRoutes`; it is what the desktop-as-host door mints paired-device
     * sessions through (`establishPairedDevice`), rotates bearer pairs with (`/auth/refresh`)
     * and revokes by (`GET/DELETE /devices`). The launch session stays `identity.ts`'s.
     */
    auth: makeSessionLifecycle({ config: authConfig }),
    // THE GATED IDEMPOTENT SEND, and the SAME `SendService` Cloud runs — the `outbound_sends`
    // reservation, the pre-minted Message-ID, the verify-by-Sent recovery and `SEND_STALE_AFTER_MS`
    // are all the shared implementation. Only the transport differs, and that difference is
    // `sendAdapter` below: `openLocalSend` builds SMTP from `config.imap.smtp` and authenticates
    // with the one sealed credential the IMAP side decrypts. Forking a second sender here is
    // exactly the divergence the one-pipeline rule forbids on the receive side, for the same reason.
    sends: sendService,
    sendAdapter: openSendAdapter,
    // No platform ceiling on attachment bytes — a fact about this host, not a preference. The
    // hosted API runs behind a serverless request-body limit, and `SendService`'s 3 MB constant
    // is that limit in raw bytes, reasoned from a deployment this process is not. Here the
    // compose form, this handler and the SMTP dial are one process: no request body sits
    // between them, so the only ceiling is the one the user's own submission server announced
    // (`mailboxes.smtp_max_size_bytes`, mail 0055), which `SendService` applies. `null` is a
    // declaration, not an absence — an install that said nothing would get the hosted constant,
    // the stricter branch; until the server has been probed the column is NULL and this still
    // resolves to 3 MB, so the loose direction is unreachable without a measurement.
    sendSurfaceMaxTotalBytes: null,
    // UNMETERED STORAGE, typed on the same declaration-not-inference terms as the mailbox
    // allowance below: the desktop tier is free and its limit is the user's own disk. A value
    // somebody wrote, never an absent-config default — the send route REFUSES the sent-copy
    // projection on a host that declared nothing.
    storageCapOf: async () => UNMETERED_STORAGE_CAP,
    push: LOCAL_PUSH,
    imapAdmission: LOCAL_IMAP_ADMISSION,
    // The add-time probe's SSRF gate is a no-op on a local install: a desktop user's own mail
    // server may sit on a LAN address or a non-standard port, and this process opens sockets only
    // on the user's own machine, so there is no cross-tenant network to protect. Named explicitly,
    // never a default — the hosted deployment wires the enforcing `makeProbeHostGuard` instead.
    probeHostGuard: ALLOW_ANY_PROBE_HOST,
    /**
     * UNMETERED, SAID OUT LOUD — the ITEM-10 distinction, in the one bag where it matters most.
     *
     * An absent member is a composition nobody finished; this literal is a deployment that means
     * it. Nothing here dials anyone about an account's standing, no limit applies, and the AI half
     * is gated by whether this install has a model key of its owner's own and by nothing else.
     */
    entitlementsPort: UNMETERED,
    mailbox: makeMailboxService({
      keyProvider, allowance: UNMETERED_MAILBOX_ALLOWANCE, installId,
      // Declared, not absent: `UNMETERED_MAILBOX_ALLOWANCE` ignores the verdict, and an ABSENT
      // reader is what a host that forgot to wire one looks like. This says which this is.
      accessOf: async () => UNMETERED_ACCESS,
    }),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    // The classifier reaches the SUGGEST half only; the read half is constructed without one.
    // `credits` stays absent — this tier is free, so an absent gate means unmetered, not
    // ungated. No `unsubscribe` here, deliberately: the automatic screen-out pass stays OFF on
    // this door until its consent surface exists. The engine CAN post (the port is on the bag
    // for the user-initiated verb); what is missing is everything around an AUTOMATIC
    // third-party request — the pre-click disclosure is mode-gated off here and
    // `block_auto_unsubscribe_at` has no local route; arming without those would send
    // third-party requests on a gesture whose UI never said it would.
    // `landing-mailbox-truth.test.ts` reads this call site: while the pass is unwired the
    // landing copy MUST carry the standalone qualifier; wiring `unsubscribe` here flips that.
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
    /* `imageFetch` is the test seam `oneClickPost` is, and for the same stated reason: both exist
       so a test can count what left the machine. Production passes nothing and gets the pinned,
       redirect-manual client the hosted door uses — one implementation, so the two doors cannot
       classify a beacon or resolve a host two ways. */
    privacy: makePrivacyService({ remote: imageFetch, resolver: nodeHostResolver }),
    // The MANUAL verb only: `POST /messages/:id/unsubscribe`, which `localRoutes` has mounted
    // (answering 503 `unsubscribe_unconfigured`) since the record table landed, now performs the
    // request on this door. A manual unsubscribe is the user's own explicit act on mail in front
    // of them — the same consent as clicking the list's link themselves, minus the trackers —
    // which is why it is armed while the AUTOMATIC pass above is deliberately not. On this door
    // the POST leaves the user's own machine (there are no ohmail servers in a standalone
    // install's loop, by the door's own design); the hosted door keeps the server-side posture
    // `unsubscribe-service.ts` documents.
    unsubscribe,
    contacts: contactsService,
    snippets: snippetsService,
    notify: notifyRulesService,
    away: awayResponderService,
    attachments: attachmentsService,
    kb: kbService,
    tags: tagsService,
    drafts: draftsService,
    /* Send later's two verbs (mail 0077). This process runs its own scheduled-send pass in the
       local sync loop (the standalone install has no Cloud worker), so an appointment made on this
       door is kept by this door — WHERE THE PASS IS COMPOSED. Where it is not, the door may not
       accept the promise either: `AppointmentsRefused` refuses the mint with the sentence and
       inherits cancel, so a standing appointment can still be taken off. Two independently
       measured conditions on purpose — the door stops the promise, the pass stops the delivery. */
    schedules: runsPass(organizerKind, "scheduled-send")
      ? scheduleService
      : new AppointmentsRefused(),
    workflows: workflowsService,
  };
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * ══ THE CEILING AN IDLE MAILBOX RESTS AT ══
 *
 * Two minutes. It is an eighth of `DEFAULT_STALE_AFTER_MS` (10 min), which is the bound that
 * decides when another install may take a mailbox whose organizer stopped renewing — so a claim
 * renewed once a ceiling still has four missed renewals of room. It is the same order as the
 * shell's own belt behind its wake stream (`WAKE_SAFETY_POLL_MS`, 90 s). Freshness is not what
 * this trades: the rest is taken ONLY while the mailbox's own IDLE is carrying arrivals.
 */
export const IDLE_POLL_CEILING_MS = 120_000;

/**
 * The next delay after a drain that found nothing — geometric, clamped, and a pure function so
 * the ladder can be watched on a fake clock. `base` floors it (a configured poll interval above
 * the ceiling is honoured rather than shortened), and doubling from `current` means the ladder
 * climbs 15 → 30 → 60 → 120 and then stays.
 */
export function nextIdlePollMs(current: number, base: number, ceiling: number): number {
  const floor = Math.max(1, base);
  const cap = Math.max(floor, ceiling);
  return Math.min(Math.max(current, floor) * 2, cap);
}

/**
 * The dial context for a connection nobody keeps — a probe and a send. Both open a login, do one
 * thing and close it inside the call that made them: no poll timer, no runtime to mark, so "the
 * connection died between calls" describes nothing — either the call is in flight and the
 * failure comes back as a throw, or the connection is closed and its death is what we asked for.
 * A named constant rather than an inline `() => {}` at each site, because the empty body is a
 * claim — "there is nothing to heal here" — stated once with the reason attached.
 */
const ONE_SHOT_DIAL: AdapterDialContext = { onConnectionError: () => { /* see above */ } };

/**
 * A DIAL REFUSED BECAUSE THIS INSTALL HAS SIGNED OUT. The mailbox password is gone from the store
 * and the copy this attachment holds in memory may not be used to open a login: every dial reads
 * the sign-out epoch (`signout-fence.ts`) and this is what it throws when the epoch has moved.
 */
export class SignedOutError extends Error {
  readonly code = "ESIGNEDOUT";
  constructor() {
    super(
      "this install signed out, so the password this mailbox resolved is not dialled with; " +
      "the mirror is served and signing in again opens a connection",
    );
    this.name = "SignedOutError";
  }
}

/**
 * The drain was gated on a connection that no longer exists — a coded refusal, not a fault. The
 * organizer lease is read once per drain, on one connection; if that connection is replaced
 * mid-drain, every later step would run against a connection whose lease it never read — on a
 * mailbox that changed hands during the outage, two organizers writing. So the drain carries the
 * generation it gated under and refuses the moment that stops being current. Nothing is wrong
 * with the mailbox, credential or server: the pass is stale, and the very next drain re-reads
 * the lease on the new connection. It carries a `code` so a caller can tell it from a real fault
 * without matching on a message.
 */
export class ConnectionReplacedError extends Error {
  readonly code = "ECONNGEN";
  constructor(readonly gatedGeneration: number, readonly currentGeneration: number) {
    super(
      `this pass read the organizer lease on connection generation ${gatedGeneration}, and the ` +
      `mailbox is now on generation ${currentGeneration}; it is abandoned rather than continued ` +
      "on a connection it never gated",
    );
    this.name = "ConnectionReplacedError";
  }
}

/**
 * How long the organizer lease may go on being unreadable before the connection is called dead.
 * `LeaseUnavailableError` is exempt from every failure counter by class, correctly — "I could
 * not look" must never be recorded as "this mailbox is broken" — but with nothing else bounding
 * the exempt arm, a permanently dead connection is retried for ever: the measured wedge, the
 * same failure every poll interval, healed only by a restart. The hosted worker reached this
 * number first (`DEFAULT_LEASE_UNAVAILABLE_DETACH_MS`), and its argument for a duration over a
 * cycle count holds here: "after N cycles" is a proxy for time that silently retunes itself the
 * day somebody changes `pollIntervalMs`.
 */
export const LOCAL_CONNECTION_DEAD_AFTER_MS = 120_000;

/**
 * …and the cycle count beside it, which is not a second opinion. Whichever comes first: the duration is
 * the product property; this is the arm that cannot be bypassed by a composition that owns the clock —
 * an injected `now`, or a test driving drains by hand. Without it the bound would be provable only by a
 * test that sleeps two minutes, and a guard nobody can afford to run is one nobody runs. Eight, because
 * eight polls at the shipped 15 s interval IS two minutes: on the shipped configuration the arms fire
 * together and the count adds nothing. It bites only where the poll is faster, and there an early
 * re-dial costs one process-owned socket — the asymmetry that makes the union safe here and not in the
 * hosted worker, where the same shape would be a re-attach storm across every account on a shard.
 */
export const LOCAL_CONNECTION_DEAD_AFTER_CYCLES = 8;

/**
 * How long a heartbeat may go unanswered before the connection is called dead.
 *
 * The event detector needs the driver to report; the duration bound
 * ({@link LOCAL_CONNECTION_DEAD_AFTER_MS}) needs cycles that ran and threw. A half-open link
 * produces neither, so the fastest thing left is the socket's own inactivity timer at 120 s.
 * Thirty seconds is set against what a NOOP costs — one round trip — and what a false positive
 * costs: one re-dial of one socket this process owns.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * The heartbeat window for this launch. A value that is not a positive number refuses the boot
 * rather than falling back to the default: a zero or unreadable window would report every mailbox
 * unreachable on every poll, which is indistinguishable from the mail server being down. The
 * refusal names the variable, and reports the TYPE of a non-number rather than echoing it.
 */
export function resolveHeartbeatTimeoutMs(config: { heartbeatTimeoutMs?: number }): number {
  const raw: unknown = config.heartbeatTimeoutMs;
  if (raw === undefined) return DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    const said = typeof raw === "number"
      ? (Number.isNaN(raw) ? "not a number (NaN — the value supplied is not numeric)" : String(raw))
      : `not a number (${typeof raw})`;
    throw new Error(
      "OHMAIL_HEARTBEAT_MS must be a positive number of milliseconds — the window a connection " +
      `has to answer an IMAP NOOP in before it is treated as dead. It is ${said}. Refused at ` +
      "startup rather than replaced by the default: a zero or unreadable window would make every " +
      "poll declare this mailbox unreachable and re-dial it, which is indistinguishable from the " +
      "mail server being down.",
    );
  }
  return raw;
}

/**
 * How often the roster route says it answered, at rest.
 *
 * A line per answer is four a minute while Settings is open. A line only on change is worse: an
 * answer that never changes and a question that stopped arriving then produce the same nothing,
 * which is the pair this instrument exists to separate. On a change or once a minute, so the
 * reading is the trail and a gap in it is the silence.
 */
export const LOCAL_CONNECTIONS_LOG_EVERY_MS = 60_000;

/**
 * The deadlines this process dials with — the persistent-process set, never the serverless one.
 * `DEFAULT_NET_TIMEOUTS.socketMs` is 25 s, chosen against a 60-second serverless ceiling; the sidecar passed
 * no `timeouts`, so a desktop holding connections for the life of the window inherited it. `socketMs` is
 * Node's socket inactivity timer, and imapflow only auto-idles 15 s after the last command with a mailbox
 * selected — the fatal window is a long quiet stretch mid first sync (measured: `NoConnection` at 31 s and 69
 * s, growing with mailbox size — a property of the link, not the platform). The same values as {@link
 * WORKER_NET_TIMEOUTS}, not a second literal (the dial test asserts equality). Sync dial only: probes keep
 * short deadlines, sends resolve per mailbox (`makeSendAdapter`).
 */
export const SIDECAR_NET_TIMEOUTS: NetTimeouts = WORKER_NET_TIMEOUTS;

/** First wait after a dial that failed for a reason that may pass. Doubles to
 *  {@link REDIAL_BACKOFF_MAX_MS}; {@link DESKTOP_RECONNECT}'s ladder IS that doubling, and the
 *  code reads the ladder — these two stay the authority on its shape and the test compares them. */
export const REDIAL_BACKOFF_BASE_MS = 15_000;
/**
 * THE CEILING ON THAT WAIT.
 *
 * Without a backoff at all, a server that accepts TCP and refuses everything got a fresh dial
 * every poll — FOUR LOGIN ATTEMPTS A MINUTE, for as long as the app stayed open. Providers
 * throttle that, and some lock the account; the person's mail then stops for a reason the app
 * caused. Five minutes is short enough that a real outage heals without anybody pressing
 * anything and long enough that a broken server sees single figures per hour.
 */
export const REDIAL_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * How long this composition waits before calling a connection dead, and how it re-dials.
 * The four bounds above suit a desktop that runs for days, where a dead socket is rare and a
 * counted login is the costly mistake. A phone organizes only while ohmail is open and drops its
 * route for seconds, so the same numbers read as a broken app. The bounds therefore become a
 * PROFILE selected by {@link OrganizerKind} — no new flag: the discriminator is already in the
 * claim, and `composition-passes.ts` is the prior art for an exhaustive record over it, so a
 * fourth kind cannot reach the claim without an answer here.
 */
export interface ReconnectProfile {
  /** The duration bound over failing cycles — see {@link LOCAL_CONNECTION_DEAD_AFTER_MS}. */
  readonly deadAfterMs: number;
  /** The cycle bound beside it, whichever comes first — {@link LOCAL_CONNECTION_DEAD_AFTER_CYCLES}. */
  readonly deadAfterCycles: number;
  /**
   * THE WAIT BEFORE EACH RE-DIAL, step by step, THE LAST ONE REPEATING FOR EVER.
   *
   * An explicit ladder rather than a base and a cap, because the two profiles do not share one
   * curve: the desktop's is the shipped doubling (and the desktop entry below is exactly what
   * that doubling produces — `reconnect-after-close.test.ts` proves it against
   * {@link REDIAL_BACKOFF_BASE_MS} and {@link REDIAL_BACKOFF_MAX_MS} rather than retyping it),
   * and the phone's is a ruled sequence that is not one. `ladderMs[0]` is also the floor under a
   * person's press, so a press is never rationed slower than the automatic ladder it skips.
   */
  readonly ladderMs: readonly number[];
}

/** The shipped desktop and Cloud numbers, unchanged — see the four constants above. */
export const DESKTOP_RECONNECT: ReconnectProfile = {
  deadAfterMs: LOCAL_CONNECTION_DEAD_AFTER_MS,
  deadAfterCycles: LOCAL_CONNECTION_DEAD_AFTER_CYCLES,
  ladderMs: [15_000, 30_000, 60_000, 120_000, 240_000, 300_000],
};

/**
 * A PHONE. Detection at 3 cycles or 45 s — a phone's session is
 * minutes, so two minutes of silence is most of it — and a ladder of 5/15/30/60 s with the last
 * step repeating. The ladder never runs out, which is why the sentence a person reads keys on the
 * wall clock and not on an exhausted ladder.
 */
export const PHONE_RECONNECT: ReconnectProfile = {
  deadAfterMs: 45_000,
  deadAfterCycles: 3,
  ladderMs: [5_000, 15_000, 30_000, 60_000],
};

export const RECONNECT_PROFILES: Readonly<Record<OrganizerKind, ReconnectProfile>> = {
  local: DESKTOP_RECONNECT,
  cloud: DESKTOP_RECONNECT,
  mobile: PHONE_RECONNECT,
};

/** Which bounds this install runs on. Exhaustive over the claim kinds by the record's type. */
export const reconnectProfile = (kind: OrganizerKind): ReconnectProfile =>
  RECONNECT_PROFILES[kind];

/** The wait before attempt `n` (1-based). Past the ladder's end the last step repeats. */
export const redialStepMs = (profile: ReconnectProfile, attempt: number): number =>
  profile.ladderMs[Math.min(Math.max(attempt, 1), profile.ladderMs.length) - 1]!;

/**
 * ══ AWAIT A PROMISE, OR GIVE UP — the whole of what makes a stop finish on a wedged link ══
 *
 * Answers whether it SETTLED, and a rejection counts as settled: the caller's question is "is the
 * work over", and a failure is over. The timer is unref'd and cleared on both paths, so a bounded
 * wait can never be the thing that holds a process open.
 */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  /* THE DEADLINE IS A WALL-CLOCK INSTANT, AND THE TIMER IS RE-ARMED AGAINST IT.
   * `setTimeout` schedules against the event loop's cached clock, which is not refreshed while
   * synchronous work runs, so a single-shot timer can fire up to a millisecond before `Date.now()`
   * reaches the deadline — a bounded wait that returns early is a bound that does not hold, and
   * `detach()` measured it as a 299 against the 300 ms interval it promises. */
  const deadline = Date.now() + Math.max(0, ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    const arm = (): void => {
      const left = deadline - Date.now();
      if (left <= 0) { resolve(false); return; }
      timer = setTimeout(arm, left);
      timer.unref?.();
    };
    arm();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), elapsed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * WHAT A LAUNCH COULD NOT OPEN — see {@link LocalSidecar.start}.
 *
 * Empty is the healthy answer AND the offline one: a mailbox with no usable password never
 * dials, which is not a failed launch (`start()` returns before `connect()` for it).
 */
export interface LaunchReport {
  readonly failures: readonly { readonly mailboxId: string; readonly err: unknown }[];
}

/**
 * Did the server refuse the encrypted way in — the TLS twin of {@link credentialsRefused}.
 * imapflow stamps `tlsFailed` on both of its TLS refusals: no STARTTLS where the options require
 * it (`_failSTARTTLS`), and data injected between the tagged STARTTLS OK and the handshake. Both
 * mean the same thing to a caller: this configuration cannot be dialled, and a poll will not
 * make it dialable — what separates it from a timeout or a refused socket. The same `cause` walk
 * and hop bound as its neighbour: the adapter wraps, and a predicate reading only the outermost
 * error would answer `false` for the wrapped shape.
 */
export function tlsRefused(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { tlsFailed?: unknown }).tlsFailed === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Did the server reject our credentials — one bit, deliberately narrower than the worker's.
 * `classifyMailboxError` is the real taxonomy and this is not a second copy: it answers one question
 * where that answers six, and it is not imported for a structural reason — that module imports `makeDb`
 * from `@trafficflow/db/cloud`, and the worker's export map exists precisely to keep the hosted
 * Postgres pool out of the desktop. What is shared is the SIGNAL, so the two cannot disagree on the one
 * case both judge: imapflow's `authenticationFailed` flag and the OAuth client's `OAUTH_INVALID_GRANT`.
 * Everything else — timeout, TLS failure, refused socket, a server that is down — is NOT this, which
 * keeps a provider blip from telling somebody their password is wrong.
 */
export function credentialsRefused(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if ((e as { authenticationFailed?: unknown }).authenticationFailed === true) return true;
    if ((e as { code?: unknown }).code === "OAUTH_INVALID_GRANT") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * DID THE SERVER ANSWER A FETCH AND REFUSE IT — a tagged `NO` or `BAD`, never a dead socket. A
 * mailbox over quota, a backend being repaired, a host throttling body fetches: the connection is
 * up, the login stands, and one command was declined. Calling that an outage told a person their
 * connection was lost by a server that had just signed them in.
 *
 * Read off imapflow's `responseStatus` and off the command WE sent; the server's words steer
 * nothing. FETCH only — a declined CREATE, MOVE or APPEND still records an outage. A refused
 * SIGN-IN is excluded by class: that answer is `signInRefused`, and the two must not merge.
 */
export function fetchRefusal(err: unknown): "NO" | "BAD" | null {
  if (credentialsRefused(err)) return null;
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    const status = (e as { responseStatus?: unknown }).responseStatus;
    const sent = (e as { executedCommand?: unknown }).executedCommand;
    if ((status === "NO" || status === "BAD") && typeof sent === "string" && IMAP_FETCH_SENT.test(sent)) {
      return status;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** {@link fetchRefusal} as the one bit a branch wants. */
export function fetchRefused(err: unknown): boolean {
  return fetchRefusal(err) !== null;
}

/**
 * The command THIS PROCESS sent, matched on its verb. imapflow builds `executedCommand` from what
 * we handed it, so it is ours to read; the tag is whatever the driver minted and is skipped.
 */
const IMAP_FETCH_SENT = /^\S+ (?:UID )?FETCH\b/i;

/**
 * Did this failure come from the connection, or from the work? The bound counts connection-class failures and nothing
 * else. `LeaseUnavailableError` alone was wrong: an organizer's drain reads `ohmail/_meta` first, so a dead socket
 * surfaces as that class — a READER's gate takes the append-less peek, which never throws by design, so its dead
 * socket arrived as an ordinary adapter error and advanced neither arm: the mirror froze until restart with the pane
 * reporting the mailbox reachable. Still not "any failure": a store or classifier fault says nothing about the
 * socket, and counting it would churn logins on the strength of a bug elsewhere. {@link ConnectionReplacedError} is
 * excluded because it is our own refusal — counting it would let one re-dial arm the bound toward the next. The
 * `cause` chain is walked because both wrappers carry the driver's error underneath.
 */
export function isConnectionFailure(err: unknown): boolean {
  if (err instanceof ConnectionReplacedError) return false;
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 8; hops++) {
    if (e instanceof LeaseUnavailableError || e instanceof ImapConnectionClosedError) return true;
    const code = (e as { code?: unknown }).code;
    /* imapflow's own vocabulary for a socket that is gone, plus the adapter's `EIMAPCLOSED` and
       the node-level resets. Matched as a closed set of literals rather than by message text:
       a server's own words must never be able to steer this. */
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The closed set {@link isConnectionFailure} matches. Literals only — never a message. */
const CONNECTION_ERROR_CODES = new Set([
  "NoConnection", "EIMAPCLOSED", "ECONNRESET", "ECONNREFUSED", "EPIPE",
  "ETIMEDOUT", "ETIMEOUT", "ESOCKET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
]);

/**
 * The budget for the historical-name repair, per drain — see `backfillStoredNames`. Two numbers because they
 * bound different things: the batch is how many rows one transaction writes; the pages are how many of those
 * a drain may run before yielding. Their product — 200 rows — is one visit's whole work, a deliberately small
 * fraction of a store that may hold tens of thousands: the repair is cosmetic and the sync it rides is not.
 * The batch is half the shared default — that default is sized for a server with the table to itself; here
 * the parse, the write and the request handler are one process, and what matters is the longest stretch in
 * which the window gets no answer. Fifty thousand messages take a few hundred drains, hours of the app being
 * open — the intended shape, not a limitation: rows read as they always have until their turn comes.
 */
export const LOCAL_NAME_BACKFILL_BATCH = 100;
export const LOCAL_NAME_BACKFILL_PAGES = 2;

/**
 * How often a launch runs the THREAD-JOIN HEAL (`@trafficflow/worker/thread-join-heal`) at the
 * tail of a drain. Six hours — the hosted worker's own gate — because it repairs presentation
 * (a conversation a forward split into two threads), nothing user-promised rides on a run, and
 * its candidate pre-filter is a GROUP BY over the store's threads that per-drain polling would
 * pay for nothing. A `const`, not an env var, for the reason every gate here is.
 */
export const LOCAL_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * How often a launch runs the INBOUND-QUIET pass (`@trafficflow/worker/inbound-quiet` — the
 * forwarding-detection heuristic, mail 0078) at the tail of a drain. Six hours, the hosted
 * worker's own gate, for its reason: the pass judges fortnight-wide windows, so nothing a user
 * can perceive changes between two drains, and its grouped aggregate is not worth paying
 * per poll. A standalone install has the same blind spot the incident was found in — a
 * provider-level forward diverts mail before IMAP storage while every cycle here reports
 * healthy — and no worker anywhere else will ever judge this store. A `const`, not an env
 * var, for the reason every gate here is.
 */
export const LOCAL_INBOUND_QUIET_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * A drain's wall-clock shape, from the per-cycle durations it measured — the number that
 * attributes desktop CPU and quit lag. A drain runs its inner cycles back-to-back (only a
 * `setTimeout(0)` yield between), so a drain taking longer than the poll interval is a high-duty
 * loop; and quit waits for the in-flight cycle, so `slowestMs` is the floor on how long an
 * ordinary quit blocks. `slowestMs` is the max, not the sum — the single cycle a quit waits on,
 * and the sharpest read on the account-wide-modseq folder-diff (an iCloud mailbox re-scans every
 * watched folder whenever any changed). Pure, testable without IMAP.
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

/**
 * "Sync now" forces a re-dial — the local door's one addition to the shared resync route. The shared handler
 * nulls every folder's cursor and answers 202; on this door the engine is in this process and holds a backoff
 * ladder, so the press was answered 202 and nothing happened until the ladder ran down. Wrapped rather than
 * replaced: the shared handler stays the authority for what a resync IS. On a 202 only — and 202 is the only
 * answer this check ever sees: every refusal the shared handler makes is thrown and enveloped above this
 * wrapper, so the status test is a contract on this wrapper (the suite reaches the other arm with a stub
 * route). Fire-and-forget so the answer stays immediate; the catch prevents a process-level crash on a
 * mailbox that is simply still unreachable — the ordinary case this exists for.
 */
export function withForcedRedial(
  routes: readonly Route[],
  runtimeFor: (mailboxId: string) => { syncUntilQuiet(maxCycles?: number, opts?: { force?: boolean }): Promise<number> } | undefined,
  /**
   * The engine's diagnostic seam, for the ONE line this wrapper writes: a press it refused
   * because there is no runtime to hand it to. Optional so the wrapper stays drivable from a
   * test with a stub route and nothing else — see the control that reaches its refusal arm.
   */
  log: (event: string, detail: Record<string, unknown>) => void = () => undefined,
): Route[] {
  return routes.map((r) => {
    if (r.method !== "POST" || r.pattern !== "/mailboxes/:id/resync") return r;
    return {
      ...r,
      handler: async (req, deps, params) => {
        const res = await r.handler(req, deps, params);
        if (res.status !== 202) return res;
        const id = params.id;
        if (id === undefined) return res;
        const runtime = runtimeFor(id);
        /* No runtime means the press reaches nothing, so it is refused rather than queued.
         * This was `runtimeFor(id)?.syncUntilQuiet(...)`, and the optional chain is the whole
         * defect: for a mailbox with no runtime nothing was dialled and the shared handler's
         * 202 was returned anyway — the pane says "Sync queued" while the engine never hears
         * of the mailbox, the failure-looks-like-healthy shape on the one control that exists
         * to make a stuck mailbox move. Reaching here with no runtime is not a race with a
         * removal: the 202 means `ownedRow` found the row and `assertOrganizerRole` read
         * `organizer` — the state this refusal makes unrepresentable. `DesktopMailboxes`
         * renders the sentence.
         */
        if (runtime === undefined) {
          log("local_mailbox_resync_unserved", {
            mailboxId: id,
            reason: "a resync was asked for a mailbox this install holds no runtime for; nothing "
              + "was dialled and the press is refused rather than reported as queued",
          });
          return errorResponse(
            "sync_engine_absent", 503,
            "This install is not running this mailbox, so there is nothing to sync here.",
          );
        }
        void runtime.syncUntilQuiet(undefined, { force: true })
          .catch(() => { /* the drain reports its own failures; a press must not crash the host */ });
        return res;
      },
    };
  });
}

export async function createSidecar(config: SidecarConfig): Promise<Sidecar> {
  const log = config.log ?? ((): void => undefined);
  const now = config.now ?? ((): Date => new Date());
  const address = config.address ?? config.imap.auth.user;
  /* WHAT THIS COMPOSITION CLAIMS AS, resolved ONCE. Hoisted to this scope because two readers now
     need it and `?? "local"` written twice is the "absent config selects the dangerous branch"
     shape duplicated: the lease writes it into the claim, and `composition-passes.ts` decides from
     it which outbound passes are composed at all. */
  const organizerKind: OrganizerKind = config.organizerKind ?? "local";
  /* THE CONNECTION BOUNDS THIS COMPOSITION RUNS ON, resolved from that same kind and nothing else
     — see {@link ReconnectProfile}. Hoisted here rather than read per mailbox: it is a property of
     the install, and a per-mailbox read would invite a caller to hand one mailbox a phone's
     numbers and its neighbour a desktop's. */
  const reconnect = reconnectProfile(organizerKind);
  /* THE POLL CADENCE, resolved ONCE for the same reason — `?? DEFAULT` written twice is two
     answers to one question. Two readers: the poll timer, and the bound on how long a stop waits
     for the cycle that timer started (`detach`). */
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  /* Resolved ONCE beside the interval it bounds, for that line's own reason. */
  const idlePollCeilingMs = config.idlePollCeilingMs ?? IDLE_POLL_CEILING_MS;
  /**
   * HOW LONG A STOP WAITS FOR THE IN-FLIGHT CYCLE — one drain interval, and then the socket goes.
   *
   * One interval is the honest bound: a cycle that has not come back by the time the NEXT one
   * would have started is not finishing, it is parked in a command the link will never answer.
   */
  const detachWaitMs = pollIntervalMs;
  /* Before any door is mounted: an unreadable heartbeat window is a refusal to start, not a
     value to fall back from — unlike the host knobs below, which degrade. */
  const heartbeatTimeoutMs = resolveHeartbeatTimeoutMs(config);
  /* The roster route's instrument: the last summary emitted and when, for the rule in
     {@link LOCAL_CONNECTIONS_LOG_EVERY_MS}. Counts only, never an id or an address. */
  let connectionsAnsweredLine = "";
  let connectionsAnsweredAt = 0;

  /**
   * The request-channel signing key for one mailbox, derived rather than stored: HKDF over the
   * mailbox password, salted with the mailbox's own address (`deriveRequestKey`). Computed at
   * use — it costs one hash, and persisting it would put a second copy of a
   * credential-equivalent secret somewhere the credential store does not protect. The address is
   * the salt and must match what every other install uses for this mailbox, which is why it is
   * the mailbox row's address rather than this process's configured one — a self-hosted install
   * may be configured with a login that is not the address.
   */
  /* There is no process-wide request key, and there was: `deriveRequestKey` over the SEED's
   * configured credential, salted with whichever mailbox asked — right for the seed by
   * accident, wrong for every other local mailbox (`attachLocal` dials #2..N from their own
   * stored credential, and `config.imap.auth` for a non-seed row carries no password). The
   * failure is the worst shape: HKDF over the wrong secret is still 32 bytes, so nothing
   * errors and every record for that mailbox refuses as `unauthenticated` — the same answer a
   * forgery gets, with the log naming an attack. So the key derives per attachment, from the
   * credential this attachment actually dialled with — the invariant the other two doors hold
   * by construction: derive from the credential you opened this mailbox with. */

  // ── THE BOOT CLOCK ────────────────────────────────────────────────────────────────────────
  //
  // The shell shows "Opening your mailbox" for exactly as long as this function is awaited: both
  // doors serve the bridge only after the constructor returns (`main.ts`), so every second the
  // window spends on that screen is a second spent between here and the `boot_phases` line at the
  // bottom. It brackets the WHOLE function, which is what makes the phases below answerable —
  // whatever the four named phases do not account for is the remainder, and a remainder that
  // dominates is itself the finding.
  const tBoot = Date.now();
  const opened: OpenLocalDb = await (config.store ?? openLocalDb)(config.dataDir, {
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
     * This install's own AI — a key its owner holds, a model on this machine, or nothing.
     * Assembled before the app because the route table it contributes is part of the app, and
     * because reading the stored settings once here lets every accessor downstream be
     * synchronous: the request path decides whether a drafter EXISTS while building its
     * dependency bag, not inside a handler. `canStoreKey` is the same fact `keyProvider` already
     * encodes — a refusing provider means no durable key — stated as a value rather than
     * inferred from a throw, so the settings surface can say so before offering a field it would
     * have to refuse.
     */
    const ai = await createLocalAi({
      dataDir: config.dataDir,
      keyProvider,
      canStoreKey: durableKey,
      log,
      now,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    /* `localAutoSuggestRoutes` is mounted HERE and nowhere else, which is what makes "this door
       only" structural rather than a condition in a render. `cloud-engine.ts` composes its own
       table (the read mirror plus a write-through proxy) and never this array, so a mirrored hosted
       account still arms its opt-in on the account — where the ledger and the worker that spends
       against it actually are. See `auto-suggest-routes.ts`. */
    // ONLY the exact boolean arms host mode — an absent config value must never select the
    // branch that opens a second door — and the OTHER two knobs can only ever DISARM: a garbage
    // origin or port turns host mode off for the launch with a surfaced reason, because the
    // stdio door must never die over host config. One reading, in `resolveHostConfig`; the
    // listener itself is `main.ts`'s to start from the state this exposes.
    const hostConfig = resolveHostConfig(config);
    if (hostConfig.state.reason !== null) {
      log("host_config_invalid", { reason: hostConfig.state.reason });
    }
    const hostMode = hostConfig.state.armed;
    // The LAN fallback's one reading — same discipline: a refused value degrades the LAN half
    // with a surfaced reason and nothing else changes. Absent stays silent.
    let lan = resolveLanBind(config);
    if (lan.reason !== null) {
      log("host_lan_config_invalid", { reason: lan.reason });
    }
    /**
     * The LAN door's key — resolved here, once, because this composition holds the data
     * directory, and because the link's fingerprint and the socket's certificate must come from
     * ONE object or they can disagree. Resolved only when an address was actually chosen: an
     * install that never turned same-network access on mints nothing and writes nothing, so the
     * ordinary boot is byte-identical to what it was — the rule the whole LAN half is held to. A
     * refusal degrades the LAN half to off with its own sentence in `lanState`, so the pane says
     * why; it deliberately does not fall back to a cleartext door (`maybeStartLanListener`).
     */
    let lanIdentity: LanIdentity | null = null;
    if (lan.address !== null) {
      const outcome = ensureLanIdentity(config.dataDir, log);
      if (outcome.kind === "identity") lanIdentity = outcome.identity;
      else lan = { address: null, reason: outcome.refusal.reason };
    }
    const app = createApp([
      /* THE PRESS REACHES THE ENGINE. `runtimes` is declared further down this same function;
         the closure is only ever CALLED from a request handler, long after it exists. Local
         composition only — the hosted door proxies its resync to a worker and has no runtime
         here to force. */
      ...withForcedRedial(localRoutes, (id) => runtimes.get(id), log),
      ...localAiRoutes(ai),
      ...localAutoSuggestRoutes({ db, accountId: world.accountId, ai, now }),
      // Which addresses this machine could serve same-network access on — the LAN ceremony's
      // one read, mounted UNARMED because the choice is offered before host mode exists. Never
      // on the host/LAN doors; see `lan-routes.ts`.
      ...localLanRoutes(() => lanIdentity?.fingerprint ?? null),
      // The window-only pairing mint (mint/list/revoke), on this door alone and only when host
      // mode is armed. The machine's own login is the step-up; see `host-pair-routes.ts`.
      ...(hostMode ? hostPairRoutes : []),
    ]);
    /**
     * THE DESKTOP-HOST DOOR's app — the composition a paired phone reaches, built ONLY when host
     * mode is armed so a disarmed install holds no second door, not a refusing one. Same engine,
     * same store, same `app.handle` pipeline: a remote device is a VIEWER of the one pipeline,
     * never a second write path. The window-only tables above (`/local/ai`, auto-suggest, the
     * pairing mint) are structurally absent from it.
     */
    const hostApp: App | null = hostMode ? createApp(desktopHostRoutes) : null;
    /**
     * The static half of the same door — the browser client the QR sends a phone to. Probed NOW,
     * awaited, so `host_assets_missing` lands in the boot log where somebody debugging an
     * API-only answer will look, rather than on the first request. Absent config is the ordinary
     * install and says nothing.
     */
    const hostStatic = hostMode
      ? createHostStatic({ assetsDir: config.hostAssetsDir?.trim() || null, log })
      : null;
    if (hostStatic) await hostStatic.ready();

    /**
     * One-click unsubscribe — the same service, the same gates, as the hosted API. Constructed once and handed to
     * every per-request bag for the MANUAL verb alone (`POST /messages/:id/unsubscribe`); the screener's automatic
     * pass deliberately does not receive it (see `localServices`'s `screener:` entry). Three deps: `post` — {@link
     * nodeOneClickPost}, the pinned redirect-refusing client (the second of the process's two non-mailbox egresses);
     * `resolver` — the REAL `node:dns`, as the image proxy above now also uses: the SSRF gate protects the user's own home network
     * from a `List-Unsubscribe` header naming a private address, and this URL is only POSTed after a screen-out the
     * user performed; `trustedAuthservIdsFor` — `providerAuthservIds` over the same host string the sync loop
     * resolves, so the two paths cannot disagree.
     */
    const unsubscribe = makeUnsubscribeService({
      post: config.oneClickPost ?? nodeOneClickPost,
      resolver: nodeHostResolver,
      trustedAuthservIdsFor: async () => providerAuthservIds(config.imap.host),
    });

    /**
     * A FRESH `ApiDeps` PER REQUEST. `ApiDeps` is mutable by design — `withRequestId` writes
     * `requestId`, `withSession` writes `session`, `withIdempotency` writes `idempotency` — so a
     * shared object would leak one request's identity into the next. It is the same shape the
     * client engine's contract tests build when they drive `app.handle` directly.
     */
    /**
     * The send transport — the shared `makeSendAdapter`, resolved per mailbox from that mailbox's own credential
     * rows. A hand-written `openLocalSend` assumed the SMTP server is an environment fact, true only for one mailbox:
     * with several, a reply composed in mailbox two went out through mailbox ONE's submission server authenticated
     * with mailbox two's password — silent, the copy in Sent, the only trace in the receiving server's headers. So
     * the transport comes from the rows: the `smtp` row when it exists, the mailbox's own `imap` host on 587 when
     * not. Engine-scoped: `OpenSendAdapter` takes the mailbox id. The outgoing `foreign-host` sentences go with the
     * old path; the incoming `credentialIsForeign` gate is untouched. The factory seam lets a test observe WHICH
     * server a send dialled — the only way to tell a correct send from the defect.
     */
    /**
     * The probe seam, threaded from the same place the sync adapter takes one. A probe IS a dial
     * — it opens a login against the server a person just typed — so an install configured to
     * dial through a double must dial the probe through it too; without this the local door
     * would be the one path in this process that reaches a real socket regardless. Production is
     * unaffected: `config.adapterFactory` is absent there and both probe factories fall through
     * to a real `ImapAdapter`.
     */
    const probeOpts = config.adapterFactory
      ? { adapterFactory: (cfg: ImapConfig) => config.adapterFactory!(cfg, ONE_SHOT_DIAL) as unknown as ProbeDialer }
      : {};
    /**
     * …and the submission leg, on the same condition and for the same reason. A mailbox has two
     * servers and adding one probes both; intercepting the incoming dial while the outgoing one
     * opens a real socket would make `adapterFactory` a half-seam. The double resolves an EMPTY
     * proof rather than a fabricated one — `undefined` is the documented "nothing was learned"
     * answer, and inventing an announced size would put a measurement into the store that no
     * server made. Production is unaffected: with no factory this is `{}` and the probe dials
     * for real.
     */
    const smtpProbeOpts: SmtpProbeOptions = config.smtpDial
      /* THE SUBMISSION DIAL, INJECTED — the same argument `adapterFactory` carries, and it exists
         because the default double CANNOT REFUSE. `{ dial: async () => undefined }` resolves an
         empty proof for every host, which is the right stand-in for a composition that must not
         open sockets and useless for the one behaviour that matters here: what this door does when
         a submission server says no. A test that cannot produce a refusal cannot hold the line
         that an incoming credential survives one. Production passes neither and dials for real. */
      ? { dial: config.smtpDial }
      : config.adapterFactory
        ? { dial: async (): Promise<void> => undefined }
        : {};
    const openLocalSend: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
      /* The boot contract reaches the send path, and it has to. The incoming comparison gates
       * the launch: a credential proved against one server is not offered to another. A send
       * is a dial like any other, on its own fresh connection built straight from the
       * credential rows — without this it would go on offering the password while the launch
       * that owns the mailbox was refusing to. It used to hold by construction (the deleted
       * local sender resolved through the same `resolveLogin`); the shared adapter reads the
       * rows directly, so the check is made here, at the seam that knows both. Only the
       * incoming arm (no process-wide submission host remains), and only for a mailbox this
       * install is actually running — a row with no runtime has no configuration to be
       * measured against. */
      const rt = runtimes.get(mailboxId);
      if (rt && (await rt.credentialState()) === "foreign-host") {
        throw new ServiceError(
          "upstream_unavailable", 502,
          "the stored mailbox password was proved against a different incoming (IMAP) server " +
            "than this install is now configured for, so it was not offered and nothing was " +
            "sent. Finishing or undoing the change of server resolves it.",
        );
      }
      return config.adapterFactory
        /* The empty third argument is the shared function's OWN timeouts option, which this
           door does not set — the desktop dials the user's own server with the adapter's
           defaults. Passed positionally so the factory lands in the fourth slot. */
        ? makeSendAdapter(depsFor(), mailboxId, {},
            (cfg: ImapConfig) => config.adapterFactory!(cfg, ONE_SHOT_DIAL) as unknown as ImapAdapter)
        : makeSendAdapter(depsFor(), mailboxId);
    };

    const depsFor = (): ApiDeps => ({
      db,
      now,
      requestId: "",
      /**
       * A route fault on this door has a sink — the same omission as `SidecarConfig.logger`'s.
       * `withErrorEnvelope` writes the one line describing an unhandled route fault (`request_unhandled`)
       * through `deps.logger`, falling back to `silentLogger`; this container injected none, so a 500 on the
       * standalone door was answered `internal` and recorded nowhere — on the one door where the log is the
       * only witness. `withRequestId` runs above the envelope and binds `requestId` onto whatever sits here,
       * so the line a user can quote an id for is the same line this field makes reachable. `depsForHost`
       * spreads this container, so the host door inherits the sink. Spread rather than assigned so a
       * no-logger install keeps the field ABSENT (`exactOptionalPropertyTypes`).
       */
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      session: null,
      authConfig,
      keyProvider,
      // Rebuilt per request so the AI slots reflect what this install can do NOW — see
      // `localServices`. `openLocalSend` (below) is the send transport, resolving the sealed
      // credential fresh per send.
      services: localServices(
        authConfig, keyProvider, world.accountId, openLocalSend, unsubscribe,
        config.imageFetch ?? nodeRemoteFetch, organizerKind, ai,
      ),
      // BEARER ONLY. There is no browser here, so there is no ambient cookie to abuse — and with
      // `via` structurally unable to be "cookie", `withCsrf` becomes a no-op by construction
      // rather than by a check. Same posture as the managed API base.
      allowCookieAuth: false,
      // SSE OFF, and this one is load-bearing for the transport rather than a preference: a frame
      // carries a COMPLETE response, and `GET /events` never completes. Disabled, it answers a
      // finite 503 that `HttpAdapter` already tolerates (it treats SSE as an optional wake signal
      // and polls `/sync` regardless). See the note in `protocol.ts`.
      sse: { ...DEFAULT_SSE, enabled: false },
      /**
       * `/health` publishes the key's identity, in the hosted service's own shape: `{ active,
       * count, fingerprint }` — a digest and two integers, never key material. It makes a
       * rotation observable from outside the process: after the shell installs a new version,
       * `active` moves and `fingerprint` changes. `kekError` is deliberately never set: on the
       * hosted side it makes `/health` answer 503, right for a server that cannot decrypt
       * anybody's credentials; here the same condition means "this user has not typed their
       * password yet", and an app reporting itself dead while happily serving the mirror would
       * be lying.
       */
      // `schemaTier: "mail"` because this install migrated the mail journal and nothing else
      // (`db.ts`). Without it `/health` probes for the hosted billing ledger and answers 503
      // `schema_incomplete` for ever — about a database that is complete for what it is.
      health: {
        version: API_VERSION, kek: kekIdentity, schemaTier: "mail",
        /**
         * Which store this install actually opened, named rather than left null. Null was
         * harmless with one possible answer and stops being harmless with two: `/health` on a
         * phone reports no schema census (no Postgres catalogs), so the provider is the only
         * thing in the body that says why — and a null reads as "this host does not know". Read
         * from the handle's own brand, so it cannot disagree with the store that answered the
         * request. Generic rather than a package name: the device store is expo-sqlite on a
         * phone and `node:sqlite` in the harness, and naming one would be false in the other
         * place while looking more precise.
         */
        dbProvider: dialectOf(db) === "sqlite" ? "sqlite" : "pglite",
      },
      /**
       * What `GET /hello` answers — this install's capability statement, on `health`'s injection
       * pattern. `flavor: "local"` is what a client's server picker reads to learn it is talking
       * to a desktop engine. The auth block is all-false and that is the truth: this process
       * mints one session per launch for the shell that spawned it, so there is no sign-in
       * ceremony to offer — the machine's own login is the boundary, and `needsSetup` is `false`
       * for the same reason. `ai` is per-request honest because this container is rebuilt per
       * request: whether THIS install has a verified model right now, the same fact that decides
       * whether `services.drafter` exists.
       */
      hello: {
        flavor: "local",
        needsSetup: false,
        auth: { password: false, totp: false, webauthn: false, publicSignup: false },
        features: {
          // SSE is off in this host — see `sse` above; `GET /events` answers a finite 503.
          sse: false,
          // No staging: the send runs in the same process as the SMTP dial (see local.ts).
          staging: false,
          ai: ai.drafter() !== undefined,
          // The host-mode arm, truthfully. Armed, this door carries the window-only mint
          // (`host-pair-routes.ts` — the window hands a phone a credential; no invite arm and
          // nobody to register), so the descriptor says so and the window can offer the
          // ceremony. Disarmed — the default — nothing is mounted and this stays `false`:
          // `localRoutes` itself never carries `/pair*` (the census in the API package's
          // `hello.test.ts` pins that), the mount is this composition's own, and both readings
          // are pinned — disarmed in the sidecar's hello suite, armed in its host-mode suite —
          // so neither composition can lie about the ceremony.
          pairing: hostMode,
          /* This door's image proxy FETCHES: the composition wires `nodeRemoteFetch` and the
             real resolver (see `localServices`'s `privacy:` entry), so a reading pane may offer
             pictures here and Settings may draw the switch. It was `false` in effect for as long
             as the egress was a refusal, and the route being mounted never said otherwise. */
          remoteImages: true,
        },
      },
    });
    /**
     * The host door's auth config — the served MagicDNS origin, threaded into the request
     * guard's allow-list. With `depsFor`'s loopback config, an Origin-carrying mutation from a
     * real phone browser (whose origin IS the machine's tailnet name — what `tailscale serve`
     * publishes) was refused by `withRequestGuard` as cross-site; the listener suite captured
     * exactly that red before this line existed. Built through the same
     * `makeAuthConfig`/`assertOriginConfig` every door boots through (`resolveHostConfig`); with
     * no origin configured the door keeps the stdio config — nothing browser-shaped can reach
     * it, because the listener refuses to start without the origin.
     */
    const hostAuthConfig = hostConfig.authConfig ?? authConfig;
    /**
     * Is the whole engine shutting down? — one flag for the install, distinct from any one
     * mailbox's. The account-scoped passes below used to yield on the single mailbox's
     * `stopped`, the same statement with one mailbox and not any more: `stopped` means "this
     * MAILBOX is gone", and neither of its causes is a reason for the install's own name repair
     * to stop walking rows that belong to the other mailboxes. What the yield is actually for is
     * `stop()`: a quitting engine must not open a transaction it may not finish. That is this
     * flag, and only `stop()` sets it.
     */
    let stopping = false;
    /**
     * One account-scoped pass at a time across the whole install. The passes below take an
     * account and no mailbox; every runtime's drain reaches them, and drains of different
     * mailboxes deliberately overlap — without this each pass would run N times at once over the
     * same rows. Two keep a walk position in memory (`namesCursor`, `joinHealCursor`), and a
     * position shared by two concurrent walkers is last-writer-wins: the cursor moves backwards,
     * the same page is scanned twice, the tail never reached. A single-flight join rather than a
     * queue: a second drain does not need its own run, it needs the work done — it awaits the
     * run in flight. There is one account, so nothing here is per-mailbox fair.
     */
    let accountPass: Promise<void> | null = null;
    const onceForTheAccount = async (fn: () => Promise<void>): Promise<void> => {
      if (accountPass) { await accountPass; return; }
      const run = fn().finally(() => { accountPass = null; });
      accountPass = run.catch(() => undefined);
      await run;
    };
    /**
     * The repository over this install's ONE store. Per store and not per mailbox: every method
     * on it is already scoped by the ids it is passed, so a second one per mailbox would be a
     * second handle to the same file with no fact of its own.
     */
    const repo = makeDrizzleRepo(db);
    /**
     * Who this install is, to the organizer lease — one identity for the machine, whatever
     * number of mailboxes it holds. The full argument is at the lease's banner: the id must
     * survive a crash, a reboot and a long sleep, and differ between two installs — exactly what
     * the one `accounts` row per data directory is. What multi-mailbox adds is the reason it is
     * hoisted to THIS scope rather than resolved per runtime: an install claiming each mailbox
     * under a different id would look to itself like several installs, and its own second
     * mailbox would read its first one's claim as a stranger's. One install, N claims, all
     * carrying this id.
     */
    const installId = config.installId?.trim() || world.accountId;
    /**
     * What this install calls itself, to every other install reading the claim. The fallback is the
     * desktop's, and only the desktop's: `hostname()` is the one thing a desktop process knows
     * about its machine without asking its shell. It is not available anywhere else — a phone has
     * no `os` module and its bundle substitutes a stub that throws, so reaching the fallback there
     * is a crash at composition time, the loud failure and the better half. The worse half is what
     * a silent fallback would produce, so the requirement is stated: a composition that is not the
     * desktop must name itself, or the holder line on every other device says a machine name that
     * belongs to nothing. Tied to `organizerKind`, the field that makes it necessary.
     */
    if (config.organizerKind !== undefined && config.organizerKind !== "local"
      && (config.machineName ?? "").trim() === "") {
      throw new Error(
        `a composition that claims as \`${config.organizerKind}\` must pass \`machineName\`: the ` +
          "claim it writes to the mailbox names the holder to every other install, and this " +
          "process has no machine name of its own to fall back to",
      );
    }
    const machineName = config.machineName ?? hostname();
    /** Every mailbox this install runs, oldest first. See `roster.ts`. */
    const runtimes = new LocalRoster();
    /**
     * The sign-out epoch every credential this install holds belongs to. One per engine — see
     * `signout-fence.ts` for why it is not a module-level counter and what each side of it owes.
     */
    const fence: SignOutFence = createSignOutFence();
    /**
     * Undo a credential this install wrote for a sign-out that has already happened. Every
     * transport of the one mailbox, because a seal writes the incoming and the submission rows
     * together and leaving either is leaving a password behind.
     */
    const discardCredentialsFor = async (mailboxId: string): Promise<void> => {
      await db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
    };
    /**
     * `mailboxes.signed_out_at` as it stands NOW — what a credential write records before it dials
     * so the fence can tell whether a sign-out landed while it was out (`signed-out-fence.ts`).
     * `null` for a mailbox with no row: an absent mailbox is not a sign-out, and the caller's own
     * refusal is what says so.
     */
    const signedOutAtOf = async (mailboxId: string): Promise<Date | null> => {
      const [row] = await db.select({ signedOutAt: mailboxes.signedOutAt })
        .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
      return row?.signedOutAt ?? null;
    };
    /**
     * The runtime the shell's SINGLE-MAILBOX surfaces answer for — `organizerState()`,
     * `credentialState()`, `forgetStoredLogin()` and the `adapter` this object exposes.
     *
     * Resolved per call rather than captured once, because the answer moves: removing the seed
     * while other mailboxes remain must fall through to the oldest survivor rather than keep
     * pointing at a runtime that has been detached.
     */
    const seedRuntime = (): LocalMailboxRuntime | undefined => runtimes.seed(address);
    /** The roster row for an id, or null. Used once, by the boot writes, before any runtime exists. */
    const runtimeRosterRow = (rows: readonly LocalRosterRow[], id: string): LocalRosterRow | null =>
      rows.find((r) => r.id === id) ?? null;
    // The install's own passes — account-scoped, and therefore NOT per mailbox. Everything
    // below this banner and above the next takes an ACCOUNT and no mailbox: the Ohbox posture
    // and the screening window, the resurface flip, the Screener's suggestion pass and the
    // historical-name repair. They read and write rows that belong to the install rather than
    // to one server and one login, so an install running several mailboxes runs each of them
    // ONCE per drain and not once per mailbox — the same scan repeated per row would cost N
    // times as much and answer the same question N times. Moved above the per-mailbox assembly
    // so the boundary is a place in the file rather than a fact reconstructed from arguments;
    // nothing changed in the move except the flag the name repair yields on (`stopping`).

    /**
     * How this mailbox wants its Ohbox kept — read fresh, once per drain. Two columns on `account_settings`,
     * both inputs to filing: the POSTURE decides whether obvious bulk from an admitted sender is demoted
     * (`EvaluateRulesInput.ohboxPolicy` is required so no caller sits silently on the wrong side; resolved
     * every drain, model or no model), and the BAR is the account's own sentence, reaching the classifier's
     * user turn only (absent ⇒ omitted). Read with no cache, unlike the hosted worker: one account, one
     * in-process database — a cache buys nothing and costs staleness after a Settings edit. A failed read
     * files leniently and drops the bar: `people_only` is the strict posture, and defaulting to it on a blip
     * would demote a real person's mail. The event name is the hosted worker's.
     */
    const screeningNow = async (): Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff">> => {
      try {
        const [row] = await db.select({
          policy: accountSettings.ohboxPolicy, bar: accountSettings.ohboxBar,
          // The window, which this door did not have. This file once contained zero
          // occurrences of `screeningCutoff`, `dormancy` or `screeningBaseline` — so the
          // standalone install, the free tier and the door most people meet first, screened
          // EVERY backfilled message regardless of age: a person with a decade of mail got a
          // decade of it moved into `ohmail/Screener`, one IMAP move at a time, into a queue
          // nobody was going to empty. The hosted worker has resolved this per cycle since
          // mail 0056 (`index.ts#screeningFor`); this is the same three columns and the same
          // resolver, deliberately, so the two cannot drift. `consentRoutes` are mounted on
          // `localRoutes` in the same commit — without them no surface can set the dial this
          // reads, and a cutoff nobody can choose is a window nobody chose.
          baselineAt: accountSettings.screeningBaselineAt,
          dormancyDays: accountSettings.dormancyDays,
          scope: accountSettings.screeningScope,
        }).from(accountSettings).where(eq(accountSettings.accountId, world.accountId)).limit(1);
        const cutoff = resolveScreeningCutoff(row?.baselineAt, row?.dormancyDays, row?.scope);
        return {
          ohboxPolicy: resolveOhboxPolicy(row?.policy ?? null),
          ...(row?.bar ? { ohboxBar: row.bar } : {}),
          // ABSENT ⇒ no cutoff ⇒ the gate holds every unruled sender's mail whatever its date,
          // which is both the pre-0056 behaviour and exactly what `screening_scope = 'all_time'`
          // asks for. One state, reached two ways, and `resolveScreeningCutoff` is the single
          // place that decides which.
          ...(cutoff ? { screeningCutoff: cutoff } : {}),
        };
      } catch (err) {
        log("screening_pref_read_failed", {
          err,
          reason: "this mailbox's Ohbox posture and screening window could not be read, so this " +
            "pass files on the lenient default, sends no bar to a model and applies NO cutoff " +
            "(the strict direction for the gate); the next pass reads again",
        });
        return { ohboxPolicy: DEFAULT_OHBOX_POLICY };
      }
    };

    /**
     * Scheduled resurfacing — the local half of a feature that was hosted-only by accident. A message put
     * away until Friday at nine carries `state='bubbled_up'` and a `bubbleUpAt`; on Cloud the hosted worker
     * flips it, and a standalone install has no worker, so the row sat there while the shortcut promised
     * "Resurfaces {when}". The flip belongs where the authoritative store is — here this PGlite file; on the
     * Cloud door the hosted database, whose mirror learns the resurface as an ordinary delta. Behind the
     * organizer gate (inside {@link drain}): a stood-down install's database is a frozen mirror, and flipping
     * rows there would surface items in parallel with the real owner. One indexed SELECT + one UPDATE per due
     * row, per drain, not per cycle. Failures contained: the row stays due.
     */
    const resurfaceDue = async (): Promise<void> => {
      try {
        const { flipped } = await bubbleUpPass(
          db as unknown as Tx, now(), { accountId: world.accountId },
        );
        // Only when something moved: a settled mailbox emits this line never, which is the same
        // rule the drain summary below follows.
        if (flipped > 0) log("resurface_flipped", { flipped });
      } catch (err) {
        log("resurface_pass_failed", {
          err,
          reason: "scheduled resurfaces could not be flipped this pass; the rows stay due and " +
            "the next poll tries again, and mail continues to be filed either way",
        });
      }
    };

    /**
     * Suggest for the senders that just arrived — "continuously" on a door that only runs while its window is open
     * means at the tail of a drain: the only moment this install can have new held senders, and the only moment it is
     * awake. Launch catch-up needs no second hook — nothing arrives while the app is closed, and an interrupted pass
     * resumes for free (the stored suggestion is the progress marker). It is the worker's pass
     * (`@trafficflow/worker/screener-auto-suggest`), not a copy: watermark, cap and ordering must agree character for
     * character with the Screener surface. Here `credits` is absent and `unmetered: true` declared; the watermark is
     * `account_settings.auto_suggest_at` (written by `PUT /local/auto-suggest` only); the first refusal stops the
     * pass via `classifierForCycle()`'s cooldown. On: at most one model call per new held sender, ever.
     */
    const suggestNew = async (ohboxBar?: string): Promise<void> => {
      // The port FIRST, so an install with no model — the common case, and the product's floor —
      // pays nothing and reads nothing. `classifierForCycle` and not `classifier`: this is
      // background work with nobody waiting, so it must take the seam that withholds a model which
      // has been failing rather than the one the Screener button uses.
      const classifier = ai.classifierForCycle();
      if (!classifier) return;
      try {
        const { bought, examined, capped } = await screenerAutoSuggestPass(db as unknown as Tx, {
          accountId: world.accountId,
          classifier,
          // THE DECLARATION, not an omission. See `ScreenerAutoSuggestDeps.unmetered`.
          unmetered: true,
          ...(ohboxBar ? { ohboxBar } : {}),
        });
        // Only when something was bought: an install that has not opted in, or one whose queue is
        // already answered for, stays silent every drain — the rule every other line here follows.
        if (bought > 0) log("screener_auto_suggest", { examined, bought, capped });
      } catch (err) {
        log("screener_auto_suggest_failed", {
          err,
          reason: "no suggestion was bought for the senders that just arrived; nothing is marked " +
            "and no cursor persists, so the next drain resumes at the next unanswered sender and " +
            "the Screener's own button still works in the meantime",
        });
      }
    };

    /**
     * How far the historical-name repair has walked THIS LAUNCH, and whether it is finished.
     *
     * Deliberately in memory and nowhere else. The database already holds the answer to "is this
     * row repaired?" — the column is either set or it is not — so a persisted cursor would be a
     * second, weaker copy of a fact the store keeps perfectly, and the two would drift the first
     * time a write was lost. What memory buys instead is a WALK POSITION, which is a different
     * thing and not durable state: see {@link backfillStoredNames}.
     */
    let namesCursor: string | undefined;
    let namesDone = false;
    /** When the thread-join heal last ran in THIS launch — it repairs presentation, not a
     * promise, so once per {@link LOCAL_JOIN_HEAL_EVERY_MS} is plenty and a busy drain never
     * pays its GROUP BY. Zero so a launch's first drain takes one look (splits accumulated
     * while the app was closed), exactly the worker's gate seeding. */
    let lastJoinHealAt = 0;
    /** When the inbound-quiet pass last ran in THIS launch — same seeding and cadence
     * (`LOCAL_INBOUND_QUIET_EVERY_MS`) as the heal above: zero so a launch's first drain takes
     * one look at what went quiet while the app was closed. */
    let lastInboundQuietAt = 0;
    /** Where the last gated heal walk stopped, kept only while it stopped on its BUDGET — a
     * refused group never leaves the candidate predicate, so restarting from the top every six
     * hours would rescan the same refusals for ever and never reach the groups past the cap.
     * Cleared after an uncapped walk, exactly as the hosted caller keeps its per-account map. */
    let joinHealCursor: ThreadJoinHealCursor | undefined;

    /**
     * Fill in the sender names and recipients of messages stored before there was anywhere to
     * put them — a one-time repair of this install's own store, spread over many visits. Hosted
     * rows were repaired centrally and mirrors learned the values as `/sync` deltas; a standalone
     * store is the authority nothing else has seen, so this door runs the same pass itself
     * (`@trafficflow/worker/sender-name-backfill` — a second parse would produce indistinguishable
     * rows). {@link LOCAL_NAME_BACKFILL_PAGES} pages of {@link LOCAL_NAME_BACKFILL_BATCH} rows per
     * visit; no resume state — the pass writes only unset columns (`namesCursor` is a per-launch
     * walk position, `namesDone` ends the scans); one `message` update per row repaints the window.
     */
    const backfillStoredNames = async (): Promise<void> => {
      // Both guards before any query. A quitting engine must not open a transaction it may not
      // finish, and a finished repair must cost nothing at all.
      if (namesDone || stopping) return;
      try {
        const r = await runSenderNameBackfill({
          db: db as unknown as Tx,
          apply: true,
          accountId: world.accountId,
          batch: LOCAL_NAME_BACKFILL_BATCH,
          maxRows: LOCAL_NAME_BACKFILL_BATCH * LOCAL_NAME_BACKFILL_PAGES,
          ...(namesCursor === undefined ? {} : { startAfterId: namesCursor }),
        });
        if (r.cursor !== null) namesCursor = r.cursor;
        if (r.exhausted) namesDone = true;
        // Only when something was written. A store with nothing to repair — every install created
        // after the columns existed, which is most of them — stays silent on every drain of its
        // life, and so does a store this has already finished. Counts only: WHICH message got its
        // sender back is a fact about somebody's mail, and how many did is not.
        if (r.written > 0) log("sender_names_backfilled", {
          scanned: r.scanned, fillable: r.fillable, written: r.written,
        });
      } catch (err) {
        log("sender_names_backfill_failed", {
          err,
          reason: "some older messages keep showing a bare address instead of the sender's name; " +
            "nothing is marked and no position is kept, so the next pass asks the store again and " +
            "the mail itself is unaffected either way",
        });
      }
    };


    /**
     * Attach one mailbox — everything this install does with one server and one login. The body
     * below is what `createSidecar` used to do to its only mailbox, unchanged in substance and
     * now parameterised by the row: it resolves that row's credential, opens its connection,
     * holds its lease, runs its poll timer and its serial queue, and hands back the runtime the
     * roster keeps. The install's own passes are NOT in here — they take an account and no
     * mailbox, so they are resolved once and shared by every runtime.
     */
    /**
     * The host door's per-request container — {@link depsFor} with the three differences that ARE the door:
     * the descriptor (`flavor: "desktop-host"`; `pairing: true` is this table's truth — the redeem is
     * mounted, the mint is the window's; `sse: false` is honest until the follow-up the ruling names); the
     * auth config ({@link hostAuthConfig} — the service bag is rebuilt with it so the session lifecycle and
     * the guard read ONE config); and the send surface — the stdio bag declares `sendSurfaceMaxTotalBytes:
     * null`, false on THIS door: a phone's send rides an HTTP body, so the door declares {@link
     * HOST_SEND_MAX_TOTAL_BYTES}, and `effectiveAttachmentCap` still takes the smaller of this and the
     * announced size. `allowCookieAuth: false` rides in — the zero-Set-Cookie census sweeps on that flag.
     */
    const depsForHost = (): ApiDeps => ({
      ...depsFor(),
      authConfig: hostAuthConfig,
      services: {
        ...localServices(
          hostAuthConfig, keyProvider, world.accountId, openLocalSend, unsubscribe,
          config.imageFetch ?? nodeRemoteFetch, organizerKind, ai,
        ),
        sendSurfaceMaxTotalBytes: HOST_SEND_MAX_TOTAL_BYTES,
      },
      hello: {
        flavor: "desktop-host",
        // No setup ceremony exists on this door: the world was created at first boot, and a
        // device becomes a session through the pairing redeem, never through a setup page.
        needsSetup: false,
        auth: { password: false, totp: false, webauthn: false, publicSignup: false },
        features: {
          sse: false, staging: false, ai: ai.drafter() !== undefined, pairing: true,
          // Same composition, same armed egress as the window's own door above.
          remoteImages: true,
        },
      },
    });

    /* The stored login — what makes a restart survivable. The division of labour across the
       host boundary: the SHELL holds one per-install key in the OS keystore and passes it at
       spawn; the DATABASE holds the mailbox password, envelope-encrypted under that key; the
       environment carries the password EXACTLY ONCE, on the launch the user types it. One key
       per install scales to any number of mailboxes; one keystore item per mailbox would be a
       second credential-at-rest design competing with the hosted envelope. The key wraps
       `mailbox_credentials` and nothing else: losing it costs the stored password, not the
       mail — the mailbox on the user's own server is the master, so a lost key is a password
       prompt, and deleting the data directory plus the keystore item is a clean uninstall that
       leaves every folder and message where it physically sits. */

    /**
     * An outgoing server is not a reason to stop receiving. This door proves both transports before storing anything,
     * and `MailboxService` refuses the whole write when either dial is refused — right on the hosted door, backwards
     * here: a mailbox whose incoming server works could not be connected because its outgoing one was blocked or
     * guessed wrong, and "Test connection" only ever proved IMAP. So a refusal whose transport is `smtp` is not
     * fatal: the call is made again with the submission block dropped and `smtpUnsettled` carrying the probe's reason
     * — the incoming credential is stored and organizes, no `smtp` row is written (an unproven submission credential
     * is exactly what this service refuses to store), the send path refuses with that reason instead of guessing
     * `imap host:587`, and an ordinary credential patch settles it. Only `smtp`: an IMAP refusal stays fatal.
     */
    const SMTP_ONLY_RETRY = "the submission server was refused; the mailbox keeps its incoming "
      + "credential and sending is recorded as unsettled";

    /** The refusal's own reason when it is an SMTP probe refusal, else `null`. */
    const smtpRefusalReason = (err: unknown): string | null => {
      const e = err as { code?: string; details?: { reason?: unknown; transport?: unknown } };
      if (e?.code !== "mailbox_probe_failed") return null;
      if (e.details?.transport !== "smtp") return null;
      return typeof e.details.reason === "string" && e.details.reason !== ""
        ? e.details.reason
        : "unknown";
    };

    /**
     * Run a credential write; on an SMTP-only refusal, run it again without the submission block.
     *
     * The body is rebuilt rather than mutated: `create` and `update` both read it more than once
     * and a caller's object is not this function's to change.
     */
    const keepingIncoming = async <T>(
      body: Record<string, unknown>,
      run: (b: Record<string, unknown>) => Promise<T>,
    ): Promise<T> => {
      try {
        return await run(body);
      } catch (err) {
        const reason = smtpRefusalReason(err);
        if (reason === null) throw err;
        log("local_mailbox_smtp_unsettled", { verdict: reason, reason: SMTP_ONLY_RETRY });
        const imap = (body.imap ?? {}) as Record<string, unknown>;
        const { smtp: _dropped, ...rest } = body;
        return await run({ ...rest, imap: { ...imap, smtpUnsettled: reason } });
      }
    };

    /**
     * Is this row the mailbox the settings file describes — the seed, by ADDRESS. As
     * `row.id === world.mailboxId` it conflated two questions, since `world.mailboxId` falls
     * back to the oldest live row when the seed address has no row. `isSeed` gates four
     * configuration facts; handed to a row the settings file never heard of, the survivor of a
     * seed removal got the REMOVED mailbox's host and user, `credentialIsForeign` answered
     * `foreign-host`, and a mailbox organizing five seconds earlier came back dialling nothing.
     * By address, no row is the seed after its removal; the boot's question only (the route
     * sites pass `false`). The walk meant to catch this shared one hostname; no longer.
     */
    const seedAddress = (config.address ?? config.imap.auth.user ?? "").trim().toLowerCase();
    const isSeedRow = (address: string): boolean =>
      seedAddress !== "" && address.trim().toLowerCase() === seedAddress;

    const attachLocal = async (mb: LocalRosterRow, isSeed: boolean): Promise<LocalMailboxRuntime> => {
      /**
       * What this mailbox dials. `config.imap` — the `OHMAIL_IMAP_*` the shell set — is now the SEED's only,
       * and only until that mailbox's credential records what a probe proved; every other mailbox dials from
       * its own `imap` credential row's `meta`, where the hosted worker has always read it. One process-wide
       * server for N mailboxes is wrong in a way nothing surfaces: mailbox two dialled at mailbox one's host
       * with mailbox two's password is a login failure if you are lucky, and a successful login to the WRONG
       * ACCOUNT if they share a provider. The seed's fallback is narrow: on first launch it has no credential
       * row yet, and once its row exists the fallback is unreachable. A non-seed row with no credential is a
       * mailbox awaiting a password — it dials nothing and serves the mirror.
       */
      const dialRow = (await db
        .select({ meta: mailboxCredentials.meta })
        .from(mailboxCredentials)
        .where(and(
          eq(mailboxCredentials.mailboxId, mb.id),
          eq(mailboxCredentials.transport, "imap"),
        ))
        .limit(1))[0];
      const dialMeta = (dialRow?.meta ?? null) as
        (CredMetaAuth & { host?: string; port?: number; secure?: boolean; insecureConsent?: boolean }) | null;
      /* The seed dials what it was configured for — the boot contract. As
       * `isSeed && !dialMeta?.host`, a seed whose credential recorded a host dialled the
       * credential's host and ignored the configuration — which silently disables the incoming
       * boot contract: `credentialIsForeign(row.meta, mbImap.host)` with both sides from one
       * row compares the credential against itself and can never disagree, so a launch pointed
       * at a new server would go on dialling the old one for ever, with the password. The
       * seed's dial is the configuration the shell set, keeping the comparison real; mailboxes
       * #2..N have no configured server to disagree with — their row is the only statement of
       * where they live, so the same predicate correctly never withholds. */
      const mbImap: SidecarImapConfig = isSeed
        ? config.imap
        : {
            host: dialMeta?.host ?? "",
            port: dialMeta?.port ?? 993,
            secure: dialMeta?.secure ?? true,
            ...(dialMeta?.insecureConsent === true ? { allowInsecure: true } : {}),
            auth: { user: dialMeta?.user ?? mb.address },
            /* NO `smtp` BLOCK. Submission coordinates are the send path's to resolve from this
               mailbox's own `smtp` credential row (`makeSendAdapter`), and a copy here would be a
               second source for them — the exact split that sent mailbox two's mail through
               mailbox one's server. The receive side has no use for them. */
          };

      /** The `(mailbox, imap)` credential row, or null when the user has not supplied one yet. */
      const storedLogin = async (): Promise<{ secretEnc: string; keyVersion: number; meta: unknown } | null> => {
        const rows = await db
          .select({ secretEnc: mailboxCredentials.secretEnc, keyVersion: mailboxCredentials.keyVersion, meta: mailboxCredentials.meta })
          .from(mailboxCredentials)
          .where(and(
            eq(mailboxCredentials.mailboxId, mb.id),
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
        /**
         * The delete and its proof are one transaction, and the proof is a read. This issued the DELETE, logged
         * `stored_login_cleared` and answered 200 without asking whether the row was gone — a delete that removed
         * nothing read the same from outside, and the shell, seeing 2xx, removed `config.json` with its refusal arm
         * never reached. So the row is deleted and read back in one transaction; a surviving row makes this THROW.
         * `FOR UPDATE` serializes a competing credential write and does not stop it COMMITTING immediately after —
         * a `PATCH` that dialled before this ran re-inserts the sealed password after the 200. That is what the
         * `signed_out_at` stamp below closes: every writer that seals a secret re-reads it under the mailbox's own
         * row lock and refuses when it moved (`packages/services/src/signed-out-fence.ts`).
         */
        const had = await db.transaction(async (tx) => {
          const before = await dialect(tx).forUpdate(
            tx.select({ mailboxId: mailboxCredentials.mailboxId }).from(mailboxCredentials)
              .where(and(
                eq(mailboxCredentials.mailboxId, mb.id),
                eq(mailboxCredentials.transport, "imap"),
              )));
          await tx.delete(mailboxCredentials).where(and(
            eq(mailboxCredentials.mailboxId, mb.id),
            eq(mailboxCredentials.transport, "imap"),
          ));
          /* AND THE DURABLE STAMP, in the same transaction as the delete. Every writer that seals
             a secret re-reads this column under the mailbox's row lock and refuses when it has
             moved, which is what closes the writer this transaction can serialize but not stop
             committing right after it — the shared `PATCH /mailboxes/:id` a paired phone sends.
             The epoch below is the same rule for this process; the column is the rule on disk. */
          await tx.update(mailboxes).set({ signedOutAt: now() })
            .where(eq(mailboxes.id, mb.id));
          const after = await tx.select({ mailboxId: mailboxCredentials.mailboxId }).from(mailboxCredentials)
            .where(and(
              eq(mailboxCredentials.mailboxId, mb.id),
              eq(mailboxCredentials.transport, "imap"),
            ));
          if (after.length > 0) {
            throw new ServiceError(
              "stored_login_not_cleared", 500,
              "the stored mailbox password is still on this install — the delete did not take. " +
                "You have not been signed out.",
            );
          }
          return before.length > 0;
        });
        /* THE CREDENTIAL IS GONE, so a refusal recorded against the old one is stale evidence.
           This path does NOT detach the runtime, which is why the flag needs clearing here rather
           than by construction — see `signInRefused`. */
        clearSignInRefusal("the stored password was forgotten");
        /**
         * AND THE EPOCH MOVES, so nothing in flight writes this password back and no dial opens a
         * login on the copy in memory. Here rather than only in the sign-out route because the
         * refused-launch path (`mobile.ts`) discards a seal without signing out and leaves the
         * same fact. After the row is proven gone: bumping over a clear that THREW would leave an
         * install refusing to dial a credential it still holds.
         */
        fence.bump();
        await closeDialAfterSignOut();
        log("stored_login_cleared", {
          mailboxId: mb.id,
          state: had ? "removed" : "absent",
          reason: "the sealed mailbox password was removed from this install and read back as " +
            "absent; the mirror and the mailbox on the user's own server are untouched",
        });
        return had;
      };

      /**
       * The password this launch will use, and what the shell should be told. The store wins over the
       * environment (the hosted worker's rule: a variable seeds once, never overwrites). The boot contract —
       * one comparison closing both reachable mismatches: the boot (`start()` resolves once; `login.state !==
       * "ready"` stops the dial — the state a crash between the door's seal and `engine_configure` leaves)
       * and the send (`openLocalSend` resolves afresh per send). Before the decrypt: the comparison needs no
       * key, so a foreign credential never becomes plaintext, and foreign outranks `unreadable` — the fact
       * the person can act on. No environment fallback: `pass` is `null`. `smtpHost` is opt-in — only
       * `openLocalSend` passes it; a moved outgoing server must not stop mail.
       */
      const resolveLogin = async (
        opts?: { smtpHost?: string },
      ): Promise<{
        state: CredentialState;
        pass: string | null;
        foreign?: "incoming" | "outgoing" | "outgoing-none";
      }> => {
        /* THE SEED'S, AND ONLY THE SEED'S. The process environment describes one mailbox, so a
           password in it is a fact about that one. Offering it as a fallback for mailbox two
           would authenticate to mailbox two's server with mailbox one's secret. */
        const envPass = isSeed ? config.imap.auth.pass : undefined;
        const row = await storedLogin();
        if (!row) return envPass ? { state: "ready", pass: envPass } : { state: "absent", pass: null };
        /**
         * Which comparison failed rides out with the state — load-bearing, not convenience.
         * `foreign-host` is one state with two causes, and the send path has to say which in
         * words a person can act on: told the OUTGOING server is wrong when the incoming one
         * moved, they would change a setting that was already right, and following the
         * instruction cannot recover the install. A true sentence about the wrong server is the
         * exact failure this seam exists to end. The shell is not given this: it renders the
         * state, whose meaning there is the boot's — see {@link CredentialState}.
         */
        /* THIS MAILBOX'S configured host, not the process's. With one mailbox those were the
           same string; with several, comparing mailbox two's stored credential against mailbox
           one's host answers a question about the wrong pair of servers — and answers it
           WRONGLY in the direction that withholds a working password. */
        if (credentialIsForeign(row.meta, mbImap.host)) {
          return { state: "foreign-host", pass: null, foreign: "incoming" };
        }
        // Before the decrypt for the same reason the line above is: a credential this engine has no
        // business offering to this server is never brought into memory as plaintext at all.
        // INCOMING FIRST, so the incoming fault wins when both disagree: it stops the whole launch,
        // and settling it is what makes the outgoing question meaningful.
        if (opts !== undefined && credentialIsForeignSmtp(row.meta, opts.smtpHost)) {
          /**
           * TWO OUTGOING CAUSES, NOT ONE, and the split is not a refinement — it decides what the
           * person is told to do. The credential can disagree because it names a DIFFERENT server,
           * or because it names NONE — and those have different recoveries. "Point the outgoing
           * server back" is an instruction with no referent for the second: there was never a
           * previous submission server to return to, and the only way out is to save the password
           * for the one that is now configured. Telling somebody to restore a setting that never
           * existed is the same true-sentence-about-the-wrong-thing this whole seam exists to end.
           */
          return {
            state: "foreign-host",
            pass: null,
            foreign: sealedSmtpHost(row.meta) === "" ? "outgoing-none" : "outgoing",
          };
        }
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
       * FIRST RUN: seal the password the user just typed, so no later launch needs it.
       *
       * Skipped without a durable key — the whole point of the refusal above — and skipped when a
       * row already exists, which is what keeps this idempotent across every relaunch. It is NOT
       * the recovery path: a row that exists and cannot be read is left exactly as it is, and
       * re-entry through `PATCH /mailboxes/:id` is what replaces it. Overwriting here would mean a
       * launch script with a stale password could silently reseal a credential the user had
       * already corrected.
       */
      // See the note in `resolveLogin`: the environment's password belongs to the seed.
      const envPass = isSeed ? config.imap.auth.pass : undefined;
      /* THE SIGN-OUT FENCE, over the launch's own seal. This is a credential write like the door's
         — it just runs at boot rather than at a press — and the encrypt above it is an await a
         sign-out can land inside, which would seal a password the person had just asked to be
         gone. Discarded rather than merely refused: the insert may already have committed. */
      if (durableKey && envPass && !(await storedLogin())) {
        const bootSeal = fence.begin();
        /* AND THE DURABLE STAMP, read BEFORE the encrypt — the await a sign-out lands inside. The
           insert runs in a transaction that re-reads it under this mailbox's row lock, so a
           password a sign-out overtook is never WRITTEN rather than written and removed again. A
           launch that starts AFTER a sign-out reads the same value it commits against and is
           admitted: signing out does not stop somebody signing back in. */
        const sealOrigin: CredentialOrigin = {
          row: "already-there", signedOutAt: await signedOutAtOf(mb.id),
        };
        try {
          const sealed = await keyProvider.encrypt(envPass);
          await db.transaction(async (tx) => {
            await fenceSignedOutMailbox(tx as unknown as Tx, dialect(db), mb.id, sealOrigin);
            /* AND THE ERASURE FENCE, on the row the sign-out fence just took, so it costs no
               lock. A removal leaves the `mailboxes` row as its tombstone, so this row's key to
               it refuses the ACCOUNT sweep and nothing else: without this, a relaunch reseals
               the passwords of a mailbox somebody erased. */
            await fenceErasedMailbox(tx as unknown as Tx, dialect(db), mb.id);
            await tx.insert(mailboxCredentials).values({
              mailboxId: mb.id,
              transport: "imap",
              secretEnc: sealed.ciphertext,
              keyVersion: sealed.keyVersion,
              // The same non-secret shape the hosted worker writes, so one row shape serves both.
              meta: {
                host: mbImap.host, port: mbImap.port,
                secure: mbImap.secure, user: mbImap.auth.user,
                /**
                 * And the submission host this password is being sealed for — the outgoing half of the same record. One
                 * password covers both transports, and this is the only place that fact is written down. OMITTED, not
                 * empty, when this launch has no submission server configured — the one place that differs from the door,
                 * deliberately: an empty value states "no outgoing server is authorized", which the door can say because
                 * a door submit is a complete statement the person can make again. This seal is a bootstrap from an
                 * environment (the self-hosted path), where an operator may add the outgoing variable later with no door
                 * to re-save through — "none authorized" would refuse every later send with no recovery surface. Absent
                 * means "this row says nothing", the tolerance every older credential relies on.
                 */
                ...(isSeed && config.imap.smtp?.host ? { smtpHost: config.imap.smtp.host } : {}),
              },
              updatedAt: now(),
            });
          });
          if (bootSeal.stale()) {
            await discardCredentialsFor(mb.id);
            log("stored_login_seal_discarded", {
              mailboxId: mb.id,
              reason: "this install signed out while the launch was sealing its password, so the "
                + "row it had just written was removed again and nothing dials on it",
            });
          } else {
            log("stored_login_sealed", {
              mailboxId: mb.id,
              reason: "the mailbox password was encrypted into the local store under this install's " +
                "key; later launches read it back and need no password in the environment",
            });
          }
        } catch (err) {
          /* THE FENCE'S OWN REFUSAL IS NOT A FAILED LAUNCH — nothing was written, so there is
             nothing to undo and the mailbox comes up with no stored password, which is what
             signing out asked for. The ERASURE fence's refusal is the same answer for the same
             reason and is named FIRST, ahead of the code test: a class that fell through to the
             `throw` would stop the whole attach — every other mailbox with it — over one mailbox
             somebody removed. Any other fault still stops it. */
          if (err instanceof MailboxErasedError) {
            log("stored_login_seal_discarded", {
              mailboxId: mb.id,
              reason: "this mailbox was erased before the launch finished sealing its password, "
                + "so no password was stored and nothing dials on it",
            });
          } else if ((err as { code?: string }).code !== "signed_out") throw err;
          else log("stored_login_seal_discarded", {
            mailboxId: mb.id,
            reason: "this install had signed out of this mailbox before the launch finished "
              + "sealing its password, so no password was stored and nothing dials on it",
          });
        } finally {
          bootSeal.settle();
        }
      }

      // TWO LITERAL CALL SITES AND NOT ONE COMPUTED NAME. A guard over this package walks every
      // `log(...)` call and refuses an event name it cannot read statically, which is not pedantry:
      // a call site whose event is an expression is a call site whose FIELDS cannot be checked
      // either, and unchecked fields are how a secret reaches a log line. The guard caught this one
      // as a ternary while it was being written.
      /**
       * THE SIGN-OUT EPOCH THIS MAILBOX'S PASSWORD BELONGS TO, read before it is resolved. The
       * plaintext then lives in this closure and in `imapConfig.auth` for the life of the
       * attachment, so "the row is gone" is not the same fact as "nothing can dial with it" —
       * every dial re-reads the epoch and refuses when a sign-out has moved it.
       */
      const dialUnder = fence.generation();
      /** Whether a sign-out has happened since this mailbox resolved its password. */
      const signedOutSinceDial = (): boolean => fence.generation() !== dialUnder;
      /* `let`, and the one writer is {@link rereadCredential}. A launch that cannot open its
         stored password is an outage this install can come out of without a restart — the person
         re-enters it, the next poll's read opens the row, and this binding is what the dial then
         uses. Nothing else reassigns it. */
      let login = await resolveLogin();
      if (login.state === "absent") {
        log("stored_login_absent", {
          mailboxId: mb.id,
          state: login.state,
          reason: "no password is stored and none was supplied, so this install serves the mirror " +
            "it already has and waits for one",
        });
      } else if (login.state === "unreadable") {
        log("stored_login_unavailable", {
          mailboxId: mb.id,
          state: login.state,
          reason: "a stored password exists and this install's key does not open it; the mirror is " +
            "intact and re-entering the password re-seals it. The mailbox on the server is " +
            "untouched, and deleting the data directory re-syncs it from scratch",
        });
      } else if (login.state === "foreign-host") {
        // NEITHER HOST IS NAMED, and that is the same rule the two lines above obey. Which mail
        // server a person's mailbox is on is the identifying signal this package's census keeps off
        // a log line, and the pair of them is more identifying than either. `mailboxId` is what
        // correlates this with everything else in the launch; the hosts are on screen, where the
        // person who can act on them already is.
        log("stored_login_foreign_host", {
          mailboxId: mb.id,
          state: login.state,
          reason: "the stored password was proved against a different server than this launch is " +
            "configured for, so it was withheld and nothing was dialled. The mirror is intact and " +
            "the mailbox on the server is untouched; finishing or undoing the change of server " +
            "resolves it",
        });
      }

      /**
       * The adapter is built with whatever password this launch resolved, and `start()` refuses to
       * connect when there is none. "Takes effect on the next launch" is retired: that justification
       * (reconfiguring the local door replaces the engine) covers the SEED and nothing else — a mailbox
       * added from Settings gets no engine replacement, so a person fixing its password watched it stay
       * broken until they quit the app, with the form having said saved. The credentials stay immutable
       * underneath a running sync loop: `PATCH /local/mailboxes/:id` DETACHES the runtime and attaches
       * a fresh one, so the new password takes effect through a new connection — the same guarantee,
       * without making a connected socket's credentials mutable.
       */
      const imapConfig: ImapConfig = {
        ...mbImap,
        auth: { user: mbImap.auth.user, pass: login.pass ?? "" },
        /* HERE AND NOT AT THE `new ImapAdapter`, for two reasons. The adapter reads its deadlines
           off the CONFIG (`imapFlowOptions`), not off its options bag; and this config is what
           every dial of this mailbox is built from — the seed's and mailboxes #2..N's alike — so
           a value set at the one construction site would have missed an injected factory and any
           later caller. MERGED rather than assigned, so a caller that configured its own
           deadlines keeps them, and an explicitly-undefined key cannot clobber ours the way a
           plain spread order would. See {@link SIDECAR_NET_TIMEOUTS}. */
        timeouts: { ...SIDECAR_NET_TIMEOUTS, ...(mbImap.timeouts ?? {}) },
      };
      /* THIS MAILBOX'S REQUEST KEY, from the credential on the line above — the one the socket is
       * opened with. Deriving it anywhere else is how it comes to disagree with the other installs
       * that share this mailbox; see the note where the old process-wide helper used to be. `null`
       * when there is no password to derive from (an OAuth mailbox, or a login not yet resolved),
       * which is the honest degraded mode: no key means the claim advertises no `requests` and a
       * reader is refused at the door with the holder named. */
      let requestKey: string | null = null;
      /**
       * THE PASSWORD THIS MAILBOX DIALS WITH, AND THE KEY DERIVED FROM IT — one writer for both.
       *
       * The request key is HKDF over that password, so the two cannot move apart: left behind, it
       * stays `null` and every request record a reader wrote refuses as a forgery, with the log
       * naming an attack. A second derivation site would be a second chance to move one alone —
       * so the launch and the later read that opens the row both come through here, and
       * `request-key-agreement.test.ts`'s one-site census holds by construction.
       */
      const useDialledPassword = (pass: string): void => {
        imapConfig.auth = { user: mbImap.auth.user, pass };
        requestKey = deriveRequestKey({ auth: imapConfig.auth, address: mb.address });
      };
      useDialledPassword(login.pass ?? "");

      // The connection's own state — the fact the engine used to have no way to hold. A desktop
      // process outlives its sockets: a lid closed past the provider's idle timeout, a Wi-Fi
      // change, a VPN flap or a server `BYE` ends the connection while the timer, the serial
      // queue, the store and the roster entry carry on. With nowhere to write that down, the
      // poll fired into a dead socket and the accessors answered `organizing: true` while
      // nothing was filed and the claim in `ohmail/_meta` aged out. `null` is "the connection
      // is believed good"; a Date is the FIRST moment it was observed dead — first, not latest,
      // so the Settings row can say how long and a failing re-dial does not reset the clock.
      let connectionDeadSince: Date | null = null;
      /**
       * When this mailbox first stopped being served — the clock a PERSON is shown. Split from
       * {@link connectionDeadSince} deliberately: "the socket is open again" is a fact about the
       * socket, "this mailbox is being organized again" is a fact about the lease, and a re-dial
       * whose gate could not read `ohmail/_meta` has established the first and not the second.
       * Folded into one field, a re-dial that reached a live server with an unreadable lease
       * cleared the outage and reported the mailbox healthy while nothing was filed. So the
       * socket field drives the re-dial and this one drives the Settings row, clearing only when
       * a cycle has actually been served.
       */
      let outageSince: Date | null = null;
      /**
       * WHICH OBSERVATION MARKED IT DEAD, and they are worth telling apart in a log because they
       * are not equally fast and they are not about the same thing: the adapter's own
       * `close`/`error` event (seconds), the duration bound over failing cycles (the arm that
       * works for a connection whose death produced no event at all), the NOOP heartbeat, and
       * `credential` — no socket was ever opened, because the stored password could not be used.
       * The last one names the launch rather than a connection, and saying `event` there would
       * tell a reader a socket reported its own death when none was dialled.
       */
      let connectionDeadBy: "event" | "bound" | "heartbeat" | "credential" | null = null;
      /**
       * Whether this runtime has already reported that its connection cannot be probed — once per
       * attachment, since it is a property of the adapter. An adapter with no
       * {@link MailboxAdapter.noop} is not a failing connection, and the skip has to be legible or
       * "no heartbeat lines" reads as "the link never went quiet".
       */
      let heartbeatUnaskable = false;
      /**
       * The server answered and refused the sign-in — different from unreachable, and the difference decides
       * what we do and what the person is told. Unreachable is retried; a refused sign-in will not fix
       * itself, and retrying it every poll produced four LOGIN attempts a minute — which providers throttle
       * and some answer by locking the account, the app turning a wrong password into a lost mailbox. So this
       * suspends the automatic re-dial. It clears EXPLICITLY via {@link clearSignInRefusal}, which every
       * credential path calls: "every path detaches the runtime" is true only of `PATCH` for a non-seed
       * mailbox — the seal route excludes the seed and `forgetStoredLogin` never detaches, and on those paths
       * the flag would have survived the very act that fixes it.
       */
      let signInRefused = false;
      /**
       * THE STORED PASSWORD THIS LAUNCH COULD NOT DIAL WITH — see {@link CredentialBlock}.
       *
       * Its own field and not a second meaning for `signInRefused`: nothing answered this launch,
       * so the sentence about a server refusing a sign-in would be true of nothing that happened.
       * Set from `start()`'s non-ready arm, which used to return in silence — `outageSince` stayed
       * null over a mailbox that was not syncing, and Settings said "Up to date". Cleared only by
       * a fresh read that opens the row; the credential itself is never discarded here.
       */
      let credentialBlock: CredentialBlock | null = null;
      /**
       * THIS RUNTIME NEVER DIALLED, BECAUSE IT HAD NO PASSWORD — see
       * {@link MailboxConnectionState.needsCredential}.
       *
       * Not {@link credentialBlock}, which is about a stored row that could not be OPENED: here
       * nothing is stored and there is nothing to open. Not an outage either — no clock is
       * armed and nothing is retried, because with no password there is nothing to retry and
       * dialling an empty one is how a provider locks an account. One writer sets it (`start()`'s
       * two no-password arms) and one clears it (a later read that opens the row).
       */
      let needsCredential = false;
      /**
       * WHAT THIS MAILBOX'S FIRST SYNC HAS PRODUCED — the third answer the connection record
       * carries, derived from the drain's own stamps and the mirror's own rows. See
       * {@link createFirstSyncTracker}: nothing here can set it, which is the point.
       */
      const firstSync = createFirstSyncTracker(log, mb.id);
      /**
       * A CREDENTIAL CHANGED, so the refusal is no longer evidence about anything.
       *
       * The next poll dials again on its own; nothing here needs to force one. Also resets the
       * backoff, because a new password is a new question and it should be asked promptly rather
       * than at the end of whatever wait the old one had earned.
       */
      const clearSignInRefusal = (why: string): void => {
        if (!signInRefused && redialAttempts === 0) return;
        signInRefused = false;
        redialAttempts = 0;
        redialNotBefore = 0;
        /* …and the manual floor with them, for this method's own stated reason: a new password
           is a new question, and it should be asked promptly rather than at the end of a wait
           the old one earned. */
        forcedNotBefore = 0;
        log("mailbox_sign_in_retry_armed", {
          mailboxId: mb.id,
          reason: `${why}; the stored refusal is discarded and the next poll dials again`,
        });
      };
      /** Backoff for the failures that MAY pass. Attempts since the last successful dial. */
      let redialAttempts = 0;
      /** Wall-clock instant before which no re-dial is attempted. */
      let redialNotBefore = 0;
      /**
       * Wall-clock instant before which a press is not honoured — a floor under the one path
       * allowed to skip the ladder. A forced dial skips {@link redialNotBefore} and a fast failure
       * settles in under a second, so without this a second press dials again and repeated presses
       * defeat the 15 s–5 min ladder against a server already refusing. A press is worth ONE
       * attempt per base step: after a forced dial fails this is set to `now + reconnect.ladderMs[0]`
       * and `force` is refused until it passes (the press still answers 202); a successful dial
       * clears it. Kept separate from `redialNotBefore` — that widens to five minutes; folding them
       * would give a press the long wait back or let it reset the ladder.
       */
      let forcedNotBefore = 0;

      /**
       * Which connection this mailbox is on — a counter, bumped by every dial. The identity a
       * pass needs is not "the adapter object" (a binding can be swapped under an `await`) and
       * not "is it open" (it can be open and be the WRONG one) — it is WHICH dial. Two things
       * key on it: a death report names the generation it came from, so a late `error` from a
       * replaced connection cannot mark its healthy replacement dead; and a drain names the
       * generation it read the lease under, refusing to keep running if that stops being current
       * — see {@link ConnectionReplacedError}.
       */
      let generation = 0;

      /**
       * REFUSE TO CONTINUE A PASS WHOSE CONNECTION HAS BEEN REPLACED.
       *
       * Called before every step that WRITES to the mailbox on the strength of a lease read:
       * `ensureFolders`, the cycles that move mail, and the scheduled-send pass. Reading is not
       * gated by it — a mirror growing over a fresh connection harms nobody.
       */
      const assertSameConnection = (gen: number, conn: MailboxAdapter): void => {
        /* BOTH, and the instance is not belt-and-braces. The generation says "a re-dial has
           happened since"; the instance says "the object I am about to write through is the one
           whose lease I read". They can disagree in one direction that matters: a helper handed a
           captured adapter can outlive the binding, and a number alone would not notice. Checking
           the pair makes the guard a statement about the CONNECTION rather than about a counter. */
        if (gen !== generation || conn !== adapter) throw new ConnectionReplacedError(gen, generation);
      };

      /**
       * ONE STEP UP THE RE-DIAL LADDER — the ONE writer of the automatic wait.
       *
       * Extracted rather than written twice: a launch that cannot READ its password retries the
       * READ on this same schedule, and a second copy of the jitter would be a second cadence
       * nobody keeps in step with the first. Jittered so several mailboxes on one server do not
       * knock in unison after an outage.
       */
      const climbTheLadder = (): void => {
        redialAttempts += 1;
        const step = redialStepMs(reconnect, redialAttempts);
        redialNotBefore = Date.now() + Math.round(step * (0.8 + Math.random() * 0.4));
      };

      /**
       * THE STORED PASSWORD COULD NOT BE USED, AND THAT IS AN OUTAGE — see {@link credentialBlock}.
       *
       * `start()` used to return here in silence: nothing dialled, no detector fired,
       * `outageSince` stayed null and the connections route answered `reachable: true`, so
       * Settings said "Up to date" over a mailbox that had stopped syncing. The clocks are the
       * SAME two an unreachable server sets — `connectionDeadSince` is what arms the retry,
       * `outageSince` is what a person is shown — and the schedule is the same ladder, because a
       * password that opens on the next read is a mailbox that heals without a restart.
       */
      const noteLoginUnusable = (state: CredentialBlock["state"]): void => {
        if (stopped) return;
        credentialBlock = { state, confirmed: false };
        if (connectionDeadSince === null) {
          connectionDeadSince = now();
          connectionDeadBy = "credential";
        }
        outageSince ??= connectionDeadSince;
        log("mailbox_login_unavailable", {
          mailboxId: mb.id,
          state,
          verdict: "first-read",
          reason: "this launch holds a stored password it could not dial with, so nothing was " +
            "connected and this mailbox is not syncing. The row is untouched and is NOT thrown " +
            "away; the next poll reads it again, and re-entering the password re-seals it",
        });
      };

      /**
       * READ THE STORED PASSWORD AGAIN, AND USE IT IF IT OPENS. Answers whether it did.
       *
       * No network and no login attempt: a mailbox with no usable password is waiting for a
       * person, and dialling one repeatedly is how a wrong password becomes a locked account. On
       * a read that opens, the connection config and the derived request key move TOGETHER —
       * that key is HKDF over the password this mailbox dials with, so leaving it behind would
       * make every request record refuse as a forgery. A failing read CONFIRMS the block: the
       * advice a person is shown waits for a second, independent reading of the same fact.
       */
      const rereadCredential = async (): Promise<boolean> => {
        const fresh = await resolveLogin();
        if (fresh.state === "ready" && fresh.pass) {
          login = fresh;
          useDialledPassword(fresh.pass);
          credentialBlock = null;
          /* AND THE STATE THE LAUNCH ENTERED WITH NO PASSWORD — this read is the thing that ends
             it: a password is stored and this mailbox dials with it from here. */
          needsCredential = false;
          log("mailbox_login_restored", {
            mailboxId: mb.id,
            state: fresh.state,
            attempt: redialAttempts,
            reason: "the stored password opened on a later read, so this mailbox dials with it " +
              "now rather than at the next launch",
          });
          return true;
        }
        /* A ROW THAT IS GONE IS NOT A BLOCK. Somebody signed out: nothing is stored, the shell
           shows a password field, and claiming an unreadable credential would be a sentence about
           a row that does not exist. The outage clocks are left as any sign-out mid-outage leaves
           them — `noteCycleServed` is the one writer that clears them. */
        if (fresh.state === "absent" || fresh.state === "ready") {
          credentialBlock = null;
          return false;
        }
        credentialBlock = { state: fresh.state, confirmed: true };
        log("mailbox_login_unavailable", {
          mailboxId: mb.id,
          state: fresh.state,
          verdict: "confirmed",
          attempt: redialAttempts,
          reason: "a second, fresh read of the stored password answered the same way, so this is " +
            "not a store that was briefly unready and the person is told to sign in again. " +
            "Nothing was deleted: re-entering the password re-seals the row under this key",
        });
        return false;
      };

      /**
       * BUILD ONE DIAL. Called once at attach and again for every re-dial, because an
       * `ImapAdapter` that has been closed is not the thing to re-open — the worker's re-attach
       * builds a fresh one for the same reason, and a fresh instance is the only shape in which
       * "the factory was called a second time" is observable from outside.
       *
       * The callback closes over BOTH the generation and the adapter INSTANCE it belongs to. The
       * instance is what gets closed (never the mutable binding, which a re-dial may already have
       * moved on) and the generation is what decides whether this death is still news.
       */
      const dialAdapter = (): MailboxAdapter => {
        const gen = ++generation;
        let self: MailboxAdapter | null = null;
        const ctx: AdapterDialContext = {
          onConnectionError: (err) => noteConnectionDead(err, gen, self),
        };
        self = config.adapterFactory
          ? config.adapterFactory(imapConfig, ctx)
          : new ImapAdapter(imapConfig, { onConnectionError: ctx.onConnectionError });
        return self;
      };

      /**
       * The connection died between calls — the callback `guardAsyncErrors` had nobody to call.
       * Called from an EventEmitter handler, so it does the smallest synchronous work and puts
       * the rest on the serial queue; it must not throw (a handler raising inside an `error`
       * listener is the uncaught exception the listener exists to prevent). First observation
       * wins: imapflow's `_socketClose` can produce `error` then `close`, and the runtime reads
       * "how long has this been dead" — a second event must not restart the clock. It does not
       * re-dial: that would race the cycle running over the adapter it is about to replace; the
       * poll tick owns the re-dial, on the serial queue.
       */
      const noteConnectionDead = (err: unknown, gen: number, who: MailboxAdapter | null): void => {
        if (stopped) return;
        /* ── A DEATH FROM A CONNECTION WE HAVE ALREADY REPLACED IS NOT NEWS ──────────────────
         *
         * The real adapter's `error` listener is UNCONDITIONAL — only its `close` listener is
         * guarded by `closing`/`established` (`imap.ts`, `guardAsyncErrors`) — so a connection we
         * deliberately closed during a re-dial can still emit `error` afterwards, from a socket
         * whose replacement is already up and gated. Without this check that late report marks
         * the HEALTHY connection dead, and the next drain re-dials a connection that never
         * failed. Keyed on the generation rather than on `who === adapter`, because the binding
         * is exactly the thing that moves. */
        if (gen !== generation) {
          log("mailbox_connection_stale_report", {
            err, mailboxId: mb.id,
            detectedBy: "event",
            reason: "a connection this install has already replaced reported its own death; the " +
              "live connection is a later one and is untouched. Nothing is wrong — a socket we " +
              "closed on purpose is entitled to say so afterwards",
          });
          return;
        }
        const ended = err instanceof ImapConnectionClosedError;
        /* The line counts deaths, which is why it is inside the first-observation guard. One
         * dead socket reaches here twice (imapflow emits `error` then `close` in the same tick,
         * both forwarded, both carrying the same generation — and both correct to arrive: the
         * second covers a clean `BYE` that emits no `error`). The state was always idempotent;
         * the log call used to sit outside this block, so the line doubled — measured on the
         * Windows guest, two `mailbox_connection_unavailable` lines one millisecond apart for
         * one cut cable, making the line count imapflow's arrival paths rather than outages.
         * The second arrival is silent; the close below stays keyed to the reporting
         * connection, not the death.
         */
        if (connectionDeadSince === null) {
          connectionDeadSince = now();
          connectionDeadBy = "event";
          log("mailbox_connection_unavailable", {
            err, mailboxId: mb.id,
            detectedBy: "event",
            reason: ended
              ? "the mail server connection ENDED and this process is still running, so nothing " +
                "would have re-opened it; the next poll re-dials and re-reads the organizer lease " +
                "before it moves anything"
              : "the mail server connection reported an error and this process is still running; " +
                "the next poll re-dials and re-reads the organizer lease before it moves anything",
          });
        }
        /* OUTSIDE the guard, and it is not the same question. `connectionDeadSince` clears on a
           re-dial that reached a live server; `outageSince` clears only when a cycle is actually
           SERVED (`noteCycleServed`), so the two can be in states where a later death has to
           re-arm the person's clock while the death itself is not news. */
        outageSince ??= connectionDeadSince;
        // CLOSED ON THE QUEUE, never inline: a cycle may be mid-batch over this very adapter, and
        // closing it under one is how a drain re-reads mail it already had. `detach()` and the
        // re-dial take the same queue, so whichever runs first, the other sees a settled state.
        /* THE INSTANCE, NEVER THE BINDING. This used to read `await adapter.close()`, which is
           late-bound: by the time the queue reached it a re-dial could have installed a new
           adapter, and the close then retired the healthy replacement. Closing the object that
           reported its own death is correct whatever has happened since. */
        /* AND DESTROYED, NOT LOGGED OUT — the same correction as the re-dial's teardown, on the
           path beside it. A reported death does not mean the driver has closed: an `ETIMEOUT`
           from the socket deadline reaches here from a client that still believes it is usable,
           so `close()` issues a LOGOUT that queues behind the command already hung and never
           settles — holding THIS QUEUE with it, which `drainPass` and `detach()` both take. The
           re-dial runs outside the queue, so what that cost was not the dial: the mailbox
           re-connected, logged `mailbox_reconnected`, and then never served another cycle or
           finished a `stop()`. Destroying the socket is also what ends the hung command. */
        const dying = who;
        if (dying !== null) {
          void serialize(async () => {
            if (dying.forceClose !== undefined) {
              try { dying.forceClose(); } catch { /* the socket is going away regardless */ }
              return;
            }
            try { await dying.close(); } catch { /* the connection is already broken */ }
          }).catch(() => { /* `serialize` never rejects for the caller's sake; belt and braces */ });
        }
      };

      /**
       * THE DURATION BOUND'S TWO READINGS — both derived from cycles that actually ran.
       *
       * `since` is when the lease FIRST became unreadable in the current streak, `cycles` how
       * many consecutive drains have failed that way. Neither is configuration: a cycle that
       * serves clears both, so the state describes what this connection has been doing rather
       * than what somebody set.
       */
      let leaseUnavailableSince: number | null = null;
      let leaseUnavailableCycles = 0;

      /**
       * A DRAIN CAME BACK. The connection served, so the streak is over and so is any deadness
       * the bound had concluded from it.
       *
       * It does NOT clear a death the ADAPTER reported. An event-marked connection is one the
       * driver has told us is gone, and no amount of a drain returning zero cycles over it
       * changes that — a stopped runtime returns 0 without touching the socket at all. Only a
       * completed re-dial clears that one.
       */
      const noteCycleServed = (): void => {
        /* A STOPPED DRAIN NEITHER COUNTS NOR CLEARS. `drainPass` returns 0 at `stopped` without
           touching the socket, so treating that as "the connection served a cycle" let a
           `detach()` racing a sync erase a death the bound had correctly concluded. Nothing about
           a runtime that has been told to stop is evidence about its connection. */
        if (stopped) return;
        leaseUnavailableSince = null;
        leaseUnavailableCycles = 0;
        if (connectionDeadBy === "bound") {
          connectionDeadSince = null;
          connectionDeadBy = null;
        }
        /* THE PERSON'S CLOCK CLEARS HERE AND NOWHERE ELSE — a cycle was actually served. A
           re-dial that reached a live server does not clear it (the socket is not the mailbox);
           see {@link outageSince}. */
        outageSince = null;
      };

      /**
       * A DRAIN THREW. Only one class counts, and it is the one the wedge produced.
       *
       * `LeaseUnavailableError` is what a dead socket looks like from the gate: `mayOrganize`
       * reads `ohmail/_meta` before anything else happens, the read fails, and the class is the
       * by-class exemption every failure counter honours. Anything else that throws out of a
       * drain — a store fault, a classifier fault, a bug — says nothing about the CONNECTION,
       * and treating it as connection death would re-dial a healthy socket on every unrelated
       * defect.
       */
      const noteCycleFailed = (err: unknown): void => {
        if (stopped) return;                       // see `noteCycleServed`
        if (!isConnectionFailure(err)) return;
        leaseUnavailableSince ??= Date.now();
        leaseUnavailableCycles += 1;
        const unavailableMs = Date.now() - leaseUnavailableSince;
        const due = unavailableMs >= reconnect.deadAfterMs
          || leaseUnavailableCycles >= reconnect.deadAfterCycles;
        if (!due || connectionDeadSince !== null) return;
        connectionDeadSince = now();
        connectionDeadBy = "bound";
        outageSince ??= connectionDeadSince;
        log("mailbox_connection_unavailable", {
          err, mailboxId: mb.id,
          detectedBy: "bound",
          // WHICH lease operation failed, from the error and not from this call site — `op` is a
          // compile-time literal off a closed union, so it costs nothing and turns "the lease
          // could not be read" from one sentence into the four different faults it covers.
          // Only a lease failure has one; a reader's plain adapter error reaches here too now,
          // and answers `null` — the census refuses a spread, and rightly: a detail object whose
          // KEYS depend on a value is a line whose shape cannot be read off the call site.
          op: err instanceof LeaseUnavailableError ? err.op : null,
          reason: "the organizer lease has been unreadable for every cycle past the bound, and " +
            "no connection event said so — so the connection is treated as dead on the evidence " +
            "of the cycles themselves; the next drain re-dials and re-reads the lease before it " +
            "moves anything",
        });
      };

      /**
       * THE SERVER ANSWERED AND DECLINED THE READ — one line per SETTLED ATTEMPT.
       *
       * Not a connection line and deliberately not filed as one: `mailbox_connection_unavailable`
       * is what a person is shown "Connection lost" over, and this pass reached an answering
       * server on a standing login. `status` is our own two-member set read off the driver's
       * `responseStatus`; the server's own response text and `[…]` code are never carried — a
       * mailbox over quota must not be able to write its own words into a log line.
       */
      const noteFetchRefused = (err: unknown): void => {
        log("mailbox_fetch_unavailable", {
          err,
          mailboxId: mb.id,
          status: fetchRefusal(err),
          reason: "the mail server answered this pass's FETCH and refused it, so this mailbox's " +
            "mail could not be read; the connection and the sign-in both stand, the drain keeps " +
            "its login, and the next pass asks again",
        });
      };

      /**
       * The third detector: one NOOP per pass, for the death that emits nothing and fails no
       * cycle. On a half-open link the socket answers TCP, every command hangs, and the drain
       * parks inside its first command — `connectionDeadSince` stays null, the field every heal
       * keys on, until the socket deadline fires minutes later. It runs on the public entry
       * point, never inside `serialize`: queued behind a hanging drain it would wait for the
       * hang it exists to detect. A silent window stamps the clock and ends the connection with
       * `forceClose` (a LOGOUT queues behind the abandoned command). A refused NOOP counts as an
       * answer — the question is whether the server is talking at all.
       */
      const probeConnection = async (): Promise<void> => {
        /* A stopped runtime and a connection already known dead are both states in which asking
           changes nothing; the second is `redialIfDead`'s to act on. */
        if (stopped || connectionDeadSince !== null) return;
        const who = adapter;
        const gen = generation;
        const probe = who.noop?.bind(who);
        if (probe === undefined) {
          if (!heartbeatUnaskable) {
            heartbeatUnaskable = true;
            log("mailbox_heartbeat_unavailable", {
              mailboxId: mb.id,
              reason: "this connection cannot be asked to prove itself — the adapter implements " +
                "no NOOP — so a link that goes half-open is detected only when the socket " +
                "deadline fires, which is minutes rather than seconds. Not a failure: nothing " +
                "was asked, which is a different fact from nothing answering",
            });
          }
          return;
        }
        let settled: Promise<"answered">;
        try {
          // Settled, not resolved: an answer and a refusal are both the server talking.
          settled = probe().then(() => "answered" as const, () => "answered" as const);
        } catch {
          return;                       // a synchronous throw is a rejection; not this arm's news
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<"silent">((resolve) => {
          timer = setTimeout(() => resolve("silent"), heartbeatTimeoutMs);
          timer.unref?.();
        });
        const verdict = await Promise.race([settled, elapsed]);
        if (timer !== undefined) clearTimeout(timer);
        if (verdict === "answered") return;
        /* Re-checked after the await, generation included: this heartbeat was issued on ONE
           connection, and a re-dial or a `detach()` can land while it is outstanding. */
        if (stopped || gen !== generation || connectionDeadSince !== null) return;
        /* An unanswered probe is not yet a dead link: ask whether the server is talking.
         * imapflow writes one command at a time, so a NOOP issued during a legitimately long
         * FETCH still sits in the queue when its window elapses — force-closing there killed a
         * healthy connection and threw the cycle away, and the probe's window alone cannot tell
         * that from a half-open link. The server's own bytes can: a streaming FETCH is heard
         * from continuously, a half-open link not at all — so the window is charged only while
         * the connection is ALSO silent, and a long healthy command is never interrupted.
         * `null` is unknown and deliberately read as silence: an adapter that cannot say leaves
         * the window as the only evidence, and reading it the other way would disarm the detector.
         */
        const heardMs = who.lastServerActivityAt?.()?.getTime() ?? null;
        if (heardMs !== null && now().getTime() - heardMs < heartbeatTimeoutMs) {
          log("mailbox_heartbeat_deferred", {
            mailboxId: mb.id,
            totalMs: heartbeatTimeoutMs,
            reason: "the connection did not answer an IMAP NOOP inside the heartbeat window, and " +
              "the server was heard from inside that same window — so the probe is queued " +
              "behind a command that is still running rather than lost on a dead link. The " +
              "connection is left alone and asked again next window",
          });
          return;
        }
        connectionDeadSince = now();
        connectionDeadBy = "heartbeat";
        outageSince ??= connectionDeadSince;               // the person's clock; see the field
        log("mailbox_connection_unavailable", {
          mailboxId: mb.id,
          detectedBy: "heartbeat",
          totalMs: heartbeatTimeoutMs,
          reason: "the connection did not answer an IMAP NOOP inside the heartbeat window while " +
            "its socket was still open, which is the half-open link no connection event and no " +
            "failing cycle describes; this pass ends that connection and re-dials, and the " +
            "organizer lease is re-read before anything is moved",
        });
        // The INSTANCE, never the binding: a re-dial may already have installed a new adapter.
        try { who.forceClose?.(); } catch { /* the socket is going away regardless */ }
      };

      /**
       * ONE PROBE AT A TIME, AND AT MOST ONE PER WINDOW.
       *
       * Two callers now — the drain's preflight and {@link heartbeatTimer} — and the gate is what
       * keeps that from doubling the NOOPs on the wire: the second caller inside a window joins
       * the probe in flight or returns, and never opens a second one. At the defaults (a 15 s
       * poll against a 30 s window) the wire therefore carries fewer NOOPs than the preflight
       * alone did, not more.
       */
      const heartbeat = async (): Promise<void> => {
        const running = heartbeatInFlight;
        if (running !== null) { await running; return; }
        const last = heartbeatSettledAtMs;
        if (last !== null && now().getTime() - last < heartbeatTimeoutMs) return;
        const run = probeConnection().finally(() => {
          heartbeatSettledAtMs = now().getTime();
          heartbeatInFlight = null;
        });
        heartbeatInFlight = run;
        await run;
      };

      /* RE-ARMED FROM THE PROBE'S OWN SETTLEMENT, never from a cycle — see
         {@link heartbeatTimer}. Unreferenced, so it does not hold the process open.

         THE HEAL FOLLOWS THE PROBE, exactly as it does in `syncUntilQuiet`, and leaving it out
         was half a fix: the timer stamped a hung link dead within the window and then nothing
         re-dialled it, because the re-dial rides a drain and the drain was the thing that was
         hung. Detection and heal both have to be independent of the cycle or neither is. */
      const armHeartbeat = (): void => {
        if (stopped) return;
        heartbeatTimer = setTimeout(() => {
          void heartbeat()
            .then(() => redialIfDead())     // the ladder holds: the timer passes no `force`
            .catch(() => undefined)
            .finally(armHeartbeat);
        }, heartbeatTimeoutMs);
        heartbeatTimer.unref?.();
      };

      let adapter: MailboxAdapter = dialAdapter();
      /**
       * END THE LOGIN THE FORGOTTEN PASSWORD BOUGHT. Removing the row leaves an authenticated
       * socket open on a credential the person asked to be gone, and this engine outlives the
       * clear on every door that does not stop it. The poll timer is left alone deliberately: it
       * fires, finds the epoch moved and does not dial — one refusal, in `dialAndGate`, rather
       * than a second teardown path racing `detach()`.
       */
      const closeDialAfterSignOut = async (): Promise<void> => {
        await adapter.close().catch(() => { /* already going away */ });
      };
      const syncDeps = {
        repo,
        /**
         * AN ACCESSOR, NOT A COPY — the same rule the runtime record below states for its
         * thirteen fields, and here it is load-bearing rather than tidy. A re-dial REPLACES the
         * adapter, and a `syncDeps` that had captured the old one would hand every cycle after
         * the first re-dial the connection that died: the drain would keep throwing `NoConnection`
         * over a healthy socket sitting one binding away.
         */
        get adapter() { return adapter; },
        accountId: world.accountId, mailboxId: mb.id,
        // THE SYNC LOOP'S OWN DIAGNOSTICS, which this composition used to omit — see
        // `SidecarConfig.logger`. Spread here rather than assigned unconditionally so that an
        // install with no logger keeps the pre-existing shape (`log` absent, not `log: undefined`),
        // which is what `exactOptionalPropertyTypes` requires of an optional field.
        ...(config.logger === undefined ? {} : { log: config.logger }),
        // The same consent rule as the hosted worker: whose `Authentication-Results` this
        // mailbox may believe is a fact about the host THIS config dials — Gmail/Microsoft
        // resolve to their signing authserv-id, everything else to the empty set (demote nothing).
        // A fact about the host THIS mailbox dials — Gmail and Microsoft resolve to their signing
      // authserv-id, everything else to the empty set. Resolved from the process configuration it
      // would hand one mailbox's provider trust to another's mail.
      trustedAuthservIds: providerAuthservIds(mbImap.host),
        // UNMETERED STORAGE, typed — the free tier's limit is the user's own disk, and the field
        // is required precisely so this line has to exist rather than be inferred from absence.
        // (The assertion keeps the unique-symbol type from widening to `symbol` in this untyped
        // literal; it changes no value.)
        storageCap: UNMETERED_STORAGE_CAP as typeof UNMETERED_STORAGE_CAP,
      };

      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      /**
       * ══ THE IDLE LADDER — WHAT THE NEXT POLL IS ARMED AT ══
       *
       * `pollIntervalMs` while anything is happening; doubled towards {@link IDLE_POLL_CEILING_MS}
       * by each drain that produced nothing, and only while {@link restMayBeTaken}. Reset to base
       * by every event that can change the answer: an INBOX arrival, a press, a resume, a drain
       * that did something, a drain that failed.
       */
      let idlePollMs = pollIntervalMs;
      /**
       * May this mailbox rest at all — its INBOX watch is armed AND the server advertises IDLE, so
       * an arrival RINGS rather than waits for the next poll. False is the pre-0.19.1 behaviour
       * exactly: the ladder never leaves the base interval. Measured, never assumed.
       */
      let restMayBeTaken = false;
      /** The INBOX watch's detach, per DIAL — a re-dial builds a new adapter and re-arms. */
      let unwatch: (() => Promise<void>) | null = null;
      /** A kick is armed and has not fired: collapses a burst of arrivals into ONE drain, and
       *  keeps an in-flight drain's own re-arm from cancelling the kick (see {@link schedule}). */
      let wakePending = false;
      /** WHEN THE ARMED TIMER IS DUE, so a reset can tell "sooner" from "later" rather than
       *  re-arming blind: re-arming a timer that has already waited 100 s of its 120 pushes the
       *  drain FURTHER away, which is the opposite of what every caller of it wants. */
      let timerDueAt = 0;
      /**
       * THE HEARTBEAT'S OWN TIMER, AND WHY IT IS NOT THE POLL'S.
       *
       * The probe used to run only as the drain's preflight, and the drain re-armed itself from
       * `.finally(schedule)` — so a cycle that HUNG re-armed nothing and the one detector that
       * can see a hung cycle stopped running for as long as the hang lasted. The link then read
       * reachable and organized until the socket deadline fired minutes later, which is the
       * window this timer closes: it is re-armed by the probe's own settlement and by nothing
       * else, so it keeps asking while the cycle is stuck.
       */
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
      /** The probe in flight, so the preflight and the timer cannot ask twice at once. */
      let heartbeatInFlight: Promise<void> | null = null;
      /** When the last probe SETTLED — one probe per window, whichever caller arrives first. */
      let heartbeatSettledAtMs: number | null = null;
      /** One serial queue: a poll tick must never start a cycle while one is running, and `stop()`
       *  must be able to wait for whatever is in flight before closing IMAP and the database. */
      let tail: Promise<unknown> = Promise.resolve();
      /** How much this queue still owes — what {@link LocalMailboxRuntime.quiesce} reports on. A
       *  count and not a boolean because the queue is a chain: a caller that has joined it but not
       *  started is as much "in flight" to a stop as the body currently running. */
      let queued = 0;
      const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
        queued += 1;
        const run = tail.then(fn, fn).finally(() => { queued -= 1; });
        tail = run.catch(() => undefined);
        return run;
      };
      /**
       * WHEN THIS MAILBOX STARTED STOPPING — one instant for the whole stop, however many methods
       * it takes. A removal quiesces and then detaches; giving each its own `detachWaitMs` would
       * be a stop that can take twice as long as the number `detach()` promises, which is the
       * argument that method already makes about its own three waits.
       */
      let stopStartedAt: number | null = null;
      /** Set only where {@link LocalMailboxRuntime.quiesce} is what stopped this runtime. */
      let heldForRemoval = false;
      const stopLeft = (): number => {
        stopStartedAt ??= Date.now();
        return stopStartedAt + detachWaitMs - Date.now();
      };

      // The organizer lease — the LOCAL half. A local install cannot query the hosted database
      // and Cloud cannot query this PGlite file, so the mailbox is the only medium the two
      // share and the claim lives in it. The format, priority table and IO are
      // `packages/core`'s; the composition is `@trafficflow/worker/lease`'s. This file supplies
      // the two things Cloud cannot: WHO this install is, and what standing down means on a
      // laptop. The install id is the local `accounts` row: an install resuming its own role is
      // not a takeover, and that distinction IS an install-id match — the id survives a crash,
      // a reboot and a long sleep, and differs between installs (a hostname would collide
      // across two `MacBook-Pro`s; a per-launch value would make every restart a takeover). It
      // is written into a message in the user's OWN mailbox, the only place it goes.
      /** In memory only — the clone defence, and forgetting it on restart is what makes own-role
       *  resumption work. See `LeaseSelf` in the engine. */
      let leaseNonce: string | null = null;
      /**
       * THE NONCE A RENEWAL MINTED AND NEVER GOT AN ANSWER ABOUT — beside {@link leaseNonce}, in
       * memory for the same reason. A renewal that commits and loses its response leaves the folder
       * carrying a claim this install wrote and was never told about; with only the acknowledged
       * nonce remembered, the next gate reads it as a restored clone and stands the RUNNING install
       * down over its own write. Set before the append, cleared by the read that answered.
       */
      let leasePendingNonce: string | null = null;
      /**
       * WHAT THIS INSTALL'S WRITES RIDE ON. Written by every gate run and asked at every
       * destructive write inside the cycle, so a takeover landing mid-drain stops the remaining
       * moves instead of being noticed at the next gate.
       */
      let leasePermit: OrganizerWriteAuthority = { noLease: "not_supplied" };
      /**
       * When this process last renewed its claim — the fact the release's lapse bound is
       * computed from, in memory deliberately. The claim's heartbeat is the instant handed to
       * `readMailboxLease`, so this is the newest heartbeat any reader of `ohmail/_meta` can see
       * from this install; once it is `staleAfter` old, every other install already reads the
       * claim as stale — which makes the lapse an END of a release the server would not confirm,
       * not a guess. On restart the bound falls back to `release_requested_at`, later than any
       * renewal this install can have written after it; only a restart inside the single racing
       * pass loses a newer renewal, and the cost is a flip early by one pass's duration.
       */
      let lastLeaseRenewalAt: Date | null = null;
      /**
       * A stand-down recorded on the row outlives the process — what makes a lapsed Cloud
       * subscription leave the desktop stood down rather than auto-resuming. The lease alone
       * cannot: once Cloud releases its claim, `ohmail/_meta` is empty, and an empty folder
       * correctly reads as "nobody has ever organized this mailbox" — the arm that organizes.
       * Relaunching the app would silently make this machine the thing that moves somebody's
       * mail: a forgotten office install, woken by a billing event, filing against a rules store
       * frozen at its stand-down. So a stood-down row means this install organizes nothing and
       * the gate is not consulted; only clearing the row does — "Organize from this Mac…".
       */
      /**
       * A request from Settings overrides the row's memory, and changes nothing else. `requestOrganizerTakeover`
       * writes ONLY the stamp and leaves the row `disabled` with its reason; the stamp stops the gate
       * short-circuiting, so the lease is consulted — the one thing that can decide. The row is NOT cleared here:
       * `main.ts` calls `start()` asynchronously and `start()` returns before the gate when no password is stored, so
       * a row cleared at assembly is a `connected` mailbox served to requests before any lease read —
       * `ScheduleService` and `SendService` refuse on `status = 'disabled'` and nothing else, so that window accepts
       * sends for a mailbox another organizer may hold. The clear lives in `mayOrganize`'s ORGANIZE arm, after
       * `readMailboxLease` says yes; a refusal rewrites the row, voids the stamp, and names the install that kept it.
       */
      /* This mailbox's own memory, never the seed's. These five were read off `world` — the
       * SEED's row — the same statement with one mailbox and three silent faults with several:
       * the seed stood down and #2 did not → #2 comes up believing it was demoted and never
       * organizes the mailbox it holds; #2 stood down and the seed did not → #2 comes up with
       * no memory of it and re-claims the mailbox it was demoted from on its next lease read —
       * the auto-resume this memory exists to prevent, the one that moves somebody's mail; a
       * takeover press on ANY mailbox authorized EVERY runtime. `loadLocalRoster` already reads
       * both per row, and `identity.ts` states why; the values were computed and dropped. */
      const takeoverRequested = mb.takeoverAuthorizedAt !== null;
      /**
       * This install has handed the mailbox back and has not been asked to resume. In memory only,
       * set by nothing but {@link LocalMailboxRuntime.handBack}. Without it the hand-back was a
       * release the very next poll undid: the timer still armed, the row still organizer, the gate
       * claimed again — an iPhone suspended a second later held a live claim while running nothing,
       * the one state the hand-back exists to prevent. `handBack` clears the timer AND arms this,
       * because a timer is not the only way into the gate (a resync, a wake, `syncUntilQuiet`). Not
       * a second `priorStandDown`: that says another install holds the mailbox and needs a press;
       * this says "nobody is running here" and `resume()` clears it.
       */
      let handedBack = false;
      /**
       * The stand-down this process remembers — a `let` because the process now outlives the stand-down that
       * sets it. As a `const` read once from the row it was right while a demoted install stopped; mail 0083
       * made the loser a READER — connected, poll timer running — turning a snapshot into a hole: the gate
       * stands down mid-life, the poll fires a minute later, `priorStandDown` is still the assembly-time
       * null, the foreign claim is gone (the other organizer released cleanly) and `decideLease`'s "nobody
       * has ever organized" arm ORGANIZES — the auto-resume this mechanism exists to prevent, with no human
       * action. The gate's two arms maintain it: standing down writes the memory, the press-gated promotion
       * clears it; the value is the row's own, so relaunch and poll agree.
       */
      let priorStandDown: string | null = takeoverRequested ? null : mb.standDownReason;
      /**
       * WHAT THE WINDOW REPORTS, and it is the ROW's answer rather than the gate's optimism: a
       * stood-down install with a request outstanding is still stood down until the lease says
       * otherwise, so `organizerState()` keeps saying so and the pane keeps showing why. Reading
       * `priorStandDown` here instead would announce "organizing" for a mailbox this process has
       * not claimed and may not get.
       */
      let organizer: OrganizerState = mb.standDownReason
        ? { organizing: false, reason: mb.standDownReason as MailboxDisabledReason, heldBy: null,
          unreadableSince: null, releaseRequestedAt: null, claimed: false }
        /* THE STOP IS NOT KNOWN AT ATTACH — it is the ROW's, and the first pass's own read is what
           puts it here. `null` is "nothing has said", which is what an unasked question answers.
           `claimed` follows `organizing` here and for the same reason: the row said organizer and
           nothing has said otherwise yet. The gate's first pass replaces both. */
        : { organizing: true, reason: null, heldBy: null, unreadableSince: null,
          releaseRequestedAt: null, claimed: true };
      /**
       * The exit from a stand-down — a human asked for this machine, once. Written by the
       * "organize from this machine" command (`organize-here.ts`), which also clears the row's
       * stand-down. Both halves are needed: clearing the row alone gets as far as the lease, and
       * the lease then refuses a mailbox whose previous organizer left a claim behind without
       * releasing — the crashed-machine case, precisely when somebody sits down at another
       * machine and asks for it. This stamp is the fact that makes that case different. Spent
       * the moment it succeeds: it authorizes one becoming, never a standing right to seize this
       * mailbox back from wherever it may go next.
       */
      let takeoverAuthorized = mb.takeoverAuthorizedAt !== null;
      /**
       * The exact stamp this pass read, so the stand-down can clear THAT ONE and not whatever is
       * on the row by the time it writes. The gate reads the stamp, then the lease — a network
       * round trip that can take seconds. A press landing inside that window writes a stamp this
       * pass never offered to the lease, and an unconditional `takeoverAuthorizedAt: null` would
       * erase it: the route answered `authorized` and the request is gone with nothing saying so
       * — a press consumed by a pass that could not act on it. Comparing rather than
       * serializing, because the route must stay answerable while a slow lease read is in
       * flight; a button press must not block behind an IMAP timeout.
       */
      let observedTakeoverAt: Date | null = mb.takeoverAuthorizedAt;
      /**
       * WHAT THAT PRESS ASKED FOR, moving with the stamp beside it and never read on its own. The
       * pair is one fact: the in-flight-press comparison below clears exactly the stamp this pass
       * READ, so an intent fetched by a second statement could describe a different press.
       */
      let observedIntent: OrganizerIntent = mb.takeoverIntent;

      /**
       * Has anybody asked this install to organize this mailbox — `organize_consented_at`, as the row
       * holds it, re-read by the gate on every pass. TRUE at assembly, chosen rather than convenient:
       * `world` does not carry the column, so the first value is a guess until the gate's own read
       * replaces it one statement into `mayOrganize` — which runs before anything organizes, so the
       * guess is never acted on. What it must not be is wrong in the hurting direction: an install
       * organizing for months, briefly reading un-consented, would demote itself and stop moving mail
       * for a live customer; reading as consented and being corrected costs nothing. The same asymmetry
       * `OnboardingMailbox.organizerRole` documents, resolved the other way for the opposite reason.
       */
      let consented = true;

      /**
       * Has THIS process created the `ohmail/*` tree in the mailbox yet?
       *
       * One IMAP round trip is what it saves; correctness is what it exists for. `ensureFolders` is
       * the write that makes an organizer's destinations exist, and it has two callers now — the
       * launch, and the pass on which a promotion takes effect — so the flag is the thing that keeps
       * them from being two answers to "have the folders been made". False at construction and never
       * reset: a demotion does not remove the folders, and an install that is promoted again has
       * nothing to re-create.
       */
      let foldersEnsured = false;

      /**
       * CLOSE THE SEND-LATER APPOINTMENTS A STAND-DOWN ORPHANS — the local half of
       * `closeStoodDownAppointments`, which holds the whole argument for why they are FAILED rather
       * than handed over.
       *
       * Never throws: it is called from the stand-down path and from the launch below, and neither
       * may be made contingent on it. A failure is logged and retried — the next launch of a
       * still-stood-down install runs the catch-up again, and the row it would close is still
       * exactly as it was.
       */
      const standDownAppointments = async (
        reason: MailboxDisabledReason,
        /**
         * The RELEASE's sentence, when this close is a release rather than a stand-down (mail
         * 0088). Omitted, `reason` chooses — the stand-down arm and the launch catch-up. See
         * `RELEASED_ORGANIZER_SEND_SENTENCE` for why a release cannot quote a stand-down's.
         */
        sentence?: string,
      ): Promise<void> => {
        try {
          const r = await closeStoodDownAppointments(db as unknown as Tx, {
            accountId: world.accountId, mailboxId: mb.id, reason, now: now(),
            ...(sentence !== undefined ? { sentence } : {}),
          });
          // Only when something closed: an install with no appointments — the overwhelming case —
          // stays silent on every stand-down and every launch, the rule every pass here follows.
          if (r.closed > 0) log("scheduled_sends_stood_down", { closed: r.closed, disabledReason: reason });
        } catch (err) {
          log("scheduled_sends_stand_down_failed", {
            err,
            reason: "a scheduled send this install can no longer make was not closed with its " +
              "sentence; the row still says it will send, and the next launch tries again",
          });
        }
      };

      /**
       * The launch catch-up — a stood-down install closes its own appointments on every start. The stand-down
       * hook covers the transition; this covers the STATE, for three cases the transition cannot reach: an
       * install that stood down before this code existed, one whose close failed, and one relaunched since
       * (`mayOrganize` returns at `priorStandDown` without reaching the lease arm, so no later launch would
       * run the close). Here in the assembly rather than `start()`, because `start()` returns before the gate
       * when no password is stored — and a stood-down install with a forgotten password is exactly one whose
       * Drafts screen someone opens. One indexed UPDATE, matching nothing on a settled install; awaited, so
       * the mirror is true before the bridge serves its first request.
       */
      if (priorStandDown) await standDownAppointments(priorStandDown as MailboxDisabledReason);

      /**
       * The portable organizer profile — the LOCAL half, the same composition Cloud runs
       * (`@trafficflow/worker/profile`), handed this install's lease identity and this install's
       * store. One serialization of one store, or LOCAL and CLOUD would write documents that
       * disagree about the same configuration. Ticked only from `syncUntilQuiet` AFTER
       * `mayOrganize()` said yes — the single-writer discipline every organizer-side write
       * rides. `"0.0.0"` is the version every local surface reports today (the /hello
       * convention); provenance in the document, never a decision.
       */
      const profileSync = new OrganizerProfileSync({
        db, accountId: world.accountId, mailboxId: mb.id,
        /* AN ACCESSOR for `syncDeps.adapter`'s reason, and this object is the one that would have
           hidden the defect longest: `OrganizerProfileSync` keeps the deps record for the life of
           the attachment and reads `deps.adapter` per call, so a captured value would leave the
           write-behind publishing into a dead socket after a re-dial while every other pass had
           healed — a partial recovery, which is worse to diagnose than none. */
        get adapter() { return adapter; },
        self: { installId, kind: organizerKind },
        producerVersion: "0.0.0",
        ...(config.profileFlushIntervalMs !== undefined
          ? { flushIntervalMs: config.profileFlushIntervalMs } : {}),
        now,
        log,
      });

      /**
       * Read the lease. Returns false when this install must not organize, and makes that durable. The loser is a
       * READER: connected, poll timer running, mirror growing, `\Seen` its one IMAP write verb — not a stopped
       * install (this header once said the opposite, long enough that three call sites implemented that sentence).
       * The fear is answered by the ROLE, not by stopping: a reader's cycle skips `reconcileFolders`, the folder-ops
       * pass, the junk sweep, `ensureFolders`, the retro passes and the profile publish (`SyncDeps.role` carries the
       * whole list). `false` means "not the organizer", never "do nothing". The stand-down is sticky in the local row
       * (`status='disabled'` + reason) — the memory the mailbox cannot hold, since an empty `ohmail/_meta` reads as
       * "nobody has ever organized", which organizes. Only an explicit human action clears it.
       */
      /**
       * What the row already says the holder is, so the peek below writes only when something
       * CHANGED (0.14.1). The hosted twin (`index.ts#MailboxRuntime.holderSeen`) has carried
       * this since reader mode landed; this side wrote every poll instead. Seeded NULL rather
       * than from `world`, which does not carry the four columns — so the first peek of a launch
       * always writes, once, and every settled poll after it writes nothing. The first write's
       * `organizer_event_at` is stamped only if the occupancy differs from this seed — a launch
       * finding the same empty folder the row already recorded stamps nothing.
       */
      const holderSeen: {
        kind: string | null; name: string | null; since: Date | null; state: string | null;
        /** Mail 0089 — the fifth holder column, tracked beside the other four for the same reason. */
        capabilities: string | null;
        /** Mail 0092 — the SIXTH holder column, and the reason it is tracked here rather than
            written blind is the compare below: a column this snapshot does not carry cannot be
            found stale, so it is never corrected. That is exactly how the hosted twin shipped
            this column inert — written by every writer, compared by none, NULL for ever on every
            row that predated it, and a hand-back refused on precisely the mailboxes organized
            longest. */
        installId: string | null;
      } = { kind: null, name: null, since: null, state: null, capabilities: null, installId: null };

      /**
       * An install that is not the organizer looks, and still does not claim. Two arms reach
       * it: a pre-consent install, and a demoted reader — which used to return without peeking,
       * so a demoted desktop's holder columns froze at the handover. The consent arm returns
       * BEFORE `readMailboxLease` (that function APPENDS on an empty folder), but the holder is
       * exactly what the pre-consent screens must say (`deriveOnboardingStep` row 3). So this is
       * the APPEND-less read (`readLeasePeek`, one method, no way to write — the narrowness is
       * the enforcement). Never throws: "could not look" and "nobody holds it" must not be
       * reachable from one another. Writes only on change.
       */
      /**
       * The engine's own APPEND-less look, in the three words a decision can be made from — and
       * the reason it is not {@link readLeasePeek} directly is the missing accessor. `leasePeekIo`
       * is probed structurally because `MailboxAdapter` does not declare it, and this call site
       * answered a failed probe with a bare `return`: the holder columns then said exactly what a
       * mailbox nobody has ever organized says, no line was logged, and `unreadableSince` — the
       * field that exists to tell a person the difference — stayed null. Measured: with that arm
       * taken, the phone's consent door admitted the press and wrote the consent.
       */
      const peekOrganizer = async (): Promise<LeasePeekAnswer> => {
        const peekIo = (adapter as Partial<{ leasePeekIo(): LeasePeekIo }>).leasePeekIo;
        /* ASKING FOR THE ACCESSOR CAN ITSELF REFUSE, and that is an ANSWER too. `ImapAdapter`
           asserts the adapter is usable before handing the io out, so a RETIRED one throws here —
           an ordinary runtime state, a mailbox detached while a press was in flight. Inside the
           poll that throw was caught by the surrounding try; the DOOR awaits this directly, so
           without this it would reject rather than refuse, and a rejection is not the 503 whose
           sentence tells a person to press again. */
        let io: LeasePeekIo | undefined;
        try {
          io = typeof peekIo === "function" ? peekIo.call(adapter) : undefined;
        } catch (err) {
          return { answer: "unreadable", op: "no_lease_peek_io", cause: err };
        }
        return answerLeasePeek({
          io,
          now: now(),
          ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          log,
        });
      };

      /** The one place this runtime writes "the lease could not be read" — kept from the FIRST
       *  failure, so a surface can say how long; a look that answers clears it. */
      const markLeaseUnreadable = (err: unknown, op: LeaseOp): void => {
        organizer = {
          ...organizer,
          unreadableSince: organizer.unreadableSince ?? new Date().toISOString(),
        };
        log("organizer_peek_failed", {
          err, op,
          reason: "this install reads this mailbox and could not see who organizes it; the row "
            + "keeps its previous answer, the pane says the lease is unreadable, and the next "
            + "pass looks again",
        });
      };

      const notePeekedHolder = async (reason: MailboxDisabledReason | null): Promise<void> => {
        try {
          const answered = await peekOrganizer();
          /* THE THIRD ANSWER, AND IT IS NOT `free`. A look that did not happen leaves the four
             holder columns alone — a failed look is not evidence about who holds the mailbox —
             and says so where a person and the door can both read it. */
          if (answered.answer === "unreadable") {
            markLeaseUnreadable(answered.cause, answered.op);
            return;
          }
          const seen = answered.peek;
          /* FRESHEST FIRST — `peekLease` sorts them, and the freshest is what a person means by
             "who organizes this". An empty list is "nobody named", never invented. */
          const top = seen.holders[0] ?? null;
          /* `none` is not a member of the column's closed set: "nobody has ever organized this
             mailbox" is genuinely absent, not `stopped`. */
          const state = seen.state === "held" ? "held" : seen.state === "stopped" ? "stopped" : null;
          const name = top && top.displayName.trim() !== "" ? organizerDisplayName(top.displayName) : null;
          const kind = top === null ? null : top.kind;
          const since = top ? top.claimedAt : null;
          // Mail 0089 — the fifth holder column, computed the same way the hosted twin
          // (`index.ts#refreshReaderHolder`) does: comma-joined, lowercased, empty ⇒ null.
          const capabilities = top ? capabilitiesColumn(top.capabilities) : null;
          /* Mail 0092 — WHICH install holds it, beside WHAT KIND of install. `kind` is one of
             three words and answers "what sort of thing"; the hand-back needs "is this us", and
             those are the same question only when there is one install per kind. */
          /* NAMED `holderInstallId`, NOT `installId`, and that is not style. An outer
             `const installId = world.accountId` — THIS install's id — is in scope here, so a
             binding called `installId` shadows it only inside its own block and reads as the
             outer one everywhere else. Both are `string`-ish, so the mix-up TYPECHECKS: the
             first cut of this projection wrote this install's id into every row, including a
             peer's, which refreshes a peer's row on every poll and re-stamps
             `organizer_event_at` — the fifteen-second notice the compare exists to stop.
             Caught by renaming this binding and finding that nothing broke. */
          const holderInstallId = top === null ? null : top.installId;
          /* The REASON is the caller's, because the two arms that peek mean different things by
             the same four columns. A pre-consent install names no reason — nobody has stood
             anything down and putting "another install has claimed this mailbox" in front of
             somebody who simply has not finished setup would be false. A DEMOTED reader names the
             stand-down it remembers, so the pane keeps saying why it is not organizing. */
          organizer = { organizing: false, reason, heldBy: name, unreadableSince: null,
            /* CARRIED: a peek reads the holder, never the row's own stop. */
            releaseRequestedAt: organizer.releaseRequestedAt,
            /* The two arms that peek are the two that hold nothing — a reader, and an install
               nobody has consented to. */
            claimed: false };
          /* Zero writes in the steady state, and the check is new (0.14.1). This block claimed
           * "only when something changed" and then wrote unconditionally — one UPDATE per
           * mailbox per poll for four values already there. The hosted twin
           * (`index.ts#refreshReaderHolder`) had the comparison and this side did not, and
           * nothing could notice: an idempotent write is invisible. It stops being invisible
           * the moment an event instant rides the same statement — without the comparison every
           * poll of a settled reader would stamp `organizer_event_at` and the notice would
           * reappear every fifteen seconds for ever.
           */
          const same = holderSeen.kind === kind && holderSeen.name === name
            && holderSeen.state === state && holderSeen.capabilities === capabilities
            && holderSeen.installId === holderInstallId
            && (holderSeen.since ? holderSeen.since.getTime() : null)
              === (since ? since.getTime() : null);
          if (same) return;
          /* AN OCCUPANCY FLIP IS AN EVENT; A RENAME OR A NEW TENURE IS NOT. The hosted twin's
             argument verbatim: `held` ⇄ `stopped` (and either direction to or from "we have not
             looked") is what the reader's two sentences are about, while a peer restarting shifts
             `organized_since` and a machine being renamed shifts the name — neither is news, and
             telling somebody about them is the notice crying wolf. */
          const stateChanged = holderSeen.state !== state;
          await db.update(mailboxes)
            .set({
              organizedByKind: kind,
              organizedByName: name,
              organizedSince: since,
              organizerState: state,
              // Mail 0089 — the fifth holder column, on the same read.
              organizedByCapabilities: capabilities,
              // Mail 0092 — the sixth, on the same read as the kind: the two must never disagree.
              organizedByInstallId: holderInstallId,
              ...(stateChanged ? { organizerEventAt: now() } : {}),
            })
            .where(eq(mailboxes.id, mb.id));
          holderSeen.kind = kind; holderSeen.name = name;
          holderSeen.since = since; holderSeen.state = state;
          holderSeen.capabilities = capabilities; holderSeen.installId = holderInstallId;
        } catch (err) {
          /* And it is recorded where a person can see it, not only in a log. Keeping the row's
           * previous answer is right — a failed look is not evidence about who holds the
           * mailbox — but it left the STATE looking healthy: a reader whose lease reads keep
           * failing presented an ordinary connected pane with a stale holder, and the mark this
           * field exists for was set only on the startup path — the reliability-signal-as-
           * healthy-state shape surviving at poll time, where a mailbox spends its life.
           * `answerLeasePeek` answers the folder's own faults rather than throwing them, so what
           * reaches here is the WRITE below failing — which is still a pass that learned nothing. */
          markLeaseUnreadable(err, "list_claims");
        }
      };

      const mayOrganize = async (): Promise<boolean> => {
        /* The stamp is re-read every run, and without this the poll destroys it.
         * `takeoverAuthorized` was derived once at assembly — harmless while a stood-down
         * install had no poll timer. A reader cycles now, turning dormant staleness
         * destructive: the poll asks the lease with `takeover: "none"`, is correctly refused by
         * the foreign claim the person is asking to take over, and the refusal arm CLEARS the
         * persisted stamp — the press consumed by the one pass that could not act on it. So the
         * row is asked again at the top of the gate: one indexed read per poll, which makes the
         * takeover route's promise a fact. Failure is not an error: an unreadable row leaves
         * the in-memory value, and a takeover deferred one poll beats a failed launch.
         */
        /** What the ROW says the role is, re-read every pass beside the stamp (0.14.1). */
        let rowRole: string = "organizer";
        /**
         * Did the read above actually land? — a `let` because the inferred default was measured to be a hole.
         * `rowRole` is a fresh optimistic literal per call, so a re-read that THREW left it saying
         * `"organizer"` and the gate ran the write gate anyway — the auto-resume this release exists to
         * close, reached through the read added to close it: the person releases, the row says `reader`, the
         * folder is empty, a later poll's point-read fails, and `decideLease`'s arm 4 hands the mailbox back
         * under a row that still says `reader` — moving mail on IMAP while its own API refuses every write.
         * So an unreadable row is treated as "do not claim": one deferred poll for an organizer (its claim
         * stays fresh for forty more renews) against a reversed human decision.
         */
        let rowRead = false;
        /** Mail 0088 — "stop organizing this mailbox and keep my mail", if it has been asked. */
        let releaseRequested: Date | null = null;
        try {
          const [row] = await db.select({
            at: mailboxes.takeoverAuthorizedAt,
            // …AND THE CONSENT, in the same indexed read. See the arm below: this is the column
            // that separates "nobody has been asked" from "this install is the organizer", and
            // before it was read here NOTHING on this door read it at all.
            consentedAt: mailboxes.organizeConsentedAt,
            /* And the role, which is what the RAM memory was standing in for (0.14.1).
             * `priorStandDown` was a process-local `let`, and the arm it guarded was the whole
             * of "this desktop does not auto-resume". Two things were wrong with reading RAM
             * here: another writer moves this row (the local `organize here` door, a `DELETE`,
             * the Settings pane) and RAM does not hear about it; and a value that starts NULL
             * at assembly means the first pass after a press resolves from a snapshot taken
             * before it, so the gate's two halves can disagree about one row inside one cycle.
             * The row is the memory the mailbox cannot hold, so the row is what is read — one
             * indexed point-read per poll, in the same statement as the columns beside it.
             */
            role: mailboxes.organizerRole,
            // Mail 0104 — the VERB behind `at`, in the SAME statement for the reason every column
            // here is in it: the gate decides from one read of this row.
            intent: mailboxes.takeoverIntent,
            releaseAt: mailboxes.releaseRequestedAt,
            // The holder columns, so the peek below can tell a CHANGE from a no-op without a
            // second round trip — and so a value another writer moved is not compared against a
            // stale copy in this process.
            byKind: mailboxes.organizedByKind,
            byName: mailboxes.organizedByName,
            since: mailboxes.organizedSince,
            state: mailboxes.organizerState,
            // Mail 0089 — the fifth holder column, in the same read for the same reason.
            capabilities: mailboxes.organizedByCapabilities,
            // Mail 0092 — the sixth, in the same read for the same reason.
            byInstallId: mailboxes.organizedByInstallId,
          })
            .from(mailboxes).where(eq(mailboxes.id, mb.id)).limit(1);
          if (row) {
            rowRead = true;
            takeoverAuthorized = row.at !== null;
            observedTakeoverAt = row.at;
            /* A value outside the column's closed set cannot be written by this program; read as
               the verb that YIELDS rather than the one that displaces, which is the direction
               that cannot end with two organizers. */
            observedIntent = row.intent === "takeover" ? "takeover" : "join";
            consented = row.consentedAt !== null;
            rowRole = row.role;
            releaseRequested = row.releaseAt;
            holderSeen.kind = row.byKind;
            holderSeen.name = row.byName;
            holderSeen.since = row.since;
            holderSeen.state = row.state;
            holderSeen.capabilities = row.capabilities;
            holderSeen.installId = row.byInstallId;
          }
        } catch (err) {
          log("organizer_takeover_reread_failed", {
            err,
            reason: "the takeover request could not be re-read this cycle; the stamp stands on the " +
              "row and the next cycle asks again",
          });
        }

        /* THE STOP STANDING ON THE ROW, PROJECTED ONCE FOR EVERY LITERAL BELOW. `organizing`
         * answers what THIS PASS may arrange, and a pass honouring a release arranges nothing
         * whether or not the claim left `ohmail/_meta` — so the phone's adapter read
         * `organizing: false` as "the mailbox was let go" and reported a refused stop as a success.
         * Two questions need two fields; this is the second, the row's own `release_requested_at`.
         * DERIVED IN ONE PLACE and spent below, where the compare-and-set records the release. A
         * pass that could NOT read the row never reaches a literal that writes this: the `!rowRead`
         * arm returns by spreading the previous answer, and a carry term here would be a second
         * mechanism over that one. */
        let releaseStamp: string | null = releaseRequested?.toISOString() ?? null;

        /* The release is honoured first, before the lease is read at all (0.14.1). The hosted
         * twin's arm, verbatim: "stop organizing this mailbox and keep my mail" is not a
         * question for the lease, and reading the lease first would RENEW a claim this install
         * is about to delete — advertising a machine told to stop, once per poll, in somebody's
         * mailbox. Three writes in load-bearing order: the CLAIM while the connection that can
         * expunge it is open, then the ROW (what makes the ceasing durable and what
         * `closeStoodDownAppointments` reads), then the APPOINTMENTS — none may abort the
         * ceasing. The timer and the login stay, as on a stand-down: a release keeps the mirror
         * growing, the mail readable and the send path open — the whole difference from removal.
         */
        if (releaseRequested !== null) {
          const released = await releaseOwnClaim(
            adapter, installId, mb.id, { current: leaseNonce, pending: leasePendingNonce }, log,
            "the claim ages out of the mailbox on its own; until it does, another "
              + "install that tries to take this mailbox over stands itself down again",
          );
          /* "Could not look" is not "released", and this arm is the whole of that.
           * `releaseOwnClaim` answers a count of ours removed, `0` (a complete answer), or
           * `null` — the search refused, the walk short, the folder over its ceiling. What
           * stood here gated the log on `> 0` and the write on nothing, so `null` produced a
           * row byte-identical to a completed release: the pane said the mailbox was let go
           * while the claim stood in `ohmail/_meta` and every other install stood itself down
           * against it. So `null` records nothing — the next poll asks again. The pass still
           * ceases to organize: falling through to the lease read would renew the claim being
           * given up. `takeover_authorized_at` is not spent; `notePeekedHolder` is not called.
           */
          /* …and the retry is bounded by the lapse, or "stop" can never finish (0.14.1).
           * Measured on a real provider: the enumeration was refused on every poll — the arm
           * below, right per pass, was unbounded as a whole. The bound is the lease's own
           * arithmetic: a pass with a pending request never renews, so once
           * {@link lastLeaseRenewalAt} is `staleAfter` old every reader already treats the
           * claim as stale and takes the mailbox past it — organizing here has truthfully
           * ended, and the row flips exactly as a confirmed release does (the log names the
           * lapse). Inside the window the arm stands: flipping early would stand the other
           * machine down against a still-fresh claim. On restart `release_requested_at` bounds.
           */
          let releasedByLapse = false;
          if (released === null) {
            const staleAfterMs = config.leaseStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
            const lastRenewal = lastLeaseRenewalAt ?? releaseRequested;
            if (now().getTime() - lastRenewal.getTime() >= staleAfterMs) {
              releasedByLapse = true;
            }
          }
          if (released === null && !releasedByLapse) {
            /* The pipeline is told, or a reader's gate gets an organizer's cycle. This record is
               what the PANE renders and what the next pass's gate starts from; the drain of the
               pass this gate is running takes the answer as a value instead. `reason` is NULL:
               nobody else holds this mailbox, and naming a holder would put "another install
               has claimed this mailbox" in front of somebody whose own release has not
               finished. `unreadableSince` is CARRIED, not cleared — this pass did not read the
               lease, so it learned nothing that could clear a standing mark; and not set
               either — "the server would not enumerate our records" is not "we cannot see who
               organizes this mailbox". */
            organizer = {
              organizing: false, reason: null, heldBy: null,
              unreadableSince: organizer.unreadableSince,
              /* NOT OURS ANY MORE, whatever the folder still holds: the person pressed stop, so
                 nothing may start behind a notification on the strength of this claim. */
              claimed: false,
              /* AND THE STOP IS STILL STANDING, which is the whole of what a caller may not read
                 off `organizing` here: nothing was recorded, the claim is in the folder as far as
                 anybody knows, and the next poll asks the server again. */
              releaseRequestedAt: releaseStamp,
            };
            log("organizer_claim_release_unconfirmed", {
              mailboxId: mb.id,
              reason: "this install was asked to stop organizing this mailbox and could not "
                + "confirm its claim is out of the mailbox, so nothing is recorded as released: "
                + "the mailbox stays organized here with the request still standing, this pass "
                + "arranges nothing and renews nothing, and the next poll asks the server again",
            });
            return false;
          }
          if (released !== null && released > 0) {
            log("organizer_claim_released", {
              mailboxId: mb.id,
              claims: released,
              reason: "the person asked this install to stop organizing this mailbox; its claim "
                + "is out of the folder so another install can take it without waiting out the "
                + "staleness window",
            });
          }
          /* AND `0` FALLS THROUGH TO THE SAME WRITE, with no line of its own. A complete read
             that found none of ours means nothing of this install's is holding the mailbox — the
             thing the person asked for — so it is a release, and it is silent because there is no
             count to report and nothing an operator would act on. Treating it as a failure would
             strand the request for ever on a mailbox whose claim had already aged out: there
             would be nothing left for any later poll to remove. */
          try {
            /* And it yields to a press that landed while it was asking the server.
             * `releaseOwnClaim` is an IMAP round trip, and the route that writes
             * `takeover_authorized_at` stays answerable throughout ({@link observedTakeoverAt}),
             * so the gap between this pass reading the row and writing it is exactly where
             * "organize here again" lands — unguarded, this write deleted that press silently.
             * The update is a compare-and-set on the two columns this pass decided from,
             * yielding whole: an overtaken release records nothing. `IS NOT DISTINCT FROM`, not
             * `=` (SQL equality on two NULLs is NULL). Both columns, because the door that
             * accepts a press on a release-pending row also cancels the request in the same
             * transaction; the next pass's gate appends a fresh claim under the surviving stamp. */
            const [recorded] = await db.update(mailboxes)
              .set({
                organizerRole: "reader",
                // Nobody won this mailbox. Leaving the holder columns populated would put
                // "organized by <someone>" on a mailbox nothing is organizing, in front of the
                // person who just pressed the button that stopped it.
                organizedByKind: null,
                organizedByName: null,
                organizedSince: null,
                organizerState: null,
                // Mail 0089 — the fifth holder column goes with the other four; nobody won this
                // mailbox, so nobody offers anything.
                organizedByCapabilities: null,
                // Mail 0092 — nobody won it, so no id names anybody.
                organizedByInstallId: null,
                // Both stamps are spent. They are contradictory instructions about one mailbox, and
                // a release that left a becoming authorized would be promoted straight back by the
                // very next poll — the control undoing itself.
                releaseRequestedAt: null,
                takeoverAuthorizedAt: null,
                // AND THE RECORD THAT IT HAPPENED (0.14.1). The ask is gone; without this the
                // row is byte-identical to a stood-down reader whose winner has since gone away,
                // and the launch catch-up for orphaned appointments would stop running on it. See
                // `standDownMemory`'s released arm.
                organizerReleasedAt: now(),
                organizerEventAt: now(),
              })
              .where(and(
                eq(mailboxes.id, mb.id),
                sql`${mailboxes.takeoverAuthorizedAt} is not distinct from ${dialect(db).tsOrNull(observedTakeoverAt)}`,
                sql`${mailboxes.releaseRequestedAt} is not distinct from ${dialect(db).tsOrNull(releaseRequested)}`,
              ))
              .returning({ id: mailboxes.id });
            if (recorded === undefined) {
              /* THE PRESS WON. Nothing is recorded and nothing is undone — the next poll re-reads
                 the row, finds the request gone and the stamp standing, and promotes. `organizing`
                 is false for THIS pass because the claim did come out of the folder a moment ago:
                 filing mail as an organizer with no claim in `ohmail/_meta` is the one state worse
                 than a pass that arranges nothing. `unreadableSince` is carried, not cleared — see
                 the unconfirmed arm above for why a pass that read nothing may not clear a mark. */
              organizer = {
                organizing: false, reason: null, heldBy: null,
                unreadableSince: organizer.unreadableSince,
                /* The claim did come out of the folder a moment ago; the next poll's gate appends
                   a fresh one under the surviving press and sets this again. */
                claimed: false,
                /* NOTHING IS RECORDED AND NOTHING IS SPENT, so the stamp stands exactly as this
                   pass read it — the row moved under the write, and the next poll re-reads it. */
                releaseRequestedAt: releaseStamp,
              };
              log("organizer_claim_release_yielded_to_press", {
                mailboxId: mb.id,
                reason: "this install was asked to stop organizing this mailbox and then asked to "
                  + "organize it again while the first request was still being carried out; the "
                  + "later press stands, nothing is recorded as released, and the next poll "
                  + "organizes this mailbox here again",
              });
              return false;
            }
            holderSeen.kind = null; holderSeen.name = null;
            holderSeen.since = null; holderSeen.state = null;
            holderSeen.capabilities = null;
            /* THE REQUEST IS SPENT, and this is the only line that spends it: the statement above
               is what cleared the row's own column, so the projection moves with it and not a
               moment earlier. The catch below does NOT clear it — a write that failed leaves the
               request standing, which is what its own sentence says. */
            releaseStamp = null;
          } catch (err) {
            log("organizer_release_write_failed", {
              err,
              reason: "this install has stopped organizing the mailbox and its claim is gone; the "
                + "row could not record it, so the next poll honours the request again",
            });
          }
          takeoverAuthorized = false;
          observedTakeoverAt = null;
          /* On the lapse path this pass read nothing from the folder — the enumeration is what
             failed — so a standing unreadable mark is carried, on the unconfirmed arm's own rule:
             a pass that learned nothing may not clear an outage. A confirmed release DID read the
             folder, and clears it as it always has. */
          organizer = {
            organizing: false, reason: null, heldBy: null,
            unreadableSince: releasedByLapse ? organizer.unreadableSince : null,
            releaseRequestedAt: releaseStamp,
            /* THE CLAIM IS GONE — confirmed out of the folder, or lapsed past believability. */
            claimed: false,
          };
          /* NOT `priorStandDown`. That memory answers "somebody else holds this", and it is what
             `standDownMemory` derives from the row — which now reports a released mailbox as no
             memory at all. Setting it here would make the pane say another organizer had taken the
             mailbox from an install whose owner simply stopped it. */
          // The RELEASE's sentence: nobody took this mailbox, so "schedule it again where the
          // mailbox is organized now" would name a place that does not exist.
          await standDownAppointments("organized_elsewhere:unknown", RELEASED_ORGANIZER_SEND_SENTENCE);
          if (releasedByLapse) {
            log("organizer_released_by_lapse", {
              mailboxId: mb.id,
              reason: "this install was asked to stop organizing this mailbox and the server never "
                + "confirmed its record was removed; the record has now been stale for longer than "
                + "any install honours one, so the organizing here is recorded as ended — the claim "
                + "ages out of the folder on its own, and this install reads from now on",
            });
          } else {
            log("organizer_released", {
              reason: "the person stopped organizing this mailbox here; this install keeps its login, "
                + "its poll timer, its credentials and its mirror, and reads the mailbox from now on",
            });
          }
          return false;
        }

        /* A reader with no press never enters the gate — and it looks. This replaces
         * `if (priorStandDown && !takeoverAuthorized) return false;`, changing where the answer
         * comes from (the row, not RAM) and what happens on the way out: the old arm returned
         * without peeking, so a demoted desktop's holder columns froze at the handover and a
         * second handover was invisible. `notePeekedHolder` is the APPEND-less read — one
         * method, no way to write — so the reader learns who holds the mailbox every poll and
         * still cannot claim it. A live press outranks the role: the press is the explicit
         * human action this arm waits for, and the stamp is re-read above precisely so a press
         * that landed after assembly is seen.
         */
        /* Handed back — and the refusal is ahead of the lease read. `runLeaseGate` does not
         * merely report: on an empty `ohmail/_meta` it APPENDS this install's claim, so asking
         * it at all is already taking the mailbox — a check placed after it would re-claim the
         * very mailbox this install just gave back (measured as a poll landing behind a
         * hand-back). Above the reader arm because it is not about roles: the row still says
         * organizer and is meant to, so `resume()` can promote with no press.
         * `notePeekedHolder` is skipped too — a phone about to be suspended has no pane to feed.
         */
        if (handedBack) {
          organizer = { ...organizer, organizing: false };
          return false;
        }
        if (!rowRead || (rowRole === "reader" && !takeoverAuthorized)) {
          if (!rowRead) {
            log("organizer_row_unreadable", {
              reason: "this pass could not read the row that says whether this install organizes "
                + "this mailbox, so it looks at the lease and claims nothing — an unreadable row "
                + "is not permission, and the next poll asks again",
            });
          }
          await notePeekedHolder(priorStandDown as MailboxDisabledReason | null);
          /* The answer and the cache agree, even when both reads failed. `notePeekedHolder`
           * carries the previous record on its catch — correctly, a failed look is not
           * evidence — but this arm is also reached when the ROW read failed, and then nothing
           * had set `organizing`: it kept the last good answer, `true`, while this function
           * returned false — and `drain` decides organizer-only work from that field, so the
           * pass that could not establish its role ran as the organizer. The pass is not
           * organizing, so the field says so; `unreadableSince` is what tells a person the
           * difference between "nothing organizes this" and "we could not look". */
          /* AND NOT OURS. A row that says reader is an instruction, and a row that could not be
             read is not permission — neither may leave a stale `claimed` standing for the phone's
             background arm to start a notification on. */
          organizer = { ...organizer, organizing: false, claimed: false };
          /* And cache the organizer's settings document, once per reader cycle (mail 0094). A
           * reader's own responder/rule/window/signature rows are inert: the ones in force are
           * in the published document of the install that HOLDS this mailbox — the panes used
           * to render the local rows anyway, and the reader now keeps a copy that
           * `GET /mailboxes/:id/profile` serves. Only on the reader arm, and only when the row
           * actually says `reader`: unlike the bounded peek this read fetches full message
           * sources, a cost with nothing behind it on a mailbox whose role is unknown; the
           * pre-consent arm is excluded because nobody agreed to that mailbox. Never throws —
           * `syncProfileMirror` owns that: one poll stale beats an invented absence. */
          if (rowRole === "reader") {
            /* PROBED, not asserted — `notePeekedHolder`'s exact shape for `leasePeekIo`. `profileIo`
               is not on `MailboxAdapter`: it is an accessor the real IMAP adapter carries and a test
               double need not, so an adapter without it is SKIPPED rather than crashing a sync
               cycle over a cache. */
            const mkIo = (adapter as Partial<{
              profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
            }>).profileIo;
            if (typeof mkIo === "function") {
              await syncProfileMirror({
                db, accountId: world.accountId, mailboxId: mb.id,
                /* A NAMED READER IDENTITY, not this install's own. `readOrganizerProfile` remembers
                   a position per identity, and borrowing the organizer write-behind's would let a
                   read and a write share one anchor — the API's profile reader makes the same split
                   for the same reason. */
                io: mkIo.call(adapter, { installId: "reader-profile-mirror", mailboxId: mb.id }),
                now: now(), log,
              });
            }
          }
          return false;
        }
        /* Nobody has agreed to this yet, so this install reads and arranges nothing. AHEAD of
         * the lease read — the ordering is the whole guard: `runLeaseGate` APPENDS a claim on
         * an empty folder, so asking it is already taking the mailbox. Measured without this: a
         * person typed a password and six seconds later their backlog had been moved into six
         * new folders, the consent screen reachable only afterwards. `!takeoverAuthorized` is
         * what makes the flow work rather than deadlock: the consent route writes
         * `organize_consented_at` and `takeover_authorized_at` in ONE transaction, so the first
         * pass after "Agree" promotes. `organizer` IS set here (`drain` gates organizer-only
         * work on it); `reason` is NULL — no holder to name; `priorStandDown` is NOT set. */
        if (!consented && !takeoverAuthorized) {
          organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null,
            releaseRequestedAt: releaseStamp, claimed: false };
          await notePeekedHolder(null);
          return false;
        }
        /* What this claim offers a reader (mail 0090): `requests`, but only where a shared
         * secret exists to verify one with. The key is HKDF over the MAILBOX PASSWORD — the one
         * secret this install and the hosted worker both hold, and one that whoever can merely
         * APPEND to `ohmail/_meta` does not — derived from the credential this process already
         * opened IMAP with, never stored or fetched; deriving needs no network, so both
         * directions of the channel are available on equal terms with Cloud. `null` for an
         * OAuth mailbox: each install holds its own token, so there is no shared secret — the
         * claim advertises nothing and a reader is refused honestly at its own door.
         */
        /* ══ THE CLAIM IS OURS FROM HERE ═══════════════════════════════════════════════════
         *
         * Reaching this line means the row says organizer and somebody consented — the instruction
         * the claim below carries out. It is set HERE and not with `organizing` two awaits down
         * because the lease read APPENDS the claim to `ohmail/_meta` and the permit is a second
         * round trip: between them a caller reading `organizing` sees exactly what it sees for a
         * mailbox nobody has consented to, and the phone's background arm gave that reading back.
         * A pass that goes on to stand down or to yield clears it below.
         */
        organizer = { ...organizer, claimed: true };
        /* Captured once so the renewal memory records the SAME instant the gate writes into the
           claim's heartbeat — the lapse bound below compares against what a reader of the folder
           can actually see, not against a second clock reading taken after the round trip. */
        const gateAskedAt = now();
        const leaseArgs = {
          adapter,
          mailboxId: mb.id,
          self: {
            installId, kind: organizerKind, displayName: machineName, lastNonce: leaseNonce,
            /* BOTH VALUES: an install recognises its own claim whatever happened to the response. */
            pendingNonce: leasePendingNonce,
          },
          hasRequestKey: requestKey !== null,
          // An explicit human choice, and the ONLY thing that distinguishes "this mailbox's last
          // organizer went quiet" from "the user wants this machine to have it". Without it the
          // lease reports such a mailbox as available and declines to take it, which is the right
          // default and the wrong answer once somebody has actually asked.
          //
          // THE INSTANT, and it is `observedTakeoverAt` rather than a fresh clock reading: the
          // stamp this pass actually read is the one it may act on, and it is the same value the
          // stand-down below compares against before voiding anything. A `now()` here would make
          // every press look like it happened at the moment of the gate — so a stale press that
          // ought to lose rule 6 would win it, on every cycle, for ever.

          // AND THE VERB, which lets rule 6 refuse a press that asked only to JOIN a mailbox
          // another install is organizing. Read in the same statement as the instant.
          takeover: takeoverAuthorized && observedTakeoverAt !== null
            ? { authorizedAt: observedTakeoverAt, intent: observedIntent }
            : null,
          ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          log,
        };
        const outcome = await readMailboxLease({ ...leaseArgs, now: gateAskedAt });
        if (outcome.organize) {
          leaseNonce = outcome.nonce;
          /* THE ANSWER ARRIVED, so nothing is pending — the widening is one value and it is dropped
             the moment the write it covers is acknowledged. */
          leasePendingNonce = null;
          /*
           * THE ROW FOLLOWS THE CLAIM, WITH NOTHING BETWEEN THEM. `readMailboxLease` has just said
           * ORGANIZE, so this install's claim stands in `ohmail/_meta` and is verified there. From that
           * instant to the row saying `organizer` nothing else may be awaited: measured here, the
           * promotion sat behind `acquireLeasePermit`'s `stampMeta`, an IMAP STATUS worth ~83 ms, and
           * for that window the folder advertised this install as organizer while its own row — the one
           * every write door consults — still said `reader`. The promotion is issued here and the permit
           * taken after it; the permit adopts this same read, and the folder reading it already took, so
           * a take-over landing in this gap cannot reach the permit's baseline.
           */
          // THE MEMORY IS SPENT WITH THE STAMP. Reaching here past a remembered stand-down means a
          // human pressed the button and the lease agreed; leaving the memory set would make the
          // very next poll return false for an install that IS the organizer — it would drain as a
          // reader against a row that says `organizer`, which is the two halves disagreeing in the
          // other direction. See {@link priorStandDown}.
          priorStandDown = null;
          if (takeoverAuthorized) {
            // Spend it — one becoming, not a standing right: leaving the stamp set would let
            // this install seize the mailbox back on a later launch after a human moved it
            // elsewhere. The stand-down is cleared in the same statement, here and nowhere
            // earlier: this is the moment `readMailboxLease` said ORGANIZE — a clear at
            // assembly would publish a `connected` mailbox to the send/schedule paths before
            // any lease read. `disabled_reason` is re-checked in SQL, not memory: a
            // `DELETE /mailboxes/:id` committing during the lease's round trip makes the row a
            // tombstone, and an unconditional write would revive it; the stamp is spent either
            // way. The write's read-back decides whether this launch organizes at all: finding
            // the tombstone, it organizes nothing and the appended claim ages out.
            try {
              const [after] = await db.update(mailboxes)
                .set({
                  status: sql`case when ${mailboxes.disabledReason} is not null then 'connected' else ${mailboxes.status} end`,
                  disabledReason: null,
                  takeoverAuthorizedAt: null,
                  /* The role, in the same statement as the stamp it spends. Without this the
                   * row still says `reader` for an install the lease just made the ORGANIZER,
                   * and `organizer_role` is the authority every write door consults: the
                   * install would move mail on IMAP while its own API refused every request
                   * with `409 organized_elsewhere`, naming itself. Unreachable before — until
                   * the stamp could be spent by a POLL, every promotion went through a relaunch
                   * where the role is written at assembly; arming the reader's loop made this
                   * path live, so it is repaired here.
                   */
                  organizerRole: "organizer",
                  // Mail 0088 — a mailbox organized here again is not a released one. The marker
                  // describes the CURRENT state, so the promotion ends it.
                  organizerReleasedAt: null,
                  /* And the holder columns go with the role (0.14.1). This block used to leave
                   * them for "the next cycle's own writes" — false for this shape:
                   * `notePeekedHolder` is the only later writer and it runs on the READER arm,
                   * which an organizer never reaches, so the stale holder stood until something
                   * demoted the install again. The hosted twin has cleared them in this same
                   * statement since mail 0083, for the governing reason: a row that says
                   * `organizer` while still naming who organizes it is a banner that contradicts
                   * itself — and once the notice landed, an organizer row naming a previous
                   * holder rendered "another install organizes this mailbox now" about itself.
                   */
                  organizedByKind: null,
                  // Mail 0092 — the sixth goes with the other five. A holder cleared in five
                  // columns and remembered in a sixth is the migrated row all over again.
                  organizedByInstallId: null,
                  organizedByName: null,
                  organizedSince: null,
                  organizerState: null,
                  // Mail 0089 — the fifth holder column goes with the other four, for the same
                  // reason: this row is now the organizer and names no holder at all.
                  organizedByCapabilities: null,
                  /* Mail 0088: the organizing situation just changed, so say when. The fourth
                   * of the five writers of the (role, state, holder) triple — the promotion
                   * half. A person watching another door is entitled to be told once that this
                   * install now organizes the mailbox. In the SAME statement as the role, on
                   * `markMailboxStoodDown`'s reasoning: a row whose role has moved while its
                   * event instant still describes the previous situation is a client rendering
                   * yesterday's sentence, with nothing anywhere to notice it.
                   */
                  organizerEventAt: now(),
                })
                .where(eq(mailboxes.id, mb.id))
                .returning({ status: mailboxes.status });
              takeoverAuthorized = false;
              if (!after || after.status === "disabled") {
                log("organizer_takeover_row_removed", {
                  reason: "this mailbox was removed while the organizer lease was being read, so " +
                    "this install organizes nothing and serves the mirror it already has; the " +
                    "claim it appended ages out of the mailbox on its own",
                });
                organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null,
                  /* The mailbox is gone; the claim this pass appended ages out of a folder nothing
                     will serve, so nothing may be started on the strength of it. */
                  releaseRequestedAt: releaseStamp, claimed: false };
                stopped = true;
                if (timer) clearTimeout(timer);
                if (heartbeatTimer) clearTimeout(heartbeatTimer);
                try {
                  await adapter.close();
                } catch (closeErr) {
                  log("adapter_close_failed", { err: closeErr });
                }
                return false;
              }
              /*
               * THE PROMOTION SAYS SO, AND IT SAYS SO HERE — ahead of `acquireLeasePermit` below.
               *
               * The failure half has had a line since it existed; without this one the ORDER that
               * paragraph above is about could only be read off a test fixture, and the fixture the
               * guard used measured the permit's `stampMeta` invocation, which the baseline move put
               * ahead of the row on purpose. Two product lines — this one and `lease_permit_granted`
               * — are the order itself. `state` and a constant sentence rather than `from`/`to`:
               * those two are address-shaped names this repository's logger does not admit.
               */
              log("organizer_row_promoted", {
                mailboxId: mb.id,
                state: "organizer",
                reason: "the lease said organize and this install's claim stands in the folder, so " +
                  "the row moved from reader to organizer before the permit was taken",
              });
            } catch (err) {
              /* THE ROLE WENT WITH THE STAMP, so this is not "one more spendable cycle": the write
               * that failed is the one that makes the row say `organizer`, and without it this
               * install holds the claim while its row still says `reader` — the state the statement
               * above exists to prevent, reported rather than left lying. `takeoverAuthorized` is
               * deliberately NOT cleared here (the clear is inside the try, after the write
               * resolved), so the stamp is still on the row and the next cycle promotes again. */
              log("organizer_promotion_failed", {
                err,
                mailboxId: mb.id,
                reason: "this install holds the organizer claim and its row could not be promoted, " +
                  "so the row still says reader; the authorization stays on the row and the next " +
                  "cycle writes it again",
              });
            }
          }
          // THE READ ABOVE IS THE PERMIT'S FIRST LOOK, adopted rather than repeated: the gate
          // renews this install's claim, so a second run here is the same-millisecond
          // self-stand-down `MIN_PERMIT_TTL_MS` refuses.
          // No TTL knob: one value for the fleet (`DEFAULT_PERMIT_TTL_MS`). A configurable window
          // beside a fixed believability cutoff is silently the smaller of the two.
          leasePermit = await acquireLeasePermit({
            ...leaseArgs, adopt: { outcome, at: gateAskedAt }, now,
            /* ── A RENEWAL THIS INSTALL PERFORMED IS THIS INSTALL'S CLAIM ─────────────────
             *
             * The permit re-reads past its deadline or its write count, and a re-read RENEWS:
             * new nonce in the folder, the old copy expunged. Held here, the old nonce made the
             * next gate read our own claim as a restored clone — this install stood ITSELF down
             * and left a live claim nobody was behind, refusing the next install for a staleness
             * window — and made `releaseOwnClaim` address a claim that no longer exists, so
             * "stop organizing here" released nothing. One writer owns the settled nonce.
             */
            onRenew: ({ nonce: renewed, at }) => {
              leaseNonce = renewed; leasePendingNonce = null; lastLeaseRenewalAt = at;
            },
            /* AND WHAT THE PERMIT MINTED, before the append that carries it — a renewal inside the
               permit whose answer is lost still leaves this install able to name what it wrote. */
            onNonceMinted: (minted: string) => { leasePendingNonce = minted; },
          });
          // The gate renewed this install's claim with `gateAskedAt` as its heartbeat — the fact
          // the release's lapse bound reads. See `lastLeaseRenewalAt`.
          lastLeaseRenewalAt = gateAskedAt;
          // Reading the lease is what proves it: a resolved gate clears the unreadable mark.
          organizer = { organizing: true, reason: null, heldBy: null, unreadableSince: null,
            releaseRequestedAt: releaseStamp, claimed: true };
          return true;
        }

        organizer = {
          organizing: false,
          reason: outcome.reason,
          heldBy: outcome.by?.displayName ?? null,
          /* DISPLACED. Another install holds the mailbox, so the claim is not ours to defend and
             not ours to give back. */
          claimed: false,
          // The lease WAS read to reach a stand-down, so whatever was unreadable no longer is.
          unreadableSince: null,
          releaseRequestedAt: releaseStamp,
        };
        // Standing down voids any unspent authorization, in memory and on the row below. We are not
        // the organizer, so becoming one again is a new becoming and needs a new explicit request.
        takeoverAuthorized = false;
        log("organizer_stand_down", {
          /* THE MAILBOX THIS VERDICT IS ABOUT. A stand-down is a per-mailbox decision and this
             line named none, so on an install holding more than one mailbox the log could not say
             which one had changed hands — an incident nobody can read off the record it leaves.
             The id and never the address: this is a log. */
          mailboxId: mb.id,
          disabledReason: outcome.reason,
          heldBy: organizer.heldBy,
          // `state` and NOT `organizerState`, which is the name this line shipped with and which
          // `ALLOWED_FIELDS` drops — so the stand-down line reported `droppedFields` and said
          // nothing about the state it exists to name. `reconcile-cron.ts:259` already carries the
          // same correction in the same words for the same value on the hosted door.
          state: outcome.state,
          // HOW THE HOLDER RELATES TO THIS INSTALL — see {@link ownClaimTerm}. Anything but
          // `install_id` on this line is an install standing down from a claim of its own.
          ownClaimTerm: ownClaimTerm(outcome.by, installId, leaseNonce),
          reason: "another organizer holds this mailbox; this install becomes a READER of it — it " +
            "keeps its login and its poll timer, its mirror goes on growing, it can mark mail read " +
            "and send, and it moves, files and deletes nothing",
        });
        /* The handover rides the demotion's transaction, and the latch rides its success.
         * Three separate statements left two sequences open: a paired device's forwarded move
         * committing after the handover read its pending set and before the demotion —
         * accepted, then neither performed nor exported; and a swallowed handover failure with
         * the latch set anyway — the transition gate skipping the handover for ever. One
         * transaction, latch only on commit: `exportPendingMovesOnStandDown` takes `FOR UPDATE`
         * on the row first, `assertOrganizerRole` takes `FOR SHARE` inside the transaction
         * recording a forwarded move — no admitted intent missed, none admitted afterwards. On
         * the transition only: an ungated export would mint a request per poll.
         */
        const wasOrganizing = priorStandDown === null;
        try {
          /* The role, not the status. Writing `status: "disabled"` stopped the install: timer
           * cleared, login closed, mirror frozen at the handover — the earlier dual-mode design,
           * replaced by the 2026-09-01 owner ruling (the doc is amended in the same commit). A
           * demoted install is a READER: `connected`, on its own roster, the four holder columns
           * written from the SAME verdict that demoted it, so the row names who holds the
           * mailbox without any client dialling IMAP. `disabled_reason` is deliberately not
           * written any more: `disabled` means tombstone or plan-disable, full stop, and a
           * reader carrying a stand-down reason would be a row saying two things about itself.
           */
          const handed = await db.transaction(async (tx) => {
            const exported = wasOrganizing
              ? await exportPendingMovesOnStandDown(tx as unknown as Tx, {
                accountId: world.accountId, mailboxId: mb.id, now: now(), mintId: randomUUID,
              })
              : null;
            await tx.update(mailboxes)
            .set({
              organizerRole: "reader",
              // Mail 0088 — BEING BEATEN IS NOT RELEASING. A row carrying both would report the
              // quieter of the two events to a person whose mailbox somebody else has just taken.
              organizerReleasedAt: null,
              /* THROUGH THE WRITE DOOR, because the middle term is a word cut out of a reason
                 string and this store has no CHECK to catch it: `organized_by_kind` is widenable,
                 so the device's refusal is `organizerKindColumn` and nothing else. An unrankable
                 peer becomes `unknown`, which every reader downstream fails closed on. */
              organizedByKind: organizerKindColumn(outcome.by?.kind ?? outcome.reason.split(":")[1]),
              /* Mail 0092 — AND DELIBERATELY NO INSTALL ID HERE. The kind above falls back to a word cut
                 out of a reason string; an identity manufactured that way, in a column a release decision
                 is made on, would satisfy the compare and never refresh — a fabrication that outranks the
                 NULL it replaced. The verdict carries no id for the winner, so the column stays NULL, and
                 NULL fails closed, which is the safe direction. Do not "complete" this by deriving one. */
              // Header-safe and capped at the write — this is another install's machine name,
              // arriving out of an RFC822 header it wrote.
              organizedByName: organizerDisplayName(outcome.by?.displayName ?? null),
              organizedSince: outcome.by?.claimedAt ?? null,
              organizerState: outcome.state,
              // Mail 0089 — the fifth holder column, from the SAME verdict.
              organizedByCapabilities: capabilitiesColumn(outcome.by?.capabilities ?? null),
              /* THE STAMP THIS PASS READ, and only that one — see {@link observedTakeoverAt}. A
                 press that landed while the lease was being read was never offered to it, and
                 clearing it here would answer a request nothing ever considered. `IS NOT DISTINCT
                 FROM` rather than `=` so the ordinary case (both NULL) matches: SQL equality on two
                 NULLs is NULL, which would make this a no-op on every stand-down that had no stamp
                 and leave the column's own value untouched — harmless there, and the wrong shape to
                 rely on. */
              takeoverAuthorizedAt: sql`case when ${mailboxes.takeoverAuthorizedAt} is not distinct from ${dialect(db).tsOrNull(observedTakeoverAt)}
                then null else ${mailboxes.takeoverAuthorizedAt} end`,
              // Mail 0088 — the demotion half, and the fifth writer of the triple. Stamped in the
              // same statement as the role and the holder columns it is announcing.
              organizerEventAt: now(),
            })
            .where(eq(mailboxes.id, mb.id));
            return exported;
          });
          /* THE LATCH, AFTER THE COMMIT. A reader keeps polling, so without it the next cycle
             would ask the lease again and take the mailbox back the moment the other organizer
             released it — and setting it before the write meant a failed write silently retired
             the handover with it. See {@link priorStandDown}. */
          priorStandDown = outcome.reason;
          if (handed !== null && (handed.exported > 0 || handed.unmappable > 0)) {
            log("organizer_stand_down_moves_handed_over", {
              mailboxId: mb.id,
              exported: handed.exported, already: handed.already, unmappable: handed.unmappable,
              reason: "these moves were recorded here before the lease was read again; each is now "
                + "a request for the install that holds the mailbox. `unmappable` are intents this "
                + "handover cannot express — a desired folder no destination word covers, or a "
                + "message with no usable dedup key — and they stay pending exactly where they are",
            });
          }
        } catch (err) {
          log("organizer_stand_down_write_failed", {
            mailboxId: mb.id,
            err,
            reason: "neither the demotion nor the handover of pending local moves was recorded, so "
              + "the row still says this install organizes the mailbox; this install reads it "
              + "regardless and the next cycle demotes and hands over again",
          });
        }
        // And the appointments this install can no longer keep are closed, here.
        // `sendScheduled()` is inside `drain`, and `drain` is behind this gate — from the line
        // below, the scheduled-send pass never runs on this install again, so everything it
        // owed is owed now or never: the appointment does not travel (the portable profile
        // carries no drafts), and `SCHEDULED_SEND_EXPIRY_MS` is enforced inside that
        // unreachable pass. Without this call a pending scheduled send is never delivered,
        // never reported failed, and Drafts says "Sends Tue 14:50" for a time that has gone,
        // for ever (measured; see `closeStoodDownAppointments`). Not folded into the
        // stand-down UPDATE: different owners, different failure answers — a stand-down must
        // never be contingent on closing an appointment; a failed close is retried at launch.
        await standDownAppointments(outcome.reason);
        /* The timer and the login stay. The three statements that followed this line
         * (`stopped = true`, `clearTimeout`, `adapter.close()`) were the whole of "stops
         * syncing entirely"; they are gone from THIS path and kept for the two that still mean
         * it — a tombstone, and a removal discovered mid-launch. What replaces them is nothing:
         * `start()` continues and the next cycle is a READER cycle. The mirror keeps growing,
         * which is the product difference — a person who moved organizing to another machine
         * still reads, searches and sends from this one. `return false` still means "this
         * install is not the organizer"; it no longer means "and therefore do nothing".
         */
        return false;
      };

      /** Has this runtime already said it composes no scheduled-send pass? See `sendScheduled`. */
      let noAppointmentsLogged = false;

      /**
       * Keep the send-later appointments this install made (mail 0077) — the standalone door's copy of the
       * clock the hosted deployment runs every minute. The same ONE implementation (`runScheduledSendPass` in
       * `@trafficflow/services`): the claim, the recovery arm and the outcome table must agree with what the
       * schedule verbs promised, or two hosts would disagree about one row. Only the transport differs —
       * `openLocalSend`, the exact adapter a manual send from this door dials — and the storage cap is this
       * tier's typed UNMETERED. On the drain cadence rather than a timer, the honest reading of "sends at
       * 9:00" on a door that exists only while the app is open: an appointment due while the app is closed
       * sends on the next launch's first drain. Failures are contained.
       */
      /**
       * @param gen  the connection generation the caller gated under, and @param conn the adapter
       *   instance it belongs to. Threaded in rather than read from the closure because this pass
       *   OUTLIVES a cycle: it is the caller's identity that decides whether a delivery is still
       *   this install's to make, and the closure's binding is exactly the thing that moves.
       */
      const sendScheduled = async (gen: number, conn: MailboxAdapter): Promise<void> => {
        /* ── AND NOT ON A COMPOSITION THAT KEEPS NO APPOINTMENTS ──────────────────────────────
         *
         * `composition-passes.ts` decides; a phone is the composition it excludes. The refusal is
         * HERE rather than at the drain's call site because `reader-drain.test.ts` reads that line
         * literally (`if (organizing) await sendScheduled(...)`) to prove the pass stays
         * organizer-only, and a second conjunct there would retire that guard silently.
         *
         * Once per runtime, not once per drain: a line on every poll would bury the one that says
         * something happened. `runScheduledSendPass` is never entered, so nothing is claimed. */
        if (!runsPass(organizerKind, "scheduled-send")) {
          if (!noAppointmentsLogged) {
            noAppointmentsLogged = true;
            log("scheduled_send_pass_not_composed", {
              kind: organizerKind,
              reason: "this install keeps no send-later appointments, so no due appointment was "
                + "claimed or sent on this drain and none will be; the schedule verb refuses to "
                + "make one here, and mail keeps arriving",
            });
          }
          return;
        }
        try {
          const r = await runScheduledSendPass(db as never, {
            /* ── THE PASS STOPS IF THIS MAILBOX STOPS BEING OURS WHILE IT RUNS ─────────────
             *
             * Checked BETWEEN ROWS rather than once before the pass, because the change this
             * defends against happens DURING it: the socket dies, a re-dial re-reads the lease
             * and finds a stranger's claim, and this loop is still holding appointments it
             * claimed under the old answer. One check at the top cannot see that; it has already
             * returned by the time it matters.
             *
             * `stopped` is in the predicate for the same reason — a removed mailbox must not go
             * on sending on its own behalf while `detach()` waits for the pass to end. */
            cancelled: () => stopped || gen !== generation || conn !== adapter,
            openSendAdapter: openLocalSend,
            /* This mailbox's appointments only. The pass scans the whole store, which equalled
             * "this mailbox" when an install held one; with several, an unnarrowed scan would let
             * an organizing mailbox claim and SEND an appointment belonging to a mailbox this
             * install merely reads. The gate is per runtime, so each organizing mailbox keeps its
             * own and a reader's are left for whoever organizes it. */
            mailboxIds: [mb.id],
            resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
            now,
          });
          if (r.claimed > 0) {
            log("scheduled_send_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              failed: r.failed, deferred: r.deferred,
            });
          }
        } catch (err) {
          log("scheduled_send_pass_failed", {
            err,
            reason: "no due scheduled send was attempted this drain; the appointments stand and " +
              "the next drain claims them again, and mail continues to arrive either way",
          });
        }
      };

      /**
       * The away responder, on the door that only exists while the window is open (mail 0087). The same ONE
       * implementation the hosted API host runs (`runAwayResponderPass`): the reservation, the per-sender
       * throttle and the ledger must agree across every host, or two installs organizing one mailbox at
       * different moments would answer a correspondent twice. Only the transport differs (`openLocalSend`).
       * The promise is honest: replies go out while ohmail is open on this computer, and the settings pane
       * SAYS SO; overnight mail is answered on the next launch's first drain, bounded by the throttle.
       * Organizer only, twice over: the gate stops a reader spending a drain, the JOIN inside the pass makes
       * it impossible. `mailboxIds: [mb.id]` — each mailbox keeps its own.
       */
      /**
       * @param gen  the connection generation the caller gated under, @param conn the adapter
       *   instance it belongs to, and @param permit the organizer lease those two were gated on.
       *   All three threaded in rather than read from the closure because this pass OUTLIVES a
       *   cycle: it is the caller's own authority that decides whether a delivery is still this
       *   install's to make, and the closure's bindings are exactly the things that move.
       */
      const answerAway = async (
        gen: number, conn: MailboxAdapter, permit: OrganizerWriteAuthority,
      ): Promise<void> => {
        /** Set by the refusal below, read by `cancelled` so the pass ends where it stands. */
        let leaseLost = false;
        /* ── THE SEND BOUNDARY ASKS THE LEASE, BECAUSE THE CONNECTION ANSWERS SOMETHING ELSE ──
         * Choosing another organizer mid-pass leaves THIS socket open and healthy, so the
         * connection check admits every remaining reply and two installs answer one correspondent.
         * An away reply is irreversible mail sent in somebody's name, so the authority is re-asked
         * at the last point before delivery — `check()` is the permit's own bounded re-read — and
         * a refusal both refuses this send and ends the pass.
         * An UNREADABLE lease is not a stand-down: a read that throws leaves the receipt untouched
         * (`lease.ts`), so the permit's `revoked` latch decides and an outage lets mail flow.
         */
        const refuse = (): void => {
          leaseLost = true;
          log("away_responder_stood_down", {
            mailboxId: mb.id,
            reason: "another install holds this mailbox now, so this automatic reply was not sent "
              + "and the pass ends here; the install that holds it answers the same message from "
              + "its own pass, and mail continues to arrive either way",
          });
        };
        const askLease = async (): Promise<void> => {
          if ("check" in permit) {
            try {
              await permit.check();
              return;
            } catch (err) {
              if (!leaseStoodDown(permit)) return;
              refuse();
              throw err;
            }
          }
          refuse();
          throw new Error("no organizer lease permit authorises this away reply");
        };
        const sendUnderLease: OpenSendAdapter = async (
          mailboxId: string,
        ): Promise<SendAdapter> => {
          const sender = await openLocalSend(mailboxId);
          /* SPREAD, never a hand-written literal: a method this door forgets to name does not
             exist to the pass, which is how `forceClose` was silently lost at the sibling seam. */
          return { ...sender, send: async (msg) => { await askLease(); return sender.send(msg); } };
        };
        try {
          const r = await runAwayResponderPass(db as never, {
            /* ── THE PASS STOPS IF THIS MAILBOX STOPS BEING OURS WHILE IT RUNS ─────────────
             *
             * Checked BETWEEN ROWS rather than once before the pass, because the change this
             * defends against happens DURING it: the socket dies, a re-dial re-reads the lease
             * and finds a stranger's claim, and this loop is still holding appointments it
             * claimed under the old answer. One check at the top cannot see that; it has already
             * returned by the time it matters.
             *
             * `stopped` is in the predicate for the same reason — a removed mailbox must not go
             * on sending on its own behalf while `detach()` waits for the pass to end. */
            cancelled: () =>
              stopped || gen !== generation || conn !== adapter
              || leaseLost || leaseStoodDown(permit),
            openSendAdapter: sendUnderLease,
            mailboxIds: [mb.id],
            now,
          });
          if (r.examined > 0) {
            log("away_responder_pass", {
              accounts: r.accounts, examined: r.examined, sent: r.sent,
              unverified: r.unverified, throttled: r.throttled, suppressed: r.suppressed,
              deferredAccounts: r.deferredAccounts, deferredCandidates: r.deferredCandidates,
              capped: r.capped, refusedErased: r.refusedErased,
            });
          }
        } catch (err) {
          log("away_responder_pass_failed", {
            err,
            reason: "no away reply was attempted this drain and no candidate was decided; the " +
              "next drain re-reads the same window, and mail continues to arrive either way",
          });
        }
      };

      /**
       * Settle a send this install started and never finished — the same implementation the
       * hosted host and self-host clock run. Deliberately NOT gated on organizing: it resolves
       * THIS install's own `pending` reservation (a Sent-folder read plus a compare-and-swap on a
       * row nobody else owns), so gating would strand someone demoted to reader between send and a
       * crash with a draft stuck "Sending…" (`send-reconcile-drain.test.ts`). No account filter —
       * a standalone store holds one account. The adapter is wrapped so `send` throws: a
       * structural proof this hook cannot deliver a second copy.
       */
      const reconcileStrandedSends = async (): Promise<void> => {
        try {
          const r = await runSendReconcilePass(db as never, {
            openSendAdapter: openLocalSend,
            /* NO account filter, and none is available: the pass is store-wide by design, exactly
               like the scheduled sender it settles for. That is correct on this door for a reason
               the hosted host does not have — a standalone store holds ONE account, so store-wide
               IS this install's own reservations. */
            now,
          });
          if (r.claimed > 0) {
            log("send_reconcile_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              deferred: r.deferred, resolvedElsewhere: r.resolvedElsewhere, gaveUp: r.gaveUp,
            });
          }
        } catch (err) {
          log("send_reconcile_pass_failed", {
            err,
            reason: "no stranded reservation was resolved this drain; every row stays exactly as " +
              "it was and the next drain looks again — the pass never sends, so a failure here " +
              "cannot have delivered anything",
          });
        }
      };

      /**
       * The drain itself. Never called from outside this closure, and — since the mailbox-removal design — reached
       * by a READER as well as by an organizer; the `organizing` the GATE handed this pass is what
       * separates them, both for the passes below and for the `role` every cycle runs under.
       */
      /**
       * @param gen  the connection generation the caller read the organizer lease under. Every
       *   step below that WRITES to the mailbox re-checks it, and the drain abandons itself with
       *   {@link ConnectionReplacedError} rather than continuing over a connection it never gated.
       * @param conn the adapter instance that generation belongs to. Passed as a VALUE and spread
       *   over `syncDeps` for each cycle, so that even inside one cycle a re-dial cannot move the
       *   mail: the pipeline writes to the connection whose lease this pass read, or it fails.
       * @param organizing THE ROLE THE GATE READ FOR THIS PASS, passed as a value for the reason
       *   `gen` and `conn` are. It used to read `organizer.organizing` — a field that outlives the
       *   gate and that a stop, a hand-back or a failed poll rewrites mid-pass, so two readers
       *   inside one pass could disagree, and a pass that could not establish its role at all
       *   depended on the gate's unreadable arm having written the cache before the drain read it.
       *   One reading per pass; the cache is re-established at the NEXT pass's gate.
       */
      /**
       * THE KNOWN-SET MEMO, ONE PER ATTACHMENT — `apps/worker/src/known-set.ts`, on this door.
       * Without it every idle cycle re-read every locator this mailbox holds. DIRTY BY DEFAULT:
       * the proxy drops it on every repo method not classified neutral, `runSyncCycle` on any
       * throw. Two legs hold it here — this process holds an EXCLUSIVE lock on the data directory,
       * so nothing else can write the projection; and the app's own routes share the store without
       * going through the cycle's repo, so the change-log mark {@link changeLogMark} is the
       * comparison. The one writer with no change row is the removal wipe, which runs after the
       * runtime has left the roster, so this memo dies with the attachment that owns it.
       */
      const knownSet = new KnownSetCache(mb.id);
      /** The change-log mark this runtime's last drain left behind; `null` is an unknown. */
      let knownSetMark: string | null = null;

      const drain = async (
        maxCycles: number, gen: number, conn: MailboxAdapter, organizing: boolean,
      ): Promise<number> => {
        // The marker-surfacing preflight, at the top of the drain both doors share. Routing no
        // longer depends on it (`importDecisionOpenNow` re-evaluates each cycle) but the confirm
        // surface does: the hold it offers is readable only through the durable marker this
        // preflight writes; without it a takeover could route in hold mode with no candidate on
        // screen and no release. One folder read per pre-seed entry, nothing once seeded or held.
        // ORGANIZER ONLY — a reader has nothing to inherit and never arms the hold.
        /* THE CONNECTION CHECK SITS ABOVE THE ROLE CHECK, on its own line, and both of those
           facts matter. Above, because a pass whose connection has been replaced is stale
           whatever role it holds — a reader cycling over a dead socket is the wedge too. On its
           own line, because `reader-drain.test.ts` reads THIS FILE and requires the role gate to
           be literally `if (organizing) await …`: a source census cannot see through a
           brace, and folding the two together would silently retire a guard that exists to keep
           an organizer-only mailbox write off a reader's drain. */
        assertSameConnection(gen, conn);
        if (organizing) await profileSync.armHoldFromFolder();
        // BEFORE the cycles, not after: a resurface is a local database fact and does not depend on
        // the mailbox being reachable, so it must survive a cycle that throws on a dead connection.
        /* THE INSTALL'S OWN WORK, ONCE. See {@link onceForTheAccount}: another mailbox's drain that
         is already doing this is doing it for everybody. */
      await onceForTheAccount(resurfaceDue);
        // Due appointments next, ahead of the cycles: a scheduled send has a clock and must not
        // wait out a backlog drain nor be skipped by an inbound cycle's throw (its SMTP dial fails
        // independently and the pass re-arms the row). ORGANIZER ONLY, per `SyncDeps.role`: a
        // stand-down's close of appointments it can no longer keep is best-effort, so a due one
        // can survive into a reader launch, and an ungated pass would claim and SEND it from an
        // install the mailbox's organizer knows nothing about, at a time nobody re-chose.
        assertSameConnection(gen, conn);
        if (organizing) await sendScheduled(gen, conn);
        // The away responder, directly after the appointment clock and gated the same way. AFTER
        // the cycles would be wrong for the reason the placement note above gives about
        // `sendScheduled`: an away reply has a clock on it too — it is a promise about mail that
        // has just arrived — and it must not wait out a hundred-cycle backlog drain. Its own SMTP
        // dial fails independently of the inbound cycles, and the pass contains its own faults.
        /* ITS OWN CHECK, not the one above `sendScheduled`. The scheduled-send pass sits between
           them and can take a long time — a batch of deliveries, each with its own dial — so by
           the time this line is reached the connection may have been replaced twice over. A guard
           six lines up is a guard about a different moment. */
        assertSameConnection(gen, conn);
        if (organizing) await answerAway(gen, conn, leasePermit);
        /* AND THE RECONCILER — UNGATED, unlike the two lines above it. See its own note: those two
           SEND on the mailbox's behalf and a reader must not; this one settles a reservation THIS
           install wrote, by reading. Gating it would leave a demoted install saying "Sending…" for
           ever, since no other install holds that reservation. After the sender, because the
           sender is the only thing on this door that creates one. */
        await reconcileStrandedSends();
        let cycles = 0;
        /** Did a cycle report an empty backlog, or did the loop simply run out of cycles? */
        let drained = false;
        /** The INBOUND half alone — did any cycle report an empty adapter backlog? The import
            stamp below reads THIS, never `drained`: `initial_import_completed_at`'s contract (and
            the hosted worker's behaviour) is "the inbound backlog emptied", independent of any
            outbound filing the reconciler still owes — a re-opened delete filing or a budget-capped
            queue must extend the DRAIN without withholding the import stamp. */
        let inboundDrained = false;
        // ── ONCE PER DRAIN, BESIDE THE LEASE AND FOR THE SAME REASON ───────────────────────────
        //
        // A drain is one logical pass over a backlog the adapter hands over in bounded batches, and
        // the posture it is filed under must be one posture: re-reading between two batches would
        // let a mailbox change its mind halfway through its own backlog. It is NOT hoisted into
        // `syncDeps` above, which is built once per process — that would freeze the posture for the
        // life of the engine, so an edit in Settings would need a relaunch to take effect.
        const screening = await screeningNow();
        /* WHEN THIS DRAIN BEGAN, for the first-import clock. A drain is up to a hundred cycles, and
           the one that finds a first import open lands a large mailbox's first pages before it
           reports — 13.7 minutes of a 47.4-minute import on the reference rig, which the reported
           duration used to leave out. `performance.now()`, matching the reporter's own clock. */
        const passStartedAt = performance.now();
        // Per-cycle wall durations, summarized into one `sync_drain` line below — the read that
        // attributes desktop CPU and quit lag to the pipeline. `Date.now()` deliberately, not the
        // injected `now()`: a test may freeze that clock, and a frozen clock would report every
        // cycle as 0 ms.
        const cycleMs: number[] = [];
        /* WHAT THIS DRAIN DID, counted — the reading behind the idle-cost gates below. `census`
           is the shared loop's own (mailbox-sized derivations, the rows they walked, and what the
           adapter handed over); `checkpoints` is this file's. Both are folded into `sync_drain`,
           so a settled mailbox's poll says in one line whether it did anything at all. */
        /* Zeroed here rather than through a helper, for the import rule above: the TYPE still
           comes from the loop, so a counter added there stops this line compiling — which is the
           direction that keeps a census honest. */
        const census: CycleCensus = {
          cursorBuilds: 0, locatorReads: 0, locatorRows: 0, cursorFolders: 0, observed: 0,
        };
        let checkpoints = 0;
        /* WHERE THE CHANGE LOG STOOD WHEN THIS DRAIN BEGAN — the comparison BOTH gates below
           take, read here and not at the caller because the lease gate writes `ohmail/_meta`
           between the two. One indexed aggregate per drain. The memo's drop is the first gate:
           the app's own routes write this store without going through the cycle's repo, and each
           writes a change row. It is RECORDED at the drain's end as the value read HERE — a route
           that wrote while the drain ran would otherwise be folded into the end reading and drop
           nothing. An unreadable mark is an UNKNOWN and takes the drop path. */
        const markAtStart = await changeLogMark();
        if (markAtStart === null || knownSetMark === null || markAtStart !== knownSetMark) {
          knownSet.drop("the store moved outside the drain");
        }
        while (!stopped && cycles < maxCycles) {
          /* THE REFUSAL, AT EVERY CYCLE EDGE. A drain runs for up to a hundred cycles and each
             one moves mail, so the question "is this still the connection I gated?" has to be
             asked repeatedly rather than once at the top. Between two edges the pipeline writes
             to `conn` — the instance, spread below — so a swap cannot redirect a cycle that is
             already running either. */
          assertSameConnection(gen, conn);
          const cycleStart = Date.now();
          // The model is resolved once per cycle and never held: `classifierForCycle()` answers
          // `undefined` with no verified model or after repeated faults, so `planChange`'s
          // `classifier &&` short-circuits to rules — the floor between "a suggestion is missing"
          // and "mail stopped arriving". Holding the port across that transition would stall the
          // mailbox behind the first message rules could not settle. `hasBacklog` (inbound the
          // adapter owes) and `owesFiling` (outbound the reconciler owes — budgeted filing, or a
          // delete whose park re-opened a row) are BOTH "is there more to do": stopping on backlog
          // alone declared quiet with a move pending and left a delete unfinished until next poll.
          /* Accounted per cycle, not per drain. The bound was once recorded around the whole
           * `drainPass` (up to a hundred cycles), so a flapping socket miscounted: served cycles
           * that should have ended an outage did not, and a later death advanced the streak from
           * where it stood rather than from one. So a COMPLETED cycle clears the streak and a
           * connection-class failure inside the loop starts its own; the wrapper around `drainPass`
           * still covers failures OUTSIDE the loop — the gate most of all. */
          let cycleServed = false;
          let hasBacklog: boolean;
          let owesFiling: boolean;
          try {
            /**
             * THE CYCLE RUNS IN THE INGEST LANE, and every statement it issues inherits it.
             *
             * This is the only place the name is given: `store-lanes.ts` schedules the one PGlite
             * connection between the mail coming in and everything else asking for it, and an
             * async context is how a statement six calls deep says which it is without every repo
             * method growing a parameter. Unnamed work is interactive, so the reverse mistake —
             * a window's read counted as ingest — is not reachable from here.
             */
            const outcome = await inStoreLane("ingest", async () => runSyncCycle({
            ...syncDeps,
            census, knownSet,
            /* THE GATED CONNECTION, spread over `syncDeps`'s live getter on purpose. The getter is
               what lets a re-dialled mailbox use its new connection; this is what stops a drain
               that is ALREADY RUNNING from being handed one. Both are needed and they are not in
               tension: the getter serves the next pass, this serves the current one. */
            adapter: conn,
            ...screening, classifier: ai.classifierForCycle(),
            // Mail 0083. THE ROLE THE GATE ANSWERED FOR THIS DRAIN, spread after `syncDeps` so it
            // wins: a demoted install keeps draining, and every cycle it runs from here is a READER
            // cycle — the mirror grows, `\Seen` is pushed, and nothing is moved, filed or created.
            // `organizing` is the gate's own answer for THIS pass, handed down rather than read
            // back off the engine, so a demotion or a promotion applies to the very next PASS.
            role: organizing ? "organizer" : "reader",
            // A demoted install keeps draining as a READER, and a reader holds no lease — its
            // `\Seen` push is the one verb it may write. Naming that here rather than passing the
            // spent permit is what keeps "no lease" and "not asked" apart at the write boundary.
            writeAuthority: organizing ? leasePermit : { noLease: "reader" },
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED from
            // the current facts at every cycle edge — never cached; see the worker's cycle for
            // the argument (many arm/release orderings were tried, each with a
            // mirror-image race). One `ohmail/_meta` FETCH per cycle; a store serialize and an
            // indexed read only when a foreign document is present; a faulted read answers what
            // the previous cycle answered.
            importDecisionOpen: await profileSync.importDecisionOpenNow(),
          }));
            cycleServed = true;
            ({ hasBacklog, owesFiling } = outcome);
          } catch (err) {
            /* ── A HAND-OVER IS A STATE CHANGE, NOT A FAILED DRAIN ──────────────────────────
             *
             * `runSyncCycle` makes a mid-cycle stand-down terminal and THROWS it, which the
             * hosted worker's callers need — `reconcile-cron.ts` answers that class with its own
             * stand-down bookkeeping. Here nobody above answers it: the throw reaches
             * `syncUntilQuiet`'s catch, which drops the idle ladder to base, the poll then logs
             * `sync_cycle_failed` and a press is refused in those words — "your sync failed" for
             * somebody moving organizing to their other machine, and the drain's own tail lost
             * with it. The cycle stopped writing at its page; this ends the DRAIN at that page.
             * Nothing is recorded here: the cycle has already written its `stood_down_mid_cycle`
             * verdict, the post-drain writes are refused by the permit's own last verdict, and
             * the next pass's gate re-reads the lease and answers reader — the one derivation of
             * that state. NOT `LeaseUnavailableError`: an unreadable lease is a question with no
             * answer, it keeps counting toward the connection bound, and it leaves as it did.
             */
            if (!(err instanceof OrganizerStandDownError)) throw err;
            break;
          } finally {
            if (cycleServed) noteCycleServed();
          }
          cycleMs.push(Date.now() - cycleStart);
          cycles++;
          if (!hasBacklog) inboundDrained = true;
          if (!hasBacklog && !owesFiling) { drained = true; break; }
          /* AND FOLD THE LOG IN PER CYCLE, NOT ONLY WHEN THE DRAIN ENDS. A first import is ONE
             drain of up to a hundred cycles, so the checkpoint below it bounded nothing while that
             ran: the log grows WITH the import — 14.8 KiB a message, linear, about a gigabyte over
             a large mailbox — and a kill in that window takes all of it. Reached only when there
             is MORE backlog, so a settled mailbox takes exactly the one checkpoint it always did.
             It does not cost, it PAYS: inside the ingest's relaxed transaction the checkpoint is
             the only flush there is, so an unfolded log leaves the buffer pool wholly dirty and
             every eviction writes a page and flushes ahead of it — 22.2 ms a message against 33.5
             and a peak of 8 MiB against 58, two reps in opposite orders
             (`test/rigs/checkpoint-churn-rig.mjs`). */
          await opened.checkpoint();
          checkpoints += 1;
          // Yield, so a backlog drain cannot starve the request handler sharing this event loop.
          await new Promise((r) => setTimeout(r, 0));
        }
        /* ONE LINE PER DRAIN, WRITTEN AT THE DRAIN'S END — a settled mailbox emits it every poll
           interval, so it stays quiet; a slow or spinning drain is the line that shows it.
           `slowestMs` above the poll interval is the signal to chase. It reports the WHOLE drain,
           tail included, because the tail takes the last checkpoint and the count of those is what
           says whether an idle poll did anything at all; the `finally` is what keeps a tail that
           throws from taking the record of the cycles that ran with it. Literal field keys, not a
           spread of the summary object: the log census refuses a call site whose field set it
           cannot read statically. See `summarizeDrain`. */
        let drainLineWritten = false;
        const writeDrainLine = (): void => {
          if (drainLineWritten || cycles === 0) return;
          drainLineWritten = true;
          const shape = summarizeDrain(cycleMs);
          log("sync_drain", {
            cycles: shape.cycles, totalMs: shape.totalMs, slowestMs: shape.slowestMs, drained,
            observed: census.observed, cursorBuilds: census.cursorBuilds,
            locatorReads: census.locatorReads, locatorRows: census.locatorRows,
            cursorFolders: census.cursorFolders, checkpoints,
          });
        };
        try {
          /* AFTER THE CYCLES, AND THAT ORDER IS THE FEATURE. The senders this asks about are the ones
             the cycles above just brought in, so running it first would spend a whole drain behind the
             mail it is about. It is also OUTSIDE the loop for `resurfaceDue`'s reason turned round: a
             backlog drain is up to a hundred cycles, and asking after each of them would page through
             the same queue a hundred times for one arrival. Before the checkpoint below, so the rows it
             writes are folded into the same fold. */
          await onceForTheAccount(() => suggestNew(screening.ohboxBar));
          /* AND THE HISTORICAL-NAME REPAIR LAST OF ALL THE WORK, which is the ordering claim the
             suite pins rather than a preference. It is about rows that have been on this disk for as
             long as the install has existed, so nothing it does is urgent, and a cold launch's first
             drain is exactly when the user is watching an empty window fill up. Running it before the
             cycles — or between them — would spend a page of parsing and a write transaction in front
             of the mail somebody is waiting for, every launch, to correct a display name they have
             been reading past for months. Before the checkpoint below for `suggestNew`'s reason: the
             rows it writes belong in the same fold. */
          await onceForTheAccount(backfillStoredNames);
          /* REJOIN THE CONVERSATIONS A FORWARD SPLIT, the same pass the hosted worker runs
             (`@trafficflow/worker/thread-join-heal`) for the reason every pass above is the
             worker's: on this door the store under the user's home IS the authority, no worker
             anywhere else will ever visit it, and a second implementation of the join evidence
             would be a second population of merges decided by different rules. Time-gated
             in-launch (six hours, like the hosted gate) because it repairs presentation — a
             conversation reading as two threads — and its pre-filter is a GROUP BY nobody should
             pay per drain. After the name repair, before the stamp, so its change rows fold into
             the same checkpoint. A failure is CONTAINED like every pass above: threads stay
             split, mail keeps arriving, the next gated drain asks again. */
          if (Date.now() - lastJoinHealAt >= LOCAL_JOIN_HEAL_EVERY_MS) {
            lastJoinHealAt = Date.now();
            try {
              const r = await threadJoinHealPass({
                db: db as unknown as Tx, apply: true, accountId: world.accountId, log: undefined,
                cursor: joinHealCursor,
              });
              // Persist the resume point for every capped walk — never reset it on a failure: a
              // deterministically failing group would pin the walk to its own page and starve the
              // tail. The pass already retries a failure once in-run, so what remains is
              // persistent and waits for the wrap-around.
              joinHealCursor = r.capped && r.cursor ? r.cursor : undefined;
              if (r.merged > 0) log("thread_join_heal", { merged: r.merged, moved: r.messagesMoved, skipped: r.skipped });
              // A `_failed` suffix, or the sidecar's log filter files it as informational and the
              // only diagnostic of a caught merge failure is lost (`createSidecarLog` classifies
              // by name; see apps/sidecar/src/log.ts).
              if (r.failed > 0) log("thread_join_heal_failed", { failed: r.failed, merged: r.merged, skipped: r.skipped });
            } catch (err) {
              log("thread_join_heal_failed", {
                err,
                reason: "no group committed partially — each is one transaction; split threads " +
                  "stay split and the next gated drain re-reads reality",
              });
            }
          }
          /* NOTICE THE MAILBOX A PROVIDER-SIDE FORWARD EMPTIED — the same pass the hosted worker
             runs (`@trafficflow/worker/inbound-quiet`), for the reason every pass above is the
             worker's: this store is the authority for this install, no worker anywhere else will
             judge it, and a second implementation of the predicate would tell the same mailbox's
             owner two different stories across the doors. Time-gated in-launch (six hours, the
             hosted gate) because the windows it judges are fortnights. After the heal, before the
             stamp — it writes no change rows (the mailbox panel polls `GET /mailboxes`), so the
             checkpoint ordering is indifferent, and the tail keeps all the maintenance in one
             place. A failure is CONTAINED like every pass above: episodes already stamped stand,
             mail keeps arriving, the next gated drain asks again. */
          if (Date.now() - lastInboundQuietAt >= LOCAL_INBOUND_QUIET_EVERY_MS) {
            lastInboundQuietAt = Date.now();
            try {
              const r = await inboundQuietPass(db as unknown as Tx, now(), { accountId: world.accountId });
              if (r.tripped > 0 || r.cleared > 0) {
                log("inbound_quiet_pass", { tripped: r.tripped, cleared: r.cleared });
              }
            } catch (err) {
              log("inbound_quiet_pass_failed", {
                err,
                reason: "the quiet-mailbox judgment was skipped this drain; stamped episodes " +
                  "stand, nothing trips or clears, and the next gated drain re-reads reality",
              });
            }
          }
          /* HOW FAR THIS MAILBOX HAS GOT, WRITTEN DOWN. On a hosted account these two columns are the
             worker's; here this process IS the worker, and the window's sync line reads them to tell a
             first import apart from a settled mailbox. `inboundDrained` is the distinction that
             matters for the second stamp: a drain that ran out of CYCLES with inbound mail still owed
             has not finished the import, and saying it had would tell somebody their mailbox was
             complete with half of it still on its way — while outbound filing the reconciler still
             owes (the OTHER reason the loop keeps going) is not import and must not withhold the
             stamp. See `sync-stamp.ts`. */
          if (cycles > 0) {
            const stamps = await stampSynced(db, mb.id, now(), inboundDrained);
            /* HOW LONG THE FIRST IMPORT TOOK, from the stamps that just decided it — the number
               nobody could read off a log before. The count is a thunk so a settled mailbox's pass
               pays nothing for it; see `first-sync.ts`. */
            await firstSyncLog.report(mb.id, stamps, () => mirroredMessageCount(db, mb.id), passStartedAt);
            /* AND WHETHER THE IMPORT IS STILL OPEN, from the SAME stamps — the state a surface
               renders must not be able to disagree with the line a log carries about one pass. */
            firstSync.noteStamps(stamps);
          }
          /* THE TAIL'S FOLD, AND ONLY WHEN THE TAIL WROTE. The suggestions, the name repair, the
             join heal and the stamps all write after the last cycle's fold, and the periodic
             checkpointer bounds the log to five minutes and nothing narrower. But a settled
             mailbox's whole tail is `stampSynced`'s one-row `last_sync_at`, which the next drain
             re-derives — a crash that loses it costs nothing, and it does not earn a fold. Every
             tail pass writing mail writes a change row, so the mark is the comparison; an
             unreadable mark takes the fold rather than skipping it. `inbound_quiet` writes no
             change row and says so itself. AWAITED, and `checkpoint()` never throws. */
          const markAtEnd = await changeLogMark();
          const tailWrote = markAtStart === null || markAtEnd === null || markAtEnd !== markAtStart;
          if (cycles > 0 && (census.observed > 0 || tailWrote)) {
            await opened.checkpoint();
            checkpoints += 1;
          }
          // What the memo above is held against next time — see the note at `markAtStart`.
          knownSetMark = markAtStart;
          /* PUT THE IDLE BACK ON INBOX. The cycles above re-SELECT other folders, after which an
             INBOX arrival emits nothing — a dead push channel that looks exactly like a slow one
             (the worker measured p50 194 s that way, which is why `rearmWatch` exists). It also
             rings the bell itself for growth that landed in the blind window. A belt, so a failure
             is logged and never turned into a failed drain; the next poll still comes. */
          if (restMayBeTaken && typeof conn.rearmWatch === "function") {
            try {
              await conn.rearmWatch();
            } catch (err) {
              log("local_wake_rearm_failed", {
                err,
                reason: "the INBOX watch could not be re-armed after this drain, so arrivals may " +
                  "wait for the poll until the connection is re-dialled",
              });
            }
          }
        } finally {
          writeDrainLine();
        }
        return cycles;
      };

      const drainPass = async (maxCycles = 100): Promise<number> =>
        serialize(async () => {
          // The gate, immediately before `runSyncCycle`, once per DRAIN not per inner cycle:
          // re-reading the lease between batches of one drain would be an append and an expunge
          // per batch for a claim nothing could have changed; the poll timer re-enters here, so
          // the re-verification interval is the poll interval. On the PUBLIC entry point, not only
          // `start()`, because `Sidecar` exposes this method and a skippable gate is no gate.
          // `stopped` FIRST: a stand-down closed the login, so reading the lease over a dead
          // connection would throw `LeaseUnavailableError` out of a method whose honest answer is
          // "this install organizes nothing" (`stop()` reaches the same state).
          if (stopped) return 0;
          /* ── WHICH CONNECTION THIS PASS IS ABOUT, CAPTURED BEFORE THE GATE READS IT ─────────
           *
           * The lease is read once per drain, on one connection, and everything after it is done
           * on the strength of that read. Both facts are therefore captured here, together, and
           * carried through the whole pass: the GENERATION so each mailbox write can re-check
           * that it is still current, and the INSTANCE so the cycles write to the connection the
           * gate actually asked, rather than to whatever the binding holds by then. */
          const gen = generation;
          const conn = adapter;
          /* The gate answers a ROLE, not admission. It was `if (!(await mayOrganize())) return 0`,
           * which made a stood-down install do NOTHING and contradicted the reader half of this
           * file: a demoted install keeps draining — its mirror grows, it marks read (`\Seen`, the
           * reader's one IMAP write) and sends. `drain` is the only path to `runSyncCycle`, so the
           * reader's cycle was unreachable and `reconcileFlags` never ran (`read-writeback-live.ts`
           * measured an empty mirror). Now `mayOrganize()` runs for its decision AND side effects;
           * only the removed-mailbox arm, which sets `stopped`, stops the drain. The stand-down arm
           * sets neither, which is the distinction. */
          const organizing = await mayOrganize();
          if (stopped) return 0;
          /* Create the `ohmail/*` tree at the moment this install becomes the organizer. `start()`
           * calls `ensureFolders` behind its own `permitted` gate, which was the ONLY call; a
           * MID-LIFE promotion — now the ordinary path, since a fresh install comes up a reader and
           * "Agree and start organizing" promotes on the next pass — reached none of it and routed
           * into folders the server did not have. ONCE PER PROCESS: the flag is armed by whichever
           * path arrives first. A failure is NOT fatal and the flag is NOT set on it, so the drain
           * still mirrors and the next pass retries. */
          if (organizing && !foldersEnsured) {
            try {
              /* THE MAILBOX WRITE THIS WHOLE ORDERING PROTECTS — creating somebody else's
                 `ohmail/*` tree. Refused outright if the connection has moved since the gate. */
              assertSameConnection(gen, conn);
              await conn.ensureFolders();
              foldersEnsured = true;
            } catch (err) {
              log("ensure_folders_failed", {
                err,
                reason: "this install has just become the organizer and its ohmail/* tree could not "
                  + "be created; nothing is routed into a folder that does not exist and the next "
                  + "pass asks again",
              });
            }
          }
          /**
           * The request drain / the reader's own cycle (0.14.1). ONCE per `syncUntilQuiet()`, not
           * per inner `drain()` cycle — it reads or writes `ohmail/_meta`, a round trip per poll.
           * Organizing → `applyMetaRequests` (apply a reader's decision, expunge it); otherwise →
           * `driveOutstandingRequests` (append this install's decisions, observe what the organizer
           * took). Neither performs a physical IMAP move — `drain()`'s `runSyncCycle`, right after,
           * reconciles the `folder_state` rows either writes (see `@trafficflow/worker`'s header).
           */
          //
          // Why the drain's log is translated here and NOT forwarded: `(event, detail) =>
          // log(event, { ...detail })` is the obvious wiring and this door may not use it.
          // `log-census.test.ts` requires every call site here to carry a LITERAL event name and a
          // readable field set, because this is the published desktop payload — a forwarded name is
          // unenumerable, a spread detail unauditable. So the drain's outcomes become three literal
          // lines with explicit fields, and anything else is counted under a fourth.
          const noteRequestEvent = (event: string, detail: Record<string, unknown>): void => {
            const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
            if (event === "organizer_requests_drained") {
              log("organizer_requests_drained", {
                mailboxId: mb.id,
                applied: num(detail.applied),
                refused: num(detail.refused),
                deferred: num(detail.deferred),
                // Records this build deliberately left alone — a future protocol, or a kind it has
                // no applier for. Nonzero here is normal; nonzero `refused` is not.
                standing: num(detail.standing),
              });
              return;
            }
            if (event === "outstanding_requests_driven") {
              log("outstanding_requests_driven", {
                mailboxId: mb.id,
                sent: num(detail.sent),
                applied: num(detail.applied),
                // The organizer said no, and said why. Absent before the acknowledgement model:
                // a reader could not tell a refusal from an application at all.
                refused: num(detail.refused),
                expired: num(detail.expired),
              });
              return;
            }
            // The refusals and the transient IO failures. The NAME rides as a value under
            // `outcome`, never as the event, so the roster this package publishes stays the set
            // written above and the field is one the logger already keeps.
            log("organizer_requests_note", { mailboxId: mb.id, outcome: event });
          };
          /* The mail pass's failure is HELD rather than propagated, for exactly as long as it
           * takes the request channel below to run. See that block. */
          let cycleError: unknown = null;
          let cycles = 0;
          try {
            cycles = await drain(maxCycles, gen, conn, organizing);
          } catch (err) {
            cycleError = err;
          }

          // The request channel, after the mail. Ordered so a flood of `ohmail/_meta` records
          // cannot delay reading someone's mail (bounded on both axes in `request-drain.ts`). It
          // runs even when the mail pass FAILED: a persistent sync fault used to drain nothing, so
          // a decision made elsewhere expired reporting NOBODY TOOK IT while an organizer was live.
          // The throw is held, this block runs once, then rethrown below — a second copy in a catch
          // applies a decision twice. ONE failure is excluded: `LeaseUnavailableError`, the lease
          // read failing (not "another organizer holds it"). This channel appends acks and expunges
          // records, and its standing comes only from the lease, so it must not proceed on an
          // unanswered question; skipping costs a delay, the next pass drains once the lease reads.
          /* ── AND THE PERMIT'S OWN LAST VERDICT, WHICH IS NOT A CLASS OF THROW ─────────────
           *
           * A stand-down mid-drain revokes the permit, and only ONE of the drain's write sites
           * lets the refusal out: `fileOne`, `reconcileFlags` and `folderOpsPass` each swallow
           * everything but a fence, so the ordinary shape of this defect reaches here with
           * `cycleError` NULL and the pass reporting success. Asked of the permit instead, both
           * shapes are one fact. Only when this pass was ORGANIZING: a reader holds no permit and
           * its own channel below must not be refused by a receipt from before its demotion. */
          const permitStoodDown = organizing && leaseStoodDown(leasePermit);
          const cycleMayStillWrite = !permitStoodDown
            && !(cycleError instanceof LeaseUnavailableError
              || cycleError instanceof ConnectionReplacedError);
          if (cycleMayStillWrite) try {
            /* ── THE POST-DRAIN WRITES ARE ON THE GATED CONNECTION, AND ARE CHECKED FIRST ────
             *
             * Everything below appends to, acknowledges in, or expunges from `ohmail/_meta` — the
             * same folder the organizer lease lives in — and it all used to run on the MUTABLE
             * binding after the cycles had finished. A pass that gated connection A and reached
             * here after a re-dial installed B therefore did its request and profile writes on B,
             * whose own gate was still queued behind this very pass. Two installs writing one
             * mailbox's decisions, which is the invariant, reached without a single cycle
             * misbehaving — the cycle half was fixed and this half was not. */
            assertSameConnection(gen, conn);
            if (organizing) {
              await applyMetaRequests(
                db, {
                  mailboxId: mb.id, accountId: world.accountId, adapter: conn, installId,
                  requestKey,
                }, now(),
                noteRequestEvent,
              );
              // Rows this install queued while it was a READER are stranded the moment it becomes
              // the organizer: nothing appends them, and no acknowledgement will ever arrive
              // because the organizer they wait for is this process.
              await settleOwnOutstandingRequests(
                db, { mailboxId: mb.id, accountId: world.accountId }, now(), noteRequestEvent,
              );
            } else {
              /* THE READER'S HALF OF THE SAME CHANNEL, checked on its own. The organizer arm above
                 has its own assertion and this branch is reached instead of it, never after it —
                 so borrowing that one would leave this path unguarded, which is precisely what the
                 census found. */
              assertSameConnection(gen, conn);
              await driveOutstandingRequests(
                db, {
                  mailboxId: mb.id, accountId: world.accountId, adapter: conn, installId,
                  requestKey,
                },
                { installId, kind: organizerKind }, now(),
                noteRequestEvent,
              );
            }
          } catch (err) {
            log("organizer_requests_drain_failed", {
              err, mailboxId: mb.id,
              reason: "this pass reads or organizes mail regardless; the next pass tries again",
            });
          }

          // The mail pass's own failure, now that the channel has had its turn. Everything below
          // is the tail of a pass that COMPLETED and must not run for one that did not.
          if (cycleError !== null) throw cycleError;

          // The portable profile's write-behind tick, behind the gate it rides. After the drain,
          // it reads the store the cycles just wrote, so a burst of verdicts is one comparison.
          // Reachable only when `mayOrganize()` said yes — publishing into someone's `ohmail/_meta`
          // is the single-writer rule, not an optimisation. Runs on a zero-cycle drain too
          // (settings change without mail), never throws. EXPLICIT now the line above no longer
          // returns for a reader: this used to be organizer-only by being unreachable.
          /* THE PROFILE PUBLISH IS A MAILBOX WRITE TOO — an append and an expunge in
             `ohmail/_meta` — and it read the LIVE getter, so a stale pass published this
             install's settings over a connection it had never gated. Checked here; the sync
             itself resolves its adapter through the same getter, so the check is what stands
             between it and a replaced connection. */
          assertSameConnection(gen, conn);
          /* AND NOT IF THE PERMIT STOOD DOWN — the same fact the request channel above asks. The
             publish is an append and an expunge in `ohmail/_meta`, and it is reached on exactly
             the shape that hides the stand-down: a refusal swallowed inside the cycle leaves
             `cycleError` null, so the line above lets this run. `organizing` is the gate's answer
             from before the drain and says nothing about what happened during it. */
          if (organizing && !permitStoodDown) await profileSync.onOrganize(conn);
          return cycles;
        });

      /**
       * One drain, with the connection's health accounted for either way. This wrapper is the
       * SECOND detector, because the first is not reachable everywhere: `guardAsyncErrors` returns
       * early for a client with no event surface, so an injected double bypasses the `close`
       * listener — an event-only heal would be the `failure-looks-like-healthy` shape. It also
       * covers a half-open death that emits nothing. On the PUBLIC entry point, not inside
       * `serialize`, so the accounting sees the drain's OUTCOME and a direct caller ("sync now",
       * `syncMailbox`) feeds the same bound the poll timer does.
       */
      /**
       * DID THIS DRAIN PRODUCE ANYTHING ANYONE COULD SEE? The window runs its own mirror and learns
       * what exists ONLY from the change log it drains (`local-mirror.ts`), so the log's top seq is
       * exactly that question: one indexed aggregate over the `(account_id, seq)` primary key.
       * `"empty"` is a log with no rows — a real, quiet state, kept apart from `null`, which is a
       * log we could not read and which {@link noteIdleOutcome} treats as NOT quiet. The fail-safe
       * direction is the fast cadence.
       */
      const changeLogMark = async (): Promise<string | null> => {
        try {
          const { max } = await seqBounds(db as unknown as Tx, world.accountId);
          return max === null ? "empty" : max.toString();
        } catch {
          return null;
        }
      };

      /**
       * One step of the ladder, taken after a drain that came back. A drain that changed nothing
       * climbs towards the ceiling; one that changed something falls back to base. The climb needs
       * {@link restMayBeTaken} — resting behind a doorbell nobody wired would be trading freshness
       * for CPU, which is the fix this lane was told not to make.
       */
      const noteIdleOutcome = async (before: string | null): Promise<void> => {
        const after = await changeLogMark();
        const quiet = before !== null && after !== null && before === after;
        if (!quiet) { idlePollMs = pollIntervalMs; return; }
        if (!restMayBeTaken) return;
        const next = nextIdlePollMs(idlePollMs, pollIntervalMs, idlePollCeilingMs);
        if (next === idlePollMs) return;
        idlePollMs = next;
        log("sync_idle_backoff", { nextPollMs: next, ceilingMs: idlePollCeilingMs });
      };

      const syncUntilQuiet = async (
        maxCycles = 100,
        opts: { force?: boolean } = {},
      ): Promise<number> => {
        // THE HEAL, IMMEDIATELY BEFORE THE DRAIN IT IS FOR — and outside `drainPass`'s serialized
        // body, which would deadlock. See `redialIfDead`. It never throws: a server that is still
        // down leaves the drain below to fail in its own words, which is the class the bound
        // counts and every failure counter exempts.
        /* THE POLL PASSES NOTHING, so the ladder holds for it — `force` reaches here only from
           the resync route's wrapper, which is a person pressing a button. */
        /* The detector before the heal: `redialIfDead` returns while nothing is known dead, so a
           half-open link reached the drain and hung inside it. Never throws. */
        await heartbeat();
        await redialIfDead({ force: opts.force === true });
        /* AND NOTHING IS DRAINED OVER A CONNECTION THAT WAS NEVER OPENED. The poll is armed for a
           mailbox whose stored password could not be used so the READ is retried on the ladder —
           see `redialIfDead` — and a drain here would fail on every tick against an adapter that
           has never connected, filing `sync_cycle_failed` for a state the connection record
           already states. `0` is the honest count: nothing was served. */
        if (credentialBlock !== null) return 0;
        /* A PRESS IS ATTENTION. A forced drain — the resync button, a foreground resume, a
           promotion — returns the ladder to base on the way in and takes no rest on the way out,
           however little it finds: somebody is at the screen. */
        if (opts.force === true) idlePollMs = pollIntervalMs;
        const markBefore = await changeLogMark();
        try {
          const cycles = await drainPass(maxCycles);
          noteCycleServed();
          if (opts.force !== true) await noteIdleOutcome(markBefore);
          return cycles;
        } catch (err) {
          /* A FAILED DRAIN IS NOT A QUIET ONE, and the bound this protects is one the app states
             in plain words: a connection is dead after 120 s OR after 8 consecutive cycles that
             could not read the lease, whichever comes first (see `LOCAL_CONNECTION_DEAD_AFTER_MS`
             and its cycle twin). Climbing the ladder here would stretch those eight cycles across
             sixteen minutes. */
          idlePollMs = pollIntervalMs;
          /* A DRAIN THAT DIED LEFT THE STORE IN A STATE NOBODY STATED. `runSyncCycle` has already
             dropped the memo on its own throw; this forgets the MARK too, so the next drain
             re-reads rather than trusting a comparison against a moment that was never finished. */
          knownSetMark = null;
          noteCycleFailed(err);
          /* AND THE REFUSAL IS NAMED, once per settled attempt. `noteCycleFailed` already exempts
             it correctly — a tagged `NO` is not a connection failure and never advanced the bound
             — but it exempted it in SILENCE, so every poll after the launch left no line at all
             and a mailbox nothing could be read from looked like a mailbox with nothing in it. */
          if (fetchRefused(err)) noteFetchRefused(err);
          throw err;
        } finally {
          /* A DRAIN CAME BACK — HOWEVER IT CAME BACK. In a `finally` because the arm that
             matters most is the throwing one: a first sync that cannot read the mail leaves by
             the catch, and reading the state only off the returning arm would report the failure
             as a first sync still working, for ever. `stopped` is excluded for
             `noteCycleServed`'s reason — a runtime told to stop is evidence about nothing. It
             never throws (the tracker contains its own probe's faults), so it cannot replace the
             error this block is carrying out. */
          if (!stopped) await firstSync.noteDrainEnded(() => mirroredFirstSyncFacts(db, mb.id));
        }
      };

      const schedule = (delayMs?: number): void => {
        if (stopped) return;
        /* A KICK OUTRANKS AN ORDINARY RE-ARM, and that is a correctness rule rather than a
           preference. `delayMs === undefined` is the tail of a drain; a drain settling just after
           an arrival rang would otherwise clear the kick's timer, put that mail behind a full
           interval, and leave `wakePending` set for ever so no later arrival could ring either.
           The kick's own callback clears the flag. */
        if (delayMs === undefined && wakePending) return;
        /* EXACTLY ONE POLL TIMER PER RUNTIME, at any moment. Every armed timer re-arms itself in
           the `.finally` below, so arming a second one does not move the next poll — it starts a
           second loop that runs for the life of the runtime, and two gated cycles then race each
           other on the lease. A caller that arms while one is armed MOVES the next poll instead.
           `dialAndGate` says the same about itself ("two would give the mailbox two overlapping
           drains"); the enforcement belongs here, where the timer is. `stopped` returns first. */
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          /* SPENT THE MOMENT IT FIRES, before anything can await. Left standing, the guard above
             refuses every later re-arm and the mailbox stops polling altogether after its first
             arrival — which is how this line came to exist (the reset case went red on a poll loop
             that had silently ended). */
          wakePending = false;
          void syncUntilQuiet()
            .catch((err: unknown) => {
              // A failed cycle is a bad network or a sleeping laptop, not a reason to stop being a
              // mail app. Offline is a property of this mode: the organizer pauses and the viewer
              // stays complete — the API keeps serving the mirror over the bridge either way.
              /* Except when what failed was the LEASE, which is not a passing condition. A cycle
               * that died because `ohmail/_meta` could not be read is the organizer half of the
               * reader case beside it: the install organizes nothing until it clears and says so.
               * Narrowed BY CLASS — arming this for every cycle failure would make a dropped
               * connection look like an unreadable lease and the field would stop meaning anything.
               * Cleared by the next successful gate, like the other paths. */
              if (err instanceof LeaseUnavailableError) {
                organizer = {
                  ...organizer,
                  unreadableSince: organizer.unreadableSince ?? new Date().toISOString(),
                };
              }
              log("sync_cycle_failed", { err });
            })
            .finally(schedule);
        }, delayMs ?? idlePollMs);
        timerDueAt = Date.now() + (delayMs ?? idlePollMs);
        timer.unref?.();
      };

      /**
       * THE DOORBELL RANG — INBOX grew. Two acts and no more: the ladder returns to base (the
       * mailbox is active again) and one drain is armed for now. Synchronous and throw-free by
       * construction: it runs inside imapflow's `exists` handler, where a raising listener is the
       * uncaught exception the connection's own listeners exist to prevent.
       */
      const onMailboxSignal = (): void => {
        if (stopped || handedBack) return;
        idlePollMs = pollIntervalMs;
        if (wakePending) return;
        wakePending = true;
        schedule(0);
      };

      /**
       * A DOOR WROTE SOMETHING — see {@link LocalMailboxRuntime.noteWorldMoved}. The ladder goes
       * back to base, and the armed timer is pulled in ONLY if that lands sooner than what is
       * already due. No drain is forced: the guarantee is "within one base interval", which is
       * exactly the cadence this engine had before it learned to rest.
       */
      const noteWorldMoved = (): void => {
        if (stopped || handedBack) return;
        idlePollMs = pollIntervalMs;
        if (wakePending) return;
        if (timerDueAt - Date.now() > pollIntervalMs) schedule(pollIntervalMs);
      };

      /**
       * ══ ARM THE DOORBELL — the channel this door has always had and never used ══
       *
       * `watch` is required of every `MailboxAdapter` and the hosted worker has run on it since
       * 0.13; here it is what LETS the poll rest, so it is measured rather than assumed — the rest
       * is taken only when the listener is registered AND the server advertises IDLE. Best-effort
       * by construction: a refusal leaves `restMayBeTaken` false and this mailbox on its old base
       * cadence, which is a slower app and never a wrong one. Per DIAL — a re-dial re-arms.
       */
      const armWake = async (conn: MailboxAdapter): Promise<void> => {
        /* EXACTLY ONE LISTENER PER RUNTIME, the poll timer's own rule applied to the doorbell: the
           previous one is detached before a new one is registered, so a re-dial cannot leave two
           subscriptions ringing one mailbox. */
        const previous = unwatch;
        restMayBeTaken = false;
        unwatch = null;
        if (previous) await previous().catch(() => { /* that connection is already gone */ });
        try {
          const caps = await conn.capabilities();
          if (!caps.idle) {
            log("local_wake_unarmed", {
              reason: "this server does not advertise IMAP IDLE, so there is no channel to rest " +
                "behind; the poll keeps its base interval and carries every arrival itself",
            });
            return;
          }
          unwatch = await conn.watch(onMailboxSignal);
          restMayBeTaken = true;
        } catch (err) {
          log("local_wake_unarmed", {
            err,
            reason: "the INBOX watch could not be armed on this connection, so the poll keeps " +
              "its base interval and carries every arrival itself",
          });
        }
      };

      /**
       * THE RUNTIME THIS MAILBOX IS, handed to the roster.
       *
       * The thirteen mutable fields are ACCESSORS rather than copies, and that is the whole of
       * the care this record needs. `mayOrganize` writes `organizer`, `priorStandDown` and
       * `leaseNonce` on every pass; a record built by spreading their values would freeze the
       * answers at attach time, so the pane would render a demotion that happened an hour ago as
       * though this install still organized the mailbox. Reading through a getter is what keeps
       * the map's view and the gate's view the same view.
       */
      /**
       * Dial, then learn, then act — the ONE sequence a launch and a re-dial both run. Extracting
       * it from `start()` is what makes reconnect safe: resuming a drain over a fresh socket
       * WITHOUT re-reading the organizer lease would dual-organize against a claim that arrived
       * during the outage, and reconnect-after-sleep is when a mailbox most likely changed hands.
       * "Exactly one active organizer per mailbox" — a second copy of this sequence is how it
       * breaks. The lease is read BEFORE the first move, and `ensureFolders` IS a move. It does NOT
       * arm the poll timer: `start()` calls `schedule()` after it, and a re-dial's chain already
       * ends in one — two would give the mailbox two overlapping drains.
       */
      const dialAndGate = async (): Promise<{ leaseRead: boolean }> => {
        /* THE SIGN-OUT FENCE, BEFORE `connect()` and before anything else. A launch and a re-dial
           both come through here, and both hold the plaintext in memory — so a sign-out that
           landed after this mailbox resolved its password must stop the login being opened, not
           merely the row being read. Refusing is the whole act: the poll timer lands here again
           and refuses again until the process ends or somebody signs back in. */
        if (signedOutSinceDial()) throw new SignedOutError();
        await adapter.connect();
        /* AFTER `connect()`, because that is the call that establishes the connection this pass
           is about. Captured once and carried, exactly as `drainPass` does. */
        /* STOPPED WHILE WE DIALLED. `connect()` is the longest await in this sequence and
           `detach()` can complete inside it, so the gate below — which APPENDS a claim to the
           user's mailbox — must not be reached by a runtime that has been told it is finished. */
        /* CAPTURED FIRST, BEFORE THE STOPPED CHECK — and the order is the point rather than
           tidiness. This close exists to release the login THIS sequence just opened, so it must
           name that connection and not the binding, which a re-dial can move. Capturing after the
           check left one `adapter.close()` inside the gated region, which is the receiver-position
           shape the census now refuses. */
        const gen = generation;
        const conn = adapter;
        if (stopped) {
          await conn.close().catch(() => { /* already going away */ });
          return { leaseRead: false };
        }
        // Everything below runs on an AUTHENTICATED socket, so it is wrapped. `connect()` logs in
        // then LISTs, and `main.ts` answers a rejected `start()` by logging and serving the mirror
        // anyway — so a throw from the lease gate, `ensureFolders` or the first drain left an
        // authenticated login open with no handle to close it, for the life of the process. iCloud
        // caps concurrent connections per account, so a leaked login eventually refuses connects in
        // another app. A `catch` and NOT a `finally`: a healthy launch keeps the login (the poll
        // timer and organizer claim run on it); tests assert both directions. Same close-then-
        // rethrow shape as `send-adapter.ts` and `attachments-adapter.ts`.
        try {
          // The lease is read BEFORE the first move, and `ensureFolders` IS a move: creating the `ohmail`
          // folder tree in a mailbox Cloud organizes is a write this install has no business making, and
          // reconnect-after-sleep is when a mailbox most likely changed hands. Gated here, drained through
          // the already-gated inner `drain`, so a launch reads the lease ONCE. A lease we could not READ is
          // not one we lost: an unreachable `ohmail/_meta` leaves the organizer paused and the viewer
          // complete rather than a failed launch, exempted BY CLASS as the hosted worker does. The login is
          // KEPT — it is the connection the next poll asks over and the one non-throwing exit here with
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
            /* AND IT IS RECORDED WHERE A PERSON CAN SEE IT — carried over from the launch
             * sequence this function was extracted from. A log line is not a user-visible state,
             * and when the cause is a folder over the ceiling it does not clear on its own, so a
             * desktop would otherwise sit in an ordinary connected state organizing nothing. Kept
             * from the FIRST failure rather than refreshed, so a surface can say how long it has
             * been true; every path that reads the lease successfully sets it back to `null`.
             *
             * THE LEASE, NOT THE SOCKET. A dead connection has its own clock
             * (`connectionDeadSince`) and must never land here: "we cannot read who organizes this
             * mailbox" and "this machine cannot reach the server" are different sentences. */
            organizer = {
              organizing: false,
              reason: organizer.reason,
              heldBy: organizer.heldBy,
              unreadableSince: organizer.unreadableSince ?? new Date().toISOString(),
              /* CARRIED with the rest: an unreadable lease says nothing about the row — and that
                 is the whole of it for `claimed`. An outage is not a machine taking the mailbox,
                 so the notification stands and the next poll asks again. */
              releaseRequestedAt: organizer.releaseRequestedAt,
              claimed: organizer.claimed,
            };
            // NO `schedule()` HERE — the CALLER arms the timer. That is what lets a re-dial
            // run this identical sequence without arming a second one for the same mailbox.
            //
            // `leaseRead: false` — THE SOCKET IS UP AND THE MAILBOX IS NOT BEING ORGANIZED, and
            // the caller must be able to tell those apart. A re-dial that reported success here
            // cleared the outage, logged `mailbox_reconnected` and told the person their mailbox
            // was healthy while nothing was being filed.
            return { leaseRead: false };
          }
          /* `!permitted` is "NOT THE ORGANIZER", not "stop" — the launch half. This used to
           * `return`, taking the first drain, special-folder discovery AND `schedule()` with it,
           * so a stood-down install came up with no poll timer (and closed the login on
           * `priorStandDown`). A stand-down no longer means stop: a demoted install is a READER —
           * it keeps its login and poll timer and goes on cycling, so the gate re-runs next poll,
           * reads the stamp and promotes with no relaunch (without which "Organize from this
           * machine" did nothing until restart). So a reader falls through — drains, schedules,
           * keeps the connection — and the one thing it does not do is below. */
          /* `stopped` is checked whatever the gate answered. This read `if (!permitted && stopped)`,
           * so a gate that said YES walked past it — and `mayOrganize` is the longest await, the
           * likeliest place for `detach()` to land. A removal or shutdown overlapping a slow lease
           * read then continued into `ensureFolders`, discovery and a full drain on a runtime told
           * it was finished, having already appended a fresh claim. `detach()` waited for all of it:
           * it bounded the damage's duration and prevented none. The permitted arm STANDS DOWN
           * rather than returning — the gate just renewed a claim on a mailbox it is letting go, and
           * leaving it makes the next install wait out a claim nobody honours. */
          if (stopped) {
            if (permitted) {
              const released = await releaseOwnClaim(
                conn, installId, mb.id, { current: leaseNonce, pending: leasePendingNonce }, log,
                "the claim this pass renewed could not be released; it ages out of " +
                  "ohmail/_meta on its own and another install takes the mailbox then",
              );
              /* ONLY WHEN SOMETHING WAS ACTUALLY GIVEN BACK. This line was written
                 unconditionally and the release's answer was discarded, so a pass that removed
                 NOTHING — the folder held no record of ours the search could see — still said the
                 claim "is given back rather than left to age out". Its two siblings on this door
                 both gate on the count; this one did not, and it is the arm that runs on the
                 detach a person's removal triggers, which is exactly when the sentence gets read. */
              if (released !== null && released > 0) {
                log("organizer_claim_released_on_detach", {
                  mailboxId: mb.id,
                  claims: released,
                  reason: "the mailbox was removed or the engine stopped while the organizer " +
                    "lease was being read, and that read had already renewed this install's " +
                    "claim; it is given back rather than left to age out",
                });
              }
            }
            return { leaseRead: true };
          }
          /* AND THERE IS NO SECOND `stopped` CHECK BELOW THIS, DELIBERATELY.
           *
           * `if (!permitted && stopped)` stood here, returning the same `{ leaseRead: true }` for
           * the removal case. The arm above returns on `stopped` whatever the gate answered, so
           * its contrary state — stopped, and not yet returned — is unreachable: the condition
           * could never be true, could never be watched fail, and read to the next person as a
           * promise this code does not keep. The removal case it named is handled by the arm
           * above, on the same `leaseRead: true`, and `mayOrganize` has already cleared the timer
           * and closed the login on that path.
           */
          // Before the first cycle of an ORGANIZER, always: the pipeline routes into the `ohmail`
          // folder tree, and a move to a folder the server does not have fails. The hosted sync
          // worker does the same thing at attach time.
          //
          // NEVER FOR A READER, and this is the sharpest line in the branch above: `ensureFolders` is the
          // IMAP WRITE that creates somebody else's `ohmail` tree, and the header forty lines up already says
          // so — *"reconnect is learn-then-act … creating the `ohmail` folder tree in a mailbox Cloud is
          // organizing is a write this install has no business making"*. It was gated by the `return` that
          // has just gone, so it needs its own gate now.
          if (permitted) {
            /* THE CONNECTION THIS DIAL ESTABLISHED, not the binding. `dialAndGate` captures
               `conn` immediately after `connect()`, and every `await` between there and here —
               the lease read most of all — is a window in which a re-dial can move the binding.
               Creating somebody else's `ohmail/*` tree through a connection this sequence never
               gated is the defect the cycles were fixed for, on the launch path. */
            assertSameConnection(gen, conn);
            await conn.ensureFolders();
            // See {@link foldersEnsured}: the poll's own call must not repeat what this just did.
            foldersEnsured = true;
          }
          // Mail 0065: discover the provider's own \Junk and \Trash and write them down. The
          // hosted worker's attach hook, mirrored here because the LOCAL engine is its own attach
          // path — without it `mailboxes.trash_folder` stays NULL, so delete refuses
          // (`no_trash_folder`) and spam verdicts never reach Junk. Read-only (one LIST), re-written
          // every attach so a renamed folder heals, best-effort (`imap-types.ts` carries the rule).
          // A READER runs it too: one LIST and a write to this install's own row, and the knowledge
          // makes a promotion take effect on the next poll rather than the next launch.
          if (typeof conn.findSpecialFolders === "function"
            && typeof repo.setMailboxSpecialFolders === "function") {
            try {
              const found = await conn.findSpecialFolders();
              await repo.setMailboxSpecialFolders(mb.id, {
                junkFolder: found.junk, trashFolder: found.trash,
              });
            } catch (err) {
              log("special_folder_discovery_failed", { err });
            }
          }
          /* ── A FETCH THE SERVER REFUSED IS NOT A FAILED LAUNCH ──────────────────────────
           *
           * The lease arm's exemption above, one command later: the socket is up, the login
           * stands, the lease has been read, and what failed is the WORK. Rethrowing put the
           * launch through two call sites that both assume the socket — this function's `catch`,
           * which closes the login it just opened, and `start()`'s, which records a dead
           * connection for any launch failure. Measured on both doors against a relay answering
           * content FETCHes with a tagged `NO`: the mailbox read `reachable: false` and the app
           * said "Connection lost. Reconnecting…". So the login is KEPT, the caller arms the poll,
           * and the next drain asks again over the same connection. Narrow BY CLASS. */
          try {
            // `permitted`, the answer THIS launch's gate gave — the launch is a pass like any
            // other and its drain runs under the role that pass read.
            await serialize(() => drain(100, gen, conn, permitted));
          } catch (err) {
            if (!fetchRefused(err)) throw err;
            noteFetchRefused(err);
          }
          /* THE DOORBELL, AFTER THE LAUNCH DRAIN AND BEFORE THE CALLER ARMS THE TIMER. After the
             drain so a first import is not interrupted by its own arrivals, and here rather than
             in `start()` so a RE-DIAL re-arms on the new connection — the watch belongs to the
             socket, and a mailbox that came back from an outage must not rest behind a doorbell
             that died with the old one. */
          await armWake(conn);
          // (the poll timer is armed by the caller — see the header)
          return { leaseRead: true };
        } catch (err) {
          // The ORIGINAL error, rethrown — `main.ts` decides what a failed launch means, and it
          // must not be told the connection failed to close when what failed was the drain.
          /* `conn` AND NOT `adapter`, the same late-binding fault `noteConnectionDead` documents:
             this line exists to release the login THIS sequence opened, and after a re-dial the
             binding is a different, healthy connection — closing that one would retire the
             replacement on the way out of a failure that had nothing to do with it. */
          await conn.close().catch(() => { /* the connection is already broken */ });
          throw err;
        }
      };

      /**
       * Re-dial a connection known dead. It must NOT be called from inside the serial queue:
       * `serialize` chains onto `tail` and `dialAndGate` takes the queue twice, so a re-dial from
       * inside `drainPass` waits for itself — the deadlock this lane is about. So it runs on the
       * PUBLIC entry point, before the drain it heals. A FRESH adapter, not a re-opened one: a
       * bound-retired adapter refuses every call by design (`assertUsable`) and a fresh dial is the
       * only externally observable "opened a new connection". It NEVER throws (a dial error would
       * replace the `LeaseUnavailableError` the bound exempts), and a failed attempt does NOT reset
       * `connectionDeadSince` — Settings renders it as "unreachable since".
       */
      let redialling = false;
      /**
       * THE IN-FLIGHT RE-DIAL, for `detach()` to wait on — and for nothing else to wait behind.
       *
       * Resolved whenever no re-dial is running, so awaiting it is free in the ordinary case.
       */
      let redialInFlight: Promise<void> = Promise.resolve();
      /**
       * @param force A person pressed "Sync now". Skips the backoff WAIT and nothing else: the ladder is
       * right for a poll, wrong for a person watching the one control do nothing after the network
       * returned. Every other early return still holds — `stopped` and `connectionDeadSince === null`
       * (nothing to re-dial), `redialling` (join, don't open a second login), the credential arm (which
       * retries the stored READ rather than dialling), and `signInRefused` (the SERVER said no; a press
       * must not become repeated LOGIN attempts providers throttle or lock). It does NOT reset the
       * ladder (`redialAttempts` untouched) and is NOT unlimited — at most once per this profile's first
       * ladder step ({@link forcedNotBefore}, {@link ReconnectProfile}).
       */
      const redialIfDead = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
        if (stopped || connectionDeadSince === null || redialling) return;
        /* ── A REFUSED SIGN-IN IS NOT RETRIED, AND A FAILING SERVER IS BACKED OFF ────────────
         *
         * Both are the same defect seen from two sides: a dial that cannot succeed being repeated
         * on the poll's cadence. The first cannot succeed until a person acts, so it is not
         * attempted at all; the second may, so it is attempted on a widening interval instead of
         * four times a minute. */
        if (signInRefused) return;
        /* THE PRESS SKIPS THE LADDER, AND THE FLOOR UNDER THE PRESS IS ITS OWN. See
           {@link forcedNotBefore}: a forced dial that failed a moment ago has not become worth
           repeating because somebody pressed again. ABOVE the credential arm below, because the
           READ is rationed by this same ladder: a store that answered a moment ago has not become
           worth asking again either, and a read every poll would climb no ladder at all. */
        if (force ? Date.now() < forcedNotBefore : Date.now() < redialNotBefore) return;
        /* THE SAME PRECONDITION `start()` KEEPS, and for the same reason: an empty password is a
           login attempt the server will refuse, and a refused login counts toward a lockout on
           some providers. A mailbox with no usable credential is not unreachable, it is waiting
           for a person, and dialling it repeatedly would turn that into a locked account.
           WHAT IS RETRIED IS THE READ, which touches no server: the row can open on a later read
           — a person re-entered the password on a door that does not replace this runtime — and
           without this the mailbox stayed dark until the app was quit. A read that does not open
           climbs the ladder exactly as a failed dial does. */
        if (login.state !== "ready" || !login.pass) {
          if (!(await rereadCredential())) {
            /* AND ONLY THE POLL CLIMBS, exactly as the failed dial below decides it: a press is
               one reading, not evidence about when a store might open, so it arms its own floor
               and leaves the automatic wait where it was. */
            if (force) forcedNotBefore = Date.now() + reconnect.ladderMs[0]!;
            else climbTheLadder();
            return;
          }
          if (stopped) return;
          /* AND THE HEARTBEAT THIS LAUNCH NEVER ARMED. `start()` returned before `armHeartbeat()`
             when the password could not be used, so a mailbox healed here would run with two death
             detectors where every other one has three — and the missing one is the half-open link,
             which neither of the others describes. Reached at most once: the guard above is false
             from the moment the read opens. */
          armHeartbeat();
        }
          /* The re-dial joins `tail` so `detach()` waits FOR it, but is not put INTO it. It cannot
           * queue behind `tail` — `dialAndGate` takes the queue twice, so a queued re-dial waits
           * for itself (this lane's deadlock). But `detach()` awaits `tail` then closes the adapter,
           * so a re-dial outside it could resume afterwards: a fresh connection, a renewed claim and
           * folders for a just-removed mailbox, or a login with no handle to close it. Folding it
           * INTO `tail` deadlocks the other way (every later step, including the gate it waits for,
           * waits for it). So the wait gets its OWN handle: `detach()` awaits the queue AND this,
           * and this chains onto nothing. */
        redialling = true;
        let settle: () => void = () => {};
        redialInFlight = new Promise<void>((resolve) => { settle = resolve; });
        const deadSince = outageSince ?? connectionDeadSince;
        const detectedBy = connectionDeadBy;
        try {
          const old = adapter;
          /* The dead connection is DESTROYED, not asked to leave politely. `close()` issues a
             LOGOUT, and IMAP commands are serialized, so it queues behind a command already hung
             and waits out the hang it was escaping ({@link MailboxAdapter.forceClose}). On a
             half-open link (the socket answers TCP, nothing answers IMAP) the LOGOUT never settles,
             `finally` never runs, and `redialling` — the latch every later attempt returns on — is
             held for the life of the process, so no dial ever happens again. This and the
             detector's teardown are ONE mechanism: destroying the socket is what ends the other's
             hung LOGOUT, so with both polite there is no dial at all and neither may be relaxed on
             the grounds that the other covers it. */
          if (old.forceClose !== undefined) {
            try { old.forceClose(); } catch { /* the socket is going away regardless */ }
          } else {
            /* An injected double with no `forceClose`. NOT awaited, for the reason above: a
               teardown this function waits on is a latch this function can park on, and nothing
               below needs the old connection's last byte. */
            try { void Promise.resolve(old.close()).catch(() => undefined); }
            catch { /* threw synchronously; it is going away either way */ }
          }
          /* RE-CHECKED AFTER EVERY AWAIT, not once at the top. `detach()` can complete inside any
             of these suspensions — a mailbox removal, a password re-attach, the engine shutting
             down — and each check below is a point at which this stops rather than installing a
             connection for a runtime that has been told it is finished. */
          if (stopped) return;
          adapter = dialAdapter();
          const outcome = await dialAndGate();
          if (stopped) {
            /* Removed while we dialled. The connection we just opened has no owner, and leaving
               it would be the leak `start()`'s own catch exists to prevent — on a provider that
               caps concurrent logins, in somebody else's mail app. */
            await adapter.close().catch(() => { /* already going away */ });
            return;
          }
          /* The socket is up. That is not the same as the mailbox being served.
           * `connectionDeadSince` clears either way — it is what makes the next poll re-dial, and
           * re-dialling over an answering server would churn logins a provider counts. `outageSince`
           * clears only when a cycle is actually SERVED (`noteCycleServed`'s job, not this one), so
           * a re-dial that reached a live server but an unreadable `ohmail/_meta` leaves Settings
           * saying "unreachable since" the ORIGINAL instant — the outage is not over. */
          connectionDeadSince = null;
          connectionDeadBy = null;
          redialAttempts = 0;
          redialNotBefore = 0;
          /* The press's floor goes with the ladder — DEFENCE, not a watched invariant, said here
           * so a later reader does not take it for a guarantee. Its contrary state is unreachable:
           * a FORCED dial runs only once the floor has passed, so a later press is admitted whether
           * or not this clears it. The one path that could differ (a poll succeeding inside the
           * window) needs pinned jitter and a frozen clock and loses the lease
           * (`lease_lost_race`), so a case on it was a race, not evidence, and was removed. Kept as
           * hygiene — a floor outliving the condition it rations is a bug for the next caller — and
           * the mutation table leaves it out. */
          forcedNotBefore = 0;
          if (outcome.leaseRead) {
            leaseUnavailableSince = null;
            leaseUnavailableCycles = 0;
            log("mailbox_reconnected", {
              mailboxId: mb.id,
              detectedBy: detectedBy ?? "bound",
              totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
              reason: "the mail server connection was re-opened and the organizer lease was read " +
                "again BEFORE anything was moved, so a claim that arrived during the outage is " +
                "honoured on the first cycle back rather than a cycle later",
            });
            return;
          }
          /* THE STREAK IS DELIBERATELY NOT CLEARED. The lease is still unreadable, so the cycles
             that follow are a CONTINUATION of the same outage rather than the start of a new
             one — clearing it would buy the wedge another full bound before anybody looked
             again. */
          log("mailbox_reconnect_lease_unavailable", {
            mailboxId: mb.id,
            totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
            reason: "the connection was re-opened and the organizer lease still could not be " +
              "read, so this install organizes nothing yet and the mailbox is still reported " +
              "unreachable. The socket is not the mailbox",
          });
        } catch (err) {
          /* ── WHY IT FAILED DECIDES WHETHER IT IS TRIED AGAIN ─────────────────────────────
           *
           * A refused sign-in stops the automatic re-dial for good; anything else widens the
           * wait. Without this the log line below was literally true — "the next poll tries
           * again" — and that was the defect, not the remedy. */
          if (credentialsRefused(err)) {
            signInRefused = true;
            log("mailbox_sign_in_failed", {
              err, mailboxId: mb.id,
              reason: "the mail server answered and rejected the sign-in, so this install stops " +
                "dialling until the password or token changes. Retrying on the poll would be " +
                "four attempts a minute at a server that has already said no, which providers " +
                "throttle and some answer by locking the account",
            });
          } else if (force) {
            /* Only a FORCED attempt arms the press's floor. Arming it on any failed dial reads
               harmless and is not: during an outage the poll fails on its own cadence, so the
               floor would re-arm every 15 s–5 min and a press be refused almost whenever made.
               UNJITTERED and fixed at the base step, unlike the arm below: it moves with the
               profile so a press rationed at the desktop's 15 s on a phone whose ladder runs at
               5 s does not make the heal slower. Jitter stops mailboxes knocking in unison after
               an outage, a property of the automatic cadence; a person pressing is not a herd,
               and a floor that moved would make "press again in fifteen seconds" unstatable. */
            forcedNotBefore = Date.now() + reconnect.ladderMs[0]!;
          } else {
            /* AND ONLY THE POLL CLIMBS THE LADDER — a press is one dial, not evidence about the
               server's schedule; see the contract above. A failed forced attempt used to run
               these two lines as well, which widened the AUTOMATIC wait and restarted it from
               the press: the app's own next attempt then came later than it would have if
               nobody had pressed, so the one control the product offers for a slow heal made
               the heal slower, and six presses walked the wait to the five-minute cap. */
            climbTheLadder();
          }
          log("mailbox_reconnect_failed", {
            err, mailboxId: mb.id,
            attempt: redialAttempts,
            /* WHEN THE NEXT AUTOMATIC ATTEMPT IS PERMITTED, so a reader can tell a ladder that is
               climbing from one that has stopped. `null` on a refused sign-in — nothing is
               waiting, because nothing will dial until a person acts — and `0` where the next
               poll may dial at once, which is what a failed PRESS leaves (the press does not
               climb the automatic ladder). Read off `redialNotBefore` AFTER the arms above, never
               from the step this call site could compute: the one that ran is the fact. */
            retryInMs: signInRefused ? null : Math.max(0, redialNotBefore - Date.now()),
            totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
            reason: "the connection could not be re-opened; this install organizes nothing and " +
              "serves the mirror it already has, and the next poll tries again. The clock the " +
              "settings row reports is unchanged — it measures the outage, not the attempts",
          });
        } finally {
          redialling = false;
          settle();
        }
      };

      const rt: LocalMailboxRuntime = {
        mailboxId: mb.id,
        address: mb.address,
        imap: mbImap,
        get adapter() { return adapter; },
        get syncDeps() { return syncDeps; },
        get timer() { return timer; },
        set timer(v) { timer = v; },
        get tail() { return tail; },
        set tail(v) { tail = v; },
        get stopped() { return stopped; },
        set stopped(v) { stopped = v; },
        get priorStandDown() { return priorStandDown; },
        set priorStandDown(v) { priorStandDown = v; },
        /**
         * ORGANIZING IS THE MECHANISM, NOT THE INTENT — three facts meet here: a claim this install
         * holds, a poll timer armed (on this tier also the RENEWAL, since the gate runs at the top
         * of every cycle), and neither a hand-back nor a stop standing. A claim taken by a start
         * that has not armed its timer is `starting` — {@link OrganizerState.claimed} true with
         * `organizing` false — and is what a failed resume used to report as organizing. Asymmetric
         * with the setter on purpose: a pass WRITES its intent, a caller READS what exists.
         */
        get organizer() {
          /* A MASK, NEVER A SOURCE. The mechanism can only WITHHOLD what the pass declared — it may
             not grant it: `claimed` is the INSTRUCTION, set at attach from the row, so a launch
             whose lease could not be read has it true with no pass behind it, and deriving from the
             mechanism alone would report that mailbox as organized. Measured by
             `connection-release.e2e.test.ts`'s unreadable-lease-at-launch case. */
          const running = organizer.organizing
            && organizer.claimed && timer !== null && !handedBack && !stopped;
          return organizer.organizing === running ? organizer : { ...organizer, organizing: running };
        },
        set organizer(v) { organizer = v; },
        get takeoverAuthorized() { return takeoverAuthorized; },
        set takeoverAuthorized(v) { takeoverAuthorized = v; },
        get observedTakeoverAt() { return observedTakeoverAt; },
        set observedTakeoverAt(v) { observedTakeoverAt = v; },
        get consented() { return consented; },
        set consented(v) { consented = v; },
        get foldersEnsured() { return foldersEnsured; },
        set foldersEnsured(v) { foldersEnsured = v; },
        get leaseNonce() { return leaseNonce; },
        set leaseNonce(v) { leaseNonce = v; },
        /* READ-ONLY on the record: the pending nonce is written by the gate and by the permit, at
           the instant a claim is minted, and a setter would be a second writer of an identity only
           the write path can know. See the field. */
        get leasePendingNonce() { return leasePendingNonce; },
        get profileSync() { return profileSync; },
        /* THE CONNECTION'S OWN ANSWER, derived and never stored: the pair of closure fields IS
           the state, and this shapes them for a caller. `reachable` is the negation of "we have
           observed a death that no re-dial has undone" — not a probe, and deliberately not one:
           asking the socket here would put an IMAP round trip on a settings render. */
        get connection() {
          /* `outageSince` AND NOT `connectionDeadSince` — see the field. The socket one clears the
             moment a dial succeeds, which is what stops a re-dial per poll; this one clears only
             when a cycle has actually been served. The row must follow the mailbox, not the
             socket, or a re-dial onto a live server with an unreadable lease reports a mailbox
             that is being organized when nothing is being filed. */
          return {
            /* AND NOTHING IS REACHABLE THAT WAS NEVER DIALLED. `outageSince === null` alone is
               the negation of an observed death, which a runtime that opened no socket at all
               cannot have — so a mailbox with no password answered `true` and Settings said "Up
               to date" over one that had never read a byte. See {@link needsCredential}: it is
               the state's own name, and the surfaces rank it above the outage arm. */
            reachable: outageSince === null && !needsCredential,
            unreachableSince: outageSince,
            /* NO PASSWORD ON THIS INSTALL — the state, not a diagnosis of the server. Rides
               beside `unreachableSince` rather than inside it: there is no outage clock to
               name, and an outage sentence would send somebody to look at a working network. */
            needsCredential,
            /* AND WHY, WHEN THE REASON IS THIS INSTALL'S OWN STORE rather than the server. No
               socket was opened at all here, so "can't reach the mail server" would send somebody
               to look at a network that is working. See {@link CredentialBlock}. */
            credentialBlocked: credentialBlock,
            /* AND WHETHER THE SETTINGS DOCUMENT CAN BE KEPT AT ALL — read off the profile sync,
               which is the only thing that knows. The drain cannot answer this: it says mail is
               coming down, and a claimed mailbox whose `ohmail/_meta` refuses every read drains
               perfectly while none of the person's rules can be read. See {@link ProfileBlock}. */
            profileBlocked: profileSync.profileBlock(),
            /* THE DIAGNOSIS, not just the fact. "Can't reach the mail server" over a server that
               answered and said no is the wrong sentence: it sends somebody to look at their
               network when the answer is their password. */
            signInRefused,
            /* AND WHAT THE FIRST SYNC PRODUCED, read in the same pass for the reason the record's
               own header gives: two reads would be two clocks. */
            firstSync: firstSync.state(),
          };
        },
        serialize,
        syncUntilQuiet,
        /* The foreground wake — see `LocalMailboxRuntime.redial`. The SAME function the poll runs,
           handed a second caller rather than reimplemented: a wake that dialled by its own route
           would be a second dial path, and the one thing both must do identically is take the
           lease gate before anything is moved. */
        redial: redialIfDead,
        credentialState: async () => (await resolveLogin()).state,
        forgetStoredLogin,
        async start() {
          // ── A PASSWORD THAT IS THERE AND CANNOT BE USED IS AN OUTAGE ──────────────────────
          //
          // One line used to cover three different facts. `absent` is genuinely quiet: nothing is
          // stored and a person is being asked for one. `unreadable` and `foreign-host` are the
          // opposite — this install WAS syncing, the sealed row is intact, and this launch served
          // nothing. Returning in silence left `outageSince` null with no retry armed, so Settings
          // said "Up to date" over a mailbox that had stopped. It is recorded as the outage it is,
          // on the same ladder an unreachable server gets; the credential is not discarded.
          if (login.state === "unreadable" || login.state === "foreign-host") {
            noteLoginUnusable(login.state);
            schedule();
            return;
          }
          // ── NO PASSWORD, NO CONNECTION — AND THAT IS NOT A FAILED LAUNCH ──────────────────
          //
          // Offline is a property of this mode: the organizer is paused and the viewer is
          // complete, so the bridge keeps serving the mirror and the shell shows a password
          // field. Throwing here instead would make a missing password look like a broken app,
          // and a mailbox whose key was replaced would be unrecoverable rather than one prompt
          // away. Deliberately BEFORE `connect()`: an empty password is a login attempt the
          // server will refuse, and a refused login on some providers counts toward a lockout.
          //
          // IT IS SAID, THOUGH. Returning in silence left `outageSince` null over a runtime that
          // had opened nothing, so the connections route answered `reachable: true` and the row
          // read "Up to date" — measured by signing out with two mailboxes and reconnecting only
          // the primary. Nothing is scheduled with it: with no password there is nothing to
          // retry, and the state is what a person acts on.
          // No second log line: the attach above already wrote `stored_login_absent` once, and a
          // state a surface renders is not news to repeat.
          if (login.state !== "ready" || !login.pass) {
            needsCredential = true;
            return;
          }
          /* …AND NOT AFTER A SIGN-OUT. Same shape and same place as the line above, for the same
             reason: this is not a failed launch, it is an install with no password to use. The
             throwing check in `dialAndGate` is what the re-dial meets; a launch answers quietly
             so a sign-out during boot does not surface as a broken app. */
          if (signedOutSinceDial()) {
            /* THE SAME STATE AS THE ARM ABOVE, and it is set for the arm above's reason: this
               runtime opened no socket, so nothing may report it reachable. */
            needsCredential = true;
            log("stored_login_absent", {
              mailboxId: mb.id,
              state: "absent",
              reason: "this install signed out while it was starting, so no login was opened on "
                + "the password this launch had already read",
            });
            return;
          }
          /* THE LAUNCH DIAL JOINS THE SAME WAIT `detach()` HONOURS.
           *
           * `detach()` awaited `tail` and the re-dial handle, but not this — so a removal landing
           * during a LAUNCH could close the adapter while `dialAndGate` was still inside it, and
           * the stand-down that arm now performs (releasing the claim the gate just renewed) would
           * be cut off by detach's own close. Re-dial and launch run the identical sequence; they
           * should be waited for identically. */
          let settleStart: () => void = () => {};
          redialInFlight = new Promise<void>((resolve) => { settleStart = resolve; });
          try {
            await dialAndGate();
          } catch (err) {
            /* A launch that could not dial is an OUTAGE, not a dead mailbox. `connect()` can reject
             * with the adapter emitting nothing (refused TCP, TLS failure, no greeting), so no
             * detector fired and `start()` threw before arming the poll — a mailbox reported
             * reachable for ever with no path to heal, the failure-looks-healthy shape from the one
             * direction nothing watched. So the death is recorded and the timer IS armed; `main.ts`
             * still learns the launch failed (rethrown). `null` for the adapter: `dialAndGate`'s
             * catch has ALREADY closed it (`connection-release.e2e.test.ts`), and a second close
             * here closed the login twice. */
            noteConnectionDead(err, generation, null);
            if (credentialsRefused(err)) {
              signInRefused = true;
              log("mailbox_sign_in_failed", {
                err, mailboxId: mb.id,
                reason: "the mail server answered this launch and rejected the sign-in; the " +
                  "mirror is served and nothing is dialled again until the password changes",
              });
            }
            schedule();
            throw err;
          } finally {
            settleStart();
          }
          // ARMED HERE and not inside the sequence above. `schedule()` returns at `stopped`,
          // which is the mailbox-was-removed arm's exit and the one path that must not poll.
          schedule();
          /* AND THE HEARTBEAT'S OWN TIMER, on the same rule and for the reason its field states:
             the probe may not depend on a cycle finishing. */
          armHeartbeat();
        },
        /**
         * STOP TAKING WORK AND WAIT OUT THE PASS ALREADY RUNNING — the half of a stop that must
         * happen BEFORE the caller writes anything about this mailbox. The removal route used to
         * run straight past a pass parked in a server call, which then committed its messages into
         * a tombstoned, emptied mailbox: mail left on the machine, its arrival announced after the
         * receipt that said the mailbox was gone. So the row and the mirror are not touched until
         * this returns. The login is left OPEN — the claim release needs it, and `detach()` closes
         * it on the SAME budget, so a removal costs one drain interval and not two.
         */
        async quiesce() {
          const waiting = queued > 0;
          /* WHO PUT IT ON HOLD, so `unquiesce` can only take back what this did. A runtime that
             was already stopped — a removal discovered mid-launch, a takeover that found the row
             gone — is NOT revived by a removal that then failed; it is still stopped for its own
             reason. The wait below runs either way: `stopped` can be set mid-pass. */
          heldForRemoval = !stopped;
          stopped = true;
          if (timer) clearTimeout(timer);
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          if (waiting) {
            log("local_mailbox_pass_awaited", {
              mailboxId: mb.id,
              pollIntervalMs: detachWaitMs,
              reason: "this mailbox was reading mail when it was stopped; the pass is waited out "
                + "before anything is written about the mailbox, so nothing it is carrying is "
                + "committed after the row has been removed",
            });
          }
          const wedged = !(await settledWithin(tail, stopLeft()))
            || !(await settledWithin(redialInFlight, stopLeft()));
          if (wedged) {
            log("local_mailbox_pass_not_awaited", {
              mailboxId: mb.id,
              pollIntervalMs: detachWaitMs,
              reason: "this mailbox did not finish its pass within one drain interval, so the stop "
                + "went ahead without it; the pass's own writes are refused against a removed "
                + "mailbox rather than committed behind it",
            });
          }
        },
        /**
         * TAKE THE MAILBOX BACK OFF HOLD — for the caller that quiesced and then did NOT remove it.
         *
         * `MailboxService.delete` can refuse (it owns the row check) or fail, and the removal
         * route holds the mailbox BEFORE it asks. Without this, a refused removal left a mailbox
         * the person still has with its poll timer cleared and its runtime stopped until the next
         * launch, while Settings went on reporting it reachable — the false-state class, reached
         * through a failure of the very act that is supposed to leave nothing behind.
         */
        noteWorldMoved,
        unquiesce() {
          if (!heldForRemoval) return;
          heldForRemoval = false;
          stopped = false;
          /* AND THE BUDGET GOES BACK TOO. It is a wall-clock instant, so a hold that was taken and
             released an hour ago would leave the next `detach()` with a budget already spent: it
             would wait zero, call itself wedged and destroy a live socket on a mailbox that is
             stopping normally. */
          stopStartedAt = null;
          /* The two timers the hold cleared, and nothing else: the login was never closed, the
             claim was never released, and the pass this hold waited out has already ended. */
          schedule();
          armHeartbeat();
        },
        /**
         * Stop this mailbox, give its claim back, and leave the store alone: one login and one
         * timer go down while the other mailboxes serve out of the same database. The in-flight
         * cycle is AWAITED, not cancelled — a drain mid-batch has rows committed and a cursor
         * about to move, and dropping it re-reads mail already had. BOUNDED, because a half-open
         * link has nothing to end a command: three waits (the queue, an in-flight re-dial, and
         * `close()`'s LOGOUT) share one drain interval, and when it runs out the socket is
         * DESTROYED, ending the hung command.
         */
        async detach() {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          /* The budget is armed by whichever stop method arrives first — `quiesce()` on the
             removal route, this one everywhere else — and `startedAt` is read back from it so the
             forced-teardown line below measures the whole stop rather than this method's slice. */
          const left = stopLeft;
          left();                                  // arms it where nothing has yet
          const startedAt = stopStartedAt as number;
          /* THE QUEUE, which a drain parked inside a serialized body holds. */
          let wedged = !(await settledWithin(tail, left()));
          /* AND THE RE-DIAL, WHICH IS NOT IN THE QUEUE — see {@link redialInFlight}. Without this
             a re-dial suspended in `connect()` resumes AFTER the teardown has closed the adapter
             and dropped the runtime, and then installs a fresh authenticated connection for a
             mailbox that no longer exists: an organizer claim renewed after the removal route
             released it, folders created in somebody's mailbox on the way out, and a login with
             no handle anywhere that can close it. `stopped` is already true here, so the re-dial's
             own re-checks turn this wait into an early exit rather than a full second dial.
             It SHARES the budget rather than getting its own: two bounds in sequence would be a
             stop that can take twice as long as the number this method promises. */
          if (!wedged) wedged = !(await settledWithin(redialInFlight, left()));
          /* AND THE CLAIM GOES BACK, then the LOGOUT — ONE wait, in that order. The claim first
             because the release needs the login; left standing it obstructs every other install
             for `DEFAULT_STALE_AFTER_MS` while the machine that wrote it is gone. Only where this
             install believes it organizes — a reader's release would be an IMAP read that can only
             fail. The logout's rejection still reaches the log: a server answering LOGOUT with an
             error is not one answering nothing. ONE `settledWithin`, started in a MICROTASK, both
             for the bound: a fourth hop re-derives its deadline, and `setTimeout` schedules against
             the loop's clock, which a synchronous prologue does not refresh — measured as a 299
             against a 300 ms bound. */
          if (!wedged) {
            const politely = Promise.resolve().then(() => (organizer.organizing
              ? releaseOwnClaim(
                adapter, installId, mb.id, { current: leaseNonce, pending: leasePendingNonce }, log,
                "this install is stopping and its claim could not be removed; it ages out of "
                  + "ohmail/_meta on its own and another install takes the mailbox then",
              ).then((released) => {
                leaseNonce = null;
                organizer = { ...organizer, organizing: false };
                if (released !== null && released > 0) {
                  log("organizer_claim_released_on_stop", {
                    mailboxId: mb.id,
                    claims: released,
                    reason: "this install stopped organizing this mailbox because it is shutting "
                      + "down, so the claim is given back rather than left to age out; the row is "
                      + "untouched and the next launch claims the mailbox again unless another "
                      + "install has taken it",
                  });
                }
              })
              : Promise.resolve()))
              .then(() => Promise.resolve(adapter.close()))
              .catch((err: unknown) => { log("adapter_close_failed", { err }); });
            wedged = !(await settledWithin(politely, left()));
          }
          if (!wedged) return;
          /* The same teardown the re-dial uses on a connection found dead, and for the same
             reason. `adapter` is re-read here, so a re-dial that installed a fresh one is the one
             that goes: this runtime is stopping, and the newest connection is the one with no
             owner. */
          const held = adapter;
          if (held.forceClose !== undefined) {
            try { held.forceClose(); } catch { /* the socket is going away regardless */ }
          } else {
            /* An injected double with no `forceClose`. NOT awaited — a teardown this method waits
               on is the latch it is escaping. */
            try { void Promise.resolve(held.close()).catch(() => undefined); }
            catch { /* threw synchronously; it is going away either way */ }
          }
          log("mailbox_detach_forced", {
            mailboxId: mb.id,
            pollIntervalMs: detachWaitMs,
            totalMs: Date.now() - startedAt,
            reason: "this mailbox did not let go within one drain interval — the cycle, the " +
              "re-dial or the logout was waiting on a link that answers nothing, which is what " +
              "a half-open link produces — so the connection was destroyed and the stop " +
              "completed. Destroying it is also what ends the hung command, so nothing is left " +
              "to log out and the mailbox's timers are already down",
          });
        },
        /**
         * The claim goes back; the row does not move (see `LocalMailboxRuntime.handBack`). Inside
         * `serialize`, so it cannot land between a gate's claim and the drain that claim authorises.
         * `releaseOwnClaim` is the same function the detach arm and release route call — a caller,
         * not a second way to give a claim up. `organizing` goes false whatever the release
         * answered: `drain` decides organizer-only work from it and the caller is an app about to
         * suspend, so "organizing" over a stopped process is the two-organizers reading. The ANSWER
         * only decides whether the caller may report the mailbox handed back — `null` means it may not.
         */
        async handBack() {
          return serialize(async () => {
            if (stopped) return 0;
            const released = await releaseOwnClaim(
              adapter, installId, mb.id, { current: leaseNonce, pending: leasePendingNonce }, log,
              "this install was asked to hand the mailbox back and the claim could not be "
                + "removed; it ages out of ohmail/_meta on its own and another install takes the "
                + "mailbox then",
            );
            if (released !== null && released > 0) {
              log("organizer_claim_handed_back", {
                mailboxId: mb.id,
                claims: released,
                reason: "the app is leaving the foreground and cannot organize while it is not "
                  + "running, so the claim is given back rather than left to age out. The row is "
                  + "untouched: this install is still the organizer of record and the next gated "
                  + "cycle claims the mailbox again unless another install has taken it",
              });
            }
            /* THE NONCE GOES WITH THE CLAIM, and what it buys is the STAND-DOWN'S OWN READING.
               `ownClaimTerm` answers `our_last_nonce` while this field still names a claim we
               armed and `no_armed_nonce` once it is null — and after a hand-back the second is the
               true one. It is also what a fresh launch holds, so a resume enters the gate in a
               launch's state. Removing this line reddens no cell: the next successful gate arms
               its own nonce over it, so the claim here is the log's truthfulness, not a defect. */
            leaseNonce = null;
            leasePendingNonce = null;
            /* CARRIED: a hand-back removes the CLAIM and deliberately leaves the row saying
               organizer, so it neither makes nor spends a person's stop. */
            organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null,
              releaseRequestedAt: organizer.releaseRequestedAt,
              /* THE CLAIM WENT BACK, and this is the field that says so. The ROW is deliberately
                 untouched — the next resume takes the mailbox again with no press — so it is the
                 only fact separating a phone that gave the mailbox back from one that holds it. */
              claimed: false };
            /* THE TIMER GOES WITH THE CLAIM, and the flag closes the doors the timer is not.
               Releasing alone left the poll armed: it fired, the gate read a row that still says
               organizer, and the mailbox was claimed again — by an install that was about to be
               suspended. See {@link handedBack}. */
            handedBack = true;
            if (timer) { clearTimeout(timer); timer = null; }
            return released;
          });
        },
        /**
         * Take the mailbox back if nobody else has it — the other half of `handBack`. It clears the
         * hand-back and runs ONE forced, ordinary gated cycle: the gate reads `ohmail/_meta` and
         * either claims a free mailbox or stands this install down against a holder. No press, no
         * row write, no way to displace anybody — a resume that could take a mailbox from another
         * machine would be the press without the person. `force` for the resync route's reason (the
         * re-dial wait must not hold the first cycle). The cycle re-arms the poll timer `handBack`
         * cleared; `0` cycles means it could not be served, so the caller must not report it taken.
         */
        async resume() {
          /**
           * A START THAT DID NOT FINISH STARTING IS NOT A START, and the missing half was the TIMER.
           *
           * The poll was armed only on the returning exit, so a failure after the gate claimed left
           * this install holding the mailbox with nothing polling or renewing while the surface said
           * "organizing". It is armed on BOTH exits now. A cycle that failed is the poll's business:
           * a holder whose drain was refused is still the organizer, and giving the mailbox back
           * over a bad network hands it to another machine for a hiccup. What makes the reported
           * state unreachable is the PAIR — this timer, and `organizing` derived as a mask.
           */
          handedBack = false;
          try {
            const served = await syncUntilQuiet(undefined, { force: true });
            /* `syncUntilQuiet` deliberately does not arm it — its own tail says so — and `handBack`
               cleared it. `schedule()` returns at `stopped`, so a runtime told to stop is not
               re-armed by a resume that raced it. */
            schedule();
            return served;
          } catch (err) {
            schedule();
            log("organizer_resume_cycle_failed", {
              mailboxId: mb.id,
              err,
              reason: "the forced cycle this resume ran did not complete; the poll is armed and "
                + "owns the retry, and what this install holds is unchanged — a claim is not given "
                + "back over a cycle that failed",
            });
            return 0;
          }
        },
        /* THE SAME LOOK THE POLL MAKES, THROUGH THE SAME ADAPTER — read at call time, because a
           re-dial replaces the binding and a captured one would peek down a dead socket. A stopped
           runtime answers `unreadable` rather than `free`: there is no connection to look with,
           and "we have no way to check" is the one thing that must not read as "nobody is there". */
        async peekOrganizer(): Promise<LeasePeekAnswer> {
          if (stopped) return { answer: "unreadable", op: "no_lease_peek_io", cause: undefined };
          return peekOrganizer();
        },
      };
      runtimes.add(rt);
      return rt;
    };

    /**
     * A pause an older build left is ended BEFORE the roster is read. The fourth write of the
     * in-place upgrade below, and the one that cannot sit with the other three: they repair a
     * credential the ATTACH seals (so they run after it), while this decides WHICH ROWS THE ATTACH
     * SEES. After the loop it would attach nothing this launch, so the mailbox returns one restart
     * later. {@link endLegacyOrganizerPauses} carries the shape and why the rewrite is a reader.
     * One line per row; the id and the reason, never the address.
     */
    try {
      for (const ended of await endLegacyOrganizerPauses(db, world.accountId, now())) {
        log("local_mailbox_pause_ended", {
          mailboxId: ended.id,
          disabledReason: ended.keptReason,
          /* Appointments the row could not keep, closed with the stand-down's own sentence — a
             send scheduled before the handover, which a reader's drain never reaches. */
          closed: ended.closedSends,
          reason: "a build older than this one recorded that another organizer had taken this "
            + "mailbox by switching the mailbox off; this launch rewrote the row to what it means "
            + "— a READER of that mailbox, mirror growing, organizing nothing — so it runs again "
            + "and can be asked to organize it. Nothing was claimed by the rewrite, and any "
            + "scheduled send it could no longer make was closed with a sentence",
        });
      }
    } catch (err) {
      log("local_mailbox_pause_end_failed", {
        err,
        reason: "a mailbox this install paused under an older version was not fully re-attached: "
          + "either the row still says paused — no connection and no poll timer this launch, and "
          + "the next launch tries again — or it is a reader whose scheduled send is still to be "
          + "closed, which this mailbox's own launch catch-up does on the next start",
      });
    }

    /**
     * Attach every live mailbox. Read ONCE, never on a timer — the only writers of this table are
     * this engine's own routes, so attach and detach are EVENTS. The seed is the row the configured
     * address names; every other is a mailbox added through the door, and the difference matters for
     * two things — the environment password and the process's submission server, both facts about
     * the seed. SEQUENTIALLY, inverting the concurrency rule elsewhere: each attach may WRITE the
     * credential table (a first launch's seal is one such write), and parallel writes into one
     * PGlite backend gain nothing since attaching does not dial — `start()` opens connections.
     */
    for (const row of await loadLocalRoster(db, world.accountId)) {
      await attachLocal(row, isSeedRow(row.address));
    }
    log("local_roster_attached", {
      count: runtimes.size,
      /* It counts RUNTIMES, and used to claim they held claims. The sentence ended "…and its own
       * organizer claim", but attaching does not dial (`start()` does), so the count is runtimes
       * and the clause printed verbatim for a mailbox this install merely READS — one with no claim
       * in `ohmail/_meta`. It cost a release investigation: an empty `ohmail/_meta` beside
       * `count: 1` read as this install believing it held a claim. A log line that overstates is
       * the same fault as a comment that overstates, and dearer. Whether this install organizes a
       * mailbox is the lease's answer, per mailbox, with its own lines. */
      reason: "every mailbox this install holds has a runtime: its own connection and its own poll "
        + "timer; whether it also organizes that mailbox is the lease's answer, logged per mailbox",
    });
    /* And the rows the roster read left out, by name. The count above says how many mailboxes this
     * install RUNS, not which, and `loadLocalRoster` omits every `disabled` row — a paused one and
     * a tombstone alike — so a mailbox this install holds but does not run was absent from the boot
     * record entirely. `ensureLocalWorld`'s lookup is WIDER than the roster's, so a paused row can
     * be the seed and the `serving` line then prints the id of the one mailbox with no runtime — an
     * incident that reads backwards from the log. One line per left-out row (the ordinary install
     * says nothing extra); the id and the reason, never the address. */
    for (const row of await loadUnattachedLocalRoster(db, world.accountId)) {
      log("local_mailbox_not_attached", {
        mailboxId: row.id,
        disabledReason: row.disabledReason,
        reason: "this install holds this mailbox and is not running it: no connection, no poll "
          + "timer and no organizer claim. A row with a reason is paused; one without is a "
          + "mailbox that was removed here",
      });
    }

    /* THE REPAIRS RUN AFTER THE ATTACH, and the order is the whole of whether they ever fire.
       On a FIRST launch the seed's incoming credential does not exist when this function starts —
       it is sealed inside `attachLocal`, out of the password this process was handed — so a repair
       placed ahead of the attach would find nothing to read and nothing to copy. The measured cost
       of that ordering was a fresh install that could not send for its whole first session and
       silently acquired the ability on its second launch, which is the shape of defect that gets
       reported as "it started working on its own". */
    /**
     * The in-place upgrade and the roster it leaves. Nothing moves — store, rows, credential and
     * the `ohmail/_meta` claim are byte-identical; only the READER changed (an install that ran one
     * mailbox now runs a roster of one). Four writes make it true, each keyed on a predicate false
     * once done (no marker, no journal). The FOURTH is above the attach loop (it decides which rows
     * the attach sees); the three below repair what the attach sealed — the seed row, the incoming
     * server backfilled onto the seed's `imap`, and the submission credential — because every
     * mailbox now dials from its own row, so a seed predating that would come up with no server.
     */
    const seedRow = world.mailboxId ? runtimeRosterRow(await loadLocalRoster(db, world.accountId), world.mailboxId) : null;
    if (seedRow) {
      /* 2. The incoming server. `sealedHost(meta) === null` is the whole predicate — the row does
       * not record which server it was proved against, the shape of every credential sealed before
       * the probe recorded one, and exactly what the new reader cannot dial from. It writes what
       * THIS launch is configured with — the only evidence, and the same pair the old reader
       * dialled, so a rollback finds a `meta.host` its `credentialIsForeign` agrees with. MERGED,
       * never replaced: the blob may already carry `smtpHost` or an OAuth block. */
      try {
        const [row] = await db
          .select({ meta: mailboxCredentials.meta })
          .from(mailboxCredentials)
          .where(and(
            eq(mailboxCredentials.mailboxId, seedRow.id),
            eq(mailboxCredentials.transport, "imap"),
          ))
          .limit(1);
        if (row && sealedHost(row.meta) === null && config.imap.host) {
          await db.update(mailboxCredentials)
            .set({
              /* Through the seam: the server's `||` is the shallow merge and on the device store
                 `||` concatenates STRINGS, so this spelling would have written two JSON documents
                 end to end into the column with nothing failing at the write. */
              meta: dialect(db).jsonMergeShallow(mailboxCredentials.meta, sql`${JSON.stringify({
                host: config.imap.host, port: config.imap.port,
                secure: config.imap.secure, user: config.imap.auth.user,
              })}`),
            })
            .where(and(
              eq(mailboxCredentials.mailboxId, seedRow.id),
              eq(mailboxCredentials.transport, "imap"),
            ));
          log("seed_login_server_recorded", {
            mailboxId: seedRow.id,
            reason: "this mailbox's stored password did not record which server it was proved "
              + "against, and every mailbox now dials from its own credential; the server this "
              + "launch is configured for was written onto it, which is where the previous "
              + "version dialled",
          });
        }
      } catch (err) {
        log("seed_login_server_record_failed", {
          err,
          reason: "the stored password does not say which server it belongs to; this launch dials "
            + "the configured server as before and the next launch tries the repair again",
        });
      }

      /* 3. The submission credential. The send path reads a mailbox's `smtp` row, so a seed that
       * never had one loses the ability to send on upgrade (its submission server was a process
       * setting, no longer consulted). THE SECRET IS COPIED, NEVER DECRYPTED: `secretEnc` and
       * `keyVersion` come from the `imap` row verbatim — same password, same mailbox, same key, so
       * the ciphertext is already what an `smtp` row should hold. Re-encrypting would put plaintext
       * in this process for nothing and break a boot whose key cannot open its own row. The `meta`
       * is the coordinates typed beside that password. */
      try {
        const rows = await db
          .select({
            transport: mailboxCredentials.transport,
            secretEnc: mailboxCredentials.secretEnc,
            keyVersion: mailboxCredentials.keyVersion,
            meta: mailboxCredentials.meta,
          })
          .from(mailboxCredentials)
          .where(eq(mailboxCredentials.mailboxId, seedRow.id));
        const imapRow = rows.find((r) => r.transport === "imap");
        const hasSmtp = rows.some((r) => r.transport === "smtp");
        /**
         * Which submission server this row is for — not simply "the configured one". This read
         * `config.imap.smtp`, which would let an install acquire a submission server nobody saved
         * the password for, just by relaunching with a different setting. The credential RECORDS
         * the host it was saved for (`meta.smtpHost`), and that is an authorization.
         * {@link sealedSmtpHost}'s three answers are the cases: a HOSTNAME — use it whatever this
         * launch configures; NOTHING (key absent) — predates the record, so the process setting is
         * honest; the EMPTY STRING — saved for a pair with NO submission server, so write nothing.
         */
        const witness = sealedSmtpHost(imapRow?.meta ?? null);
        const configured = config.imap.smtp;
        /**
         * And the port must come from the same server as the host. The witness records a HOSTNAME
         * only (a flat `meta.smtpHost`, so a merge cannot erase a stored port), so when it
         * DISAGREES with this launch's configuration there is no port to pair it with — taking the
         * configured one builds the row from two different servers (e.g. `{465-server, 587,
         * cleartext}`), written once and never healing. So a disagreeing witness writes NO ROW —
         * the old behaviour the send path's outgoing arm used to refuse, right because the person is
         * mid-change. The two agreeing cases (a match, or nothing recorded) are unchanged.
         */
        const witnessAgrees = witness !== null && witness !== ""
          && witness === (configured?.host ?? "").trim().toLowerCase();
        const smtp = witness === null || witnessAgrees ? configured : undefined;
        if (witness !== null && witness !== "" && !witnessAgrees) {
          log("seed_submission_login_unsettled", {
            mailboxId: seedRow.id,
            reason: "this mailbox's password was saved for a different outgoing server than this "
              + "launch is configured for, so no submission credential was written and sending is "
              + "refused; entering the password again records the pair that is wanted",
          });
        }
        if (smtp?.host) {
          if (imapRow && !hasSmtp) {
            /* THE SIGN-OUT FENCE, because this copies a SECRET. The rows above were read before
               this repair decided anything, so a sign-out landing in between would leave this
               writing the removed password back as an `smtp` row — the same window the shared
               PATCH carries, reached at boot instead of at a press. */
            const copyOrigin: CredentialOrigin = {
              row: "already-there", signedOutAt: await signedOutAtOf(seedRow.id),
            };
            await db.transaction(async (tx) => {
              await fenceSignedOutMailbox(tx as unknown as Tx, dialect(db), seedRow.id, copyOrigin);
              // The erasure fence, the seal's note above — this copies the same secret onto a
              // second transport, so an erased mailbox must refuse it for the same reason.
              await fenceErasedMailbox(tx as unknown as Tx, dialect(db), seedRow.id);
              await tx.insert(mailboxCredentials).values({
                mailboxId: seedRow.id,
                transport: "smtp",
                // The SAME ciphertext under the SAME key version. See the note above.
                secretEnc: imapRow.secretEnc,
                keyVersion: imapRow.keyVersion,
                meta: {
                  host: smtp.host, port: smtp.port, secure: smtp.secure,
                  user: config.imap.auth.user,
                },
                updatedAt: now(),
              });
            });
            log("seed_submission_login_copied", {
              mailboxId: seedRow.id,
              reason: "the outgoing server this install was configured with was written onto this "
                + "mailbox as its own credential, so sending keeps working now that every mailbox "
                + "submits through the server its own row names; no password was decrypted",
            });
          }
        }
      } catch (err) {
        log("seed_submission_login_copy_failed", {
          err,
          reason: "this mailbox has no stored outgoing server, so a send from it is refused until "
            + "the password is entered again; nothing else is affected and the next launch tries "
            + "the repair again",
        });
      }
    }

    // Where the "Opening your mailbox" seconds went — measurement only; nothing above behaves
    // differently for it. The four named phases are the awaited work this constructor is made of,
    // and `totalReadyMs` brackets all of it, so `totalReadyMs` minus the four is the unnamed
    // remainder (AI assembly, key ring, credential resolution, route table). Naming the phases is
    // the point — like `mailbox_attached` in the worker, a single number could not say which phase
    // dominated. Emitted at constructor EXIT, not per phase, so an ordinary launch gets one line.


    log("boot_phases", {
      pgliteOpenMs: opened.timings.pgliteOpenMs,
      adoptBaselineMs: opened.timings.adoptBaselineMs,
      migrateMs: opened.timings.migrateMs,
      compactMs: opened.timings.compactMs,
      /* WHICH MIGRATION PAID, beside the pass it cost. `migrateMs` alone said 237 834 on a 1.2 GB
         store and named nothing inside it. `null` — not `0` — where the store did not migrate here
         at all (the phone's, whose schema is the platform's): "none pending" and "not this open's
         business" are different answers and a reader must be able to tell them apart. */
      migrationsPending: opened.migrations?.pending ?? null,
      migrationsApplied: opened.migrations?.applied ?? null,
      slowestMigration: opened.migrations?.slowest?.migration ?? null,
      slowestMs: opened.migrations?.slowest?.ms ?? null,
      worldMs,
      totalReadyMs: Date.now() - tBoot,
    });
    /* BESIDE `boot_phases`, and for the same reason it is beside it: that line answers "where did
       the seconds go", and this one answers the question nobody could ask at all until now — how
       much memory this engine holds, and whether it settles. The first sample lands here so a
       launch killed before the first interval still leaves a floor on the record. See
       `startEngineVitals`; no threshold is attached to any of it. */
    const stopVitals = startEngineVitals(log, {
      ...(config.vitalsIntervalMs === undefined ? {} : { intervalMs: config.vitalsIntervalMs }),
      // The store's own heap, so a rise in `rss` can be attributed to the database or to the
      // engine instead of argued about. Read per sample from the live handle, never captured.
      storeBytes: () => opened.storeBytes(),
    });
    /* ONE PER PROCESS, because the "have I already said this import is running" half is per
       launch — see `first-sync.ts`. Built here rather than inside the drain, which runs per pass. */
    const firstSyncLog = createFirstSyncReporter(log);

    /**
     * ══ A WRITE CAME IN THROUGH A DOOR — the idle ladder's third reset ══
     *
     * The window and a paired device file their moves through the API, and the engine's next drain
     * is what puts them on the mail server. A ladder that slept through that would leave a move the
     * person watched happen up to a ceiling away from IMAP, so every answered non-GET asks ONE
     * question — has the account's change log moved since the last time a door write was noticed —
     * and forces a drain on every runtime if it has. A request that WROTE NOTHING moves no seq and
     * rings nothing, which is what stops a chatty door pinning the cadence at its base.
     */
    let lastDoorMark: string | null = null;
    let doorKickInFlight = false;
    const noteDoorWrite = (req: Request, res: Response): void => {
      if (req.method === "GET" || req.method === "HEAD" || res.status >= 400) return;
      if (doorKickInFlight) return;
      doorKickInFlight = true;
      void (async () => {
        try {
          const { max } = await seqBounds(db as unknown as Tx, world.accountId);
          const mark = max === null ? "empty" : max.toString();
          if (mark === lastDoorMark) return;
          lastDoorMark = mark;
          /* THE LADDER, NOT A DRAIN — and the restraint is the point. Forcing a pass per write
             would drain on the person's typing rhythm (a draft autosaves as they compose), far
             more often than the fixed cadence this replaced. `noteWorldMoved` promises the next
             drain within ONE BASE INTERVAL, which is the cadence the engine had before it rested,
             so nothing a door writes reaches the mail server later than it used to. */
          for (const rt of runtimes.all()) rt.noteWorldMoved();
        } catch {
          /* An unreadable change log rings nothing. The poll is still the floor. */
        } finally {
          doorKickInFlight = false;
        }
      })();
    };

    return {
      app,
      db,
      repo,
      /* THE SEED's adapter. The field predates multi-mailbox and its consumers are the
         single-mailbox surfaces; `undefined` would be a breaking shape for them, so an install
         with no mailbox at all is given a refusing stand-in rather than an absence. Anything
         wanting a SPECIFIC mailbox's connection asks the roster. */
      get adapter() {
        const rt = seedRuntime();
        if (rt) return rt.adapter;
        throw new ServiceError(
          "upstream_unavailable", 502,
          "this install has no mailbox connected, so there is no mail server to talk to",
        );
      },
      world,
      sessionToken: session.token,
      handle: async (req) => {
        // Two routes ahead of the shared table, and why they are not in it. `DELETE
        // /local/stored-login` (forget the password sealed on THIS machine) and `POST
        // /local/organizer/takeover` (make THIS install the organizer of its own mailbox row) are
        // facts about a local store `packages/api`'s hosted-shared table has no meaning for — the
        // hosted takeover is `POST /mailboxes/:id/takeover`, a different authority. Both carry the
        // per-launch bearer (`resolveSession`), added shell-side and never reaching the window, so
        // a page cannot compose them; the Cloud door (`cloud-engine.ts`) serves neither. On
        // `handle` ALONE, never `handleHost`/`handleLan`: those serve a PAIRED DEVICE, and both are
        // statements about THIS COMPUTER. The separation is structural — `desktopHostRoutes` has
        // never heard of these paths, so both network doors fall through to the static handler.
        const url = new URL(req.url);
        const localRemoveMatch = req.method === "DELETE"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* `POST /local/mailboxes/:id/organize` — the first-run consent, on this door. The shared
         * `POST /mailboxes/:id/organize` is `stepUp: true`, which HERE is a permanent refusal: the
         * launch session's second-factor stamp is written once at boot (`identity.ts`), so
         * `withStepUp` refuses from five minutes after launch for the life of the process — and
         * this is the standalone install's only onboarding path. The authority is the per-launch
         * bearer (minted at boot, added shell-side, never reaching the window). `stepUpWindowMs` is
         * NOT widened: the fault is applying a second factor to a tier that has none. */
        const localOrganizeMatch = req.method === "POST"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})\/organize$/.exec(url.pathname)
          : null;
        /* `PATCH /local/mailboxes/:id` — sealing the mailbox password, on this door. The shared
         * `PATCH /mailboxes/:id` is `stepUp: true` (correctly — its body carries a password), but
         * the launch session's second-factor stamp is written ONCE at boot, so on this door it
         * refuses from five minutes after launch: a measured "recent two-factor authentication
         * required" on re-connect. It LOOKED like it worked because the first connect seals inside
         * that fresh-stamp window; only the re-connect met the refusal, so routing both here makes
         * the first's success structural. The SERVICE is `MailboxService.update` with the shared
         * route's probes — transport and authority, never a second credential write. */
        const localSealMatch = req.method === "PATCH"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* `POST /local/mailboxes` — adding a mailbox, on this door. The shared `POST /mailboxes` is
         * not `stepUp: true`, but every other verb this flow needs is, and a door that could add a
         * mailbox but not seal, remove or organize it would be worse than one that could not add.
         * The authority is the per-launch bearer (minted at boot, added shell-side, never reaching
         * the window), as for all five. On `handle` ALONE: adding a mailbox to someone's computer is
         * a statement about THIS COMPUTER, and the separation is structural — `desktopHostRoutes`,
         * which the network doors route through, has never heard of this path. */
        const localAddMatch = req.method === "POST" && url.pathname === "/local/mailboxes";
        /* `POST /local/mailboxes/probe` — testing a connection, on this door. The shared
         * `POST /mailboxes/probe` is `stepUp: true` (its body carries a password), so on this door
         * it refuses from five minutes after boot (measured: the mail server's own refusal at 170 s,
         * `403 step_up_required` at 330 s). It used to be satisfiable only by accident — the connect
         * form was withheld once a mailbox existed — but Settings → Add mailbox makes the form
         * reachable any time with its primary disabled until a verdict, so without this route "Add
         * mailbox" is a dead end. The SERVICE is `MailboxService.probeConnection` with
         * `countFolders: true`; it writes NOTHING. The authority is the per-launch bearer, on
         * `handle` ALONE — a probe opens a socket to a host in its body. */
        const localProbeMatch = req.method === "POST" && url.pathname === "/local/mailboxes/probe";
        /* `GET /local/mailboxes/connections` — can this machine reach them right now. A third route
         * ahead of the shared table: it reports the liveness of sockets THIS PROCESS holds, which
         * the hosted service (mailboxes attached by a worker on a shard) has nothing to report, so
         * adding it there would be hosted surface invented for a desktop lifecycle. NOT a column: a
         * dead connection does not survive a restart, and recording it durably would make every
         * first boot after an outage report a connected mailbox as unreachable. On `handle` ALONE,
         * like its neighbours — whether THIS COMPUTER's socket is up is a question for the person at
         * it, and a phone's view of its host is the pairing layer's answer. */
        const localConnectionsMatch = req.method === "GET"
          && url.pathname === "/local/mailboxes/connections";
        /* `DELETE /local/stored-login` — signing out of this install, NAMED because one line
           below treats it apart from its neighbours: it is the only door here that opens on an
           expired launch bearer, since it is the way OUT of the state that expiry creates. */
        const localSignOutMatch = req.method === "DELETE" && url.pathname === "/local/stored-login";
        const localAction = localConnectionsMatch
          || localSignOutMatch
          || (req.method === "POST" && url.pathname === "/local/organizer/takeover")
          || localRemoveMatch !== null
          || localOrganizeMatch !== null
          || localSealMatch !== null
          || localProbeMatch
          || localAddMatch;
        /* WHICH DOOR, as a pattern rather than a path — the shape `packages/api`'s own
           middleware logs (`route: route.pattern`). Two of these share a pattern and differ by
           method, which is why both fields ride every line. */
        const localActionRoute = localOrganizeMatch !== null
          ? "/local/mailboxes/:id/organize"
          : localRemoveMatch !== null || localSealMatch !== null
            ? "/local/mailboxes/:id"
            : localProbeMatch
              ? "/local/mailboxes/probe"
              : localAddMatch
                ? "/local/mailboxes"
                : localConnectionsMatch
                  ? "/local/mailboxes/connections"
                  : url.pathname === "/local/stored-login"
                    ? "/local/stored-login"
                    : "/local/organizer/takeover";
        /** The row id where the PATH carries one; "" where it does not. */
        const localActionMailboxId =
          (localRemoveMatch ?? localOrganizeMatch ?? localSealMatch)?.[1] ?? "";
        if (localAction) {
          /* The receipt, before any branch. With only a verdict logged, "the press never reached
           * the door" and "the door took it and dropped it" leave identical evidence, so this sits
           * ABOVE the credential read — that read is the first branch, and its refusal answered in
           * silence. The route PATTERN, never the request's path; `mailboxId` is empty where the
           * path carries none, and for the takeover whose id is in an unread body. The connections
           * GET is excluded — Settings reads it four times a minute, and it needs a rate floor
           * rather than a receipt. */
          if (!localConnectionsMatch) {
            log("local_action_received", {
              method: req.method,
              route: localActionRoute,
              mailboxId: localActionMailboxId,
              reason: "a local action door was asked to do something; the verdict for it is a " +
                "separate line, and its absence after this one means the door dropped the request",
            });
          }
          const header = req.headers.get("authorization");
          const token = header && /^Bearer\s+/i.test(header)
            ? header.replace(/^Bearer\s+/i, "").trim()
            : "";
          const live = token ? await resolveSession(db, token, now()) : null;
          /* ── THE WAY OUT OF A BROKEN SESSION MAY NOT DEPEND ON IT ─────────────────────────
           *
           * The launch bearer has no refresh ceremony, so after a day it expires and every route
           * here answers 401 — SIGN OUT with them, which made the one action that ends a broken
           * session need the broken thing. Its life is NOT extended: this asks the expiry
           * question only for the sign-out door, and only once the ordinary resolution has said
           * no. Every other route still refuses at the same minute it always did, and the
           * credential is cleared on this path alone — never on a 401 from anywhere else.
           * See {@link resolveExpiredLaunchSession} for what stays required. */
          const staleLaunch = live === null && token !== ""
            ? await resolveExpiredLaunchSession(db, token)
            : null;
          /* ADMITTED ON THE SIGN-OUT DOOR ALONE. Every other route reads `staleLaunch` only to
             SAY which refusal this is — see the 401 below, and the reason it is not one code. */
          const core = live ?? (localSignOutMatch ? staleLaunch : null);
          if (!core) {
            /* THE VERDICT FOR THE ONE REFUSAL EVERY DOOR HERE SHARES. Without it the receipt
               above is followed by nothing, which is the state it was added to end. */
            log("local_action_refused", {
              method: req.method,
              route: localActionRoute,
              status: 401,
              reason: staleLaunch
                ? "this install's launch session has expired, so nothing was read or written. " +
                  "The bearer is this install's own and the clock is what refused it; the shell " +
                  "is told which refusal this is so a person is not left reading silence"
                : "the request carried no launch bearer this install recognises, so nothing " +
                  "was read or written",
            });
            /* TWO CODES, BECAUSE THEY ARE TWO STATES AND ONLY ONE OF THEM HAS A REMEDY. An
               unrecognised bearer is a request nobody here can place; an EXPIRED one is this
               install's own, and the surface that polls this route rendered its refusal as "Can't
               check the mail server right now" — a silence that reads as no new mail while the
               day-old session quietly refused every poll. Named, so the row can say what
               happened and what to press. */
            return new Response(
              JSON.stringify(staleLaunch
                ? {
                    error: {
                      code: "launch_session_expired",
                      message: "this install's sign-in expired; sign in again to keep reading mail",
                    },
                  }
                : { error: { code: "unauthorized", message: "authentication required" } }),
              { status: 401, headers: { "content-type": "application/json" } },
            );
          }
          if (staleLaunch && live === null) {
            log("local_sign_out_on_expired_launch", {
              route: localActionRoute,
              reason: "this install's launch session had expired, so every route was answering " +
                "401 — signing out among them. The sign-out is performed on the expired bearer " +
                "rather than refused: the way out of a broken session never depends on it",
            });
          }
          if (localOrganizeMatch) {
              /* Agree and start organizing, with the window in the SAME write. The ceremony is
               * `requestOrganizerTakeover`'s and is not re-implemented here — transport and outcome.
               * What is new is that the screening answer travels with the consent:
               * `screening_baseline_at`, `dormancy_days` and `screening_scope` are written in the
               * same transaction as `organize_consented_at`, because the baseline is what the window
               * is measured from — written separately, there is a gap in which the cutoff is the
               * default. The account is the LAUNCH SESSION's, never a value from the body. */
            const mailboxId = localOrganizeMatch[1]!;
            let body: { intent?: unknown; screening?: { dormancyDays?: unknown; scope?: unknown } } = {};
            try {
              body = (await req.json()) as typeof body;
            } catch {
              /* an absent or unparseable body is "no screening answer" — the claim-back shape */
            }
            // The dial arrives over JSON, so a string that looks like a number is a real shape.
            // It is NOT coerced: `requestOrganizerTakeover` refuses a non-integer, and coercing
            // here would turn a client bug into a silently different window.
            const raw = body.screening;
            const screening = raw
              ? {
                  ...(raw.dormancyDays === undefined
                    ? {}
                    : { dormancyDays: raw.dormancyDays as number }),
                  ...(raw.scope === undefined ? {} : { scope: raw.scope as "window" | "all_time" }),
                }
              : undefined;
            try {
              const result = await requestOrganizerTakeover(db, {
                mailboxId, now: now(), accountId: core.accountId,
                /* THE VERB, AND THE BODY MAY ONLY WEAKEN IT — `packages/api`'s `organizeInputOf`
                   rule, spelled the same way on this door because this door writes the same
                   stamp. `"join"` is the one admitted value; anything else is the takeover this
                   desktop's button has always meant. The PHONE's door does not depend on its app
                   sending it (`mobile.ts` writes it over every consent request it forwards), so a
                   caller can ask for less than the button and never for more. */
                intent: body.intent === "join" ? "join" : "takeover",
                ...(screening ? { screening } : {}),
              });
              log("local_mailbox_organize_consented", {
                verdict: result.outcome,
                // The ANSWER, never the mailbox: this line is instrumentation about a ceremony,
                // and `ALLOWED_FIELDS` drops anything else anyway.
                reason: "a person agreed to let this machine organize this mailbox; the consent, "
                  + "the screening baseline and the window were written together, and the lease "
                  + "is still the authority",
              });
              return new Response(
                JSON.stringify({ outcome: result.outcome, previousReason: result.previousReason }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            } catch (err) {
              // A refused screening answer is a 400 with the refusal's own sentence; anything
              // else is internal. Mapped by hand because this handler sits AHEAD of the route
              // table and therefore ahead of `withErrorEnvelope`.
              const refused = (err as { name?: string }).name === "LocalConsentRefusal";
              log("local_mailbox_organize_failed", { err });
              return new Response(
                JSON.stringify({
                  error: refused
                    ? { code: "validation_failed", message: (err as Error).message }
                    : { code: "internal", message: "internal error" },
                }),
                { status: refused ? 400 : 500, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (localConnectionsMatch) {
            /* Instants as ISO strings, `null` while reachable — the shape every other lifecycle
               instant on this transport takes, so the shell parses it the same way. No mailbox
               address and no server name: which provider a person is on is the identifying
               signal this package keeps off the wire's diagnostics, and the row id is what
               correlates this with the list the pane already holds. */
            const items = runtimes.all().map((r) => ({
              mailboxId: r.mailboxId,
              reachable: r.connection.reachable,
              unreachableSince: r.connection.unreachableSince?.toISOString() ?? null,
              signInRefused: r.connection.signInRefused,
              /* NO PASSWORD FOR THIS MAILBOX ON THIS COMPUTER — a flat boolean, because there is
                 nothing else to say: no clock, no code, no server involved. A surface older than
                 the field reads an absent one as `false`, which is the state this install was in
                 before the field existed. */
              needsCredential: r.connection.needsCredential,
              /* THE STORED-PASSWORD BLOCK, as the object it is — a state and whether a second
                 read confirmed it. Two flat fields would admit "confirmed" with nothing to be
                 confirmed about. No server name and no address, like every other field here. */
              credentialBlocked: r.connection.credentialBlocked,
              /* THE SETTINGS-DOCUMENT BLOCK, on the same reasoning and in the same shape: the
                 refusal's own code and whether it has been seen enough times to say. The code is
                 an identifier this build produces, never a server's text — nothing here carries
                 a message, a server name or an address. */
              profileBlocked: r.connection.profileBlocked,
            }));
            /* One line where this route answers, so a question that never arrived can be told
               from an answer that was refused — from the log's side those are the same absence.
               Counts only: no address, no server name. Change-or-once-a-minute, see
               {@link LOCAL_CONNECTIONS_LOG_EVERY_MS}. */
            const serving = items.filter((i) => i.reachable).length;
            const refused = items.filter((i) => i.signInRefused).length;
            const answeredLine = JSON.stringify({ mailboxes: items.length, serving, refused });
            const answeredAt = now().getTime();
            if (answeredLine !== connectionsAnsweredLine
              || answeredAt - connectionsAnsweredAt >= LOCAL_CONNECTIONS_LOG_EVERY_MS) {
              connectionsAnsweredLine = answeredLine;
              connectionsAnsweredAt = answeredAt;
              log("local_mailbox_connections_answered", {
                mailboxes: items.length, serving, refused,
                reason: "the Settings pane asked this install which of its mailboxes it can " +
                  "reach right now, and this is what it was told. A GAP in these lines while the " +
                  "pane is open means the question stopped arriving — the answer would have been " +
                  "logged either way",
              });
            }
            return new Response(JSON.stringify({ items }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          if (localProbeMatch) {
            /* THE PROBE, AND ONLY THE PROBE. `probeConnection` dials and answers; it takes no
               transaction and touches no table, so there is nothing to undo on a refusal and
               nothing to attach on success. The refusal shape is the shared route's verbatim —
               `mailbox_probe_failed` with its `details.reason` — because the window's own
               classifier (`localProbeReason`) reads exactly that taxonomy and the connect form
               already renders every member of it. */
            try {
              const body = (await req.json()) as Record<string, unknown>;
              const imap = (body.imap && typeof body.imap === "object" ? body.imap : {}) as
                Record<string, unknown>;
              const deps = depsFor();
              const dto = await deps.services!.mailbox.probeConnection(
                {
                  db, accountId: core.accountId, userId: core.userId,
                  now, requestId: "", sessionId: core.sessionId ?? null,
                } as never,
                {
                  address: typeof body.address === "string" ? body.address : "",
                  /* FIELD BY FIELD, NEVER A SPREAD — the shared route's own rule, and it is
                     sharper here: this object reaches a function that opens a socket to a host
                     named in it, so spreading a caller-supplied object into it would let the
                     caller name fields this route never meant to expose. */
                  imap: {
                    host: typeof imap.host === "string" ? imap.host : "",
                    ...(typeof imap.port === "number" ? { port: imap.port } : {}),
                    ...(typeof imap.secure === "boolean" ? { secure: imap.secure } : {}),
                    ...(typeof imap.user === "string" ? { user: imap.user } : {}),
                    pass: typeof imap.pass === "string" ? imap.pass : "",
                  },
                },
                { probe: makeImapProbe(deps, { ...probeOpts, countFolders: true }) },
              );
              return new Response(JSON.stringify(dto), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              const e = err as { code?: string; httpStatus?: number; message?: string; details?: unknown };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              log("local_mailbox_probe_failed", { err });
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                    /* THE DETAILS TRAVEL. `localProbeReason` reads `details.reason` to pick the
                       form's sentence, and `probeTlsSentence` reads `details.tls` to name the
                       host a certificate actually covers — dropping them would put the service's
                       generic line on screen while the answer sat unread in the same response,
                       which is the defect the door's own TLS branch was written to end. */
                    ...(status === 500 || e.details === undefined ? {} : { details: e.details }),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (localAddMatch) {
              /* The service is the shared one, with both probes. `MailboxService.create` writes the
               * row and credential in ONE transaction and refuses a password it could not log in
               * with, because the probes are injected — the same pair the shared `PATCH` and the
               * seal route inject. Anything less makes this a second door into `mailbox_credentials`,
               * storing a secret nothing has tried. The mailbox count is not gated here: the tier is
               * `UNMETERED` (the limit is the user's own disk), declared in `localServices`. The
               * account is the LAUNCH SESSION's, never a value from the body. */
            /* THE SIGN-OUT FENCE, read before anything is awaited — see the seal route above. The
               create dials too, so it holds the same window open. */
            const addWrite = fence.begin();
            try {
              const body = (await req.json()) as Record<string, unknown>;
              const deps = depsFor();
              const ctx = {
                db, accountId: core.accountId, userId: core.userId,
                now, requestId: "", sessionId: core.sessionId ?? null,
              };

                /* The same-login refusal, ahead of the write. TWO ROWS ON ONE PHYSICAL MAILBOX is
                 * the one state this door must not reach. The address index forbids two live rows
                 * with the same ADDRESS, but a person reaches one mailbox under several (alias,
                 * plus-tag, bare login); what decides the same MAILBOX is the host/user pair the
                 * server answered to. It matters here because this install writes ONE claim per
                 * mailbox under its id, so two rows would write two claims with one id and the
                 * lease's clone defence would stand them down alternately for ever. Compared on what
                 * the probe PROVED (the create is the dial), and the row is removed on refusal so a
                 * 409 leaves the store as it found it. */
              const before = await db
                .select({ id: mailboxes.id, meta: mailboxCredentials.meta })
                .from(mailboxCredentials)
                .innerJoin(mailboxes, eq(mailboxes.id, mailboxCredentials.mailboxId))
                .where(and(
                  eq(mailboxes.accountId, core.accountId),
                  sql`${mailboxes.status} <> 'disabled'`,
                  eq(mailboxCredentials.transport, "imap"),
                ));

              const dto = await keepingIncoming(body, (b) => deps.services!.mailbox.create(
                ctx,
                b as never,
                { probe: makeImapProbe(deps, probeOpts), smtpProbe: makeSmtpProbe(deps, smtpProbeOpts) },
              ));

              if (addWrite.stale()) {
                /* THE SIGN-OUT FENCE, and here the undo is the whole mailbox rather than the
                   credential: this row did not exist when the person signed out, so leaving it
                   would add a mailbox to an install that had just been emptied. Through the same
                   shared service as the duplicate refusal below, for its reason — tombstone,
                   credential and appointments are one path. */
                try {
                  await deps.services!.mailbox.delete(ctx, dto.id);
                } catch (undoErr) {
                  log("local_mailbox_add_undo_failed", {
                    err: undoErr,
                    reason: "a mailbox added while this install was signing out could not be "
                      + "removed again; removing it from the pane clears it",
                  });
                }
                log("local_mailbox_seal_discarded", {
                  mailboxId: dto.id,
                  reason: "this install signed out while the password was being checked, so the "
                    + "mailbox the check added was removed again and nothing dials on it",
                });
                throw signedOutMidWrite();
              }

              const [proven] = await db
                .select({ meta: mailboxCredentials.meta })
                .from(mailboxCredentials)
                .where(and(
                  eq(mailboxCredentials.mailboxId, dto.id),
                  eq(mailboxCredentials.transport, "imap"),
                ))
                .limit(1);
              const same = (a: unknown, b: unknown): boolean => {
                const host = (m: unknown): string =>
                  ((m as { host?: unknown })?.host as string ?? "").trim().toLowerCase();
                const user = (m: unknown): string =>
                  ((m as { user?: unknown })?.user as string ?? "").trim().toLowerCase();
                /* BOTH SIDES MUST SAY SOMETHING. A row that records neither host nor user cannot
                   be proved the same as anything, and treating "we do not know" as a match would
                   refuse a legitimate second mailbox on the strength of an absence. */
                return host(a) !== "" && user(a) !== "" && host(a) === host(b) && user(a) === user(b);
              };
              const clash = before.find((r) => same(proven?.meta, r.meta));
              if (clash) {
                /* Undo the write. The service committed a row and a credential; answering 409 and
                   leaving them would be a refusal that added a mailbox. Removed through the same
                   shared service, so the tombstone, credential and appointments are one path. The
                   proof comes AFTER the write because only a dial can say which mailbox a login
                   opens, and the create IS that dial — probing first then creating would dial the
                   server twice, and the per-address probe admission is two. It leaves a tombstone
                   for an address never connected: inert, meaning "removed, may be re-added", with no
                   mirror rows because nothing ever synced. */
                try {
                  await deps.services!.mailbox.delete(ctx, dto.id);
                } catch (undoErr) {
                  log("local_mailbox_add_undo_failed", {
                    err: undoErr,
                    reason: "a mailbox this door refused as a duplicate of one already connected "
                      + "could not be removed again; it is left disconnected and removing it from "
                      + "the pane clears it",
                  });
                }
                log("local_mailbox_add_refused", {
                  verdict: "same_login",
                  reason: "this login opens a mailbox this machine already holds; two rows over "
                    + "one mailbox would write two claims into it under one install identity and "
                    + "stand each other down in turn",
                });
                return new Response(
                  JSON.stringify({
                    error: {
                      code: "same_login",
                      message: "this machine already has that mailbox. The server and username "
                        + "you entered open a mailbox that is already connected here.",
                    },
                  }),
                  { status: 409, headers: { "content-type": "application/json" } },
                );
              }

                /* And the engine beside the row. The shared service knows about ROWS; it has no idea
                 * that on THIS door a process must open a connection, hold a lease and run a poll
                 * timer for what it wrote. Attaching here makes the answer true — by the 201 the
                 * mailbox is running, so the pane's first poll finds a live row. NOT the seed (the
                 * seed is the configured address; this is another): no environment password, no
                 * process submission server, only the credential the probe proved. `start()` is not
                 * awaited — connect, folders and a first drain are minutes and the person waits on a
                 * form — and a failure leaves a connected row whose next poll retries. */
              /* THE ROW AS THE STORE HOLDS IT, not a hand-built one. A freshly created mailbox has
                 no stand-down and no stamp, so asserting nulls happens to be right today — and it
                 is the kind of right that stops being right the moment `create` grows a column.
                 Reading the roster is one indexed query and it cannot drift. */
              const freshRow = (await loadLocalRoster(db, core.accountId)).find((r) => r.id === dto.id);
              /* THE ATTACH MAY NOT TURN A COMMITTED MAILBOX INTO A 500. `mailbox.create` has
                 already written the row and the credential; an attach that throws inside the same
                 `try` would answer "internal error" over a mailbox that exists, which is the store
                 changed by a request that reported failure — the opposite of what the 409 path is
                 careful about. A mailbox that could not be attached is a mailbox that starts at the
                 next launch, which is a state this door already has words for. */
              let attached: LocalMailboxRuntime | null = null;
              try {
                attached = await attachLocal(
                  freshRow ?? {
                    id: dto.id, address: dto.address, displayName: dto.displayName ?? null,
                    standDownReason: null, takeoverAuthorizedAt: null, takeoverIntent: "join",
                  },
                   /* Never the seed — this was `isSeedRow(dto.address)` for one round, on the
                    * reasoning that an added mailbox cannot be the configured address because the
                    * same-login refusal would catch it. It is WRONG (`identity.ts` case 5): the
                    * refusal scans `status <> 'disabled'`, so a TOMBSTONED seed is invisible, and
                    * re-adding it made `isSeedRow` answer true for a just-proved row, after which the
                    * runtime dialled the stale `config.imap` and `credentialIsForeign` withheld the
                    * password. At boot the question is "which row does the settings file describe"
                    * (`isSeedRow`); here the row deliberately does not touch the settings file, so
                    * its proven credential is the only honest dial source. */
                  false,
                );
              } catch (attachErr) {
                log("local_mailbox_attach_failed", {
                  err: attachErr,
                  reason: "this mailbox was added and its password stored, but it could not be "
                    + "started in this launch; it starts with the others the next time the app is "
                    + "opened, and nothing about it was left half-written",
                });
              }
              void attached?.start().catch((err: unknown) => {
                log("mailbox_start_failed", { err });
              });
              log("local_mailbox_added", {
                verdict: "added",
                reason: "a person connected another mailbox to this machine; its password was "
                  + "proved against its own server before anything was stored, and it is running "
                  + "with its own connection, poll timer and organizer claim",
              });
              return new Response(JSON.stringify(dto), {
                status: 201, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              const e = err as { code?: string; httpStatus?: number; message?: string };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              log("local_mailbox_add_failed", { err });
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            } finally {
              addWrite.settle();
            }
          }
          if (localSealMatch) {
              /* Sealing the mailbox password, on the launch bearer. The SERVICE is
               * `MailboxService.update` and the PROBES are the shared `PATCH /mailboxes/:id`'s —
               * `makeImapProbe`/`makeSmtpProbe` over this request's deps, inheriting the deadline,
               * timeouts and IMAP admission counter. A password that cannot log in is refused HERE;
               * anything less makes this a second door into `mailbox_credentials`, storing a secret
               * nothing has tried. The account comes from the resolved launch session, never the
               * body. */
            const mailboxId = localSealMatch[1]!;
            /* THE SIGN-OUT FENCE. The probe below dials the server and commits afterwards, so a
               sign-out can run to completion inside this call — proving the row gone and
               answering — and this write then seals the password again. The epoch is read here,
               before anything is awaited; the verdict is taken after the write, because by then
               the row may already be committed and discarding it is the only honest undo. */
            const sealWrite = fence.begin();
            try {
              const deps = depsFor();
              const body = (await req.json()) as Record<string, unknown>;
              const dto = await keepingIncoming(body, (b) => deps.services!.mailbox.update(
                {
                  db, accountId: core.accountId, userId: core.userId,
                  now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
                b as never,
                { probe: makeImapProbe(deps, probeOpts), smtpProbe: makeSmtpProbe(deps, smtpProbeOpts) },
              ));
              if (sealWrite.stale()) {
                /* BEFORE THE RE-POINT, so a mailbox is never attached on a credential that is
                   about to be removed. Every transport of this mailbox, because the update writes
                   the incoming and submission rows together. */
                await discardCredentialsFor(mailboxId);
                log("local_mailbox_seal_discarded", {
                  mailboxId,
                  reason: "this install signed out while the password was being checked, so the "
                    + "credential the check stored was removed again and nothing dials on it",
                });
                throw signedOutMidWrite();
              }
                /* And the running mailbox is re-pointed, not left for the next launch. "Takes effect
                 * on next launch" was tolerable for the SEED only because the shell replaces the
                 * engine (the next launch seconds away); there is no such gesture for mailbox two,
                 * so a person fixing its password would watch it stay broken until they quit. A
                 * detach and a fresh attach — not a live mutation, since the credential decides the
                 * connection, lease identity, cursors and sync bag, and re-pointing those under a
                 * mid-cycle poll is how two connections disagree. The SEED is left alone: its door
                 * already replaces the engine, and doing both tears down a mailbox a new one starts. */
              const live = runtimes.get(mailboxId);
              if (live && mailboxId !== world.mailboxId) {
                try {
                   /* Detach first, then the attach may THROW. The login is closed and the timer
                      cleared, so the mailbox is not left with no runtime while the log claims it
                      still uses its connection. It matters because `DELETE /local/mailboxes/:id`
                      keys on the roster: a mailbox missing from it is removed WITHOUT releasing its
                      claim or wiping its mail — the phantom organizer and doubled mailbox, reached
                      through a failed password change. The old runtime cannot be revived (its
                      adapter is closed), so the roster entry is restored on failure and the next
                      launch re-attaches; what is lost is the poll until then. */
                  await live.detach();
                  runtimes.delete(mailboxId);
                  /* THE ROW AS IT NOW STANDS — a re-point must not erase this mailbox's own
                     stand-down memory or an outstanding takeover stamp. Asserting nulls here would
                     make re-entering a password an auto-resume for a mailbox somebody had taken
                     away from this machine. */
                  const repointed = (await loadLocalRoster(db, core.accountId)).find((r) => r.id === dto.id);
                  const attached = await attachLocal(
                    repointed ?? {
                      id: dto.id, address: dto.address, displayName: dto.displayName ?? null,
                      standDownReason: null, takeoverAuthorizedAt: null, takeoverIntent: "join",
                    },
                    /* NOT THE SEED, on the add route's reasoning above and one of its own: this
                       reattach follows a PATCH that has just proved a credential against the host
                       in its body, so that credential is what this runtime should dial. Handing it
                       `config.imap` instead would compare the just-proven host against the settings
                       file and withhold the password it was called to store. */
                    false,
                  );
                  void attached.start().catch((startErr: unknown) => {
                    log("mailbox_start_failed", { err: startErr });
                  });
                } catch (err) {
                  if (!runtimes.has(mailboxId)) runtimes.add(live);
                  log("local_mailbox_reattach_failed", {
                    err,
                    reason: "the new password is stored and this mailbox uses it from the next "
                      + "launch; until then this mailbox is not polling, and it is kept on the "
                      + "roster so that removing it still releases its claim and takes its mail",
                  });
                }
              }
              return new Response(JSON.stringify(dto), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              /* The service's own honest sentence, mapped by hand because this handler sits
                 AHEAD of the route table and therefore ahead of `withErrorEnvelope`. The
                 message is the one the door renders beside the password field, so a 4xx must
                 carry it through rather than be flattened. */
              const e = err as { code?: string; httpStatus?: number; message?: string };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              log("local_mailbox_seal_failed", { err });
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            } finally {
              /* ON EVERY EXIT — a sign-out waiting on this write is bounded by the wait, and an
                 exit that never settled would spend the whole of it and then be reported as a
                 store that could not be promised clean. */
              sealWrite.settle();
            }
          }
          if (localRemoveMatch) {
              /* Removing a mailbox on a standalone install. The shared `DELETE /mailboxes/:id` is
               * `stepUp: true`, which on this door is permanent: the launch session's stamp is
               * written once at boot, so `withStepUp` refuses from five minutes after launch (a
               * measured Remove button answering 403 for ever). `host-pair-routes.ts` names this
               * shape. What protects it instead is the per-launch bearer — minted at boot, added
               * shell-side, never reaching the window, uncomposable by a page. On `handle` ALONE
               * (structural via `desktopHostRoutes`): a phone must not remove a mailbox from a
               * computer. The SERVICE is `MailboxService.delete`, the hosted door's method. */
            const mailboxId = localRemoveMatch[1]!;
            try {
               /* ── THE PASS IN FLIGHT, WAITED OUT BEFORE ANYTHING IS WRITTEN ──────────────────
                * FIRST, ahead of the tombstone and the wipe, and that order is the fix. It used to
                * run LAST inside `detach()`: a pass parked in a server call resumed after the row
                * was tombstoned and the mail deleted, committed its messages into a mailbox that no
                * longer existed, and announced their arrival after the receipt that said it was
                * gone — mail left on the machine. Bounded by one drain interval, shared with
                * `detach()`; past that the pass's own writes are refused by `assertMailboxStillHere`.
                * The login is NOT closed here — the claim release below needs it. */
              await runtimes.get(mailboxId)?.quiesce();
              // The SHARED service, through the same `services` factory every other route on this
              // door resolves — never a second implementation of the tombstone, the credential
              // deletion or the appointment close. The context is the request's own: this install
              // serves exactly one account, and `core` is the launch session just resolved above.
              // `services` is optional on `ApiDeps` for hosts that mount a subset; THIS
              // composition always builds it (`localServices`, three lines into `depsFor`), so
              // the assertion is a statement about this door and not a hope.
              const out = await depsFor().services!.mailbox.delete(
                {
                  db, accountId: core.accountId, userId: core.userId,
                  now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
              );
               /* And the engine beside the row, which the shared service cannot reach.
                * `MailboxService.delete` knows about ROWS; not that this door holds an open IMAP
                * login, renews an organizer claim each poll and serves the mirror — all three were
                * measured still running after a removal. ORDER: quiesce (above), release, wipe,
                * then stop — the release needs the login the stop closes, the wipe needs the pass
                * already finished. `assertMailboxStillHere` refuses any commit that finishes into
                * the removed mailbox. The RELEASE is best effort and reported (`claimReleased`);
                * the WIPE is not — a removal that left the mail here is refused, because "it is
                * gone" would be a false statement about the only copy the person can see. */
               /* "If the roster holds it", not "if it is the one mailbox". This read
                * `if (mailboxId === world.mailboxId)`, the same statement while an install ran one
                * mailbox and a silent hole the moment it runs two: removing the SECOND matched
                * nothing, so its claim kept being renewed, its login stayed open and its mail stayed,
                * and re-adding the address served every message twice (the doubling `local-mirror.ts`
                * describes). The roster is the authority on what this install runs, so it is what the
                * question asks; each act uses THAT runtime's adapter, or a release would expunge from
                * the wrong mailbox. */
              const removed = runtimes.get(mailboxId);
               /* Whether the claim is actually off the mailbox, carried out to the person. `false`
                * means one thing: a release was ATTEMPTED and could not complete, so this install's
                * claim may still stand in `ohmail/_meta`. The removal happened either way, but
                * "the mailbox is gone from this computer" and "nothing of ours is left holding it
                * against your other machine" are two statements — untold, the other install refuses
                * the mailbox for the staleness window, blaming a machine that no longer exists. A
                * mailbox with NO runtime in the roster is not this state (no login to expunge over),
                * so it reads `true`. */
              let claimReleased = true;
              if (removed) {
                const released = await releaseOwnClaim(
                  removed.adapter, installId, mailboxId,
                  { current: removed.leaseNonce, pending: removed.leasePendingNonce }, log,
                  "the claim ages out of ohmail/_meta on its own; until it does, another "
                    + "install connecting this mailbox stands itself down against a claim "
                    + "nothing holds",
                );
                if (released === null) claimReleased = false;
                else if (released > 0) log("organizer_claim_released", { mailboxId, claims: released });
                /* ── A WIPE THAT DID NOT WIPE FAILS THE REMOVAL, AND THE RUNTIME STAYS ──────
                 * This used to be caught and logged: the person was told the mailbox was gone
                 * while its mail was still on this disk, and the log's own remedy — remove it
                 * again — could not run, because the removal had already dropped the runtime the
                 * wipe needs. Thrown instead, so `detach()` and the roster delete below are never
                 * reached and a second press comes back through this same wipe. The row is a
                 * tombstone by now and `MailboxService.delete` is idempotent over one
                 * (`ownedRowOn` reads by id, not by status), so the retry is the ordinary press. */
                try {
                  await wipeLocalMirror(db, { accountId: core.accountId, mailboxId });
                } catch (err) {
                  log("local_mirror_wipe_failed", {
                    err,
                    reason: "this install still holds the removed mailbox's mail, so the removal "
                      + "is refused rather than reported done; the mailbox keeps its runtime and "
                      + "its place on this install's roster, and removing it again runs this wipe",
                  });
                  throw Object.assign(
                    new Error("this mailbox's mail could not be cleared from this computer"),
                    { code: "local_mirror_not_cleared", httpStatus: 503 },
                  );
                }
                /* THE TIMER AND THE LOGIN — release, wipe, then stop, and the order is the whole
                   implementation: the release needs the login the stop closes, and the wipe needs
                   the poll not to be mid-cycle writing rows back in. This is one of the two paths
                   that still mean "stop syncing entirely" for a mailbox; a reader keeps its timer
                   because it still HAS a mailbox, and this one does not.

                   The STORE is untouched. `detach` closes what this mailbox holds and nothing
                   else, because the other mailboxes are still serving out of the same database —
                   which is exactly what the install's own `stop()` may not assume any more. */
                await removed.detach();
                runtimes.delete(mailboxId);
              }
              /* THE LINE SAYS WHICH OF THE TWO THINGS HAPPENED, because it used to say the one
                 that is not always true. "its organizer claim is released" was written flat, and
                 a release that could not look had just logged the opposite three lines above —
                 so the record of a removal asserted, in its own words, something the code beside
                 it had already reported failing. A log that contradicts itself in one request is
                 worse than a quiet one: it is the sentence an operator reaches for first. */
              log("local_mailbox_removed", {
                verdict: "removed",
                reason: claimReleased
                  ? "a person removed this mailbox from this machine; its credentials are "
                    + "deleted, its pending appointments are closed, its organizer claim is "
                    + "released, this install's copy of its mail is deleted and nothing was "
                    + "deleted from the mail server"
                  : "a person removed this mailbox from this machine; its credentials are "
                    + "deleted, its pending appointments are closed, this install's copy of its "
                    + "mail is deleted and nothing was deleted from the mail server — but its "
                    + "organizer claim could not be taken out of ohmail/_meta, so the claim "
                    + "stands until it goes stale and another install connecting this mailbox "
                    + "waits that long before it may organize it",
              });
              /* `claimReleased` ON THE WIRE, because the shell is the only thing that can say it
                 to the person and it had no way to know. The removal is a 200 either way — that
                 is the promise this door makes and the reason the three acts above are best
                 effort — so the outcome cannot be carried by the status code. */
              return new Response(JSON.stringify({
                seq: out.seq === null ? null : String(out.seq),
                claimReleased,
              }), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              /* THE HOLD COMES OFF FIRST. This route puts the mailbox on hold before it asks the
                 service to remove it, so a refusal here would otherwise leave a mailbox the person
                 still has with no poll timer and a stopped runtime, reporting itself reachable.
                 `unquiesce` takes back only a hold this request placed. */
              runtimes.get(mailboxId)?.unquiesce();
              // The service's own honest sentence, mapped by hand because this handler sits
              // AHEAD of the route table and therefore ahead of `withErrorEnvelope`.
              const e = err as { code?: string; httpStatus?: number; message?: string };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              log("local_mailbox_remove_failed", { err });
              return new Response(
                JSON.stringify({
                  error: { code: e.code ?? "internal", message: status === 500 ? "internal error" : (e.message ?? "") },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (req.method === "DELETE") {
              /* Signing out forgets EVERY mailbox's password, not the first one's. This route is
               * the shell signing out of the local door, whose contract is that the credential is
               * the only thing on this machine a sign-out asks to be gone. Forgetting one would
               * leave the others' sealed passwords on the disk — worse, the seed accessor falls back
               * to the oldest live runtime when the configured address matches no row, so it could
               * delete a DIFFERENT mailbox's credential and report success. So every runtime forgets
               * its own; it answers true if ANY password was there, and a failure on one is not
               * swallowed — a half-happened sign-out must not report success. */
            /**
             * THE FENCE, BEFORE ANY STORE IS TOUCHED. Bumping first is what makes a writer that
             * starts from here on refuse; waiting is what makes the ones already out settle — and
             * discard what they wrote — before the read-backs below run, so the ordinary case
             * leaves nothing at all. `runtimes.all()` is read AFTER the wait for the same reason:
             * a mailbox the add route was in the middle of creating is on it by then.
             */
            /* WHAT THIS INSTALL HELD WHEN THE PRESS ARRIVED. `cleared` used to be read off the
               forgets alone, which the fence makes wrong: a write it overtakes discards its own
               row first, so every runtime then finds nothing and a real sign-out reported having
               removed nothing. The question the field answers is about the moment of the press. */
            const held = await db.select({ mailboxId: mailboxCredentials.mailboxId })
              .from(mailboxCredentials).limit(1);
            /* THE FENCE GOES UP ON THE CALL, not on the await: `signOut` bumps the epoch before
               it yields, so every write that begins from here on reads the new one. The receipt
               is written between the two because the count it names is the set being waited for,
               and after the await that set is by definition the ones that did NOT settle. */
            const fencing = fence.signOut(SIGN_OUT_FENCE_WAIT_MS);
            log("stored_login_fence_raised", {
              route: localActionRoute,
              count: fence.outstanding(),
              reason: "signing out: no password can be stored on this install from this moment, "
                + "and the passwords already being stored are waited for before the stores are "
                + "discarded",
            });
            const fenced = await fencing;
            const forgotten = await Promise.all(runtimes.all().map((r) => r.forgetStoredLogin()));
            const cleared = held.length > 0 || forgotten.some(Boolean);
            if (fenced.unsettled > 0) {
              /* SAID, NOT SWALLOWED. Every store here was discarded, but a credential write that
                 was still out when the wait ran out can still commit, and this door cannot
                 promise what it has not seen settle. A non-2xx is what the shell already treats
                 as "you have NOT been signed out" on the local door, which is the true sentence:
                 pressing it again a moment later finds the writer settled and succeeds. */
              log("local_action_refused", {
                method: req.method,
                route: localActionRoute,
                status: 503,
                reason: "a password was being stored while this install signed out and had not "
                  + "finished; every stored password was removed, and this answers a refusal "
                  + "rather than promise a store it could not watch settle",
              });
              return new Response(
                JSON.stringify({
                  error: {
                    code: "stored_login_not_fenced",
                    message: "a password was still being saved when you signed out, so this "
                      + "install cannot promise it is gone. Try signing out again.",
                  },
                }),
                { status: 503, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(JSON.stringify({ cleared }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          // "Organize from this machine", the route. The ceremony is `requestOrganizerTakeover`'s,
          // not re-implemented here — transport and outcome. It RECORDS a request; it does not
          // seize: the mailbox is still the authority (the next launch reads the lease first), so
          // this can be a button at all — it cannot produce two organizers, only a request to
          // become one. It leaves the row STOOD DOWN and writes only the stamp: marking the mailbox
          // `connected` would advertise one nothing is organizing, and `ScheduleService`/
          // `SendService` refuse only on `status = 'disabled'`, so they would accept sends for it.
          // Since Mail 0083 the stamp is spent on the next TICK, not the next launch: a demoted
          // install is a READER that keeps its login and poll timer, so the gate re-runs, reads the
          // stamp and promotes with no relaunch. The row must not claim organizing before the lease agrees.
          let body: { mailboxId?: unknown } = {};
          try {
            body = (await req.json()) as { mailboxId?: unknown };
          } catch {
            /* an absent or unparseable body is a missing mailboxId, answered below */
          }
          const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId.trim() : "";
          if (!mailboxId) {
            /* THE SECOND SILENT REFUSAL, and the one the takeover cell needed: a press that
               arrives without a mailbox is answered 400 and, before this line, recorded
               nowhere — which is indistinguishable in the log from a press that never arrived. */
            log("local_action_refused", {
              method: req.method,
              route: localActionRoute,
              status: 400,
              reason: "the request named no mailbox, so no takeover was recorded",
            });
            return new Response(
              JSON.stringify({ error: { code: "invalid_request", message: "mailboxId is required" } }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          /* `"takeover"`, as the route's name says: this is the desktop's "take this mailbox back"
             button, the one verb the phone's door refuses to forward at all. */
          const result = await requestOrganizerTakeover(db, {
            mailboxId, now: now(), intent: "takeover",
          });
          log("organizer_takeover_authorized", {
            // `verdict` and not `outcome`: `ALLOWED_FIELDS` carries the former, and a field the
            // census drops is an instrumented line that says nothing in production.
            verdict: result.outcome,
            disabledReason: result.previousReason,
            reason: "a person asked for this machine to organize this mailbox; the lease is " +
              "still the authority and is read on the next launch",
          });
          return new Response(
            JSON.stringify({ outcome: result.outcome, previousReason: result.previousReason }),
            {
              // 200 for every outcome, including the three that write nothing: they are ANSWERS
              // about the row, not refusals of the request, and the pane says a different
              // sentence for each. A 409 here would make "this machine already organizes that
              // mailbox" look like a failure to the person who pressed a button because they
              // thought it did not.
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        const answered = await app.handle(req, depsFor());
        noteDoorWrite(req, answered);
        return answered;
      },
      // The desktop-host door, present IFF armed — see {@link Sidecar.handleHost}. Spread so a
      // disarmed sidecar genuinely lacks the member rather than carrying one that refuses.
      //
      // ── ONE DOOR, TWO HALVES, AND THE API'S PRECEDENCE IS STRUCTURAL ────────────────────
      // The decision is `matchRoute` over the SAME table the app routes with, so it cannot
      // drift from the app's own routing: a path any route matches — including a matched path
      // with the wrong method, whose 405 is the app's to answer — goes to the API, and only a
      // path the table has never heard of reaches the static handler. A file can therefore
      // never shadow a JSON route, and the index fallback can never swallow a redeem.
      ...(hostApp
        ? {
            handleHost: async (req: Request): Promise<Response> => {
              const match = matchRoute(desktopHostRoutes, req.method, new URL(req.url).pathname);
              if (match.matched || match.methodNotAllowed) return hostApp.handle(req, depsForHost());
              return hostStatic!.serve(req, new URL(req.url));
            },
            // The LAN door, present IFF the operator also chose an interface: the SAME table and
            // the SAME per-request deps as the Tailscale door — one composition, two sockets —
            // and the API-only static half in place of the packaged client. Which handler a
            // socket was given decides, structurally; no header is consulted.
            ...(lan.address !== null
              ? {
                  handleLan: async (req: Request): Promise<Response> => {
                    const match = matchRoute(desktopHostRoutes, req.method, new URL(req.url).pathname);
                    if (match.matched || match.methodNotAllowed) {
                      const answered = await hostApp.handle(req, depsForHost());
                      noteDoorWrite(req, answered);
                      return answered;
                    }
                    return serveLanFallback(req);
                  },
                }
              : {}),
          }
        : {}),
      hostState: hostConfig.state,
      lanState: lan,
      lanIdentity,
      /**
       * Drain every mailbox and answer the TOTAL number of cycles — summed, because the one
       * consumer is "did anything happen" (a per-mailbox answer is `syncMailbox`). The drains run
       * CONCURRENTLY: each mailbox has its own serial queue so its cycles never overlap, but across
       * mailboxes they may, and the store is built for it (the window is served during a drain and
       * PGlite runs each transaction through its own mutex). In series a slow mailbox would hold up
       * every other's mail. `allSettled`, so one mailbox that throws — an expired password, a
       * server gone away — cannot stop the others; the throw is already logged where it happened.
       */
      async syncUntilQuiet(maxCycles = 100) {
        const runs = await Promise.allSettled(runtimes.all().map((r) => r.syncUntilQuiet(maxCycles)));
        return runs.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
      },
      /**
       * Drain ONE mailbox.
       *
       * TWO ABSENCES, AND THEY ARE NOT THE SAME ANSWER. `?? 0` collapsed them: a row that is GONE
       * (removed between a caller reading the list and asking — a race, not a fault) and a row
       * that is HERE and deliberately not run reported the same "nothing happened", so the second
       * was a success with no work in it. The row decides which one this is.
       */
      async syncMailbox(mailboxId: string, maxCycles = 100) {
        const rt = runtimes.get(mailboxId);
        if (rt !== undefined) return rt.syncUntilQuiet(maxCycles);
        const [row] = await db.select({ id: mailboxes.id }).from(mailboxes)
          .where(and(eq(mailboxes.accountId, world.accountId), eq(mailboxes.id, mailboxId)))
          .limit(1);
        // GONE: the honest 0 this method has always answered, and the race it was written for.
        if (row === undefined) return 0;
        // HERE AND NOT RUN. Named, because a caller that gets 0 cannot tell it from a settled
        // mailbox — and the pane's own door (`withForcedRedial`) refuses the same state.
        throw new Error(`this install is not running mailbox ${mailboxId}`);
      },
      /**
       * Every mailbox's organizer state, keyed by row id — the pane renders one line per entry.
       * A snapshot taken per call, never a live map: the caller is a request handler and the
       * gate writes these fields from a poll.
       */
      organizerStates() {
        return Object.fromEntries(runtimes.all().map((r) => [r.mailboxId, r.organizer]));
      },
      connectionStates() {
        return Object.fromEntries(runtimes.all().map((r) => [r.mailboxId, r.connection]));
      },
      /**
       * The SEED's answer, unchanged for every existing caller. See `LocalRoster.seed`: the row
       * matching the configured address, else the oldest live one. An install with no mailboxes
       * at all reports itself as not organizing, which is true and is what the door chooser
       * renders.
       */
      organizerState: () => seedRuntime()?.organizer
        ?? { organizing: false, reason: null, heldBy: null, unreadableSince: null,
          releaseRequestedAt: null, claimed: false },
      /* Every mailbox, not the seed alone: a wake is an install-wide event and an install with
         four mailboxes has four dead sockets. Settled rather than raced — `allSettled` so one
         refusal cannot cut the others short, and the results are dropped because each dial path
         logs its own failure and a caller has nothing to do with them. */
      wake: async (): Promise<void> => {
        await Promise.allSettled(runtimes.all().map((rt) => rt.redial()));
      },
      /* SETTLED AND REPORTED, which is where this differs from `wake`. A wake's results are
         dropped because each dial logs its own failure and a caller has nothing to do with them;
         a hand-back's outcome decides what the app may SAY, so a rejection becomes this
         mailbox's `null` — "could not look" — rather than a missing entry. */
      handBack: async () => {
        const runs = runtimes.all();
        const settled = await Promise.allSettled(runs.map((rt) => rt.handBack()));
        return settled.map((r, i) => ({
          mailboxId: runs[i]!.mailboxId,
          released: r.status === "fulfilled" ? r.value : null,
        }));
      },
      /**
       * EVERY MAILBOX IS TRIED, AND EVERY REFUSAL IS CARRIED OUT — where this differs from `wake`.
       *
       * The results were dropped on `wake`'s reasoning, which is false here: a resume can fail
       * AFTER it claimed the mailbox, and the state it left said organizing. The catch beside the
       * one caller that has one could not fire — measured as zero lines on the arm that reproduces
       * it. So refusals are collected, since one mailbox's failure must not stop the others
       * starting, and then thrown for the caller to render.
       */
      resume: async (): Promise<void> => {
        const runs = runtimes.all();
        const settled = await Promise.allSettled(runs.map((rt) => rt.resume()));
        const refused = settled.flatMap((r, i) => (r.status === "rejected"
          ? [{ mailboxId: runs[i]!.mailboxId, reason: r.reason as unknown }]
          : []));
        if (refused.length === 0) return;
        /* THE FIRST REFUSAL IS THE ONE THROWN, and the rest ride on it: a caller renders one
           sentence, and an aggregate of one is a worse sentence than the failure itself. The others
           are named on the error so a diagnosis is not one mailbox wide. */
        const first = refused[0]!;
        const err = first.reason instanceof Error
          ? first.reason
          : new Error(String(first.reason));
        (err as Error & { resumeRefused?: readonly string[] }).resumeRefused =
          refused.map((r) => r.mailboxId);
        throw err;
      },
      /* ONE MAILBOX, NAMED. A mailbox this install does not run answers `unreadable` rather than
         throwing: the caller is a door with a press in its hand, and an id it does not recognise
         is exactly the state in which it must not say "nothing holds this". */
      peekOrganizer: async (mailboxId: string): Promise<LeasePeekAnswer> => {
        const rt = runtimes.all().find((r) => r.mailboxId === mailboxId);
        if (rt === undefined) return { answer: "unreadable", op: "no_lease_peek_io", cause: undefined };
        return rt.peekOrganizer();
      },
      credentialState: async () => (await seedRuntime()?.credentialState()) ?? "absent",
      forgetStoredLogin: async () => (await seedRuntime()?.forgetStoredLogin()) ?? false,
      /**
       * START EVERY MAILBOX. Concurrent for `syncUntilQuiet`'s reason, and `allSettled` for it
       * too — with one difference that is the whole of why this is not a bare `Promise.all`:
       * `main.ts` answers a rejected `start()` by logging and going on to serve the mirror, so a
       * throw here is not fatal to the process. What it must not do is take the OTHER mailboxes
       * down with it. Each runtime's own `start` already closes its login on the way out.
       */
      async start(): Promise<LaunchReport> {
        /* CAPTURED BEFORE the launches, so the index of a settled result names the mailbox it
           belongs to. Reading `runtimes.all()` again afterwards would be a different list — a
           mailbox can be detached while its own launch is in flight. */
        const all = runtimes.all();
        const runs = await Promise.allSettled(all.map((r) => r.start()));
        const failures: { mailboxId: string; err: unknown }[] = [];
        runs.forEach((r, i) => {
          if (r.status !== "rejected") return;
          log("mailbox_start_failed", { err: r.reason });
          failures.push({ mailboxId: all[i]?.mailboxId ?? "", err: r.reason });
        });
        return { failures };
      },
      async stop() {
        // The INSTALL is going down, which is what the account-scoped passes yield on. Each
        // mailbox's own timer, in-flight cycle and login go with its runtime; the STORE is the
        // install's and is closed once, here, after every mailbox has let go of it.
        stopping = true;
        // FIRST, and it is the only ordering that is correct: the readings are about a running
        // engine, and one taken between the last detach and the store close would describe a
        // process mid-teardown as though it were serving.
        stopVitals();
        /* AND THE CLAIM GOES BACK WITH EACH MAILBOX, inside `detach()` — see the block there.
           NOT a `handBack()` pass in front of this one: that queues BEHIND an in-flight cycle, so
           a gate parked in the lease read would run its whole drain before anything told it to
           stop. `detach()` sets `stopped` first and releases after the queue has settled, which is
           the only ordering where both are true. */
        await Promise.allSettled(runtimes.all().map((r) => r.detach()));
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
