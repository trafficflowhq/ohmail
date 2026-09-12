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
  // Mail 0083 — the role vocabulary and the machine-name bound. One spelling for the sidecar's
  // gate, the worker's gate and the eleven service write doors; see `db/src/organizer-role.ts`.
  organizerDisplayName, isOrganizerRole, capabilitiesColumn,
  // The entitlements composition this host declares. From the MAIL barrel — the port is pure
  // types and one literal, and the halves that answer it stay on `@trafficflow/db/cloud`.
  UNMETERED, UNMETERED_ACCESS,
  type MailboxDisabledReason, type OrganizerRole, type Tx,
} from "@trafficflow/db";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService,
  kbService, runAwayResponderPass, runScheduledSendPass, runSendReconcilePass,
  scheduleService, tagsService,
  makeApprovalService, makeAuthConfig, makeMailboxService, makePrivacyService,
  makeScreenerService, makeUnsubscribeService, messageService, nodeHostResolver,
  nodeOneClickPost, notifyRulesService, resolveSession,
  rulesService, searchService, sendService, snippetsService, syncService, threadService,
  triageService, workflowsService, ServiceError, type UnsubscribeService,
  type AuthConfig, type HostResolver, type MailboxAllowancePolicy, type OneClickPost,
  type PushService, type RemoteFetch,
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
// install model has to apply the identical rule and `apps/desktop` declares no `@trafficflow/*`
// dependency — see the header of `credential-host.ts` for why one definition rather than two.
import { credentialIsForeign, credentialIsForeignSmtp, sealedHost, sealedSmtpHost } from "./credential-host.js";
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
import { runSyncCycle, type SyncDeps } from "@trafficflow/worker/sync";
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
  DEFAULT_STALE_AFTER_MS, type OrganizerWriteAuthority,
} from "@trafficflow/worker/lease";
// The APPEND-LESS read, straight from core: an install that has not been asked to organize must
// still be able to say who does, and `runLeaseGate` cannot answer that question without taking
// the mailbox (its empty-folder arm claims). One method, no way to write. See
// `notePeekedHolder`.
import {
  readLeasePeek, deriveRequestKey, type LeasePeekIo, type OrganizerKind,
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
import { openLocalDb, type LocalDb, type LocalDbOpenPhase, type OpenLocalDb } from "./db.js";

/**
 * The shape {@link SidecarConfig.store} supplies — `openLocalDb`'s own signature, named so a
 * caller can be typed against it without importing the desktop's implementation.
 */
export type OpenLocalDbFn = (
  dataDir: string,
  opts: { log?: Diagnostic; onPhase?: (phase: LocalDbOpenPhase) => void },
) => Promise<OpenLocalDb>;
import {
  endLegacyOrganizerPauses, ensureLocalWorld, loadLocalRoster, loadUnattachedLocalRoster,
  mintLaunchSession,
  type LocalRosterRow, type LocalWorld,
} from "./identity.js";
// ONE RUNTIME PER MAILBOX, held in a map. The record, the map and the seed decision live in
// `roster.ts`; what stays here is the assembly that fills one in and the routes that add and
// remove them. See that file's header for what is per mailbox and what is per install.
import {
  LocalRoster,
  type CredentialState, type LocalMailboxRuntime, type MailboxConnectionState,
  type OrganizerState,
} from "./roster.js";
// Removing a mailbox takes this install's copy of its mail with it. See `local-mirror.ts` for why
// this is the sidecar's job and not `MailboxService.delete`'s.
import { mirroredMessageCount, wipeLocalMirror } from "./local-mirror.js";
import { stampSynced } from "./sync-stamp.js";
import { createFirstSyncReporter } from "./first-sync.js";
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
export type { CredentialState, MailboxConnectionState, OrganizerState } from "./roster.js";

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
  onPhase?: (phase: BootPhase) => void;
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
   * Forget the stored mailbox password; answers whether there was one to forget. This is what
   * makes signing out of the local door mean something: the shell can delete its own
   * configuration and stop this process, but the sealed credential lives inside the mirror's
   * database — and the mirror is frozen on a door switch rather than deleted, because the mail
   * is on the user's own server and re-pulling it is expensive and pointless. So the one thing
   * that has to go is removed here, leaving everything else where it is. It does not disconnect:
   * tearing down the live socket mid-request is the shell's job; the next launch has no password
   * and serves the mirror — the documented no-password state.
   */
  forgetStoredLogin(): Promise<boolean>;
  /** Stop polling, let the in-flight cycle finish, close IMAP, close and unlock the database. */
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
 * The image proxy's egress, refused. The spy-pixel blocker exists so remote content is fetched
 * only when the user asks. On Cloud the fetch goes out from our server; on desktop it would go
 * out from the user's own machine, where every socket this process opens is meant to sit behind
 * an allow-list — their IMAP/SMTP server, their own AI endpoint, nothing else — so a message can
 * never make the machine it is read on talk to a host of the sender's choosing. That allow-list
 * is not built yet, so the honest default is refusal: a blocked pixel is the product working, an
 * un-allow-listed request is not.
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
   * THE NONCE OF THE CLAIM THIS INSTALL HOLDS. A release is addressed by (install, nonce), so a
   * restored image of this machine does not lose its own claim to a sibling's stop. `null` is
   * refused inside rather than widened to the id — the request stands and the claim is released
   * by lapse.
   */
  nonce: string | null,
  log: Diagnostic,
  reason: string,
  /** The configured window the stale term is measured against — one clock on every tier. */
  staleAfterMs?: number,
): Promise<number | null> {
  try {
    return await releaseMailboxClaim(adapter, installId, mailboxId, nonce,
      ...(staleAfterMs !== undefined ? [{ staleAfterMs }] : []));
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
    privacy: makePrivacyService({ remote: REFUSING_REMOTE_FETCH, resolver: REFUSING_RESOLVER }),
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
 * The dial context for a connection nobody keeps — a probe and a send. Both open a login, do one
 * thing and close it inside the call that made them: no poll timer, no runtime to mark, so "the
 * connection died between calls" describes nothing — either the call is in flight and the
 * failure comes back as a throw, or the connection is closed and its death is what we asked for.
 * A named constant rather than an inline `() => {}` at each site, because the empty body is a
 * claim — "there is nothing to heal here" — stated once with the reason attached.
 */
const ONE_SHOT_DIAL: AdapterDialContext = { onConnectionError: () => { /* see above */ } };

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
 * ══ HOW LONG THIS COMPOSITION WAITS BEFORE IT CALLS A CONNECTION DEAD, AND HOW IT RE-DIALS ══
 *
 * The four numbers above were measured for a desktop that runs for days, where a dead socket is
 * rare and a login the provider counts is the expensive mistake. A phone organizes the mailbox
 * only while ohmail is open — a session of minutes — and loses its route for seconds at a time,
 * so the same numbers read as a broken app: measured on a phone, 2 min 27 s of failing cycles
 * with ONE `mailbox_reconnect_failed` in them, which is exactly what 8 cycles at a 15 s poll and
 * a ladder starting at 15 s produce.
 *
 * So the bounds become a PROFILE, selected by what this install already claims as
 * ({@link OrganizerKind}). No new flag: the discriminator exists, it is written into the claim,
 * and `composition-passes.ts` is the prior art for an exhaustive record over it — a fourth kind
 * cannot reach the claim without an answer here.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref?.();
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
     * `resolver` — the REAL `node:dns`, not `REFUSING_RESOLVER`: the SSRF gate protects the user's own home network
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
        authConfig, keyProvider, world.accountId, openLocalSend, unsubscribe, organizerKind, ai,
      ),
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
          hostAuthConfig, keyProvider, world.accountId, openLocalSend, unsubscribe, organizerKind,
          ai,
        ),
        sendSurfaceMaxTotalBytes: HOST_SEND_MAX_TOTAL_BYTES,
      },
      hello: {
        flavor: "desktop-host",
        // No setup ceremony exists on this door: the world was created at first boot, and a
        // device becomes a session through the pairing redeem, never through a setup page.
        needsSetup: false,
        auth: { password: false, totp: false, webauthn: false, publicSignup: false },
        features: { sse: false, staging: false, ai: ai.drafter() !== undefined, pairing: true },
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
         * What this does NOT fence: `FOR UPDATE` serializes a competing credential write, not its committing
         * immediately after — a `PATCH` waiting on the row re-inserts the sealed password after the 200. Closing that
         * needs a durable signed-out stamp every writer refuses on (`services/src/erasure-fence.ts` is the pattern) —
         * a shared-service change, ledgered rather than half-done here.
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
      if (durableKey && envPass && !(await storedLogin())) {
        const sealed = await keyProvider.encrypt(envPass);
        await db.insert(mailboxCredentials).values({
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
        log("stored_login_sealed", {
          mailboxId: mb.id,
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
      const requestKey = deriveRequestKey({ auth: imapConfig.auth, address: mb.address });

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
       * WHICH OBSERVATION MARKED IT DEAD. Two producers, and they are worth telling apart in a
       * log because only one of them is fast: the adapter's own `close`/`error` event (seconds),
       * and the duration bound over failing cycles (the arm that works for a connection whose
       * death produced no event at all).
       */
      let connectionDeadBy: "event" | "bound" | "heartbeat" | null = null;
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
       * WALL-CLOCK INSTANT BEFORE WHICH A PRESS IS NOT HONOURED — a floor under the one path
       * that is allowed to skip the ladder.
       *
       * A forced dial skips {@link redialNotBefore}, and a dial that fails FAST settles in well
       * under a second. So without this a second press — a remounted pane, a second window, a
       * person pressing twice — skipped the wait again, and repeated presses dialled once per
       * press: the 15-second-to-5-minute ladder defeated by a control anybody can hold down,
       * against a server that has already refused to answer.
       *
       * A press is worth ONE attempt per base step. After a forced dial FAILS this is set to
       * `now + reconnect.ladderMs[0]` and `force` is refused until it passes; the press still
       * answers 202, and the row still says what it said. A forced dial that SUCCEEDS clears it,
       * because the thing it was rationing is over.
       *
       * SEPARATE FROM `redialNotBefore`, deliberately. That one is the automatic ladder and
       * widens to five minutes; this is a fixed floor under the manual path. Folding them
       * together would either give a press the five-minute wait back (the defect this lane
       * closed) or let a press reset the automatic ladder (the one it refused to do).
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
      const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
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
          unreadableSince: null, releaseRequestedAt: null }
        /* THE STOP IS NOT KNOWN AT ATTACH — it is the ROW's, and the first pass's own read is what
           puts it here. `null` is "nothing has said", which is what an unasked question answers. */
        : { organizing: true, reason: null, heldBy: null, unreadableSince: null,
          releaseRequestedAt: null };
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
      const notePeekedHolder = async (reason: MailboxDisabledReason | null): Promise<void> => {
        const peekIo = (adapter as Partial<{ leasePeekIo(): LeasePeekIo }>).leasePeekIo;
        if (typeof peekIo !== "function") return;
        try {
          const seen = await readLeasePeek({
            io: peekIo.call(adapter),
            now: now(),
            ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          });
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
            releaseRequestedAt: organizer.releaseRequestedAt };
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
           * healthy-state shape surviving at poll time, where a mailbox spends its life. Kept
           * from the FIRST failure, as at startup, so the surface can say how long; the success
           * path sets it back to `null`. */
          organizer = {
            ...organizer,
            unreadableSince: organizer.unreadableSince ?? new Date().toISOString(),
          };
          log("organizer_peek_failed", {
            err,
            reason: "this install reads this mailbox and could not see who organizes it; the row "
              + "keeps its previous answer, the pane says the lease is unreadable, and the next "
              + "pass looks again",
          });
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

        /* ── THE STOP STANDING ON THE ROW, PROJECTED ONCE FOR EVERY LITERAL BELOW ─────────────
         *
         * `organizing` answers what THIS PASS may arrange, and a pass honouring a release arranges
         * nothing whether or not the claim actually left `ohmail/_meta`. So the phone's adapter
         * read `organizing: false` as "the mailbox was let go" and reported a refused stop as a
         * success: the notification and the background work came down over an install whose claim
         * still stood. The two questions need two fields, and this is the second one — the row's
         * own `release_requested_at`, which the read above already has.
         *
         * DERIVED IN ONE PLACE and spent below, where the compare-and-set records the release —
         * the same moment the row's own column is cleared. A pass that could NOT read the row
         * never reaches a literal that writes this: the `!rowRead` arm returns by spreading the
         * previous answer, which is what carries a standing stop through a pass that learned
         * nothing. A carry term here would be a second mechanism over that one. */
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
            adapter, installId, mb.id, leaseNonce, log,
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
            /* The pipeline is told, or a reader's gate gets an organizer's cycle. `drain`
               spreads `role: organizer.organizing ? "organizer" : "reader"` and gates
               `armHoldFromFolder` and `sendScheduled` on the same field. `reason` is NULL:
               nobody else holds this mailbox, and naming a holder would put "another install
               has claimed this mailbox" in front of somebody whose own release has not
               finished. `unreadableSince` is CARRIED, not cleared — this pass did not read the
               lease, so it learned nothing that could clear a standing mark; and not set
               either — "the server would not enumerate our records" is not "we cannot see who
               organizes this mailbox". */
            organizer = {
              organizing: false, reason: null, heldBy: null,
              unreadableSince: organizer.unreadableSince,
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
          organizer = { ...organizer, organizing: false };
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
            releaseRequestedAt: releaseStamp };
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
        /* Captured once so the renewal memory records the SAME instant the gate writes into the
           claim's heartbeat — the lapse bound below compares against what a reader of the folder
           can actually see, not against a second clock reading taken after the round trip. */
        const gateAskedAt = now();
        const leaseArgs = {
          adapter,
          mailboxId: mb.id,
          self: { installId, kind: organizerKind, displayName: machineName, lastNonce: leaseNonce },
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
          takeover: takeoverAuthorized && observedTakeoverAt !== null
            ? { authorizedAt: observedTakeoverAt }
            : null,
          ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          log,
        };
        const outcome = await readMailboxLease({ ...leaseArgs, now: gateAskedAt });
        if (outcome.organize) {
          leaseNonce = outcome.nonce;
          // THE READ ABOVE IS THE PERMIT'S FIRST LOOK, adopted rather than repeated: the gate
          // renews this install's claim, so a second run here is the same-millisecond
          // self-stand-down `MIN_PERMIT_TTL_MS` refuses.
          // No TTL knob: one value for the fleet (`DEFAULT_PERMIT_TTL_MS`). A configurable window
          // beside a fixed believability cutoff is silently the smaller of the two.
          leasePermit = await acquireLeasePermit({ ...leaseArgs, adopt: { outcome, at: gateAskedAt }, now });
          // The gate renewed this install's claim with `gateAskedAt` as its heartbeat — the fact
          // the release's lapse bound reads. See `lastLeaseRenewalAt`.
          lastLeaseRenewalAt = gateAskedAt;
          // Reading the lease is what proves it: a resolved gate clears the unreadable mark.
          organizer = { organizing: true, reason: null, heldBy: null, unreadableSince: null,
            releaseRequestedAt: releaseStamp };
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
                  releaseRequestedAt: releaseStamp };
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
              organizedByKind: (outcome.by?.kind ?? outcome.reason.split(":")[1] ?? "unknown"),
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
         * literally (`if (organizer.organizing) await sendScheduled(...)`) to prove the pass stays
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
            /* ── THIS MAILBOX'S APPOINTMENTS, AND NO OTHER MAILBOX'S ──────────────────────
             *
             * The pass scans the whole store, which was the same thing as "this mailbox" while
             * an install held one. It is not any more, and the difference is not a tidiness
             * question: this call is reached only when THIS mailbox organizes, and without the
             * narrowing an organizing mailbox would claim and SEND an appointment belonging to a
             * mailbox this install merely READS — mail leaving from an install the real organizer
             * knows nothing about, at a time nobody re-chose.
             *
             * The gate above is per runtime, so each organizing mailbox keeps exactly its own
             * appointments, and a reader's are left standing for whoever does organize it. */
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
       * @param gen  the connection generation the caller gated under, and @param conn the adapter
       *   instance it belongs to. Threaded in rather than read from the closure because this pass
       *   OUTLIVES a cycle: it is the caller's identity that decides whether a delivery is still
       *   this install's to make, and the closure's binding is exactly the thing that moves.
       */
      const answerAway = async (gen: number, conn: MailboxAdapter): Promise<void> => {
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
            cancelled: () => stopped || gen !== generation || conn !== adapter,
            openSendAdapter: openLocalSend,
            mailboxIds: [mb.id],
            now,
          });
          if (r.examined > 0) {
            log("away_responder_pass", {
              accounts: r.accounts, examined: r.examined, sent: r.sent,
              unverified: r.unverified, throttled: r.throttled, suppressed: r.suppressed,
              deferredAccounts: r.deferredAccounts, deferredCandidates: r.deferredCandidates,
              capped: r.capped,
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
       * SETTLE A SEND THIS INSTALL STARTED AND NEVER FINISHED.
       *
       * The same ONE implementation the hosted API host and the self-host clock run. On those two
       * a stranded `pending` reservation is drained by a cron and a timer; on THIS door there was
       * nothing at all — the pass shipped with its route and its tick and no standalone hook, so a
       * send interrupted by a quit or a crash stayed `pending` for ever and its draft went on
       * saying "Sending…" with no process anywhere that would ever look at it again.
       *
       * It could not simply be added, either, which is worth recording because it is the second
       * time this exact shape has cost a door a feature: `runSendReconcilePass` was exported from
       * `@trafficflow/services` only, and this file imports the MAIL entry point, so the hook
       * would not have compiled. A pass is only as reachable as the entry point its host actually
       * imports, and a barrel omission fails SILENTLY — no error, no red test, just a door quietly
       * doing less than the others. The mail-barrel export lands with this hook.
       *
       * ── AND IT IS DELIBERATELY *NOT* GATED ON ORGANIZING ────────────────────────────────────
       *
       * It sits between two hooks that ARE gated, so the difference has to be stated here or it
       * reads as an oversight and gets "fixed". The two above SEND: an appointment and an away
       * reply are mail leaving this mailbox, and a reader must not do that on behalf of an
       * organizer it cannot see. This one RESOLVES — the subject is THIS INSTALL'S OWN
       * reservation, written by a send this very process started, and the work is a READ (a Sent
       * folder probe, or a single indexed lookup in this account's own mirror) plus a
       * compare-and-swap on a row nobody else owns.
       *
       * Gating it would strand exactly the person it exists for: somebody whose install was
       * demoted to reader between pressing send and the process dying would keep a draft that says
       * "Sending…" for ever, because the organizer's install has no reservation of theirs to find.
       * `send-reconcile-drain.test.ts` holds that as a case rather than as a sentence.
       *
       * No account filter is passed, and none is available on the pass's own options: it scans the
       * store, exactly as the scheduled sender does. That is the right shape on this door for a
       * reason the hosted host does not have — a standalone store holds ONE account, so store-wide
       * IS this install's own reservations.
       *
       * The adapter it is handed cannot send: the pass wraps whatever factory it gets so that
       * `send` throws. That is a structural proof rather than a promise made here — this hook could
       * not deliver a second copy of an already-sent message even if its logic were wrong.
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
       * by a READER as well as by an organizer; `organizer.organizing` is what separates them, both
       * for the passes below and for the `role` every cycle runs under.
       */
      /**
       * @param gen  the connection generation the caller read the organizer lease under. Every
       *   step below that WRITES to the mailbox re-checks it, and the drain abandons itself with
       *   {@link ConnectionReplacedError} rather than continuing over a connection it never gated.
       * @param conn the adapter instance that generation belongs to. Passed as a VALUE and spread
       *   over `syncDeps` for each cycle, so that even inside one cycle a re-dial cannot move the
       *   mail: the pipeline writes to the connection whose lease this pass read, or it fails.
       */
      const drain = async (maxCycles: number, gen: number, conn: MailboxAdapter): Promise<number> => {
        // ── THE MARKER-SURFACING PREFLIGHT, AT THE TOP OF THE ONE DRAIN BOTH DOORS SHARE ──────
        //
        // Routing no longer depends on this — `importDecisionOpenNow` below evaluates the question
        // from the folder each cycle — but the CONFIRM SURFACE does: the hold it
        // must offer for answering is readable only through the durable marker this preflight (or
        // the seed, which `start()`'s door reaches only after the whole drain) writes. Without it
        // a local takeover could route in hold mode for its entire launch with no candidate on
        // screen and no way to release. Self-guarding: one folder read per pre-seed drain entry,
        // nothing once seeded or held.
        //
        // ORGANIZER ONLY, and it has to be said here now that a reader reaches this line. The hold
        // exists so an INCOMING organizer does not re-screen what it is inheriting; an install that
        // is not the incoming organizer has nothing to inherit.
        // `profile-import-service.ts` states the invariant as a fact about this file — *"its cycle
        // never arms the hold (`engine.ts`, `index.ts` — both skip `armHoldFromFolder` for a
        // reader)"* — and while the whole drain was gated that was true by accident. It is true on
        // purpose now.
        /* THE CONNECTION CHECK SITS ABOVE THE ROLE CHECK, on its own line, and both of those
           facts matter. Above, because a pass whose connection has been replaced is stale
           whatever role it holds — a reader cycling over a dead socket is the wedge too. On its
           own line, because `reader-drain.test.ts` reads THIS FILE and requires the role gate to
           be literally `if (organizer.organizing) await …`: a source census cannot see through a
           brace, and folding the two together would silently retire a guard that exists to keep
           an organizer-only mailbox write off a reader's drain. */
        assertSameConnection(gen, conn);
        if (organizer.organizing) await profileSync.armHoldFromFolder();
        // BEFORE the cycles, not after: a resurface is a local database fact and does not depend on
        // the mailbox being reachable, so it must survive a cycle that throws on a dead connection.
        /* THE INSTALL'S OWN WORK, ONCE. See {@link onceForTheAccount}: another mailbox's drain that
         is already doing this is doing it for everybody. */
      await onceForTheAccount(resurfaceDue);
        // Due appointments next, still ahead of the cycles: a send somebody scheduled has a clock
        // on it, and it must not wait out a hundred-cycle backlog drain — nor be skipped because
        // an inbound cycle threw on a dead connection (its own SMTP dial fails independently and
        // the pass re-arms the row).
        //
        // ── ORGANIZER ONLY, and it is `SyncDeps.role`'s own list that says so ──────────────────
        //
        // *"A reader cycle SKIPS … the user-commanded folder-ops pass … and — at the composition
        // roots above this file — `ensureFolders`, `sendScheduled`, the kickstart, every retro pass
        // and the organizer profile publish."* This IS one of those composition roots, and while
        // the whole drain was gated the rule held by accident.
        //
        // It is not merely tidy. A stand-down CLOSES the appointments it can no longer keep, but
        // that close is best-effort and explicitly may fail — so a due appointment can survive into
        // a reader launch, and an ungated pass here would claim and SEND it, from an install the
        // mailbox's organizer knows nothing about, at a time nobody re-chose. The gate makes the
        // close's failure cost a delay rather than a delivery.
        assertSameConnection(gen, conn);
        if (organizer.organizing) await sendScheduled(gen, conn);
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
        if (organizer.organizing) await answerAway(gen, conn);
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
        // Per-cycle wall durations, summarized into one `sync_drain` line below — the read that
        // attributes desktop CPU and quit lag to the pipeline. `Date.now()` deliberately, not the
        // injected `now()`: a test may freeze that clock, and a frozen clock would report every
        // cycle as 0 ms.
        const cycleMs: number[] = [];
        while (!stopped && cycles < maxCycles) {
          /* THE REFUSAL, AT EVERY CYCLE EDGE. A drain runs for up to a hundred cycles and each
             one moves mail, so the question "is this still the connection I gated?" has to be
             asked repeatedly rather than once at the top. Between two edges the pipeline writes
             to `conn` — the instance, spread below — so a swap cannot redirect a cycle that is
             already running either. */
          assertSameConnection(gen, conn);
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
          // BOTH halves of "is there more to do": `hasBacklog` is inbound mail the adapter still
          // owes, `owesFiling` is outbound intent the reconciler still owes — filing that hit the
          // per-cycle budget, or a completion that RE-OPENED its own row (a delete whose park
          // promoted a surviving copy files that copy on the next pass). A drain that stopped on
          // backlog alone declared itself quiet with a move still pending, and a caller trusting
          // `syncUntilQuiet()` then stopped with the delete unfinished until the next poll.
          /* ── ACCOUNTED PER CYCLE, NOT PER DRAIN ─────────────────────────────────────────
           *
           * The bound used to be recorded once around the whole `drainPass`, and a drain is up to
           * a hundred cycles. A flapping socket therefore produced this: seven drains fail with
           * connection-class errors; the socket recovers; a backlog drain serves several real
           * cycles — clearing nothing, because the drain had not finished; the socket dies again
           * on a later inner cycle; the drain rejects, the streak advances 7 → 8 and the
           * connection is declared dead at once. The served cycles should have ended the old
           * outage and the new failure should have been streak one.
           *
           * So a cycle that COMPLETES clears the streak before the next begins, and a
           * connection-class failure inside the loop starts its own. The wrapper around
           * `drainPass` still exists for the failures that happen OUTSIDE the loop — the gate
           * itself, most of all, which is where a dead socket usually surfaces first. */
          let cycleServed = false;
          let hasBacklog: boolean;
          let owesFiling: boolean;
          try {
            const outcome = await runSyncCycle({
            ...syncDeps,
            /* THE GATED CONNECTION, spread over `syncDeps`'s live getter on purpose. The getter is
               what lets a re-dialled mailbox use its new connection; this is what stops a drain
               that is ALREADY RUNNING from being handed one. Both are needed and they are not in
               tension: the getter serves the next pass, this serves the current one. */
            adapter: conn,
            ...screening, classifier: ai.classifierForCycle(),
            // Mail 0083. THE ROLE THE GATE ANSWERED FOR THIS DRAIN, spread after `syncDeps` so it
            // wins: a demoted install keeps draining, and every cycle it runs from here is a READER
            // cycle — the mirror grows, `\Seen` is pushed, and nothing is moved, filed or created.
            // `organizer.organizing` is the gate's own answer, held on the engine and refreshed by
            // every gate run, so a demotion or a promotion applies to the very next cycle.
            role: organizer.organizing ? "organizer" : "reader",
            // A demoted install keeps draining as a READER, and a reader holds no lease — its
            // `\Seen` push is the one verb it may write. Naming that here rather than passing the
            // spent permit is what keeps "no lease" and "not asked" apart at the write boundary.
            writeAuthority: organizer.organizing ? leasePermit : { noLease: "reader" },
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED from
            // the current facts at every cycle edge — never cached; see the worker's cycle for
            // the argument (many arm/release orderings were tried, each with a
            // mirror-image race). One `ohmail/_meta` FETCH per cycle; a store serialize and an
            // indexed read only when a foreign document is present; a faulted read answers what
            // the previous cycle answered.
            importDecisionOpen: await profileSync.importDecisionOpenNow(),
          });
            cycleServed = true;
            ({ hasBacklog, owesFiling } = outcome);
          } finally {
            if (cycleServed) noteCycleServed();
          }
          cycleMs.push(Date.now() - cycleStart);
          cycles++;
          if (!hasBacklog) inboundDrained = true;
          if (!hasBacklog && !owesFiling) { drained = true; break; }
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
          await firstSync.report(mb.id, stamps, () => mirroredMessageCount(db, mb.id));
        }
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

      const drainPass = async (maxCycles = 100): Promise<number> =>
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
          /* ── WHICH CONNECTION THIS PASS IS ABOUT, CAPTURED BEFORE THE GATE READS IT ─────────
           *
           * The lease is read once per drain, on one connection, and everything after it is done
           * on the strength of that read. Both facts are therefore captured here, together, and
           * carried through the whole pass: the GENERATION so each mailbox write can re-check
           * that it is still current, and the INSTANCE so the cycles write to the connection the
           * gate actually asked, rather than to whatever the binding holds by then. */
          const gen = generation;
          const conn = adapter;
          /* -- THE GATE ANSWERS A ROLE. IT USED TO ANSWER ADMISSION, AND THAT WAS THE BUG ------
           *
           * This line was `if (!(await mayOrganize())) return 0;`, which made a stood-down install
           * do NOTHING -- and it contradicted, in this same file, both the sentence the stand-down
           * logs (*"its mirror goes on growing, it can mark mail read and send"*) and the comment
           * inside `drain` that spreads `role: organizer.organizing ? "organizer" : "reader"` and
           * says *"a demoted install keeps draining"*. The reader half of the cycle was written and
           * was unreachable: `drain` is the only path to `runSyncCycle` on this door, so a reader's
           * mirror never grew by one message and `reconcileFlags` -- `\Seen`, the reader's ONE IMAP
           * write verb -- never ran at all.
           *
           * MEASURED, against a real IMAP account whose lease another install holds
           * (`scripts/read-writeback-live.ts`): the install stood down, `syncUntilQuiet()` returned,
           * and the mirror stayed EMPTY -- not one message of a mailbox that had plenty. That is
           * also the whole of the reported symptom *"I marked it read on the desktop and my mailbox
           * never saw it"* for anybody whose desktop is a reader -- the intent is written locally
           * and the pass that would carry it to the server is never entered.
           *
           * `mayOrganize()` is therefore called for its DECISION and its side effects, and only the
           * arm that genuinely means "do nothing" still stops the drain: the removed-mailbox arm,
           * which sets `stopped` (and clears the timer and closes the login) before returning false.
           * The stand-down arm sets neither, which is exactly the distinction it was rewritten to
           * make.
           */
          const organizing = await mayOrganize();
          if (stopped) return 0;
          /* -- THE `ohmail/*` TREE, AT THE MOMENT THIS INSTALL BECOMES THE ORGANIZER ------------
           *
           * `start()` calls `ensureFolders` behind its own `permitted` gate, which is right and was
           * the ONLY call: a launch that came up already organizing made the folders and every later
           * pass had them. A promotion that happens MID-LIFE reached none of it, and mid-life
           * promotion is now the ordinary path rather than an edge — a fresh install comes up as a
           * consent-less reader, and "Agree and start organizing" promotes it on the very next pass.
           *
           * Without this, that pass routed into folders the server did not have. The comment on the
           * special-folder discovery forty lines below `start()`'s own call already states the
           * standard this has to meet — *"the knowledge is what makes a promotion take effect on the
           * next poll rather than on the next launch"* — and the folder tree was the half of that
           * knowledge nothing refreshed. The symptom is the one this whole area keeps producing: the
           * person agrees, the row says organizer, and nothing visible happens until they quit and
           * reopen.
           *
           * ONCE PER PROCESS, not once per pass. `ensureFolders` is idempotent but it is a round
           * trip per cycle otherwise, and this runs on the poll. The flag is armed by whichever of
           * the two paths gets there first — `start()`'s call sets it too — so an install that came
           * up organizing does not make a second one.
           *
           * A FAILURE IS NOT FATAL. The drain that follows can still mirror, `\Seen` still ships,
           * and the next pass tries again; throwing here would turn a transient IMAP fault into a
           * launch with no mail on screen. It is deliberately NOT set on the failure path, so the
           * retry is real.
           */
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
           * ── THE REQUEST DRAIN / THE READER'S OWN CYCLE (0.14.1) ──────────────────
           *
           * ONCE PER `syncUntilQuiet()`, not once per inner `drain()` cycle — `ensure_folders`'s
           * own reasoning applies verbatim: this reads or writes `ohmail/_meta` and doing so once
           * per DRAIN is a round trip per poll, not a round trip per batch.
           *
           * ORGANIZING → `applyMetaRequests` (apply a reader's decision, expunge it); otherwise
           * → `driveOutstandingRequests` (append this install's own pending decisions, observe
           * what the organizer took). See `@trafficflow/worker/request-drain`'s own header for
           * why neither performs a physical IMAP move of its own — `drain()`'s own `runSyncCycle`
           * call, right after this, reconciles the `folder_state` rows either one writes.
           */
          //
          // ── WHY THE DRAIN'S LOG IS TRANSLATED HERE AND NOT FORWARDED ────────────────────
          //
          // `(event, detail) => log(event, { ...detail })` is the obvious wiring and this door
          // may not use it. `log-census.test.ts` requires every call site in this package to
          // carry a LITERAL event name and a readable field set, because this is the published
          // desktop payload: a forwarded name is a name nobody can enumerate, and a spread
          // detail is a field set nobody can audit for what it might carry. The census caught
          // exactly that here. So the drain's outcomes are translated into three literal lines
          // with explicit fields, and anything else it reports is counted under a fourth rather
          // than echoed verbatim.
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
            cycles = await drain(maxCycles, gen, conn);
          } catch (err) {
            cycleError = err;
          }

          // ── THE REQUEST CHANNEL, AFTER THE MAIL ──────────────────────────────────────────
          //
          // Ordered deliberately, and the reason is not tidiness: `ohmail/_meta` is a folder any
          // process with append rights on the mailbox can write to, so a drain that ran BEFORE the
          // cycles would let a flood of records delay the pass that reads somebody's mail. A
          // queued decision landing one pass later is not a regression anybody can perceive; mail
          // arriving late is. The drain is bounded on both axes inside `request-drain.ts`.
          //
          // ── AND IT RUNS WHEN THE MAIL PASS FAILED, WHICH IS WHY THE FAILURE IS HELD ABOVE ──
          //
          // A cycle that THROWS used to escape this block entirely, so a mailbox with a
          // PERSISTENT sync fault drained nothing for as long as the fault lasted — and a
          // decision made on another install expired reporting that NOBODY TOOK IT, while an
          // organizer was live and connected the whole time. Telling somebody their decision was
          // dropped when it was merely never looked at is worse than telling them to wait.
          //
          // So the throw is held, this block runs, and the failure is rethrown below with nothing
          // else having happened. One call site, deliberately: a second copy inside a catch is how
          // a decision gets applied twice.
          //
          // ONE FAILURE IS EXCLUDED, and it is not the one the hosted twin excludes for. That one
          // can lose the shard it leads; this door leads nothing and shares nothing — one process,
          // one store, one mailbox — so a fence has no meaning here.
          //
          // What this door CAN lose is the lease itself. The mailbox is the master, and a mailbox
          // this install organizes today can be taken over from elsewhere: the takeover is written
          // into the shared folder, and this install discovers it and stands down on a later pass.
          // So "may this install write" is only ever as fresh as the last lease read that
          // SUCCEEDED.
          //
          // `LeaseUnavailableError` is that read failing. It does not say another organizer holds
          // the mailbox; it says this pass could not find out. The channel below appends
          // acknowledgements and expunges records, and its standing to do either comes from the
          // lease and nothing else — so it is exactly the work that must not proceed on an
          // unanswered question. Skipping costs a delay: the records stay where they are and the
          // next pass drains them once the lease can be read again.
          //
          // This is not the same rule as the one the bounded folder read follows one layer down,
          // where a partial read is acted on rather than refused. That is a read deciding what it
          // knows; this is a write claiming standing it failed to establish, and being wrong costs
          // opposite things — a refused read strands a mailbox nobody organizes, an unproven write
          // puts two organizers on one.
          const cycleMayStillWrite = !(cycleError instanceof LeaseUnavailableError
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

          // ── THE PORTABLE PROFILE'S WRITE-BEHIND TICK, BEHIND THE GATE IT RIDES ────────────
          //
          // After the drain and not inside it: the tick reads the store the cycles just wrote, so
          // a burst of screener verdicts in one drain is one comparison. Reachable only when
          // `mayOrganize()` said yes — a stood-down install reads and writes nothing here, which
          // is the single-writer property the lease already enforces. Runs on a zero-cycle drain
          // too, deliberately: settings change without mail arriving. Never throws.
          //
          // EXPLICIT NOW, because the line above no longer returns for a reader: this used to be
          // organizer-only by being unreachable, and the property has to survive that stopping being
          // true. Publishing the portable profile is a write into somebody else's `ohmail/_meta`,
          // and it is the single-writer rule rather than an optimisation.
          /* THE PROFILE PUBLISH IS A MAILBOX WRITE TOO — an append and an expunge in
             `ohmail/_meta` — and it read the LIVE getter, so a stale pass published this
             install's settings over a connection it had never gated. Checked here; the sync
             itself resolves its adapter through the same getter, so the check is what stands
             between it and a replaced connection. */
          assertSameConnection(gen, conn);
          if (organizing) await profileSync.onOrganize(conn);
          return cycles;
        });

      /**
       * ONE DRAIN, WITH THE CONNECTION'S HEALTH ACCOUNTED FOR EITHER WAY.
       *
       * The wrapper is the whole of the SECOND detector, and it exists because the first one is
       * not reachable from everywhere: `ImapAdapter#guardAsyncErrors` returns early for any
       * client with no event surface, so an injected double bypasses the `close` listener
       * entirely — which is exactly what the adapter's own comment says of it, and exactly why
       * the hosted worker bounds the same arm by duration rather than trusting the event. An
       * event-driven-only heal would be this repository's named `failure-looks-like-healthy`
       * shape: a mechanism whose only tested path is the one production does not always take.
       *
       * It also covers a connection death that genuinely emits nothing — a socket that answers
       * TCP and never completes another IMAP command, the half-open case a `close` event never
       * describes.
       *
       * ON THE PUBLIC ENTRY POINT and not inside `serialize`, so the accounting sees the drain's
       * OUTCOME rather than one step of it, and so a caller reaching this method directly (the
       * shell's "sync now", `syncMailbox`) feeds the same bound the poll timer does.
       */
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
        try {
          const cycles = await drainPass(maxCycles);
          noteCycleServed();
          return cycles;
        } catch (err) {
          noteCycleFailed(err);
          throw err;
        }
      };

      const schedule = (): void => {
        if (stopped) return;
        timer = setTimeout(() => {
          void syncUntilQuiet()
            .catch((err: unknown) => {
              // A failed cycle is a bad network or a sleeping laptop, not a reason to stop being a
              // mail app. Offline is a property of this mode: the organizer pauses and the viewer
              // stays complete — the API keeps serving the mirror over the bridge either way.
              /* ── EXCEPT WHEN WHAT FAILED WAS THE LEASE, WHICH IS NOT A PASSING CONDITION ────
               *
               * A cycle that died because `ohmail/_meta` could not be read is the organizer half
               * of the reader case beside it, and it was the louder of the two: the gate throws,
               * this handler logged, and the next tick tried again behind an ordinary connected
               * state. When the cause is a folder over the ceiling that does not clear by itself,
               * so the install organizes nothing for as long as it lasts and says nothing about
               * it.
               *
               * Narrowed BY CLASS deliberately. Arming this mark for every cycle failure would
               * make a dropped connection look like an unreadable lease, and the field would stop
               * meaning anything. Cleared by the next successful gate, like the other paths. */
              if (err instanceof LeaseUnavailableError) {
                organizer = {
                  ...organizer,
                  unreadableSince: organizer.unreadableSince ?? new Date().toISOString(),
                };
              }
              log("sync_cycle_failed", { err });
            })
            .finally(schedule);
        }, pollIntervalMs);
        timer.unref?.();
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
       * DIAL, THEN LEARN, THEN ACT — the ONE sequence a launch and a re-dial both run.
       *
       * This was the body of `start()`, and extracting it is the whole of what makes reconnect
       * safe rather than merely present. A re-dial that resumed the drain over a fresh socket
       * WITHOUT re-reading the organizer lease would dual-organize for one cycle against a claim
       * that arrived during the outage — and reconnect-after-sleep is precisely when a mailbox is
       * most likely to have changed hands. "Exactly one active organizer per mailbox" is the
       * invariant, and a SECOND implementation of this sequence is how it would be broken: two
       * copies drift, and the copy that drifts is the one nobody launches.
       *
       * So there is one copy, and the order inside it is the rule already written above the gate
       * below — the lease is read BEFORE the first move, and `ensureFolders` IS a move. Creating
       * the `ohmail/*` tree in a mailbox Cloud is organizing is a write this install has no
       * business making.
       *
       * IT DOES NOT ARM THE POLL TIMER, and that is the one edit the extraction made. `start()`
       * calls `schedule()` after it; a re-dial runs inside a drain whose own chain already ends
       * in `schedule()`. Leaving the call in here would give a re-dialled mailbox TWO timers —
       * two overlapping drains, and an append to `ohmail/_meta` per timer per interval.
       */
      const dialAndGate = async (): Promise<{ leaseRead: boolean }> => {
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
              /* CARRIED with the rest: an unreadable lease says nothing about the row. */
              releaseRequestedAt: organizer.releaseRequestedAt,
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
          /* -- `!permitted` IS "NOT THE ORGANIZER", NOT "STOP" — THE LAUNCH HALF  --
           *
           * This branch used to `return` here, and what it returned before is the whole first
           * drain, the special-folder discovery AND `schedule()` — so a stood-down install came up
           * with no poll timer at all. On `priorStandDown` it also closed the login, under a
           * comment whose first sentence was the pre-0083 doctrine verbatim: *"A stood-down
           * install STOPS SYNCING ENTIRELY — it does not keep passively mirroring, and it must not
           * keep burning a connection either."*
           *
           * That is no longer what a stand-down means, and TWO other comments in this same file
           * already say so. The stand-down logs *"it keeps its login and its poll timer, its
           * mirror goes on growing"*; and the takeover route's own header says *"A demoted install
           * is now a READER — it keeps its login and its poll timer and goes on cycling — so the
           * gate runs again on the very next poll, reads the stamp, and promotes. No relaunch."*
           * Neither could be true while this line returned: there was no next poll to read the
           * stamp on, so "Organize from this machine" did nothing at all until the app was
           * restarted — and that button is the whole of how a person takes a mailbox back onto a
           * machine that has stood down, so "it needs a relaunch" was not a small caveat.
           *
           * So a reader falls through: it drains, it schedules, and it keeps the connection the
           * next poll asks over. The ONE thing it does not do is below.
           */
          /* ── STOPPED IS CHECKED WHATEVER THE GATE ANSWERED ──────────────────────────────
           *
           * This read `if (!permitted && stopped)`, so a gate that said YES walked straight past
           * it — and `mayOrganize` is the longest await in the sequence, which makes it the most
           * likely place for `detach()` to land. A removal or a shutdown overlapping a slow lease
           * read therefore continued into `ensureFolders`, special-folder discovery and a full
           * drain on a runtime that had been told it was finished, having already appended a fresh
           * claim to the mailbox on the way through. `detach()` waited for all of it: it bounded
           * the damage's duration and prevented none of it.
           *
           * The permitted arm STANDS DOWN rather than merely returning. The gate has just renewed
           * this install's claim on a mailbox it is letting go of, and leaving that behind makes
           * the next install wait out a claim nobody is honouring. */
          if (stopped) {
            if (permitted) {
              const released = await releaseOwnClaim(
                conn, installId, mb.id, leaseNonce, log,
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
          // Before the first cycle of an ORGANIZER, always: the pipeline routes into `ohmail/*`
          // and a move to a folder the server does not have fails. The hosted sync worker does the
          // same thing at attach time.
          //
          // NEVER FOR A READER, and this is the sharpest line in the branch above: `ensureFolders`
          // is the IMAP WRITE that creates somebody else's `ohmail/*` tree, and the header forty
          // lines up already says so — *"reconnect is learn-then-act … creating the `ohmail/*` tree
          // in a mailbox Cloud is organizing is a write this install has no business making"*. It
          // was gated by the `return` that has just gone, so it needs its own gate now.
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
          // ── Mail 0065: DISCOVER THE PROVIDER'S OWN \Junk AND \Trash, AND WRITE THEM DOWN ──
          //
          // The hosted worker's attach hook, mirrored here because the LOCAL engine is its own
          // attach path: without this, a local install's `mailboxes.trash_folder` stays NULL for
          // ever, so its own API refuses every delete (`no_trash_folder`) and its spam verdicts
          // never reach the provider's Junk. Read-only (one LIST), re-written every attach so a
          // renamed folder heals, best-effort: a discovery failure keeps the stored answer and
          // the fallbacks are never destructive. imap-types.ts carries the product rule.
          //
          // A READER RUNS THIS TOO, deliberately. It is one LIST and a write to this install's own
          // row — no mailbox write of any kind — and the knowledge is what makes a promotion take
          // effect on the next poll rather than on the next launch.
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
          await serialize(() => drain(100, gen, conn));
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
       * RE-DIAL A CONNECTION THAT IS KNOWN DEAD — the heal, and where it may run from.
       *
       * ── IT MUST NOT BE CALLED FROM INSIDE THE SERIAL QUEUE, AND THAT IS A DEADLOCK ─────────
       *
       * The obvious place for this is the head of the drain, after the `stopped` check. It is
       * the wrong place: `serialize` chains onto `tail`, so a `serialize` call made from inside a
       * serialized function waits for the function that is waiting for it. `dialAndGate` takes
       * the queue twice (the gate, then the first drain), so a re-dial from inside `drainPass`
       * hangs the mailbox for ever with no error anywhere — the failure this whole lane is about,
       * reached by the fix for it. So it runs on the PUBLIC entry point, immediately before the
       * drain it is healing for, and the drain itself is untouched.
       *
       * ── A FRESH ADAPTER, NOT A RE-OPENED ONE ──────────────────────────────────────────────
       *
       * `ImapAdapter.connect()` does reset its own lifecycle flags, so re-dialling in place would
       * work for the socket. It is still wrong here for two reasons that are not about the
       * socket: an adapter RETIRED by a bound breach refuses every call for ever by design
       * (`assertUsable`), and a fresh dial is the only shape in which "this install opened a new
       * connection" is observable from outside — which is what a test can hold and a log can
       * report. The hosted worker's re-attach builds a new one for the same reason.
       *
       * ── IT NEVER THROWS ───────────────────────────────────────────────────────────────────
       *
       * A re-dial that fails must leave the drain to fail in its own words. Rethrowing here would
       * replace `LeaseUnavailableError` — the class the bound counts and every failure counter
       * exempts — with a dial error, so a server that is simply still down would start looking
       * like a broken mailbox.
       *
       * ── AND A FAILED ATTEMPT DOES NOT RESET THE CLOCK ─────────────────────────────────────
       *
       * `connectionDeadSince` keeps its first observation across any number of failed re-dials.
       * It is what Settings renders as "unreachable since", and a number that restarted every
       * time the app tried again would report a two-hour outage as fifteen seconds old.
       */
      let redialling = false;
      /**
       * THE IN-FLIGHT RE-DIAL, for `detach()` to wait on — and for nothing else to wait behind.
       *
       * Resolved whenever no re-dial is running, so awaiting it is free in the ordinary case.
       */
      let redialInFlight: Promise<void> = Promise.resolve();
      /**
       * @param force A PERSON PRESSED "SYNC NOW". Skips the backoff WAIT and nothing else.
       *
       * The ladder is right for a poll and wrong for a person. `redialNotBefore` widens to five
       * minutes so a server that is down is not knocked on four times a minute; the cost is that
       * after the network comes back the mailbox can sit unreachable for the rest of that wait,
       * and the one control the product offers for it did nothing. Measured on the Omarchy
       * guest: five failed attempts at 15/45/90/150/255 s, the sixth at +295 s, and a press in
       * between changed nothing.
       *
       * EVERY OTHER EARLY RETURN STILL HOLDS, and each is a different kind of no:
       * `stopped` and `connectionDeadSince === null` say there is nothing to re-dial;
       * `redialling` says one is already in flight, so a second press joins it rather than
       * opening a second login; the credential guard says the mailbox is waiting for a person,
       * not for the network; and `signInRefused` says the SERVER has already answered no — a
       * press must not turn that into repeated LOGIN attempts, which is what providers throttle
       * and some answer by locking the account. A press is evidence that somebody is waiting.
       * It is not evidence that the password changed.
       *
       * AND IT DOES NOT RESET THE LADDER. `redialAttempts` is untouched, so a forced attempt
       * that fails leaves the backoff exactly where it was: the press bought one dial, not a
       * fresh start.
       *
       * NOR IS IT UNLIMITED. Skipping the wait is not the same as having no wait: a failed dial
       * settles in well under a second, so an unbounded `force` let repeated presses dial once
       * per press and reproduced the four-times-a-minute knocking from the other side. A press
       * is honoured at most once per this profile's first ladder step — see
       * {@link forcedNotBefore} and {@link ReconnectProfile}.
       */
      const redialIfDead = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
        if (stopped || connectionDeadSince === null || redialling) return;
        /* THE SAME PRECONDITION `start()` KEEPS, and for the same reason: an empty password is a
           login attempt the server will refuse, and a refused login counts toward a lockout on
           some providers. A mailbox with no usable credential is not unreachable, it is waiting
           for a person, and dialling it repeatedly would turn that into a locked account. */
        if (login.state !== "ready" || !login.pass) return;
        /* ── A REFUSED SIGN-IN IS NOT RETRIED, AND A FAILING SERVER IS BACKED OFF ────────────
         *
         * Both are the same defect seen from two sides: a dial that cannot succeed being repeated
         * on the poll's cadence. The first cannot succeed until a person acts, so it is not
         * attempted at all; the second may, so it is attempted on a widening interval instead of
         * four times a minute. */
        if (signInRefused) return;
        /* THE PRESS SKIPS THE LADDER, AND THE FLOOR UNDER THE PRESS IS ITS OWN. See
           {@link forcedNotBefore}: a forced dial that failed a moment ago has not become worth
           repeating because somebody pressed again. */
        if (force ? Date.now() < forcedNotBefore : Date.now() < redialNotBefore) return;
        /* ── THE RE-DIAL JOINS `tail`, SO `detach()` WAITS FOR IT ────────────────────────────
         *
         * It cannot QUEUE behind `tail` — `dialAndGate` takes the queue twice and a queued
         * re-dial would wait for itself, which is the deadlock this lane already met once. But
         * `detach()` awaits `tail` and then closes the adapter, so a re-dial outside it could
         * resume AFTERWARDS: install a fresh connection, renew the organizer claim and create
         * folders for a mailbox that has just been removed, or leave an authenticated login with
         * no handle anywhere that can close it.
         *
         * AND IT IS NOT PUT INTO `tail`. That was the first attempt and it deadlocks for the
         * reason the paragraph above names, one step further out: `serialize` CHAINS onto `tail`,
         * so folding the re-dial into it makes every later queued step wait for the re-dial —
         * including `dialAndGate`'s own gate, which the re-dial is waiting for. Measured: the
         * first connection came up, drained and served; the re-dial connected and then hung for
         * ever on its own gate. Two different failures reached from the same wrong instinct, that
         * one promise chain can express both "run in order" and "wait for this".
         *
         * So the wait gets its OWN handle. `detach()` awaits the queue AND this, and this chains
         * onto nothing — a re-dial can therefore be waited FOR without being waited BEHIND. */
        redialling = true;
        let settle: () => void = () => {};
        redialInFlight = new Promise<void>((resolve) => { settle = resolve; });
        const deadSince = outageSince ?? connectionDeadSince;
        const detectedBy = connectionDeadBy;
        try {
          const old = adapter;
          /* ── THE DEAD CONNECTION IS DESTROYED, NOT ASKED TO LEAVE POLITELY ─────────────────
           *
           * `close()` issues a LOGOUT and IMAP commands are serialized, so it queues behind a
           * command that is already hung and waits out the hang it was escaping — the contract
           * {@link MailboxAdapter.forceClose} states, on the one caller that had not read it.
           * A half-open link (a phone losing its route: the socket answers TCP, nothing answers
           * IMAP) has nothing to end that wait, so the LOGOUT never settled, `finally` never
           * ran, and `redialling` — the latch EVERY later attempt returns on, the poll's and the
           * person's press alike — was held for the life of the process. Measured on a device:
           * one `mailbox_reconnect_failed`, then no dial ever again and zero bytes on the wire
           * with the route restored, while the drain went on failing every fifteen seconds.
           * Destroying the socket is also the only thing that ends the hung command.
           *
           * THIS AND THE DETECTOR'S TEARDOWN ARE ONE MECHANISM, not a fix and a belt. Measured
           * by mutating both: with either one destroying, the dial happens — because destroying
           * the socket is what ends the OTHER one's hung LOGOUT. With both polite there is no
           * dial at all, which is the device's reading. So neither may be relaxed on the grounds
           * that the other covers it. */
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
          /* ── THE SOCKET IS UP. THAT IS NOT THE SAME AS THE MAILBOX BEING SERVED ────────────
           *
           * `connectionDeadSince` clears either way, and it has to: it is what makes the next
           * poll re-dial, and re-dialling every fifteen seconds over a server that is answering
           * would churn logins on a provider that counts them.
           *
           * `outageSince` clears only when a cycle is actually SERVED, which is
           * `noteCycleServed`'s job and not this one. So a re-dial that reached a live server and
           * an unreadable `ohmail/_meta` leaves the Settings row saying "unreachable since" the
           * ORIGINAL instant — the outage is not over, and neither the person's clock nor the
           * word "reconnected" may pretend it is. */
          connectionDeadSince = null;
          connectionDeadBy = null;
          redialAttempts = 0;
          redialNotBefore = 0;
          /* THE PRESS'S FLOOR GOES WITH THE LADDER, and NO TEST WATCHES THIS LINE — said here
             because the alternative is a later reader taking it for a guarantee.
             Its contrary state is unreachable: a FORCED dial only runs once the floor has
             passed, so after one the floor is a past instant whether or not this clears it, and
             a later press is admitted either way. The one path that could see a difference — the
             POLL succeeding INSIDE the floor's window — needs the ladder's jitter pinned and the
             clock frozen across a 13-second jump, and a fixture doing that loses the organizer
             lease (`lease_lost_race`, then `organizer_stand_down`), after which the resync route
             refuses and the press dials nothing for a reason that is not this line. A case built
             on it passed only by asserting before the stand-down landed, which is a race, not
             evidence; it was removed rather than left looking like a guard.
             The line stays because it is correct hygiene — a floor outliving the condition it
             rations is a bug waiting for the next caller — but it is DEFENCE, not a watched
             invariant, and the mutation table says so by leaving it out. */
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
            /* ONLY A FORCED ATTEMPT ARMS THE PRESS'S FLOOR, and the `if` is the whole of it.
               An earlier version armed this on ANY failed dial, which reads harmless and is not:
               during an outage the POLL fails on its own cadence, so the floor would be re-armed
               every 15 s to 5 min and a press would be refused almost whenever anybody made one
               — the defect this lane closed, rebuilt out of its own remedy. Caught by the
               press-through-the-route control, which went red the moment it ran beside the rest
               of the file.

               UNJITTERED AND FIXED AT THE LADDER'S FIRST STEP, unlike the arm below. It moves
               with the profile for the reason the profile exists: a press rationed at the
               desktop's 15 s on a phone whose automatic ladder runs at 5 s would be the control
               making the heal slower, which is the defect this floor was added to avoid.
               The jitter exists to stop several mailboxes knocking in unison after an outage,
               which is a property of the AUTOMATIC cadence; a person pressing a button is not a
               herd, and a floor that moved would make "press again in fifteen seconds" a thing
               nobody could state. */
            forcedNotBefore = Date.now() + reconnect.ladderMs[0]!;
          } else {
            /* AND ONLY THE POLL CLIMBS THE LADDER — a press is one dial, not evidence about the
               server's schedule; see the contract above. A failed forced attempt used to run
               these two lines as well, which widened the AUTOMATIC wait and restarted it from
               the press: the app's own next attempt then came later than it would have if
               nobody had pressed, so the one control the product offers for a slow heal made
               the heal slower, and six presses walked the wait to the five-minute cap. */
            redialAttempts += 1;
            const step = redialStepMs(reconnect, redialAttempts);
            /* JITTERED, so several mailboxes on one server do not knock in unison after an
               outage — the thundering herd every backoff without one produces. */
            redialNotBefore = Date.now() + Math.round(step * (0.8 + Math.random() * 0.4));
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
        get organizer() { return organizer; },
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
            reachable: outageSince === null,
            unreachableSince: outageSince,
            /* THE DIAGNOSIS, not just the fact. "Can't reach the mail server" over a server that
               answered and said no is the wrong sentence: it sends somebody to look at their
               network when the answer is their password. */
            signInRefused,
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
          // ── NO PASSWORD, NO CONNECTION — AND THAT IS NOT A FAILED LAUNCH ──────────────────
          //
          // Offline is a property of this mode: the organizer is paused and the viewer is
          // complete, so the bridge keeps serving the mirror and the shell shows a password
          // field. Throwing here instead would make a missing password look like a broken app,
          // and a mailbox whose key was replaced would be unrecoverable rather than one prompt
          // away. Deliberately BEFORE `connect()`: an empty password is a login attempt the
          // server will refuse, and a refused login on some providers counts toward a lockout.
          if (login.state !== "ready" || !login.pass) return;
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
            /* ── A LAUNCH THAT COULD NOT DIAL IS AN OUTAGE, NOT A DEAD MAILBOX ───────────────
             *
             * `connect()` can reject without the adapter ever emitting anything: a refused TCP
             * connection, a TLS failure, a server that never answers the greeting. Nothing had
             * observed a connection to lose, so no detector fired — and `start()` threw before
             * arming the poll, so there was no timer either. The result was a mailbox reported
             * REACHABLE for ever with no path that could ever heal it, which is the same
             * failure-looks-healthy shape this lane exists to close, reached from the one
             * direction nothing was watching.
             *
             * So the death is recorded and the timer IS armed. `main.ts` still learns the launch
             * failed — the error is rethrown — but the mailbox now has a poll that will re-dial
             * it, and Settings says it is unreachable until one succeeds.
             *
             * `null` for the adapter, because `dialAndGate`'s own catch has ALREADY closed it —
             * that is the whole of what `connection-release.e2e.test.ts` holds, and queueing a
             * second close here made a failed launch close its login twice. Recording the death
             * and releasing the socket are two jobs; this call site only needs the first. */
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
         * STOP THIS MAILBOX AND LEAVE THE STORE ALONE.
         *
         * The install's `stop()` used to be this and the store close together, because one
         * mailbox going down WAS the engine going down. They are different acts now: removing
         * one mailbox of three stops one login and one timer, and the other two go on serving
         * out of the same database. So the store close stays with the engine and this closes
         * exactly what this mailbox holds.
         *
         * The in-flight cycle is awaited rather than cancelled — a drain half-way through a
         * batch has rows committed and a cursor it is about to move, and dropping it there is
         * how a mailbox re-reads mail it already had.
         *
         * ── AND THE WHOLE OF IT IS BOUNDED: ON A HALF-OPEN LINK IT NEVER ENDED ──────────────
         *
         * A half-open link — a phone losing its route: the socket answers TCP, nothing answers
         * IMAP — has nothing to end a command, and this method has THREE waits a command can
         * hold: the queue, an in-flight re-dial, and the polite `close()` whose LOGOUT queues
         * behind whatever is already hung. Measured: the drain parks in its PREFLIGHT PROBE,
         * which runs OUTSIDE the serial queue, so the queue is clear and what hung was the
         * LOGOUT — a bound on the queue alone was half a fix and the case that found it is in
         * `reconnect-after-close.test.ts`.
         *
         * So there is ONE budget — one drain interval, past which a cycle is not "about to
         * finish", it is wedged — spent across all three, and when it runs out the socket is
         * DESTROYED. That is also the only thing that ends the hung command, so nothing is left
         * to wait for and this returns without a LOGOUT.
         */
        async detach() {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (heartbeatTimer) clearTimeout(heartbeatTimer);
          const startedAt = Date.now();
          const left = (): number => startedAt + detachWaitMs - Date.now();
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
          /* AND THE LOGOUT, which is where a preflight-parked drain actually holds it. Raced
             rather than awaited, and its rejection still reaches the log: a server that answers
             the LOGOUT with an error is a different thing from one that answers nothing. */
          if (!wedged) {
            const politely = Promise.resolve(adapter.close()).catch((err: unknown) => {
              log("adapter_close_failed", { err });
            });
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
         * THE CLAIM GOES BACK; THE ROW DOES NOT MOVE. See `LocalMailboxRuntime.handBack`.
         *
         * Inside `serialize`, so it cannot land between a gate's claim and the drain that claim
         * authorises — the window `detach()` documents as the most likely place for a teardown to
         * arrive. `releaseOwnClaim` is the SAME function the detach arm and the release route call:
         * this adds a caller, not a second way to give a claim up.
         *
         * `organizing` goes false whatever the release answered, and that is deliberate rather
         * than sloppy. `drain` decides organizer-only work from that field, and the caller of this
         * is an app about to be suspended: a state saying "organizing" over a process that is not
         * running is the two-organizers reading. What the ANSWER decides is whether the caller may
         * say the mailbox was handed back — `null` means it may not.
         */
        async handBack() {
          return serialize(async () => {
            if (stopped) return 0;
            const released = await releaseOwnClaim(
              adapter, installId, mb.id, leaseNonce, log,
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
            /* CARRIED: a hand-back removes the CLAIM and deliberately leaves the row saying
               organizer, so it neither makes nor spends a person's stop. */
            organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null,
              releaseRequestedAt: organizer.releaseRequestedAt };
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
         * TAKE THE MAILBOX BACK IF NOBODY ELSE HAS IT — the other half of `handBack`.
         *
         * It clears the hand-back and runs ONE forced cycle, which is the ordinary gated cycle: the
         * gate reads `ohmail/_meta` and either claims a free mailbox or stands this install down
         * against a holder. No press, no row write, and no way to displace anybody — a resume that
         * could take a mailbox from another machine would be the press without the person.
         *
         * `force` for the resync route's reason: this is somebody opening the app, so the re-dial
         * backoff wait must not hold the first cycle behind it. The cycle re-arms the poll timer on
         * its way out, which is what `handBack` cleared.
         *
         * Answers how many cycles ran — `0` means the cycle could not be served, and the caller
         * must not report the mailbox as taken back.
         */
        async resume() {
          handedBack = false;
          return syncUntilQuiet(undefined, { force: true });
        },
      };
      runtimes.add(rt);
      return rt;
    };

    /**
     * ══ A PAUSE AN OLDER BUILD LEFT IS ENDED BEFORE THE ROSTER IS READ ═══════════════════════
     *
     * The FOURTH write of the in-place upgrade below, and the one that cannot sit with the other
     * three: they repair a credential the ATTACH seals, so they run after it, and this one decides
     * WHICH ROWS THE ATTACH SEES. Placed after the loop it would attach nothing this launch and the
     * mailbox would come back one restart later — a person pressing "Organize here instead" twice
     * and being answered by neither press.
     *
     * {@link endLegacyOrganizerPauses} carries what the shape is and why the rewrite is a reader.
     * One line per row, so an install with no such row says nothing extra; the id and the reason,
     * never the address.
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
     * ATTACH EVERY LIVE MAILBOX.
     *
     * Read once, here, and never on a timer — the only writers of this table are this engine's own
     * routes, so attach and detach are EVENTS rather than something to discover. The seed is
     * whichever row the configured address names; every other row is a mailbox somebody added
     * through the door, and the difference matters for exactly two things — the environment
     * password and the process's submission server, both of which are facts about the seed.
     *
     * SEQUENTIALLY, deliberately, and this is the one place the concurrency rule elsewhere in this
     * file is inverted. Each attach reads and may WRITE the credential table for its own mailbox,
     * and a first launch's seal is one of those writes; running them in parallel would put several
     * such writes into one PGlite backend at once for no gain, since attaching does not dial —
     * `start()` is what opens connections, and that is concurrent.
     */
    for (const row of await loadLocalRoster(db, world.accountId)) {
      await attachLocal(row, isSeedRow(row.address));
    }
    log("local_roster_attached", {
      count: runtimes.size,
      /* ── IT COUNTS RUNTIMES, AND IT USED TO CLAIM THEY HELD CLAIMS ────────────────────────
       *
       * The sentence ended "…and its own organizer claim", and attaching does not dial — `start()`
       * is what opens connections, as the block above this loop says. So the count is runtimes, and
       * the clause was printed verbatim for a mailbox this install is a READER of: one that has no
       * claim in `ohmail/_meta` and, while its row says `reader`, never will.
       *
       * It cost a release investigation. An empty `ohmail/_meta` beside `count: 1` was read as this
       * install believing it held a claim, because this line said so, and the search went looking
       * for a gate that had refused to write rather than for the row that says who organizes. A log
       * line that overstates is the same fault as a comment that overstates, and dearer, because it
       * is what somebody reads at three in the morning with no code in front of them.
       *
       * Whether this install organizes a mailbox is the lease's answer, per mailbox, and it has its
       * own lines. */
      reason: "every mailbox this install holds has a runtime: its own connection and its own poll "
        + "timer; whether it also organizes that mailbox is the lease's answer, logged per mailbox",
    });
    /* ── AND THE ROWS THE ROSTER READ LEFT OUT, BY NAME ─────────────────────────────────────
     *
     * The count above says how many mailboxes this install RUNS and cannot say which ones, and
     * `loadLocalRoster` leaves out every `disabled` row — a paused one (stood down, with a reason)
     * and a tombstone (removed, reason NULL) alike. Neither had a line, so a mailbox this install
     * holds and does not run was absent from the boot record entirely: no skip line, no row state,
     * nothing. Worse, `ensureLocalWorld`'s lookup is WIDER than the roster's, so a paused row can
     * be the seed — and the `serving` line then prints the id of the one mailbox with no runtime.
     * An incident on that shape reads backwards from the log, which is how it was read.
     *
     * One line per left-out row, so the ordinary install (none) says nothing extra. The id and the
     * reason, never the address. */
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
     * ══ THE IN-PLACE UPGRADE, AND THE ROSTER IT LEAVES ════════════════════════════════════════
     *
     * Nothing moves. The store, the account row, the mailbox row, the credential and the claim in
     * `ohmail/_meta` are byte-identical across this change; what is different is the READER. An
     * install that ran one mailbox comes up running a roster that happens to hold one.
     *
     * Four writes make that true, and each is keyed on a predicate that is false once it has
     * been done — no marker, no journal entry, nothing to migrate. A third launch writes nothing.
     * The FOURTH is above the attach loop rather than here, and its block says why: it decides
     * which rows the attach sees, where these three repair what the attach sealed.
     *
     *  1. THE SEED ROW, which `ensureLocalWorld` has already decided about above: it exists on a
     *     fresh install and is found on every later one. Its predicate is the one that stops a
     *     removed mailbox coming back.
     *  2. THE INCOMING SERVER, backfilled onto the seed's `imap` credential when the row does not
     *     record one. Rows sealed after the probe started recording `host/port/secure/user`
     *     already carry them and are skipped.
     *  3. THE SUBMISSION CREDENTIAL, when this launch is configured with an outgoing server and
     *     the seed has no `smtp` row.
     *
     * Two and three exist because the reader changed: every mailbox now dials from its own
     * credential row rather than from the process environment, so a seed whose row predates that
     * would come up with no server at all — a working install that stopped working on upgrade.
     */
    const seedRow = world.mailboxId ? runtimeRosterRow(await loadLocalRoster(db, world.accountId), world.mailboxId) : null;
    if (seedRow) {
      /* ── 2. THE INCOMING SERVER ─────────────────────────────────────────────────────────────
       *
       * `sealedHost(meta) === null` is the whole predicate — the row does not say which server it
       * was proved against. That is the shape of every credential sealed before the probe recorded
       * one, and it is exactly the shape the new reader cannot dial from.
       *
       * It writes what THIS launch is configured with, which is the only evidence available and is
       * the same pair the old reader would have dialled — so the upgrade dials precisely where the
       * previous version dialled, and a rollback finds a `meta.host` its own
       * `credentialIsForeign` agrees with.
       *
       * MERGED, never replaced: the blob may already carry `smtpHost` (the outgoing witness) or an
       * OAuth block, and a whole-value write would silently drop them.
       */
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

      /* ── 3. THE SUBMISSION CREDENTIAL ───────────────────────────────────────────────────────
       *
       * The send path reads a mailbox's `smtp` credential row, and a seed that has never had one
       * would lose the ability to send on upgrade — its submission server was a process setting,
       * and process settings are no longer consulted.
       *
       * THE SECRET IS COPIED, NEVER DECRYPTED. `secretEnc` and `keyVersion` are taken from the
       * `imap` row verbatim: it is the same password for the same mailbox, sealed under the same
       * key, so the ciphertext is already exactly what an `smtp` row should hold. Decrypting to
       * re-encrypt would put the plaintext in this process for no reason at all, and would fail
       * outright on an install whose key cannot open its own row — which is a state that must
       * stay recoverable by re-entering the password, not one that breaks a boot.
       *
       * The `meta` is the coordinates the person typed beside that password, which is the same
       * authorization the outgoing witness already recorded.
       */
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
         * ══ WHICH SUBMISSION SERVER THIS ROW IS FOR, AND IT IS NOT SIMPLY "THE CONFIGURED ONE" ══
         *
         * This read `config.imap.smtp` and nothing else, and that was wrong in the one direction
         * that matters. The credential already RECORDS the submission host it was saved for —
         * `meta.smtpHost`, written by the door because the person who typed the password typed
         * both servers into the same form — and that record is an AUTHORIZATION. Taking the
         * process's current setting instead would let an install acquire a submission server
         * nobody ever saved the password for, simply by being relaunched with a different
         * setting: exactly the defect the send path's own outgoing refusal used to catch, walked
         * back in through the upgrade.
         *
         * {@link sealedSmtpHost}'s three answers are the three cases, and they are genuinely
         * different:
         *
         *  · A HOSTNAME — the person authorized that server. Use it, whatever this launch is
         *    configured with. A configuration that disagrees is a change they have not completed;
         *    the send goes where they said, and re-entering the password is what moves it.
         *  · NOTHING (the key is absent) — the credential predates the record. There is no
         *    authorization to honour and no disagreement to detect, so the process's setting is
         *    the honest answer: it is precisely where the previous build would have submitted,
         *    which is the whole promise of an in-place upgrade. This is the same tolerance the
         *    shared comparison already grants such a row.
         *  · THE EMPTY STRING — the person saved the password for a pair with NO submission
         *    server. Writing a row here would hand that password to a server that appeared
         *    afterwards, which is the same defect by the third route. Write nothing.
         */
        const witness = sealedSmtpHost(imapRow?.meta ?? null);
        const configured = config.imap.smtp;
        /**
         * ── AND THE PORT HAS TO COME FROM THE SAME SERVER AS THE HOST ────────────────────────
         *
         * The witness records a HOSTNAME and nothing else — the door writes `meta.smtpHost` as a
         * flat string, deliberately, so that a merge cannot erase a stored port. So when the
         * witness DISAGREES with this launch's configuration there is no port to pair it with:
         * taking the configured one would build the row out of two different servers, and an
         * install whose password was saved for an implicit-TLS server on 465 and which is now
         * configured for 587 would get a permanent row saying `{465-server, 587, cleartext}`.
         * Written once, `hasSmtp` true from then on, and it never heals.
         *
         * So a DISAGREEING witness writes NO ROW AT ALL, and that is the old behaviour restored
         * rather than a new refusal: this is exactly the state the send path's outgoing arm used
         * to refuse, and refusing is right — the person is part-way through changing their
         * submission server, and finishing it (re-entering the password, which re-records both)
         * is what completes the move. Guessing a port on their behalf would send their mail
         * somewhere they never authorized, or downgrade the connection it goes over.
         *
         * The two agreeing cases are unchanged: a witness that MATCHES the configuration takes
         * that configuration's port and TLS mode, and a witness that says NOTHING falls back to
         * the configuration entire — which is where the previous build submitted.
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
            await db.insert(mailboxCredentials).values({
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
      compactMs: opened.timings.compactMs,
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
    const firstSync = createFirstSyncReporter(log);

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
        // ── TWO ROUTES AHEAD OF THE TABLE, AND WHY THEY ARE NOT IN IT ──────────────────────
        //
        // `DELETE /local/stored-login` is a DESKTOP-ONLY action: forget the password sealed on
        // THIS machine. `packages/api`'s route table is shared with the hosted service, where the
        // idea has no meaning — there is no per-install key and no local store to forget from — so
        // adding it there would be hosted surface invented for a desktop lifecycle.
        //
        // `POST /local/organizer/takeover` is the second, on the identical argument: it authorizes
        // ONE becoming on THIS install's own mailbox row, which is a fact about a local store the
        // hosted service does not have. The hosted equivalent is `POST /mailboxes/:id/takeover`
        // on an account, and it is a different ceremony with a different authority — this one is
        // the machine's own login, which is the boundary on this door.
        //
        // Both carry the same gate every other request on this transport carries: the per-launch
        // bearer, resolved by the same `resolveSession` the middleware chain runs. The bearer is
        // added shell-side and never reaches the window, so a page cannot compose these calls
        // itself. The Cloud door (`cloud-engine.ts`) is a different composition and serves
        // neither, which is what keeps "organize from this machine" off a mirror this install
        // does not own — structurally, rather than by a check.
        //
        // AND THEY ARE ON `handle` ALONE, NEVER `handleHost` OR `handleLan`. Those two serve a
        // PAIRED DEVICE over the network, and both of these actions are statements about THIS
        // COMPUTER — forget the password sealed on this disk; make this machine the organizer of
        // a mailbox. A phone on the same network asserting either would be a remote device
        // deciding something whose whole authority is that somebody is sitting at the machine.
        // The separation is the route table's: `desktopHostRoutes` has never heard of these
        // paths, so both doors fall through to their static handler.
        const url = new URL(req.url);
        const localRemoveMatch = req.method === "DELETE"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* -- `POST /local/mailboxes/:id/organize` — THE FIRST-RUN CONSENT, ON THIS DOOR -------
         *
         * The shared table's `POST /mailboxes/:id/organize` is `stepUp: true`, which on THIS door
         * is not a guard but a permanent refusal: the launch session's second-factor stamp is
         * written once at boot (`identity.ts#mintLaunchSession`, "there is no second factor on a
         * local install"), so `withStepUp` refuses from five minutes after launch for the life of
         * the process — which is every machine that has been open longer than a coffee. That is
         * the same shape `DELETE /local/mailboxes/:id` was added for, and it is recorded in its
         * note below; here it would strand the standalone install's ONLY onboarding path, so the
         * flow could never be completed on the door the flow exists for.
         *
         * The per-launch bearer is the authority, exactly as it is for the three routes beside
         * this one: minted at boot, added shell-side, never reaching the window, impossible for a
         * page to compose. Holding it IS being the person sitting at this machine.
         *
         * `stepUpWindowMs` is NOT widened. The window is right for the door it was written for;
         * what is wrong is applying a second factor to a tier that has none. */
        const localOrganizeMatch = req.method === "POST"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})\/organize$/.exec(url.pathname)
          : null;
        /* -- `PATCH /local/mailboxes/:id` — SEALING THE MAILBOX PASSWORD, ON THIS DOOR --------
         *
         * The fourth route in this family and it is here for the family's reason, measured on a
         * released build: re-connecting a mailbox thirty-five minutes after launch answered
         * **"recent two-factor authentication required"** — on a door that has no second factor
         * and no way to acquire one. The only cure a person had was to quit and reopen the app.
         *
         * The shared `PATCH /mailboxes/:id` is `stepUp: true` (correctly — its body carries a
         * mailbox password), and the launch session's second-factor stamp is written ONCE at boot,
         * so on this door that flag refuses everything from five minutes after launch for the life
         * of the process.
         *
         * IT LOOKED LIKE IT WORKED, and that is what kept it hidden. The FIRST connect seals
         * seconds after `engine_configure` replaces the engine, inside the one window where the
         * launch stamp is fresh — so the door's own happy path passed by luck of timing rather
         * than by design, and only the RE-connect (over an engine that has been up a while) ever
         * met the refusal. Routing both through here makes the first connect's success structural
         * too, which is the point: `doors.ts` calls one function for both.
         *
         * The SERVICE is `MailboxService.update`, with the same probes the shared route injects —
         * so a password that cannot log in is refused HERE, on the form, exactly as it is on the
         * hosted door. This handler is the transport and the authority, never a second
         * implementation of the credential write. */
        const localSealMatch = req.method === "PATCH"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* -- `POST /local/mailboxes` — ADDING A MAILBOX, ON THIS DOOR ----------------------
         *
         * The fifth member of the ahead-of-table family, and it is here for the family's one
         * reason: the shared `POST /mailboxes` is not `stepUp: true`, but every other verb this
         * flow needs is, and a door that could add a mailbox and then not seal, remove or organize
         * it would be worse than one that could not add at all. The authority is the same for all
         * five — the per-launch bearer, minted at boot, added shell-side, never reaching the
         * window, impossible for a page to compose. Holding it IS being the person at this
         * machine.
         *
         * On `handle` ALONE, never `handleHost` or `handleLan`. Adding a mailbox to somebody's
         * computer is a statement about THIS COMPUTER, and a phone on the same network must not
         * be able to make it. The separation is structural: those doors route through
         * `desktopHostRoutes`, which has never heard of this path. */
        const localAddMatch = req.method === "POST" && url.pathname === "/local/mailboxes";
        /* -- `POST /local/mailboxes/probe` — TESTING A CONNECTION, ON THIS DOOR --------------
         *
         * The sixth member, and the reason it exists is the family's reason arriving through a
         * door that was not open until this release. The shared `POST /mailboxes/probe` is
         * `stepUp: true` — correctly, its body carries a mailbox password — and on this door the
         * launch session's second-factor stamp is written ONCE at boot, so the flag refuses
         * everything from five minutes after launch for the life of the process.
         *
         * IT USED TO BE SATISFIABLE BY ACCIDENT, and the accident is over. The flow's connect
         * form is withheld the moment a mailbox exists, so the only state in which "Test
         * connection" could be pressed was one where the engine had just come up — the same
         * window in which the launch stamp is fresh. `local-first-run.ts` said so in as many
         * words and was right at the time. Settings → Add mailbox makes the form reachable at any
         * point in a launch, and the flow's primary is DISABLED until a verdict exists — so
         * without this route "Add mailbox" is a dead end on every window that has been open
         * longer than a coffee.
         *
         * MEASURED rather than reasoned: against a real sidecar, the shared route answered the
         * mail server's own refusal at 170 s after boot and `403 step_up_required` at 330 s.
         *
         * The SERVICE is `MailboxService.probeConnection`, with the same prober the shared route
         * builds and the same `countFolders: true` — this is the one call site that pays a LIST
         * for a number a screen reads. It writes NOTHING: no row, no credential, no folder. The
         * authority is the per-launch bearer, as it is for the other five.
         *
         * On `handle` ALONE. A probe opens a socket to a host named in its body, so a phone on
         * the same network must not be able to ask this computer to make one. */
        const localProbeMatch = req.method === "POST" && url.pathname === "/local/mailboxes/probe";
        /* -- `GET /local/mailboxes/connections` — CAN THIS MACHINE REACH THEM RIGHT NOW ---------
         *
         * A THIRD route ahead of the shared table, on the identical argument the two above it
         * carry: it reports the liveness of sockets THIS PROCESS holds. The hosted service has no
         * such thing to report — its mailboxes are attached by a worker on a shard, and a
         * connection there is a fact about a machine no user is sitting at — so adding it to
         * `packages/api`'s table would be hosted surface invented for a desktop lifecycle.
         *
         * AND IT IS NOT A COLUMN, which is the other reason it is here rather than on
         * `GET /mailboxes`. A dead connection does not survive a restart: a relaunch dials a
         * fresh one. Recording it durably would make every first boot after an outage report a
         * mailbox as unreachable that is already connected.
         *
         * ON `handle` ALONE, like its two neighbours: `handleHost` and `handleLan` serve a PAIRED
         * DEVICE, and whether THIS COMPUTER's socket is up is a question for somebody sitting at
         * this computer. A phone's own view of its host is the pairing layer's answer, not this
         * one.
         */
        const localConnectionsMatch = req.method === "GET"
          && url.pathname === "/local/mailboxes/connections";
        const localAction = localConnectionsMatch
          || (req.method === "DELETE" && url.pathname === "/local/stored-login")
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
          /* ── THE RECEIPT, BEFORE ANY BRANCH ─────────────────────────────────────────────
           *
           * With only a verdict logged, "the press never reached the door" and "the door took it
           * and dropped it" leave identical evidence. It sits ABOVE the credential read because
           * that read is this block's first branch, and the refusal under it is one of the two
           * that answered in silence.
           *
           * The route PATTERN, never the request's path; `mailboxId` is empty where the path
           * carries none, and for the takeover, whose id is in a body not read yet. The
           * connections GET is excluded — it is a read Settings makes four times a minute, and
           * what it needs is a rate floor rather than a receipt. */
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
          const core = token ? await resolveSession(db, token, now()) : null;
          if (!core) {
            /* THE VERDICT FOR THE ONE REFUSAL EVERY DOOR HERE SHARES. Without it the receipt
               above is followed by nothing, which is the state it was added to end. */
            log("local_action_refused", {
              method: req.method,
              route: localActionRoute,
              status: 401,
              reason: "the request carried no launch bearer this install recognises, so nothing " +
                "was read or written",
            });
            return new Response(
              JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }),
              { status: 401, headers: { "content-type": "application/json" } },
            );
          }
          if (localOrganizeMatch) {
            /* -- AGREE AND START ORGANIZING, WITH THE WINDOW IN THE SAME WRITE ---------------
             *
             * The ceremony is `requestOrganizerTakeover`'s and is NOT re-implemented here — this
             * handler is the transport and the outcome, the same division the takeover route
             * below keeps. What is new is that the SCREENING ANSWER travels with the consent:
             * `screening_baseline_at`, `dormancy_days` and `screening_scope` are written in the
             * same transaction as `organize_consented_at`, because the baseline is what the
             * window is measured from. Written separately, there is a gap in which the consent
             * exists and the window does not, and in that gap the cutoff is the product default
             * rather than the answer the person just gave.
             *
             * The account is the LAUNCH SESSION's, never a value from the body. This install
             * serves one account and `core` is the session just resolved above; taking it from
             * the request would let a body name a different account's settings row.
             */
            const mailboxId = localOrganizeMatch[1]!;
            let body: { screening?: { dormancyDays?: unknown; scope?: unknown } } = {};
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
            /* -- THE SERVICE IS THE SHARED ONE, WITH BOTH PROBES ---------------------------
             *
             * `MailboxService.create` writes the row and the credential in ONE transaction and
             * refuses a password it could not log in with, because the probes are injected — the
             * same pair the shared `PATCH /mailboxes/:id` and this door's own seal route inject.
             * Anything less would make this the second door into `mailbox_credentials`, and the
             * one that stores a secret nothing has tried.
             *
             * The allowance is already `UNMETERED` on this door (the free tier's limit is the
             * user's own disk), so the mailbox count is not gated here; that is a fact about the
             * tier and it is declared in `localServices`, not re-decided in this handler.
             *
             * The account is the LAUNCH SESSION's and never a value from the body. This install
             * serves exactly one account, so there is nothing a body could name that would not be
             * a way of naming another.
             */
            try {
              const body = (await req.json()) as Record<string, unknown>;
              const deps = depsFor();
              const ctx = {
                db, accountId: core.accountId, userId: core.userId,
                now, requestId: "", sessionId: core.sessionId ?? null,
              };

              /* ── THE SAME-LOGIN REFUSAL, AHEAD OF THE WRITE ─────────────────────────────
               *
               * TWO ROWS ON ONE PHYSICAL MAILBOX IS THE ONE STATE THIS DOOR MUST NOT REACH.
               *
               * The address index already forbids two live rows with the same ADDRESS, and that
               * is not the same question: a person can reach one mailbox under two addresses —
               * an alias, a plus-tag, the bare login as against the full address — and every one
               * of those passes the index. What decides whether two rows are the same MAILBOX is
               * the pair the server answered to: host and user.
               *
               * Why it matters more here than on the hosted door: this install writes ONE claim
               * per mailbox into `ohmail/_meta`, all of them carrying this install's id. Two rows
               * over one physical mailbox would write TWO claims with ONE id into ONE folder, and
               * the lease's clone defence reads a second claim bearing its own id as evidence
               * that a copy of this install is running — so the two rows would stand each other
               * down, alternately, for as long as they both existed. Nothing errors; the mailbox
               * simply stops being organized by anybody.
               *
               * COMPARED ON WHAT THE PROBE PROVED, not on what was typed. The body's host may be
               * absent (the probe walks the ladder) or spelled differently from the row's; the
               * credential's `meta` records what actually answered. So the create runs first —
               * it is the only thing that can prove a pair — and the refusal is a read of the
               * result against the rows that were already there. The row it just wrote is removed
               * again on refusal, so a 409 leaves the store exactly as it found it.
               */
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
                /* UNDO THE WRITE. The service committed a row and a credential; leaving them and
                   answering 409 would be a refusal that added a mailbox. Removed through the same
                   shared service that removes any other, so the tombstone, the credential and the
                   appointments are one implementation.

                   WHY THE PROOF COMES AFTER THE WRITE RATHER THAN BEFORE IT: only a dial can say
                   which mailbox a login opens, and the create IS the dial. Probing first to decide,
                   and then creating, would dial the person's own server TWICE for one submit — and
                   the per-address probe admission is two, so the second attempt of somebody who
                   mistyped would be refused by our own budget rather than by their server.

                   WHAT IT LEAVES: a tombstone for an address that was never really connected. That
                   is untidy and inert. A tombstone means "removed, and may be re-added", which is
                   exactly the right thing to say about an address whose add was refused, and there
                   are no mirror rows to wipe because nothing ever synced. */
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

              /* ── AND THE ENGINE BESIDE THE ROW ──────────────────────────────────────────
               *
               * The shared service knows about ROWS. It has no idea that on THIS door a process
               * has to open a connection, hold a lease and run a poll timer for what it just
               * wrote. Attaching here is what makes the answer true: by the time the 201 is
               * returned the mailbox is running, so the pane's first poll finds a live row rather
               * than one that starts working at the next launch.
               *
               * NOT the seed — the seed is the address this process was configured with, and this
               * mailbox is by definition another one. It gets no environment password and no
               * process submission server; its credential is the one the probe just proved.
               *
               * `start()` is deliberately NOT awaited: it connects, may ensure folders and runs a
               * first drain, which on a real mailbox is minutes. The person is waiting on a form.
               * A failure there is logged by the same path a launch failure takes and leaves a
               * connected row whose next poll tries again — which is the documented state for a
               * mailbox that cannot be reached, not a failed add.
               */
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
                    standDownReason: null, takeoverAuthorizedAt: null,
                  },
                  /* ── NEVER THE SEED, AND THIS WAS `isSeedRow(dto.address)` FOR ONE ROUND ────
                   *
                   * The reasoning for asking the predicate was that a mailbox being added cannot
                   * be the configured address because the same-login refusal would have caught it.
                   * IT IS WRONG, and the case is one `identity.ts` documents as expected (its case
                   * 5, "re-add of a removed address through Add mailbox"): the refusal scans rows
                   * with `status <> 'disabled'`, so a TOMBSTONED seed is invisible to it. Remove
                   * the seed while another mailbox remains — no sign-out, so `config.json` keeps
                   * naming it — then add that address again, and `isSeedRow` answered true for a
                   * row whose credential had just been proved against whatever host the person
                   * typed. The runtime would then dial `config.imap`, the STALE settings file, and
                   * `credentialIsForeign` would compare the freshly proven host against it and
                   * withhold the password: a mailbox that had just passed a live probe coming up
                   * dialling nothing, at this launch and every one after it.
                   *
                   * The two answers differ because the two questions do. At BOOT the question is
                   * "which row does the settings file describe", and `isSeedRow` answers it. HERE
                   * the row was made by a request that deliberately does not touch the settings
                   * file, so it is not the seed whatever its address says — and its credential,
                   * which was just proven, is the only honest source for its dial. */
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
            }
          }
          if (localSealMatch) {
            /* -- SEALING THE MAILBOX PASSWORD, ON THE LAUNCH BEARER ------------------------
             *
             * The SERVICE is `MailboxService.update` and the PROBES are the ones the shared
             * `PATCH /mailboxes/:id` injects — `makeImapProbe`/`makeSmtpProbe` over this
             * request's own deps, so they inherit the deadline, the tightened client timeouts
             * and the IMAP admission counter exactly as the hosted door's do. A password that
             * cannot log in is refused HERE, on the form. Anything less would make this the
             * second door into `mailbox_credentials`, and the one that stores a secret nothing
             * has tried.
             *
             * The account comes from the resolved launch session and NEVER from the body — the
             * same rule the consent route states. This install serves exactly one account, so
             * there is nothing for a body to name that would not be a way of naming another.
             */
            const mailboxId = localSealMatch[1]!;
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
              /* ── AND THE RUNNING MAILBOX IS RE-POINTED, NOT LEFT FOR THE NEXT LAUNCH ─────
               *
               * "A password entered AFTER the process is up takes effect on the next launch" was
               * true, and it was tolerable for exactly one reason: the shell REPLACES the engine
               * when the seed's door is reconfigured, so the next launch was seconds away. There
               * is no such gesture for mailbox two. Leaving it would mean a person fixing that
               * mailbox's password watched it stay broken until they quit the app — with the
               * form having told them it was saved, because it was.
               *
               * A detach and a fresh attach is the whole mechanism, and it is deliberately not a
               * mutation of the live runtime: the credential decides the connection, the lease
               * identity, the folder cursors and the sync bag, and re-pointing those underneath a
               * poll that may be mid-cycle is how two connections come to disagree about one
               * mailbox. Detach waits for the in-flight cycle, closes the login and drops the
               * runtime; attach reads the row again from scratch.
               *
               * THE SEED IS LEFT ALONE. Its door still replaces the engine, and doing both would
               * mean an engine tearing down a mailbox a new engine is already starting.
               */
              const live = runtimes.get(mailboxId);
              if (live && mailboxId !== world.mailboxId) {
                try {
                  /* DETACH FIRST, and then the attach may THROW — which used to leave the mailbox
                     with no runtime at all while the log said it "goes on using the connection it
                     already had". It does not: the login is closed and the timer is cleared. The
                     sharper half is that `DELETE /local/mailboxes/:id` now keys on the roster, so a
                     mailbox missing from it is removed WITHOUT releasing its organizer claim or
                     wiping its mail — the phantom organizer and the doubled mailbox, arrived at
                     through a failed password change.

                     The old runtime cannot be revived (its adapter is closed), so the roster entry
                     is restored on failure and the next launch re-attaches it properly. What is
                     lost is the poll until then; what is kept is the roster telling the truth
                     about which mailboxes this install holds. */
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
                      standDownReason: null, takeoverAuthorizedAt: null,
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
            }
          }
          if (localRemoveMatch) {
            /* -- REMOVING A MAILBOX ON A STANDALONE INSTALL
             *
             * `DELETE /mailboxes/:id` is in the shared route table and is `stepUp: true`, and on
             * THIS door that makes it permanently unusable rather than merely guarded. The
             * launch session's second-factor stamp (`lastTwofaAt`) is written ONCE at boot —
             * `identity.ts#mintLaunchSession`, "there is no second factor on a local install" —
             * so `withStepUp` refuses every call from `stepUpWindowMs` (five minutes) after
             * launch for the rest of the process's life. `host-pair-routes.ts` names exactly this
             * shape as the reason its own mints are not `stepUp: true`. The measured consequence
             * was a Settings pane whose Remove button answered 403 forever on a machine that had
             * been open more than five minutes, which is every machine.
             *
             * WHAT PROTECTS IT INSTEAD, and it is the same protection the two routes beside it
             * have: THE PER-LAUNCH BEARER, which is minted at boot, added shell-side, never
             * reaches the window, and cannot be composed by any page. Holding it IS being the
             * person sitting at this machine — which is what a second factor would be evidence
             * of anyway, and is why `mintLaunchSession` says the machine's own login is the
             * step-up on this tier. The bearer is resolved by the same `resolveSession` above,
             * before this branch is reached.
             *
             * ON `handle` ALONE, never `handleHost` or `handleLan`. A phone on the same network
             * must not be able to remove a mailbox from somebody's computer; the separation is
             * structural (those doors route through `desktopHostRoutes`, which has never heard of
             * this path) rather than a check that could be forgotten.
             *
             * The SERVICE is `MailboxService.delete` — the same method the hosted door calls, so
             * the tombstone, the credential deletion and the appointment close are one
             * implementation and not two. This handler is the transport and the outcome.
             */
            const mailboxId = localRemoveMatch[1]!;
            try {
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
              /* -- AND THE ENGINE BESIDE THE ROW, WHICH THE SHARED SERVICE CANNOT REACH ------
               *
               * `MailboxService.delete` is the hosted door's method too. It knows about ROWS: the
               * tombstone, the credential, the appointments. It has no idea that on THIS door a
               * process is holding an open IMAP login to that mailbox, renewing an organizer
               * claim in it every poll, and serving its mirror to the window.
               *
               * All three were measured still running after a removal. The claim was renewed at
               * 08:35:41, 08:36:58 and 08:38:45 after a removal at 08:33:41, by an install whose
               * own status bar said "No mailbox connected, so nothing can arrive" — a phantom
               * organizer, which stands any OTHER install down for the length of the staleness
               * window when the person tries to connect that mailbox somewhere else. The mirror
               * stayed too, and re-adding the same address (a tombstone is correctly not reused)
               * put a second row beside it, after which every message was served twice.
               *
               * ORDER: release, wipe, then stop. The release needs the login the stop closes, and
               * the wipe needs the poll not to be mid-cycle writing rows back in. `serialize` is
               * not taken because `stopped` is what the drain checks and the removal has already
               * committed — a cycle already in flight finishes against a tombstoned row, which
               * every write door refuses on its own.
               *
               * BEST EFFORT, INDIVIDUALLY. The removal has already happened as far as the person
               * is concerned; none of these three may turn it into an error they cannot get past.
               * A failed release costs the next install one staleness window, a failed wipe leaves
               * mail that another removal clears, and both say so on the line.
               */
              /* ── "IF THE ROSTER HOLDS IT", NOT "IF IT IS THE ONE MAILBOX" ────────────────
               *
               * This read `if (mailboxId === world.mailboxId)`, which was the same statement
               * while an install ran exactly one mailbox and is a silent hole the moment it runs
               * two. Removing the SECOND mailbox would match nothing: its claim would go on being
               * renewed in somebody's `ohmail/_meta` by a poll timer nobody stopped, its login
               * would stay open, and its mail would stay in the store — so re-adding the address
               * would serve every message twice, which is the doubling `local-mirror.ts` exists
               * to describe, reached by a different route.
               *
               * The roster is the authority on what this install is actually running, so it is
               * what the question asks. Each act below uses THAT runtime's adapter rather than a
               * captured one: releasing mailbox two's claim over mailbox one's connection would
               * expunge from the wrong mailbox.
               */
              const removed = runtimes.get(mailboxId);
              /* ── WHETHER THE CLAIM IS ACTUALLY OFF THE MAILBOX, CARRIED OUT TO THE PERSON ───
               *
               * `false` means one thing and only one: a release was ATTEMPTED for this mailbox
               * and could not be completed, so this install's claim may still be standing in
               * `ohmail/_meta`. The removal itself has happened either way — it is not abortable
               * by bookkeeping, and none of the three acts below may turn it into an error
               * somebody cannot get past — but "the mailbox is gone from this computer" and
               * "nothing of ours is left holding it against your other machine" are two
               * statements, and only the first was ever made here.
               *
               * That silence is the whole cost of the defect. The person's other install then
               * refuses the mailbox for the length of the staleness window and says only that
               * somebody else organizes it, which is a sentence about a machine that no longer
               * exists. Told, it is a wait with a reason; untold, it is the product being wrong.
               *
               * A mailbox with NO runtime in the roster is not this state: this install is not
               * organizing it, there is no login here to expunge over, and there is therefore no
               * attempt to report the outcome of. That reads `true` — nothing of ours is being
               * left behind by THIS removal — and it is the ordinary case for an already-detached
               * or never-dialled row. */
              let claimReleased = true;
              if (removed) {
                const released = await releaseOwnClaim(
                  removed.adapter, installId, mailboxId, removed.leaseNonce, log,
                  "the claim ages out of ohmail/_meta on its own; until it does, another "
                    + "install connecting this mailbox stands itself down against a claim "
                    + "nothing holds",
                );
                if (released === null) claimReleased = false;
                else if (released > 0) log("organizer_claim_released", { mailboxId, claims: released });
                try {
                  await wipeLocalMirror(db, mailboxId);
                } catch (err) {
                  log("local_mirror_wipe_failed", {
                    err,
                    reason: "this install still holds the removed mailbox's mail; removing the "
                      + "mailbox again clears it, and until then a re-add of the same address "
                      + "shows every message twice",
                  });
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
            /* ── SIGNING OUT FORGETS EVERY MAILBOX'S PASSWORD, NOT THE FIRST ONE'S ───────────
             *
             * This route is the shell signing out of the LOCAL DOOR, and its own contract is that
             * "the credential is the only thing on this machine that a person signing out is
             * asking to be gone". With one mailbox, forgetting the seed's was that. With several,
             * forgetting one leaves the others' sealed passwords on the disk of somebody who just
             * asked to be signed out — and worse: the seed accessor falls back to the OLDEST live
             * runtime when the configured address matches no row, so on an install whose first
             * mailbox was removed it would have deleted a DIFFERENT mailbox's credential and
             * reported a sign-out.
             *
             * So every runtime forgets its own. Answers true if ANY password was there to forget,
             * which is what the shell renders; a failure on one mailbox is not swallowed — the
             * route's own error arm carries it, because a sign-out that half-happened must not
             * report success. */
            const forgotten = await Promise.all(runtimes.all().map((r) => r.forgetStoredLogin()));
            const cleared = forgotten.some(Boolean);
            return new Response(JSON.stringify({ cleared }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          // ── "ORGANIZE FROM THIS MACHINE", THE ROUTE ──────────────────────────────────────
          //
          // The ceremony is `requestOrganizerTakeover`'s and is NOT re-implemented here. This
          // handler is the transport and the outcome, nothing more.
          //
          // IT RECORDS A REQUEST; IT DOES NOT SEIZE. The mailbox is still the authority — the
          // next launch reads the lease first, and an organizer that is actively renewing its
          // claim keeps the mailbox whatever was asked here. That ordering is the reason this
          // can be a button at all: it cannot produce two organizers, only a request to become
          // one.
          //
          // AND IT LEAVES THE ROW STOOD DOWN, WHICH IS THE DIFFERENCE FROM THE CLI. A stand-down
          // set `stopped`, cleared the poll timer and closed the IMAP login; `priorStandDown` was
          // read once at assembly. Undoing all of that from a request handler would mean
          // re-opening a login and restarting the poll loop beside a `serialize` queue already
          // told this install organizes nothing — the shape that produces two organizers on one
          // mailbox. So this process goes on organizing nothing, and the row goes on SAYING so:
          // marking the mailbox `connected` here would advertise one that nothing is organizing,
          // and `ScheduleService`/`SendService` refuse on `status = 'disabled'` and on nothing
          // else, so they would start accepting sends for it in that window. The stamp alone is
          // durable and means exactly what the press means; the engine spends it at its next
          // assembly, which is the CLI's own timing.
          //
          // ── AND SINCE MAIL 0083 THE STAMP IS SPENT ON THE NEXT TICK, NOT THE NEXT LAUNCH ──
          //
          // Every sentence above about "the engine spends it at its next assembly" and "the pane
          // says to quit and reopen" was true of an install that STOPPED when it stood down: the
          // timer was cleared and the login closed, so there was no next tick to spend anything
          // on. A demoted install is now a READER — it keeps its login and its poll timer and
          // goes on cycling — so the gate runs again on the very next poll, reads the stamp, and
          // promotes. No relaunch, and the "quit and reopen" copy is gone from the pane.
          //
          // The rest of the argument stands unchanged and is the reason this still writes only
          // the stamp: the ROW must not claim this install organizes the mailbox before the lease
          // has agreed, because `ScheduleService` and `SendService` read the row.
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
          const result = await requestOrganizerTakeover(db, { mailboxId, now: now() });
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
        return app.handle(req, depsFor());
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
                    if (match.matched || match.methodNotAllowed) return hostApp.handle(req, depsForHost());
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
       * DRAIN EVERY MAILBOX, and answer the TOTAL number of cycles.
       *
       * Summed rather than maxed or first-wins, because the number's one consumer is the
       * question *"did anything happen"* — a caller that ran this and got zero has a settled
       * install, and one that got a number knows work was done somewhere. A per-mailbox answer
       * is `syncMailbox`.
       *
       * The drains run CONCURRENTLY. Each mailbox has its own serial queue, so no two cycles of
       * one mailbox overlap; across mailboxes they may, and the store is built for it — the
       * window is already served during a drain, and the driver runs each transaction through
       * PGlite's own mutex. Running them in series would make a slow mailbox hold up every
       * other mailbox's mail for as long as its backlog takes.
       *
       * `allSettled`, so one mailbox that throws — an expired password, a server that went
       * away — cannot stop the others from draining. The throw is already logged where it
       * happened; what matters here is that the rest of the install keeps working.
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
          releaseRequestedAt: null },
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
      /* Every mailbox, settled, and the results dropped: each cycle logs its own failure and the
         caller's next read of `organizerStates()` is the answer that matters. A refusal here must
         not stop the other mailboxes resuming. */
      resume: async (): Promise<void> => {
        await Promise.allSettled(runtimes.all().map((rt) => rt.resume()));
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
