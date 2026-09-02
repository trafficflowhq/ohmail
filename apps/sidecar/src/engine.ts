import { hostname } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import {
  StaticKeyProvider, kekRingFingerprint, UNMETERED_STORAGE_CAP,
  type KekEnvIdentity, type KeyProvider, type Logger, type OpenSendAdapter, type SendAdapter,
} from "@trafficflow/core/mail";
import { ImapAdapter, buildImapAuth, type ImapConfig, type MailboxAdapter, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
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
  accountSettings, closeStoodDownAppointments, mailboxCredentials, mailboxes,
  // Mail 0083 — the role vocabulary and the machine-name bound. One spelling for the sidecar's
  // gate, the worker's gate and the eleven service write doors; see `db/src/organizer-role.ts`.
  organizerDisplayName, isOrganizerRole,
  type MailboxDisabledReason, type OrganizerRole, type Tx,
} from "@trafficflow/db";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService,
  kbService, runScheduledSendPass, scheduleService, tagsService,
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
  API_VERSION, ALLOW_ANY_PROBE_HOST, createApp, DEFAULT_SSE, localRoutes, makeImapProbe,
  makeSendAdapter, makeSmtpProbe, matchRoute,
  type ProbeDialer, type SmtpProbeOptions,
  type ApiDeps, type ApiServices, type App,
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
  readMailboxLease, releaseMailboxClaim, LeaseUnavailableError,
} from "@trafficflow/worker/lease";
// The APPEND-LESS read, straight from core: an install that has not been asked to organize must
// still be able to say who does, and `runLeaseGate` cannot answer that question without taking
// the mailbox (its empty-folder arm claims). One method, no way to write. See
// `notePreConsentHolder`.
import { readLeasePeek, type LeasePeekIo } from "@trafficflow/core/adapters/organizer-lease";
import { OrganizerProfileSync } from "@trafficflow/worker/profile";
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
import { openLocalDb, type LocalDb, type LocalDbOpenPhase, type OpenLocalDb } from "./db.js";
import {
  ensureLocalWorld, loadLocalRoster, mintLaunchSession,
  type LocalRosterRow, type LocalWorld,
} from "./identity.js";
// ONE RUNTIME PER MAILBOX, held in a map. The record, the map and the seed decision live in
// `roster.ts`; what stays here is the assembly that fills one in and the routes that add and
// remove them. See that file's header for what is per mailbox and what is per install.
import {
  LocalRoster,
  type CredentialState, type LocalMailboxRuntime, type OrganizerState,
} from "./roster.js";
// Removing a mailbox takes this install's copy of its mail with it. See `local-mirror.ts` for why
// this is the sidecar's job and not `MailboxService.delete`'s.
import { wipeLocalMirror } from "./local-mirror.js";
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
 * The two facts that are per MAILBOX rather than per install — whether this machine can open
 * one, and whether it organizes it — live with the runtime that holds them (`roster.ts`), and
 * are re-exported here so every caller that already reads them off this module is unchanged.
 *
 * They moved because an install now answers them N times. A single `CredentialState` for the
 * process was the same statement as the mailbox's while there was one mailbox; with several it
 * would be an answer about whichever one the shell happened to ask about last.
 */
