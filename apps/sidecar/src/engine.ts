import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import {
  StaticKeyProvider, kekRingFingerprint,
  type KekEnvIdentity, type KeyProvider,
} from "@trafficflow/core/mail";
import {
  isImapBoundExceeded,
} from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeSignatureCheck } from "@trafficflow/core/adapters/dkim";
// After the `@trafficflow/core` block, matching every other file in this package: core first,
// then the private half. `packages/core` → `@trafficflow/db` is a real edge (`pipeline.ts` imports
// `classifyLedgerSource`, `drizzle-repo.ts` imports the tables), so this file should not be the
// module that enters that graph.
import {
  mailboxCredentials, mailboxes,
  // Read once at the open: the send reservations the last run left `pending` (see `inheritedSends`).
  outboundSends,
  // The erasure fence's mailbox arm and its refusal class — one module for both doors, the
  // sign-out fence's rule. The class is read by the seal's catch arm, which treats an erased
  // mailbox exactly as it treats a signed-out one.
  // Mail 0083 — the role vocabulary and the machine-name bound. One spelling for the sidecar's
  // gate, the worker's gate and the eleven service write doors; see `db/src/organizer-role.ts`.
  isOrganizerRole,
  // The write door for `organized_by_kind`, which this store carries no CHECK for: the set
  // is widenable, so a device's refusal lives here and not in the table definition.
  // The entitlements composition this host declares. From the MAIL barrel — the port is pure
  // types and one literal, and the halves that answer it stay on `@trafficflow/db/cloud`.
  type MailboxDisabledReason, type OrganizerRole,
  // The change log's horizons, for the ONE question the idle scheduler asks: did this drain
  // produce anything the window could see? Nothing else on this door writes to the window's
  // mirror, so an unmoved `max` IS "nothing happened" — see `changeLogMark`.
  // The arrangement's doorbell: every role flip below rings it inside its own transaction.
  // What a server says when it declines a LOGIN for now — the worker's classifier reads the same two.
  // The 0.25.9 repair of a person's press that left a Screener rule inferred, once per launch.
} from "@trafficflow/db";
import {
  makeAuthConfig,
  sendService,
  ServiceError,
  type PassContext,
  // The sign-out fence's durable half — one module for both doors, so the engine and the shared
  // mailbox service cannot hold two versions of the same rule (`signed-out-fence.ts`).
  // What a sign-out keeps of where a mailbox lives (mail 0127): the one builder the column takes
  // and the reader that re-applies its allow-list.
} from "@trafficflow/services/mail";
import {
  createApp, localRoutes,
  makeSmtpProbe, matchRoute, sendConnections,
  type App,
} from "@trafficflow/api/local";
// THE DESKTOP-HOST DOOR's route table (Phase 3): the single-user product set plus the carved
// session-lifecycle pair, the device list and the anonymous device-pair redeem — and structurally
// nothing else. Mounted below ONLY when host mode is armed; see `desktopHostRoutes`' own header
// for the exact in/out list and the obligations it puts on this composition root.
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { createSignOutFence, type SignOutFence } from "./signout-fence.js";
// WHICH OUTBOUND PASSES THIS COMPOSITION RUNS — one table read by the pass and by the door, so
// "a phone keeps no appointments" cannot be true in one of the two places. See its header.
import {
  COMPOSITION_WALKS,
} from "./composition-passes.js";
import { hostPairRoutesFor } from "./host-pair-routes.js";
// The static half of the host door — the built browser client the QR sends a phone to, served
// beside the API out of one `handleHost`. The route table wins; this covers everything else.
// See `host-static.ts` for the traversal defense, the caching rule and the credential-page CSP.
import { createHostStatic } from "./host-static.js";
// The host door's knobs, resolved ONCE (`resolveHostConfig` — pure, never throws, degrades with
// a surfaced reason), and the door's own send-surface ceiling. See `host-listener.ts`'s header
// for the whole arrangement; the listener itself is `main.ts`'s to start.
import { resolveHostConfig } from "./host-listener.js";
// The LAN fallback's one reading and its browser-facing explainer — the API-only decision and
// the secure-context audit behind it live in `host-lan.ts`'s header.
import { resolveLanBind, serveLanFallback } from "./host-lan.js";
import { ensureLanIdentity, type LanIdentity } from "./host-lan-tls.js";
import { localLanRoutes } from "./lan-routes.js";
import { attachmentFileRoutes } from "./attachment-file-route.js";

// The APPEND-LESS read, straight from core: an install that has not been asked to organize must
// still be able to say who does, and `runLeaseGate` cannot answer that question without taking
// the mailbox (its empty-folder arm claims). One method, no way to write. See
// `notePeekedHolder`.
import {
  makeClockCorrectionWatch,
  type LeasePeekAnswer, type OrganizerKind,
  type OrganizerIntent,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ImapAuth } from "@trafficflow/core/adapters/imap-types";
import type { ThreadJoinHealCursor } from "@ohmail/organizer/thread-join-heal";
import { createLocalAi } from "./ai-provider.js";
import { localAiRoutes } from "./ai-routes.js";
import { localAutoSuggestRoutes } from "./auto-suggest-routes.js";
import {
  closeAfterFailedStart, openLocalDb,
  type OpenLocalDb,
} from "./db.js";
import { awaitFirstPage } from "./first-page-gate.js";

export type { OpenLocalDbFn } from "./engine-types.js";
import {
  ensureLocalWorld,
  type LocalRosterRow,
} from "./identity.js";
import { mintLaunchBearer } from "./launch-bearer.js";
import { ownContextOf, unboundOf } from "./store-binding.js";
// ONE RUNTIME PER MAILBOX, held in a map. The record, the map and the seed decision live in
// `roster.ts`; what stays here is the assembly that fills one in and the routes that add and
// remove them. See that file's header for what is per mailbox and what is per install.
import {
  LocalRoster,
  type LocalMailboxRuntime,
  type OrganizerState,
} from "./roster.js";
import { settleFirstDoorAttempt } from "./first-door.js";
import type { SearchWarmup } from "./search-warmup.js";
import { createStatisticsUpkeep } from "./store-statistics.js";
import type { CadenceClocks } from "./pass-cadence.js";
import { loopTurn } from "./loop-hold.js";
import { createDrainTurns } from "./vitals.js";
import {
  type SidecarImapConfig, type SidecarConfig, type QuitPlan, QUIT_OFFER_RESERVE_MS,
  type QuitReport, QuitLeftOpenError, type Sidecar, type LaunchReport,
} from "./engine-types.js";
import {
  refusingKeyProvider, INHERITED_SENDS_MAX,
} from "./engine-local-services.js";
import {
  DEFAULT_POLL_INTERVAL_MS, IDLE_POLL_CEILING_MS,
  resolveHeartbeatTimeoutMs,
  reconnectProfile, settledWithin,
} from "./engine-reconnect.js";
import {
  engineBuildLabel,
} from "./engine-classifiers.js";
import {
  withForcedRedial, withImportHandover, withPullKick, withSeenPush,
} from "./engine-routes.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";
import { requestDepsSection } from "./engine-request-deps.js";
import { accountPassesSection } from "./engine-account-passes.js";
import { pressSection } from "./engine-press.js";
import { loginSection } from "./engine-mailbox-login.js";
import { connectionSection } from "./engine-mailbox-connection.js";
import { stateSection } from "./engine-mailbox-state.js";
import { claimSection } from "./engine-mailbox-claim.js";
import { sendsSection } from "./engine-mailbox-sends.js";
import { drainSection } from "./engine-mailbox-drain.js";
import { loopSection } from "./engine-mailbox-loop.js";
import { dialSection } from "./engine-mailbox-dial.js";
import { runtimeSection } from "./engine-mailbox-runtime.js";
import { rosterStartSection } from "./engine-roster-start.js";
import { windowServicesSection } from "./engine-window-services.js";
import { requestDoorSection } from "./engine-request-door.js";

/**
 * THE LOCAL ENGINE — `createApp` over `localRoutes` on on-disk PGlite (the host door, when armed,
 * over `desktopHostRoutes`), an `ImapAdapter` against the user's own server, and the shared sync
 * loop, assembled into one process.
 *
 * Everything a Cloud deployment configures and this one does not is an absence with a reason, not
 * an oversight. Read the service bag below as the answer to "what is Cloud, and what is mail?".
 */

export type { SidecarImapConfig } from "./engine-types.js";

export type {
  CredentialBlock, CredentialState, DialAnswer, FirstSyncState, MailboxConnectionState, OrganizerState,
} from "./engine-types.js";

export {
  type AdapterDialContext, type SidecarConfig, type BootPhase, type QuitPlan, QUIT_OFFER_RESERVE_MS,
  type QuitReport, QuitLeftOpenError, type Sidecar,
} from "./engine-types.js";

export { refusingKeyProvider, UNMETERED_MAILBOX_ALLOWANCE } from "./engine-local-services.js";