export type { CredentialState, OrganizerState } from "./roster.js";

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
   * THE SAME DIAGNOSTICS, IN THE SHAPE THE SHARED SYNC LOOP SPEAKS — and the reason it exists is
   * that this door was running the loop with `log` UNSET.
   *
   * `@trafficflow/worker/sync` is one implementation serving two hosts. Cloud's composition root
   * hands it a `Logger`; this one built `syncDeps` without one, so every `log?.warn` / `log?.error`
   * in the reconcile passes optional-chained into nothing on the standalone door. What was lost is
   * exactly the set of lines that describe a write the mail server did NOT accept — a refused
   * `STORE`, a `STORE` whose bookkeeping did not commit, a read-state intent with nowhere to go —
   * which is to say: on the one door where the local database is the only other witness, the
   * diagnostics for "your mailbox did not take this" were discarded. A person reporting that a
   * message they marked read stayed unread in their mailbox left no trace at all.
   *
   * A SECOND FIELD RATHER THAN A WIDER `log`, because {@link Diagnostic} is not a widening of
   * `Logger` — it is a narrowing, forced by `readMailboxLease`, and the level it derives from the
   * event name is a claim about THIS package's vocabulary and not the worker's (see
   * `log.ts#createSidecarLogger`). Production builds ONE `createSidecarLogger()` and passes both
   * faces of it, which is what `main.ts` does and what the log census now asserts it does.
   *
   * ABSENT ⇒ the sync loop's own diagnostics are dropped, exactly as they were before this
   * existed. That is the right default for the many tests that compose an engine without a log at
   * all, and it is the wrong one for production — which is why the guard is on `main.ts` rather
   * than on this type.
   */
  logger?: Logger;
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
   * TEST SEAM for the one-click unsubscribe POST — with `fetchImpl` below, one of the exactly
   * TWO ways this process reaches a network that is not the mailbox, and both exist so a test
   * can count what left the machine rather than read the code and believe it. Production passes
   * nothing and gets `nodeOneClickPost`: the pinned, redirect-refusing, body-discarding client
   * the hosted API sends the same request with. The URL it posts to has already passed the same
   * SSRF gate (`assertPublicHttpUrl` over real DNS) — a desktop machine sits INSIDE somebody's
   * home network, so a List-Unsubscribe header naming a LAN address is refused here for the same
   * reason it is refused in Cloud, and unlike the probe's `ALLOW_ANY_PROBE_HOST` this URL is the
   * SENDER'S choice, never the user's own server.
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
   * HOST MODE — this install serves its owner's other devices (Phase 3).
   *
   * Armed, three things exist that otherwise do not: the stdio door gains the window-only
   * pairing mint (`hostPairRoutes` — how the window hands a phone its credential), `/hello` on
   * the stdio door says `pairing: true` so the window can offer the ceremony, and
   * {@link Sidecar.handleHost} exists — the desktop-host door's `Request → Response`, which
   * the loopback listener (`host-listener.ts`, started by `main.ts`) binds and
   * `tailscale serve` publishes.
   *
   * ONLY the exact boolean `true` arms it. Absent — every install that has never heard of host
   * mode, which is every install today — is byte-identical to the pre-host build: no extra
   * routes, no second door, `pairing: false`. An absent config value must never select the
   * dangerous branch; the disarmed composition is pinned by test in both directions. The shell
   * wires this from its host-mode ceremony (a following change); nothing sets it yet.
   */
  hostMode?: boolean;
  /**
   * THE SERVED ORIGIN — `https://<machine>.<tailnet>.ts.net`, the thing `tailscale serve`
   * publishes and a phone's browser therefore SENDS as `Origin` on every mutation. Threaded into
   * the host door's request-guard allow-list, and nowhere else: the stdio door's own auth config
   * is untouched. Without it, armed, the door still exists for the window and for tests driving
   * `handleHost` directly, but the LISTENER refuses to start — a socket whose guard allow-lists
   * only `http://localhost` would refuse every real browser mutation as cross-site.
   *
   * Validated at construction by the same `makeAuthConfig`/`assertOriginConfig` every other door
   * boots through (https, or http on loopback only; one bare absolute origin; a DNS-named host —
   * the MagicDNS name, never the tailnet IP). A value that fails turns host mode OFF for the
   * launch with a surfaced reason (`host_config_invalid`); it can never kill the stdio door.
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
   * THE DESKTOP-HOST DOOR — `Request → Response` over `desktopHostRoutes`, the surface a paired
   * phone reaches. Present IFF host mode is armed; a disarmed install has no second door at all,
   * not a refusing one. It serves the same engine, the same store and the same fresh-deps
   * discipline as {@link handle}, with three composition differences that ARE the door:
   * `/hello` answers `flavor: "desktop-host"`, the window-only surfaces (`/local/*`, the
   * pairing mint) are structurally absent, and the request guard allow-lists the SERVED origin
   * (`SidecarConfig.hostOrigin`) instead of the stdio door's loopback one — a phone's browser
   * sends the MagicDNS origin on every mutation. The loopback listener that binds this is
   * `host-listener.ts`'s, started by `main.ts` from {@link hostState}.
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
   * because this is the composition that knows the data directory. `null` when no LAN address
   * was chosen, or when the identity could not be established (in which case `lanState.reason`
   * says so and the door stays SHUT rather than falling back to cleartext).
   *
   * Two consumers, deliberately one value: `main.ts` serves TLS with it, and
   * `GET /local/lan/pin` hands its fingerprint to the window so the pairing link can carry it.
   * A second reading would be a second chance for the link's fingerprint and the door's key to
   * disagree — which is a pairing that fails at the handshake with nothing to point at.
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
  unsubscribe: UnsubscribeService,
  ai?: LocalAi,
): ApiServices {
  const classifier = ai?.classifier();
  const drafter = ai?.drafter();
  return {
    sync: syncService,
    /**
     * THE SESSION LIFECYCLE OVER THE LOCAL STORE (Phase 3) — the same establish/rotate/
     * revoke machinery Cloud runs, instantiated bare: no ceremony, because this tier has no
     * registration and no factors (the machine's own login is the boundary, exactly the
     * `mintLaunchSession` argument in `identity.ts`), and the base class's hosted hooks answer
     * the local truth — no event table, no throttle, no enrolled factors.
     *
     * WIRED BUT NOT YET CONSUMED: no route in `localRoutes` reads it today. It is what the
     * desktop-as-host door (the next slice) mints paired-device sessions through (`establishPairedDevice`
     * via the device-pair redeem), rotates their bearer pairs with (`/auth/refresh`), and
     * revokes them by (`GET/DELETE /devices`). The launch session itself never touches it —
     * that mint stays `identity.ts`'s, one per launch, deviceId NULL.
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
    mailbox: makeMailboxService({ keyProvider, allowance: UNMETERED_MAILBOX_ALLOWANCE }),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    // The classifier reaches the SUGGEST half only; the read half is constructed without one and
    // could not call a model even through a cast. `credits` stays absent — this tier is free, so
    // there is no allowance to meter and an absent gate means unmetered rather than ungated.
    //
    // NO `unsubscribe` HERE, DELIBERATELY — the automatic screen-out pass stays OFF on this door
    // until its consent surface exists. The engine CAN post (the port is on the bag below, for
    // the user-initiated verb); what is missing is everything around an AUTOMATIC third-party
    // request: the shared client's pre-click
    // disclosure is mode-gated off on this door (`AppShell.autoUnsubscribeDiscloses` requires a
    // consent transport this door does not hand in), and the "switch in Settings turns it off"
    // promise has no local read/write path (`block_auto_unsubscribe_at` has no route here — the
    // `/local/auto-suggest` pattern is the prior art for adding one). Arming the pass without
    // those would send requests to third parties on a gesture whose UI never said it would, with
    // no way to stop it. `landing-mailbox-truth.test.ts` reads this call site: while the pass is
    // unwired the landing copy MUST carry the standalone qualifier, and the day the disclosure
    // and the switch land, wiring `unsubscribe` into this literal flips that guard and takes the
    // qualifier out.
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
    // Send later's two verbs (mail 0077). This process runs its own scheduled-send pass in the
    // local sync loop (the standalone install has no Cloud worker), so an appointment made on
    // this door is kept by this door.
    schedules: scheduleService,
    workflows: workflowsService,
  };
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * THE BUDGET FOR THE HISTORICAL-NAME REPAIR, per drain. See `backfillStoredNames` below.
 *
 * Two numbers rather than one, because they bound different things. The BATCH is how many rows one
 * transaction writes and one header-parse burst covers; the PAGES are how many of those a single
 * drain is allowed before it yields the engine back. Their product — 200 rows — is the whole of what
 * one visit does, and it is a deliberately small fraction of a store that may hold tens of
 * thousands: the repair is cosmetic and the sync it rides on is not, so a visit that finished the
 * job in one go would be trading mail for display names.
 *
 * The batch is HALF the shared default. That default is sized for a server draining a table it has
 * to itself over a network; here the parse, the write and the request handler are one process on one
 * machine, and the cost that matters is the longest single stretch in which the window gets no
 * answer — which is a page, not a run. The parse itself is cheap enough that it is not the reason
 * for either number: a header bag with an encoded word, a quoted name and two recipients takes
 * about a sixth of a millisecond, so a whole visit's worth of them is tens of milliseconds. The
 * write transaction behind it is what a page bounds.
 *
 * At this size a store of fifty thousand historical messages takes a few hundred drains. That is
 * hours of the app being open, spread over as many sessions as it takes, and it is the intended
 * shape rather than a limitation to be tuned away: nothing is broken while it is in progress, the
 * rows simply read as they always have until their turn comes.
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
     * THE LAN DOOR'S KEY — resolved here, once, because this is the composition that holds the
     * data directory, and because the link's fingerprint and the socket's certificate have to
     * come from ONE object or they can disagree.
     *
     * Resolved only when an address was actually chosen: an install that has never turned
     * same-network access on mints nothing and writes nothing, so the ordinary boot is
     * byte-identical to what it was — the same rule the whole LAN half is held to.
     *
     * A refusal DEGRADES the LAN half to off with the refusal's own sentence in `lanState`, so
     * the pane says why. It deliberately does not fall back to a cleartext door: see
     * `maybeStartLanListener`.
     */
    let lanIdentity: LanIdentity | null = null;
    if (lan.address !== null) {
      const outcome = ensureLanIdentity(config.dataDir, log);
      if (outcome.kind === "identity") lanIdentity = outcome.identity;
      else lan = { address: null, reason: outcome.refusal.reason };
    }
    const app = createApp([
      ...localRoutes,
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
     * ONE-CLICK UNSUBSCRIBE — the same service, the same gates, as the hosted API.
     *
     * Constructed ONCE (it only stores its deps) and handed to every per-request bag for the
     * MANUAL verb alone: `POST /messages/:id/unsubscribe`, the user's own explicit act. The
     * screener's AUTOMATIC pass deliberately does not receive it — see the `screener:` entry in
     * `localServices` for why the arm stays off until its consent surface exists. Its three
     * deps, each a deliberate reading of "this is a desktop":
     *
     *  · `post` — {@link nodeOneClickPost}, the pinned redirect-refusing client, or the config's
     *    test seam. This is the second of the process's two non-mailbox egresses (the other is
     *    the user's own model endpoint, `fetchImpl`).
     *  · `resolver` — the REAL `node:dns`, NOT `REFUSING_RESOLVER`: the SSRF gate here protects
     *    the user's own home network from a sender's `List-Unsubscribe` header naming a private
     *    address, and a refusing resolver would refuse every legitimate unsubscribe with it.
     *    The privacy proxy above keeps its refusal — remote CONTENT stays off until the
     *    allow-list lands — but this URL is only ever POSTed to after a screen-out the user
     *    performed, which is the consent the courtesy rides on.
     *  · `trustedAuthservIdsFor` — `providerAuthservIds(config.imap.host)`, the same host string
     *    this process dials, exactly as the sync loop resolves it (`syncDeps` below), so the two
     *    paths cannot disagree about which provider serves the mailbox. Not the drizzle bridge:
     *    this seam HOLDS the config, and the bridge exists for consumers that do not.
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
     * THE SEND TRANSPORT — the SHARED `makeSendAdapter`, resolved per MAILBOX from that mailbox's
     * own credential rows.
     *
     * A hand-written `openLocalSend` stood inside the per-mailbox assembly, and its reason for
     * existing was one sentence: *"the hosted `makeSendAdapter` reads the SMTP host/port from a
     * stored `smtp` credential row, and a local install has neither — its SMTP server is an
     * environment fact, not a stored one"*. That was true of an install with ONE mailbox
     * configured from the process environment, and it stops being true of an install with
     * several: the environment can describe one submission server, and the second mailbox is on
     * somebody else's.
     *
     * The failure it produced if left alone is the sharp kind — silent, and invisible from the
     * sending machine. A reply composed in mailbox two goes out through mailbox ONE's submission
     * server, authenticated with mailbox two's password. Both halves are wrong; the send
     * succeeds; the copy lands in Sent; the only trace is in the receiving server's headers.
     *
     * So the transport comes from the credential rows, which is what the shared implementation
     * has always done: this mailbox's `smtp` row when it has one, its own `imap` host on 587
     * when it does not. One implementation across both doors, and the coordinates are a fact
     * about the mailbox rather than about the process.
     *
     * ── IT IS ENGINE-SCOPED, NOT PER-RUNTIME, AND THAT IS NOT AN OVERSIGHT ──────────────────
     *
     * `OpenSendAdapter` takes the mailbox id, and the shared implementation resolves everything
     * else from it. There is nothing left for a per-runtime copy to close over — one function
     * answers for every mailbox, which is also why the send route needs no knowledge of the
     * roster.
     *
     * ── WHAT GOES WITH THE OLD PATH ─────────────────────────────────────────────────────────
     *
     * The three `foreign-host` sentences it raised on the OUTGOING side. They compared the
     * credential's recorded submission host against the one the PROCESS was configured for, and
     * there is no process-wide submission host to compare against any more — the row is now the
     * only statement of where a mailbox submits, so it cannot disagree with itself. The INCOMING
     * comparison is untouched and still gates the launch: `credentialIsForeign` is what stops a
     * password proved against one server being offered to another, and that question still has
     * two sides.
     *
     * The factory seam is threaded through so a test can observe WHICH server a send dialled.
     * Against a server that accepts every login — which is what a test server is — that is the
     * only way to tell a correct send from the defect above.
     */
    /**
     * THE PROBE SEAM, threaded from the same place the sync adapter takes one.
     *
     * A probe IS a dial — it opens a login against the server a person just typed and refuses a
     * password that cannot use it — so an install configured to dial through a double must dial
     * the probe through it too. Without this the local door would be the one path in this process
     * that reaches a real socket regardless, which is the opposite of what the seam is for.
     *
     * PRODUCTION IS UNAFFECTED: `config.adapterFactory` is absent there and both probe factories
     * fall through to their own default, which is a real `ImapAdapter`.
     */
    const probeOpts = config.adapterFactory
      ? { adapterFactory: (cfg: ImapConfig) => config.adapterFactory!(cfg) as unknown as ProbeDialer }
      : {};
    /**
     * …AND THE SUBMISSION LEG, on the same condition and for the same reason.
     *
     * A mailbox has two servers and adding one probes both. Intercepting the incoming dial and
     * leaving the outgoing one to open a real socket would make `adapterFactory` a half-seam: an
     * install told to dial nothing would still reach a submission server, and the create it was
     * asked to perform would fail on the leg nobody intercepted.
     *
     * The double resolves an EMPTY proof rather than a fabricated one — `undefined` is the
     * documented "nothing was learned" answer on this seam, and inventing an announced SIZE would
     * be putting a measurement into the store that no server made.
     *
     * PRODUCTION IS UNAFFECTED: with no factory this is `{}` and the probe dials for real.
     */
    const smtpProbeOpts: SmtpProbeOptions = config.adapterFactory
      ? { dial: async (): Promise<void> => undefined }
      : {};
    const openLocalSend: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
      /* ── THE BOOT CONTRACT REACHES THE SEND PATH, AND IT HAS TO ─────────────────────────────
       *
       * The INCOMING comparison gates the launch: a credential proved against one server is not
       * offered to another, so a mailbox in that state dials nothing and the person is told which
       * settings to settle. A SEND is a dial like any other, and it runs on its own fresh
       * connection built straight from the credential rows — so without this it would go on
       * offering the password while the launch that owns that mailbox was refusing to, which is
       * the same secret reaching a server nobody settled on, through the one door that does not
       * consult the gate.
       *
       * It used to hold by construction: the deleted local sender resolved the credential through
       * the same `resolveLogin` the launch used, and inherited the refusal. The shared adapter
       * reads the rows directly and knows nothing about what this process was configured for, so
       * the check is made here — at the seam that knows both.
       *
       * ONLY THE INCOMING ARM. The outgoing one is gone with the design that produced it: there is
       * no process-wide submission host any more, so a credential cannot disagree with one. And
       * only for a mailbox this install is actually RUNNING — a send for a row with no runtime
       * has no configuration to be measured against, and refusing it would be inventing a
       * disagreement out of an absence. */
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
            (cfg: ImapConfig) => config.adapterFactory!(cfg) as unknown as ImapAdapter)
        : makeSendAdapter(depsFor(), mailboxId);
    };

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
      services: localServices(authConfig, keyProvider, openLocalSend, unsubscribe, ai),
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
      /**
       * What `GET /hello` answers — this install's capability statement, on `health`'s
       * injection pattern. `flavor: "local"` is what a client's server picker reads to learn it
       * is talking to a desktop engine rather than a server.
       *
       * The auth block is all-false and that is the truth, not a gap: this process mints one
       * session per launch for the shell that spawned it, so there is no sign-in ceremony to
       * offer a caller — the machine's own login is the boundary, and `needsSetup` is `false`
       * for the same reason (the world is created at first boot, not through a setup page).
       * `ai` is per-request honest because this whole container is rebuilt per request: it says
       * whether THIS install has a verified model right now, the same fact that decides whether
       * `services.drafter` exists a few lines above.
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
          // THE HOST-MODE ARM, truthfully. This stood as "FALSE FOR GOOD" while the pairing
          // ceremony was the standalone server's alone; Phase 3 falsified that sentence, and it
          // is rewritten in the same commit that mounts anything. Armed, this door carries the
          // window-only MINT (`host-pair-routes.ts` — the window hands a phone a credential;
          // there is still no INVITE arm here and nobody to register), so the descriptor says
          // so and the window can offer the ceremony. Disarmed — the default, and every install
          // that has never heard of host mode — nothing is mounted and this stays `false`:
          // `localRoutes` itself never carries `/pair*` (the census in the API package's
          // `hello.test.ts` still pins that), the mount is this composition's own, and both
          // readings of this line are pinned — disarmed in the sidecar's hello suite, armed in
          // its host-mode suite — so neither composition can lie about the ceremony.
          pairing: hostMode,
        },
      },
    });
    /**
     * THE HOST DOOR'S AUTH CONFIG — the served MagicDNS origin, threaded into the request
     * guard's allow-list. This discharges the obligation recorded here when the door first
     * landed: with `depsFor`'s
     * loopback config, an Origin-carrying mutation from a real phone browser (whose origin IS
     * the machine's tailnet name — that is what `tailscale serve` publishes) was refused by
     * `withRequestGuard` as cross-site, and the listener suite captured exactly that red before
     * this line existed. Built through the same `makeAuthConfig`/`assertOriginConfig` every
     * other door boots through (`resolveHostConfig`); when no origin is configured the door
     * keeps the stdio config — nothing browser-shaped can reach it, because the LISTENER
     * refuses to start without the origin (`maybeStartHostListener`).
     */
    const hostAuthConfig = hostConfig.authConfig ?? authConfig;
    /**
     * IS THE WHOLE ENGINE SHUTTING DOWN? — one flag for the install, distinct from any one
     * mailbox's.
     *
     * The account-scoped passes below used to yield on the single mailbox's `stopped`, which was
     * the same statement while there was one mailbox and is not any more. `stopped` means "this
     * MAILBOX is gone" — it is set when a mailbox is removed, and when a launch discovers mid-flight
     * that it was — and neither of those is a reason for the install's own name repair to stop
     * walking rows that belong to the other mailboxes.
     *
     * What the yield is actually for is `stop()`: a quitting engine must not open a transaction it
     * may not finish. That is this flag, and only `stop()` sets it.
     */
    let stopping = false;
    /**
     * ONE ACCOUNT-SCOPED PASS AT A TIME ACROSS THE WHOLE INSTALL.
     *
     * The passes below take an account and no mailbox. Every runtime's drain reaches them, and
     * drains of different mailboxes deliberately overlap — so without this each of them would run
     * N times at once over the same rows. Two of them keep a WALK POSITION in memory
     * (`namesCursor`, `joinHealCursor`), and a walk position shared by two concurrent walkers is
     * last-writer-wins: the cursor can move backwards, and the same page is scanned twice while
     * the tail is never reached.
     *
     * A single-flight join rather than a queue: a second drain arriving while one of these is in
     * flight does not need its own run, it needs the work to have been done — so it awaits the run
     * already going and returns. That is also why nothing here is per-mailbox fair; there is one
     * account and the answer is the same for every caller.
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
     * WHO THIS INSTALL IS, to the organizer lease — one identity for the machine, whatever number
     * of mailboxes it holds.
     *
     * The full argument is at the lease's own banner further down, and none of it changes here:
     * the id has to survive a crash, a reboot and a long sleep, and it has to differ between two
     * installs on two machines, which is exactly what the one `accounts` row per data directory
     * already is.
     *
     * What multi-mailbox adds is the reason it must be hoisted to THIS scope rather than resolved
     * per runtime: an install that claimed each of its mailboxes under a different id would look
     * to itself like several installs, and its own second mailbox would read its first one's claim
     * as a stranger's. One install, N claims, all carrying this id.
     */
    const installId = world.accountId;
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
    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE INSTALL'S OWN PASSES — account-scoped, and therefore NOT per mailbox
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // Everything below this banner and above the next one takes an ACCOUNT and no mailbox:
    // the Ohbox posture and the screening window, the resurface flip, the Screener's
    // suggestion pass and the historical-name repair. They read and write rows that belong to
    // the install rather than to one server and one login, so an install running several
    // mailboxes must run each of them ONCE per drain and not once per mailbox — the same scan
    // repeated per row would cost N times as much and answer the same question N times.
    //
    // They moved above the per-mailbox assembly rather than staying interleaved with it so
    // that the boundary is a place in the file rather than a fact a reader has to reconstruct
    // from each function's arguments. Nothing about them changed in the move except the flag
    // the name repair yields on — see `stopping`.

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
    const screeningNow = async (): Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff">> => {
      try {
        const [row] = await db.select({
          policy: accountSettings.ohboxPolicy, bar: accountSettings.ohboxBar,
          // ── THE WINDOW, WHICH THIS DOOR DID NOT HAVE (mail 0083) ──────────────────────
          //
          // Before this line `apps/sidecar/src/engine.ts` contained zero occurrences of
          // `screeningCutoff`, `dormancy` or `screeningBaseline` — so the standalone install,
          // which is the free tier and the funnel and the door most people meet first, screened
          // EVERY backfilled message regardless of age. A person with a decade of mail got a
          // decade of it moved into `ohmail/Screener`, one physical IMAP move at a time, into a
          // queue nobody was going to empty. The hosted worker has resolved this per cycle since
          // mail 0056 (`index.ts#screeningFor`); this is the same three columns, the same
          // resolver, and deliberately the same shape so the two cannot drift.
          //
          // `consentRoutes` are mounted on `localRoutes` in the same commit, which is the other
          // half: without them there is no way to READ or WRITE the dial this reads, and a
          // cutoff resolved from columns no surface can set is a window nobody can choose.
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
     * SUGGEST FOR THE SENDERS THAT JUST ARRIVED — "continuously", on a door that only runs while
     * its window is open.
     *
     * The hosted service does this from an always-on worker cycle. A standalone install has no
     * such process, by design and not by omission — this engine runs while the app is open and
     * stops when it quits — so the honest reading of "continuously" here is **at the tail of a
     * drain**: the moment mail has just been brought in is the only moment this install can have
     * new held senders, and it is also the only moment it is awake.
     *
     * ── LAUNCH CATCH-UP NEEDS NO SECOND HOOK, AND THAT IS A FACT ABOUT THIS DOOR ─────────────
     *
     * The obvious second trigger would be "on launch, catch up on what arrived while we were
     * closed". Nothing arrives while this app is closed — no process is syncing — so there is
     * nothing of that kind to catch up on. What a launch CAN owe is a pass a quit interrupted
     * half-way, and that resumes for free: progress is the stored suggestion, so the candidate
     * query simply starts at the next unbought sender. `start()` runs a drain, this runs at its
     * tail, and the catch-up is that same call rather than a special case that would need its own
     * bounds and its own test.
     *
     * ── IT IS THE WORKER'S PASS, NOT A COPY OF IT ────────────────────────────────────────────
     *
     * `@trafficflow/worker/screener-auto-suggest`, for the reason `bubbleUpPass` above is the
     * worker's: the watermark, the per-pass cap and the representative-per-sender ordering all
     * have to agree character for character with what the Screener surface shows, or a suggestion
     * is stored against a message the row on screen is not about. Two implementations of that
     * agree until the day one of them is edited.
     *
     * ── WHAT DIFFERS ON THIS DOOR, AND WHAT DOES NOT ─────────────────────────────────────────
     *
     * `credits` is ABSENT and `unmetered: true` is DECLARED. This tier has no ledger: the model is
     * the installer's own key or their own machine, which is exactly what `localServices` says
     * about `aiCredits`. The declaration is required rather than inferred from the absence — see
     * that field's own note — so a wiring mistake here is a pass that does nothing rather than one
     * that spends unmetered.
     *
     * The other two bounds are unchanged. The WATERMARK is `account_settings.auto_suggest_at` on
     * this machine's store, written by `PUT /local/auto-suggest` and by nothing else on this door,
     * so turning the switch on never reaches back over a mailbox that was already synced. The CAP
     * is the pass's own page, and it earns its place here for one case rather than for every
     * drain: a first sync after the switch was turned on, where the screening baseline window can
     * present many senders at once.
     *
     * The third bound — first refusal stops the pass — is the CLASSIFIER's here rather than the
     * ledger's. `classifierForCycle()` is the same seam the sync loop uses, withheld after
     * repeated faults with a growing cooldown, and the pass stops on its first throw. So a model
     * server somebody quit costs one call on this drain and none on the next several.
     *
     * ── COST WHEN IT IS OFF, AND WHEN IT IS ON ──────────────────────────────────────────────
     *
     * OFF (the default) with no model: nothing at all — the port is absent, so the pass returns
     * before it reads anything. OFF with a model: one indexed PK read per drain. ON: at most one
     * model call per NEW held sender, ever, because the stored suggestion is the progress marker
     * and the candidate query excludes it. That is strictly fewer calls than the drain it rides
     * on already makes, since the pipeline classifies each new MESSAGE while this asks about each
     * new first-contact SENDER.
     *
     * A failure is CONTAINED, exactly as `resurfaceDue`'s is: suggestions are one feature and mail
     * arriving is another.
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
     * FILL IN THE SENDER NAMES AND RECIPIENTS OF MESSAGES STORED BEFORE THERE WAS ANYWHERE TO PUT
     * THEM — a one-time repair of this install's own store, spread over as many visits as it takes.
     *
     * ── WHAT IS WRONG WITHOUT IT ─────────────────────────────────────────────────────────────
     *
     * `messages.from_name` went in after the messages that need it, and until it existed the reader
     * was handed a bare address for every sender. `to_addresses` and `cc_addresses` are the same
     * story from the other end: the columns were there, nothing wrote them, so a message showed no
     * "To" line at all. New mail has been stored complete since; the rows already on disk were left
     * as they were, and they are the mail somebody actually has.
     *
     * A hosted account's rows were repaired in the hosted database, and every mirror above it —
     * including the Cloud door of this app — learned the corrected values as ordinary `/sync`
     * deltas, because that repair emitted a change per row it touched. A STANDALONE install shares
     * none of that: the store under the user's home IS the authority, no process anywhere else has
     * ever seen it, and nothing was ever going to reach it. So this door runs the repair itself.
     *
     * ── WHY IT IS THE SAME PASS ──────────────────────────────────────────────────────────────
     *
     * `@trafficflow/worker/sender-name-backfill`, for the reason `bubbleUpPass` and
     * `screenerAutoSuggestPass` above are the worker's. What this writes is what INGEST would have
     * written from those same headers, and ingest's parse handles RFC 2047 encoded words, quoted
     * names containing commas and headers folded across lines. A second parse would produce a
     * second population of rows decided by different rules, and the two would be indistinguishable
     * afterwards — you cannot tell a name that was parsed wrongly from one the sender wrote.
     *
     * ── THE BUDGET, AND WHY THIS NEEDS NO STATE TO RESUME ─────────────────────────────────────
     *
     * {@link LOCAL_NAME_BACKFILL_PAGES} pages of {@link LOCAL_NAME_BACKFILL_BATCH} rows per visit,
     * then it yields. A big store therefore takes many drains and quite possibly several sessions,
     * which is the intended shape: the mail is what the drain is for and this is cosmetic.
     *
     * Nothing new is tracked. The pass only ever writes a column that is unset and repeats that
     * predicate in its UPDATE, so a row it has done is not a candidate the next time and a row it
     * has not is — the store's own contents are both the progress marker and the completion state,
     * and a quit at any moment costs at most the visit that was in flight.
     *
     * `namesCursor` is NOT that state and does not need to survive anything. It is a position in
     * one launch's walk, and it exists because a row can be a permanent candidate: a sender who set
     * no display name leaves `from_name` NULL for ever, correctly, and a message addressed to
     * nobody leaves `to_addresses` empty for ever. Those rows sit at the front of the ordering and
     * accumulate, so a visit that always started at the beginning would spend a growing share of
     * its budget re-reading rows it has already correctly decided to leave alone — and on a large
     * store it would eventually spend ALL of it and stop making progress, silently, having done
     * exactly the right thing with every row it looked at. Carrying the position forward within a
     * launch is what keeps each visit's budget spent on rows nobody has looked at yet. A relaunch
     * starts at the beginning again, which costs one cheap re-walk and is also how a row lost to a
     * competing writer comes back into view.
     *
     * `namesDone` is the other half: once a walk reads a page with nothing after it, this launch is
     * finished, and every later drain returns before touching the database. Without it a repaired
     * store would pay a full scan for nothing every poll interval, for as long as the app is open.
     *
     * ── THE WINDOW SEES IT WITHIN THE SESSION, WHICH IS WHY THE CHANGE LOG IS NOT DEAD WEIGHT ─
     *
     * The pass emits one `message` update per row it writes. On this door that is not a note for
     * some remote mirror — the window's own view IS a mirror, fed by `/sync` off this store through
     * the same service Cloud serves, and it upserts the whole message projection per change. So a
     * name filled here repaints the list in the same session instead of at the next launch. The
     * rows cost one sequence allocation per page and would be needed anyway the moment this install
     * is ever read by anything else.
     *
     * A failure is CONTAINED, exactly as the two passes above are: display names are cosmetic and
     * mail arriving is not. The next drain simply asks again.
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
     * ATTACH ONE MAILBOX — everything this install does with one server and one login.
     *
     * The body below is what `createSidecar` used to do to its only mailbox, unchanged in
     * substance and now parameterised by the row it is doing it to. It resolves that row's
     * credential, opens its connection, holds its lease, runs its poll timer and its serial
     * queue, and hands back the runtime the roster keeps.
     *
     * The install's own passes are NOT in here — see the banner above them. They take an
     * account and no mailbox, so they are resolved once and shared by every runtime.
     */
    /**
     * The HOST DOOR's per-request container — {@link depsFor} with the three differences that
     * ARE the door:
     *
     *  · the DESCRIPTOR. `flavor: "desktop-host"` is what a server picker switches on;
     *    `pairing: true` is this table's truth (the redeem is mounted; the mint is the
     *    window's); `sse: false` is honest until the follow-up the ruling names; `ai` states
     *    whether THIS install has a verified model, same as the stdio door.
     *  · the AUTH CONFIG — {@link hostAuthConfig}, above. The service bag is rebuilt with it so
     *    the session lifecycle and the guard read ONE config, not two.
     *  · the SEND SURFACE. The stdio bag declares `sendSurfaceMaxTotalBytes: null` — compose,
     *    handler and SMTP dial are one process, no request body between them — and on THIS door
     *    that fact is false: a phone's send rides an HTTP body through the loopback adapter, so
     *    the door declares the ceiling its transport actually has
     *    ({@link HOST_SEND_MAX_TOTAL_BYTES}, sized under the adapter's byte cap — the
     *    derivation is `host-listener.ts`'s header). `effectiveAttachmentCap` still takes the
     *    smaller of this and the mailbox's own announced SIZE.
     *
     * `allowCookieAuth: false` rides in from `depsFor` — the door NEVER mints, reads or clears
     * a cookie, and the API package's zero-Set-Cookie census sweeps the whole table on exactly
     * that flag.
     */
    const depsForHost = (): ApiDeps => ({
      ...depsFor(),
      authConfig: hostAuthConfig,
      services: {
        ...localServices(hostAuthConfig, keyProvider, openLocalSend, unsubscribe, ai),
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

    const attachLocal = async (mb: LocalRosterRow, isSeed: boolean): Promise<LocalMailboxRuntime> => {
      /**
       * ══ WHAT THIS MAILBOX DIALS ═══════════════════════════════════════════════════════════
       *
       * `config.imap` — the `OHMAIL_IMAP_*` the shell set — used to be THE configuration of THE
       * mailbox. It is now the SEED's, and only until that mailbox's credential records what a
       * probe actually proved. Every other mailbox dials from its own `imap` credential row's
       * `meta`, which is where the hosted worker has always read it from and where this door
       * already reads it for an attachment fetch.
       *
       * The alternative — one process-wide server for N mailboxes — is not a smaller version of
       * this; it is wrong in a way nothing surfaces. Mailbox two would be dialled at mailbox
       * one's host with mailbox two's password: a login failure if you are lucky, and if the two
       * happen to share a provider, a successful login to the WRONG ACCOUNT.
       *
       * ── THE SEED'S FALLBACK, AND WHY IT IS NARROW ────────────────────────────────────────
       *
       * On a first launch the seed has no credential row yet — the password is still in this
       * process's environment and the seal below is what writes it down. So the seed, and only
       * the seed, falls back to `config.imap`. Once its row exists, and once the boot's backfill
       * has put `host/port/secure/user` on a row sealed before anything recorded them, the seed
       * reads from the row exactly like every other mailbox and this fallback is unreachable.
       *
       * A NON-seed row with no credential is a mailbox awaiting a password — the state
       * `POST /local/mailboxes` never produces (it probes before it writes) but a removal race or
       * a half-finished flow can. It gets its own address and no server, which resolves to a
       * launch that dials nothing and serves the mirror: the documented no-password state.
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
      /* ── THE SEED DIALS WHAT IT WAS CONFIGURED FOR, AND THAT IS THE BOOT CONTRACT ────────
       *
       * This read `isSeed && !dialMeta?.host`, so a seed whose credential recorded a host dialled
       * THE CREDENTIAL'S host and ignored the configuration. It looks like the multi-mailbox rule
       * applied evenly, and it silently disables the incoming boot contract: the comparison below
       * is `credentialIsForeign(row.meta, mbImap.host)`, and with both sides taken from the same
       * row it compares the credential against ITSELF and can never disagree. A launch pointed at
       * a new server would go on dialling the old one for ever, with the password, and say
       * nothing — while the whole point of that contract is to dial NOTHING and tell the person,
       * because a half-finished change of server is exactly when a secret must not be offered.
       *
       * So the SEED's dial is the configuration the shell set — what the person chose — and the
       * comparison stays a real comparison. Mailboxes #2..N have no configured server to disagree
       * with: their row is the only statement of where they live, so the same predicate compares
       * a host against itself and correctly never withholds. One rule, two honest answers. */
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
         * ── THE DELETE AND ITS PROOF ARE ONE TRANSACTION, AND THE PROOF IS A READ ─────────────
         *
         * This issued the DELETE, logged `stored_login_cleared` and answered 200 without ever
         * asking whether the row was gone, so a delete that removed nothing read exactly the same
         * from outside as one that worked — and the shell, seeing the 2xx, went on to stop the
         * engine and remove `config.json`, with its own refusal arm never reached.
         *
         * So the row is deleted and READ BACK inside one transaction. A row that survives makes
         * this THROW, which is what turns the shell's "the engine refused" arm from a comment
         * into a path.
         *
         * ── WHAT THIS DOES *NOT* FENCE, SAID PLAINLY ──────────────────────────────────────────
         *
         * The `FOR UPDATE` makes a competing credential write serialize against this transaction;
         * it does not stop that write COMMITTING IMMEDIATELY AFTER it. A `PATCH /mailboxes/:id`
         * that has already probed a replacement password and is waiting on the row will resume the
         * moment this commits and insert the sealed password again — after the 200 has gone back,
         * so the shell removes the configuration and reports a sign-out over a credential that is
         * once more in the database.
         *
         * Closing that needs what account erasure has: a durable signed-out stamp every credential
         * writer reads under the same lock and refuses on (`services/src/erasure-fence.ts` is the
         * pattern). That is a change to the SHARED mailbox service, not to this closure, and it is
         * ledgered rather than half-done here — a fence that only narrows the window would read
         * like one that closes it. Precondition: a credential write in flight at the moment of a
         * sign-out, on a single-user desktop.
         */
        const had = await db.transaction(async (tx) => {
          const before = await tx.select({ mailboxId: mailboxCredentials.mailboxId }).from(mailboxCredentials)
            .where(and(
              eq(mailboxCredentials.mailboxId, mb.id),
              eq(mailboxCredentials.transport, "imap"),
            ))
            .for("update");
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
        log("stored_login_cleared", {
          mailboxId: mb.id,
          state: had ? "removed" : "absent",
          reason: "the sealed mailbox password was removed from this install and read back as " +
            "absent; the mirror and the mailbox on the user's own server are untouched",
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
       *
       * ── THE BOOT CONTRACT — THE ONE COMPARISON, AND WHY IT LIVES HERE ────────────────────────
       *
       * A sealed credential is a password PROVED AGAINST ONE SERVER, and this is the single place
       * that decides whether the current launch may have it. Both ways the mismatch is reachable
       * end here, which is why one comparison closes both rather than two fences closing one each:
       *
       *  · THE BOOT. `start()` resolves this once and hands the result to the adapter it builds
       *    (`login.state !== "ready"` is what stops the dial), so an install that comes up
       *    configured for one server holding a credential proved against another serves its mirror
       *    and authenticates to nothing. That is the case a CRASH leaves behind — between the
       *    door's seal and the `engine_configure` that follows it, the credential names the new
       *    host and the settings still name the old one, and a process that dies there has nobody
       *    to tell.
       *  · THE SEND. `openLocalSend` resolves this AFRESH for every send while holding the SMTP
       *    coordinates the process booted with, so a send racing that same interval would offer the
       *    new server's password to the old server's SMTP. Nothing in the door can prevent it — the
       *    door is a modal over the whole app, but a scheduled send fires on the engine's own timer.
       *
       * BEFORE THE DECRYPT, DELIBERATELY. The comparison needs no key, so a credential this engine
       * has no business using is never brought into memory as plaintext at all. It also settles the
       * precedence between this and `unreadable` in the right direction: a row that is both foreign
       * and unopenable is reported as foreign, because that is the fact the person can act on and
       * the other one would send them to re-enter a password into the wrong server.
       *
       * NO ENVIRONMENT FALLBACK, unlike `unreadable`. `pass` is `null` outright. Carrying a
       * password beside a state that forbids using it is the same half-state this contract exists
       * to remove, and it costs nothing real: an install with no stored row never reaches this
       * branch, and the desktop shell has no route for a password in the environment at all.
       *
       * ── THE OUTGOING SERVER IS THE CALLER'S QUESTION TO ASK, NOT THIS FUNCTION'S ──────────────
       *
       * A mailbox has two servers and the reconfigure that moves only the OUTGOING one leaves this
       * comparison satisfied: the incoming host still agrees, so the launch is `ready`, and the send
       * transport is then built from whatever submission coordinates the process booted with. That is
       * the same defect one server over, and it ends here too — but only for callers that are about
       * to submit.
       *
       * `smtpHost` is therefore OPT-IN. `start()` and the shell's credential state do not pass it,
       * deliberately: a mailbox whose outgoing server moved still receives mail perfectly, and
       * refusing the launch would stop somebody's mail arriving in order to fence a send they may not
       * be making. `openLocalSend` passes it, because that is the one place the password meets a
       * submission server.
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
         * WHICH COMPARISON FAILED RIDES OUT WITH THE STATE, and it is load-bearing rather than a
         * convenience. `foreign-host` is one state with two causes, and the send path has to say
         * which in words a person can act on: told the OUTGOING server is wrong when the incoming one
         * moved, they would go and change a setting that was already right, and following the
         * instruction cannot recover the install. A true sentence about the wrong server is the exact
         * failure this whole seam exists to end, so it must not be reintroduced by the fence that
         * closes it.
         *
         * The shell is not given this. It renders the state, and the state's meaning there is the
         * boot's — see {@link CredentialState}.
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
             * AND THE SUBMISSION HOST THIS PASSWORD IS BEING SEALED FOR — the outgoing half of the
             * same record. One password covers both transports, so the person who supplied it named
             * both servers, and this is the only place that fact is written down: the send path reads
             * its coordinates from the running configuration, which can be changed without touching
             * the credential at all.
             *
             * OMITTED, NOT EMPTY, when this launch has no submission server configured — and this
             * is the ONE place that differs from the door, deliberately, so the difference is stated
             * rather than left to look like an oversight.
             *
             * An empty value is a STATEMENT that no outgoing server is authorized, and the door can
             * make it because a door submit is a complete statement about a pair that the person can
             * make again. This seal is a BOOTSTRAP from an environment: it runs only when a password
             * arrives in this process's own configuration, which is the self-hosted path, and there
             * the outgoing server is a variable an operator may legitimately add later with no door
             * to re-save through. Writing "none authorized" here would refuse every send after that
             * addition, with the recovery being a request this operator has no surface for. So the
             * key is simply absent, which means "this row says nothing" — the same tolerance every
             * credential sealed before the key existed relies on.
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
       * connect when there is none.
       *
       * ── "TAKES EFFECT ON THE NEXT LAUNCH" IS RETIRED, AND THE MECHANISM IS NOT MUTATION ────
       *
       * This said a password entered after the process is up takes effect on the next launch, and
       * justified it by the shell's own flow: reconfiguring the local door REPLACES the engine, so
       * the next launch was seconds away. That justification covers the SEED and nothing else.
       * There is no engine replacement for a mailbox added from Settings, so leaving it would mean
       * a person fixing that mailbox's password watched it stay broken until they quit the app —
       * with the form having told them it was saved, because it had been.
       *
       * What changed is not this line: the credentials are still immutable underneath a running
       * sync loop, for exactly the reason given here. `PATCH /local/mailboxes/:id` DETACHES the
       * runtime and attaches a fresh one, so the new password takes effect through a new
       * connection rather than by re-pointing a live one — which is the same guarantee, reached
       * without making a connected socket's credentials mutable.
       */
      const imapConfig: ImapConfig = { ...mbImap, auth: { user: mbImap.auth.user, pass: login.pass ?? "" } };
      const adapter = config.adapterFactory ? config.adapterFactory(imapConfig) : new ImapAdapter(imapConfig);
      const syncDeps = {
        repo, adapter, accountId: world.accountId, mailboxId: mb.id,
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
      /**
       * ── A REQUEST FROM SETTINGS OVERRIDES THE ROW'S MEMORY, AND CHANGES NOTHING ELSE ───────
       *
       * `requestOrganizerTakeover` (the "Organize from this machine" button) writes ONLY the
       * stamp and deliberately leaves the row `disabled` with its reason — see its header. The
       * stamp is what this line reads, and all it does is stop the gate SHORT-CIRCUITING: with a
       * request outstanding, the lease is consulted, which is the one thing that can decide.
       *
       * ── THE ROW IS NOT CLEARED HERE, AND THAT IS THE SECOND ROUND'S CORRECTION ────────────
       *
       * It was, for one round: the stand-down was cleared at assembly, on the argument that this
       * is the CLI's own timing (the CLI needs the app stopped, so nothing serves in between).
       * The argument was wrong about THIS process. `main.ts` announces the bridge and calls
       * `start()` asynchronously, and `start()` returns before the gate when no password is
       * stored — so a row cleared here is a `connected` mailbox served to requests before any
       * lease has been read, and for the whole life of a passwordless launch. `ScheduleService`
       * and `SendService` refuse on `status = 'disabled'` and on nothing else, so that window
       * accepts sends for a mailbox another organizer may still hold.
       *
       * So the clear moved to where the answer is: `mayOrganize`'s ORGANIZE arm, which runs only
       * after `readMailboxLease` has said yes. Until then the row goes on saying it is not
       * organized here, every surface goes on telling the truth, and nothing may send. If the
       * lease refuses, the stand-down arm rewrites the row and voids the stamp, and the person is
       * told which install kept it.
       */
      /* ── THIS MAILBOX'S OWN MEMORY, NEVER THE SEED'S ─────────────────────────────────────
       *
       * These five were read off `world`, which is the SEED's row, and that was the same statement
       * while an install held one mailbox. With several it is three separate faults, all silent:
       *
       *  · the seed stood down and #2 did not → #2 comes up believing it was demoted, never
       *    organizes the mailbox it holds, and never keeps its own appointments;
       *  · #2 stood down and the seed did not → #2 comes up with NO memory of it and re-claims the
       *    mailbox it was demoted from on its next lease read. That is the auto-resume this memory
       *    exists to prevent, and it is the one that moves somebody's mail;
       *  · a takeover press on ANY mailbox authorized EVERY runtime, so an unrelated mailbox could
       *    seize the organizer role and then void a stamp belonging to another row.
       *
       * `loadLocalRoster` already reads both per row, and `identity.ts` states why in as many
       * words. The values were computed and dropped. */
      const takeoverRequested = mb.takeoverAuthorizedAt !== null;
      /**
       * THE STAND-DOWN THIS PROCESS REMEMBERS — and it is a `let` because the process now OUTLIVES
       * the stand-down that sets it.
       *
       * It was a `const` read once from the row, which was exactly right while a demoted install
       * STOPPED: the timer was cleared and the login closed, so the next reader of this value was
       * the next launch, and the row it read was the record. Mail 0083 made the loser a READER —
       * connected, poll timer running — and that turns a snapshot into a hole. The gate stands down
       * mid-life, the poll fires a minute later, `priorStandDown` is still the NULL it was at
       * assembly, and the gate reads the lease again; find the foreign claim gone (the other
       * organizer released cleanly, so `ohmail/_meta` is empty) and `decideLease`'s "nobody has
       * ever organized this mailbox" arm ORGANIZES. That is the auto-resume this whole mechanism
       * exists to prevent, reached without any human action, on a machine somebody left running.
       *
       * So the two arms of the gate maintain it: standing down writes the memory, and the promotion
       * — which only ever runs behind an explicit press — clears it. The value is deliberately the
       * same one the ROW carries, so a relaunch and a poll answer the question identically.
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
        ? { organizing: false, reason: mb.standDownReason as MailboxDisabledReason, heldBy: null }
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
      let takeoverAuthorized = mb.takeoverAuthorizedAt !== null;
      /**
       * THE EXACT STAMP THIS PASS READ, so the stand-down can clear THAT ONE and not whatever is on
       * the row by the time it writes.
       *
       * The gate reads the stamp, then reads the LEASE — a network round trip against the user's own
       * IMAP server, which can take seconds. A press landing inside that window writes a stamp this
       * pass never saw and never offered to the lease, and an unconditional
       * `takeoverAuthorizedAt: null` in the stand-down would erase it: the route answered
       * `authorized`, the person carried on working, and the request is gone with nothing anywhere
       * saying so. Narrow, and exactly the class this whole round is about — a press consumed by a
       * pass that could not act on it.
       *
       * Comparing rather than serializing, because serializing is the wrong instrument here: the
       * route must stay answerable while a slow lease read is in flight, and making it wait on the
       * gate would block a button press behind an IMAP timeout.
       */
      let observedTakeoverAt: Date | null = mb.takeoverAuthorizedAt;

      /**
       * HAS ANYBODY ASKED THIS INSTALL TO ORGANIZE THIS MAILBOX — `organize_consented_at`, as the
       * row holds it, re-read by the gate on every pass.
       *
       * TRUE AT ASSEMBLY, and that default is chosen rather than convenient. `world` does not carry
       * the column, so the first value here is a guess until the gate's own read replaces it one
       * statement into `mayOrganize` — and `mayOrganize` runs before anything organizes (it gates
       * `ensureFolders` and every drain). The guess is therefore never acted on. What it must not do
       * is be WRONG in the direction that hurts if some future path ever did act on it: an install
       * that has been organizing a mailbox for months, briefly reading as un-consented, would demote
       * itself, close its appointments and stop moving mail for a live customer. Reading as
       * consented and being corrected costs nothing, because the correction lands before the first
       * decision. That is the same asymmetry `OnboardingMailbox.organizerRole` documents on the
       * client, resolved the other way for the opposite reason: there the absent value would put a
       * consent screen over somebody's working mailbox, here it would stop one.
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
      const standDownAppointments = async (reason: MailboxDisabledReason): Promise<void> => {
        try {
          const r = await closeStoodDownAppointments(db as unknown as Tx, {
            accountId: world.accountId, mailboxId: mb.id, reason, now: now(),
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
       * THE LAUNCH CATCH-UP — a stood-down install closes its own appointments on every start.
       *
       * The stand-down hook above covers the transition. This covers the STATE, and it is needed
       * for three cases the transition cannot reach: an install that stood down before this code
       * existed (which is every orphan in the field today), one whose close failed, and one that
       * has been relaunched since — because `mayOrganize` returns at `priorStandDown` without
       * reaching the lease arm, so nothing on a later launch would ever run the close.
       *
       * It is HERE — in the assembly, on the row's own memory — rather than inside `start()`,
       * because `start()` returns before the gate when no password is stored, and a stood-down
       * install with a forgotten password is exactly one whose Drafts screen someone opens. The
       * write is one indexed UPDATE that matches nothing on a settled install.
       *
       * Awaited, so the mirror is true before the bridge serves its first request.
       */
      if (priorStandDown) await standDownAppointments(priorStandDown as MailboxDisabledReason);

      /**
       * THE PORTABLE ORGANIZER PROFILE — the LOCAL half, which is the same composition Cloud runs
       * (`@trafficflow/worker/profile`), handed this install's lease identity and this install's
       * store. One serialization of one store, or LOCAL and CLOUD would write documents that
       * disagree about the same configuration.
       *
       * Ticked only from `syncUntilQuiet` AFTER `mayOrganize()` said yes — the same single-writer
       * discipline every organizer-side write here rides. `"0.0.0"` is the version every local
       * surface reports today (the /hello convention); it is provenance in the document, never a
       * decision.
       */
      const profileSync = new OrganizerProfileSync({
        db, accountId: world.accountId, mailboxId: mb.id, adapter,
        self: { installId, kind: "local" },
        producerVersion: "0.0.0",
        ...(config.profileFlushIntervalMs !== undefined
          ? { flushIntervalMs: config.profileFlushIntervalMs } : {}),
        now,
        log,
      });

      /**
       * Read the lease. Returns false when this install must not organize, and makes that durable.
       *
       * ── WHAT THE LOSER BECOMES (mail 0083 — this paragraph used to say the opposite) ────────
       *
       * The loser is a READER: connected, poll timer running, mirror growing, `\Seen` its one IMAP
       * write verb. It is NOT a stopped install, and this header said it was — *"stands down on its
       * next cycle and STOPS SYNCING ENTIRELY … the poll timer stops and the login closes"* — for
       * long enough that three separate call sites implemented that sentence instead of the one the
       * stand-down arm below actually logs. The fear it encoded is real and is answered by the ROLE
       * rather than by stopping: a reader's cycle skips `reconcileFolders`, the folder-ops pass, the
       * junk sweep, `ensureFolders`, the retro passes and the profile publish, so it observes without
       * acting and cannot be half of a dual-organizer bug. `SyncDeps.role` carries the whole list.
       *
       * `false` therefore means "this install is not the organizer" and never "and therefore do
       * nothing" — which is what every caller of this gate has to be read as asking.
       *
       * The stand-down is STICKY in the local row (`status='disabled'` + the reason), and that is
       * what actually keeps a stood-down desktop from auto-resuming when Cloud lapses. The lease
       * alone could not: once Cloud releases its claim the folder is empty, and an empty folder
       * reads as "nobody has ever organized this mailbox", which organizes. The row is the memory
       * the mailbox cannot hold, and only an explicit human action clears it.
       */
      /**
       * A PRE-CONSENT INSTALL LOOKS, AND STILL DOES NOT CLAIM.
       *
       * The consent arm below returns BEFORE `readMailboxLease`, and it has to: that function is not
       * a report, it APPENDS on an empty folder. But returning early also means never learning who
       * holds the mailbox — and the holder is exactly what the screens before consent have to say.
       * The flow's "somebody else organizes this" step turns on `organizedBy` AND the absence of
       * a consent stamp (`deriveOnboardingStep` row 3) — it deliberately does NOT ask for the role,
       * because the role is written by the STAND-DOWN and these columns by this peek, so requiring
       * both would mean waiting for a demotion to be told about a claim already seen.
       * Settings → Mailboxes renders the same four columns; with
       * none of them written, a person connecting a mailbox their other machine organizes would be
       * shown the plain consent statement and would agree to take it without ever being told.
       *
       * So this is the APPEND-less read, the same one the hosted reader cycle uses
       * (`index.ts#refreshReaderHolder`) and the same one the ruling names: *"A reader consults
       * `runLeaseGate` only when `takeover_authorized_at IS NOT NULL`; otherwise it peeks."*
       * `readLeasePeek` takes an IO object with exactly one method and no way to write — the
       * narrowness is the enforcement rather than a convention.
       *
       * NEVER THROWS, and an adapter without the read-only accessor is simply skipped. "I could not
       * look" and "nobody holds it" must not be reachable from one another: leaving the columns at
       * their previous answer is at worst one poll stale, while writing "nobody" from a failed
       * FETCH would invite somebody to take a mailbox another machine is actively organizing.
       *
       * ONLY WHEN SOMETHING CHANGED, so the steady state of a mailbox waiting on its consent screen
       * is one FETCH and zero writes per pass.
       */
      const notePreConsentHolder = async (): Promise<void> => {
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
          organizer = { organizing: false, reason: null, heldBy: name };
          await db.update(mailboxes)
            .set({
              organizedByKind: kind,
              organizedByName: name,
              organizedSince: top ? top.claimedAt : null,
              organizerState: state,
            })
            .where(eq(mailboxes.id, mb.id));
        } catch (err) {
          log("organizer_peek_failed", {
            err,
            reason: "this install has not been asked to organize this mailbox and could not see who "
              + "does; the row keeps its previous answer and the next pass looks again",
          });
        }
      };

      const mayOrganize = async (): Promise<boolean> => {
        /* -- THE STAMP IS RE-READ EVERY RUN, AND WITHOUT THIS THE POLL DESTROYS IT ---------------
         *
         * `takeoverAuthorized` was derived ONCE at assembly, which was harmless while a stood-down
         * install had no poll timer: the row survived to the next launch and the gate read it then.
         * A reader cycles now, and that turns a dormant staleness into a DESTRUCTIVE one — the poll
         * asks the lease with `takeover: "none"`, is correctly refused by the foreign claim the
         * person is asking to take over, and the refusal arm then CLEARS the persisted stamp. The
         * press is consumed by the one pass that could not act on it, and a relaunch cannot recover
         * it either because there is nothing left on the row to recover.
         *
         * So the row is asked again, here, at the top of the gate. One indexed read per poll against
         * the local store, which is the cheapest thing in this function, and it is what makes the
         * takeover route's own promise — *"the gate runs again on the very next poll, reads the
         * stamp, and promotes"* — a fact rather than a sentence.
         *
         * Failure is NOT an error: an unreadable row leaves the in-memory value standing, which is
         * exactly what it was before this read existed. A takeover deferred to the next poll is a
         * far better outcome than a launch that fails because a status read did.
         */
        try {
          const [row] = await db.select({
            at: mailboxes.takeoverAuthorizedAt,
            // …AND THE CONSENT, in the same indexed read. See the arm below: this is the column
            // that separates "nobody has been asked" from "this install is the organizer", and
            // before it was read here NOTHING on this door read it at all.
            consentedAt: mailboxes.organizeConsentedAt,
          })
            .from(mailboxes).where(eq(mailboxes.id, mb.id)).limit(1);
          if (row) {
            takeoverAuthorized = row.at !== null;
            observedTakeoverAt = row.at;
            consented = row.consentedAt !== null;
          }
        } catch (err) {
          log("organizer_takeover_reread_failed", {
            err,
            reason: "the takeover request could not be re-read this cycle; the stamp stands on the " +
              "row and the next cycle asks again",
          });
        }
        // The row's memory outranks the folder. See `priorStandDown` above: this is the arm that
        // makes "the desktop does not auto-resume" survive a relaunch, and it deliberately does not
        // even read the lease — there is nothing for the gate to decide about a mailbox this install
        // has been told to stop organizing.
        //
        // A LIVE REQUEST OUTRANKS THAT MEMORY, and it has to now that the stamp is re-read: the
        // press is the explicit human action the stand-down's stickiness exists to wait for, and
        // `priorStandDown` was computed at assembly from a row that had no stamp on it yet.
        if (priorStandDown && !takeoverAuthorized) return false;
        /* -- NOBODY HAS AGREED TO THIS YET, SO THIS INSTALL READS AND ARRANGES NOTHING ----------
         *
         * AHEAD OF THE LEASE READ, and that ordering is the whole guard rather than a detail.
         * `runLeaseGate` does not merely report — on an empty `ohmail/_meta` it takes the first arm
         * ("nobody has ever organized this mailbox") and APPENDS this install's claim. Asking it at
         * all is therefore already taking the mailbox, so a consent check placed after it would
         * leave a claim in a stranger's mailbox for every launch before anybody agreed to anything.
         *
         * WHAT WAS MEASURED WITHOUT THIS: a person chose "On this computer", typed a password, and
         * six seconds later their mailbox had six new folders and their backlog had been moved into
         * them. The consent screen existed and was reachable only afterwards. The gate consulted the
         * lease and `takeover_authorized_at` and nothing else — `organize_consented_at` had a writer
         * on this door and no reader.
         *
         * `!takeoverAuthorized` is the second half and it is what makes the flow work rather than
         * deadlock: the consent route writes `organize_consented_at` and `takeover_authorized_at` in
         * ONE transaction, so the first pass after "Agree" sees both, spends the stamp at the arm
         * below and promotes. It also keeps the CLI (`runOrganizeHere`) and the Settings pane's
         * "Organize here instead" working unchanged — every door into organizing goes through a
         * write that sets the pair.
         *
         * `organizer` IS SET HERE and not left standing. `drain` spreads
         * `role: organizer.organizing ? "organizer" : "reader"` and gates `armHoldFromFolder` and
         * `sendScheduled` on the same field, so returning false without it would give a reader's
         * gate an organizer's cycle — the row and the pipeline disagreeing, which is precisely the
         * shape this whole area keeps producing. `reason` is NULL deliberately: this install has not
         * stood down and nobody else holds the mailbox. There is no holder to name, and naming one
         * would put "another install has claimed this mailbox" on the screen of somebody who has
         * simply not finished setup.
         *
         * `priorStandDown` is deliberately NOT set. That memory exists to stop an auto-resume after
         * a real demotion; a mailbox nobody has agreed to is not a demotion, and setting it would
         * make the state sticky for the life of the process.
         */
        if (!consented && !takeoverAuthorized) {
          organizer = { organizing: false, reason: null, heldBy: null };
          await notePreConsentHolder();
          return false;
        }
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
          // THE MEMORY IS SPENT WITH THE STAMP. Reaching here past a remembered stand-down means a
          // human pressed the button and the lease agreed; leaving the memory set would make the
          // very next poll return false for an install that IS the organizer — it would drain as a
          // reader against a row that says `organizer`, which is the two halves disagreeing in the
          // other direction. See {@link priorStandDown}.
          priorStandDown = null;
          if (takeoverAuthorized) {
            // SPEND IT. One becoming, not a standing right: leaving the stamp set would let this
            // install seize the mailbox back on some later launch, after a human had deliberately
            // moved it elsewhere. Written only when there is something to clear, so an install that
            // simply keeps organizing writes nothing here on any cycle.
            //
            // ── AND THE STAND-DOWN IS CLEARED IN THE SAME STATEMENT, HERE AND NOWHERE EARLIER ──
            //
            // This is the moment `readMailboxLease` said ORGANIZE. Clearing the row before it —
            // at assembly, say — publishes a `connected` mailbox to the send and schedule paths
            // (which refuse on `status = 'disabled'` and on nothing else) before any lease has
            // been read, and for the whole life of a launch with no stored password, where
            // `start()` returns before this gate. Here there is nothing to race: the claim is
            // already written and this install IS the organizer.
            //
            // All three columns together, for `authorizeOrganizerTakeover`'s reason: `status`
            // without `disabled_reason` is a TOMBSTONE, and the next launch would mint a second
            // mailbox row for the same address with none of this one's history.
            //
            // ── AND `disabled_reason` IS RE-CHECKED IN THE WRITE, NOT ASSUMED FROM MEMORY ──────
            //
            // `takeoverAuthorized` was read at assembly and the lease read since then is a network
            // round trip, during which the bridge is serving. A `DELETE /mailboxes/:id` committing
            // in that window makes the row a TOMBSTONE — `disabled`, reason NULL, credentials
            // deleted — and an unconditional write here would revive it as `connected`, undoing a
            // removal the person asked for and leaving a connected mailbox with no stored login.
            //
            // So the stand-down clear is conditional on the stand-down still being there, in SQL
            // rather than in a prior read, while the STAMP is spent either way: whatever the row
            // became, this authorization has been used and must not authorize a later seizure.
            // A row that was never stood down keeps its `connected`/NULL values, so this stays the
            // no-op it has always been for an install that simply organizes.
            //
            // ── AND THE WRITE'S OWN ANSWER DECIDES WHETHER THIS LAUNCH ORGANIZES AT ALL ────────
            //
            // Preserving the tombstone is not sufficient on its own: the lease has already said
            // organize and already appended this install's claim, so without the branch below
            // `start()` would go on to `ensureFolders()`, `drain()` and the poll timer against a
            // mailbox the person removed — writing under a row every later launch excludes, and
            // holding a claim that stands another organizer down. The read-back is free (the
            // statement is already running) and it is the only place this launch can learn the
            // removal, because `world` is a snapshot taken before the lease read.
            //
            // The response is the stand-down's own tail minus its row write, which the removal has
            // already made: organize nothing, stop the timer, close the login. The claim we
            // appended is left to age out of `ohmail/_meta` on its own — the same cost a crashed
            // organizer imposes, and strictly better than expunging from a launch that has just
            // discovered it should not be here.
            //
            // This does NOT close the general case: a `DELETE` landing mid-launch on an install
            // that was never stood down reaches none of this, and that race predates this code —
            // it belongs to the engine's `world` snapshot and wants a lifecycle mechanism, not a
            // branch. What it closes is the window this arm opened.
            try {
              const [after] = await db.update(mailboxes)
                .set({
                  status: sql`case when ${mailboxes.disabledReason} is not null then 'connected' else ${mailboxes.status} end`,
                  disabledReason: null,
                  takeoverAuthorizedAt: null,
                  /* -- THE ROLE, IN THE SAME STATEMENT AS THE STAMP IT SPENDS (mail 0083) --------
                   *
                   * Without this the row still says `reader` for an install the lease has just
                   * made the ORGANIZER, and `organizer_role` is the authority every write door
                   * consults: the install would move mail on IMAP while its own API refused every
                   * request that asked it to, with `409 organized_elsewhere`, naming itself.
                   *
                   * It was unreachable before — this arm runs only when a takeover stamp is spent,
                   * and until the stamp could be spent by a POLL there was no promotion that did
                   * not also go through a relaunch, where the role is written at assembly. Arming
                   * the reader's loop is what made this path live, so it is repaired here.
                   *
                   * The two clean-up columns are deliberately NOT touched: `organized_by_*` is what
                   * the pane renders about the install that held it, and the next cycle's own
                   * writes are the right place for that, not a stamp-spending UPDATE.
                   */
                  organizerRole: "organizer",
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
                organizer = { organizing: false, reason: null, heldBy: null };
                stopped = true;
                if (timer) clearTimeout(timer);
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
        };
        // Standing down voids any unspent authorization, in memory and on the row below. We are not
        // the organizer, so becoming one again is a new becoming and needs a new explicit request.
        takeoverAuthorized = false;
        // …AND IT IS REMEMBERED FOR THE REST OF THIS PROCESS, not only on the row. A reader keeps
        // polling, so without this line the next cycle would ask the lease again and take the
        // mailbox back the moment the other organizer released it. See {@link priorStandDown}.
        priorStandDown = outcome.reason;
        log("organizer_stand_down", {
          disabledReason: outcome.reason,
          heldBy: organizer.heldBy,
          // `state` and NOT `organizerState`, which is the name this line shipped with and which
          // `ALLOWED_FIELDS` drops — so the stand-down line reported `droppedFields` and said
          // nothing about the state it exists to name. `reconcile-cron.ts:259` already carries the
          // same correction in the same words for the same value on the hosted door.
          state: outcome.state,
          reason: "another organizer holds this mailbox; this install becomes a READER of it — it " +
            "keeps its login and its poll timer, its mirror goes on growing, it can mark mail read " +
            "and send, and it moves, files and deletes nothing",
        });
        try {
          /* -- THE ROLE, NOT THE STATUS (mail 0083) ------------------------------------------
           *
           * This wrote `status: "disabled"` and the install stopped: the timer was cleared, the
           * login closed, the mirror frozen at the instant of the handover. That is what
           * the earlier dual-mode design described as "stops syncing entirely / frozen mirror", and
           * the 2026-09-01 owner ruling replaced it — the doc is amended in this commit rather
           * than left to contradict the code.
           *
           * A demoted install is a READER. It is `connected`, it is on its own roster, and the
           * four holder columns are what its banner renders — written from the SAME verdict that
           * demoted it, so the row names who holds the mailbox without any client dialling IMAP.
           *
           * `disabled_reason` is deliberately NOT written any more. `disabled` means tombstone or
           * plan-disable, full stop, and a reader that also carried a stand-down reason would be a
           * row saying two different things about itself.
           */
          await db.update(mailboxes)
            .set({
              organizerRole: "reader",
              organizedByKind: (outcome.by?.kind ?? outcome.reason.split(":")[1] ?? "unknown"),
              // Header-safe and capped at the write — this is another install's machine name,
              // arriving out of an RFC822 header it wrote.
              organizedByName: organizerDisplayName(outcome.by?.displayName ?? null),
              organizedSince: outcome.by?.claimedAt ?? null,
              organizerState: outcome.state,
              /* THE STAMP THIS PASS READ, and only that one — see {@link observedTakeoverAt}. A
                 press that landed while the lease was being read was never offered to it, and
                 clearing it here would answer a request nothing ever considered. `IS NOT DISTINCT
                 FROM` rather than `=` so the ordinary case (both NULL) matches: SQL equality on two
                 NULLs is NULL, which would make this a no-op on every stand-down that had no stamp
                 and leave the column's own value untouched — harmless there, and the wrong shape to
                 rely on. */
              takeoverAuthorizedAt: sql`case when ${mailboxes.takeoverAuthorizedAt} is not distinct from ${observedTakeoverAt}
                then null else ${mailboxes.takeoverAuthorizedAt} end`,
            })
            .where(eq(mailboxes.id, mb.id));
        } catch (err) {
          log("organizer_stand_down_write_failed", {
            err,
            reason: "this install reads the mailbox regardless; the row could not record who organizes it",
          });
        }
        // ── AND THE APPOINTMENTS THIS INSTALL CAN NO LONGER KEEP ARE CLOSED, HERE ──────────────
        //
        // `sendScheduled()` is inside `drain`, and `drain` is behind this gate — so from the line
        // below, the scheduled-send pass will never run on this install again. Everything it owed
        // is owed now or never: the appointment does not travel (the portable profile carries no
        // drafts, deliberately), and `SCHEDULED_SEND_EXPIRY_MS` — the constant that exists so a
        // late appointment is closed with a sentence rather than delivered quietly — is enforced
        // INSIDE that unreachable pass. Without this call a pending scheduled send is never
        // delivered, never reported as failed, and the Drafts screen goes on saying "Sends Tue
        // 14:50" for a time that has gone, for ever. Measured; see `closeStoodDownAppointments`.
        //
        // NOT folded into the stand-down UPDATE above as one transaction, and that is deliberate:
        // the two writes have different owners (the worker's twin is a FENCED lifecycle write) and
        // different failure answers, and a stand-down must never be contingent on closing an
        // appointment. A failed close is retried by the launch catch-up while the row still says
        // stood down.
        await standDownAppointments(outcome.reason);
        /* -- THE TIMER AND THE LOGIN STAY (mail 0083) ----------------------------------------
         *
         * Three statements used to follow this line — `stopped = true`, `clearTimeout(timer)`,
         * `adapter.close()` — and together they were the whole of "stops syncing entirely". They
         * are gone from THIS path and kept for the two paths that still mean it: a tombstone (the
         * mailbox was removed) and a removal discovered mid-launch, both above.
         *
         * What replaces them is nothing at all: `start()` continues, the drain runs, and the cycle
         * that follows is a READER cycle. The mirror keeps growing, which is the entire product
         * difference — a person who moved organizing to another machine can still read, search and
         * send from this one, and the mail they receive after the handover appears here.
         *
         * `return false` still means "this install is not the organizer", which is what every
         * caller of this gate asks. It no longer means "and therefore do nothing".
         */
        return false;
      };

      /**
       * KEEP THE SEND-LATER APPOINTMENTS THIS INSTALL MADE (mail 0077) — the standalone door's
       * copy of the clock the hosted deployment runs on the API host every minute.
       *
       * The same ONE implementation (`runScheduledSendPass` in `@trafficflow/services`), for the
       * reason every pass above is the worker's: the claim, the recovery arm and the outcome
       * table have to agree with what the schedule verbs promised, or a cancel that answered
       * "already being sent" and a claim that was not one would be two hosts disagreeing about
       * one row. Only the transport differs — `openLocalSend`, the exact adapter a manual send
       * from this door dials — and the storage cap is this tier's typed UNMETERED, the same
       * declaration `localServices` makes for the send route's own projection.
       *
       * On the DRAIN cadence rather than a timer, which is the honest reading of "sends at 9:00"
       * on a door that only exists while the app is open: an appointment that comes due while
       * the app is closed sends on the next launch's first drain, and the compose surface's
       * picker says the time in the user's own clock either way. A failure is CONTAINED like
       * every pass here — the pass re-arms transient faults itself, and mail keeps arriving.
       */
      const sendScheduled = async (): Promise<void> => {
        try {
          const r = await runScheduledSendPass(db as never, {
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
       * The drain itself. Never called from outside this closure, and — since mail 0083 — reached
       * by a READER as well as by an organizer; `organizer.organizing` is what separates them, both
       * for the passes below and for the `role` every cycle runs under.
       */
      const drain = async (maxCycles: number): Promise<number> => {
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
        if (organizer.organizing) await sendScheduled();
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
          const { hasBacklog, owesFiling } = await runSyncCycle({
            ...syncDeps, ...screening, classifier: ai.classifierForCycle(),
            // Mail 0083. THE ROLE THE GATE ANSWERED FOR THIS DRAIN, spread after `syncDeps` so it
            // wins: a demoted install keeps draining, and every cycle it runs from here is a READER
            // cycle — the mirror grows, `\Seen` is pushed, and nothing is moved, filed or created.
            // `organizer.organizing` is the gate's own answer, held on the engine and refreshed by
            // every gate run, so a demotion or a promotion applies to the very next cycle.
            role: organizer.organizing ? "organizer" : "reader",
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED from
            // the current facts at every cycle edge — never cached; see the worker's cycle for
            // the argument (many arm/release orderings were tried, each with a
            // mirror-image race). One `ohmail/_meta` FETCH per cycle; a store serialize and an
            // indexed read only when a foreign document is present; a faulted read answers what
            // the previous cycle answered.
            importDecisionOpen: await profileSync.importDecisionOpenNow(),
          });
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
        if (cycles > 0) await stampSynced(db, mb.id, now(), inboundDrained);
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
              await adapter.ensureFolders();
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
          const cycles = await drain(maxCycles);
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
          if (organizing) await profileSync.onOrganize();
          return cycles;
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
        serialize,
        syncUntilQuiet,
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
            /* -- `!permitted` IS "NOT THE ORGANIZER", NOT "STOP" — THE LAUNCH HALF (mail 0083) --
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
            if (!permitted && stopped) {
              // THE MAILBOX WAS REMOVED — the only `false` that still means "do nothing".
              // `mayOrganize` has already cleared the timer and closed the login on that arm; there
              // is no mirror to grow and nothing to schedule.
              return;
            }
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
              await adapter.ensureFolders();
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
            if (typeof adapter.findSpecialFolders === "function"
              && typeof repo.setMailboxSpecialFolders === "function") {
              try {
                const found = await adapter.findSpecialFolders();
                await repo.setMailboxSpecialFolders(mb.id, {
                  junkFolder: found.junk, trashFolder: found.trash,
                });
              } catch (err) {
                log("special_folder_discovery_failed", { err });
              }
            }
            await serialize(() => drain(100));
            schedule();
          } catch (err) {
            // The ORIGINAL error, rethrown — `main.ts` decides what a failed launch means, and it
            // must not be told the connection failed to close when what failed was the drain.
            await adapter.close().catch(() => { /* the connection is already broken */ });
            throw err;
          }
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
         */
        async detach() {
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
        },
      };
      runtimes.add(rt);
      return rt;
    };

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
      await attachLocal(row, row.id === world.mailboxId);
    }
    log("local_roster_attached", {
      count: runtimes.size,
      reason: "every mailbox this install holds has a runtime: its own connection, its own poll "
        + "timer and its own organizer claim",
    });

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
     * Three writes make that true, and each is keyed on a predicate that is false once it has
     * been done — no marker, no journal entry, nothing to migrate. A third launch writes nothing.
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
              meta: sql`coalesce(${mailboxCredentials.meta}, '{}'::jsonb) || ${JSON.stringify({
                host: config.imap.host, port: config.imap.port,
                secure: config.imap.secure, user: config.imap.auth.user,
              })}::jsonb`,
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
        const localAction = (req.method === "DELETE" && url.pathname === "/local/stored-login")
          || (req.method === "POST" && url.pathname === "/local/organizer/takeover")
          || localRemoveMatch !== null
          || localOrganizeMatch !== null
          || localSealMatch !== null
          || localAddMatch;
        if (localAction) {
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

              const dto = await deps.services!.mailbox.create(
                ctx,
                body as never,
                { probe: makeImapProbe(deps, probeOpts), smtpProbe: makeSmtpProbe(deps, smtpProbeOpts) },
              );

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
              const dto = await deps.services!.mailbox.update(
                {
                  db, accountId: core.accountId, userId: core.userId,
                  now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
                body as never,
                { probe: makeImapProbe(deps, probeOpts), smtpProbe: makeSmtpProbe(deps, smtpProbeOpts) },
              );
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
              if (removed) {
                try {
                  const released = await releaseMailboxClaim(removed.adapter, installId);
                  if (released > 0) log("organizer_claim_released", { claims: released });
                } catch (err) {
                  log("organizer_claim_release_failed", {
                    err,
                    reason: "the claim ages out of ohmail/_meta on its own; until it does, another "
                      + "install connecting this mailbox stands itself down against a claim "
                      + "nothing holds",
                  });
                }
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
              log("local_mailbox_removed", {
                verdict: "removed",
                reason: "a person removed this mailbox from this machine; its credentials are "
                  + "deleted, its pending appointments are closed, its organizer claim is "
                  + "released, this install's copy of its mail is deleted and nothing was "
                  + "deleted from the mail server",
              });
              return new Response(JSON.stringify({ seq: out.seq === null ? null : String(out.seq) }), {
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
       * Drain ONE mailbox. Answers 0 for an id this install does not run, which is the honest
       * answer rather than a throw: the row may have been removed between a caller reading the
       * list and asking, and that is a race, not a fault.
       */
      async syncMailbox(mailboxId: string, maxCycles = 100) {
        return (await runtimes.get(mailboxId)?.syncUntilQuiet(maxCycles)) ?? 0;
      },
      /**
       * Every mailbox's organizer state, keyed by row id — the pane renders one line per entry.
       * A snapshot taken per call, never a live map: the caller is a request handler and the
       * gate writes these fields from a poll.
       */
      organizerStates() {
        return Object.fromEntries(runtimes.all().map((r) => [r.mailboxId, r.organizer]));
      },
      /**
       * The SEED's answer, unchanged for every existing caller. See `LocalRoster.seed`: the row
       * matching the configured address, else the oldest live one. An install with no mailboxes
       * at all reports itself as not organizing, which is true and is what the door chooser
       * renders.
       */
      organizerState: () => seedRuntime()?.organizer ?? { organizing: false, reason: null, heldBy: null },
      credentialState: async () => (await seedRuntime()?.credentialState()) ?? "absent",
      forgetStoredLogin: async () => (await seedRuntime()?.forgetStoredLogin()) ?? false,
      /**
       * START EVERY MAILBOX. Concurrent for `syncUntilQuiet`'s reason, and `allSettled` for it
       * too — with one difference that is the whole of why this is not a bare `Promise.all`:
       * `main.ts` answers a rejected `start()` by logging and going on to serve the mirror, so a
       * throw here is not fatal to the process. What it must not do is take the OTHER mailboxes
       * down with it. Each runtime's own `start` already closes its login on the way out.
       */
      async start() {
        const runs = await Promise.allSettled(runtimes.all().map((r) => r.start()));
        for (const r of runs) {
          if (r.status === "rejected") log("mailbox_start_failed", { err: r.reason });
        }
      },
      async stop() {
        // The INSTALL is going down, which is what the account-scoped passes yield on. Each
        // mailbox's own timer, in-flight cycle and login go with its runtime; the STORE is the
        // install's and is closed once, here, after every mailbox has let go of it.
        stopping = true;
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