export {
  DEFAULT_POLL_INTERVAL_MS, IDLE_POLL_CEILING_MS, nextIdlePollMs, SignedOutError, ConnectionReplacedError,
  LOCAL_CONNECTION_DEAD_AFTER_MS, LOCAL_CONNECTION_DEAD_AFTER_CYCLES, DEFAULT_HEARTBEAT_TIMEOUT_MS,
  resolveHeartbeatTimeoutMs, LOCAL_CONNECTIONS_LOG_EVERY_MS, SIDECAR_NET_TIMEOUTS, REDIAL_BACKOFF_BASE_MS,
  REDIAL_BACKOFF_MAX_MS, type ReconnectProfile, DESKTOP_RECONNECT, PHONE_RECONNECT, RECONNECT_PROFILES,
  reconnectProfile, WallWait, redialStepMs, settledWithin,
} from "./engine-reconnect.js";

export type { LaunchReport } from "./engine-types.js";

export {
  tlsRefused, certificateRefused, dialWentQuiet, credentialsRefused, seedDial, fetchRefusal, fetchRefused,
  isConnectionFailure, drainFailureKeepsTheLogin, BAKED_ENGINE_VERSION, engineBuildLabel, STORE_REFUSED_DETAIL,
  discloseLocalSyncFailures, discloseProviderConfirms,
} from "./engine-classifiers.js";

export {
  LOCAL_NAME_BACKFILL_BATCH, LOCAL_NAME_BACKFILL_PAGES, LOCAL_JOIN_HEAL_EVERY_MS, LOCAL_INBOUND_QUIET_EVERY_MS,
  summarizeDrain, withForcedRedial, withImportHandover, withPullKick, withSeenPush,
} from "./engine-routes.js";

export async function createSidecar(config: SidecarConfig): Promise<Sidecar> {
  const scope = {} as EngineScope;
  const log = config.log ?? ((): void => undefined);
  const now = config.now ?? ((): Date => new Date());
  /* HOW LONG SINCE, as opposed to WHEN: every interval this engine measures in memory (a pass's
     cadence, a stop's budget, the lease bound's duration) reads this, so a wall clock stepped back
     neither skips a pass nor stretches a wait. A time that is stored or shown stays on `now`. */
  const monotonic = config.monotonic ?? ((): number => performance.now());
  /* A RECURRING PASS reads both clocks (`pass-cadence.ts`): the monotonic one alone stops in a
     suspend, so the hourly retro would run an awake hour after every sleep. */
  const wallNow = config.now ? (): number => now().getTime() : (): number => Date.now();
  const cadenceClocks: CadenceClocks = { wall: wallNow, mono: monotonic };
  const address = config.address ?? config.imap.auth.user;
  // The drains' loop readings since the last `engine_vitals` line.
  const drainTurns = createDrainTurns();
  /* THE SENDER-SIGNATURE CHECK, once for the install, over the lookup the composition chose; `null`
     where it chose none (the phone). Its one-click half is resolved per drain (`screeningNow`). */
  const signatureCheck = config.dkimKeys == null ? null : makeSignatureCheck({ keys: config.dkimKeys, now });
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
  /* HOW THIS COMPOSITION RUNS THE ORGANIZE WALKS: the turn they hand the loop, and the agree's sweep sizing. */
  const walks = COMPOSITION_WALKS[organizerKind];
  const walkTurn = config.loopTurn ?? (walks.turns ? loopTurn : undefined);
  const agreePages = config.agreeSweepPages ?? walks.agreePages;
  const agreeSlices = config.agreeSweepSlices ?? walks.agreeSlices;
  /* WHICH BUILD THIS ENGINE IS, as the sync loop's version label — see {@link engineBuildLabel}. */
  const engineBuild = engineBuildLabel(config.buildCommit);
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
  scope.connectionsAnsweredLine = "";
  scope.connectionsAnsweredAt = 0;

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
    ...(config.onStoreFatal ? { onFatal: config.onStoreFatal } : {}),
    // A store 1.0 made is moved to 2.0 at this open, and every value it sealed is opened under this
    // install's own key ring before the move commits. No ring: nothing opens, and such a store stays.
    transition: {
      // The way such a store crosses, named here and nowhere defaulted: a whole copy of it is taken first.
      way: "copy",
      openSealed: Object.keys(config.keks ?? {}).length > 0 ? new StaticKeyProvider(config.keks!) : refusingKeyProvider(),
    },
  });
  // Everything after the store: identity, the key ring, the AI assembly, the route table. Named
  // so the narration a window renders never just stops at the last database phase.
  config.onPhase?.("preparing");
  try {
    const db = opened.db;
    // The search's planner statistics after a drain took mail — PGlite has no autovacuum.
    const statisticsUpkeep = createStatisticsUpkeep(() => opened.analyzeSearchIfStale());
    /* The known-set read's statistics, before a drain reads it: without them every page sorts the
       rest of the mailbox. Kept once answered; an empty table or a refusal is asked again next drain. */
    let knownSetStatistics: Promise<void> | null = null;
    const knownSetStatisticsOnce = (): Promise<void> => {
      if (knownSetStatistics !== null) return knownSetStatistics;
      const step: Promise<void> = Promise.resolve()
        .then(() => opened.analyzeKnownSetIfNever())
        .catch(() => "pending" as const)
        .then((s) => { if (s === "pending" && knownSetStatistics === step) knownSetStatistics = null; });
      return (knownSetStatistics = step);
    };
    /* THE WAIT FOR THE WINDOW'S FIRST PAGE, one spelling for the poll's drain and the launch's
       (`first-page-gate.ts`). TWO LINES, NOT ONE WITH A FIELD: a rig greps for an event, and the
       drain yielded and got its page, or the bound fired and it went anyway. A wait of nothing
       (`already`, or a grace spent before the drain asked) says nothing. */
    const yieldToFirstPage = async (): Promise<void> => {
      const yieldedAt = performance.now();
      const waited = await awaitFirstPage();
      const waitedMs = Math.floor(performance.now() - yieldedAt);
      if (waited === "served") log("first_page_before_drain", { waitedMs });
      else if (waited === "timed-out" && waitedMs > 0) log("first_page_grace_expired", { waitedMs });
    };
    const tWorld = Date.now();
    /* AN UNSAVED FIRST DOOR IS KEPT OR UNDONE before any row is found or connects. Not the phone's. */
    if (organizerKind === "local") {
      await settleFirstDoorAttempt(db, {
        dataDir: config.dataDir, address, pending: config.doorPending === true, save: config.doorSave === true,
        now: now(), log,
      });
    }
    const world = await ensureLocalWorld(db, { address, ...(config.displayName ? { displayName: config.displayName } : {}), now: now() });
    const session = await mintLaunchBearer(db, world, now(), log);
    // The two identity writes, together: the mailbox row this install serves and the launch
    // session the shell will authenticate with. Measured as one phase because they are one
    // question — what it costs to establish who this launch is — and neither is separable from
    // the other in the failure this instrumentation exists to attribute.
    const worldMs = Date.now() - tWorld;
    if (session.revoked > 0) log("stale_sessions_revoked", { count: session.revoked });
    /* THE STORE'S HANDLES, BY WHOM EACH ACTS FOR (`store-binding.ts`). `db` stays the store's own,
       with no binding: the organizer's and the engine's own statements ride it. `unbound` names no
       account: a request's handle as it is minted, a session's look-up, a pass's walk. `ownContext`
       is a context of the engine's own, bound to this world's account: made from the world this
       launch found in its store, and from nothing a request or a mailbox says. */
    const unbound = unboundOf(db);
    const ownContext = (requestId: string): PassContext => ownContextOf(db, world, { now, requestId });

    /**
     * THE SEND RESERVATIONS THE LAST RUN LEFT `pending`, read before any door serves and before any
     * drain, so no attempt of THIS run is among them. Where this engine opened its store itself it
     * holds the data directory alone (`db.ts`'s lock), so the process that made them is gone and
     * nothing can still be sending them: the reconcile pass decides them at the first drain
     * (`runSendReconcilePass`'s `inherited`) instead of after `SEND_STALE_AFTER_MS`, so a delivered
     * message does not read "Sending…" for ten minutes. A quit that closed the store before a send's
     * finalize, or a crash, is what leaves one. A store handed in (the phone's) holds no such lock,
     * so its rows keep the stale window, as every row this run makes does. A read that fails names
     * none, which is today's behaviour.
     */
    const inheritedPending: readonly string[] = config.store !== undefined ? [] : await db
      .select({ id: outboundSends.id }).from(outboundSends)
      .where(eq(outboundSends.status, "pending"))
      .orderBy(outboundSends.createdAt)
      .limit(INHERITED_SENDS_MAX)
      .then((rows) => rows.map((r) => r.id), (err: unknown) => {
        log("inherited_sends_read_failed", {
          err,
          reason: "the send reservations the last run left pending could not be read, so they wait "
            + "out the ordinary ten minutes before the drain checks the Sent folder for them",
        });
        return [];
      });
    /* THE ONES THAT OFFERED NOTHING ARE FORGOTTEN HERE, before any door serves (mail 0162): a quit
       during a slow IMAP login leaves `unoffered`, the draft goes back to a draft, and the window's
       restored outbox entry sends it under its own key without waiting for the drain. The rest go
       to the reconcile pass as before; a failure leaves them all to it. */
    const inheritedSends: readonly string[] = inheritedPending.length === 0 ? inheritedPending : await sendService
      .forgetInherited(ownContext("inherited-sends"), inheritedPending)
      .then((r) => {
        if (r.forgotten > 0) log("inherited_sends_forgotten", { count: r.forgotten });
        return r.remaining;
      }, (err: unknown) => {
        log("inherited_sends_forget_failed", {
          err,
          reason: "the reservations the last run left pending that offered nothing could not be "
            + "forgotten, so the drain decides them as before",
        });
        return inheritedPending;
      });

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
      monotonic,
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
      ...withSeenPush(withPullKick(withImportHandover(withForcedRedial(localRoutes, (id) => runtimes.get(id), log), (id) => runtimes.get(id)), () => runtimes.all(), (id) => runtimes.get(id), (id) => gapOwed.add(id)), () => runtimes.all()),
      ...localAiRoutes(ai),
      ...localAutoSuggestRoutes({ db, accountId: world.accountId, ai, now }),
      // Which addresses this machine could serve same-network access on — the LAN ceremony's
      // one read, mounted UNARMED because the choice is offered before host mode exists. Never
      // on the host/LAN doors; see `lan-routes.ts`.
      ...localLanRoutes(() => lanIdentity?.fingerprint ?? null),
      // The desktop's streamed save, into the shell's staging folder. This door only; never the
      // host's, and not on a phone (no staging folder, and `phone/attachment-file-route.ts`).
      ...attachmentFileRoutes(config.attachmentStagingDir),
      // The window-only pairing mint (mint/list/revoke), on this door alone and only when host
      // mode is armed. The machine's own login is the step-up; see `host-pair-routes.ts`.
      ...(hostMode ? hostPairRoutesFor(config.dataDir, log) : []),
    ]);
    /**
     * THE DESKTOP-HOST DOOR's app — the composition a paired phone reaches, built ONLY when host
     * mode is armed so a disarmed install holds no second door, not a refusing one. Same engine,
     * same store, same `app.handle` pipeline: a remote device is a VIEWER of the one pipeline,
     * never a second write path. The window-only tables above (`/local/ai`, auto-suggest, the
     * pairing mint) are structurally absent from it.
     */
    const hostApp: App | null = hostMode
      ? createApp(withSeenPush(withPullKick(withImportHandover(desktopHostRoutes, (id) => runtimes.get(id)), () => runtimes.all(), (id) => runtimes.get(id), (id) => gapOwed.add(id)), () => runtimes.all())) : null;
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
    Object.assign(scope, {
      log, now, monotonic, cadenceClocks, address, drainTurns, signatureCheck, organizerKind, reconnect, walkTurn,
      agreePages, agreeSlices, engineBuild, pollIntervalMs, idlePollCeilingMs, detachWaitMs, heartbeatTimeoutMs,
      tBoot, opened, db, unbound, ownContext, statisticsUpkeep, knownSetStatisticsOnce, yieldToFirstPage, world, session, worldMs,
      inheritedSends, authConfig, durableKey, keyProvider, kekIdentity, ai, hostConfig, hostMode, app,
    } satisfies Partial<EngineScope>);

    requestDepsSection(scope, config);
    /**
     * Is the whole engine shutting down? — one flag for the install, distinct from any one
     * mailbox's. The account-scoped passes below used to yield on the single mailbox's
     * `stopped`, the same statement with one mailbox and not any more: `stopped` means "this
     * MAILBOX is gone", and neither of its causes is a reason for the install's own name repair
     * to stop walking rows that belong to the other mailboxes. What the yield is actually for is
     * `stop()`: a quitting engine must not open a transaction it may not finish. That is this
     * flag, and only `stop()` sets it.
     */
    scope.stopping = false;
    /**
     * THE LAST INSTANT OF A QUIT A PRESS IS STILL OFFERED: its request window less
     * {@link QUIT_OFFER_RESERVE_MS} (`quit`). Null for a stop without a plan, which waits for no request.
     */
    let offerBy: number | null = null;
    /** A press whose transport opens later, or during a stop without a plan, is held (`SendDeps.holdOffer`). */
    const holdOffer = (): boolean => scope.stopping && (offerBy === null || monotonic() > offerBy);
    /**
     * THE SHELL MARKED THIS STOP AS A RESTART ({@link Sidecar.leaving}). Set only by the exact word
     * `"restart"` and never cleared: one frame arrives, just before the input ends. Read by
     * `stop()` alone, so a mailbox removed or re-pointed meanwhile still gives its claim back.
     */
    let leavingForRestart = false;
    /** The mailboxes whose row a gate in this process read as `organizer` — {@link Sidecar.organizedHere}. */
    const organizedHereIds = new Set<string>();
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
    /**
     * THE MAILBOXES WHOSE ORGANIZING TENURE HAS HAD A QUIET DRAIN — the gap catch-up's licence.
     * Process-local: added when a drain this install ran as the organizer ended with nothing new,
     * removed by any pass that does not organize (a stand-down, a hand-back). Never inside the gate
     * and never on observed folders the new tenure has not brought up to date.
     */
    const gapCatchupReady = new Set<string>();
    /**
     * THE MAILBOXES THE GAP PASS OWES A RUN, so a settled drain asks the store nothing: each attach
     * once, a release or a look that opens a window, and a recorded press. A pass that ran leaves nothing owed.
     */
    const gapOwed = new Set<string>();
    /** The mailboxes whose window waiting for arrival times was said, so it is said once. */
    const arrivalsSaid = new Set<string>();
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
    /* THE CYCLE'S REPO: over the drain's own handle where the store pages the drain's commits (the
       phone's — see `OpenLocalDb.ingestDb`), the same repo everywhere else. */
    const cycleRepo = opened.ingestDb ? makeDrizzleRepo(opened.ingestDb) : repo;
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
     * THIS PROCESS'S OWN CLOCK, WATCHED — one watch for the install, because a clock correction is
     * a fact about the machine and not about a mailbox. Each runtime latches the count it has
     * acted on, so every mailbox gets the renewal a correction licenses and none gets two.
     */
    const clockCorrections = makeClockCorrectionWatch();
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
    /** What a launch could not open, logged per mailbox: `start()`'s and `startAnswering()`'s one loop. */
    const launchReport = (
      all: readonly LocalMailboxRuntime[], runs: readonly PromiseSettledResult<void>[],
    ): LaunchReport => {
      const failures: { mailboxId: string; err: unknown }[] = [];
      runs.forEach((r, i) => {
        if (r.status !== "rejected") return;
        // A first drain that ended on one of our ceilings fails the launch: name which.
        const ceiling = isImapBoundExceeded(r.reason) ? r.reason : null;
        log("mailbox_start_failed", {
          err: r.reason, ceiling: ceiling?.bound ?? null, ceilingLimit: ceiling?.limit ?? null,
        });
        failures.push({ mailboxId: all[i]?.mailboxId ?? "", err: r.reason });
      });
      return { failures };
    };
    /** The roster row for an id, or null. Used once, by the boot writes, before any runtime exists. */
    const runtimeRosterRow = (rows: readonly LocalRosterRow[], id: string): LocalRosterRow | null =>
      rows.find((r) => r.id === id) ?? null;
    Object.assign(scope, {
      holdOffer, organizedHereIds, gapCatchupReady, gapOwed, arrivalsSaid, onceForTheAccount, repo, cycleRepo,
      installId, clockCorrections, machineName, runtimes, fence, discardCredentialsFor, signedOutAtOf,
      runtimeRosterRow,
    } satisfies Partial<EngineScope>);
    accountPassesSection(scope, config);


    pressSection(scope, config);

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

    /** The launch's one warm-up search (`search-warmup.ts`), armed by the first settled drain. */
    scope.searchWarmup = null;
    Object.assign(scope, {
      isSeedRow,
    } satisfies Partial<EngineScope>);
    const attachLocal = async (mb: LocalRosterRow, isSeed: boolean): Promise<LocalMailboxRuntime> => {
      const box = {} as MailboxScope;
      await loginSection(scope, box, config, mb, isSeed);
      connectionSection(scope, box, config, mb);

      stateSection(scope, box, config, mb);

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
      if (box.priorStandDown) await box.standDownAppointments(box.priorStandDown as MailboxDisabledReason);

      claimSection(scope, box, config, mb);

      sendsSection(scope, box, mb);

      drainSection(scope, box, config, mb);

      loopSection(scope, box, mb);

      dialSection(scope, box, mb);

      runtimeSection(scope, box, config, mb, isSeed);
      runtimes.add(box.rt);
      return box.rt;
    };
    scope.attachLocal = attachLocal;

    await rosterStartSection(scope, config);

    windowServicesSection(scope, config);

    /**
     * THE QUIT: THE STORE CLOSES FIRST, THE NETWORK GOODBYES BESIDE IT. The shell kills at its
     * grace, and the store close used to queue behind every mailbox's claim release and LOGOUT,
     * each allowed a whole drain interval: on a slow server the kill landed first and the store
     * stayed recorded open with its lock behind. So the passes and the search backfill get until
     * `passBy`, a pass still running is cut by destroying its socket, and the store closes as soon
     * as the writers let go while the goodbyes run until `goodbyeBy`.
     *
     * THE DOORS' REQUESTS ARE WRITERS UNTIL `requestsBy`, later than the passes: a request is what
     * the person pressed, and its last act is a store write — a send's finalize, a removal's wipe.
     * Cut at `passBy`, a send went out and was recorded pending (and `unverified` when its Sent copy
     * had failed), and a removal answered 503 with the mail still on disk. `requestsBy` is the
     * instant that still leaves the measured close reserve before the deadline, so a request that
     * ends inside it records what it did; one still running past it stays a goodbye below.
     */
    const quit = async (plan: QuitPlan): Promise<QuitReport> => {
      const began = monotonic();
      const passBy = began + plan.passMs;
      const requestsBy = began + Math.max(plan.passMs, plan.requestsMs);
      offerBy = requestsBy - QUIT_OFFER_RESERVE_MS;
      const since = (): number => Math.round(monotonic() - began);
      scope.searchWarmup?.stop();
      const leaving = leavingForRestart ? "restart" : "quit";
      // The quit leaves each organized mailbox's settings, as a writer, before its claim goes back.
      const detaching = runtimes.all().map((r) => r.detachBy(
        leaving, { passBy, goodbyeBy: began + plan.goodbyeMs }, { leaveSettings: leaving === "quit" },
      ));
      const writer = async (work: Promise<unknown>, by: number): Promise<number> => {
        await settledWithin(work, by - monotonic());
        return since();
      };
      const [requestsMs, backfillMs, mailboxesMs] = await Promise.all([
        writer(plan.requests ?? Promise.resolve(), requestsBy),
        writer(Promise.all([scope.searchBackfill?.stop(), scope.htmlWordsBackfill?.stop()]), passBy),
        writer(Promise.all(detaching.map((d) => d.passSettled)), passBy),
      ]);
      /* A quarter second at least, for a pass cut at `passBy` to unwind its last statement, or a
         request cut at `requestsBy` its own. */
      const closing = Promise.resolve(opened.close({ waitMs: Math.max(250, began + plan.storeWaitMs - monotonic()) }));
      /* The requests still running stay a goodbye: a send past its SMTP start keeps the process
         (and its leased connection, see `closeAll`) until it ends or `goodbyeBy`. */
      const goodbyes = Promise.all([
        ...detaching.map((d) => d.done),
        sendConnections.closeAll({ withinMs: Math.max(0, began + plan.goodbyeMs - monotonic()) }).then(() => false),
        settledWithin(plan.requests ?? Promise.resolve(), began + plan.goodbyeMs - monotonic()).then(() => false),
      ]).then((forced) => ({ forced: forced.filter(Boolean).length, at: since() }));
      const [store, bye] = await Promise.allSettled([closing, goodbyes]);
      const closed = store.status === "fulfilled" ? store.value : undefined;
      const report: QuitReport = {
        requestsMs,
        passesMs: Math.max(backfillMs, mailboxesMs),
        storeWaitMs: closed?.waitedMs ?? 0,
        storeCloseMs: closed?.terminateMs ?? 0,
        goodbyesMs: bye.status === "fulfilled" ? bye.value.at : since(),
        forced: bye.status === "fulfilled" ? bye.value.forced : 0,
      };
      if (store.status === "rejected") throw new QuitLeftOpenError(store.reason, report);
      return report;
    };

    requestDoorSection(scope, config);
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
      handle: scope.handle,
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
              scope.attention.note(req.method, new URL(req.url).pathname);
              const match = matchRoute(desktopHostRoutes, req.method, new URL(req.url).pathname);
              if (match.matched || match.methodNotAllowed) return scope.asPerson(req, () => hostApp.handle(req, scope.depsForHost()));
              return hostStatic!.serve(req, new URL(req.url));
            },
            // The LAN door, present IFF the operator also chose an interface: the SAME table and
            // the SAME per-request deps as the Tailscale door — one composition, two sockets —
            // and the API-only static half in place of the packaged client. Which handler a
            // socket was given decides, structurally; no header is consulted.
            ...(lan.address !== null
              ? {
                  handleLan: async (req: Request): Promise<Response> => {
                    scope.attention.note(req.method, new URL(req.url).pathname);
                    const match = matchRoute(desktopHostRoutes, req.method, new URL(req.url).pathname);
                    if (match.matched || match.methodNotAllowed) {
                      const answered = await scope.asPerson(req, () => hostApp.handle(req, scope.depsForHost()));
                      scope.noteDoorWrite(req, answered);
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
        ?? { organizing: false, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
          releaseRequestedAt: null, claimed: false, releaseRefusal: null, holderState: null },
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
      leave: (): void => {
        for (const rt of runtimes.all()) rt.leave();
      },
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
      resume: async () => {
        const runs = runtimes.all();
        const settled = await Promise.allSettled(runs.map((rt) => rt.resume()));
        const refused = settled.flatMap((r, i) => (r.status === "rejected"
          ? [{ mailboxId: runs[i]!.mailboxId, reason: r.reason as unknown }]
          : []));
        /* THE COUNTS ARE CARRIED, not dropped: a runtime answers `0` for a forced cycle that
           failed without throwing, and only the count says the mailbox was not taken back. */
        if (refused.length === 0) {
          return settled.map((r, i) => ({
            mailboxId: runs[i]!.mailboxId,
            served: r.status === "fulfilled" ? r.value : 0,
          }));
        }
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
      settingsLeftOnlyHere: async (mailboxId: string, opts?: { leaving?: boolean }) => {
        const rt = runtimes.all().find((r) => r.mailboxId === mailboxId);
        return rt === undefined ? null : rt.profileSync.settingsLeftOnlyHere(opts);
      },
      credentialState: async () => (await seedRuntime()?.credentialState()) ?? "absent",
      forgetStoredLogin: async (opts) => (await seedRuntime()?.forgetStoredLogin(opts)) ?? false,
      probeSubmission: async (input) => makeSmtpProbe(scope.ownDeps(), scope.smtpProbeOpts)({
        accountId: world.accountId, address: input.address, smtp: input.smtp,
      }),
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
        return launchReport(all, await Promise.allSettled(all.map((r) => r.start())));
      },
      /* THE SAME LAUNCH, and the seed's dial beside it — see {@link Sidecar.startAnswering}. */
      startAnswering() {
        const all = runtimes.all();
        const answering = all.map((r) => r.startAnswering());
        const seed = seedRuntime();
        const at = seed === undefined ? -1 : all.indexOf(seed);
        return {
          report: Promise.allSettled(answering.map((a) => a.started)).then((runs) => launchReport(all, runs)),
          seedDial: at === -1 ? Promise.resolve(null) : answering[at]!.dial,
        };
      },
      stop: (async (plan?: QuitPlan): Promise<QuitReport | void> => {
        // The INSTALL is going down, which is what the account-scoped passes yield on. Each
        // mailbox's own timer, in-flight cycle and login go with its runtime; the STORE is the
        // install's and is closed once, here, after every mailbox has let go of it.
        scope.stopping = true;
        // FIRST, and it is the only ordering that is correct: the readings are about a running
        // engine, and one taken between the last detach and the store close would describe a
        // process mid-teardown as though it were serving.
        scope.stopVitals();
        if (plan !== undefined) return quit(plan);
        // A round in flight finishes before the store closes under it.
        await Promise.all([scope.searchBackfill?.stop(), scope.htmlWordsBackfill?.stop()]);
        scope.searchWarmup?.stop();
        /* AND THE CLAIM GOES BACK WITH EACH MAILBOX, inside `detach()` — see the block there.
           NOT a `handBack()` pass in front of this one: that queues BEHIND an in-flight cycle, so
           a gate parked in the lease read would run its whole drain before anything told it to
           stop. `detach()` sets `stopped` first and releases after the queue has settled, which is
           the only ordering where both are true. */
        const leaving = leavingForRestart ? "restart" : "quit";
        // The quit leaves each organized mailbox's settings and the instant it let go, before its claim.
        await Promise.allSettled(runtimes.all().map((r) => r.detach(leaving, { leaveSettings: leaving === "quit" })));
        // The send door's kept connections go with the install: nothing outlives the stop.
        await sendConnections.closeAll();
        await opened.close();
      }) as Sidecar["stop"],
      leaving(reason: unknown) {
        /* STRICT: the one word that keeps the claim. Anything else is the quit, and releases. */
        if (reason === "restart") leavingForRestart = true;
      },
      organizedHere: (mailboxId: string) => organizedHereIds.has(mailboxId),
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly, or the next launch
    // finds a directory it cannot open and a message about a process that is already gone.
    await closeAfterFailedStart(opened);
    throw err;
  }
}
