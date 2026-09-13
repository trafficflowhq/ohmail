import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  pruneIdempotencyKeys, pruneSendFingerprints, noticeSinkFor, setNoticeSink, accountSettings, mailboxCredentials, mailboxes,
  messages, folderState, junkSweepCandidateWhere, closeStoodDownAppointments,
  RELEASED_ORGANIZER_SEND_SENTENCE, capabilitiesColumn, exportPendingMovesOnStandDown,
  UNMETERED, isMetered, type EntitlementsComposition,
  type StandDownExport,
} from "@trafficflow/db";
import {
  makeEntitlementsClient, makeOwnedDb, makeChangeWakeHub, type OwnedDb, type ChangeWakeFanout } from "@trafficflow/db/cloud";
import {
  runAlertPass,
  webhookAlertSink,
  resendAlertSink,
  telegramAlertSink,
  sinkHealthOf,
  newDeliveryStreak,
  writeHeartbeat,
  refreshHeartbeat,
  clearHeartbeat,
  resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER,
  /* The retention sweep over `attachment_staging`, and the bucket client it needs. From the
   * CLOUD entry point and never the mail one: staging is a hosted transport and this is a hosted
   * process. The sweep lives beside the rows it deletes rather than beside the send path that
   * mints them, so that running it here costs this process no dependency it does not already
   * have — the worker's deliberately small runtime dependency set, and `test/deps.test.ts` is
   * what keeps that true. */
  makeSupabaseStagingStorage, makeS3StagingStorage, sweepExpiredStagingFor,
  type AlertSink,
  type AlertSinkHealth,
  type AttachmentStagingStorage,
} from "@trafficflow/db/cloud";
import {
  createLogger, silentLogger, resolveOhboxPolicy, resolveScreeningCutoff, DEFAULT_OHBOX_POLICY, type Logger,
  providerAuthservIds,
  MicrosoftTokenProvider, type OAuthTokenProvider, type UpdateSecretPort, type FetchLike,
} from "@trafficflow/core";
import { makeDrizzleRepo, mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import {
  ImapAdapter, ImapConnectionClosedError, WORKER_NET_TIMEOUTS, learnSmtpMaxSize,
  isImapBoundExceeded,
  type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import {
  loadConfig, keyProviderFromKekEnv, selectionOf, instanceIdFrom, WorkerConfigError,
  DEFAULT_MAX_MAILBOXES, DEFAULT_SHARDS, DEFAULT_ROSTER_INTERVAL_MS,
  DEFAULT_LOCK_HEARTBEAT_MS, DEFAULT_MAILBOX_RETRY_MS, DEFAULT_MAX_SYNC_FAILURES,
  DEFAULT_ALERT_INTERVAL_MS, DEFAULT_SYNC_BLOCK_GRACE_MS,
  DEFAULT_LEASE_UNAVAILABLE_DETACH_MS, resolveCycleLanes, CYCLE_FAST_LANES, CYCLE_WAKE_REVISITS,
  type WorkerConfig,
} from "./config.js";
import {
  anyDegradedCause, type DegradedCauses, type UnservedBreakdown,
} from "./health.js";
import { acquireLeaderLock, leaderLockKeyFor, LockLostError, type LeaderLock } from "./leader-lock.js";
import { startApiCron, type ApiCronHandle, type ApiCronTargetHealth } from "./api-cron.js";
import { runSyncCycle, LeaderFencedError, MailboxRemovedError, type SyncDeps } from "./sync.js";
import {
  applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests,
} from "./request-drain.js";
import {
  adoptSweepWindow, junkSweepPass, sweepStateForPress, SWEEP_SCAN_START,
  type SweepScanState,
} from "./junk-sweep.js";

/**
 * How many Quarantine members one cycle's sweep slice may move — the filing budget's argument
 * (`RECONCILE_MOVES_PER_CYCLE`) applied to the one-time sweep: a large pile rotates through the
 * serial queue rather than holding it, and the command stands until the pile is drained.
 */
const JUNK_SWEEP_PER_CYCLE = 200;
import { makeStorageCapResolver } from "./storage-cap.js";
import { DeadLetterLedger, isDatabaseFault, isSharedDatabaseFault } from "./dead-letter.js";
import { KnownSetCache } from "./known-set.js";
import { markDatabaseFaults, asDatabaseFault } from "./db-fault.js";
import { runKickstart } from "./kickstart.js";
import {
  runThreadBackfill, THREAD_BACKFILL_SLICE_MS, THREAD_BACKFILL_SLICE_PAGES,
} from "./thread-backfill.js";
import { makeClassifierCircuit, ClassifierFaultError, type ClassifierCircuit } from "./ai-circuit.js";
import { workflowDrainPass, workflowTimeScanPass, unconfiguredDrafter } from "./workflow-cron.js";
import { bubbleUpPass } from "./bubble-up-cron.js";
import { threadJoinHealPass, type ThreadJoinHealCursor } from "./thread-join-heal.js";
import { inboundQuietPass } from "./inbound-quiet.js";
import { makeAwayReplySweep } from "./away-reply-sweep.js";
import { ruleRetroPass } from "./rule-retro.js";
import { gateReleasePass } from "./gate-release.js";
import { apiFaultPrunePass } from "./api-fault-prune.js";
import { ohboxTidyPass } from "./ohbox-tidy.js";
import { screenerAutoApplyPass } from "./screener-auto.js";
import { screenerAutoSuggestPass } from "./screener-auto-suggest.js";
import { syncKickPass } from "./sync-kick.js";
import { sensitiveBackfillPass } from "./sensitive-backfill.js";
import { storageEvictPass } from "./storage-evict.js";
import { isCliEntry, flushExit, installCrashHandlers } from "./entry.js";
import {
  startPushWake, pushEndpointGuardFromEnv, vapidFromEnv, type RunningPushWake,
} from "./push-wake.js";
import { driverWriteRaceReason } from "./driver-write-race.js";
import { recordSmtpMaxSize, smtpSizeDial } from "./smtp-size.js";
import type { Tx, OrganizerRole, OrganizerState } from "@trafficflow/db";
import {
  loadEnabledMailboxes, loadMailboxCreds, loadMailboxById, bootstrapEnvCreds,
  markMailboxFailed, markMailboxReadLimited, markMailboxConnected, markMailboxStoodDown,
  clearOrganizerStandDown,
  markMailboxReleased, refreshOrganizerHolder,
  markMailboxSyncBlocked, clearMailboxSyncBlock,
  classifyMailboxError, mailboxErrorDetail,
  stampMailboxSyncNow, stampInitialImportComplete, makeSyncWriteFence, type LeaderFence,
  accountsOf, loadServedAccounts, accountInShard,
  type EnabledMailbox, type MailboxDisabledReason, type MailboxErrorPhase,
  type MailboxSyncBlockReason,
} from "./mailboxes.js";
import { OrganizerProfileSync, syncProfileMirror } from "./profile.js";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import {
  readMailboxLease, acquireLeasePermit, releaseMailboxClaim, cloudInstallId, CLOUD_DISPLAY_NAME,
  LeaseUnavailableError, leaseBlockReason, leaseStoodDown, DEFAULT_STALE_AFTER_MS,
  type OrganizerWriteAuthority,
  type LeaseSelf, type LeasePeekCapableAdapter,
} from "./lease.js";
// The APPEND-less read of `ohmail/_meta` — see `LeasePeekCapableAdapter`. A reader LOOKS at the
// lease every cycle to keep `organizer_state` and the holder columns honest, and looking must
// never write a claim: `readLeasePeek` takes the read-only IO and creates nothing.
import {
  readLeasePeek, answerLeasePeek, deriveRequestKey, type OrganizerIntent,
} from "@trafficflow/core/adapters/organizer-lease";

/** How often the leader runs the global maintenance pass (expired-idempotency-key sweep). */
export const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

/**
 * How often the leader runs the BUBBLE-UP RESURFACING pass, and NOT CONFIGURABLE. There is no
 * `TF_BUBBLE_UP_EVERY_MS` deliberately: an env var is the "absent config selects the dangerous
 * branch" trap — an unset `?? SOMETHING` picks a period nobody chose, and the failure is silent (a
 * snoozed message resurfaces late, or a deployment meaning 60 s runs the pass hourly). 60 s because
 * that is the granularity the promise is made at — `AppShell`'s resurface names a wall-clock minute
 * and `pollIntervalMs` is 60 s anyway, so a shorter period buys nothing but extra queries.
 */
export const BUBBLE_UP_EVERY_MS = 60_000;

/**
 * How often the leader runs the THREAD-JOIN HEAL, and NOT CONFIGURABLE — a `const` for {@link
 * BUBBLE_UP_EVERY_MS}'s reason: an unset `?? something` would silently pick a period nobody chose.
 * Six hours, not sixty seconds, because the pass repairs a presentation defect, not a promise: a
 * conversation a forward split renders as two threads until the heal joins them, and the joining
 * evidence (`conversationJoinVerdict`) needs the counterparty's REPLY to have arrived, which takes
 * hours to days. Every cycle would be a fleet-wide GROUP BY bought against no user-visible latency.
 */
export const THREAD_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * How often the leader runs the INBOUND-QUIET pass (the forwarding-detection heuristic,
 * mail 0078), and NOT CONFIGURABLE — a `const` for the reason {@link BUBBLE_UP_EVERY_MS} is:
 * an unset `?? something` would silently pick a period nobody chose.
 *
 * Six hours, {@link THREAD_JOIN_HEAL_EVERY_MS}'s cadence and for the same shape of reason: the
 * pass judges windows measured in WEEKS (`INBOUND_QUIET_WINDOW_MS` is fourteen days), so the
 * verdict cannot change between two cycles in any way a user could perceive, and every cycle
 * would be a fleet-wide grouped aggregate bought against no user-visible latency.
 */
export const INBOUND_QUIET_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * How soon the away-reply sweep retries while it is still owed — fifteen minutes. The sweep runs
 * ONCE PER WORKER PROCESS and its gate closes only on an attempt in which every account walked to
 * exhaustion; this interval governs the case where it did NOT (an account that threw, or hit the
 * safety bound), which would otherwise repeat on every cycle — a hot loop for a persistently failing
 * account. It starts DUE, so the first attempt is the first cycle after start. The pass is a REPAIR:
 * once a release carrying `autoReplyByUs` reaches every client, this and the pass it calls can be
 * deleted outright, which is why there is no daily belt.
 */
export const AWAY_REPLY_REDELIVER_RETRY_MS = 15 * 60 * 1000;

/**
 * ENFORCED SYNC — how often the worker scans for mailboxes the API has stamped `sync_requested_at`.
 *
 * Far shorter than `pollIntervalMs` (60 s) on purpose: this exists to close the gap between a user
 * doing something — sending a message, moving a folder — and seeing it reflected in their own
 * mirror. 3 s is short enough to read as "immediate" and long enough that the scan (one indexed
 * read over the served set) is free. It is a `const`, not an env var, for the same reason
 * {@link BUBBLE_UP_EVERY_MS} is: an unset `?? something` here would silently pick a latency nobody
 * chose. See `sync-kick.ts` and `mailboxes.sync_requested_at` (mail 0049).
 */
export const SYNC_KICK_EVERY_MS = 3_000;

/** Live scheduling counters for the health endpoint. */
export interface WorkerStats {
  /** Mailboxes connected and in the rotation (a quarantined one is NOT counted). */
  mailboxes: number;
  /** Accounts whose per-account passes this process runs (its shard's duty). */
  accounts: number;
  /** Enabled mailboxes this process is SUPPOSED to serve, after the cap. */
  expected: number;
  /** Selected mailboxes detached behind a retry backoff (status='error'). */
  quarantined: number;
  /** Selected mailboxes with no `imap` credential row yet — enabled but unsyncable. */
  awaitingCredentials: number;
  /** Enabled mailboxes dropped by `maxMailboxes` — nothing in this process serves them. */
  truncated: number;
  /**
   * Serving strictly less than the roster says it should — `anyDegradedCause(causes)`, and the
   * `worker_heartbeats.degraded` column. Derived, so it can never be true without {@link causes}
   * naming something.
   */
  degraded: boolean;
  /** WHY {@link degraded} is what it is. The supervisor hands this straight to `evaluateHealth`. */
  causes: DegradedCauses;
  /** The shortfall, decomposed — published on `/health` as `unserved`. */
  unserved: UnservedBreakdown;
  /**
   * When THIS PROCESS'S DATABASE started failing, or null while it is answering.
   *
   * A shared-dependency fault is the one incident this worker cannot record by writing it down,
   * so it is published here and on `/health` — the two surfaces that keep working when Postgres
   * does not. Non-null also means the roster is intact: nothing was quarantined for it, and the
   * next cycle that completes clears it.
   */
  databaseFaultSince: Date | null;
  /** The lock was lost and this worker has quiesced (split-brain guard). */
  lockLost: boolean;
  /**
   * Messages this process's attached mailboxes could not ingest on three or more attempts
   * (`ESCALATE_AFTER_ATTEMPTS`) — recorded, still probed once per deployed build, and no longer
   * plausibly one deploy away from working. A COUNT and nothing else: which mailbox and which UID
   * are in `message_failures` and in the log, and neither belongs on a public endpoint. Nothing
   * PAGES on this number — `/health` is polled, not alerted on — so it is a window, not an alarm; the
   * path that pages is a heartbeat column plus a fifth alert rule, a cloud migration of its own.
   */
  escalatedMessages: number;
  /**
   * The last cycle in which at least one mailbox actually SYNCED (or in which there was
   * genuinely nothing to sync). Deliberately NOT "the last time the timer fired": an empty
   * or all-failed cycle must not refresh freshness, or `/health` lies about a dead leader.
   */
  lastCycleAt: Date | null;
  /**
   * Every configured pager arm, and whether it is actually delivering. The startup line has always
   * named the arms (`alertSinks:["mail"]`), and a name is not a state: an arm that has refused every
   * delivery since it was configured appears in that list exactly like a working one, and did — the
   * webhook arm sat in it, dead, for months, and a second vendor makes that worse, because the
   * surviving arm keeps pages landing and there is then no symptom at all. So the standing per-arm
   * verdict is published — closed codes, counts, timestamps, never the vendor's error sentence — and
   * a `lastOkAt: null` with `attempts: 0` is the honest report for an arm nobody has exercised.
   */
  alertSinks: AlertSinkHealth[];
  /**
   * THE API-CRON SCHEDULE'S STANDING REPORT — one entry per internal API route this worker
   * drives on a clock (`api-cron.ts`), in the table's order. `[]` on a deployment that armed
   * no `TF_API_CRON_URL`/`TF_API_CRON_SECRET` pair, on every shard but 0, and on a standby.
   *
   * Here for the reason `alertSinks` is: the layer this replaced failed by SAYING NOTHING —
   * a schedule that stops must be a row an operator can read going stale (`lastOkAt` ageing
   * past `everySeconds`), not an absence. Closed codes and clocks only; a memory read, so
   * `/health` still touches no database.
   */
  apiCron: ApiCronTargetHealth[];
}

export interface RunningWorker {
  stop(): Promise<void>;
  stats(): WorkerStats;
}

export interface WorkerHooks {
  /**
   * The advisory lock is provably gone (session dropped / another backend owns it). The
   * worker has ALREADY quiesced — every mailbox detached, every timer cleared — so this is
   * purely the signal for the supervisor to stop advertising leadership and go 503.
   */
  onLockLost?: (err: LockLostError) => void;
  }

/** A mailbox that connected successfully and is now part of the sync rotation. */
interface MailboxRuntime {
  accountId: string;
  mailboxId: string;
  adapter: MailboxAdapter;
  /**
   * The signing key for this mailbox's request channel, or `null` when there is no shared secret.
   * Derived from the mailbox PASSWORD at attach (`deriveRequestKey`, HKDF salted with the address)
   * and held for the life of the runtime rather than recomputed per cycle. Derived HERE because this
   * is where the credential is decrypted; nothing downstream has one or should. `null` for an OAuth
   * mailbox: each install holds its own token, so there is no secret both sides share and no key to
   * derive, and every consumer treats that as "this mailbox has no request channel".
   */
  requestKey: string | null;
  deps: SyncDeps;
  unwatch: (() => Promise<void>) | null;
  /** Consecutive runtime sync failures; at `maxSyncFailures` the mailbox is detached. */
  failures: number;
  /**
   * When this runtime last completed a `runSyncCycle` — and `null` means it never has.
   *
   * Set ONLY in `cycle()`. `attach()` used to set it too, back when it drained inline, and now
   * that attach syncs nothing it would be a lie in the one direction that matters: it is the evidence the roster
   * pass reads before converging a row to `connected`, so an attach that sets it would let a
   * mailbox that has never synced be called connected 30 seconds later.
   */
  lastSuccessAt: Date | null;
  /**
   * This mailbox's row says something other than `connected` and this process owes it a recovery
   * write — spent by `cycle()` after the first SUCCESSFUL `runSyncCycle`, never by `attach`.
   *
   * A boolean on the runtime rather than a re-read of the row, because the decision is about what
   * THIS attach observed: `mb.status` is re-read every roster pass, so a mailbox recovered by the
   * roster's own converge path would otherwise be re-written by the next cycle for ever.
   */
  needsRecovery: boolean;
  /**
   * `Date.now()` when this runtime's cycle FIRST failed to read the organizer lease, or `null`
   * whenever the lease has answered at all since. `LeaseUnavailableError` is exempt from
   * `maxSyncFailures` BY CLASS in `cycle()`, correctly — an infrastructure fault must never write
   * `status='error'` — but a membership test can say "this cycle could not read the lease", not "for
   * how long", so nothing could tell a provider blip from a socket that died ten minutes ago (one
   * incident sat every mailbox there for most of an hour reporting `leader`, `serving`). On the
   * runtime because it is a property of ONE connection — a detach resets it to `null`, which is right,
   * the new connection has failed nothing yet. Cleared whenever `mayOrganize` RESOLVES either way.
   */
  leaseUnavailableSince: number | null;
  /**
   * The nonce of the last organizer claim THIS process wrote for THIS mailbox.
   *
   * In memory and per mailbox, both deliberately. Per mailbox because each mailbox's claim
   * carries its own nonce; in memory because persisting it would break own-role resumption —
   * after a restart we would not recognise our own claim and would stand down from a mailbox
   * nobody else wants. The engine's `LeaseSelf` documents the whole clone defence; this field is
   * just where the worker keeps its half of it, and a fresh runtime starting at `null` is the
   * designed trade rather than an omission.
   */
  leaseNonce: string | null;
  /**
   * WHAT THIS MAILBOX'S WRITES RIDE ON — the permit the last gate took, or the named reason there
   * is none. Written by `mayOrganize` on both arms and handed to `runSyncCycle`, so every
   * destructive write inside the cycle asks the lease again instead of resting on the cycle's
   * opening read.
   */
  leasePermit: OrganizerWriteAuthority;
  /**
   * The lease-relevant columns of this mailbox's row, as the last roster pass read them.
   *
   * Re-read every `TF_ROSTER_INTERVAL_MS` rather than captured at attach, because
   * `takeover_authorized_at` is stamped by ANOTHER process (the connect flow) while this one is
   * already serving the mailbox. A value captured once would mean a user's explicit "yes, move
   * this to Cloud" did nothing until the worker happened to restart.
   */
  lease: {
    takeoverAuthorizedAt: Date | null;
    /**
     * Mail 0104. WHAT THAT PRESS ASKED FOR — `takeover` asks for the mailbox whoever holds it,
     * `join` asks only for one nobody is organizing. Read in the same statement as the stamp and
     * meaningless without it; Cloud's own door writes `takeover`, so this reads `takeover` for
     * every press a person makes here, and the field exists because the FENCE is shared with an
     * install that has no takeover verb.
     */
    takeoverIntent: OrganizerIntent;
    disabledReason: string | null;
    /**
     * Mail 0083. WHAT THE ROW SAYS THE ROLE IS — which is not the same thing as what this process
     * is doing (`MailboxRuntime.role` carries that) and is why both exist.
     *
     * The gate needs it for one decision: whether a promotion has a row to flip. That used to be
     * `takeoverAuthorizedAt || disabledReason` and the second term was the whole of "this row is
     * stood down" — until 0083 moved the stand-down onto the role and left `disabled_reason` with
     * no writer, at which point a consented reader whose foreign claim had simply gone away was
     * promoted by the lease and never written back.
     */
    organizerRole: OrganizerRole;
    /**
     * Mail 0083. NULL means NOBODY HAS ASKED THIS INSTALL TO ORGANIZE THIS MAILBOX, which is the
     * state `POST /mailboxes` now creates. It is read by the gate for one purpose and it is the
     * purpose the whole reader mode turns on: a consent-less mailbox must never be promoted by an
     * EMPTY `ohmail/_meta`. `decideLease`'s "nobody has ever organized this mailbox" arm organizes
     * on an empty folder, which is right for a mailbox somebody consented to and is a seizure for
     * one they merely connected.
     */
    organizeConsentedAt: Date | null;
    /**
     * Mail 0088. THE PERSON ASKED THIS INSTALL TO STOP ORGANIZING THIS MAILBOX AND KEEP THE MAIL.
     *
     * The mirror of {@link takeoverAuthorizedAt} in every respect that matters here: written by
     * ANOTHER process while this one is already organizing, re-read every roster pass for that
     * reason, and spent by the first gate that honours it. The gate takes it BEFORE the lease read
     * — see the arm at the top of `mayOrganize` for why reading the lease first would renew a claim
     * this install is about to delete.
     */
    releaseRequestedAt: Date | null;
  };
  /**
   * Mail 0083. WHAT THE ROW ALREADY SAYS THE HOLDER IS, so a reader's per-cycle peek writes only
   * when something CHANGED.
   *
   * Seeded from the roster row at attach and updated in place by `refreshReaderHolder`. Without
   * it a reader would issue one `UPDATE mailboxes` per poll interval per mailbox for ever, to
   * write the four values that are already there — the same "zero writes in the steady state"
   * rule `clearMailboxSyncBlock` and `clearOrganizerStandDown` each keep for their own columns.
   */
  holderSeen: {
    kind: string | null; name: string | null; since: Date | null; state: string | null;
    /** Mail 0089 — the fifth holder column, tracked beside the other four for the same reason. */
    capabilities: string | null;
    /** Mail 0092 — the sixth. Tracked here because the compare, not the write, is what decides
        whether a stale id is ever corrected; see the note on the compare in `refreshReaderHolder`. */
    installId: string | null;
  };
  /**
   * Mail 0083. What this process IS to this mailbox right now — and it is MUTABLE, unlike almost
   * everything else on a runtime, because the role can flip in either direction without a
   * re-attach: a human authorizes a claim-back and the next gate promotes; another install takes
   * over and the next gate demotes. Both used to require a detach (a demotion left the roster
   * entirely), and neither does now.
   *
   * It is what `runSyncCycle` receives as `SyncDeps.role`, read at the cycle rather than captured
   * on `deps`, so a flip applies on the very next pass.
   */
  role: OrganizerRole;
  /**
   * This mailbox's LAST cycle ended still owing work — a truncated inbound batch (`hasBacklog`) or
   * filing that hit the reconciler's per-cycle budget (`owesFiling`). It is what the rotation's
   * fast-lane reservation keys on, and it is the mailbox's OWN report rather than a guess from its
   * size (a finished-importing huge mailbox is light, a small mid-first-import one heavy); the same
   * two flags already drive the `backfill_progress` re-kick. FALSE at attach, deliberately: a fresh
   * runtime has said nothing yet, and presuming it heavy would hold the whole shard's first pass out
   * of the reserved lane — at boot every mailbox is fresh, so it would make the first rotation the narrowest.
   */
  owesBacklog: boolean;
  /**
   * The portable organizer profile's write-behind state for this attachment
   * (`apps/worker/src/profile.ts`). Per attachment for the known-set memo's reason: a mailbox
   * that changes hands starts cold and re-reads what `ohmail/_meta` actually holds.
   */
  profile: OrganizerProfileSync;
  /**
   * `Date.now()` of the OLDEST unserved wake for this mailbox — its IDLE fired, or the sync-kick
   * channel named it — or `null` when nothing is owed. `adapter.watch(() => kickCycle())` schedules
   * a rotation, not a visit, so a mailbox whose doorbell rang went to the back of the queue behind
   * every other mailbox on the shard (a measured 15.5-minute gap on a sub-second wake channel).
   * Recording WHICH mailbox rang turns the kick into a priority: oldest wake first, the same
   * oldest-first rule the rest of this file uses. Cleared when the mailbox is ADMITTED to a lane, not
   * when the cycle completes — a wake arriving DURING its own visit is about mail that landed after
   * `changesSince`, and clearing on completion would swallow it.
   */
  wokenAt: number | null;
}

/** A detached mailbox waiting out its exponential retry backoff. */
interface Quarantine {
  attempts: number;
  retryAt: number;
  reason: string;
  /**
   * Mail migration 0039's column. Did `retry_after` actually get written for this mailbox? A flag,
   * not "just read the column", because `retry_after IS NULL` has to mean exactly one thing before it
   * can be a release signal, and without this it means two: "an operator cleared it" and "the durable
   * write never landed". The second is normal — `markMailboxFailed` is fenced and best-effort against
   * a database that may be the very thing broken. Conflated, the roster gate reads NULL as "try now",
   * the attach fails again, the write fails again, and the mailbox is re-dialled every
   * `rosterIntervalMs` — the silent DoS against a customer's provider `attach()`'s end forbids. So
   * the column governs only when we know it is OURS.
   */
  persisted: boolean;
}

/**
 * The always-on worker. ONE process, ONE leader lock per shard; it then syncs ALL enabled mailboxes
 * of ALL accounts in its shard (a second registered account is never silently unsynced), reading each
 * mailbox's credentials from `mailbox_credentials` (envelope-decrypted via the KeyProvider). The
 * roster is LIVE, not a startup snapshot: a `TF_ROSTER_INTERVAL_MS` pass re-reads the shard and
 * reconciles the runtime map, so accounts that registered after boot connect without a restart and
 * disabled/deleted mailboxes are closed. Failure isolation is per mailbox (marked `error`, detached,
 * backed off, never aborting others); cycles and roster passes are SERIALIZED on one queue, and a
 * cycle SERVES an owed roster pass from inside its entry, visiting up to `cycleLanes` mailboxes at once. SECURITY: this host holds KEK material to decrypt credentials — same trust level as the API.
 */
export async function startWorker(config: WorkerConfig, hooks: WorkerHooks = {}): Promise<RunningWorker> {
  const lock: LeaderLock | null = await acquireLeaderLock(
    config.databaseUrl, leaderLockKeyFor(config.shardIndex ?? 0),
  );
  if (!lock) throw new Error("another worker holds the leader lock; exiting");
  return startWorkerWithLock(config, lock, hooks);
}

/**
 * The worker body, entered with the shard's leader lock ALREADY held. Split out for the
 * standby supervisor, which must acquire the lock itself so a lock-held start can
 * wait instead of exiting. On any startup failure it closes its DB pool and RELEASES the
 * lock, so a standby can take over instead of the shard going dark behind a held lock.
 */
export async function startWorkerWithLock(
  config: WorkerConfig, lock: LeaderLock, hooks: WorkerHooks = {},
): Promise<RunningWorker> {
  const owned: OwnedDb = makeOwnedDb(config.databaseUrl);
  const db = owned.db;
  // Declared out here so a failure LATER in startup (e.g. a roster pass that rejects) still
  // closes the IMAP connections it already opened — a leaked login is exactly what gets a
  // provider to throttle the user's mailbox.
  const runtimes = new Map<string, MailboxRuntime>();
  /** The same, for the timers: the startup catch must be able to disarm them (see below). */
  let stopTimers: (() => void) | null = null;

  try {
    // ── EVERY SYNC-LOOP DATABASE CALL NAMES ITS ORIGIN ─────────────────────────────────────
    //
    // `SyncDeps.repo` is the one object through which `runSyncCycle` reaches Postgres, and
    // wrapping it here is what makes "is this the shared database or this customer's provider"
    // an answerable question rather than a guess from an error code. Measured shapes and the
    // full argument: `db-fault.ts`. The other seam — the fence's own transaction — is wrapped in
    // `makeSyncWriteFence`.
    const repo = markDatabaseFaults(makeDrizzleRepo(db), "repo");

    const maybeKeyProvider = config.keyProvider ?? keyProviderFromKekEnv(process.env);
    if (!maybeKeyProvider) {
      throw new Error("worker requires a KeyProvider: set TF_KEK_V1 (64 hex) or pass config.keyProvider");
    }
    const keyProvider = maybeKeyProvider;

    // OAuth2 (Exchange/M365) token source — one per process, per-mailbox cache. Constructed
    // UNCONDITIONALLY, even with no `MS_OAUTH_*` and no oauth mailboxes: the refusal for a missing
    // client secret must NAME the missing variable, which only happens if the provider exists to be
    // asked; a password-only deployment simply never invokes it (an oauth row is the only thing that
    // reaches `fetchAccessToken`). The rotated-token write targets the mailbox's OWN imap row and is
    // the only write this port makes — ONE WRITER shared with the API host
    // (`rotateMailboxOAuthSecret`), whose `transport = 'imap'` predicate stops a rotation
    // overwriting an unrelated smtp row and is not a thing to state twice.
    const updateSecret: UpdateSecretPort = (mailboxId, ciphertextEnc, keyVersion) =>
      rotateMailboxOAuthSecret(db, {
        mailboxId, ciphertext: ciphertextEnc, keyVersion, now: new Date(),
      });
    /**
     * The registration is resolved AT TOKEN TIME, from the config store, with env as the fallback —
     * not at boot. An Entra client secret expires on Azure's schedule, and when it does every oauth
     * mailbox stops refreshing silently, because `refreshAccessToken` classifies a rejected client as
     * "we could not ask" rather than a dead credential, so nothing quarantines or pages. The remedy
     * is an operator pasting a new secret, and this process may not have restarted for weeks, so the
     * value is read on the refresh path through the SAME resolver (`resolveOAuthProviderConfig`) the
     * API uses. `enabled` is NOT consulted — it is the ONBOARDING switch, and refusing to refresh an
     * already-connected mailbox because onboarding is off would take working mailboxes down.
     */
    const oauthTokenProvider: OAuthTokenProvider = new MicrosoftTokenProvider({
      clientId: config.msOAuth?.clientId ?? "",
      clientSecret: config.msOAuth?.clientSecret ?? "",
      defaultTenant: config.msOAuth?.tenant ?? "common",
      resolveClient: async (want) => {
        /*
         * The public door is a different registration and it is NOT in the config store. A mailbox
         * connected through the device-code flow holds a refresh token issued by the PUBLIC
         * application, and only that application can renew it — and this process is the organizer on a
         * self-hosted install, so it must do so for ever. It resolves the public client from the
         * environment alone: there is no `oauth_provider_config` arm for it, because that table's
         * content is the confidential registration an operator manages, and this composition has no
         * admin console. `kind: "public"` is STATED — unlabelled, the token client defaults it to
         * `confidential` and demands a secret a public registration lacks.
         */
        if (want === "public") {
          return {
            clientId: config.msDevice?.clientId ?? "",
            clientSecret: "",
            defaultTenant: config.msDevice?.tenant || "common",
            kind: "public",
          };
        }
        const resolved = await resolveOAuthProviderConfig({
          tx: db,
          decrypt: (ct, kv) => keyProvider.decrypt(ct, kv),
          bootstrap: {
            clientId: config.msOAuth?.clientId ?? "",
            clientSecret: config.msOAuth?.clientSecret ?? "",
            tenant: config.msOAuth?.tenant ?? "",
            redirectUri: config.msOAuth?.redirectUri ?? "",
          },
          provider: MICROSOFT_PROVIDER,
        });
        return {
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret,
          defaultTenant: resolved.tenant || (config.msOAuth?.tenant ?? "common"),
          // Stated for the same reason the public arm states its own: this is the confidential
          // registration, and the token client re-checks that the door it asked for is the door
          // that answered. An unlabelled return would pass by defaulting, which is exactly the
          // kind of agreement-by-coincidence the explicit kind exists to remove.
          kind: "confidential",
        };
      },
      keyProvider,
      updateSecret,
      // Node's global fetch. Cast because `FetchLike` is the narrow slice this client uses; the
      // shapes are structurally compatible (Response carries ok/status/json/text).
      fetch: globalThis.fetch as unknown as FetchLike,
    });

    // One-shot bootstrap: seed the legacy single env mailbox's DB creds exactly once.
    // No-op when a (mailboxId,'imap') row already exists — env never overwrites. This is
    // now the ONLY use of `config.accountId` in the worker: it VALIDATES the pairing, so a
    // stale TF_ACCOUNT_ID next to a live TF_MAILBOX_ID is a loud refusal instead of a
    // credential row written under the wrong account.
    if (config.mailboxId && config.imap) {
      const row = await loadMailboxById(db, config.mailboxId);
      if (!row) throw new Error(`TF_MAILBOX_ID ${config.mailboxId} does not exist`);
      if (config.accountId && row.accountId !== config.accountId) {
        throw new Error(
          `TF_ACCOUNT_ID ${config.accountId} does not own TF_MAILBOX_ID ${config.mailboxId} ` +
          `(it belongs to account ${row.accountId}); refusing to bootstrap credentials`,
        );
      }
      await bootstrapEnvCreds(db, keyProvider, {
        mailboxId: config.mailboxId, imap: config.imap, smtp: config.smtp,
      });
    }

    const shards = config.shards ?? DEFAULT_SHARDS;
    const shardIndex = config.shardIndex ?? 0;
    const maxMailboxes = config.maxMailboxes ?? DEFAULT_MAX_MAILBOXES;
    // Resolved through the clamp on BOTH paths — see `resolveCycleLanes` for why a
    // programmatic value is not honoured verbatim the way the millisecond knobs are.
    const cycleLanes = resolveCycleLanes(config.cycleLanes);
    /**
     * Lanes a mailbox that owes a backlog may occupy, leaving {@link CYCLE_FAST_LANES} for the
     * mailboxes that do not.
     *
     * `Math.max(1, …)` so `cycleLanes: 1` stays the exact serial rotation rather than becoming a
     * shard on which no backfill may ever run: at one lane there is nothing to reserve FROM.
     */
    const heavyLanes = Math.max(1, cycleLanes - CYCLE_FAST_LANES);
    const rosterIntervalMs = config.rosterIntervalMs ?? DEFAULT_ROSTER_INTERVAL_MS;
    const heartbeatMs = config.lockHeartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS;
    const retryBaseMs = config.mailboxRetryMs ?? DEFAULT_MAILBOX_RETRY_MS;
    const retryMaxMs = retryBaseMs * 16;
    const maxSyncFailures = Math.max(1, config.maxSyncFailures ?? DEFAULT_MAX_SYNC_FAILURES);
    // Mail 0029. A DURATION and not a pass count, so it cannot silently retune itself when
    // `rosterIntervalMs` moves — and bounded below `DEFAULT_ALERT_THRESHOLDS.syncLagMs`, so the row
    // can always explain the alert that fires about it. See `DEFAULT_SYNC_BLOCK_GRACE_MS`.
    const syncBlockGraceMs = config.syncBlockGraceMs ?? DEFAULT_SYNC_BLOCK_GRACE_MS;
    // The bound on the by-class `LeaseUnavailableError` exemption in `cycle()`. Also a
    // DURATION and not a cycle count, and also below `syncLagMs` — see the constant's header, and
    // `config.test.ts`, which asserts the shipped default because no e2e guard can: they all inject
    // the bound, so a miswired default keeps production broken while the suite stays green.
    const leaseUnavailableDetachMs =
      config.leaseUnavailableDetachMs ?? DEFAULT_LEASE_UNAVAILABLE_DETACH_MS;
    const selection = selectionOf(config);
    const makeAdapter = config.adapterFactory
      ?? ((cfg, ctx) => new ImapAdapter(cfg, { onConnectionError: ctx.onConnectionError }));

    // Structured logs + the alert pass. Every line this worker emits from here on is one JSON object
    // carrying `instanceId` and `shard`, and every per-mailbox line adds `accountId`/`mailboxId` —
    // the two ids that turn "a sync cycle failed" into "THIS customer's mail stopped". Bound once, on
    // a child logger, so no call site can forget them. The DEFAULT is `silentLogger`, not a stdout
    // logger, for every path except the CLI: a library that prints because its host forgot to inject
    // something pollutes somebody's test output. `runWorkerSupervised` (and the deployed process)
    // injects a real one; `startWorker` called from a test stays quiet unless it asks.
    const instanceId = config.instanceId ?? instanceIdFrom();
    const environment = config.environment ?? "production";
    const startedAt = new Date();
    const log: Logger = (config.logger ?? silentLogger).child({
      instanceId, shard: shardIndex, shards, environment,
    });

    /**
     * The leader epoch, as the two mailbox lifecycle writes see it. `worker_heartbeats` is already
     * the durable, atomically-claimed record of "who leads shard N" — `writeHeartbeat` overwrites
     * `instance_id` on takeover and `refreshHeartbeat` refuses a surrendered leader's late pulse
     * against exactly this predicate. Passing it into `markMailboxFailed`/`markMailboxConnected`
     * fences those writes with the SAME definition, and `clearHeartbeat` takes it so a surrender
     * cannot clobber a successor's claim. The first beat is written before any attach, so the row
     * exists by the time either write fires; a failed beat closes the fence and the write is refused
     * and LOGGED (`mailbox_failure_write_fenced`) rather than landing unfenced — the safe direction.
     */
    const fence: LeaderFence = { shardIndex, instanceId };
    const alertIntervalMs = config.alertIntervalMs ?? DEFAULT_ALERT_INTERVAL_MS;
    const alertSinks: AlertSink[] = [];
    const hook = webhookAlertSink(config.alertWebhookUrl, config.alertPost);
    if (hook) alertSinks.push(hook);
    // The MAIL arm — the product's own transactional mailer, added when the webhook arm's
    // endpoint turned out to blackhole this host's egress (see `alert-mail.ts` for the
    // measurement). Both arms share the injected `alertPost` seam, so no test opens a socket.
    const mailArm = resendAlertSink(
      { apiKey: config.resendApiKey, from: config.mailFrom, to: config.alertEmail },
      config.alertPost,
    );
    if (mailArm) alertSinks.push(mailArm);
    // The PUSH arm — the pager's second VENDOR, not merely its second arm. The mail arm above
    // is the product's own transactional mailer: one account, one credential, one company
    // carrying every page there is. This one shares none of that, and its reachability from
    // this container was probed rather than assumed. See `packages/db/src/alert-push.ts`.
    const pushArm = telegramAlertSink(
      { botToken: config.alertTelegramBotToken, chatId: config.alertTelegramChatId },
      config.alertPost,
    );
    if (pushArm) alertSinks.push(pushArm);
    /**
     * The consecutive-failure memory behind `alerts_undeliverable` for a CONFIGURED sink.
     *
     * Held for the life of this leadership rather than in the database — see
     * {@link DeliveryStreak}. A restart or a lock handover starts a fresh streak, which costs
     * three minutes of escalation latency and cannot lose an escalation: the fault is still
     * there on the next three passes.
     */
    const alertDeliveryStreak = newDeliveryStreak();

    let stopped = false;
    let lockLost = false;
    let lastCycleAt: Date | null = null;
    let dutyAccounts: string[] = [];
    // Time-gate for the global maintenance pass; starts "due" so a fresh leader sweeps once.
    let lastMaintenanceAt = 0;
    /**
     * The staging bucket's client, built ONCE per run rather than per pass — it is a closure over
     * three strings and a `fetch`, so rebuilding it hourly would be pure waste. `null` when this
     * deployment has no staging environment, which the maintenance pass reports rather than
     * passes over: a bucket the API writes to and nothing sweeps grows forever.
     */
    // KIND FOR KIND with the API host's mint: the worker is the only process that ever deletes,
    // so every kind the API can stage into must have its sweep arm here — the type narrows on
    // the union, so a kind added to the config without an arm is a compile error, not a bucket
    // that grows forever.
    const stagingStorage: AttachmentStagingStorage | null = config.attachmentStaging
      ? (config.attachmentStaging.kind === "s3"
        ? makeS3StagingStorage(config.attachmentStaging)
        : makeSupabaseStagingStorage(config.attachmentStaging))
      : null;
    /**
     * Time-gate for the bubble-up pass. Starts "due" for the same reason
     * `lastMaintenanceAt` does, and here it matters more: a message whose `bubble_up_at` fell
     * due while the previous leader was being replaced must resurface on the new leader's FIRST
     * cycle, not one {@link BUBBLE_UP_EVERY_MS} after the takeover.
     */
    let lastBubbleUpAt = 0;
    /**
     * Time-gate for the thread-join heal. Starts "due" like `lastBubbleUpAt`, and here the
     * reason is survival rather than latency: a deployment cadence shorter than
     * {@link THREAD_JOIN_HEAL_EVERY_MS} would otherwise mean the pass NEVER runs — a
     * scheduled pass that no schedule ever reaches, which this repo has paid for before.
     * The first-cycle cost is one small GROUP BY per served account.
     */
    let lastThreadJoinHealAt = 0;
    /**
     * Time-gate for the inbound-quiet pass. Starts "due" like `lastThreadJoinHealAt` and for
     * its exact reason: a deployment cadence shorter than {@link INBOUND_QUIET_EVERY_MS} would
     * otherwise mean the forwarding-detection heuristic NEVER runs. The first-cycle cost is one
     * bounded grouped aggregate per served account.
     */
    let lastInboundQuietAt = 0;
    /**
     * The per-process sweep. It owns the gate AND every account's resume point, so an attempt that
     * could not finish is continued rather than restarted — see its own docblock for why that used
     * to be two locals here and why review was right to call that untestable.
     */
    const awayReplySweep = makeAwayReplySweep();
    /** Starts DUE. Only paces the RETRY; the gate is the sweep's. */
    let lastAwayReplySweepAt = 0;
    /**
     * Where each account's LAST gated heal run stopped, kept only while it stopped on its
     * BUDGET. An account holding more duplicate-name groups than one run's cap would otherwise
     * rescan the same leading refusals every six hours for ever — a refused group never leaves
     * the candidate predicate — and the splits past the cap would never be examined. Cleared on
     * an uncapped pass so the next run takes a fresh full look. In-memory on purpose: a leader
     * handover restarts from the top, which costs one rescan and needs no schema.
     */
    const threadJoinHealCursors = new Map<string, ThreadJoinHealCursor>();
    /**
     * One-shot: the boot announcement and its heartbeat happen on the FIRST roster pass only.
     * Declared HERE with the rest of the closure state rather than beside `cycleQueued` — a
     * `let` in temporal dead zone throws if `reconcileRoster` is ever called earlier than its
     * declaration, and "safe because of current call order" is not a property worth relying on.
     */
    let booted = false;
    /** The boot beat, which fires once the first roster pass knows what the duty IS. */
    let firstBeatPending = true;
    let expected = 0;
    let truncated = 0;
    let dutyGap = false;
    /**
     * The mailbox ids of the current duty — `served`, kept at closure scope (HEALTH-REASON).
     *
     * `expected` is its length and was for a long time the only thing kept, which is why the health
     * endpoint could say a mailbox was missing and never which one's absence it was describing.
     * The BREAKDOWN needs the identities: `expected - mailboxes` is a subtraction over two numbers
     * that drift apart during every roster pass, while intersecting this list with `runtimes` and
     * the three block maps is exact at any instant — including mid-pass, which is exactly when
     * `/health` is most likely to be probed by a deploy.
     */
    let servedIds: readonly string[] = [];
    /**
     * The shared-dependency condition — when our own database is the thing that is broken. `null` ⇒
     * the database is answering; otherwise the ms instant the current run of database faults began,
     * kept in MEMORY on purpose — it is the state in which the database cannot be written to, so a
     * column recording it would be exactly as unreachable as the thing it reports. `/health` is
     * served out of this process and touches no database (see `health.ts`), which makes it the only
     * surface that still works during the condition it describes. ONE CONDITION for the process, not
     * one per mailbox, because that is what the fault IS — the argument the classifier circuit is
     * built on: a per-mailbox counter over a shared dependency converges 13× slower and reports 13 incidents.
     */
    let dbFaultSince: number | null = null;
    /** Database faults observed in the CURRENT run. Reported once at the end, not once each. */
    let dbFaults = 0;
    const quarantine = new Map<string, Quarantine>();
    /**
     * Mailboxes on the duty that this process is NOT SERVING, and since when (mail 0029). They were
     * bare `Set<string>`s, and a measured half-hour silence lived in that: a membership test can say
     * "not served" but not "for how long", so no catch arm could decide whether the state had lasted
     * long enough to write down, and every arm settled for a log line. `since` lets ONE place decide.
     * `reason` is nullable: `null` means "accounted for, but the ROW ALREADY EXPLAINS ITSELF" — the
     * stand-down case only, where `mayOrganize` returning false already wrote `status='disabled'` plus
     * `disabled_reason` through `markMailboxStoodDown`, which CLEARS these two columns; writing
     * `lease_unreadable` on top would be this pass contradicting itself with a worse answer.
     */
    interface SyncBlock {
      /** `Date.now()` when this process FIRST observed this block. Never moved by a re-observation. */
      since: number;
      /** What to write on the row, or `null` when the row already says something better. */
      reason: MailboxSyncBlockReason | null;
    }
    const awaitingCreds = new Map<string, SyncBlock>();
    /**
     * Mailboxes this pass did not attach because of the ORGANIZER LEASE — either another organizer
     * holds them (the row is now `disabled` and the next pass will not offer them) or the lease could
     * not be read at all. It exists because `roster_invariant_violated` asserts every mailbox is in
     * exactly one accounted-for bucket, and a mailbox we deliberately declined to organize is
     * accounted for — without this set the gate would page an operator about its own correct behaviour
     * every thirty seconds. A lease-unavailable mailbox still counts toward `expected`, so `/health`
     * reports `degraded` while it lasts (nothing is syncing it). The two populations are not the same
     * state (mail 0029) — only "could not read it" gets a `reason` (see {@link SyncBlock}).
     */
    const leaseBlocked = new Map<string, SyncBlock>();
    /**
     * Mailboxes the `maxMailboxes` cap dropped, and since when (mail 0029).
     *
     * At closure scope and not local to `reconcileRoster`, which is the only thing that makes the
     * grace measurable: `dropped` is recomputed from scratch every pass, so a map rebuilt with it
     * would restart `since` at `Date.now()` every 30 seconds and the grace would never elapse.
     * These mailboxes are the most silent of the three arms — they are not even counted in
     * `expected`, so `degraded` stays false while nothing in this deployment serves them.
     */
    const capDropped = new Map<string, SyncBlock>();
    /**
     * Mailboxes whose last cycle ended on a ceiling WE set (`ImapBoundExceeded`) — the FOURTH
     * arm, and the only one whose cause is the mailbox's SIZE rather than our roster.
     *
     * At closure scope for `capDropped`'s reason: the entry has to outlive the cycle that wrote
     * it, or the grace could never elapse. It is dropped by the cycle that next completes, which
     * is what makes `reconcileSyncBlocks` clear the row on the next healthy pass — the same
     * mechanism the other three arms use, and the reason this needed no clearing code of its own.
     */
    const readLimited = new Map<string, SyncBlock>();
    /**
     * Record a block, PRESERVING `since` across passes.
     *
     * A catch arm calls this and does nothing else — no I/O, no decision, no threshold. That is
     * what keeps the elapsed-time policy in exactly one place (`reconcileSyncBlocks`) instead of
     * spread across four catch sites that would each have to get it right. A CHANGE of reason
     * starts a new episode, because it is one: a mailbox that stopped waiting for credentials and
     * is now behind an unreadable lease has been unserved continuously, but for a new cause, and
     * `markMailboxSyncBlocked`'s `coalesce` keeps the row's own `since` at the earlier of the two.
     */
    function noteBlock(
      into: Map<string, SyncBlock>, mailboxId: string, reason: MailboxSyncBlockReason | null,
    ): void {
      const prev = into.get(mailboxId);
      if (prev && prev.reason === reason) return;
      into.set(mailboxId, { since: Date.now(), reason });
    }
    /** Loud logs that must not repeat on every 30 s roster pass. */
    const announced = { cap: "", creds: new Set<string>() };
    /**
     * Mailboxes whose submission server this process has already asked for its `SIZE` (mail 0055).
     *
     * ONE SMTP LOGIN PER MAILBOX PER PROCESS, and the bound is not decoration: `attach` runs again
     * every time a mailbox detaches and re-attaches, so without this a mailbox that flaps would log
     * in to its provider on every roster pass — which is how a provider decides to throttle a
     * customer. `smtp-size.ts` marks a mailbox here BEFORE it dials, so a failed dial counts too.
     */
    const smtpSizeAttempted = new Set<string>();

    /**
     * Enter (or stay in) the shared-database condition — ONE incident, however many mailboxes. The
     * loud line is EDGE-TRIGGERED: "surface as the worker-wide condition it is — the health surface
     * and ONE alert, not thirteen" is what this owes, and a `log.error` per occurrence would deliver
     * the thirteen. A shard of thirteen under a two-minute outage produces one `error` here and one
     * `info` when it clears; the per-occurrence detail rides `debug`. `runAlertPass` is deliberately
     * NOT the surface for this, and that is not an oversight: every rule it evaluates is a query, so
     * during the fault it describes it cannot run — the two things that still work are this process's
     * own log stream and its `/health`, and both carry it.
     */
    function noteDatabaseFault(
      err: unknown, at: { mailboxId?: string; accountId?: string } = {},
    ): void {
      dbFaults++;
      if (dbFaultSince === null) {
        dbFaultSince = Date.now();
        log.error("worker_database_fault", {
          ...at, err,
          reason: "a call to OUR OWN database failed — this is a shared-dependency condition, not " +
            "a fault of this mailbox. No mailbox is counted toward maxSyncFailures, no provider " +
            "backoff is earned, and this pass stops rather than collecting the same failure once " +
            "per mailbox. /health reports degraded until a cycle completes",
        });
        return;
      }
      log.debug("worker_database_fault_repeat", {
        ...at, err, count: dbFaults,
        outageMs: Date.now() - dbFaultSince,
      });
    }

    /**
     * Leave it — called from the ONE place that is proof the database is answering again.
     *
     * A completed `runSyncCycle` and nothing weaker. Not a successful heartbeat (it is
     * best-effort and its own catch swallows), not a roster pass (it reads, and a read can
     * succeed against a replica that is not accepting writes): the condition is about writing
     * mail, so the evidence that ends it has to be mail that was written.
     */
    /**
     * A best-effort catch may swallow the mailbox's verdict. It may not swallow the shard's.
     * `cycle()` is full of catches that deliberately do nothing (a `last_sync_at` that could not be
     * written, a per-account pass) — every one right about the MAILBOX (a freshness column must never
     * walk a healthy mailbox toward `error`) and silently also correct about the SHARD, which it is
     * not entitled to be. With lanes, a database dying mid-pass can meet every mailbox past
     * `runSyncCycle` at once, so an outage was met only by bookkeeping writes that all catch, and the
     * shard announced NOTHING (`/health` said `databaseFaultSince: null` through a total outage). So
     * the catches ANNOUNCE now (`noteDatabaseFault`, edge-triggered) — but only calls that NAME their origin via `asDatabaseFault`; a call holding the customer's adapter must not be wrapped (`db-fault.ts`).
     */
    function noteIfSharedDatabaseFault(
      err: unknown, mb?: { mailboxId: string; accountId: string },
    ): void {
      if (isSharedDatabaseFault(err)) noteDatabaseFault(err, mb);
    }

    function clearDatabaseFault(): void {
      if (dbFaultSince === null) return;
      log.info("worker_database_recovered", {
        outageMs: Date.now() - dbFaultSince, faults: dbFaults,
        reason: "a sync cycle completed, so the database is answering again — the roster was never " +
          "quarantined and resumes at its normal cadence",
      });
      dbFaultSince = null;
      dbFaults = 0;
    }

    // A roster pass that is owed, and the cycle that was sitting on it. `reconcileRoster` is the ONLY
    // path by which a mailbox joins the rotation and is a live re-read, but it shares its queue with
    // `cycle()`, which is ONE entry covering every attached mailbox. Measured: `last_cycle_at` did
    // not move for ten minutes while one cycle entry held the queue and `beat_at` stayed fresh (the
    // pulse is the one thing off it), so adoption was not broken but STARVED — the starvation term is
    // the WHOLE cycle, which at `maxMailboxes` 64 is hours. The fix is SCHEDULING, not concurrency:
    // `rosterPending` says a pass is owed and `cycle()` serves it BETWEEN two mailboxes, inside its
    // own entry, so nothing new runs in parallel and `stop()`'s drain still covers it. The flag is an
    // accelerator and the queue entry the floor — on an idle shard nothing reaches a yield point, so
    // a flag-only design would stop adopting exactly where the bug did not exist.
    /** A roster pass is owed. Cleared by whichever of the two paths gets to it first. */
    let rosterPending = false;
    /** When the OLDEST unserved request was made — the delay `roster_pass_delayed` reports. */
    let rosterPendingSince = 0;
    /** A queued entry is already waiting to serve it; do not queue a second. */
    let rosterQueued = false;

    // ── One serial queue for cycles AND roster passes. A roster pass must never close an
    //    adapter a sync cycle is using, and stop() must be able to wait for whatever is in
    //    flight before it closes the DB and releases the lock.
    //
    //    ONE QUEUE, BUT NOT ONE ENTRY PER CYCLE — see `yieldToRoster`. A cycle serves
    //    the pass it is holding up BETWEEN two mailboxes, from inside its own entry, so nothing
    //    ever runs concurrently and the sentence above still holds literally.
    let tail: Promise<unknown> = Promise.resolve();
    function serialize<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    }
    async function drain(): Promise<void> { try { await tail; } catch { /* logged at source */ } }

    // The one property the single queue used to give for free. The queue is unchanged (ONE entry at a
    // time, cycles and roster passes both, `stop()` drains it); what changed is the INSIDE of a cycle
    // entry, which now visits up to `cycleLanes` mailboxes at once. The mid-cycle adoption's safety
    // argument was "a roster pass runs between two mailboxes where NOTHING is suspended in an
    // adapter", which bought one thing — a pass may never close an adapter somebody is using — and
    // with lanes in flight is no longer literally true, so the property is enforced directly.
    // `laneBusy` is the enforcement: `reconcileRoster` (the ONE detach site reachable from inside a
    // running cycle) SKIPS a mailbox a lane is inside and hands it to `deferredLeaves`, drained after
    // the lanes join — the same "detached after the loop, never inside it" discipline the others
    // follow. In the steady state both are empty: this costs one Set membership test per pass.
    /** Mailbox ids a lane of the RUNNING cycle is currently inside. */
    const laneBusy = new Set<string>();
    /** Runtimes a roster pass wanted to detach while a lane held them; drained by `cycle()`. */
    const deferredLeaves: Array<{ rt: MailboxRuntime; release: boolean; reason: string }> = [];

    /**
     * THIS mailbox is owed a visit — its IDLE fired, or the enforced-sync scan named it. Keeps the
     * OLDEST unserved wake (`??=`), so a mailbox ringing repeatedly through a long backfill is
     * ordered by when it FIRST rang rather than its most recent signal — otherwise a chatty mailbox
     * keeps resetting itself to the back. Silently ignores a mailbox this process does not serve: both
     * callers are already scoped to `runtimes` (the IDLE callback belongs to an attached adapter,
     * `syncKickPass` filters on the served set), so this is the race between a signal in flight and a
     * detach, and dropping it is correct — a detached mailbox has no lane, and the next attach
     * re-establishes IDLE.
     */
    function noteWake(mailboxId: string): void {
      const rt = runtimes.get(mailboxId);
      if (!rt) return;
      rt.wokenAt ??= Date.now();
      nudgeCycle();
    }

    // And a running cycle has to be able to hear it. The dispatcher inside `cycle()` blocks on
    // `Promise.race(lanes)` — it wakes when a lane FINISHES, the wrong event for this: a wake landing
    // while three lanes are inside long batches would not be looked at until one returned, so the
    // mailbox would wait a bounded batch (~254 s measured) for a signal that answered in under a
    // second. This is the other thing the race waits on. ONE pending promise, re-armed on every fire,
    // rather than a fresh one per turn — the naive form leaves every superseded promise unresolved
    // and holds its `resolve` for the life of the process. It never rejects, so the race cannot either.
    let wakeSignal!: Promise<void>;
    let fireWake!: () => void;
    function armWake(): void { wakeSignal = new Promise<void>((r) => { fireWake = r; }); }
    armWake();
    /** Tell a cycle that is blocked on its lanes that there is something new to look at. */
    function nudgeCycle(): void {
      const fire = fireWake;
      armWake();
      fire();
    }

    function backoffFor(attempts: number): number {
      return Math.min(retryBaseMs * 2 ** Math.max(0, attempts - 1), retryMaxMs);
    }

    // The AI spend port. ONE for the process, where there were three memoised gate factories (a
    // `debit_classify` for ingest, a second with the exclusive claim and setup-pool wrapper for the
    // Screener's cron half, a `debit_workflow` for workflow steps). Each call site's terms had to be
    // composed here and the API host had to compose the same two — a host that got one wrong gave a
    // call site another's terms (setup-funded Screener spends once skipped the claim entirely). Now
    // the call site names its ACTION and the terms come from `SPEND_ACTIONS`. The per-account memo is
    // gone and nothing is lost: it carried the "sources I charged" marker, and the port answers that
    // with `ok.attempt` — which works across a restart and a network hop, as the marker never could.
    // Composed UNCONDITIONALLY, before any live model: metering must exist before the spend does.
    /* ONE ENTITLEMENTS PORT FOR THE PROCESS, or a named unmetered state.
     *
     * `ENTITLEMENTS_URL` set ⇒ the HTTP client of that program; unset ⇒ `UNMETERED`, and the
     * spend call sites are handed nothing and charge nothing. Composed UNCONDITIONALLY, before
     * any live model is: metering must exist before the spend does, not after. */
    const entitlements: EntitlementsComposition = config.entitlements
      ? makeEntitlementsClient({ baseUrl: config.entitlements.url, secret: config.entitlements.secret })
      : UNMETERED;
    /** The spend half the call sites take — `undefined` where nothing meters. */
    const spend = isMetered(entitlements) ? entitlements : undefined;

    // The LIVE classifier, behind a per-process circuit breaker. ONE circuit for the process, because
    // the failure domain is the shared API key and endpoint — per-mailbox circuits would each burn
    // their own faults into the same outage, and `cycle()` walks the rotation serially so one counter
    // converges fastest. `circuit.port()` is resolved PER CYCLE and never cached: while open it
    // answers `undefined`, `pipeline.ts`'s `classifier &&` short-circuits before the money question,
    // and the message files rules-only with no model call and no debit; holding a wrapper across the
    // open transition would charge every message and then fail it. The COST RECORDER is attached here
    // because here is where the pool exists — `config.aiUsage` relays usage to it, BUFFERED (30 s),
    // safe because nothing freezes this process between a call and its flush, tail flushed on
    // shutdown. Absent when managed AI is not armed — the rules-only deployment records and spends nothing.

    // Absent classifier ⇒ no circuit and today's behaviour exactly (rules-only routing).
    const classifierCircuit: ClassifierCircuit | undefined = config.classifier
      ? makeClassifierCircuit(config.classifier, { log })
      : undefined;
    /** The classifier + gate pair for one mailbox's cycle. */
    function aiFor(mailboxId: string, accountId: string): Pick<SyncDeps, "classifier" | "credits"> {
      if (!classifierCircuit) return { ...(spend ? { credits: spend } : {}) };
      return {
        // The SAME mailbox id both halves take: `meter` records this mailbox's charge and the
        // wrapper clears this mailbox's record on a success. Two different ids there, or one
        // omitted, is how a success for one mailbox forfeits another's refund.
        classifier: classifierCircuit.port(mailboxId),
        // The metered port is what teaches the circuit which ledger attempt it charged, so a
        // trip can refund the message it just abandoned. See `ai-circuit.ts`.
        ...(spend ? { credits: classifierCircuit.meter(mailboxId, spend) } : {}),
      };
    }

    // The account's Ohbox posture, resolved per account and cached with a short TTL. One worker
    // serves many accounts, so it is resolved from THAT account's `account_settings` row, never from
    // config, and cached briefly so a toggle takes effect within a cycle or two without a DB read per
    // cycle per mailbox. A read FAULT resolves to the lenient default (`DEFAULT_OHBOX_POLICY`) and
    // does NOT poison the cache — a transient blip must never demote a real person's mail. The
    // screening cutoff comes off the same row and read: `screening_baseline_at - dormancy_days` (mail
    // 0056), resolved once per account per TTL and threaded into `planChange` as an instant; a NULL
    // baseline or a read fault resolves to `undefined` (no cutoff, the consent-gate direction). And
    // the storage cap per account: the hosted worker is THE metered composition (`SyncDeps.storageCap`
    // required, local engines `UNMETERED_STORAGE_CAP`), refreshed per cycle so a limit change moves within one.
    const storageCapFor = makeStorageCapResolver(entitlements, log);
    const SCREENING_TTL_MS = 30_000;
    type ScreeningDeps = Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff">;
    const screeningCache = new Map<string, { at: number; value: ScreeningDeps }>();
    async function screeningFor(accountId: string): Promise<ScreeningDeps> {
      const now = Date.now();
      const hit = screeningCache.get(accountId);
      if (hit && now - hit.at < SCREENING_TTL_MS) return hit.value;
      try {
        const [row] = await db.select({
          policy: accountSettings.ohboxPolicy,
          bar: accountSettings.ohboxBar,
          baselineAt: accountSettings.screeningBaselineAt,
          dormancyDays: accountSettings.dormancyDays,
        }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
        const cutoff = resolveScreeningCutoff(row?.baselineAt, row?.dormancyDays);
        const value: ScreeningDeps = {
          ohboxPolicy: resolveOhboxPolicy(row?.policy ?? null),
          ...(row?.bar ? { ohboxBar: row.bar } : {}),
          ...(cutoff ? { screeningCutoff: cutoff } : {}),
        };
        screeningCache.set(accountId, { at: now, value });
        return value;
      } catch (err) {
        // Do NOT cache the fault: the next cycle re-reads, and until then we route LENIENT for the
        // posture and with NO CUTOFF for the gate — which is the strict direction for the gate.
        log.warn("screening_pref_read_failed", { accountId, err });
        return { ohboxPolicy: DEFAULT_OHBOX_POLICY };
      }
    }

    // The organizer lease, wired. The invariant: exactly one active organizer per mailbox, enforced
    // by a lease in `ohmail/_meta` — the only medium a LOCAL install and Cloud share. The lease engine
    // existed with a GreenMail two-worlds test and NOTHING called it, while real mailboxes were
    // organized by Cloud with no claim in the folder at all. The gate runs at TWO seams: `attach()`,
    // after `connect()` and BEFORE `ensureFolders()` (everything after writes to somebody's mailbox,
    // and reconnect is learn-then-act); and `cycle()`, before `runSyncCycle`, the RE-VERIFICATION that
    // turns a lease into an exclusion (a claim is evidence only for the cycle that read it, so a
    // mailbox that changed hands stops being organized next pass). Both seams are guarded by ORDERING
    // (`attach-nonblocking.e2e.test.ts`), and there is ONE organizer identity for the whole process —
    // not `instanceId`, or every leader failover would read as a new organizer arriving (`lease.ts`).
    const organizerInstallId = config.organizer?.installId ?? cloudInstallId(environment);
    const organizerDisplayName = config.organizer?.displayName ?? CLOUD_DISPLAY_NAME;
    const organizerStaleAfterMs = config.organizer?.staleAfterMs;

    function leaseSelfFor(rt: { leaseNonce: string | null }): LeaseSelf {
      return {
        installId: organizerInstallId,
        kind: "cloud",
        displayName: organizerDisplayName,
        lastNonce: rt.leaseNonce,
      };
    }

    /**
     * A reader looks. It does not claim. The APPEND-less read of `ohmail/_meta`, run once per reader
     * cycle, whose whole product is the four holder columns — so the banner every client renders is a
     * ROW read rather than a live IMAP dial per viewer. `readLeasePeek` cannot create the folder or
     * write a claim; that narrowness is the enforcement (see `LeasePeekCapableAdapter`). NEVER throws:
     * a reader that could not look keeps reading mail, the columns keep their previous answer (at
     * worst one poll stale), and the alternative — treating an unreadable folder as evidence — is
     * exactly the conflation the lease forbids. It writes only when something CHANGED, so a reader
     * whose organizer is quietly renewing costs zero writes per cycle.
     */
    async function refreshReaderHolder(
      mb: { mailboxId: string; accountId: string },
      adapter: MailboxAdapter,
      current: {
        kind: string | null; name: string | null; since: Date | null; state: string | null;
        capabilities: string | null; installId: string | null;
      },
    ): Promise<void> {
      const peek = (adapter as Partial<LeasePeekCapableAdapter>).leasePeekIo;
      try {
        /* ── THE CONFIGURED WINDOW, and omitting it was a real divergence ─────────────────────
         *
         * The gate below is given `organizerStaleAfterMs`; both previews used to default to ten
         * minutes. With a 24-hour configured window and two installs each carrying a record 14–15
         * minutes old, the gate answered `stand_down` — held, per the configuration — while the
         * preview answered `stopped`, so this row was refreshed to say nobody organizes a mailbox
         * the same pass had just stood down from. The release certification below had the same
         * omission and the same cause, with a WRITE at the end of it. One window per mailbox, read
         * from one place; the sidecar already forwards its own (`engine.ts:3267`, `:3657`), which
         * is what made the difference legible. */
        /* THREE ANSWERS, AND THE MISSING ACCESSOR IS ONE OF THEM. This probed `leasePeekIo` and
           answered a failed probe with a bare `return` — no write, no line, and the four holder
           columns left saying exactly what an unorganized mailbox's say. Every banner in the
           product reads those columns, so an adapter without the read-only accessor renders
           "nobody organizes this mailbox" about a mailbox nothing has looked at. `answerLeasePeek`
           makes that an ANSWER; the row is still left alone, because a failed look is not evidence
           about who holds the mailbox. */
        const answered = await answerLeasePeek({
          io: typeof peek === "function" ? peek.call(adapter) : undefined,
          now: new Date(),
          ...(organizerStaleAfterMs !== undefined ? { staleAfterMs: organizerStaleAfterMs } : {}),
        });
        if (answered.answer === "unreadable") {
          log.warn("organizer_holder_refresh_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, op: answered.op,
            reason: "this reader could not look at the claim folder, so the holder columns keep "
              + "their previous answer; a look that did not land is not evidence that nobody "
              + "organizes this mailbox, and the next cycle looks again",
          });
          return;
        }
        const seen = answered.peek;
        // FRESHEST FIRST, and the freshest is the one a person means by "who organizes this".
        // `holders` is already sorted that way by `peekLease`; an empty list means the folder
        // holds no readable claim, which is reported as "nobody named" rather than invented.
        const top = seen.holders[0] ?? null;
        // `none` is not a member of the column's closed set and must not be coerced into one:
        // "nobody has ever organized this mailbox" is genuinely absent, not `stopped`.
        const state: OrganizerState | null =
          seen.state === "held" ? "held" : seen.state === "stopped" ? "stopped" : null;
        const name = top && top.displayName.trim() !== "" ? top.displayName.trim() : null;
        const kind = top === null ? null : top.kind;
        /* Mail 0092 — WHICH install, beside WHAT kind. Dropping the id here is what made the row
           unable to tell this deployment's own abandoned claim from another Cloud deployment's
           live one, and `lease.ts` scopes those ids by environment precisely so the two differ. */
        const installId = top === null ? null : top.installId;
        const since = top ? top.claimedAt : null;
        // Mail 0089 — the fifth holder column, computed the same way `refreshOrganizerHolder`
        // stores it: comma-joined, lowercased, empty ⇒ null. Compared here too, so a capability
        // added mid-tenure (a peer upgrading its build without a takeover) still lands on the row —
        // it just never stamps `organizer_event_at`, on the same argument `organizedSince` shifting
        // under a renewed tenure already makes below.
        const capabilities = top ? capabilitiesColumn(top.capabilities) : null;
        /* THE ID IS PART OF THE COMPARE, not just part of the write. This compare decides whether
           the row is already what the folder says, and a column missing from it is a column that
           can never be found stale: 0092 shipped with the id written but not compared, so every
           row that predated the migration kept a NULL id for ever — the five older columns already
           agreed, so this returned before the write on every cycle. NULL fails closed in the
           release arm, so the hand-back stayed refused on precisely the mailboxes it was for.
           Any holder column added after this one belongs on the roster and in this line. */
        if (current.kind === kind && current.name === name && current.state === state
          && current.capabilities === capabilities && current.installId === installId
          && (current.since ? current.since.getTime() : null) === (since ? since.getTime() : null)) return;
        /* Only an occupancy flip is an event (0.14.1). This function writes whenever ANY of the four
         * columns moved, and most of those movements are not news: a peer restarting shifts
         * `organized_since`, a machine being renamed shifts `organized_by_name`, and telling somebody
         * "another install organizes this now" for either would be the notice crying wolf — the
         * once-per-event promise is worth something only if what counts as an event is what a person
         * would call one. `held` ⇄ `stopped`, and either direction to or from "we have not looked",
         * ARE what the two reader sentences are about: somebody is organizing this, or somebody
         * stopped and you can claim it. */
        const stateChanged = current.state !== state;
        await refreshOrganizerHolder(db, mb.mailboxId, {
          kind, installId, displayName: name, claimedAt: since, state,
          capabilities: top?.capabilities ?? null,
        }, { fence, stateChanged });
        log.info("organizer_holder_refreshed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId,
          organizerState: state, heldBy: name,
          reason: "this install reads this mailbox; the row now names who organizes it, so every "
            + "client's banner is a row read rather than an IMAP dial per viewer",
        });
        current.kind = kind; current.name = name; current.since = since; current.state = state;
        current.capabilities = capabilities; current.installId = installId;
      } catch (err) {
        // Deliberately swallowed — see the header. A reader that cannot read the lease keeps
        // reading mail.
        log.warn("organizer_holder_refresh_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
        });
      }
    }

    /**
     * Read the lease for one mailbox and, when it says no, make that durable. Returns `true` iff this
     * process may organize the mailbox right now — since mail 0083 the same question as "is this
     * install the ORGANIZER", and `false` is no longer "stop": it is `role: "reader"`, and the caller
     * keeps syncing. Throws {@link LeaseUnavailableError} when the lease could not be READ at all,
     * never a stand-down (that "somebody else holds this" and "I could not look" must not be reachable
     * from one another); both call sites exempt that class like `ClassifierFaultError`. `false` has
     * two causes deliberately answered as one — another organizer holds it, or nobody asked this
     * install to (a consent-less mailbox) — differing only in the ROW, which names a holder in the first. The demotion write is FENCED, but a fenced-out write still demotes IN THIS PROCESS.
     */
    async function mayOrganize(
      mb: { mailboxId: string; accountId: string },
      lease: {
        takeoverAuthorizedAt: Date | null; disabledReason: string | null;
        /** Mail 0104 — the VERB behind the stamp; see {@link MailboxRuntime.lease}. */
        takeoverIntent: OrganizerIntent;
        organizerRole: OrganizerRole;
        organizeConsentedAt: Date | null;
        /** Mail 0088 — "stop organizing this mailbox, keep my mail", honoured before anything. */
        releaseRequestedAt: Date | null;
      },
      nonce: { leaseNonce: string | null; leasePermit: OrganizerWriteAuthority },
      adapter: MailboxAdapter,
      phase: "attach" | "cycle",
      /**
       * The mailbox's derived request key, or `null` when there is no shared secret (OAuth). It
       * decides ONE thing here: whether the claim this gate writes advertises `requests`. Passed
       * in rather than read, because the credential it comes from is decrypted at attach and this
       * function runs in both phases — at attach the runtime does not exist yet.
       */
      requestKeyForGate: string | null,
    ): Promise<boolean> {
      /* The release is honoured FIRST, before the lease is read at all (0.14.1). "Stop organizing and
       * keep my mail" is not a question for the lease — the answer is nobody, the person withdrew the
       * entitlement. It is first because `readMailboxLease` below APPENDS: an install that read the
       * lease first would renew its claim and release it one statement later, advertising itself as
       * the organizer of a mailbox it has been told to stop, once per cycle. The three writes are
       * ordered: the CLAIM first (while the connection that can expunge it is open —
       * `releaseOrganizerClaim`, or a fresh claim stands another install down for the staleness
       * window); the ROW second (what makes the release durable, and what `closeStoodDownAppointments`
       * reads); the APPOINTMENTS last (the other order closes nothing, silently). A failed release does NOT abort the ceasing — this install has stopped organizing whichever way the writes went.
       */
      if (lease.releaseRequestedAt !== null) {
        const removed = await releaseOrganizerClaim(
          // The nonce this gate's carrier holds. On the ATTACH path no gate has run yet, so it is
          // `null` and the release refuses rather than deleting by id — the request stands and the
          // lapse bound below records it once the claim stops being renewed.
          { mailboxId: mb.mailboxId, accountId: mb.accountId, adapter, leaseNonce: nonce.leaseNonce },
          "the person asked this install to stop organizing this mailbox and keep reading it",
        );
        /* Zero claims removed is not a release. The release is authorized from the row as it stood
         * when the person pressed and carried out a cycle later, and the mailbox can change hands in
         * between — another install expunges this one's claim — so the removal above (matched on OUR
         * install id) removes nothing and used to say nothing about it. `markMailboxReleased` then ran
         * anyway and nulls all six holder columns, so the row said nobody organizes this mailbox while
         * another install actively did (every banner is a row read) — the install-id defect one layer
         * down. So the row is stamped released only when our claim was actually taken out, or the
         * folder holds NOBODY; a foreign claim leaves the request standing, re-honoured next cycle,
         * healing when the foreign claim goes, with the holder columns still naming the real holder.
         */
        /* The folder decides, not the count. The first cut asked the peek only when the removal
         * returned ZERO, which left the defect one case over: if another install appends its claim
         * while ours is still there, removing ours returns ONE, the count looks like success, and the
         * row is cleared over a claim still in the folder. A positive count says our claim went, not
         * that the mailbox is free. So the folder is read after every removal and the row is stamped
         * only when nothing else holds it. Four things withhold: a LIVE foreign claim; UNREADABLE
         * claims (a `MalformedClaim` is EVIDENCE, not nothing); a folder we could not read at all; an
         * adapter with no read side (unreachable in production, withheld not assumed). A STALE foreign
         * claim does NOT withhold — it is a corpse the takeover path steps over.
         */
        let mayMark = false;
        /**
         * A LIVE HOLDER THIS PASS ACTUALLY SAW — the one withholding reason the lapse bound below
         * may not step over. The others ("could not read the folder", "records we cannot parse",
         * "no peek on this adapter") are all forms of not knowing; this one is knowing.
         */
        let sawLiveHolder = false;
        /* The peek is NOT gated on our removal, and that matters since the nonce scope. It used to
         * sit inside `if (removed !== null)`, on the reading that a failed removal left nothing to
         * certify; a release addressed by (install, nonce) added a THIRD outcome — an install that
         * cannot name its claim refuses, `removed` is `null`, and the peek never ran, so
         * `sawLiveHolder` stayed false and the lapse bound stamped "nothing organizes this" while
         * another install actively did (`release-stranded-claim.test.ts`'s holder case went red in
         * exactly that direction). The peek answers "is this mailbox free?", not "did our delete
         * land", so it is asked whenever the adapter can answer it; `mayMark` still requires our own
         * removal, the part that was never the peek's to decide. */
        {
          const peek = (adapter as Partial<LeasePeekCapableAdapter>).leasePeekIo;
          if (typeof peek === "function") {
            try {
              /* The CONFIGURED window, for the reason given at the reader-holder refresh above —
                 and it matters more here, because this read decides whether to STAMP the mailbox
                 released. Defaulting to ten minutes against a longer configured window reported no
                 fresh holder for a mailbox the gate still considers held, and `mayMark` below then
                 certified a release while another install was inside its own lease. */
              const seen = await readLeasePeek({
                io: peek.call(adapter), now: new Date(),
                ...(organizerStaleAfterMs !== undefined ? { staleAfterMs: organizerStaleAfterMs } : {}),
              });
              /* ANY LIVE CLAIM STOPS THIS, INCLUDING ONE CARRYING OUR OWN ID. Excluding our own
                 was wrong in a way the word "foreign" hid: `releaseMailboxClaim` removes the
                 claims it SAW in its own `listClaims`, so a claim appended after that read —
                 by an overlapping worker of this same deployment, or by anything else writing
                 our id — survives the removal. The peek then saw it, called it ours, and the row
                 was stamped free while a fresh claim stood every other install down.
                 What has to be true before saying "nobody organizes this" is that the folder
                 holds no live claim at all. A surviving claim of ours is not an exception to
                 that; it is an unfinished release, and the next cycle removes it. */
              const live = seen.holders.find((h) => h.fresh);
              sawLiveHolder = live !== undefined;
              mayMark = removed !== null && live === undefined && seen.unreadable === 0;
              if (!mayMark) {
                log.info("organizer_release_withheld", {
                  mailboxId: mb.mailboxId, accountId: mb.accountId,
                  holder: live?.installId ?? null, unreadable: seen.unreadable,
                  reason: "the mailbox is not free, so this install must not report it as free; "
                    + "the request stands and is honoured again when the folder says otherwise",
                });
              }
            } catch (err) {
              log.warn("organizer_release_peek_failed", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, err,
                reason: "the release is left pending rather than certified against a folder that "
                  + "could not be read",
              });
            }
          }
        }
        /* A lapse bound, so "stopping on the next pass" cannot stand for ever. Every withholding path
         * above is honest and UNBOUNDED — a folder over the read ceiling never completes the read that
         * confirms the release, so the pane says "Stopping on the next pass" until somebody empties the
         * folder by hand. The bound is the staleness window (the window after which no install honours
         * a record), and this arm RETURNS AHEAD OF THE GATE, so a pending release means our claim has
         * not been renewed since it was asked — un-renewed for a whole window, it has aged out on its
         * own and the release is a fact (the sidecar's `releasedByLapse`, its reasoning). It COMPLETES
         * one already asked for, never flips one; `TF_LEASE_STALE_MS` is the one knob. It does NOT step
         * over a holder we saw — the bound is for NOT KNOWING, and a seen holder is knowing.
         */
        const lapseMs = organizerStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
        const releasedByLapse = !mayMark && !sawLiveHolder
          && Date.now() - lease.releaseRequestedAt.getTime() >= lapseMs;
        if (releasedByLapse) {
          log.info("organizer_released_by_lapse", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, lapseMs,
            reason: "this install was asked to stop organizing this mailbox and the folder never "
              + "confirmed its claim was removed; the claim has now been un-renewed for longer "
              + "than any install honours one, so the release is recorded as done",
          });
        }
        let stamped = false;
        if (mayMark || releasedByLapse) try {
          const written = await markMailboxReleased(db, mb.mailboxId, { fence });
          if (written) {
            stamped = true;
            // The in-memory mirror of what the row now holds, on the same discipline the
            // stand-down arm keeps: this pass's own later reads must not act on a value the write
            // has just replaced, and the next cycle must not re-honour a request that is spent.
            lease.releaseRequestedAt = null;
            lease.takeoverAuthorizedAt = null;
            lease.organizerRole = "reader";
          } else {
            log.info("organizer_release_write_fenced", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              reason: "the mailbox is a tombstone, or this instance no longer leads the shard",
            });
          }
        } catch (err) {
          log.error("organizer_release_write_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "this process has stopped organizing the mailbox and its claim is gone; the "
              + "row could not record it, so the next cycle honours the request again",
          });
        }
        // The sentence is the RELEASE's, not a stand-down's: nobody took this mailbox, so
        // "schedule it again where the mailbox is organized now" would name a place that does not
        // exist. See `RELEASED_ORGANIZER_SEND_SENTENCE`.
        await standDownAppointments(
          mb, "organized_elsewhere:unknown", RELEASED_ORGANIZER_SEND_SENTENCE,
        );
        /* THE SENTENCE ONLY GOES IN THE LOG IF IT IS TRUE. This fired unconditionally — after a
           withheld write, after a fenced write, after a write that threw — so the log said the
           person had stopped organizing the mailbox in exactly the cases where the row still said
           otherwise. A log line that reports an outcome has to read the outcome. */
        if (stamped) {
          log.info("organizer_released", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
            reason: "the person stopped organizing this mailbox here; the row keeps its "
              + "credentials, its consent and its mirror, and this install reads it from now on",
          });
        } else {
          log.info("organizer_release_pending", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
            reason: "this install has stopped organizing, and the row does not yet record the "
              + "release; the request stands and is honoured again next cycle",
          });
        }
        return false;
      }
      /* A consent-less mailbox is never promoted by an empty folder. `decideLease`'s first arm
       * organizes a mailbox with ZERO claims ("nobody has ever organized this"), the right answer for
       * a mailbox somebody asked us to organize and a SEIZURE for one they merely connected.
       * `POST /mailboxes` now creates a consent-less reader precisely so a fresh connect moves
       * nothing, and without this line the first cycle would find an empty `ohmail/_meta`, claim it,
       * create the tree and file the backlog — before the person ever saw the consent screen. It sits
       * ABOVE the read because it is not a fact about the LEASE (the folder says what it says) but
       * about whether THIS install has been asked, which lives in the row. `takeover_authorized_at`
       * overrides it and must: that stamp IS the explicit human action, written beside consent in one tx.
       */
      if (lease.organizeConsentedAt === null && lease.takeoverAuthorizedAt === null) {
        log.info("organizer_awaiting_consent", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
          reason: "nobody has asked this install to organize this mailbox, so it reads it and "
            + "moves nothing — an empty lease folder must not be read as permission",
        });
        return false;
      }
      /* A reader with no press never enters the gate. `readMailboxLease` is not a report — it runs the
       * WRITE gate, and `decideLease`'s arm 4 ("no readable claim, so nobody has ever organized this")
       * answers `organize` and APPENDS. That arm is correct for the question it is asked; the mistake
       * was asking it. A CONSENTED READER against an EMPTY `ohmail/_meta` is what the folder looks like
       * the moment the other organizer releases cleanly, so this gate ran arm 4 the next cycle, claimed
       * the mailbox and promoted the row — AUTO-RESUME WITH NO PRESS, sixty seconds after somebody
       * moved organizing away, and the release above reversed by the cycle that performed it. The
       * desktop door never had it (`reader-no-auto-resume.test.ts`). Nothing replaces the read: both
       * call sites already peek on `false` through `refreshReaderHolder`, so the banner stays fresh. `takeoverAuthorizedAt` is the exemption — that stamp IS the explicit human action.
       */
      if (lease.organizerRole === "reader" && lease.takeoverAuthorizedAt === null) {
        log.info("organizer_reader_peek_only", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
          reason: "this install reads this mailbox and nobody has asked it to organize it, so it "
            + "looks at the lease and never runs the gate — an empty folder is not permission",
        });
        return false;
      }
      /* What this claim will offer a reader (mail 0090). `requests` is advertised only while this
       * account HOLDS a request key, the only thing that lets this organizer tell a genuine reader's
       * decision from a message anyone with APPEND rights wrote — no key, no capability, a reader
       * refused honestly at its own door. MINTED here, not merely read, and only on THIS door: the
       * hosted database is where an account's key lives, so the hosted worker is the one process
       * entitled to create one; a LOCAL install must never mint its own (it would generate a key the
       * Cloud reader has never seen) and receives it over an authenticated call. So the answer is
       * unconditionally YES once the mint returns, and the `catch` is the interesting case: a key this
       * process could not read or create means the claim advertises NOTHING, the fail-safe direction. Read AFTER the reader peek-only return, so a mailbox this install merely reads mints no key.
       */
      // WHAT THIS CLAIM OFFERS A READER: `requests`, but only where a shared secret exists to
      // verify one with. The key is derived from the mailbox password at attach and carried on the
      // runtime; an OAuth mailbox has none, so this claim advertises nothing and a reader is
      // refused honestly at its own door.
      const hasRequestKey = requestKeyForGate !== null;

      // The instant the gate ASKED, captured once: the permit's TTL is measured from the look, and
      // a second clock reading taken after the round trip would date the receipt in the future.
      const gateAskedAt = new Date();
      const leaseArgs = {
        adapter,
        self: leaseSelfFor(nonce),
        mailboxId: mb.mailboxId,
        hasRequestKey,
        // The no-seize-back rule. The stamp is what tells "the user just added this
        // mailbox to Cloud" apart from "the account was parked and came back", which are
        // otherwise identical to the gate.
        //
        // THE INSTANT AND NOT A FLAG (0.14.1). It is the row's own `takeover_authorized_at`,
        // handed over unchanged, because the election ranks presses against each other: what
        // decides a contest between this install and another one that has ALSO been pressed for is
        // which person pressed last, and a boolean cannot say.

        // AND THE VERB, which lets rule 6 refuse a press that asked only to JOIN a mailbox
        // somebody else is organizing. The two are one fact about one press.
        takeover: lease.takeoverAuthorizedAt
          ? { authorizedAt: lease.takeoverAuthorizedAt, intent: lease.takeoverIntent }
          : null,
        ...(organizerStaleAfterMs !== undefined ? { staleAfterMs: organizerStaleAfterMs } : {}),
        log: (event: string, detail: Record<string, unknown>): void => {
          log.info(event, { ...detail, mailboxId: mb.mailboxId, accountId: mb.accountId });
        },
      };
      const outcome = await readMailboxLease({ ...leaseArgs, now: gateAskedAt });

      if (outcome.organize) {
        nonce.leaseNonce = outcome.nonce;
        // THE READ ABOVE IS THE PERMIT'S FIRST LOOK, adopted rather than repeated: the gate renews
        // our claim, so running it twice here is the same-millisecond self-stand-down
        // `MIN_PERMIT_TTL_MS` refuses. Every write in the cycle that follows asks this receipt.
        nonce.leasePermit = await acquireLeasePermit({
          ...leaseArgs, adopt: { outcome, at: gateAskedAt },
          /* THE NONCE THE PERMIT RENEWS IS THIS RUNTIME'S NONCE. A re-read past the deadline or
             the write count writes a new claim and expunges the old one; holding the old nonce
             made the next cycle's gate read this worker's own claim as a restored clone, stand it
             down, and leave a live claim with nobody behind it. See `LeasePermitInput.onRenew`. */
          onRenew: ({ nonce: renewed }) => { nonce.leaseNonce = renewed; },
        });
        // ONE-SHOT. The authorization bought this becoming and no other; leaving it set would
        // let a lapse-then-resubscribe seize the mailbox back months later from whatever a human
        // deliberately moved it to. Written only when there IS something to clear, so the steady
        // state is zero extra writes per cycle.
        /* And the row's role is the third term, without which this wrote nothing. The two original
         * terms were the whole of "there is a stand-down on this row" while a stand-down WAS
         * `status='disabled'` plus a reason; 0083 moved that fact to `organizer_role` and left
         * `disabled_reason` with no writer, so for the one shape needing no stamp — a CONSENTED reader
         * whose foreign organizer released its claim, at which point `decideLease` says organize — both
         * terms were null and this block was skipped: the lease said organizer, the pipeline ran as
         * organizer, and the ROW went on saying `reader`. That is not cosmetic: `organizer_role` is the
         * authority every write door consults (`assertOrganizerRole`), so the process moved mail on
         * IMAP while its own API answered `409 organized_elsewhere`. `engine.ts` repaired the identical hole.
         */
        if (lease.takeoverAuthorizedAt || lease.disabledReason || lease.organizerRole === "reader") {
          try {
            await clearOrganizerStandDown(db, mb.mailboxId, { fence });
            lease.takeoverAuthorizedAt = null;
            lease.disabledReason = null;
            // The row now says `organizer`, so the next cycle issues no second UPDATE — the
            // "no-op UPDATE every cycle" `clearOrganizerStandDown`'s header refuses to pay for.
            lease.organizerRole = "organizer";
          } catch (err) {
            // The gate already said organize and our claim is already written. Failing to spend
            // the stamp costs one more cycle of it being spendable, never correctness.
            log.warn("organizer_takeover_clear_failed", { mailboxId: mb.mailboxId, accountId: mb.accountId, err });
          }
        }
        return true;
      }

      /* The intents this process recorded and may no longer carry out. Between the takeover and this
       * poll the row still read `organizer`, so a paired device's forwarded move passed
       * `assertOrganizerRole` and was recorded as a local `folder_state` intent — a reader's
       * `reconcileFolders` skips it and the install that CAN perform it has never heard of it, so the
       * near side shows a move that never reaches the mail server. It travels now, as the
       * `message.move` request the door would have written. ON THE TRANSITION ONLY —
       * `lease.organizerRole` still holds what the row says and this gate answers `stand_down` every
       * cycle while a foreign claim stands, so an ungated export would mint a request per cycle.
       * Best-effort: this process has already stopped organizing the mailbox. */
      /* The handover rides the demotion's own transaction, and both halves are contingent. It used to
       * be a separate transaction ahead of the write, leaving two sequences open: a paired device's
       * forwarded move committing AFTER a handover read its pending set and BEFORE the demotion (the
       * host accepted the move, became a reader, and neither performed nor exported it); and the
       * handover's own failure swallowed, so a demotion was recorded with an export that did not
       * happen. One transaction closes both: `markMailboxStoodDown` takes `FOR UPDATE` first and
       * `assertOrganizerRole` takes `FOR SHARE` inside a forwarded-move transaction, so the lock is
       * granted only once every such write has committed, and one arriving after waits and is refused.
       * ON THE TRANSITION ONLY, or an ungated export would mint a request per cycle. */
      const wasOrganizer = lease.organizerRole === "organizer";
      /* A HOLDER RATHER THAN A `let`, so the read below is the handover's own answer and not a
         narrowing of the initializer: the assignment happens inside the transaction's callback. */
      const handed: { r: StandDownExport | null } = { r: null };
      log.warn("organizer_stand_down", {
        mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
        disabledReason: outcome.reason,
        // WHETHER THE OTHER ORGANIZER IS STILL RENEWING. The row cannot hold this — a disabled
        // mailbox leaves the roster, so nothing would ever refresh it — but the log can, and it
        // is the difference between "a live install holds this" and "an install stopped and left
        // its claim behind", which are the same `disabled_reason` and completely different
        // incidents.
        organizerState: outcome.state,
        // The claim's DISPLAY NAME is the only field of a foreign claim worth logging: it is
        // what the takeover prompt shows a human. The install id is an opaque handle and the
        // heartbeat is noise at this level.
        heldBy: outcome.by?.displayName ?? null,
        reason: "another organizer holds this mailbox; disabling it here and syncing nothing — " +
          "exactly one active organizer per mailbox is the invariant this enforces",
      });
      try {
        // The holder columns ride the SAME statement as the role : a row that says
        // `reader` without naming who organizes it is a banner with a blank in it, and the banner
        // reads the row precisely so no client has to dial IMAP to render one.
        const written = await markMailboxStoodDown(db, mb.mailboxId, outcome.reason, {
          fence,
          ...(wasOrganizer
            ? {
              also: async (tx: typeof db): Promise<void> => {
                handed.r = await exportPendingMovesOnStandDown(tx as unknown as Tx, {
                  accountId: mb.accountId, mailboxId: mb.mailboxId, now: new Date(),
                  mintId: randomUUID,
                });
              },
            }
            : {}),
          by: {
            kind: outcome.by ? outcome.by.kind : null,
            // Mail 0092 — the winner's install id, so a stood-down row names WHICH install beat
            // it rather than only what sort of install it was.
            installId: outcome.by ? outcome.by.installId : null,
            displayName: outcome.by ? outcome.by.displayName : null,
            claimedAt: outcome.by ? outcome.by.claimedAt : null,
            state: outcome.state,
            capabilities: outcome.by ? outcome.by.capabilities : null,
          },
        });
        if (!written) {
          log.info("organizer_stand_down_write_fenced", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox is a tombstone, or this instance no longer leads the shard; the "
              + "handover of pending local moves did not run either, and the instance that does "
              + "lead the shard stands the same mailbox down on its own next pass",
          });
        } else {
          /* THE ROW'S MIRROR, AS `markMailboxStoodDown` HAS JUST LEFT IT — and it moves only on a
             write that LANDED. It used to be set ahead of the write, which made the mirror say
             `reader` after a write that threw: the next cycle's transition gate then skipped the
             handover for ever, so one failed write stranded every pending intent. Leaving it at
             `organizer` costs one more cycle of this row admitting a forwarded move, and that
             move is exported by the retry. */
          lease.organizerRole = "reader";
        }
        // Only when there was something to hand over: the overwhelming majority of stand-downs
        // have no pending intent and must stay silent.
        const r = handed.r;
        if (r !== null && (r.exported > 0 || r.unmappable > 0)) {
          log.warn("organizer_stand_down_moves_handed_over", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            exported: r.exported, already: r.already, unmappable: r.unmappable,
            reason: "these moves were recorded here before the lease was read again; each is now a "
              + "request for the install that holds the mailbox. `unmappable` are intents this "
              + "handover cannot express — a desired folder no destination word covers, or a "
              + "message with no usable dedup key — and they stay pending exactly where they are",
          });
        }
      } catch (err) {
        log.error("organizer_stand_down_write_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "neither the demotion nor the handover of pending local moves was recorded, so "
            + "the row still says this install organizes the mailbox; this cycle organizes "
            + "nothing and the next one demotes and hands over again",
        });
        return false;
      }
      // And the appointments this process can no longer keep are closed with a sentence. The mailbox
      // leaves the roster here (`loadEnabledMailboxes` excludes `disabled`) and a pending scheduled
      // send does not travel (the portable profile carries configuration, deliberately no drafts), so
      // the appointment is owed an ending now — see `closeStoodDownAppointments` for why FAILED rather
      // than handed over (an adopted appointment is two organizers holding one send). Best-effort, and
      // the hosted scheduled-send pass is the backstop. DELIBERATELY NOT FENCED: the fence arbitrates
      // Cloud against Cloud, but the LEASE said another organizer holds this, a fact any instance
      // reading `ohmail/_meta` reaches — and fencing it would break the ordinary case, since
      // `lifecycleWhere` refuses an already-disabled mailbox, so `markMailboxStoodDown` returns false
      // on every repeat and a close gated on that would never run for a long-stood-down mailbox.
      await standDownAppointments(mb, outcome.reason);
      return false;
    }


    /**
     * The stand-down's appointment close. Its own function rather than four inline statements in
     * the gate, so the gate's stand-down arm still reads as one decision — and never throws, for
     * the reason its call site gives. `toStandDown`'s post-loop detach is deliberately NOT a
     * second call site: those runtimes are exactly the ones this gate already answered `false`
     * for, so the close has already run for each of them.
     */
    async function standDownAppointments(
      mb: { mailboxId: string; accountId: string }, reason: MailboxDisabledReason,
      /**
       * The RELEASE's sentence, when this close is a release rather than a stand-down (0.14.1).
       * Omitted, `reason` chooses — every pre-0088 caller. See `RELEASED_ORGANIZER_SEND_SENTENCE`
       * for why a release cannot quote a stand-down's: nobody took this mailbox, so "schedule it
       * again where the mailbox is organized now" names a place that does not exist.
       */
      sentence?: string,
    ): Promise<void> {
      try {
        const r = await closeStoodDownAppointments(db as unknown as Tx, {
          accountId: mb.accountId, mailboxId: mb.mailboxId, reason, now: new Date(),
          ...(sentence !== undefined ? { sentence } : {}),
        });
        // Only when something closed: the overwhelming majority of stand-downs have no
        // appointment to close and must stay silent.
        if (r.closed > 0) {
          log.warn("scheduled_sends_stood_down", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, closed: r.closed,
            disabledReason: reason,
            reason: "these scheduled sends were made by this organizer and cannot travel; each " +
              "is now an ordinary draft carrying the sentence its Drafts row quotes",
          });
        }
      } catch (err) {
        log.error("scheduled_sends_stand_down_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "a scheduled send this process can no longer make was not closed with its " +
            "sentence; the hosted pass refuses a disabled mailbox at due time and closes it there",
        });
      }
    }

    /**
     * Release the claim on a mailbox this process is no longer entitled to organize. The roster half
     * (the parked-accounts reader dropping a parked account's mailboxes out of `loadEnabledMailboxes`,
     * `reconcileRoster` detaching them) is not enough: a dropped row leaves a FRESH claim in
     * `ohmail/_meta`, and a fresh Cloud claim stands a desktop install down — the account is parked,
     * the user clicks "Organize from this Mac", and the button appears to do nothing for the staleness
     * window. So the claim is deleted while the connection that can delete it is open. This is the
     * ONLY teardown path that releases: `detach` is also reached by a connection error, quarantine,
     * lost lock and clean stop, and in every one Cloud intends to keep organizing. Best effort — a release that could abort a detach would be worse than the fault it reports.
     */
    async function releaseOrganizerClaim(
      /**
       * The three fields this needs, rather than a whole {@link MailboxRuntime} — which a runtime
       * still satisfies, so the roster's call sites are unchanged. Widened in 0.14.1 because the
       * release arm inside `mayOrganize` runs BEFORE a runtime exists on the attach path: it holds
       * the adapter and the two ids and nothing else, and building a runtime to satisfy a
       * parameter would be inventing state to describe a mailbox this process is giving up.
       */
      rt: {
        mailboxId: string; accountId: string; adapter: MailboxAdapter;
        /** The nonce of the claim being given up — a release is addressed by (install, nonce). */
        leaseNonce: string | null;
      },
      why: string,
    ): Promise<number | null> {
      /* IT RETURNS THE COUNT NOW, and `null` for "could not look". This returned `void` and
         swallowed a removal of ZERO — see the caller for what that cost. The three answers are
         genuinely different: we removed our claim, our claim was not there, and we could not
         reach the folder. Collapsing the last two into the first is how a release got certified
         over somebody else's live claim. */
      try {
        /* BOTH SIDES OF THIS HUNK ARE LOAD-BEARING. Upstream widened `releaseMailboxClaim` to
           take the mailbox id; this lane changed the control flow so the COUNT is returned and a
           zero no longer returns early — the caller has to tell "removed our claim" from "our
           claim was not there". Keeping either alone silently loses the other. */
        /* THE NONCE THIS RUNTIME WROTE, so the delete names the claim this process holds and not a
           sibling lineage's. `null` — no gate has run on this runtime yet — refuses inside, and
           the lapse bound above records the release when the claim stops being renewed. */
        const released = await releaseMailboxClaim(
          rt.adapter, organizerInstallId, rt.mailboxId, rt.leaseNonce,
          // The CONFIGURED window, so the stale term and every other reader of this folder agree.
          ...(organizerStaleAfterMs !== undefined ? [{ staleAfterMs: organizerStaleAfterMs }] : []),
        );
        if (released > 0) {
          log.info("organizer_claim_released", {
            mailboxId: rt.mailboxId, accountId: rt.accountId, claims: released, reason: why,
          });
        }
        return released;
      } catch (err) {
        log.warn("organizer_claim_release_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, err,
          reason: "the claim will age out of ohmail/_meta on its own; until it does, a LOCAL " +
            "install that tries to take this mailbox over stands itself down again",
        });
        return null;
      }
    }

    async function quarantineMailbox(
      mailboxId: string, accountId: string, reason: unknown, phase: MailboxErrorPhase,
    ): Promise<void> {
      const prev = quarantine.get(mailboxId);
      const attempts = (prev?.attempts ?? 0) + 1;
      // Prefer the server's own backoff hint, bounded by our ceiling. imapflow parses MS365's
      // throttle reply — "Suggested Backoff Time: 92415 milliseconds" — onto the error as
      // `err.throttleReset` (imapflow@1.5.0). It is MILLISECONDS, raw; reading it as seconds sleeps
      // for a day. This worker parsed it and threw it away, so a provider that told us exactly when to
      // come back was retried on our own ladder regardless — which earns the next throttle. `Math.max`
      // then `Math.min` is the contract: the hint may only LENGTHEN the wait (never shorter than the
      // ladder) and may never escape `retryMaxMs` (a hostile hint cannot park a mailbox for ever).
      // `Number.isFinite` rather than `typeof === "number"`: `Math.max(x, NaN)` is NaN, `retryAt`
      // becomes NaN, and every `Date.now() >= NaN` is false — the mailbox would never leave quarantine.
      const raw = (reason as { throttleReset?: unknown } | null | undefined)?.throttleReset;
      const hint = Number.isFinite(raw) ? (raw as number) : 0;
      const wait = Math.min(Math.max(backoffFor(attempts), hint), retryMaxMs);
      const retryAt = Date.now() + wait;
      quarantine.set(mailboxId, {
        attempts, retryAt,
        reason: reason instanceof Error ? reason.message : String(reason),
        // Optimistic-false: the entry exists from this statement onwards, and the write below is
        // awaited. Until it returns true the in-memory instant governs, which is the pre-0039
        // behaviour and the correct fallback.
        persisted: false,
      });
      // The row now records WHY, not merely THAT. See `markMailboxFailed` for why the detail is
      // an allowlisted token and never the error's message. Still best-effort: a worker
      // deployed ahead of mail migration 0023 fails this write and logs it, rather than crashing on a
      // column that does not exist yet — a mailbox must never be un-quarantined by a
      // bookkeeping failure.
      const code = classifyMailboxError(reason, phase);
      /**
       * A ceiling we set is not a broken mailbox — the one arm that does not write `error`.
       * `ImapBoundExceeded` is raised by this codebase, never by the server: the mailbox
       * authenticated, answered, and sent more than one pass takes. `classifyMailboxError` reads
       * response codes, errnos and a flag, none of which a bound breach carries, so it answers `sync`
       * and the row used to say the mailbox failed. The backoff is UNCHANGED (the ladder runs, the
       * in-memory entry is written, `retry_after` persists it) — only the row's verdict moves. Keyed
       * on the CLASS, not a bound code, so a ceiling added later is covered without being enumerated.
       */
      const bounded = isImapBoundExceeded(reason);
      if (bounded) noteBlock(readLimited, mailboxId, "read_limited");
      try {
        // Mail migration 0039: the same statement now also records WHEN. That is what makes this backoff
        // survive a restart and — the point of the column — releasable by an operator, because
        // until now the only exits from quarantine were the ladder expiring and a redeploy.
        const written = bounded
          ? await markMailboxReadLimited(db, mailboxId, { fence, retryAfter: new Date(retryAt) })
          : await markMailboxFailed(
            db, mailboxId, { code, detail: mailboxErrorDetail(reason) },
            { fence, retryAfter: new Date(retryAt) },
          );
        // Only a write that LANDED lets the column govern this mailbox. Re-read from the map
        // rather than closed over: the entry could have been dropped by a roster pass while this
        // write was in flight, and resurrecting it here would re-quarantine a mailbox that has
        // left the duty.
        if (written) {
          const held = quarantine.get(mailboxId);
          if (held) held.persisted = true;
        }
        if (!written) {
          // FENCED, not failed. Either the user disconnected this mailbox while the attempt was
          // in flight, or another instance now leads this shard — in both cases the row we would
          // have written is a stale claim, and refusing it IS the correct outcome. Logged at
          // info because it is a normal handover, not an incident.
          log.info("mailbox_failure_write_fenced", {
            mailboxId, accountId, errorCode: code,
            reason: "the mailbox is disabled or this instance no longer leads the shard",
          });
        }
      } catch (err) {
        log.error("mailbox_failure_write_failed", {
          mailboxId, accountId, errorCode: code, err,
          reason: "the mailbox is quarantined in memory but its row could not record why",
        });
      }
      // `errorCode` is the code that was WRITTEN, so a bounded refusal reports none: the row
      // carries `sync_blocked_reason` instead, and naming `sync` here would send a reader looking
      // for an `error_code` the row does not hold. The event and its level are unchanged — the
      // backoff is real either way, and four suites read this line's `attempts`/`retryInMs`.
      log.error("mailbox_quarantined", {
        mailboxId, accountId, attempts, retryInMs: wait, err: reason,
        ...(bounded ? { syncBlockedReason: "read_limited" } : { errorCode: code }),
      });
    }

    /**
     * Persist a VERIFIED recovery, and never let its failure tear down a working mailbox.
     *
     * Called from two places, which is the fix for a bug this file used to carry: the attach
     * path wrote it once and the comment claimed "the next roster pass writes it" if that
     * failed. It did not — `reconcileRoster` skips anything already in `runtimes`, so a mailbox
     * whose recovery write failed served correctly while its row said `error` FOREVER, which is
     * indistinguishable from the outage this slice is about. The roster pass now calls this too.
     */
    async function markRecovered(mb: { mailboxId: string; accountId: string }): Promise<void> {
      try {
        const written = await markMailboxConnected(db, mb.mailboxId, { fence });
        if (!written) {
          // The disconnect case is the one that matters here: a recovery that began from an
          // `error` snapshot must not resurrect a mailbox the user has since disconnected, and
          // must not overwrite a replacement leader's view of it. `reconcileRoster` detaches
          // the runtime on its next pass.
          log.info("mailbox_recovery_write_fenced", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox is disabled or this instance no longer leads the shard",
          });
          return;
        }
        log.info("mailbox_recovered", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, status: "connected",
        });
      } catch (err) {
        log.error("mailbox_status_write_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "mailbox recovered but its status row could not be updated — the next roster " +
            "pass retries this while the mailbox stays attached and serving",
        });
      }
    }

    /**
     * One mailbox's connection died asynchronously — contain it to that mailbox. This is the callback
     * every adapter is handed. `ImapFlow` reports a socket that FAILED by EMITTING `error`; with no
     * listener Node raises an uncaught exception and `entry.ts` exits the process, so one customer's
     * hiccup took down the shard and restarted the container every ~26 s. It now also hears a socket
     * that merely ENDED: imapflow calls `close()` on `_socketClose`/a failed IDLE recovery, which
     * emits `close`, never `error` — nothing listened, so a total outage had zero connection events.
     * The two shapes are separated BY CLASS (never a driver string): ERRORED → detach AND quarantine;
     * merely ENDED → DETACH ONLY (no `error`, no backoff), so the next roster pass re-dials in 30 s rather than waiting out `retryBaseMs`. ON THE QUEUE, so a detach never closes an adapter a cycle is using and an error during `attach()` lands after that attach's own catch.
     */
    function handleConnectionError(mailboxId: string, accountId: string, err: unknown): void {
      if (stopped) return;
      const ended = err instanceof ImapConnectionClosedError;
      log.error("mailbox_connection_error", {
        mailboxId, accountId, err,
        reason: ended
          ? "the provider connection ENDED (imapflow emitted `close`, which nothing listened for " +
            "until the dead-connection fix); detaching THIS mailbox so the next roster pass re-dials it — NOT " +
            "quarantined, because a socket that closed is not a broken mailbox"
          : "the provider connection emitted an error; detaching and quarantining THIS " +
            "mailbox — before this listener existed the same event exited the process",
      });
      void serialize(async () => {
        const rt = runtimes.get(mailboxId);
        // Already gone: the attach path's own catch owns it, a roster pass detached it, or a
        // second `error` followed the first. Nothing to do, and nothing to double-count.
        if (!rt || stopped) return;
        if (ended) {
          await detach(rt, "the provider connection closed — the next roster pass re-attaches it on a fresh one");
          return;
        }
        await detach(rt, "the provider connection emitted an error");
        await quarantineMailbox(mailboxId, accountId, err, "sync");
      }).catch((e: unknown) => {
        log.error("connection_error_handling_failed", { mailboxId, accountId, err: e });
      });
    }

    /** Unwatch + CLOSE a mailbox's connection and drop it from the rotation. */
    async function detach(rt: MailboxRuntime, reason: string): Promise<void> {
      runtimes.delete(rt.mailboxId);
      // THE KNOWN-SET MEMO DIES WITH THE ATTACHMENT. Dropping the runtime already makes it
      // unreachable, so this is belt AND braces — but it is the braces that state the invariant:
      // an in-memory copy of a mailbox's known UIDs may never outlive this process's claim on that
      // mailbox, because the next organizer is free to write those very rows.
      rt.deps.knownSet?.drop(`detached: ${reason}`);
      if (rt.unwatch) { try { await rt.unwatch(); } catch { /* ignore */ } }
      try { await rt.adapter.close(); } catch { /* ignore */ }
      log.info("mailbox_detached", { mailboxId: rt.mailboxId, accountId: rt.accountId, reason });
    }

    /**
     * Register one mailbox into the rotation: connect, prove the organizer lease, ensure the folder
     * tree, join `runtimes`, kickstart once, establish IDLE. It does NOT sync — the first drain and
     * restart convergence both ride `cycle()`, and the reason is measured: with two inline sync cycles
     * here, one production mailbox held this function for over six minutes and the next mailbox in the
     * roster was not dialled until it returned. EVERY failure path closes the adapter it just opened —
     * previously a throw from `ensureFolders()` or the inline drain leaked the connection, because the
     * adapter had not been pushed onto the tracked list yet.
     */
    async function attach(mb: EnabledMailbox): Promise<void> {
      // The setup is INSIDE the boundary. `loadMailboxCreds` and `makeAdapter` used to run ABOVE the
      // `try` below — a shard-wide outage waiting for one corrupt row. A credential envelope that
      // cannot be decrypted (bad ciphertext, a key version this deployment no longer carries), or an
      // `adapterFactory` that refuses one mailbox's configuration, threw from OUTSIDE every catch: on
      // a cold start it rejected `startWorkerWithLock` and released the lock; on a timer pass the
      // pass-level catch stopped, so later unattached mailboxes were never visited. The roster is
      // stable oldest-first, so the same bad row led every pass and healthy mailboxes behind it stayed
      // unsynced for ever. `adapter` is therefore nullable and the catch null-guards its close — every
      // per-mailbox failure now happens where that mailbox's own catch can see it.
      let adapter: MailboxAdapter | null = null;
      let unwatch: (() => Promise<void>) | null = null;
      try {
        const creds = await loadMailboxCreds(db, mb.mailboxId, keyProvider, oauthTokenProvider);
        if (!creds) {
          // RECORD ONLY. The log below still announces once ever — that is a log-noise control and
          // it is correct — but it is no longer the ONLY record, which is what made this the most
          // silent of the three arms. `reconcileSyncBlocks` writes the row.
          noteBlock(awaitingCreds, mb.mailboxId, "awaiting_credentials");
          if (!announced.creds.has(mb.mailboxId)) {
            announced.creds.add(mb.mailboxId);
            log.warn("mailbox_awaiting_credentials", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              reason: "enabled but no 'imap' credential row — it cannot sync until credentials are provisioned",
            });
          }
          return;
        }
        awaitingCreds.delete(mb.mailboxId);
        announced.creds.delete(mb.mailboxId);

        // What this mailbox's submission server will accept (mail 0055). Attempted here because this
        // is a place that already holds decrypted SMTP credentials for a mailbox nobody is changing;
        // the rule and bounds are `learnSmtpMaxSize`'s, the timeouts and write `smtp-size.ts`'s. ON
        // THE MANAGED DEPLOYMENT THIS ALWAYS FAILS, measured: Railway blocks outbound submission
        // ports, so every dial answers "Connection timeout" while the IMAP dial to the same host on
        // 993 completes in the next log line — the managed service learns these numbers from the API
        // host instead. Kept because it is correct where egress is open (a self-hosted worker),
        // bounded to one refused connection per mailbox per process, logged at `info`. AWAITED rather
        // than fired-and-forgotten, so one mailbox's failure stays one mailbox's failure.
        try {
          const learned = await learnSmtpMaxSize({
            mailboxId: mb.mailboxId,
            announced: mb.smtpMaxSizeBytes,
            smtp: creds.smtp,
            attempted: smtpSizeAttempted,
            dial: smtpSizeDial,
          });
          if (learned.outcome === "learned") {
            await recordSmtpMaxSize(db, mb.mailboxId, learned.maxMessageBytes);
            log.info("mailbox_smtp_size_learned", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              announcedBytes: learned.maxMessageBytes,
            });
          } else if (learned.outcome === "failed") {
            // A submission server that refuses a login costs this mailbox its ceiling and nothing
            // else — the strict fallback still applies and the mailbox still syncs. `info`, not
            // `warn`: a mailbox whose SMTP password differs from its IMAP one is a supported
            // configuration this deployment simply cannot probe, not an incident.
            // A CLOSED CODE, never the submission server's own words: that text is written by a
            // third party, routinely contains the username, and `reason` is an allowlisted field.
            log.info("mailbox_smtp_size_unlearned", {
              mailboxId: mb.mailboxId, accountId: mb.accountId, code: learned.code,
            });
          }
        } catch (err) {
          // The RECORD can still fail (a database fault), and it must not take the attach with it.
          // The RECORD failed (a database fault), not the dial. `code` from our own taxonomy
          // rather than the driver's message, on the same rule as the arm above.
          log.info("mailbox_smtp_size_unlearned", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, code: "unknown",
          });
        }

        adapter = makeAdapter({
          host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
          // The connect-time plaintext consent, if the credential row carries one. See
          // `TransportCreds.allowInsecure` for why omitting this strands a consented mailbox.
          ...(creds.imap.allowInsecure ? { allowInsecure: true } : {}),
          // The `auth` union already assembled by the shared builder: `{ user, pass }` for a
          // password mailbox, `{ user, fetchAccessToken }` for oauth2. Passed through untouched.
          auth: creds.imap.auth,
          smtp: creds.smtp ? {
            host: creds.smtp.host, port: creds.smtp.port, secure: creds.smtp.secure,
            // An smtp credential row is always a password (oauth mailboxes carry no smtp row); narrow
            // to the password member so it fits `ImapConfig.smtp.auth`, and omit auth otherwise.
            ...("pass" in creds.smtp.auth ? { auth: creds.smtp.auth } : {}),
          } : undefined,
          sentDomain: config.sentDomain,
          // NOT the serverless defaults. This process holds its connections for the life of the
          // deployment and does bounded database work between IMAP commands; a 25 s socket
          // deadline chosen against Vercel's `maxDuration` is a deadline the worker's own cycle
          // can exceed legitimately. See `WORKER_NET_TIMEOUTS`.
          timeouts: WORKER_NET_TIMEOUTS,
        }, {
          accountId: mb.accountId, mailboxId: mb.mailboxId,
          onConnectionError: (err) => handleConnectionError(mb.mailboxId, mb.accountId, err),
        });
        // Said BEFORE the dial, because everything after it can still be slow: a hung provider,
        // a lease gate over four IMAP round-trips, a first `ensureFolders` against a real
        // server. Without this line an attach that never returns looks exactly like a worker
        // that never tried — which is precisely how a boot-time outage once read.
        log.info("mailbox_attach_started", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, host: creds.imap.host,
        });

        // ── EVERY PHASE IS TIMED, BECAUSE "WHICH PHASE DOMINATES" WAS UNANSWERABLE ─────────
        //
        // The production measurement could say only that `attach_started → attached` was
        // minutes for one mailbox and seconds for another. Nothing in the log said which phase, so
        // the diagnosis had to be argued from row counts in a retroactive query. These fields
        // ride on `mailbox_attached` so the NEXT boot answers it from production directly.
        //
        // There is deliberately no `restartMs`: the phase it would have measured is the pair of
        // inline sync cycles, and that is gone from this path entirely. A field reporting 0 for
        // a phase that no longer exists is worse than its absence — it reads as a fast drain.
        const tAttach = Date.now();
        await adapter.connect();
        const connectMs = Date.now() - tAttach;

        // The organizer lease, before the first move. Here and not below `ensureFolders()`: every line
        // after this WRITES to somebody's mailbox (`ensureFolders` creates the `ohmail/*` tree,
        // `runKickstart` re-routes the Screener backlog). If another organizer holds it, neither may
        // happen — "learn then act" is the rule for this seam, because reconnect-after-sleep is when a
        // mailbox most likely changed hands. Taking the first DRAIN off this path did NOT move this
        // gate, and the ordering is guarded (`ensure_folders` may not precede `lease_organize` —
        // `attach-nonblocking.e2e.test.ts`, claim 5). Standing down here returns EARLY and leaves the
        // mailbox out of `runtimes` (not a failure, so no retry backoff; the row is `disabled`, so the
        // next pass does not offer it). The nonce this gate writes is carried onto the runtime — it is
        // the clone defence's memory, and a discarded nonce re-arms that defence every cycle.
        const leaseState = {
          leaseNonce: null as string | null,
          // Until the gate runs there is no permit; the attach's own gate call replaces this.
          leasePermit: { noLease: "not_supplied" } as OrganizerWriteAuthority,
        };
        const leaseRow = {
          takeoverAuthorizedAt: mb.takeoverAuthorizedAt, takeoverIntent: mb.takeoverIntent,
          disabledReason: mb.disabledReason,
          // Mail 0083 — see `MailboxRuntime.lease.organizerRole`. This is the shape the promotion
          // hole was reachable through: an existing reader row attaches with no stamp and a null
          // reason, so without this the gate had nothing left to notice it by.
          organizerRole: mb.organizerRole,
          organizeConsentedAt: mb.organizeConsentedAt,
          // Mail 0088 — the release request, read at attach for the same reason the stamp above
          // it is: a press that landed while this process was down is still owed an answer, and
          // the first gate after a restart is where it gets one.
          releaseRequestedAt: mb.releaseRequestedAt,
        };
        /** What the row says the holder is, so the reader peek writes only on a CHANGE. */
        const holderSeen = {
          kind: mb.organizedByKind, name: mb.organizedByName,
          since: mb.organizedSince, state: mb.organizerState,
          capabilities: mb.organizedByCapabilities,
          installId: mb.organizedByInstallId,
        };
        const tLease = Date.now();
        /* A stand-down no longer ends the attach. This block used to `return`, and the mailbox left
         * the roster with its connection closed — standing down meant stopping. It now means BEING A
         * READER (another mail client on the mailbox), so the attach continues with `role: "reader"`,
         * keeps its login and poll timer, and builds a mirror that GROWS; what it does not do is the
         * four things below that write to somebody else's mailbox. `mayOrganize` has already written
         * the demotion, the holder columns and the appointment close, exactly as before. TWO REFUSALS
         * ARE FOLDED INTO ONE ANSWER: `mayOrganize` returns false both for "somebody else holds this"
         * and "nobody asked this install to organize it" (a consent-less mailbox), and the attach
         * treats them identically because the BEHAVIOUR is (read, do not move); the row tells them apart.
         */
        const role: OrganizerRole =
          (await mayOrganize(mb, leaseRow, leaseState, adapter, "attach",
            deriveRequestKey({ auth: creds.imap.auth, address: mb.address }))) ? "organizer" : "reader";
        const leaseMs = Date.now() - tLease;
        if (role === "organizer") {
          leaseBlocked.delete(mb.mailboxId);
        } else {
          // `reason: null` — the ROLE now carries the whole answer to "why is this mailbox not
          // being organized here", and it is a better answer than any sync-block member. See
          // `SyncBlock`.
          noteBlock(leaseBlocked, mb.mailboxId, null);
          // The row's holder columns, refreshed from the same connection that just looked. On the
          // stand-down path `markMailboxStoodDown` has already written them from the verdict's own
          // claim; this covers the OTHER arm — a consent-less reader, whose refusal never read the
          // folder at all, so without this its banner would have nothing to say.
          await refreshReaderHolder(mb, adapter, holderSeen);
        }
        const tFolders = Date.now();
        /* -- `ohmail/*` IS CREATED BY AN ORGANIZER AND BY NOTHING ELSE ------------------------
         *
         * The first of the four skips, and the one the two-worlds test asserts against the SERVER
         * rather than against a log line: after N reader cycles over unruled INBOX mail, `ohmail/*`
         * is ABSENT on the mail server and every message is still in INBOX. A reader that created
         * the tree would be visibly organizing a mailbox it does not hold — in every other mail
         * client the person owns, and in the folder list of whoever does hold it.
         */
        if (role === "organizer") await adapter.ensureFolders();
        const foldersMs = Date.now() - tFolders;
        // ── Mail 0065: DISCOVER THE PROVIDER'S OWN \Junk AND \Trash, AND WRITE THEM DOWN ──
        //
        // Read-only (one LIST) and re-written on EVERY attach, so a folder the user creates or
        // renames heals on the next connect with no operator action. The columns are what lets
        // the API refuse a delete up front (`no_trash_folder`) and the reconciler file a spam
        // verdict into native Junk without a LIST per pending row — the API may never open
        // IMAP. Best-effort: a discovery failure leaves the stored answer as it was, and the
        // fallbacks (Quarantine / refusal) are never destructive. See imap-types.ts for the
        // product rule this serves.
        if (typeof adapter.findSpecialFolders === "function"
          && typeof repo.setMailboxSpecialFolders === "function") {
          try {
            const found = await adapter.findSpecialFolders();
            await repo.setMailboxSpecialFolders(mb.mailboxId, {
              junkFolder: found.junk, trashFolder: found.trash,
            });
          } catch (err) {
            log.warn("special_folder_discovery_failed", { mailboxId: mb.mailboxId, err });
          }
        }
        // accountId comes from the MAILBOX ROW, not from config: one process, many accounts.
        // The spend gate is built from that same accountId for exactly that reason.
        // The narrowed handle the sweep port's closures capture — `adapter` is a `let` above,
        // and TypeScript does not carry a `let`'s narrowing into a callback that runs later.
        const attachedAdapter: MailboxAdapter = adapter;
        /** The sweep's scan state for THIS attachment — see the `junkSweep.run` note below. */
        let sweepScan: SweepScanState = SWEEP_SCAN_START;
        const deps: SyncDeps = {
          repo, adapter, accountId: mb.accountId, mailboxId: mb.mailboxId,
          // Mail 0083. THE ATTACH-TIME ROLE, and it is the field's floor rather than its whole
          // story: `cycle()` re-verifies the lease before every pass and spreads `role: rt.role`
          // over these deps, so a flip in either direction applies on the very next cycle without
          // a re-attach. It is required here so this composition cannot be the one that forgets.
          role,
          // The leader fence over this mailbox's mail-bearing writes. The SAME `fence` the lifecycle
          // writes key on — one definition of "am I still the leader of this shard" — extended to
          // everything `runSyncCycle` persists and to its IMAP mutations. Before this line, a worker
          // whose advisory lock had dropped kept committing messages, advancing cursors, appending
          // change_log rows and issuing IMAP moves beside the new leader: the fence covered
          // `mailboxes.status` and nothing that carries mail. `() => lockLost` is the synchronous
          // tripwire — `handleLockLoss` flips it the moment loss is observed, so the in-flight cycle
          // refuses its NEXT write and unwinds. `stopped` is deliberately NOT part of it: a graceful
          // shutdown lets in-flight writes complete.
          fence: makeSyncWriteFence(db, mb.mailboxId, fence, () => lockLost),
          ...(spend ? { credits: spend } : {}),
          // Whose `Authentication-Results` this mailbox may believe, resolved from the
          // SAME host string the adapter above dials. Empty for every provider the table does
          // not name, which routes exactly as before this field existed; for Gmail/Microsoft it
          // is what lets a forged known-contact `From` be demoted to the Screener.
          trustedAuthservIds: providerAuthservIds(creds.imap.host),
          // One ledger per attachment, and that lifetime is the design. Per mailbox, because a
          // written-off UID is meaningless in another mailbox's folders. Built HERE rather than per
          // cycle, because the two things it remembers are cross-cycle: how many times a message has
          // failed, and which UIDs must stay out of the known-set so their bodies are not re-fetched.
          // A ledger rebuilt per cycle would count every attempt as the first and never reach a
          // terminal decision — the wedge, restated. The paragraph that used to be here is now FALSE:
          // it claimed a restart was how a parser fix reached skipped Sent mail, but the Sent cursor is
          // a UID watermark, so a restart does NOT re-offer a skipped UID (mail loss). Mail 0041 landed
          // the durable table; `runSyncCycle` hydrates this ledger from it, so dropping it on detach now
          // costs nothing.
          deadLetters: new DeadLetterLedger(),
          // One known-set memo per attachment, for the same reason as the ledger. `buildCursor`
          // re-read this mailbox's ENTIRE `message_instances` join at the top of every cycle —
          // thousands of rows a call, once per poll, for the life of the attachment. It is state this
          // process wrote and that nobody else may write while it holds the mailbox, so it is
          // remembered, and any write that could move it drops the memo (see `known-set.ts`). Built per
          // ATTACHMENT, not per process, because the lifetime is the safety argument: a mailbox that
          // changes hands is detached and re-attached and the new runtime starts cold. Dropped
          // explicitly on detach, the lock-loss tripwire and every stand-down — a memo of somebody
          // else's mailbox must stop existing the moment leadership is in doubt.
          knownSet: new KnownSetCache(mb.mailboxId),
          // The account's managed storage cap AT ATTACH — the per-cycle spread below refreshes
          // it, so this value's real job is that the field cannot be forgotten: it is required,
          // and this composition is the metered one.
          storageCap: await storageCapFor(mb.accountId),
          log,
          // ── THE ONE-TIME SWEEP'S COMMAND PORT (FOLDERS-SPEC.md §16.1) ─────────────────
          //
          // Built HERE because this is where the database handle and this mailbox's adapter
          // meet. `requested` reads the stamp as the server renders it; `run` is `junkSweepPass`
          // — the operator CLI's exact function — with the cycle's fences threaded in: the
          // leadership `guard` before every chunk's IMAP move, and a repo whose `transaction`
          // IS the fenced group, so every completion write rides the same fence the ingest and
          // reconcile groups do; `clear` retires only the observed token (`sync-kick.ts`'s
          // compare-the-text discipline), so a press landing mid-sweep is served next cycle.
          junkSweep: {
            requested: async () => {
              const [row] = await db
                .select({
                  at: sql<string | null>`${mailboxes.junkSweepRequestedAt}::text`,
                  off: mailboxes.foldersDisabledAt,
                })
                .from(mailboxes)
                .where(eq(mailboxes.id, mb.mailboxId))
                .limit(1);
              if (!row || row.at === null) return null;
              if (row.off !== null) {
                // Switched off under "Use folders" since the press (§17): an opted-out mailbox
                // performs no move on the feature's account. The stale stamp is retired here
                // — at its observed value — so the offer does not read "queued" for ever.
                await db.update(mailboxes)
                  .set({ junkSweepRequestedAt: null })
                  .where(and(
                    eq(mailboxes.id, mb.mailboxId),
                    sql`${mailboxes.junkSweepRequestedAt} = ${row.at}::timestamptz`,
                  ));
                log.info("junk_sweep_command_dropped", {
                  mailboxId: mb.mailboxId, accountId: mb.accountId,
                  reason: "the mailbox was switched off under Use folders after the press; nothing moves",
                });
                return null;
              }
              return row.at;
            },
            run: async (hooks) => {
              // ONE PRESS, ONE SCAN STATE — the reset is a named decision in `junk-sweep.ts`
              // rather than a conditional here, because a decision spelled inline in this file is
              // one nothing can assert. See `SweepScanState.command`.
              sweepScan = sweepStateForPress(sweepScan, hooks.command);
              const fencedRepo = new Proxy(repo, {
                get: (target, key, receiver) =>
                  key === "transaction" ? hooks.write : Reflect.get(target, key, receiver),
              }) as typeof repo & { transaction: typeof hooks.write };
              /**
               * ONE BOUNDED WINDOW PER CYCLE on a KEYSET cursor, with the scan's state carried
               * across cycles in the attachment ({@link adoptSweepWindow} is the whole decision,
               * pinned by test): the cursor advances until the scan runs off the end, and
               * `examinedAll` is true precisely when a WHOLE scan — top to end, however many
               * cycles it took — moved nothing. That is what lets `sync.ts` retire the command
               * over a pile the server refuses outright, without ever walking more than one
               * window inside one cycle.
               */
              const res = await junkSweepPass({
                db: db as unknown as Tx, repo: fencedRepo, adapter: attachedAdapter,
                accountId: mb.accountId, mailboxId: mb.mailboxId, execute: true,
                writeAuthority: hooks.writeAuthority,
                limit: JUNK_SWEEP_PER_CYCLE,
                ...(sweepScan.after !== null ? { afterId: sweepScan.after } : {}),
              });
              const adopted = adoptSweepWindow(sweepScan, {
                movedCount: res.moved.length,
                candidates: res.candidates.length,
                lastId: res.candidates.at(-1)?.messageId ?? null,
                junkFolder: res.junkFolder,
                deferredCount: res.deferred,
              }, JUNK_SWEEP_PER_CYCLE);
              sweepScan = adopted.state;
              return {
                moved: res.moved, skipped: res.skipped, junkFolder: res.junkFolder,
                // The scan's deferrals, not this window's. `res.deferred` is one window, and the
                // cursor moves past a deferred member, so the FINAL window of a multi-window scan can
                // honestly report zero while a row it deferred earlier is still in the pile — and the
                // retirement rule would then retire the command over exactly the mail the deferral
                // protected. So what crosses this boundary is the accumulated fact, in `SweepScanState`
                // beside `movedSinceTop`. `exhaustedDeferrals` is the termination bound: after three
                // consecutive completed scans kept alive by deferrals alone, the exemption stops and
                // the command may retire — without it, a stale locator nothing repoints keeps the
                // command queued and the mailbox re-kicked for ever.
                deferred: res.deferred,
                deferralsHold: adopted.deferralsHold,
                examinedAll: adopted.examinedAll,
              };
            },
            remaining: async () => {
              const [row] = await db
                .select({ n: sql<number>`count(*)::int` })
                .from(messages)
                .innerJoin(folderState, eq(folderState.messageId, messages.id))
                .where(junkSweepCandidateWhere(mb.accountId, mb.mailboxId));
              return Number(row?.n ?? 0);
            },
            clear: async (observed) => {
              await db.update(mailboxes)
                .set({ junkSweepRequestedAt: null })
                .where(and(
                  eq(mailboxes.id, mb.mailboxId),
                  sql`${mailboxes.junkSweepRequestedAt} = ${observed}::timestamptz`,
                ));
            },
          },
        };

        // Registering the mailbox IS what attach is for. This line used to be a fix for a reporting
        // bug — `reconcileOnRestart` drained inline below it, `runtimes` stayed empty for that drain,
        // and `stats()` plus every heartbeat said `mailboxes: 0` while the process did the busiest
        // thing it ever does (a first import ingested thousands of messages over most of an hour while
        // the heartbeat reported zero). Now the drain is gone from this function and this line is the
        // POINT of it: attach connects, proves the lease, ensures folders, joins the rotation and
        // establishes IDLE, and everything that reads mail rides `cycle()`. `unwatch` is null until
        // IDLE is established and is patched onto the same object; the serial queue guarantees no cycle
        // or roster pass interleaves with a mid-flight attach. The failure path is unchanged: the catch
        // deletes the runtime and quarantines.
        const rt: MailboxRuntime = {
          accountId: mb.accountId, mailboxId: mb.mailboxId, adapter, deps, unwatch: null,
          requestKey: deriveRequestKey({ auth: creds.imap.auth, address: mb.address }),
          failures: 0, lastSuccessAt: null, leaseNonce: leaseState.leaseNonce,
          leasePermit: leaseState.leasePermit,
          lease: leaseRow,
          // Mail 0083. Mutable, and re-read by every cycle — see the fields.
          role,
          holderSeen,
          // A FRESH CONNECTION HAS NOT FAILED TO READ ANYTHING YET. The gate above
          // just answered organize over this very socket, so starting anywhere but `null` would
          // charge the new connection for the dead one's silence.
          leaseUnavailableSince: null,
          // Attach no longer proves a sync, so what "recovered" means moved with the drain. See
          // the comment on this field and the one below `mailbox_attached`.
          needsRecovery: mb.status !== "connected",
          // Both start empty because a fresh runtime has reported nothing: it has not said
          // it owes a backlog and its IDLE has not fired. See the fields for why "unknown" resolves
          // to LIGHT here and not to heavy.
          owesBacklog: false,
          // The profile's write-behind, beside the lease it rides: same identity, same store,
          // ticked only from a cycle the gate admitted. `config.buildVersion` is the label the
          // health endpoint reports — provenance in the document, never a decision.
          profile: new OrganizerProfileSync({
            db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
            self: { installId: organizerInstallId, kind: "cloud" },
            producerVersion: config.buildVersion ?? "dev",
            ...(config.organizer?.profileFlushIntervalMs !== undefined
              ? { flushIntervalMs: config.organizer.profileFlushIntervalMs } : {}),
            log: (event, detail) => {
              if (/_failed$/.test(event)) log.warn(event, detail);
              else log.info(event, detail);
            },
          }),
          wokenAt: null,
        };
        runtimes.set(mb.mailboxId, rt);
        await beat();

        // Arm the profile hold before the first routing decision (TAKEOVER-RESCREEN). A mailbox taken
        // over from another organizer arrives CARRYING its decisions — the travelling profile in
        // `ohmail/_meta`. The write-behind's ordinary seed discovers it at the END of the first cycle,
        // after that cycle has already routed: the drill measured a cold takeover moving all 31 INBOX
        // messages of already-screened-in senders into the Screener while the document answering for
        // them sat one FETCH away. This read-only detection runs here — after the lease gate said
        // organize, before any cycle can route — so `cycle()`'s `importDecisionOpen` is true from the
        // first ingest. Never throws; a read fault retries at the first tick and the residual is at
        // most one pre-fix cycle. Ordinary mailboxes return in one FETCH and arm nothing.
        /* Skipped for a reader: the profile hold is an incoming organizer's question. The third of the
         * four skips. `armHoldFromFolder` exists so an organizer TAKING a mailbox over does not
         * re-screen the decisions it is inheriting — it detects a foreign profile document, holds it,
         * and asks whether to import. A reader inherits nothing and decides nothing, so there is no
         * question to hold; arming it would put a pending import prompt on screen for a mailbox this
         * install does not organize (the read is harmless, but the MARKER is what the confirm surface
         * renders). A PROMOTION does not come through here: mail 0083 promotes a reader IN PLACE on the
         * cycle path, which arms its own hold there — the two call sites are the two ways a process can
         * become this mailbox's organizer. */
        if (role === "organizer") await rt.profile.armHoldFromFolder();

        // Make the mailbox Screener-shaped, once, before the first drain. Here and not in `cycle()`:
        // it is a once-per-mailbox pass (`mailboxes.kickstart_at`, mail 0025) that must run BEFORE the
        // first drain — import the Sent folder's recipients into `contacts` first and the very first
        // routing decision already knows the user's correspondents; import them afterwards and hundreds
        // of messages have been filed into the Screener and need re-routing. Moving the drain onto the
        // cycle loop left the ordering intact: the first cycle is queued behind the roster pass this
        // attach belongs to, so it cannot begin until every attach — hence this kickstart — has
        // returned (a mid-cycle pass is AWAITED, from inside the cycle's own entry). It stays here
        // because it is once-per-mailbox and marker-gated, and a virgin Screener backlog is empty. A
        // FAILURE MUST NOT FAIL THE ATTACH — the marker is written only on success, so the next attach retries.
        const tKickstart = Date.now();
        /* -- SKIPPED FOR A READER: THE KICKSTART RE-ROUTES THE SCREENER BACKLOG ---------------
         *
         * The second of the four skips. `runKickstart` imports the Sent folder's recipients into
         * `contacts` and then RE-ROUTES the Screener backlog — physical IMAP moves, once per
         * mailbox, on the organizer's authority. Its marker (`mailboxes.kickstart_at`) is
         * deliberately left unwritten here, so a reader that is later promoted runs it on the
         * attach after the promotion, which is the first moment it is entitled to.
         */
        try {
          const shaped = role === "reader" ? { ran: false } as Awaited<ReturnType<typeof runKickstart>> : await runKickstart({
            repo, adapter, accountId: mb.accountId, mailboxId: mb.mailboxId, log,
          });
          if (shaped.ran) {
            log.info("mailbox_kickstarted", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              sentRecipients: shaped.sentRecipients, contactsImported: shaped.contactsImported,
              examined: shaped.examined, rerouted: shaped.rerouted, truncated: shaped.truncated,
            });
          }
        } catch (err) {
          log.error("kickstart_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "the mailbox is attached and syncing; the kickstart marker is unwritten, so " +
              "the next attach retries it",
          });
        }

        const kickstartMs = Date.now() - tKickstart;

        // Nothing that drains runs here — a rule now applied to the drain itself. Two changes deleted
        // work from this line for the same reason. The first ran `runThreadBackfill` here: minutes of
        // pure database work while the connection above was dialled, authenticated, NOT yet in IDLE
        // and with nothing awaiting it — the socket outlived its timeout, imapflow emitted the failure
        // on a client with no `error` listener, and an uncaught exception took the process down every
        // ~26 s (try/catch could not help — the throw did not come out of the call it wrapped). The
        // rule: nothing that does not need the connection runs while the connection is held and
        // unattended. A later measurement covered what was still here (`reconcileOnRestart`, two full
        // cycles, ~six minutes for one mailbox, false `sync_lag` pages every deploy), so restart
        // convergence rides `cycle()` now — every-cycle-until-converged, and no classifier on this path.
        const tWatch = Date.now();
        // ── THE DOORBELL NOW SAYS WHO RANG IT ──────────────────────────────────────────────────
        //
        // `kickCycle()` alone schedules a ROTATION, so a mailbox whose IDLE fired joined the back
        // of a queue containing every other mailbox on the shard — a sub-second wake channel in
        // front of a 15.5-minute queue, measured. `noteWake` marks THIS runtime, which is what
        // lets `cycle()` order the rotation by who is actually waiting; the kick is unchanged and
        // still the thing that makes a cycle happen at all.
        unwatch = await adapter.watch(() => { noteWake(mb.mailboxId); kickCycle(); });
        rt.unwatch = unwatch;
        // The quarantine entry is NOT cleared here. It moved with the drain.
        // `quarantine.delete(mb.mailboxId)` was the last line of this function, and its reason was
        // exact: the entry carries the exponential backoff's attempt count, and clearing it BEFORE the
        // drain would reset a struggling provider's backoff to the base delay on every retry — the
        // mailbox hammered at the minimum interval for ever. The drain moved, so "the end of a
        // successful attach" IS now "before the drain", and leaving the delete here reintroduces
        // exactly that bug: a login the provider accepts whose every sync cycle throws would attach,
        // clear the count, fail into a fresh attempts=1 quarantine, and re-attach for ever at
        // `retryBaseMs` — a silent DoS (`stats()` excludes anything in `runtimes`). It is spent on the
        // first SUCCESSFUL cycle instead, beside the recovery write (`mailbox-failure.e2e.test.ts`).

        // ── THE PHASE BREAKDOWN, SO THE NEXT BOOT ANSWERS "WHICH PHASE" ITSELF ────────────
        //
        // The measurement could not say which phase dominated the six minutes, because the only two timestamps
        // in the log were the two ends of the whole function. These five are now the whole of what
        // attach does, and `attachMs` brackets exactly them: the clock starts immediately after
        // `mailbox_attach_started`, so the credential read and `makeAdapter` sit deliberately
        // OUTSIDE it — they are already bounded by the gap between `attach_started` and the
        // previous line in the log, and including them would make the five phases stop summing.
        log.info("mailbox_attached", {
          mailboxId: mb.mailboxId, accountId: mb.accountId,
          connectMs, leaseMs, foldersMs, kickstartMs, watchMs: Date.now() - tWatch,
          attachMs: Date.now() - tAttach,
        });
        // Beat per attach, so a roster of several real mailboxes reports progress while it is
        // still working through them rather than only once the last one is up.
        await beat();
        // The recovery write is NOT here. It is on the cycle path. It used to be, and the definition it
        // enforced was "connect + folders + two full sync cycles + IDLE": the heartbeat may count a
        // mailbox mid-drain, but the STATUS COLUMN may only say `connected` about one that has actually
        // synced (or Settings shows "connected" flashes on a mailbox that has never synced). That
        // invariant is unchanged, but "two inline cycles" was a PROXY for "actually synced", available
        // here only because the drain was here. With the drain on the cycle loop the real thing is
        // available: `rt.needsRecovery` is spent in `cycle()` after the first successful `runSyncCycle`,
        // and a mailbox whose cycles all throw accumulates toward quarantine without ever being called
        // connected. Writing it here now would mean "the login worked" — strictly weaker.
      } catch (err) {
        if (unwatch) { try { await unwatch(); } catch { /* ignore */ } }
        if (adapter) { try { await adapter.close(); } catch { /* ignore */ } }  // never leak a half-open login
        runtimes.delete(mb.mailboxId);
        // A shared-service fault is not this mailbox's fault. The credential read moved inside this
        // `try`, and that read is a DATABASE read. Left unexempted, one database blip would quarantine
        // every mailbox of the shard in turn and write `status='error'` on each — "the database was
        // unreachable for ninety seconds" rendered as "your mailbox is broken", a measured incident's
        // exact shape. So it is rethrown: the roster pass fails, no mailbox row is touched, no backoff
        // is earned, and the next pass retries the whole roster. Exempted BY CLASS, like
        // `LeaseUnavailableError` — a threshold cannot be tuned into a wrong answer — while everything
        // genuinely attributable to THIS mailbox (an undecryptable envelope, a refused configuration, a
        // rejected login) still quarantines, and iteration continues to the next mailbox.
        if (isDatabaseFault(err)) {
          log.error("mailbox_attach_database_fault", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "a shared database or transport failure, NOT this mailbox — the roster pass " +
              "fails without marking any mailbox at fault, and the next pass retries",
          });
          throw err;
        }
        // A lease we could not read is not a broken mailbox, and must not be quarantined into an
        // exponential backoff. Exempted BY CLASS, the pattern `ClassifierFaultError` establishes below:
        // exempting by class rather than threshold arithmetic keeps "an infrastructure fault can never
        // quarantine a mailbox" true at every tuning of `maxSyncFailures`. The mailbox is simply not
        // attached this pass; the next pass (thirty seconds) tries again, and the ONLY thing that did
        // not happen is organizing a mailbox we could not prove was ours. Since mail 0029 it RECORDS,
        // and `reconcileSyncBlocks` decides whether the state lasted long enough for the row — until
        // that split existed this arm's `log.warn` was the only trace of a mailbox nothing was syncing,
        // and it once stayed the only trace for half an hour.
        if (err instanceof LeaseUnavailableError) {
          noteBlock(leaseBlocked, mb.mailboxId, leaseBlockReason(err));
          log.warn("attach_lease_unavailable", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            // The OPERATION, from the error rather than from this call site: `runLeaseGate` names
            // which of `ensure_meta` / `list_claims` / `renew_claim` / `remove_claims` threw, and
            // it is a compile-time literal so it carries no privacy cost. Without it "the lease
            // could not be read" is one sentence for four different faults.
            op: err.op,
            reason: "the organizer lease could not be read — NOT counted toward maxSyncFailures; " +
              "the mailbox is left unattached and the next roster pass retries it",
          });
          return;
        }
        await quarantineMailbox(mb.mailboxId, mb.accountId, err, "attach");
      }
    }

    /**
     * Re-read the shard's duty and converge the runtime map onto it: attach newly eligible
     * mailboxes, detach ones that were disabled/deleted/evicted by the cap, recompute the
     * per-account duty and the capacity counters.
     */
    async function reconcileRoster(): Promise<void> {
      if (stopped) return;

      // Say something before the first attach, and leave durable evidence. A boot-time outage was once
      // invisible for two hours, and this is the half not about locks. A leader whose first roster
      // pass blocks inside `attach` — a hung provider dial, a first `ensureFolders`, a database wait —
      // had written NO heartbeat row and emitted NO log since taking the lock, and from outside
      // "wedged mid-boot", "never started" and "no mailboxes to serve" are the same absence, which
      // nothing can page on. So the beat happens before anything that can BLOCK, and it is a beat not
      // just a log: a log is visible only to whoever is tailing, while the heartbeat row is what an
      // EXTERNAL watchdog reads. `beat()` is best-effort, so a failed write cannot stop the boot.
      if (!booted) {
        booted = true;
        log.info("leader_boot_started", {
          maxMailboxes, rosterIntervalMs,
          pollIntervalMs: config.pollIntervalMs,
          reason: "the roster pass is about to attach mailboxes; anything after this can block",
        });
      }

      const selected = await loadEnabledMailboxes(db, selection);
      const served = selected.slice(0, maxMailboxes);
      const dropped = selected.slice(maxMailboxes);
      truncated = dropped.length;
      expected = served.length;
      servedIds = served.map((m) => m.mailboxId);

      // …and the first beat says what the duty is, not `0/0`. The boot beat used to fire above this
      // block, before the roster was read, so the first row a watchdog saw was
      // `mailboxes: 0, expected: 0, degraded: false` — which reads as "healthy and nothing to do". For
      // a leader about to spend three minutes attaching two real mailboxes that is the most misleading
      // sentence the row can contain, and it is what an operator saw during the incident. Moved to
      // HERE, after `expected` is known, it says `0/2, degraded` instead: booting, not yet serving. The
      // blocking risk that trade reintroduces is exactly one DB read — against the same database the
      // beat writes to, so a read that hangs would have hung the beat too.
      if (firstBeatPending) {
        firstBeatPending = false;
        await beat();
      }

      // ── THE CAP, ON THE ROW AND NOT ONLY IN THE LOG (mail migration 0029) ───────────────
      //
      // The quietest of the three arms. A capped mailbox is not counted in `expected`, so
      // `degraded` stays FALSE and `/health` reports a perfectly healthy worker; the log line
      // fires once per change of the dropped SET, so a stable overflow says nothing after the
      // first pass. Nothing anywhere told the mailbox's owner, or an operator looking at that one
      // mailbox, that this deployment had decided not to serve it.
      const droppedIds = new Set(dropped.map((m) => m.mailboxId));
      for (const id of [...capDropped.keys()]) if (!droppedIds.has(id)) capDropped.delete(id);
      for (const m of dropped) noteBlock(capDropped, m.mailboxId, "at_capacity");

      if (dropped.length > 0) {
        const signature = dropped.map((m) => m.mailboxId).sort().join(",");
        if (signature !== announced.cap) {
          announced.cap = signature;
          const accounts = new Set(dropped.map((m) => m.accountId));
          log.error("mailbox_cap_exceeded", {
            serving: served.length, selected: selected.length, maxMailboxes,
            dropped: dropped.length, accountsAffected: accounts.size,
            sample: sample(dropped),
            reason: "these mailboxes will NOT be synced by this process — raise TF_MAX_MAILBOXES or add shards",
          });
        }
      } else {
        announced.cap = "";
      }

      const desired = new Map(served.map((m) => [m.mailboxId, m]));

      // Detach anything no longer in the duty: soft-disabled, deleted,
      // or pushed out of the cap. Leaving it attached keeps an IDLE connection open — and keeps
      // syncing a mailbox whose credentials may already have been deleted.
      for (const rt of [...runtimes.values()]) {
        if (stopped) return;
        if (!desired.has(rt.mailboxId)) {
          // Not while a lane is inside it. This is the ONE detach reachable from inside a running
          // cycle — a roster pass served by `yieldToRoster` — and with lanes it can now land on a
          // mailbox whose `changesSince` is suspended. Closing that adapter would abort a batch
          // mid-flight and, through `releaseOrganizerClaim` below, hand the mailbox away while this
          // process is still organizing it. DEFERRED, never skipped: the cycle drains `deferredLeaves`
          // once its lanes have joined, so the mailbox leaves in the same cycle it stopped being ours.
          // The duty-gap check is unaffected — a mailbox still in `runtimes` is `served` by it, which
          // is what it is until the drain runs.
          if (laneBusy.has(rt.mailboxId)) {
            deferredLeaves.push({
              rt, release: true, reason: "no longer an enabled mailbox of this shard",
            });
            continue;
          }
          // The entitlement lapse releases the claim, not just the roster row. BEFORE the detach,
          // because the detach closes the connection that can do it. This is the ONLY teardown path
          // that releases, and the discrimination is the point: `detach` is also reached by a
          // connection error, a quarantine, a lost lock and a clean stop, and in every one Cloud fully
          // intends to keep organizing — a release there would hand the mailbox to a desktop install on
          // every deploy. Leaving the duty is the opposite: the account lapsed, the user disconnected,
          // or the cap evicted it, and a live claim Cloud no longer renews is what makes the user's own
          // machine stand ITSELF down for the staleness window — ten minutes of a "leave anytime"
          // product whose button appears to do nothing at the moment somebody chose to leave.
          await releaseOrganizerClaim(rt, "this mailbox is no longer an enabled mailbox of this shard");
          await detach(rt, "no longer an enabled mailbox of this shard");
        }
      }
      for (const id of [...awaitingCreds.keys()]) if (!desired.has(id)) awaitingCreds.delete(id);
      for (const id of [...quarantine.keys()]) if (!desired.has(id)) quarantine.delete(id);
      for (const id of [...leaseBlocked.keys()]) if (!desired.has(id)) leaseBlocked.delete(id);

      // Attach what is missing, then kick a cycle if anything new came up. `attach()` syncs nothing,
      // so a mailbox that joins the rotation here has no mail processed until a cycle runs — and
      // `setInterval` fires for the FIRST time only after a full period (60 s in production), the same
      // dead window the takeover kick was measured against, reopened per mailbox at every roster pass.
      // Nothing fails and NOTHING LOGS if this kick is forgotten, which is why it is guarded
      // (`attach-nonblocking.e2e.test.ts`, claim 7). In a `finally`, so an `attach` that rethrows a
      // shared-database fault mid-loop still kicks for the mailboxes it did bring up; `kickCycle` is
      // idempotent (`cycleQueued`), checks `stopped` itself, and queues behind this pass.
      const now = Date.now();
      let newlyAttached = 0;
      try {
        for (const mb of served) {
          if (stopped) return;
          const attached = runtimes.get(mb.mailboxId);
          if (attached) {
            // Refresh the lease-relevant columns from the row we just read, so a takeover
            // authorized by the connect flow while this mailbox was already serving reaches the
            // next cycle's gate instead of waiting for a restart.
            attached.lease = {
              // Mail 0104 — the verb moves with the stamp on every refresh, for the same reason.
              takeoverAuthorizedAt: mb.takeoverAuthorizedAt, takeoverIntent: mb.takeoverIntent,
              disabledReason: mb.disabledReason,
              // Mail 0083, refreshed with the other two: a promotion or demotion written by
              // another process (the connect flow, the reconcile backstop) is a fact about this
              // row, and a value captured at attach would leave this gate deciding against it.
              organizerRole: mb.organizerRole,
              // Mail 0083. Refreshed for `takeover_authorized_at`'s exact reason: `organizeHere`
              // stamps CONSENT from another process while this one is already reading the mailbox,
              // and a value captured at attach would leave a person's "organize here" doing
              // nothing until the worker happened to restart. The two columns are written in one
              // transaction, so refreshing them together is also what keeps them consistent here.
              organizeConsentedAt: mb.organizeConsentedAt,
              // Mail 0088. Refreshed with the pair above and for the identical reason: "stop
              // organizing this mailbox" is written by ANOTHER process while this one is already
              // organizing it, and a value captured at attach would leave the person's press
              // doing nothing until the worker happened to restart.
              releaseRequestedAt: mb.releaseRequestedAt,
            };
            // Converge the row onto reality — but only about a mailbox that has actually SYNCED. This
            // mailbox is attached; if its row still says `error` the recovery write failed or was
            // fenced, and until this line NOTHING retried it (the old comment claimed "the next roster
            // pass writes it" and this loop's `continue` was the proof it did not — the mailbox synced
            // perfectly while Settings and the admin console called it broken). `mb.status` is re-read
            // every pass, so this is a no-op the moment the write lands. `lastSuccessAt !== null` is the
            // non-blocking-attach half: "attached" no longer implies "drained twice", so without this
            // clause a mailbox whose login works and whose every cycle throws would be converged to
            // `connected` 30 s later — resurrecting the "connected flashes on a never-synced mailbox".
            if (mb.status !== "connected" && attached.lastSuccessAt !== null) await markRecovered(mb);
            continue;
          }
          // The backoff gate, and since mail 0039 the row can overrule the map. Three cases, and the
          // ORDER of the first two is the whole of the release path: (1) an entry whose durable write
          // LANDED (`persisted`) is governed by `mb.retryAfter`, re-read from the database this pass,
          // so `retry_after IS NULL` means "somebody cleared it" (the admin release) and the mailbox
          // is attached NOW — the map entry is NOT deleted, since `attempts` is the ladder's input and
          // resetting it hands a struggling provider a fresh minimum-interval loop (a release buys one
          // attempt, not a clean slate); (2) an entry whose write did NOT land falls back to
          // `q.retryAt`, the pre-0039 behaviour; (3) no map entry but a future `retry_after` on the row
          // is a mailbox this NEW process never quarantined, SEEDED below rather than attached.
          const q = quarantine.get(mb.mailboxId);
          if (q) {
            const until = q.persisted ? (mb.retryAfter?.getTime() ?? null) : q.retryAt;
            if (until !== null && now < until) continue;
          } else if (mb.retryAfter && now < mb.retryAfter.getTime()) {
            // The restart seed. Without this a fresh leader forgets every backoff and re-dials every
            // parked mailbox at once — the gap this column was added to close, and a way to turn a
            // deploy during a provider outage into a burst of retries. Two details are load-bearing:
            // `attempts` is floored at the row's `retry_count`, so the ladder resumes where the outage
            // is instead of the base delay (the two counters may disagree, and this is the one place
            // the durable one is the better estimate); and `persisted: true`, because this entry was
            // READ from the column, so it is governed by the column and an operator's release reaches
            // it next pass. Seeding also keeps the roster invariant honest — a mailbox skipped on the
            // row alone would log `roster_invariant_violated` every 30 s about correct behaviour.
            quarantine.set(mb.mailboxId, {
              attempts: Math.max(1, mb.retryCount),
              retryAt: mb.retryAfter.getTime(),
              reason: "recovered from mailboxes.retry_after on takeover",
              persisted: true,
            });
            log.info("mailbox_quarantine_restored", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              retryInMs: mb.retryAfter.getTime() - now, attempts: Math.max(1, mb.retryCount),
              reason: "a durable backoff outlived the process that set it",
            });
            continue;
          }
          await attach(mb);
          // `attach` returns normally for a mailbox it declined (no credentials, lease held
          // elsewhere), so the rotation is asked rather than the call's return value.
          if (runtimes.has(mb.mailboxId)) newlyAttached++;
        }
      } finally {
        if (newlyAttached > 0) kickCycle();
      }

      dutyAccounts = accountsOf(served);

      // The roster invariant, checking what is actually SERVED rather than what was selected.
      // Every mailbox of the shard's duty must be in exactly one accounted-for bucket:
      // attached, awaiting credentials, or quarantined with a retry scheduled. Anything else
      // is a paying customer whose mail silently never syncs, i.e. a bug in this file.
      const unexplained = served.filter(
        (m) => !runtimes.has(m.mailboxId) && !awaitingCreds.has(m.mailboxId)
          && !quarantine.has(m.mailboxId) && !leaseBlocked.has(m.mailboxId),
      );
      dutyGap = unexplained.length > 0;
      if (dutyGap) {
        const accounts = new Set(unexplained.map((m) => m.accountId));
        log.error("roster_invariant_violated", {
          unexplained: unexplained.length, accountsAffected: accounts.size,
          sample: sample(unexplained),
          reason: "enabled mailboxes of this shard are neither served, awaiting credentials, " +
            "quarantined, nor held by another organizer — their mail will NEVER sync",
        });
      }

      // LAST in the pass, and the only place `sync_blocked_reason` is written. See below.
      await reconcileSyncBlocks(selected);
    }

    /**
     * The single writer of `sync_blocked_reason` (mail 0029). One place reads the three buckets,
     * compares elapsed time against ONE threshold, and writes or clears. The catch arms above only
     * RECORD, and that split is the design: an arm that decided for itself would need its own grace,
     * its own fenced write and its own idea of when to clear — three copies in the three places least
     * likely to be exercised. LAST in the roster pass, so a mailbox that recovered this pass is cleared
     * the same pass (`selected`, not `served`, because the capacity arm's mailboxes are what `served`
     * excludes). The write REPEATS (idempotent — `markMailboxSyncBlocked` COALESCEs
     * `sync_blocked_since`) and CONVERGES a row another writer cleared; the clear is gated on the row ACTUALLY carrying a reason, or a healthy shard issues one pointless UPDATE per mailbox per interval. Best-effort — a worker ahead of mail 0029 fails these on a missing column, harmlessly.
     */
    async function reconcileSyncBlocks(selected: readonly EnabledMailbox[]): Promise<void> {
      const nowMs = Date.now();
      for (const mb of selected) {
        if (stopped) return;
        const block = leaseBlocked.get(mb.mailboxId)
          ?? awaitingCreds.get(mb.mailboxId)
          ?? capDropped.get(mb.mailboxId)
          ?? readLimited.get(mb.mailboxId);
        try {
          // `>=`, so a grace of 0 writes on the first observation — which is what the roster guards
          // configure. The narrowing is written inline rather than hoisted into a `due` boolean
          // because a boolean would not carry `reason !== null` into the branch, and the cast that
          // replaced it is the kind of assertion a reviewer has to take on trust.
          if (block && block.reason !== null && nowMs - block.since >= syncBlockGraceMs) {
            const reason = block.reason;
            const written = await markMailboxSyncBlocked(db, mb.mailboxId, reason, { fence });
            if (!written) {
              log.info("mailbox_sync_block_write_fenced", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, syncBlockedReason: reason,
                reason: "the mailbox is disabled or this instance no longer leads the shard",
              });
              continue;
            }
            // Once per transition into the blocked state, not once per pass: the write above is
            // idempotent and repeats, and a line every 30 s per unserved mailbox is how the log
            // that is supposed to explain an incident becomes the reason nobody reads it.
            if (mb.syncBlockedReason !== reason) {
              log.warn("mailbox_sync_blocked", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, syncBlockedReason: reason,
                reason: "this process is NOT syncing this mailbox and the row now says so — " +
                  "status is unchanged, no error is recorded, and no retry backoff is earned",
              });
            }
          } else if (!block?.reason && mb.syncBlockedReason !== null) {
            if (await clearMailboxSyncBlock(db, mb.mailboxId, { fence })) {
              log.info("mailbox_sync_block_cleared", {
                mailboxId: mb.mailboxId, accountId: mb.accountId,
                reason: "this mailbox is being served again, or is no longer ours to serve",
              });
            }
          }
        } catch (err) {
          log.error("mailbox_sync_block_write_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "this process is not serving the mailbox regardless; the row could not record " +
              "why, so it reads as an ordinary connected mailbox",
          });
        }
      }
    }

    /**
     * A roster pass is owed from NOW. Called by the roster timer, and by nothing else.
     *
     * Sets the flag AND queues an entry. The flag lets a cycle already in flight serve the pass
     * at its next safe point; the entry is what runs it when no cycle is in flight at all.
     * Deduped like `kickCycle`, so fourteen ticks during one long cycle no longer append
     * fourteen identical passes to the queue — they append one, and `rosterPendingSince` keeps
     * the age of the OLDEST of them, which is the number worth reporting.
     */
    function requestRoster(): void {
      if (stopped) return;
      if (!rosterPending) {
        rosterPending = true;
        rosterPendingSince = Date.now();
      }
      // And make it audible to a cycle that is already blocked on its lanes. `yieldToRoster` is at the
      // top of the dispatcher loop, and that loop only turns when a lane finishes — so a pass owed
      // while every lane is inside a long batch waited out a bounded batch (~254 s measured) before it
      // was even LOOKED at (the adoption fix's residual, unchanged by lanes alone). The nudge spends
      // it: the pass is served at the next turn of the loop, with the lanes still running. Safe for the
      // reason `laneBusy` exists — the pass's detach loop skips any mailbox a lane is inside, and
      // everything else it does (attaching a lane-less mailbox, recomputing the duty, converging rows)
      // never touches a live batch.
      nudgeCycle();
      if (rosterQueued) return;
      rosterQueued = true;
      void serialize(async () => {
        rosterQueued = false;
        await servePendingRoster();
      }).catch((err: unknown) => {
        // A roster pass is a DB read: a failure is a DB blip, not a reason to stop serving
        // the mailboxes already attached. Log and try again next interval.
        log.error("roster_pass_failed", { err, reason: "keeping the current rotation" });
      });
    }

    /**
     * Run the owed pass, if it is still owed. The flag is cleared BEFORE the await, not after: a timer
     * tick landing while the pass is running is a request for the NEXT pass — it has not been served by
     * a read that already happened — and clearing afterwards would swallow it. Reached from two places,
     * never concurrently: the queued entry above, and `yieldToRoster` from inside a running cycle. Both
     * are on the one queue, so "the queued entry starts while a cycle holds the queue" is not a state
     * this program has.
     */
    async function servePendingRoster(): Promise<void> {
      if (stopped || !rosterPending) return;
      rosterPending = false;
      const waitedMs = Date.now() - rosterPendingSince;
      // The half of the starvation finding that was "and nothing surfaces it". A pass that is owed and
      // cannot run emitted NOTHING while it was happening: no log, no counter, no column.
      // `mailboxes`/`expected` in the heartbeat cannot show it — they are written BY the pass that is
      // not running — so from outside a starved shard and a healthy one are the same row. This line is
      // the difference, a `warn` because a pass later than its own interval means one queue entry ran
      // longer than the interval, worth knowing even when it is a legitimately slow backfill.
      // `latencyMs` and not `waitedMs`: the logger's ALLOWED_FIELDS is the primary redaction control
      // and a key not on it has its VALUE dropped silently (the first version emitted `waitedMs` and
      // its own test read `NaN`).
      if (waitedMs >= rosterIntervalMs) {
        log.warn("roster_pass_delayed", {
          latencyMs: waitedMs, rosterIntervalMs, mailboxes: runtimes.size,
          reason: "a cycle held the one serial queue past a roster interval — mailboxes " +
            "connected in this window were not adopted until now",
        });
      }
      await reconcileRoster();
    }

    /**
     * Hand the queue to an owed roster pass, from inside the cycle that is holding it. Called from
     * EXACTLY ONE place: the top of the rotation's dispatcher loop, the only point where no mailbox is
     * being TAKEN and the runtime map is not being walked. The comment used to say "…between two
     * mailboxes, where NO ADAPTER OPERATION IS SUSPENDED", which bought one thing — a pass may never
     * close an adapter somebody is using — and lanes make that no longer literally true, so it is
     * enforced by name: `laneBusy` holds the ids a lane is inside, and `reconcileRoster` defers their
     * detach to `deferredLeaves`. The bound IS the roster interval now (`requestRoster` nudges a cycle
     * blocked on its lanes); two organizers come from two things organizing ONE mailbox, and a mailbox being attached has no lane. `reconcileRoster` runs through `servePendingRoster` DIRECTLY, never `serialize` — this is already inside the queue's running entry.
     */
    async function yieldToRoster(): Promise<void> {
      if (stopped || !rosterPending) return;
      // A roster pass that throws must not take the rotation with it. `requestRoster`'s queued entry
      // always caught this (a roster pass is a DB read, a failure a blip, not a reason to stop serving
      // attached mailboxes), and the in-cycle path had no catch — the same failure tolerated on one
      // path and fatal on the other. It is not cosmetic: `loadEnabledMailboxes` reads through the bare
      // handle, so a dead database throws an UNTAGGED `ECONNREFUSED` here, which `isSharedDatabaseFault`
      // correctly declines to call ours (byte-identical to a dead IMAP host). Uncaught, it left
      // `cycle()` before a lane ran, so no tagged fault was raised, `noteDatabaseFault` never fired,
      // and `/health` answered `degraded: false` through a total outage. Caught here, the pass is
      // skipped, the lanes meet the database through the tagged repo, and the outage is announced
      // (`shared-db-fault.pg.test.ts`).
      try {
        await servePendingRoster();
      } catch (err) {
        log.error("roster_pass_failed", {
          err,
          reason: "the pass a running cycle was serving could not read the roster; keeping the " +
            "current rotation so the mailboxes already attached are still served this pass",
        });
      }
    }

    /** One sync pass over the rotation, then the per-account DB passes. Never throws. */
    async function cycle(): Promise<void> {
      if (stopped) return;
      /**
       * When this pass began — the batch stamp below the loop backdates to it, because a
       * `last_sync_at` written at pass END claims scans the pass performed MINUTES earlier and
       * would settle a pull that landed in between (see `stampMailboxSyncNow`'s header). A
       * host-measured elapsed, not a wall-clock: durations carry no skew.
       */
      const passStartedMs = Date.now();
      // A mailbox that has never synced goes to the front, not the back. This used to be
      // `[...runtimes.values()]` in Map insertion (roster, oldest-first) order, so the newest mailbox
      // is served LAST and its first sync waits out every other's bounded batch. Mid-cycle adoption
      // fixed the ADOPTION term; this is the residual, the larger one — attach is under a second, the
      // first CYCLE is the whole rotation. Measured: a new mailbox attached in 601 ms and its first
      // cycle came 12.8 minutes later, by which time its provider closed the idle connection, so it
      // detached and re-attached at the BACK for ever — a livelock, not slowness. So the pass starts
      // with never-completed runtimes oldest-first, a never-synced runtime adopted MID-PASS is admitted
      // to the FRONT (`servedIds` bounds one turn per id), and between them sit mailboxes with an
      // unserved wake, oldest wake first (the sub-second channel that produced a 15.5-minute gap).
      const woken = (rt: MailboxRuntime): boolean => rt.lastSuccessAt !== null && rt.wokenAt !== null;
      /** Runtimes still owed a bounded batch this pass, first-syncers first, then the woken. */
      const pending: MailboxRuntime[] = [...runtimes.values()]
        .filter((rt) => rt.lastSuccessAt === null)
        .concat(
          [...runtimes.values()].filter(woken).sort((a, b) => (a.wokenAt ?? 0) - (b.wokenAt ?? 0)),
        )
        .concat([...runtimes.values()].filter((rt) => rt.lastSuccessAt !== null && !woken(rt)));
      /** Mailbox ids that have had their turn this pass — at most one each. */
      const servedIds = new Set<string>();
      /**
       * Admit first-syncers that joined the rotation since this pass planned it, at the front.
       *
       * Called only right after `yieldToRoster()`, i.e. at a point where nothing is suspended
       * inside an adapter — the same property that makes the pass's own detaches safe there.
       */
      function admitNewFirstSyncers(): void {
        for (const rt of runtimes.values()) {
          if (rt.lastSuccessAt !== null) continue;
          if (servedIds.has(rt.mailboxId)) continue;
          if (pending.includes(rt)) continue;
          pending.unshift(rt);
        }
      }
      /**
       * Mailbox ids allowed PAST `servedIds` once, because they have been woken since their
       * turn — see `admitWoken`. Consumed on admission, so a second re-admission needs a second
       * real signal.
       */
      const revisitAllowed = new Set<string>();
      /** How many extra turns each mailbox has already been given this pass. */
      const revisits = new Map<string, number>();
      /**
       * Re-admit a mailbox whose doorbell rang AFTER its turn in this pass. Without this, lanes
       * shorten the rotation and leave the CYCLE as the unit a wake waits for (~254 s for a signal that
       * answered in under a second); with it, and a lane held back for mailboxes that owe nothing, the
       * wait is the time to find a free lane. FOUR conditions, each load-bearing: an unserved wake
       * (`wokenAt`, the only thing that earns a second turn, spent on admission); already served this
       * pass (a not-yet-served mailbox is in `pending` and keeps first-syncer ordering); not currently
       * in a lane (a mid-visit mailbox observes its own wake next pass, and re-admitting it here would
       * break per-mailbox serialization); and under {@link CYCLE_WAKE_REVISITS}, past which the mailbox KEEPS its wake and leads the next pass — the pre-lane behaviour, so the worst case is what shipped.
       */
      function admitWoken(): void {
        for (const rt of runtimes.values()) {
          if (rt.wokenAt === null) continue;
          if (!servedIds.has(rt.mailboxId)) continue;
          if (laneBusy.has(rt.mailboxId)) continue;
          if (pending.includes(rt)) continue;
          const spent = revisits.get(rt.mailboxId) ?? 0;
          if (spent >= CYCLE_WAKE_REVISITS) continue;
          revisits.set(rt.mailboxId, spent + 1);
          revisitAllowed.add(rt.mailboxId);
          pending.unshift(rt);
        }
      }
      /**
       * Re-apply the PLANNING order to what is left of `pending`, so a wake that lands MID-PASS for a
       * mailbox that has NOT had its turn moves it forward instead of leaving it at its snapshot
       * position. `admitWoken` handles the already-served half; this is the other, measured one: the
       * pass plans its order once at the top, so a doorbell ringing two seconds into a seven-minute
       * pass for the last mailbox in the snapshot bought nothing (probe 2 of 2026-08-26 waited 478 s
       * with `wokenAt` set). A STABLE re-partition into the planner's three groups (first-syncers
       * untouched, then woken by oldest wake, then the rest) — it moves mailboxes only BETWEEN turns
       * (never one a lane holds), consumes nothing, and admission re-applies every rule at fill time. Runs every turn; the array is at most the shard's mailbox count, so the sort is noise.
       */
      function reorderPending(): void {
        const rank = (rt: MailboxRuntime): number =>
          rt.lastSuccessAt === null ? 0 : rt.wokenAt !== null ? 1 : 2;
        // `Array.prototype.sort` is stable per spec, so equal-rank entries keep their order.
        pending.sort((a, b) => {
          const ra = rank(a);
          const rb = rank(b);
          if (ra !== rb) return ra - rb;
          if (ra === 1) return (a.wokenAt ?? 0) - (b.wokenAt ?? 0);
          return 0;
        });
      }
      let succeeded = 0;
      /** The ids to stamp `last_sync_at` on — see `stampMailboxSync` for why it must exist. */
      const synced: string[] = [];
      const toQuarantine: Array<{ rt: MailboxRuntime; err: unknown }> = [];
      /** Mailboxes whose adapter still owes a backlog — re-kick rather than wait a poll. */
      const backlogged: string[] = [];

      /** Mailboxes this cycle stood down from; detached after the loop, never inside it. */
      /**
       * Runtimes whose LEASE could not be read for long enough to give up on — and NOT, since mail
       * 0083, runtimes that stood down. A stand-down no longer detaches: it demotes the runtime to a
       * reader in place, keeping the login, the poll timer and a mirror that grows. What still reaches
       * this list is the unreadable-lease path, a CONNECTION fault: we cannot tell whether we hold the
       * mailbox, and the honest answer is to stop touching it, not to assume either role. The list
       * keeps its name because the detach and log line it drives are unchanged, and renaming it would
       * obscure that the population shrank rather than that the handling changed.
       */
      const toStandDown: MailboxRuntime[] = [];
      /**
       * Mailboxes whose organizer lease has been unreadable past `leaseUnavailableDetachMs`
       * — detached after the loop so the next roster pass RE-DIALS them.
       *
       * Named for what it achieves rather than for what it does: detach IS reconnect here, because
       * `attach()` is a fresh connect + a fresh lease gate + fresh folders + fresh IDLE. There is
       * deliberately no reconnect-in-place inside this loop; it would duplicate every one of those
       * phases and would need its own error handling for each.
       */
      const toReconnect: Array<{ rt: MailboxRuntime; unavailableMs: number }> = [];

      // The rotation runs several mailboxes at once, and which ones is the design. Everything above is
      // still true (one queue entry, one turn per mailbox per pass, first-syncers-first, the mid-pass
      // roster service); the walk pulls up to `cycleLanes` at a time under three admission rules, each
      // a load-bearing invariant with a mutation in `roster-serialization.pg.test.ts`. 1. ONE CYCLE PER
      // MAILBOX (structural: `servedIds` bounds a turn per pass, the queue one `cycle()` at a time).
      // 2. ONE CYCLE PER ACCOUNT (the concurrency key): `recordChange` → `allocateSeq` takes the
      // account's `account_sync_state` ROW LOCK to commit, so two mailboxes of one account would stall
      // 30 s or `55P03` on `lock_timeout` — keyed on the account, the contention is gone by
      // construction. 3. A LANE reserved for mailboxes that OWE NOTHING (`heavyLanes`), or three cold
      // backfills fill every lane. The fence is unaffected (per-mailbox `FOR UPDATE`); the pool is the ceiling.
      /** Lanes in flight: mailboxId → the promise that settles when its visit is over. */
      const inFlight = new Map<string, Promise<void>>();
      /** Accounts with a lane in flight — rule 2. */
      const busyAccounts = new Set<string>();
      /** Lanes in flight holding a mailbox that owes a backlog — rule 3. */
      let heavyInFlight = 0;
      /**
       * The pass must take no NEW mailbox: a shared database fault (which used to `break`) or a
       * fence refusal (which used to `return`).
       *
       * A flag and not a `break`, because with lanes in flight "stop the pass" and "leave the
       * loop" are no longer the same act — the lanes still have to be joined before the post-loop
       * bookkeeping can read the lists they are writing into.
       */
      let stopPass = false;

      /** Whether this runtime may start a lane right now. */
      function admissible(rt: MailboxRuntime): boolean {
        if (busyAccounts.has(rt.accountId)) return false;
        if (rt.owesBacklog && heavyInFlight >= heavyLanes) return false;
        return true;
      }

      /**
       * One mailbox's turn. NEVER throws and never rejects — every arm is handled inside. `woken` says
       * this visit was admitted on a wake (IDLE fired, or the sync-kick scan named it), captured at
       * admission because admission also SPENDS `rt.wokenAt`. It buys one thing: an EAGER `last_sync_at`
       * stamp on success, for a client-facing reason — the pull affordance's spinner settles on "every
       * mailbox's `lastSyncAt` moved past my request" (`PullNewMail.tsx`), and the batched stamp at
       * pass end can be MINUTES behind the visit that served the wake, an honest scan reported
       * dishonestly late. One UPDATE per woken visit, i.e. per doorbell ring or real arrival, never per rotation.
       */
      async function visitMailbox(rt: MailboxRuntime, woken = false): Promise<void> {
        try {
          // ── THE LEASE IS RE-VERIFIED EVERY CYCLE, BEFORE THE PIPELINE RUNS ──────────────
          //
          // A claim is evidence for exactly the cycle that read it. Gating only at attach would
          // mean a mailbox that changed hands — a user adding it to another install, a takeover
          // authorized in Cloud's UI — kept being organized by this process until the next
          // restart, which is the steady-state dual organizing the lease exists to make
          // impossible. `runSyncCycle` ingests THROUGH the pipeline, so there is no weaker
          // "sync but do not organize" position available here: syncing IS organizing.
          const organize = await mayOrganize(
            { mailboxId: rt.mailboxId, accountId: rt.accountId }, rt.lease, rt, rt.adapter, "cycle",
            rt.requestKey,
          );
          /* The role flip, in both directions, without a re-attach. `wasOrganizer` is what this process
           * was a moment ago; `organize` is what the lease just said. The two comparisons are the only
           * two transitions there are, and each used to require a detach: ORGANIZER → READER used to
           * push the runtime onto `toStandDown` (detach, close the connection) and now keeps the
           * connection, poll timer, credentials and syncing as a reader (the demotion write and
           * appointment close already happened inside `mayOrganize`); READER → ORGANIZER means a human
           * authorized a claim-back or gave consent, the gate spent the stamp, and
           * `clearOrganizerStandDown` flipped the row — what the ROW cannot do is create the folder
           * tree, so `ensureFolders` runs here, the one line of the attach a promotion catches up on. */
          const wasOrganizer = rt.role === "organizer";
          rt.role = organize ? "organizer" : "reader";
          if (organize && !wasOrganizer) {
            // BEFORE the cycle, so this very pass files into a tree that exists. It is idempotent
            // (the adapter creates only what is missing) and it is the first write this process is
            // entitled to make against this mailbox, which is why it is here and not one line
            // earlier: `mayOrganize` returning true is the entitlement.
            await rt.adapter.ensureFolders();
            // The known-set memo is dropped for the reason a stand-down drops it, in the mirror
            // direction: everything this runtime remembers about the mailbox it remembered as a
            // READER, and the cycle that follows is going to move mail on the strength of it.
            rt.deps.knownSet?.drop("organizer promotion");
            /* And the import hold is armed here, because no attach is coming. `armHoldFromFolder`
             * detects a foreign profile document and holds it, so an organizer TAKING a mailbox over
             * adopts the placement it inherits instead of re-screening a history somebody else sorted;
             * its only other call site is inside `attach()`, whose comment promised the hold is armed
             * by the attach that follows a promotion. No attach follows a promotion any more — mail
             * 0083 made READER → ORGANIZER happen IN PLACE — so the promise named a re-attach that was
             * deleted, and the sequence it left open is TAKEOVER-RESCREEN: a claim-back promotes, and
             * `runSyncCycle` runs this pass with `importDecisionOpen === false` and files the inherited
             * history into `ohmail/Screener`. BEFORE `runSyncCycle`, like `ensureFolders`: the first
             * cycle does the damage, so arming it afterwards arms it too late. */
            await rt.profile.armHoldFromFolder();
            log.info("organizer_promoted", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "a human asked this install to organize this mailbox and the lease agreed; "
                + "the folder tree is ensured and this cycle organizes — no relaunch",
            });
          }
          if (!organize && wasOrganizer) {
            // The profile module's memory of ORGANIZING this mailbox goes with the role. See
            // `forgetOrganizerLife` for what it holds and why keeping it across a handover makes
            // the NEXT promotion skip its own preflight and then supersede the document the other
            // organizer left. Purely in-process; the durable markers stand.
            rt.profile.forgetOrganizerLife();
            log.info("organizer_demoted_to_reader", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "another organizer holds this mailbox; this install keeps its login and its "
                + "mirror and becomes a reader — it marks mail read and sends, and moves nothing",
            });
          }
          // THE LEASE ANSWERED, SO IT IS READABLE — whichever way it answered. A
          // stand-down is evidence about this connection every bit as strong as an organize verdict:
          // it means `ohmail/_meta` was created and FETCHed successfully and somebody else's claim
          // was in it. Only a THROW means "we could not look", so only a throw may advance the
          // clock. Written on the line after the call rather than inside the `organize` branch for
          // exactly that reason — putting it there would leave a mailbox that alternates
          // stand-down / unreadable accumulating toward a detach it has not earned.
          rt.leaseUnavailableSince = null;
          /* A reader does not leave the roster, and the memo is not dropped. This block used to drop
           * the known-set memo and push the runtime onto `toStandDown` (detach). Both are wrong for a
           * reader, for opposite reasons. The DETACH is wrong because a reader's whole product is a
           * mirror that keeps growing — detaching would freeze it at the handover, the behaviour this
           * ruling replaced. DROPPING THE MEMO is wrong because the memo records what THIS mailbox
           * contains, not who organizes it: it was dropped at a stand-down because the runtime was about
           * to die, and it now survives and keeps reading the SAME mailbox, so the memo is still true
           * (dropping it costs a full `listKnownLocators` re-read on every demotion; it IS dropped on
           * the promotion above, which is about to move mail on it). `leaseBlocked` is still noted so
           * `/health` can say why this mailbox is not ORGANIZED here, not the same as "not synced". */
          if (!organize) {
            noteBlock(leaseBlocked, rt.mailboxId, null);
            await refreshReaderHolder(
              { mailboxId: rt.mailboxId, accountId: rt.accountId }, rt.adapter, rt.holderSeen,
            );
            /* And cache the organizer's settings document, once per reader cycle (mail 0094). A
             * reader's own responder/rule/window/signature rows are inert: the ones in force are in the
             * published document of the install that HOLDS this mailbox. The panes rendered the local
             * rows anyway (ruling 6's Critical), so the reader keeps a copy and
             * `GET /mailboxes/:id/profile` serves that. A SIBLING of `refreshReaderHolder`, not a line
             * inside it: that function RETURNS EARLY when none of the six holder columns moved (its
             * zero-writes steady state), and folded in, the mirror would refresh only when the HOLDER
             * changed — while the document changes far more often, so a settings pane would sit on a
             * stale copy. Probed, not asserted (`profileIo` is an accessor a double need not carry);
             * never throws (`syncProfileMirror` owns that). */
            const mkIo = (rt.adapter as Partial<{
              profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
            }>).profileIo;
            if (typeof mkIo === "function") {
              await syncProfileMirror({
                db, accountId: rt.accountId, mailboxId: rt.mailboxId,
                /* A NAMED READER IDENTITY. `readOrganizerProfile` remembers a position per
                   identity, so borrowing this install's own would let a read and the organizer
                   write-behind share one anchor. */
                io: mkIo.call(rt.adapter, {
                  installId: "reader-profile-mirror", mailboxId: rt.mailboxId,
                }),
                now: new Date(), log: (event, detail) => { log.info(event, detail); },
              });
            }
          } else {
            leaseBlocked.delete(rt.mailboxId);
          }
          // The classifier is resolved HERE, once per cycle, from the circuit — not stored on
          // `rt.deps`. That is what lets an outage degrade this mailbox to rules-only between
          // one cycle and the next without touching `sync.ts`, `pipeline.ts` or `SyncDeps`.
          /** When THIS visit's scan began — the eager stamp backdates to it (same rule as the pass). */
          const visitStartedMs = Date.now();

          /* THE MAIL CYCLE'S FAILURE IS HELD, NOT PROPAGATED — for exactly as long as it takes the
           * request channel below to run. See that block for why. */
          let cycleError: unknown = null;
          let syncOutcome: { hasBacklog: boolean; owesFiling: boolean } | null = null;
          try {
            syncOutcome = await runSyncCycle({
            ...rt.deps, ...aiFor(rt.mailboxId, rt.accountId), ...(await screeningFor(rt.accountId)),
            // Mail 0083. THE ROLE THE GATE JUST ANSWERED, spread over the attach-time deps so a
            // flip applies to THIS pass rather than to the one after the next re-attach. Placed
            // after the spread deliberately: it must win over `rt.deps.role`, which is only ever
            // the value the attach saw.
            role: rt.role,
            // The cap is refreshed per cycle like the screening posture beside it, so an
            // upgrade's headroom (or a downgrade's new ceiling) applies without a re-attach.
            storageCap: await storageCapFor(rt.accountId),
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED
            // from the current facts at every cycle edge — never cached: the defects
            // measured that any arm/release choreography over a folder, a store and a
            // resolutions table that all move independently has a mirror-image race for every
            // ordering. `importDecisionOpenNow` reads what stands NOW (the folder verdict on a
            // clock — a short takeover TTL before the seed, the flush cadence after — plus a
            // serialize and an indexed read only while a foreign document is actually present)
            // and never throws: a faulted read answers the previous cycle, or a provably armed
            // hold before the first success. The attach-time preflight above remains for the
            // durable marker the confirm surface needs and for the write-behind's own hold.
            /* And only an organizer asks it. The flag governs whether the consent gate adopts placement
             * instead of screening, a decision only an organizer makes — a reader files nothing, so the
             * answer cannot change what its cycle does. Asking anyway was not free once the role gate
             * stopped readers from seeding: `importDecisionOpenNow`'s TTL is the flush interval for a
             * SEEDED install and `min(EVAL_TAKEOVER_TTL_MS, flushInterval)` for an unseeded one, so an
             * attached reader — which never seeds — would fetch the whole profile source out of
             * `ohmail/_meta` every 30 s for the life of the attachment instead of settling into the
             * five-minute cadence. A reader that polls a mailbox it does not organize is the model; a
             * reader that FETCHES a document it may not act on is not. */
              importDecisionOpen: rt.role === "organizer" ? await rt.profile.importDecisionOpenNow() : false,
            });
          } catch (err) {
            cycleError = err;
          }

          /* ── A FENCE IS NOT A FAULT, AND IT MUST NOT REACH THE CHANNEL ──────────────────────
           *
           * `LeaderFencedError` does not mean this cycle went wrong; it means a mail-bearing write
           * was REFUSED because this instance no longer leads its shard. The successor is already
           * syncing this mailbox. Draining on it would be this process writing into a mailbox it
           * has just been told it no longer has standing to write to — appending an acknowledgement
           * and expunging records out from under whoever took over. So the channel runs for an
           * ORDINARY fault and never for this one, and the arms below still see exactly the error
           * they saw before. */
          /* And an unreadable lease is an unanswered question, not an ordinary fault.
           * `LeaseUnavailableError` does not say somebody else organizes this mailbox; it says this
           * cycle could not find out. The channel below APPENDS acknowledgements and EXPUNGES records,
           * and its standing to do either comes from the lease alone — a fence is a NO, this is a
           * question with no answer, and a write must not proceed on one (that is how a process keeps
           * writing into a mailbox another organizer already holds). It does not contradict the gate one
           * layer down, where a partial folder read is ACTED on: that is a read deciding what it knows,
           * this is a write claiming standing it failed to establish. Skipping costs a delay — the
           * records remain, and the next pass drains them once the lease reads again. */
          /* ── AND THE PERMIT'S OWN LAST VERDICT, WHICH NO CLASS IN THIS LIST NAMES ─────────
           *
           * A stand-down mid-cycle revokes the permit. `fileOne`, `reconcileFlags` and
           * `folderOpsPass` swallow everything but a fence, so it reaches here as NO ERROR and
           * this cycle would go on to acknowledge and expunge records in a mailbox another
           * install now organizes. Asked of the permit, both shapes are one fact. ORGANIZER only:
           * a reader holds no permit and its own drive below must not be refused by a receipt
           * left over from before its demotion. */
          const permitStoodDown = organize && leaseStoodDown(rt.leasePermit);
          const cycleMayStillWrite = !permitStoodDown
            && !(cycleError instanceof LeaderFencedError)
            && !(cycleError instanceof LeaseUnavailableError)
            // ── AND A SHARED-DATABASE FAULT IS NOT SOMETHING TO DRAIN THROUGH EITHER ─────────
            //
            // The arm below reads this class and sets `stopPass` — the whole point being to take
            // NO new mailbox while Postgres is down. A drain reached on that path cannot succeed:
            // every record it handles opens a transaction that fails and is swallowed, so the only
            // effects are one IMAP FETCH of `_meta` per mailbox and a burst of error logs, on
            // exactly the path that exists to stop doing work. It costs the shard a round trip per
            // mailbox to learn what the first mailbox already knew.
            && !isSharedDatabaseFault(cycleError);

          /* The request channel, after the mail — and the order is the security property. This ran
           * BEFORE `runSyncCycle` until mail 0090, so a decision could govern mail arriving the same
           * pass — a real benefit not worth its cost: `ohmail/_meta` is a folder anyone with APPEND
           * rights can write to, so a drain that runs FIRST lets a flood of records delay (or, with a
           * slow database, indefinitely postpone) the pass that reads somebody's mail. Reading mail is
           * the product; a decision landing one cycle later is imperceptible. Both halves are bounded in
           * `request-drain.ts`. It runs when the cycle FAILED (the throw is held in `cycleError`),
           * because a persistent fault used to drain nothing and a reader's decisions expired reporting
           * NOBODY TOOK THEM while an organizer was live — the throw is held, this runs, and it is
           * rethrown immediately below. ONE call site: a copy inside the catch applies a decision twice. */
          if (!cycleMayStillWrite) {
            /* Nothing, deliberately, and it is not a silent skip: the fence arm below logs the
             * handover with its own sentence, and the successor drains this mailbox on its next
             * pass. */
          } else if (!organize) {
            try {
              await driveOutstandingRequests(
                db, { mailboxId: rt.mailboxId, accountId: rt.accountId, installId: organizerInstallId, adapter: rt.adapter, requestKey: rt.requestKey },
                { installId: organizerInstallId, kind: "cloud" }, new Date(),
                (event, detail) => log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
            } catch (err) {
              log.error("outstanding_requests_drive_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this cycle reads mail regardless; the next cycle tries again",
              });
            }
          } else {
            try {
              await applyMetaRequests(
                db, { mailboxId: rt.mailboxId, accountId: rt.accountId, installId: organizerInstallId, adapter: rt.adapter, requestKey: rt.requestKey }, new Date(),
                (event, detail) => log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
              // THE ROLE FLIP'S OWN DEBT. Rows this install queued while it was a READER are
              // stranded the moment it becomes the organizer: nothing appends them any more, and
              // no ack will ever arrive because the organizer they are waiting for is this
              // process. Settled here, where the flip has demonstrably happened.
              await settleOwnOutstandingRequests(
                db, { mailboxId: rt.mailboxId, accountId: rt.accountId }, new Date(),
                (event, detail) => log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
            } catch (err) {
              log.error("organizer_requests_drain_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this cycle organizes mail regardless; the next cycle's drain tries again",
              });
            }
          }

          // The mail cycle's own failure, now that the channel has had its turn. Everything below
          // this line is the bookkeeping of a cycle that COMPLETED and must not run for one that
          // did not.
          if (cycleError !== null) throw cycleError;
          // Non-null on every path that reaches here: `syncOutcome` is assigned unless the cycle
          // threw, and a cycle that threw was rethrown one line up.
          const { hasBacklog, owesFiling } = syncOutcome as { hasBacklog: boolean; owesFiling: boolean };
          rt.failures = 0;

          // …and the shard-wide database condition, on the ONLY evidence strong enough to end it:
          // a cycle that completed wrote mail, so the database is accepting writes again. See
          // `clearDatabaseFault` for why a heartbeat or a roster pass is not enough.
          clearDatabaseFault();
          // …and the sync-block bucket, for the same reason the failure counter is cleared: this
          // mailbox is demonstrably being served, so `reconcileSyncBlocks` must CLEAR
          // `sync_blocked_reason` on the next pass instead of re-writing a `lease_unreadable` that
          // stopped being true. Without this the row would keep saying "nothing is organizing this
          // mailbox" about a mailbox that just completed a cycle — a row's claim is a contract,
          // broken here in the other direction.
          leaseBlocked.delete(rt.mailboxId);
          // …and the read-ceiling bucket, on exactly the same evidence: a completed cycle read
          // this mailbox inside every bound, so the soft block stops being true and the clear
          // above falls out for it too. This is the whole of "it clears on the next healthy
          // cycle" — there is no clearing statement anywhere else.
          readLimited.delete(rt.mailboxId);
          /** Whether this is the FIRST cycle this runtime has completed — see the stamp below. */
          const firstSuccess = rt.lastSuccessAt === null;
          rt.lastSuccessAt = new Date();
          synced.push(rt.mailboxId);
          succeeded++;
          // EITHER backlog re-kicks: `hasBacklog` is inbound mail the adapter still owes,
          // `owesFiling` is outbound intent that hit the reconciler's per-cycle budget. Both want
          // the same response — come round again after every other mailbox, not after a poll
          // interval — and only the first of them also means "the first import is finished", which
          // is why `runSyncCycle` keeps them apart and only this line puts them together.
          if (hasBacklog || owesFiling) backlogged.push(rt.mailboxId);
          // …and the same pair, on the RUNTIME, is what the fast-lane reservation reads next pass.
          // Written from the mailbox's own report rather than from any notion of size,
          // and written on every completed cycle so a mailbox that has finished importing stops
          // being heavy the moment it says so.
          rt.owesBacklog = hasBacklog || owesFiling;
          // The verified-recovery write, on the path that can actually verify it. Moved here from
          // `attach()`. The bar it cleared was "connect + folders + two inline sync cycles + IDLE", a
          // PROXY for "has actually synced" that happened to be reachable before attach returned. Here
          // every success is a real cycle, so the bar is the thing itself — and a mailbox whose login
          // works but whose every cycle throws never flips to `connected`; its failures accumulate
          // toward quarantine, the honest outcome. Spent once (`needsRecovery = false` regardless of
          // the write's fate) because `markRecovered` never throws: a fenced or failed write is retried
          // by the roster pass, which re-reads `mb.status` and is gated on this runtime having completed
          // a cycle. Retrying from here every cycle would be one pointless UPDATE per cycle.
          if (rt.needsRecovery) {
            rt.needsRecovery = false;
            await markRecovered(rt);
          }
          // …and the backoff's attempt count, for the reason spelled out where it used to live at
          // the end of `attach()`. A mailbox that completed a cycle is not in a failure backoff;
          // one that merely connected is not yet evidence of anything.
          quarantine.delete(rt.mailboxId);
          /* The portable profile's write-behind tick. Never throws — a settings copy that cannot be
           * written must not count against a mailbox whose provider did nothing wrong. Debounced
           * inside (`TF_PROFILE_FLUSH_MS`). The ROLE CHECK is here because this comment used to argue it
           * was unnecessary — "reachable only after `mayOrganize` said organize" — which was true while
           * a loser DETACHED. Mail 0083 made a loser a reader that keeps cycling, so `organize === false`
           * now falls through the gate, `runSyncCycle`, and onto this line, and the single-writer
           * mechanism the comment delegated to had stopped covering it. Measured: a Cloud worker demoted
           * by a live desktop claim appended a profile document to `ohmail/_meta` on the next cycle —
           * two installs writing settings into one `_meta`, the co-tenancy hazard, and a reader mirrors,
           * marks read and sends; publishing configuration is an organizer's act. */
          /* …and not on a permit that stood down mid-cycle. The publish is an append and an
             expunge in `ohmail/_meta`, and it is reached on exactly the shape the role check
             cannot see: a refusal swallowed inside the cycle leaves `cycleError` null, so this
             line runs with `rt.role` still holding the answer the gate gave before the drain. */
          if (rt.role === "organizer" && !permitStoodDown) await rt.profile.onOrganize();
          // The first stamp does not wait for the rest of the rotation. The batched write below stamps
          // everything that synced this pass and is still the steady-state writer, but this loop is
          // SERIAL, so a mailbox's very first `last_sync_at` waited on every other's bounded batch — and
          // `coalesce(last_sync_at, created_at) < now() - 15 minutes` (`alerts.ts`) is measured from row
          // creation, not this pass. Two ways that pages a healthy first connect: WIDTH (a real
          // two-mailbox shard measured most of ten minutes to the first completed pass), and SHUTDOWN
          // (`if (stopped) return;` above the batched write discards the stamp for every mailbox that
          // synced this pass). ONCE PER ATTACH (`attach()` mints `lastSuccessAt: null`); `woken` joins
          // it (2026-08-26) for the pull spinner. The `catch` is load-bearing and must never rethrow or
          // `continue` — a failed bookkeeping UPDATE would miss the exemptions and walk a row toward `error`.
          if (firstSuccess || woken) {
            try {
              // The DB-clock variant, NOT `new Date()`: this stamp is the pull affordance's
              // settle signal and is compared against a `sync_requested_at` the API stamped
              // with SQL `now()` — one clock or the comparison lies (see `stampMailboxSyncNow`).
              await asDatabaseFault("cycle.stampMailboxSync",
                () => stampMailboxSyncNow(db, [rt.mailboxId], Date.now() - visitStartedMs));
            } catch (err) {
              // Swallowed for the MAILBOX, announced for the SHARD — see
              // `noteIfSharedDatabaseFault`. Nothing below changes.
              noteIfSharedDatabaseFault(err, rt);
              log.error("mailbox_sync_stamp_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, count: 1, err,
                reason: "this mailbox's first-or-woken cycle completed but last_sync_at could " +
                  "not be written — the batched write at the end of this pass covers the same " +
                  "row, and the mailbox keeps serving either way",
              });
            }
          }

          // The first import is finished, so say so — once. `hasBacklog === false` is the one honest
          // end-of-import signal the worker has: this cycle drained everything the adapter owed, so the
          // mailbox is no longer partial. `stampInitialImportComplete` guards on
          // `initial_import_completed_at IS NULL`, so this is a once-per-mailbox write, and the client
          // reads a NULL stamp as a FLOOR under "still importing" regardless of what its own mirror is
          // doing — which stops a tab that caught up to a partial server state from calling the mailbox
          // done. NOT gated on `firstSuccess`: a mailbox draining in bounded batches completes several
          // cycles WITH a backlog before the one that clears it, so the stamp belongs to the first
          // no-backlog cycle. A FAILURE MUST NOT FAIL THE CYCLE — an uncaught throw would miss the
          // exemptions and walk a healthy mailbox toward `error`.
          if (!hasBacklog) {
            try {
              await asDatabaseFault("cycle.stampInitialImportComplete",
                () => stampInitialImportComplete(db, rt.mailboxId, new Date()));
            } catch (err) {
              noteIfSharedDatabaseFault(err, rt);
              log.error("mailbox_import_complete_stamp_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this mailbox's first import drained but initial_import_completed_at could " +
                  "not be written — the next no-backlog cycle re-attempts it, and the mailbox keeps " +
                  "serving either way",
              });
            }
          }

          // Putting back the html a classifier false positive threw away. A click tracker's
          // percent-escaped slash spelled `2fa`, so ordinary newsletters, invoices and alerts were
          // judged to carry an authentication code and stored redacted with their html discarded. The
          // classifier is fixed; the damaged mail is not, and the only remaining copy of that html is
          // the message on the server. HERE, not in the attach arm where the kickstart lives: the
          // kickstart is cheap on a virgin mailbox, but this is a network read per damaged message, and
          // a mailbox with two hundred would hold up its own first sync. AFTER a SUCCESSFUL
          // `runSyncCycle` (it shares the connection). A FAILURE MUST NOT FAIL THE CYCLE — the marker is
          // written only on a completed walk, and the catch swallows everything so a repair fault
          // never walks a mailbox toward `error` because a two-week-old newsletter could not be re-read.
          try {
            const repaired = await sensitiveBackfillPass({
              db: db as unknown as Tx, adapter: rt.adapter,
              accountId: rt.accountId, mailboxId: rt.mailboxId, log,
            });
            if (repaired.ran) {
              log.info("sensitive_fp_backfill_pass", {
                mailboxId: rt.mailboxId, accountId: rt.accountId,
                examined: repaired.examined, candidates: repaired.candidates,
                fetched: repaired.fetched, cleared: repaired.cleared,
                clearedFromStored: repaired.clearedFromStored,
                stillSensitive: repaired.stillSensitive, unreadable: repaired.unreadable,
                mismatched: repaired.mismatched, capped: repaired.capped,
                marked: repaired.marked,
                // `marked: false` with `capped: false` used to be unexplained on this line. It now
                // has exactly one cause worth reporting: the walk finished and could not READ
                // some originals, so the completion marker was withheld rather than certifying
                // over them. `walk` is which re-attempt that was, against the pass's bound.
                undecided: repaired.undecided, walk: repaired.blockedWalks,
              });
            }
          } catch (err) {
            log.error("sensitive_fp_backfill_failed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              reason: "no marker was written, so the next cycle retries; every message keeps the " +
                "body it already had and nothing about this mailbox's syncing is affected",
            });
          }

          // Put the connection back on watch — the last act of every successful visit. Everything above
          // re-SELECTed other folders on this same connection, and imapflow idles on whichever mailbox
          // is CURRENTLY selected — so without this line the IDLE established at attach watches the last
          // folder the visit touched, an INBOX arrival emits no `exists`, and the push channel is dead
          // from the first cycle onward while looking healthy (the measured 2026-08-26 state: p50 194 s
          // / p90 431 s arrival-to-mirror, entirely poll-driven). One SELECT per visit is the whole
          // cost, and only the success path pays it — a failed visit is connection trouble whose
          // detach/re-attach re-establishes the watch. Swallowed like the passes above: a re-arm that
          // could not SELECT is the connection dying, which the adapter's `close` listener detaches.
          try {
            await rt.adapter.rearmWatch?.();
          } catch (err) {
            log.warn("watch_rearm_failed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              reason: "the post-visit INBOX re-select failed — the connection is likely dying " +
                "and its own close listener detaches; until then this mailbox is poll-only",
            });
          }
        } catch (err) {
          // A fenced-out write is proof of lost leadership, not a mailbox fault. `worker_heartbeats`
          // stopped naming this instance as the shard's leader while a mail-bearing write was in flight
          // — the write was REFUSED with nothing persisted (`makeSyncWriteFence`), and every later write
          // of this cycle would be refused for the same reason. So the response is the lock-loss
          // response, not the failure ladder: quiesce the whole instance and let the supervisor
          // re-acquire. Counting this toward `maxSyncFailures` would quarantine a healthy mailbox over
          // OUR handover, and continuing would spend a rotation collecting the same refusal. FIRST among
          // the arms because it is the only one that ends the pass — `handleLockLoss` is idempotent.
          if (err instanceof LeaderFencedError) {
            log.error("sync_cycle_fenced", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              reason: "a mail-bearing write was refused because worker_heartbeats no longer " +
                "names this instance as the shard leader — quiescing instead of counting a " +
                "failure against the mailbox",
            });
            handleLockLoss(new LockLostError("a mail-bearing write was fenced out mid-cycle"));
            // `stopPass` and not a bare `return` since the lanes: `handleLockLoss` sets `stopped`, so
            // the dispatcher would stop taking work anyway, but the flag is what makes THIS arm's
            // meaning explicit and independent of that side effect. The lanes already running are
            // joined by the dispatcher — they cannot be abandoned, and each of them will hit the
            // same refusal and land here idempotently.
            stopPass = true;
            return;
          }
          // Our database failing is not thirteen mailboxes failing. Until this arm the cycle path
          // exempted three classes and read every other throw as evidence against the mailbox mid-cycle
          // — but a Postgres outage fails the first, then the second, then the rest, so at
          // `maxSyncFailures` the whole shard walks into quarantine with `status='error'` on customers'
          // rows and a backoff earned against a provider that answered correctly, and stays dark for the
          // ladder's length AFTER the database returns. Exempted BY ORIGIN, which is what could not be
          // done before: a dead Postgres throws `ECONNREFUSED`, the same name and code a dead IMAP host
          // throws, so no predicate over the error could separate them — every database call now goes
          // through a wrapped repo, recording the answer at the call. `rt.failures` is not incremented,
          // no backoff is written, THE PASS STOPS (`break`), and it is reported ONCE (`noteDatabaseFault`).
          if (isSharedDatabaseFault(err)) {
            noteDatabaseFault(err, { mailboxId: rt.mailboxId, accountId: rt.accountId });
            // Consequence (c) — THE PASS STOPS — reaches the dispatcher as a flag since the lanes
            // rather than as a `break`, and means exactly what it did: take no new mailbox, and
            // still run the post-loop bookkeeping so the `last_sync_at` stamps of the mailboxes
            // that DID sync before the fault are not thrown away. The lanes still in flight are
            // joined rather than abandoned; each will meet the same dead database and arrive
            // here, and `noteDatabaseFault` is edge-triggered so the shard announces once.
            stopPass = true;
            return;
          }
          // A model fault is not a mailbox failure, and must never count toward quarantine. Without
          // this, three failed polls of a third-party API detach the mailbox and write `status='error'`
          // — a model incident rendered as "your mailbox is broken". The circuit has counted the fault
          // and will open on it; the message stays un-ingested and the cursor unadvanced, so the next
          // cycle re-plans rules-only — nothing lost, nothing punished. Keyed on the ERROR CLASS, so the
          // exemption holds at every tuning. A lease we could not read is exempt BY CLASS too: it must
          // not read as "no claim, organize" (the dual-organizer bug) or as "stand down" (sticky — one
          // transient error disables a mailbox for ever). Its old "nothing happens, the next cycle asks
          // again" was an outage as policy (over a hundred cycles, most of an hour). Now it RECORDS,
          // CLOCKS, and past `leaseUnavailableDetachMs` DETACHES; `releaseOrganizerClaim` is never called here.
          if (err instanceof LeaseUnavailableError) {
            noteBlock(leaseBlocked, rt.mailboxId, leaseBlockReason(err));
            rt.leaseUnavailableSince ??= Date.now();
            const unavailableMs = Date.now() - rt.leaseUnavailableSince;
            const due = unavailableMs >= leaseUnavailableDetachMs;
            log.warn("sync_cycle_lease_unavailable", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              // WHICH operation threw, from the error and not from this call site — the attach arm
              // has carried it since mail migration 0029 and the cycle arm, the one that fired over a
              // hundred times in
              // production, did not. `LeaseOp` is a compile-time literal from a closed union, so it
              // carries no privacy cost, and without it "the lease could not be read" is one
              // sentence for four different faults.
              op: err.op,
              threshold: leaseUnavailableDetachMs,
              reason: due
                ? "the organizer lease has been unreadable past the bound — detaching so the next " +
                  "roster pass re-dials; still NOT counted toward maxSyncFailures and NOT quarantined"
                : "the organizer lease could not be read — NOT counted toward maxSyncFailures and " +
                  "NOT a stand-down; this mailbox syncs nothing this cycle, and the row will say so",
            });
            if (due) toReconnect.push({ rt, unavailableMs });
            return;
          }
          /* A REMOVED MAILBOX IS NOT A FAILING ONE. The person disconnected it while this cycle
             was planning a message; the commit refused rather than writing mail into a tombstone
             (`assertMailboxStillHere`). Counted toward `maxSyncFailures` it would be three polls
             from "your mailbox is broken" about a mailbox somebody deliberately removed — and the
             quarantine write is fenced on the row anyway, so the counter would climb against a
             state nothing can reach. The next roster pass drops it; nothing here needs to act. */
          if (err instanceof MailboxRemovedError) {
            log.info("sync_cycle_mailbox_removed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "this mailbox was removed while the cycle was reading it, so the pending "
                + "writes were refused rather than committed into a mailbox that is gone — NOT "
                + "counted toward maxSyncFailures and not quarantined",
            });
            return;
          }
          if (err instanceof ClassifierFaultError) {
            log.warn("sync_cycle_classifier_fault", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              circuit: classifierCircuit?.state(),
              reason: "model fault — NOT counted toward maxSyncFailures; the circuit degrades " +
                "this mailbox to rules-only routing and mail keeps flowing",
            });
            return;
          }
          rt.failures++;
          log.error("sync_cycle_failed", {
            mailboxId: rt.mailboxId, accountId: rt.accountId,
            consecutiveFailures: rt.failures, maxSyncFailures, err,
          });
          if (rt.failures >= maxSyncFailures) toQuarantine.push({ rt, err });
        }
      }

      // The dispatcher. Work-stealing and not waves, and the difference is the whole point of the
      // slice. A wave scheduler (take N, await all N, take the next N) costs `max(wave)` per wave, so
      // the heavy mailbox dominates its wave and the rotation barely moves (3×254 s + 10×2 s serial is
      // 782 s, in waves of three ~766 s). Lanes that refill the instant one frees cost
      // `max(total/N, longest)` — ~260 s for the same shard — the point at which a mailbox waits for
      // its OWN batch rather than the shard's. The roster yield is at the TOP, where the adoption fix
      // put it, and is now the only place a mailbox is taken from `pending`; lanes may be in flight
      // across it, the property `laneBusy` now enforces directly.
      for (;;) {
        if (stopped) break;
        // Serve the roster pass this cycle is sitting on. Lanes may be running while this pass works,
        // so "nothing is suspended inside an adapter" is no longer what makes it safe — `laneBusy` is:
        // the pass detaches nothing a lane is holding and defers it to `deferredLeaves`. NOT while
        // `stopPass` is set: the pass is winding down because the shared database is gone, and a roster
        // pass is a database read — attempting it once per draining lane would add `roster_pass_failed`
        // lines to the moment an operator least wants noise, and could not succeed. It stays owed and
        // runs after this cycle, where the queued entry `requestRoster` made would have run it.
        if (!stopPass) await yieldToRoster();
        if (stopped) break;
        // …and whatever that pass just adopted that has never synced goes to the front of what
        // is left of this pass, not to the back of the next one.
        admitNewFirstSyncers();
        // …and whoever rang the doorbell since their turn gets another one.
        admitWoken();
        // …and whoever rang it BEFORE their turn stops waiting at a position planned before the
        // wake existed — the mid-pass half of the wake ordering (see `reorderPending`).
        reorderPending();

        // Fill every free lane with the first ADMISSIBLE runtime, not merely the first one: a
        // mailbox held back by a busy account or by the heavy cap must not block the mailboxes
        // behind it, which would be head-of-line blocking reintroduced by the fix for it.
        while (!stopPass && !stopped && inFlight.size < cycleLanes) {
          const at = pending.findIndex(admissible);
          if (at < 0) break;
          const rt = pending.splice(at, 1)[0]!;
          // One turn per mailbox id per pass — the bound that keeps the live queue above finite,
          // and the reason a re-admitted runtime cannot be served twice. The single exception is
          // a wake that `admitWoken` has already accounted for and bounded; it is CONSUMED here,
          // so nothing can pass this gate twice on one signal.
          if (servedIds.has(rt.mailboxId) && !revisitAllowed.delete(rt.mailboxId)) continue;
          servedIds.add(rt.mailboxId);
          // And then distrust the snapshot, by identity and not by presence. `pending` was planned at
          // the top of this cycle and a roster pass may since have detached this mailbox (disabled,
          // deleted, parked, evicted). The single queue used to make that impossible; the yield above
          // trades it away, so it becomes a line of code with a test. `runtimes.get(id) !== rt` and NOT
          // `!runtimes.has(id)`, because a ten-minute cycle spans many roster intervals: one pass can
          // detach a mailbox and a later one re-attach it as a NEW runtime with a NEW connection. `has`
          // is true for that, and the stale `rt` this loop holds carries the CLOSED adapter — its
          // failures would climb to `maxSyncFailures`, and `detach(staleRt)` deletes by mailbox id,
          // evicting the healthy runtime and writing `error` on a mailbox that is working perfectly.
          if (runtimes.get(rt.mailboxId) !== rt) continue;
          // THE WAKE IS SPENT ON ADMISSION, not on completion — see `MailboxRuntime.wokenAt`. A
          // signal that arrives during this very visit is about mail that landed after
          // `changesSince` answered, and must survive into the next pass. Whether this WAS a
          // woken admission is captured first — the visit stamps `last_sync_at` eagerly for
          // exactly the woken ones (see `visitMailbox`).
          const wokenVisit = rt.wokenAt !== null;
          rt.wokenAt = null;
          const heavy = rt.owesBacklog;
          busyAccounts.add(rt.accountId);
          laneBusy.add(rt.mailboxId);
          if (heavy) heavyInFlight++;
          // The bookkeeping is in a `finally` INSIDE the async body, so it has already run by the
          // time this promise settles — which is what lets the `Promise.race` below trust the
          // maps it re-reads on the next turn.
          const lane = (async () => {
            try {
              await visitMailbox(rt, wokenVisit);
            } finally {
              inFlight.delete(rt.mailboxId);
              busyAccounts.delete(rt.accountId);
              laneBusy.delete(rt.mailboxId);
              if (heavy) heavyInFlight--;
            }
          })();
          inFlight.set(rt.mailboxId, lane);
        }

        // Nothing running and nothing admissible ⇒ the pass is over. It cannot mean "everything
        // left is blocked", because a block is always by an in-flight lane and there are none.
        //
        // A wake that lands in the instant between this test and the next `kickCycle` is not lost:
        // `wokenAt` stays set on the runtime, the kick queues a pass behind this one, and that
        // pass orders the woken mailboxes ahead of the rest.
        if (inFlight.size === 0) break;
        // Go round when a lane finishes OR when something new arrives. `race` and not `all`, so a
        // lane that finishes early takes the next mailbox instead of waiting out the backfill
        // beside it — and `wakeSignal` is what makes a doorbell audible to a cycle whose every
        // lane is inside a long batch, which is the difference between a bounded-batch wait and a
        // free-lane wait. Neither a lane nor the signal ever rejects, so this never does either.
        await Promise.race([...inFlight.values(), wakeSignal]);
      }
      // JOINED, NEVER ABANDONED. Every list the post-loop bookkeeping reads — `synced`,
      // `toStandDown`, `toQuarantine`, `toReconnect` — is written by lanes, and a `stopped` or a
      // `stopPass` that left them running would have the detach loops below closing adapters
      // mid-batch: the exact hazard the whole file is arranged to prevent. `stop()` awaits this
      // cycle's queue entry, so its drain still covers every lane.
      await Promise.all(inFlight.values());
      // …and only THEN is a shutdown allowed to skip the bookkeeping, which is what the three
      // `if (stopped) return` statements this loop used to carry did. The join above is the part
      // that could not be kept literal: a `return` with lanes running would leave `stop()`'s own
      // detaches closing adapters mid-batch. The recorded consequence — a deploy landing
      // mid-rotation discards the batched `last_sync_at` stamp — is unchanged and is still why
      // the first-success stamp inside the visit exists.
      if (stopped) return;

      // ── AND THE MAILBOXES A ROSTER PASS COULD NOT TAKE WHILE A LANE HELD THEM ──────────────
      //
      // FIRST among the post-loop detaches, because leaving the duty is a strictly better answer
      // than any of the three below it: a mailbox that is no longer ours must not also be
      // quarantined for a failure it collected on the way out. `release` is the entitlement-lapse
      // release the roster pass would have done inline — see its site for why that is the ONE
      // teardown path that releases the organizer claim.
      for (const { rt, release, reason } of deferredLeaves.splice(0)) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        if (release) await releaseOrganizerClaim(rt, "this mailbox is no longer an enabled mailbox of this shard");
        await detach(rt, reason);
      }

      // Persist what the loop above only knew in memory. Best-effort and deliberately BEFORE
      // the quarantine pass: a mailbox that synced this cycle earned its stamp regardless of
      // what happens to a different one below.
      try {
        await asDatabaseFault("cycle.stampMailboxSync",
          () => stampMailboxSyncNow(db, synced, Date.now() - passStartedMs));
      } catch (err) {
        noteIfSharedDatabaseFault(err);
        log.error("mailbox_sync_stamp_failed", {
          count: synced.length, err,
          reason: "mailboxes synced but last_sync_at could not be written — the lag alert and " +
            "the (i) panel will understate freshness until the next cycle rewrites it",
        });
      }

      // Standing down means being a reader in place, and this loop detaches only the ones that must
      // leave. The three post-loop lists (stand-down, quarantine, lease-blocked) carry the IDENTITY
      // GUARD the rotation loop carries and for the same reason: they were validated when PUSHED, and
      // a roster pass has been able to run between then and now since mid-cycle adoption — detaching a
      // stale `rt` deletes the map entry a healthy re-attached runtime owns. Outside the loop, like the
      // quarantine pass, so a detach can never close an adapter the rotation is still walking. SAY WHAT
      // IS AND IS NOT PROVEN: the HARM is proven — deleting the guard on the rotation loop turns
      // `roster-preemption.e2e.test.ts`'s stale-runtime claim red with `mailboxes: 3` where 4 are
      // attached. The three guards below are the same rule at the same risk; each ALONE is not covered,
      // so it is written down rather than asserted, so the next person knows which line is evidence.
      for (const rt of toStandDown) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        await detach(rt, "this mailbox's organizer lease could not be read for long enough to stop trying");
        // `reason: null` — the sync-block reason for this population is written by the
        // unreadable-lease arm itself (`lease_unreadable`), which is a better answer than
        // anything this line could add. See `SyncBlock`.
        noteBlock(leaseBlocked, rt.mailboxId, null);
      }

      // A mailbox that keeps failing at RUNTIME is detached and quarantined exactly like one
      // that failed to attach — otherwise a dead IDLE connection is retried forever and
      // `mailboxes` in /health keeps counting it as if it were serving.
      for (const { rt, err } of toQuarantine) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        await detach(rt, `${rt.failures} consecutive sync failures`);
        await quarantineMailbox(rt.mailboxId, rt.accountId, err, "sync");
      }

      // A connection that cannot read its own lease is detached, not quarantined. The whole
      // distinction, in three properties this loop has and the quarantine loop does not: NO backoff
      // entry and NO `status='error'` — this is an infrastructure fault, so the row keeps saying
      // `connected` while `sync_blocked_reason` says `lease_unreadable`, the honest pair the by-class
      // exemption protects; NO `releaseOrganizerClaim` — Cloud intends to keep organizing, and a
      // release here would hand the mailbox to a desktop install on every blip; and the mailbox is left
      // in `leaseBlocked` by the arm that queued it, so `roster_invariant_violated` stays quiet (a
      // detached-and-accounted-for mailbox is not a duty gap). Outside the rotation loop, so a detach
      // never closes an adapter the loop is still walking.
      for (const { rt, unavailableMs } of toReconnect) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        await detach(
          rt,
          `the organizer lease was unreadable for ${unavailableMs}ms (bound ${leaseUnavailableDetachMs}ms) — ` +
          "the connection cannot serve this mailbox, so the next roster pass re-attaches it on a fresh one",
        );
      }

      // The DB passes run over the shard's full enabled set, not the attached duty. This used to be
      // `dutyAccounts` (`accountsOf(served)`, capped at `maxMailboxes`), a cap that exists to bound
      // IMAP CONNECTIONS and nothing else — and neither pass below opens one, so an account whose
      // mailbox fell past the cap had its `workflow_runs` accepted with a 202 and drained by nobody,
      // and its snoozed messages never resurfaced. `dutyAccounts` stays the list for the THREAD
      // BACKFILL, which needs an attached mailbox. Multi-shard is closed by construction
      // (`shardPredicate` is `hashtext(account_id) % shards`). DELIBERATE SCOPE: the list derives from
      // ENABLED MAILBOXES, so a fully-disabled account gets no drain, time scan or bubble-up flip
      // (the intended semantics — a suspended account's automation must not keep firing). FALLBACK, not
      // failure: a database fault degrades to the old narrower list. cycle() has exactly ONE preemption point.
      let passAccounts = dutyAccounts;
      try {
        passAccounts = await asDatabaseFault("cycle.loadServedAccounts",
          () => loadServedAccounts(db, selection));
      } catch (err) {
        noteIfSharedDatabaseFault(err);
        log.error("served_accounts_load_failed", {
          err, accounts: dutyAccounts.length,
          reason: "the shard-wide account list could not be read; this cycle's DB passes run " +
            "over the ATTACHED duty only, so an account past the mailbox cap is skipped once",
        });
      }

      // The bubble-up resurfacing pass, in the loop and time-gated. It lives here rather than a platform
      // cron because `runBubbleUpCron` takes `acquireLeaderLock(…, leaderLockKeyFor(shardIndex))` — the
      // SAME lock this process holds — so a platform cron on this shard would be a process whose only
      // function, while the worker is healthy, is to start, fail to take the lock and exit; the wrapper
      // is a manual backstop for a DEAD worker. Until this call, nothing in production flipped
      // `bubbled_up` back, so `AppShell`'s resurface shortcut showed a DATED promise ("Resurfaces
      // {when}") no code could keep. BEFORE the workflow block, since a message coming due may satisfy
      // a `time` trigger this tick. TIME-GATED, not per-cycle-unconditional and not its own
      // `setInterval` — a second off-queue writer is unearned for one query per account, and an
      // off-queue pass can close an adapter the cycle is walking.
      if (Date.now() - lastBubbleUpAt >= BUBBLE_UP_EVERY_MS) {
        lastBubbleUpAt = Date.now();
        for (const accountId of passAccounts) {
          if (stopped) return;
          try {
            // Scoped per account even though this process is the only writer of its shard: the
            // pass's own header explains why (an unscoped pass under a shard-specific lock
            // would let shard 0 mutate shard 1's rows), and per-account isolation keeps one
            // account's failure from skipping the rest.
            const { flipped } = await asDatabaseFault("cycle.bubbleUpPass",
              () => bubbleUpPass(db as unknown as Tx, new Date(), { accountId }));
            if (flipped > 0) log.info("bubble_up_flipped", { accountId, flipped });
          } catch (err) {
            noteIfSharedDatabaseFault(err);
            log.error("bubble_up_failed", {
              accountId, err,
              reason: "a snoozed message stayed hidden past its bubble_up_at; the next pass " +
                "retries it, the predicate is the row's own state and nothing is marked",
            });
          }
        }
      }

      // Per-account DB passes, isolated per account so one account's workflow
      // error can never abort another account's drain — nor the sync cycle.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const nowTick = new Date();
          await asDatabaseFault("cycle.workflowTimeScanPass",
            () => workflowTimeScanPass(db as unknown as Tx, { accountId }, nowTick));
          // NOT wrapped in `asDatabaseFault`: the drain calls the DRAFTER, so a model outage
          // throws from inside it and must not be tagged as our database — the same subtraction
          // `sensitiveBackfillPass` gets, for the same reason.
          await workflowDrainPass(
            db as unknown as Tx,
            { drafter: config.drafter ?? unconfiguredDrafter, accountId, ...(spend ? { credits: spend } : {}) },
            nowTick,
          );
        } catch (err) {
          noteIfSharedDatabaseFault(err);
          log.error("workflow_drain_failed", { accountId, err });
        }
      }

      // Give back the mail stuck at the screening gate behind a decision the account already made.
      // BEFORE the retro pass below and in its own try/catch and loop, for that loop's reason: one
      // account's failure must not skip the rest. Running first is deliberate — it arms the release
      // licence on rules the retro pass then walks in the SAME cycle, so an affected account is
      // repaired in one pass of the tail instead of two. For every account already swept the call is
      // one indexed read of `account_settings` and no more, and it stops for ever once the marker is
      // stamped. It needs nothing beyond the db and core packages, the same dependency reason the
      // two passes below state without naming the forbidden package (`deps.test.ts` scans this
      // file's raw text).
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const r = await gateReleasePass(db as unknown as Tx, { accountId, log }, new Date());
          if (r.ran && (r.rulesArmed > 0 || r.contactRowsReleased > 0 || r.completed)) {
            log.info("gate_release_swept", {
              accountId, rulesArmed: r.rulesArmed,
              contactRowsReleased: r.contactRowsReleased, completed: r.completed,
            });
          }
        } catch (err) {
          log.error("gate_release_failed", {
            accountId, err,
            reason: "no account was marked swept, so the next cycle starts it again; a rule this " +
              "pass already armed is in flight and drops out of its own selection, and a row it " +
              "already released is desired into the Ohbox and no longer at the gate",
          });
        }
      }

      // Apply a new rule to mail that is already filed. Its OWN try/catch and loop, not folded into the
      // workflow block, for that block's reason: one account's failure must not skip the rest. It runs
      // HERE, on the worker, not the API host, because writing thousands of `folder_state` rows inside
      // `POST /rules` is what this slice stops — the sheet used to fire one `POST /messages/:id/move`
      // per match from the browser, each taking the account's sync-state row lock, abandoning the rest
      // if the tab closed. The pass needs nothing from the services package (the db and core packages
      // are its whole imports), which makes this the right host. The package is named in prose, not
      // backticks, on purpose: `deps.test.ts` scans this file's raw TEXT and does not strip comments.
      // NOT time-gated, unlike `bubbleUpPass`: its per-cycle write budget bounds it, its owed probe is
      // one indexed query, and a user who clicked a destination is waiting for their mail to move.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const { moved, completed, capped } = await ruleRetroPass(
            db as unknown as Tx,
            // Per-MAILBOX trust, off the credential row's own IMAP host, because one
            // account's mailboxes can sit at different providers. The pass caches per mailbox.
            { accountId, log, trustedAuthservIdsFor: mailboxProviderAuthservIds },
            new Date(),
          );
          if (moved > 0 || completed > 0) {
            log.info("rule_retro_pass", { accountId, moved, completed, capped });
          }
        } catch (err) {
          log.error("rule_retro_failed", {
            accountId, err,
            reason: "no rule was marked applied and no cursor advanced past uncommitted work, " +
              "so the next cycle resumes from `retro_cursor`; mail already moved is desired " +
              "state the reconciler converges independently of this pass",
          });
        }
      }

      // File the already-misfiled automated mail out of the Ohbox. Its OWN try/catch and loop: one
      // account's failure must not skip the rest. It is the durable, one-time-per-opt-in half of the
      // `people_only` posture — the live engine demotes NEW mail, this re-routes the backlog placed
      // before the account opted in. Like the retro pass it lives here and needs nothing beyond the db
      // and core packages (the same dependency reason, stated without naming the forbidden package
      // because `deps.test.ts` scans this file's raw text). It is owed work only for an account that
      // flipped to `people_only` or pressed "tidy now", which one PK read checks; for every other
      // account the call is that read and no more. NOT time-gated: its per-cycle write budget bounds it,
      // and an owner who just opted in is waiting for their Ohbox to shrink.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const { ran, moved, completed, capped } = await ohboxTidyPass(
            db as unknown as Tx,
            // Same per-mailbox trust as the retro pass above, same canonical resolver.
            { accountId, log, trustedAuthservIdsFor: mailboxProviderAuthservIds },
            new Date(),
          );
          if (ran && (moved > 0 || completed)) {
            log.info("ohbox_tidy_pass", { accountId, moved, completed, capped });
          }
        } catch (err) {
          log.error("ohbox_tidy_failed", {
            accountId, err,
            reason: "no account was marked done and the cursor advanced only past committed pages, " +
              "so the next cycle resumes from `ohbox_tidy_cursor`; mail already moved is desired " +
              "state the reconciler converges independently of this pass",
          });
        }
      }

      // Rejoin the conversations a forward split. A forward re-entering the mailbox carries no
      // References, so one human conversation becomes two header chains and renders as two threads —
      // correctly, under the ingest rule, which is why no ingest change can close it. The heal merges
      // them once the evidence completes (`conversationJoinVerdict` — same account, same base subject,
      // the same non-self correspondent on BOTH chains, the later opening with a reply/forward prefix,
      // inside a 14-day window), performing exactly the merge `POST /threads/merge` performs, change
      // rows included. TIME-GATED like `bubbleUpPass` and unlike the retro/tidy passes, because nobody
      // is waiting on it: it repairs presentation, its own budget bounds a run, and its pre-filter is a
      // per-account GROUP BY that would buy nothing per-cycle. Its OWN try/catch and loop.
      if (Date.now() - lastThreadJoinHealAt >= THREAD_JOIN_HEAL_EVERY_MS) {
        lastThreadJoinHealAt = Date.now();
        for (const accountId of passAccounts) {
          if (stopped) return;
          try {
            const r = await asDatabaseFault("cycle.threadJoinHealPass",
              () => threadJoinHealPass({
                db: db as unknown as Tx, apply: true, accountId, log,
                cursor: threadJoinHealCursors.get(accountId),
              }));
            // Carry the resume point while the budget (not the candidate set) ended the walk
            // — UNCONDITIONALLY. Resetting on failure is the tempting wrong move: a group
            // that fails deterministically would pin every run to its own page and starve the
            // tail for ever, which is strictly worse than a failed group waiting for the walk
            // to wrap. Transients are already retried once INSIDE the run (see the pass), so
            // `failed` here means the persistent case. An uncapped pass has seen everything
            // and starts the next walk fresh.
            if (r.capped && r.cursor) threadJoinHealCursors.set(accountId, r.cursor);
            else threadJoinHealCursors.delete(accountId);
            if (r.merged > 0 || r.skipped > 0 || r.failed > 0) {
              // Named fields, not a spread: `r.cursor` carries a thread SUBJECT (user content
              // the census deny-lists), and the counters must land on registered names.
              log.info("thread_join_heal_pass", {
                accountId, scanned: r.groupsScanned, merged: r.merged,
                moved: r.messagesMoved, skipped: r.skipped, failed: r.failed, capped: r.capped,
              });
            }
          } catch (err) {
            noteIfSharedDatabaseFault(err);
            log.error("thread_join_heal_failed", {
              accountId, err,
              reason: "no group of this account committed partially — each is one transaction — " +
                "and the candidate predicate is the rows' own state, so the next gated run " +
                "re-reads reality and resumes",
            });
          }
        }
      }

      // ── THE INBOUND-QUIET PASS: notice the mailbox a provider-side forward emptied ──────
      //
      // The forwarding-detection heuristic (mail 0078, `inbound-quiet.ts` carries the predicate
      // and the incident). TIME-GATED like the heal above and for its reason: the pass judges
      // fortnight-wide windows, so nothing a user can perceive changes between two cycles, and
      // per-cycle it would be a fleet-wide grouped aggregate bought against no latency. Scoped
      // per account under this shard's lock (bubble-up's argument), its OWN try/catch and loop
      // so one account's failure must not skip the rest — and never a cycle abort: the notice
      // is observability, and mail continues to be filed either way.
      if (Date.now() - lastInboundQuietAt >= INBOUND_QUIET_EVERY_MS) {
        lastInboundQuietAt = Date.now();
        for (const accountId of passAccounts) {
          if (stopped) return;
          try {
            const r = await asDatabaseFault("cycle.inboundQuietPass",
              () => inboundQuietPass(db as unknown as Tx, new Date(), { accountId }));
            if (r.tripped > 0 || r.cleared > 0) {
              log.info("inbound_quiet_pass", { accountId, tripped: r.tripped, cleared: r.cleared });
            }
          } catch (err) {
            noteIfSharedDatabaseFault(err);
            log.error("inbound_quiet_failed", {
              accountId, err,
              reason: "the quiet-mailbox judgment was skipped this pass; episodes already " +
                "stamped stand, nothing is cleared or tripped, and the next gated run " +
                "re-reads reality — syncing is untouched",
            });
          }
        }
      }

      // Re-deliver `autoReplyByUs` to mirrors that predate it. The flag is computed at materialize
      // time, so it reaches a message only when a change_log row for that message does — and every
      // responder reply already in somebody's Ohbox was written before the flag existed, so without
      // this pass the client filters on a field those rows do not carry and the replies stay in
      // "Earlier" for ever, the fix invisible on exactly the mailboxes that reported the bug (found by
      // review as a HIGH). ONCE PER PROCESS, on the first cycle (see the gate's docblock for why no
      // durable marker). Its OWN try/catch and loop, and it must never abort a cycle: it writes no
      // state of its own, moves nothing and touches no message row — a change_log row is a re-read
      // instruction — so the next gated run simply re-reads reality.
      if (!awayReplySweep.done
          && Date.now() - lastAwayReplySweepAt >= AWAY_REPLY_REDELIVER_RETRY_MS) {
        lastAwayReplySweepAt = Date.now();
        // The GATE IS THE SWEEP'S, closed after its own loop and only on a clean full pass. It
        // used to be a boolean set here, before the accounts were walked, which retired the whole
        // fleet's sweep on one account's failure. Its per-account try/catch keeps that shape — one
        // account's failure must not skip the rest — and reports through `onError`.
        const r = await asDatabaseFault("cycle.awayReplySweep",
          () => awayReplySweep.runOnce(db as unknown as Tx, passAccounts, {
            log,
            onError: (accountId, err) => {
              noteIfSharedDatabaseFault(err);
              log.error("away_reply_flag_redeliver_failed", {
                accountId, err,
                reason: "no change row for this account committed partially — each page is one " +
                  "transaction — the account keeps its cursor, the sweep stays owed, and the " +
                  "next attempt resumes there; no message was moved or altered",
              });
            },
          }));
        if (r.redelivered > 0 || r.failed > 0) {
          // `capped` carries "the sweep is still owed", NOT a field named `done`:
          // `ALLOWED_FIELDS` drops an unregistered key silently, so `done` would vanish from the
          // line. Inverted rather than renamed, because `capped` already means "the walk did not
          // reach the end" everywhere else in this cycle.
          log.info("away_reply_sweep", {
            accounts: r.accounts, marked: r.redelivered, failed: r.failed, capped: !r.done,
          });
        }
      }

      // ── TRIM THE ROLLING WINDOW: at the storage cap, the oldest stored bodies husk ──────
      //
      // Its OWN try/catch and loop, like every pass here: one account's failure must not skip
      // the rest. For every account under its high-water mark the pass is two indexed reads and
      // no more; over it, bounded rounds of bounded batches, resuming next cycle
      // (`storage-evict.ts` carries the hysteresis argument). Registered in this SERIAL
      // per-account section deliberately — the repair passes order body-row-then-counter, the
      // evictor counter-then-body-rows, and serial execution per account is what keeps the two
      // orderings from ever facing each other.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const { ran, evicted, freedBytes, capped } = await storageEvictPass(
            db as unknown as Tx, { accountId, log, storageCap: storageCapFor }, new Date(),
          );
          if (ran && evicted > 0) {
            log.info("storage_evict_pass", { accountId, evicted, freedBytes, capped });
          }
        } catch (err) {
          log.error("storage_evict_failed", {
            accountId, err,
            reason: "each round is one transaction, so a failure loses nothing durable; the " +
              "counter and the husks move together or not at all, and the next cycle re-probes",
          });
        }
      }

      // ── FILE THE OBVIOUS BULK OUT OF THE SCREENER, FOR OPTED-IN ACCOUNTS ────────────────
      //
      // Its OWN try/catch and loop, for the reason the blocks above have one: one account's failure
      // must not skip the rest. Unlike those two this is not owed-once backfill — it is a standing
      // OPT-IN, off by default, so for every account that has not turned it on the pass is a single
      // PK read and no more (the `screener_auto_apply_at IS NOT NULL` probe). It applies DETERMINISTIC
      // routing only (the strong-bulk floor), never the model and never a spend, keeps sensitivity-
      // flagged mail at the gate, and writes reversible intents the reconciler converges — same as
      // the passes above, and like them it lives here on the worker needing nothing beyond db + core.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const { ran, moved, capped } = await screenerAutoApplyPass(
            db as unknown as Tx, { accountId, log }, new Date(),
          );
          if (ran && moved > 0) {
            log.info("screener_auto_apply_pass", { accountId, moved, capped });
          }
        } catch (err) {
          log.error("screener_auto_apply_failed", {
            accountId, err,
            reason: "nothing is marked and no cursor persists — a moved row leaves the Screener and " +
              "drops out, so the next cycle re-examines from the top; mail already moved is desired " +
              "state the reconciler converges independently of this pass",
          });
        }
      }

      // Buy the model's advice about incoming held senders. Its OWN try/catch and loop. It runs AFTER
      // the deterministic auto-apply above, load-bearing: that pass files the obvious bulk OUT of the
      // Screener with no model and no spend, so anything it takes this cycle is a sender this one never
      // pays to ask about (wrong way round and the account buys advice about newsletters about to be
      // filed for free). The ONLY pass here that spends money, and the only thing in the product that
      // spends with no press in the same minute — three bounds hold it (the `auto_suggest_at`
      // watermark, a ten-sender page per account per cycle, and `spend()` before every model call with
      // the first refusal stopping the account). Off by default. It books the SAME `debit_classify`
      // reason ingest meters with (the `classify:screener:<message_id>` source is a real duplicate
      // check), but the `screener` ACTION — an exclusive claim and the screening-only setup grant first.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          // The Ohbox bar, so a suggestion bought here asks the same question a user-pressed one
          // does. Read through the same 30-second cache the sync loop fills for every served
          // account, so this is a hit rather than a read per account per cycle.
          const screening = await screeningFor(accountId);
          const { ran, bought, charged, stopped: why, capped } = await screenerAutoSuggestPass(
            db as unknown as Tx,
            {
              accountId, log,
              classifier: classifierCircuit?.port(),
              ...(spend ? { credits: spend } : {}),
              ...(screening.ohboxBar ? { ohboxBar: screening.ohboxBar } : {}),
            },
          );
          if (ran && (bought > 0 || why)) {
            log.info("screener_auto_suggest_pass", { accountId, bought, charged, stopped: why, capped });
          }
        } catch (err) {
          log.error("screener_auto_suggest_failed", {
            accountId, err,
            reason: "nothing is marked and no cursor persists — a sender whose suggestion was " +
              "stored drops out of the candidate query, so the next cycle resumes at the next " +
              "unbought sender; a charge with no stored row is retried free (the ledger source " +
              "is the message, so the retry answers `duplicate`)",
          });
        }
      }

      // ── Global maintenance, leader-only and time-gated (~hourly) ────────────────────
      //
      // `idempotency_keys` rows are written by every mutation and read only by a retry, so
      // nothing ever revisits them: without a sweep the table grows for the lifetime of the
      // deployment. `expires_at` is a 24-hour promise the API now ENFORCES on lookup, and this
      // is the other half — the rows actually going away. It belongs here rather than in a
      // platform cron because the worker is already the single elected writer, so exactly one
      // process runs it, and a failure is a logged warning, never a cycle abort.
      if (Date.now() - lastMaintenanceAt >= MAINTENANCE_EVERY_MS) {
        lastMaintenanceAt = Date.now();
        try {
          const pruned = await pruneIdempotencyKeys(db as unknown as Tx, new Date());
          if (pruned > 0) log.info("idempotency_pruned", { pruned });
        } catch (err) {
          log.error("idempotency_prune_failed", { err });
        }
        // ── SPENT SEND-CONTENT CLAIMS ──────────────────────────────────────────────────
        //
        // HYGIENE, and it is worth saying plainly because the neighbouring sweep above is not:
        // no send's answer depends on this running. The window inside which an identical message
        // is refused is compared against the request clock in the send path, so a claim this
        // deletes had already stopped refusing anything. That is deliberate — a standalone
        // install runs the same send path and has no maintenance pass at all, so an expiry that
        // depended on pruning would be unbounded on every desktop.
        try {
          const fps = await pruneSendFingerprints(db as unknown as Tx, new Date());
          if (fps > 0) log.info("send_fingerprints_pruned", { pruned: fps });
        } catch (err) {
          log.error("send_fingerprint_prune_failed", { err });
        }
        // Expired staged attachment bytes: the object, then the row. A hosted send puts attachment
        // bytes in a private bucket and references them; the row carries a 24-hour `expires_at` and
        // this is the half that makes that a fact. Same slot as the prune above (the worker is the
        // single elected writer). The abandoned upload is the case that matters — a ticket minted, a
        // compose window closed, no object written — and `remove` treats a storage 404 as success so
        // that row goes (reading it as failure would keep every abandoned ticket for the deployment's
        // life). It DRAINS: this took ONE 200-row page per hourly slot, which any faster account
        // outran, starving cleanup for everyone; `sweepExpiredStagingFor` now pages until empty under a
        // row ceiling and wall-clock budget. `drained: false` is a WARNING even though nothing threw —
        // a clean-looking number over a growing bucket is exactly what went wrong before.
        if (stagingStorage) {
          try {
            const sweep = await sweepExpiredStagingFor(db as unknown as Tx, stagingStorage, new Date());
            if (sweep.deleted > 0 || sweep.pages > 0) {
              log.info("attachment_staging_swept", {
                swept: sweep.deleted, pages: sweep.pages, drained: sweep.drained,
                stoppedBy: sweep.stoppedBy, failedPages: sweep.failedPages,
              });
            }
            if (!sweep.drained && sweep.pages > 0) {
              log.warn("attachment_staging_backlog", {
                swept: sweep.deleted, pages: sweep.pages,
                stoppedBy: sweep.stoppedBy, failedPages: sweep.failedPages,
                reason: sweep.failedPages > 0
                  ? "object storage refused at least one delete; those rows keep their objects and " +
                    "the next pass retries them, and the drain paged past them so nothing behind " +
                    "them is stalled"
                  : "the pass hit its per-invocation bound with rows still expired; the next pass " +
                    "resumes from the oldest of them. Sustained, this means the ceiling is below " +
                    "what this deployment produces and wants raising",
              });
            }
          } catch (err) {
            log.error("attachment_staging_sweep_failed", {
              err,
              reason: "the rows stay and the next maintenance pass retries — objects are deleted " +
                "before their rows, so nothing is orphaned by a failure here",
            });
          }
        } else {
          log.info("attachment_staging_sweep_skipped", {
            reason: "no staging bucket is configured on this worker; if the API stages, its " +
              "bucket is not being swept",
          });
        }
      }

      // FRESHNESS HONESTY: advance only when work actually succeeded, or when there was
      // genuinely nothing to sync. An all-failed or zero-connected cycle must NOT refresh
      // /health, or a dead leader looks perfectly fresh forever.
      if (succeeded > 0 || expected === 0) lastCycleAt = new Date();

      // ── The pulse. LAST in the cycle, so `lastCycleAt` is already the value this
      //    cycle produced and the row never claims a freshness the worker has not earned.
      await beat();

      // Backfill drain. A mailbox mid-backfill is drained as fast as the queue allows instead of one
      // bounded batch per `pollIntervalMs` (at two hundred messages a cycle, a 60 s poll would take a
      // twenty-thousand-message mailbox ~100 hours). Queued through `kickCycle`, so it lands on the
      // SAME serial queue as the roster pass and cannot starve reconciliation. Termination: a truncated
      // batch always ADMITS at least one message, and every admitted message leaves a durable trace the
      // next known-set reflects (a row, an instance, or a failure-ledger row), so the unknown set
      // strictly shrinks. The earlier "always commits at least one message" wording was FALSIFIED in
      // production (2026-08-29): an admitted create whose dedup arm REPOINTED the primary instead of
      // recording an instance learned nothing, so the re-kick fired every ~2.3 minutes for ever — the
      // shrink guarantee is a property of `pipeline.ts`'s dedup arms and `fetchCapped`, not admission alone.
      if (backlogged.length > 0 && !stopped) {
        log.info("backfill_progress", {
          mailboxes: backlogged.length, sample: backlogged.slice(0, 3),
          reason: "adapter reported a truncated batch — re-kicking rather than waiting for the poll interval",
        });
        kickCycle();
      } else {
        // …and only once the MESSAGE backlog is drained does the THREAD backlog get a slice.
        // A mailbox still streaming its first sync has better uses for the queue, and the mail
        // arriving during it is threaded at ingest anyway — so waiting costs nothing but the
        // slices themselves, which are one-shot.
        kickThreadBackfill();
      }
    }

    // The thread backfill, behind the cycle and bounded. What the first version got wrong was
    // placement, not the pass: it ran to exhaustion on the attach seam, in front of a live IMAP
    // connection, and killed the process. Four properties replace it, each a guard in
    // `thread-backfill-placement.e2e.test.ts`: 1. attach never waits for it (there is no call on that
    // path — a stronger statement than "it is fast"); 2. it is a SEPARATE queue entry, not the tail of
    // `cycle()`, so it runs after the cycle reported and deliberately does NOT touch `lastCycleAt` or
    // `beat()` — freshness it did not earn is the lie /health was fixed to stop telling; 3. bounded by
    // pages AND wall clock (resuming is free — the predicate is `thread_id IS NULL`); 4. it cannot
    // throw into anything (an escaping rejection becomes `exit(1)`). PACING: one slice per completed
    // cycle, NO self re-kick — a `setMessageThread` regression would otherwise pin the CPU.

    /** One slice at a time on the queue, the same dedupe `kickCycle` uses. */
    let backfillQueued = false;
    /**
     * Round-robin over `dutyAccounts`, so a shard with many accounts spends the same budget
     * per cycle and no account can be starved by a larger one. Read MODULO the current length:
     * `reconcileRoster` reassigns the list, and an index captured against an older, longer one
     * would address `undefined` and run a slice for no account at all.
     */
    let backfillCursor = 0;
    const threadBackfill = config.threadBackfill ?? runThreadBackfill;

    async function threadBackfillSlice(): Promise<void> {
      if (stopped || dutyAccounts.length === 0) return;
      const accountId = dutyAccounts[backfillCursor % dutyAccounts.length]!;
      backfillCursor++;
      try {
        const r = await threadBackfill({
          repo, accountId, log,
          maxPages: THREAD_BACKFILL_SLICE_PAGES,
          deadlineMs: THREAD_BACKFILL_SLICE_MS,
        });
        if (r.resolved > 0) {
          log.info("thread_backfill_slice", {
            accountId, resolved: r.resolved, threadsCreated: r.threadsCreated, more: r.truncated,
          });
        }
      } catch (err) {
        // The whole point of the slice. A failure here is unthreaded mail — mail that reads as
        // singletons, not mail that is lost — and it must cost the cycle nothing. Nothing is
        // marked, so the next slice resumes from wherever `thread_id IS NULL` now starts.
        log.error("thread_backfill_failed", {
          accountId, err,
          reason: "the backlog is identified by `thread_id IS NULL` rather than by a marker, " +
            "so the next slice resumes it",
        });
      }
    }

    function kickThreadBackfill(): void {
      if (stopped || backfillQueued) return;
      backfillQueued = true;
      void serialize(async () => {
        backfillQueued = false;
        await threadBackfillSlice();
      }).catch((err: unknown) => {
        // Unreachable while `threadBackfillSlice` catches everything, and kept precisely
        // because that is a property of today's body rather than of the queue. An escaping
        // rejection here is an `unhandledRejection`, and this process exits on those.
        log.error("thread_backfill_slice_failed_unexpectedly", { err });
      });
    }

    /**
     * Stamp this leader's row in `worker_heartbeats` — the durable evidence that makes
     * "no leader lock held for > 2 minutes" answerable by a process that is not this one.
     *
     * BEST EFFORT, always. A failed beat must never abort a sync cycle: the worst case is a
     * false "worker down" alert, and the alternative — observability code that can take a
     * working worker offline — is strictly worse than the fault it reports.
     */
    async function beat(): Promise<void> {
      if (stopped) return;
      try {
        await writeHeartbeat(db as unknown as Tx, {
          shardIndex, instanceId, shards, startedAt, ...counters(),
        });
      } catch (err) {
        log.warn("heartbeat_write_failed", { err });
      }
    }

    /**
     * Why the duty is not fully served, right now — the count and its decomposition. Set arithmetic
     * over `servedIds` against the rotation and the three block maps, bounded by `maxMailboxes` (64),
     * so it runs on every `/health` probe and beat and touches no database (which `/health` may never
     * do). THE BUCKET ORDER IS A PRECEDENCE, because the maps are not disjoint: the reachable overlap
     * is quarantine + stand-down (a mailbox whose backoff expires is offered to `attach`, `mayOrganize`
     * declines it, and the quarantine entry is deliberately NOT deleted). QUARANTINE WINS, from the
     * asymmetry of being wrong: calling a stood-down mailbox quarantined costs an arguably-false
     * degraded reading, while calling a quarantined mailbox stood down HIDES a real fault (`standDown` is excluded from the calculus). A conservative error stays visible; the other quietly weakens an assertion.
     */
    function unservedBreakdown(): UnservedBreakdown {
      const b = {
        total: 0, quarantined: 0, awaitingCredentials: 0,
        standDown: 0, leaseUnreadable: 0, unaccounted: 0,
      };
      for (const id of servedIds) {
        if (runtimes.has(id)) continue;
        b.total++;
        const lease = leaseBlocked.get(id);
        if (quarantine.has(id)) b.quarantined++;
        else if (awaitingCreds.has(id)) b.awaitingCredentials++;
        // `reason === null` is the STAND-DOWN and only that — `SyncBlock` above records why the
        // nullable reason means "the row already explains itself": `markMailboxStoodDown` wrote
        // `disabled` plus `organized_elsewhere:*` in the same statement. So this reads the dual-mode
        // hand-off off the same discriminator the sync-block writer uses, rather than a second one.
        else if (lease !== undefined) { if (lease.reason === null) b.standDown++; else b.leaseUnreadable++; }
        else b.unaccounted++;
      }
      return b;
    }

    /**
     * The worker's degraded causes, NAMED. One struct, built once, feeding both consumers:
     * `worker_heartbeats.degraded` through `counters()` below, and `/health`'s ranked
     * `degradedReason` through `evaluateHealth`. They cannot disagree because there is nothing to
     * disagree with — see `DegradedCauses` in `health.ts` for why the boolean it replaces was the
     * thing that made an unnamed `degraded: true` reachable at all.
     */
    function degradedCauses(): DegradedCauses {
      const u = unservedBreakdown();
      return {
        // `dbFaultSince !== null` is a cause in its own right because a shared-database fault is
        // invisible in every counter here — the mailboxes stay attached and the shortfall is zero
        // throughout, which is the correct outcome of the origin-tagging fix and would otherwise read as a
        // perfectly healthy worker that is silently syncing nothing.
        databaseFault: dbFaultSince !== null,
        dutyGap,
        // Stand-downs subtracted: a mailbox another organizer holds is not a shortfall of this
        // worker's. `UnservedBreakdown.standDown` carries the ruling and the measurement.
        unserved: u.total - u.standDown,
        standDown: u.standDown,
        capacityDropped: truncated,
      };
    }

    /** The live scheduling numbers, shared by `beat`, `pulse` and `stats`. */
    function counters(): {
      mailboxes: number; expected: number; accounts: number; quarantined: number;
      degraded: boolean; lastCycleAt: Date | null; aiCircuitOpenSince: Date | null;
      aiProviderOkAt: Date | null;
    } {
      const connected = runtimes.size;
      return {
        mailboxes: connected,
        expected,
        accounts: dutyAccounts.length,
        // A mailbox that is BACK in the rotation is not quarantined, whatever the map still
        // holds, and since attach stopped draining this filter carries more weight rather than less: the entry
        // is now spent on the mailbox's first SUCCESSFUL CYCLE, not at the end of its attach, so
        // the window in which a mailbox is both in `runtimes` and still in `quarantine` is a
        // whole cycle wide instead of a few statements. Without the filter, `degraded` would read
        // as a fault during every perfectly good re-attach — and `/health`'s `quarantined` is
        // read by the deploy gate, so that would be a self-inflicted 503.
        quarantined: [...quarantine.keys()].filter((id) => !runtimes.has(id)).length,
        // DERIVED from the named causes, never ORed separately. This used to read
        // `dutyGap || truncated > 0 || connected < expected || dbFaultSince !== null` — four
        // conditions, one boolean, and by the time `/health` saw it there was no name left to
        // publish. `anyDegradedCause` is the same predicate over the struct that carries the names.
        degraded: anyDegradedCause(degradedCauses()),
        lastCycleAt,
        // The classifier circuit's age, published so something outside this process can see it. The
        // breaker is in-process by design (one circuit per process, sharing one API key), so an outage
        // that opens it is invisible to every other host: mail keeps arriving, files by rules alone,
        // and nothing fails, times out or writes an error row — the whole point of the breaker, and why
        // the state has to leave the process (a fault whose entire symptom is "mail is routed worse"
        // cannot be noticed by a liveness check). FIRST open of the current run, not the newest: the
        // cooldown doubles per trip and the breaker half-opens between them, so an hour's outage
        // produces a series whose latest is always minutes old. Cleared by the first success, so a
        // closed circuit publishes null and the rule stops firing on its own.
        aiCircuitOpenSince: classifierCircuit?.state().firstOpenedAt ?? null,
        // The other half of the sentence above. A closed circuit means "no outage" only if this
        // process has actually had an answer; before its first success it means "no attempt", and
        // a worker replacing another mid-outage is in exactly that state. Publishing it lets the
        // row keep an inherited outage instead of reading a new process's silence as recovery.
        aiProviderOkAt: classifierCircuit?.state().lastSuccessAt ?? null,
      };
    }

    /**
     * The off-queue pulse — the fix for a worker that looks dead while it is working hardest. Every
     * other beat happens at the END of something (a cycle, an attach, a roster pass), fine until a
     * real first sync arrived: `cycle()` drains one bounded batch per pass, so a leader backfilling a
     * large mailbox writes nothing for minutes, and the `worker_down` rule reads `beat_at` staleness
     * and nothing else — at two minutes it pages about a worker ingesting as fast as the provider
     * serves. So the pulse runs on the LOCK-VERIFY timer, off the serial queue, and only after
     * `lock.verify()` answered `held: true` (the claim is backed by the lock, not a process asserting
     * about itself). It uses `refreshHeartbeat`, whose UPDATE is guarded on `(shard, instance, leader = true)` in the statement — a timer must never resurrect a surrendered leader. The cost: a wedged serial queue keeps beating, caught instead by `sync_lag` at fifteen minutes (a recorded follow-up).
     */
    async function pulse(): Promise<void> {
      if (stopped) return;
      try {
        await refreshHeartbeat(db as unknown as Tx, { shardIndex, instanceId, ...counters() });
      } catch (err) {
        log.warn("heartbeat_refresh_failed", { err });
      }
    }

    /**
     * One alert pass, from the WORKER side. It covers the DB-visible rules (stuck sends, sync lag and
     * their neighbours) and deliberately does NOT include itself: `shards: []` skips the leader-
     * liveness rule, because a process reporting that it is alive is not evidence of anything. That
     * rule is the API host's job (`GET /internal/alerts`), a different process on a different platform
     * (see `alerts.ts`'s header). Never throws: it runs off a timer, and an unhandled rejection here
     * would take down a worker that is syncing mail perfectly well.
     */
    async function alertPass(): Promise<void> {
      try {
        const result = await runAlertPass(db as unknown as Tx, {
          sinks: alertSinks, shards: [], source: "worker", environment,
          deliveryStreak: alertDeliveryStreak,
          // THE DRIVER'S OWN NAME, which is what makes two of the rules possible.
          //
          // `alert_driver_dark` looks at the OTHER driver's row — never its own — because a
          // process cannot testify to its own liveness. That is the same sentence `shards: []`
          // one line up encodes for `worker_down`: this pass declines to evaluate the rule about
          // itself, and the API host's pass is the one that answers it. The pair is now closed at
          // both levels — the API watches this worker, and this worker watches the API's pass.
          //
          // It also names this host in `schema_behind`'s key, so "the worker is ahead of the
          // database" and "the API is ahead of the database" stay two findings with two fixes.
          driver: "worker",
        });
        for (const alert of result.firing) {
          log.warn("alert_firing", {
            alertKey: alert.key, kind: alert.kind, severity: alert.severity,
            count: alert.count, oldestSeconds: alert.oldestSeconds, detail: alert.detail,
          });
        }
        for (const key of result.resolved) log.info("alert_resolved", { alertKey: key });
        // `api_faults`' seven-day retention, on the cadence of the arm that reads the table.
        // AFTER the pass, never before: the rules read a ten-minute window, so a prune ahead of
        // them could only ever delete rows they were about to ignore — and if it throws, the
        // pass has already delivered. It swallows its own faults; see the module.
        await apiFaultPrunePass(db as unknown as Tx, new Date(), log);
        if (result.notified.length > 0) {
          log.warn("alert_notified", {
            alertKeys: result.notified.map((a) => a.key),
            delivered: result.delivered, failedSinks: result.failedSinks,
            // WHY a sink refused, not just that it did. Every one of these lines used to read
            // `delivered=[] failedSinks=["webhook"]` and nothing else, which is true, unhelpful,
            // and cost a deploy to turn into a diagnosis. Flat `"<sink>: <reason>"` strings
            // because the logger's field census gates keys at every depth — see `deliver`.
            sinkErrors: result.sinkErrors,
            sinkFailureStreak: result.sinkFailureStreak,
          });
        }
        for (const lost of result.sinkDegraded) {
          // REDUNDANCY LOST, AND NOTHING ELSE WOULD HAVE SAID SO.
          //
          // The page landed — `alerts_undeliverable` has nothing to report and `sinkErrors`
          // reads like the routine noise a working pager also produces. Meanwhile one arm has
          // refused every delivery for the whole streak, and this deployment is back to the
          // single-vendor posture a second vendor was added to leave. ERROR, because the cost
          // of learning it during the NEXT outage is the entire reason the arm exists.
          log.error("alert_sink_degraded", {
            sink: lost.sink,
            outcome: lost.outcome,
            consecutiveFailures: lost.consecutiveFailures,
            survivors: lost.survivors,
            sinkErrors: lost.error ? [`${lost.sink}: ${lost.error}`] : [],
            reason: "one alert sink has refused every delivery for a full streak while another " +
              "delivered — pages are still landing, and the pager is back to a single vendor",
          });
        }
        if (result.escalate) {
          // A CONFIGURED sink that has refused every delivery is the same outcome as no sink at
          // all — alerts firing into nothing — and until this line existed it was the quieter of
          // the two: the no-sink case below shouts every pass, while a broken webhook logged a
          // WARN that looked like routine noise. Once per streak, cleared by any success.
          log.error("alerts_undeliverable", {
            firing: result.firing.length,
            reason: "every configured alert sink refused delivery, repeatedly — alerts are reaching nobody",
            sinks: result.escalate.sinks,
            consecutiveFailures: result.escalate.consecutiveFailures,
            sinkErrors: result.escalate.errors,
          });
        }
        if (result.firing.length > 0 && result.undeliverable) {
          // The single most dangerous state this file can be in: alerts that fire into
          // nothing. Said out loud, every pass, so it cannot be the thing nobody noticed.
          log.error("alerts_undeliverable", {
            firing: result.firing.length,
            reason: "no alert sink is configured — set TF_ALERT_EMAIL " +
              "(with RESEND_API_KEY + MAIL_FROM) or TF_ALERT_WEBHOOK_URL",
          });
        }
      } catch (err) {
        log.error("alert_pass_failed", { err });
      }
    }

    let cycleQueued = false;
    function kickCycle(): void {
      if (stopped || cycleQueued) return;
      cycleQueued = true;
      void serialize(async () => { cycleQueued = false; await cycle(); }).catch((err: unknown) => {
        // A DATABASE FAULT THAT ESCAPED THE ROTATION LOOP IS STILL THE SHARD-WIDE CONDITION.
        //
        // `cycle()` does more than walk mailboxes — the per-account passes below the loop each
        // catch their own, but this is the backstop, and without this line a fault that reached
        // it would be an `error` line and NOTHING ELSE: `/health` would keep answering
        // `degraded: false` about a worker that has stopped syncing. Recorded through the same
        // one-incident path, so it cannot double-announce an outage the loop already named.
        if (isSharedDatabaseFault(err)) noteDatabaseFault(err);
        log.error("cycle_failed_unexpectedly", { err });
      });
    }

    // The lock machinery starts BEFORE the initial roster, not after it. The initial roster pass
    // attaches every mailbox, and each attach used to also drain two bounded batches inline — minutes
    // per mailbox. While that ran, the two things that make this process observable and safe did not
    // exist yet, because both were created AFTER the `await` below. The ordering stays even though the
    // pass is now bounded by connect-time (a lock lost during a slow dial still has to be handled, and
    // 64 mailboxes' connects is not short): the pulse (the boot window wrote one heartbeat and then
    // nothing — `/health` said `standby, mailboxes: 0`, a busy worker indistinguishable from a dead
    // one), and the lock guard (a lock LOST during a long boot attach was not handled until the pass
    // returned — two workers draining one mailbox, the split-brain this guard prevents). The cost:
    // `handleLockLoss` can now fire before the work timers exist, so those are nullable and null-guarded.

    // ── Split-brain guard (the advisory lock is SESSION-scoped: Postgres frees it the
    //    instant the connection drops, and postgres.js then silently reconnects WITHOUT it).
    let verifyErrors = 0;
    let hbTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let rosterTimer: ReturnType<typeof setInterval> | null = null;
    let alertTimer: ReturnType<typeof setInterval> | null = null;
    let syncKickTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * The UnifiedPush wake sender and the LISTEN it feeds from. Not timers, but they belong to
     * `clearTimers` for the reason that function actually serves: it is "stop doing work NOW",
     * and it is what `handleLockLoss` and the startup-failure path both call. A deposed leader
     * that kept POSTing wakes would have a successor doing the same thing beside it — two wakes
     * per message, and a device that cannot tell which instance is authoritative. The hub's
     * `end()` is awaited nowhere here on purpose: it closes a socket, `clearTimers` is called
     * from synchronous paths, and a LISTEN left to the idle close is bounded.
     */
    let pushWake: RunningPushWake | null = null;
    let wakeHub: ChangeWakeFanout | null = null;
    /**
     * The API-cron scheduler (`api-cron.ts`). In `clearTimers` for the push-wake's exact
     * reason: a deposed leader that kept poking the reconcile route would overlap its
     * successor's pokes — the one concurrency the scheduler cannot guard from inside one
     * process — so "stop doing work NOW" must take it down with the rest.
     */
    let apiCron: ApiCronHandle | null = null;
    function clearTimers(): void {
      if (pollTimer) clearInterval(pollTimer);
      if (rosterTimer) clearInterval(rosterTimer);
      if (alertTimer) clearInterval(alertTimer);
      if (syncKickTimer) clearInterval(syncKickTimer);
      if (hbTimer) clearInterval(hbTimer);
      pollTimer = rosterTimer = alertTimer = syncKickTimer = hbTimer = null;
      apiCron?.stop();
      apiCron = null;
      pushWake?.stop();
      pushWake = null;
      const hub = wakeHub;
      wakeHub = null;
      if (hub) void hub.end().catch(() => { /* a LISTEN that will not close politely is closed by the socket */ });
    }
    stopTimers = clearTimers;
    function handleLockLoss(err: LockLostError): void {
      if (lockLost || stopped) return;
      lockLost = true;
      stopped = true;                              // stop triggering any new work immediately
      // SYNCHRONOUSLY, beside the tripwire and not on the queue. The detach below runs on the
      // serial queue and may wait out a `changesSince` already in flight; the known-set memo must
      // stop being servable at the INSTANT loss is observed, exactly as `lockLost` stops the next
      // mail-bearing write. Everything else here is about not writing; this is about not reading a
      // remembered answer that a successor is now entitled to invalidate.
      for (const rt of runtimes.values()) rt.deps.knownSet?.drop("leader lock lost");
      clearTimers();
      log.error("leader_lock_lost", {
        err,
        reason: "quiescing this instance to avoid two workers syncing the same accounts",
      });
      // Detach on the queue so we never close an adapter mid-cycle — but the queue entry no
      // longer waits behind minutes of writing. `lockLost` above is the sync fence's
      // synchronous tripwire (`SyncDeps.fence`, `() => lockLost` at `attach`): the in-flight
      // cycle refuses its next mail-bearing write or IMAP mutation, unwinds, and this entry
      // runs. Until the fence existed, `stopped = true` only took effect BETWEEN mailboxes, so
      // the loser kept committing messages, cursors and IMAP moves for the rest of its bounded
      // batch while the detach it owed sat queued behind exactly that work. The residual wait
      // is the non-writing phase of the cycle (a `changesSince` fetch already in flight), which
      // may hold this entry up but can no longer persist anything.
      void serialize(async () => {
        for (const rt of [...runtimes.values()]) await detach(rt, "leader lock lost");
        // Surrender the heartbeat too. Leaving the last beat behind would keep the shard
        // looking alive for the whole `leaderStaleMs` window while nothing is syncing —
        // the alert would arrive two minutes after we already KNEW.
        try { await clearHeartbeat(db as unknown as Tx, fence); }
        catch (e) { log.warn("heartbeat_clear_failed", { err: e }); }
      }).catch(() => undefined);
      hooks.onLockLost?.(err);
    }
    void lock.lost.then(handleLockLoss);
    hbTimer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        try {
          const held = await lock.verify();
          verifyErrors = 0;
          if (!held) { handleLockLoss(new LockLostError("heartbeat found the lock no longer held")); return; }
          // PROVEN LEADER, THEN PULSE. The order is the point: the row's claim that this shard
          // has a live leader is now backed by the advisory lock answering `held`, not by a
          // process asserting it about itself. A verify that FAILS deliberately skips the
          // pulse — an unproven leader should go stale, which is what the alert reads.
          await pulse();
        } catch (err) {
          // A failed heartbeat QUERY is not proof of loss (a slow DB, a statement timeout).
          // Genuine loss arrives via `lock.lost` (connection close) or a `held: false` answer.
          verifyErrors++;
          log.error("lock_verify_failed", { consecutiveFailures: verifyErrors, err });
        }
      })();
    }, heartbeatMs);

    // ── Initial roster (inside the queue, so the first timer tick cannot overlap it).
    await serialize(reconcileRoster);
    // Beat again now the roster is known: a leader that takes 60 s to write its first real
    // heartbeat is a leader the alerter reports as down for the first minute of every
    // deploy, which is how a real alert becomes noise on day one.
    await beat();

    log.info("worker_serving", {
      mailboxes: runtimes.size, accounts: dutyAccounts.length,
      maxMailboxes, rosterIntervalMs, alertIntervalMs,
      alertSinks: alertSinks.map((s) => s.name),
    });
    if (alertSinks.length === 1) {
      // ONE ARM IS NOT A PAGER, IT IS A SINGLE POINT OF FAILURE THAT USUALLY WORKS.
      //
      // Said at boot rather than left to be noticed, because the state is silent by
      // construction: one arm delivers every page correctly right up to the moment its vendor
      // has an outage, and then there is nothing — no failed delivery to escalate, no arm left
      // to carry the escalation. This is the one line that distinguishes "configured" from
      // "redundant", and it names the way out rather than only the problem.
      log.warn("alert_sinks_single_vendor", {
        alertSinks: alertSinks.map((s) => s.name),
        reason: "the pager has exactly one delivery arm; a single vendor outage silences it " +
          "entirely — arm a second by setting TF_ALERT_TELEGRAM_BOT_TOKEN + " +
          "TF_ALERT_TELEGRAM_CHAT_ID, or TF_ALERT_EMAIL (with RESEND_API_KEY + MAIL_FROM)",
      });
    }

    pollTimer = setInterval(() => { kickCycle(); }, config.pollIntervalMs);
    // Takeover kick. `setInterval` fires for the FIRST time only after a full period, so without this
    // a standby that just won the lock waits `pollIntervalMs` (60 s) before its first cycle — measured
    // across a real rolling deploy as a 68 s gap between the outgoing instance's last cycle and the
    // incoming one's first, while the lock handover was ~five seconds and the idle wait for the first
    // tick was the rest. It used to be a partial defence (attach ran `reconcileOnRestart`, so only the
    // per-account passes waited); that is no longer true, and this covers MAIL too — attach registers a
    // mailbox and syncs nothing, so without a kick a fresh leader holds two live logins and processes
    // no mail for a poll interval. Second of two kicks, deliberately redundant: `reconcileRoster` kicks
    // whenever a pass attached anything, `kickCycle` is idempotent, and a boot depending on the pass's
    // kick would be one refactor from a silent 60 s dead start. Queued, so `startWorkerWithLock` returns.
    kickCycle();
    // REQUESTS a pass rather than appending one. The old form put a pass on the tail
    // and left it there: during a measured ten-minute cycle that produced
    // fourteen identical queued passes, none of which could run, while `expected` in the
    // heartbeat kept reporting a duty computed before the customer's mailbox existed.
    rosterTimer = setInterval(() => { requestRoster(); }, rosterIntervalMs);
    // The alert pass runs OFF the serial queue: it is four aggregate reads and must not wait
    // behind a slow IMAP cycle — the cycle being slow is one of the things it reports on.
    alertTimer = setInterval(() => { void alertPass(); }, alertIntervalMs);
    /**
     * The API-cron schedule — this worker as the clock for the API host's internal passes (the session
     * reap and the SMTP SIZE back-fill, daily). The whole argument (why the worker and not the platform
     * cron those routes were written for, why the cadence restarts with leadership, every overlap arm)
     * is `api-cron.ts`'s header; what is decided HERE is only WHO schedules: inside
     * `startWorkerWithLock`, so only the leader-lock holder pokes; shard 0 only, because these passes
     * are deployment-wide, not per-shard, and N shard leaders poking hourly is N−1 too many; and armed
     * by config (`TF_API_CRON_URL` + `TF_API_CRON_SECRET`), so a self-hosted compose stays quiet.
     */
    if (config.apiCron && shardIndex === 0) {
      apiCron = startApiCron({ baseUrl: config.apiCron.baseUrl, secret: config.apiCron.secret, log });
    }
    // Enforced sync (mail 0049): a short scan for mailboxes the API stamped `sync_requested_at`. OFF
    // the serial queue like the alert pass — it is one indexed read plus a compare-and-clear, no
    // adapter operation — and its `kick` REQUESTS a cycle rather than running one, so the actual sync
    // still goes through the single queue. Scoped to `runtimes` so it only hastens a mailbox this
    // instance organizes. SINGLE-FLIGHT, because `setInterval` does not wait for its callback: a
    // database taking longer than 3 s stacks a new pass on the slow one every tick, each holding a pool
    // connection and racing the same compare-and-clear — one slow read turned into pool pressure at the
    // worst moment. A tick that finds the previous pass running skips; the stamp is there next time.
    let syncKickInFlight = false;
    syncKickTimer = setInterval(() => {
      void (async () => {
        if (stopped || syncKickInFlight) return;
        syncKickInFlight = true;
        try {
          await syncKickPass({
            db: db as unknown as Tx,
            served: () => runtimes.keys(),
            // The SAME two halves the IDLE callback uses: name the mailbox that is owed a
            // visit, then ask for a cycle. `syncKickPass` already knows which mailbox it is
            // hastening — before this the kick discarded that and asked for an undifferentiated
            // rotation, so the mailbox whose Sent copy the user is watching for waited behind every
            // other mailbox on the shard exactly as an IDLE-woken one did.
            kick: (mailboxId) => { noteWake(mailboxId); kickCycle(); },
            log,
          });
        } catch (err) {
          log.warn("sync_kick_failed", { err });
        } finally {
          syncKickInFlight = false;
        }
      })();
    }, SYNC_KICK_EVERY_MS);

    /**
     * The UnifiedPush wake sender. Here rather than the API for the reason `push_subscriptions` had no
     * sender for months: the thing that knows mail arrived is whatever ingested it, and on both the
     * managed host and a self-host compose that is THIS process (the serverless API has no place to
     * keep a LISTEN or a debounce window). It is fed by the change-wake hub rather than the ingest
     * path: `change_log` is where every writer converges, so a wake fires for anything a device would
     * pull, not only the arrivals this file knows about, at ONE session-mode connection for the
     * process. ONLY THE LEADER SENDS — this body runs with the shard's lock held, and two instances
     * POSTing to one endpoint is the duplicate-wake shape the organizer lease argues about for IMAP. The construction cannot fail the boot (a hub whose LISTEN will not establish retries), wrapped anyway because a boot that dies here would take mail syncing down for a latency feature.
     */
    try {
      wakeHub = makeChangeWakeHub(config.databaseUrl, log);
      /**
       * THE VAPID IDENTITY, OR THE REASON THERE IS NONE — read here, ONCE, at boot.
       *
       * `TF_VAPID_PRIVATE_KEY` is read in this process and in no other: the API serves the public
       * half so phones can register with it, and nothing a request handler does needs the ability to
       * sign. Read once rather than per use because `makeVapidIdentity` derives a key and asserts
       * the pair, and because two reads could disagree if the environment changed under a
       * long-running process — one value, one boot, one log line.
       */
      const vapid = vapidFromEnv();
      pushWake = startPushWake({
        db: db as unknown as Tx,
        source: wakeHub,
        // The env-read policy, and the SAME variable `apps/server` reads — the process that
        // validates a registration and the process that dials it must not disagree.
        guard: pushEndpointGuardFromEnv(),
        /**
         * THE SHARD FILTER. `subscribeAll` hears every account on the deployment, which is what
         * the sender needs and also what makes a sharded fleet duplicate: each shard runs its own
         * leader under its own lock key, and every one of them would reach every registration.
         * The predicate is the one the cron backstops already use to refuse out-of-shard work, so
         * "which accounts are mine" has one answer in this app rather than two. On the shipped
         * single-shard configuration it returns true without a query.
         */
        ownsAccount: (accountId) => accountInShard(db, accountId, selection),
        /**
         * Passing the whole discriminated answer rather than a nullable identity is what lets the
         * sender distinguish "the operator configured nothing" (degrade: the plaintext arm still
         * serves raw consumers) from "the operator configured something broken" (refuse to send at
         * all: a half-working feature would hide the mistake). See `PushWakeDeps.vapid`.
         */
        vapid,
        log,
      });
      /**
       * Said at BOOT rather than left to the first wake, because "are encrypted wakes on" is a fact an
       * operator wants when the process starts — and because both the `absent` and `configured` arms
       * are deliberately silent from then on. `state` and `reason`, NOT `vapid`/`encryptedWakes`: the
       * logger allow-lists field NAMES and drops the rest, and the first managed deploy of this line
       * logged `droppedFields=["vapid","encryptedWakes"]` and therefore said nothing at all — the exact
       * failure the allow-list reports rather than hides. `state` carries the three-valued answer
       * (`configured`/`absent`/`invalid`), which is the whole fact.
       */
      log.info("push_wake_started", {
        state: vapid.kind,
        ...(vapid.kind === "configured" ? {} : { reason: vapid.why }),
      });
    } catch (err) {
      log.warn("push_wake_unavailable", {
        err,
        reason: "new-mail wake POSTs are off for this instance; devices still sync on foreground "
          + "and pull-to-refresh, which is the floor this feature sits on",
      });
      pushWake = null;
      wakeHub = null;
    }

    let teardown: Promise<void> | null = null;
    return {
      stats(): WorkerStats {
        return {
          ...counters(),
          // NOT in `counters()`, for the same reason `truncated` is not: those fields are also the
          // `worker_heartbeats` payload and that table has no column for either. Both are memory
          // reads, so `/health` still touches no database.
          causes: degradedCauses(),
          unserved: unservedBreakdown(),
          awaitingCredentials: awaitingCreds.size,
          truncated,
          // NOT part of `counters()`, for the reason `escalatedMessages` gives below it: those
          // fields are also the `worker_heartbeats` payload and that table has no column for this
          // one. It is a memory read, so `/health` still touches no database — which for THIS
          // field is not merely a nicety but the whole point, since it reports the state in which
          // the database cannot be read.
          databaseFaultSince: dbFaultSince === null ? null : new Date(dbFaultSince),
          lockLost,
          // Summed off the attached ledgers, which hold what the last hydration read — so this is a
          // memory read and `/health` still touches no database, which is the one thing that
          // endpoint may never do. It is NOT part of `counters()`: those fields go into
          // `worker_heartbeats` as well, and that table has no column for this one.
          escalatedMessages: [...runtimes.values()]
            .reduce((n, r) => n + (r.deps.deadLetters?.escalated ?? 0), 0),
          // Derived rather than stored, so it cannot drift from the streak the pass actually
          // mutates. `sinkHealthOf` reads memory only — `/health` still touches no database.
          alertSinks: sinkHealthOf(alertSinks, alertDeliveryStreak),
          // The API-cron schedule's per-target report — a memory read like everything else
          // here. `[]` when the arm is unconfigured, on shards > 0, or after quiescing.
          apiCron: apiCron?.health() ?? [],
        };
      },
      stop(): Promise<void> {
        // Idempotent (SIGINT + SIGTERM, or a supervisor stop racing a fatal path).
        teardown ??= (async () => {
          stopped = true;
          // FIRST, and before `clearHeartbeat` below: the pulse runs off the serial queue, so
          // a timer left armed here could land its refresh after the surrender. The guarded
          // UPDATE would refuse it anyway (`leader = true` is false by then) — this is the
          // belt to that suspenders, and it also stops a beat racing `owned.close()`.
          clearTimers();
          await drain();                   // let the in-flight cycle/roster pass finish
          try {
            for (const rt of [...runtimes.values()]) await detach(rt, "worker stopping");
            // Hand the shard back BEFORE the pool closes: a clean shutdown that left its last
            // beat behind would look alive for two more minutes, and a deploy that failed to
            // start its replacement would then be reported two minutes late.
            if (!lockLost) {
              try { await clearHeartbeat(db as unknown as Tx, fence); }
              catch (err) { log.warn("heartbeat_clear_failed", { err }); }
            }
          } finally {
            // The lock MUST be released even if closing the pool rejects, or the shard stays
            // dark behind a lock nobody holds a worker for.
            try { await owned.close(); } catch (err) { log.error("db_pool_close_failed", { err }); }
            try { await lock.release(); } catch (err) { log.error("lock_release_failed", { err }); }
          }
        })();
        return teardown;
      },
    };
  } catch (err) {
    // The lock guard and its pulse now start BEFORE the initial roster pass, so a startup
    // failure after that point leaves an armed timer holding the event loop open and writing
    // to a pool that is about to close. `stopTimers` is set once they exist.
    stopTimers?.();
    for (const rt of runtimes.values()) {
      if (rt.unwatch) { try { await rt.unwatch(); } catch { /* ignore */ } }
      try { await rt.adapter.close(); } catch { /* ignore */ }
    }
    try { await owned.close(); } catch { /* ignore */ }
    await lock.release();
    throw err;
  }
}

/** `account/mailbox` ids for a log line, bounded so one bad config cannot flood the log. */
function sample(mbs: readonly EnabledMailbox[], n = 3): string {
  const head = mbs.slice(0, n).map((m) => `${m.accountId}/${m.mailboxId}`).join(", ");
  return mbs.length > n ? `${head} (+${mbs.length - n} more)` : head;
}

/**
 * The CLI bootstrap, as a NAMED export — because "was this module run directly?" stops being
 * answerable inside a single-file bundle. The self-host organizer image bundles this package into one
 * file holding FIVE `isCliEntry(import.meta.url)` main guards (this one and the four cron CLIs), all
 * reading the SAME `import.meta.url`; run directly, all five fire — the crons finish and `flushExit(0)`,
 * a clean exit that kills the supervisor mid-boot (measured as a restart loop on the bundled
 * organizer's first compose boot). So the bundle's entry stub neutralizes `argv[1]` (no guard can
 * match) and starts THIS function explicitly (`scripts/bundle-host.mjs` carries the other half). Under
 * `node dist/index.js` and `tsx src/index.ts` nothing changes — the guard below calls the same function.
 */
export async function runWorkerCli(): Promise<void> {
  await (async () => {
    // THE composition root for logging. `startWorkerWithLock` defaults to `silentLogger` so no test or
    // embedder inherits stdout noise; the process a human deploys is the one that turns the logger on,
    // exactly once, here. It starts UNBOUND — no `instanceId`, no `environment` — because those come
    // from `loadConfig()`, and reading the environment is one of the two things most likely to fail on
    // a fresh deploy: a logger that cannot exist until the configuration parses is a logger that cannot
    // report a configuration that does not parse. So the bootstrap logger is built first, the crash
    // handlers are hung off it, and it is REPLACED (not rebuilt at each call site) once the config is
    // in hand; `installCrashHandlers` reads it lazily for exactly that reason.
    let cliLog = createLogger({ service: "worker" });
    // `survivable` closes the shared-database-fault fix's own residual. postgres@3.4.9 throws a TypeError from
    // `setImmediate(nextWrite)` when a connection dies with a write buffered — no promise, so it
    // arrives here — and answering it with `exit(1)` crash-loops this process through exactly the
    // database outage the rest of this file taught it to ride out. The measurement, the rejected alternatives (no
    // published version fixes it; a vendor patch was declined) and the shape of the match are all
    // in `driver-write-race.ts`. Everything else still exits 1.
    installCrashHandlers({ log: () => cliLog, survivable: driverWriteRaceReason });

    try {
      // Both of these can throw, and until they were moved inside the try neither had a
      // handler: the rejection escaped a discarded async IIFE. See `installCrashHandlers`.
      const { runWorkerSupervised } = await import("./supervisor.js");
      const config = loadConfig();
      cliLog = createLogger({
        service: "worker",
        fields: { instanceId: config.instanceId ?? instanceIdFrom(), environment: config.environment },
      });

      // Light the notice channel, once, and lazily. `packages/db` drops notices until a host installs
      // a sink, so without this line the drain is silent rather than structured — safer than the
      // postgres.js default of dumping the raw notice object, but zero diagnostics. Installed here,
      // AFTER `cliLog` has been rebuilt with `instanceId`/`environment`, so a `pg_notice` line is
      // attributable to an instance. Read through a closure rather than captured by value, for the same
      // reason `installCrashHandlers({ log: () => cliLog })` does: `cliLog` is REPLACED, not rebuilt at
      // each call site, so a sink holding the value would keep logging through the pre-config logger for
      // the life of the process.
      setNoticeSink(noticeSinkFor({
        warn: (event, fields) => cliLog.warn(event, fields),
        info: (event, fields) => cliLog.info(event, fields),
      }));

      const sup = await runWorkerSupervised({ ...config, logger: cliLog }, {
        onFatal: (err) => { cliLog.error("fatal_after_takeover", { err }); flushExit(1); },
      });
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        cliLog.info("shutdown_requested", { signal });
        void sup.stop().then(() => flushExit(0), (err: unknown) => {
          cliLog.error("shutdown_failed", { err });
          flushExit(1);
        });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      cliLog.info("worker_up", { state: sup.state(), healthPort: sup.healthPort });
    } catch (err) {
      // `err` ONLY — the logger reduces it to class + code. A boot failure's message is the
      // most tempting one to print and the most likely to carry a connection string; the env
      // var that is actually at fault is named through `WorkerConfigError.configVar`, which is
      // a key we chose rather than a string a driver composed.
      cliLog.error("worker_start_failed", {
        err,
        ...(err instanceof WorkerConfigError ? { configVar: err.configVar } : {}),
      });
      flushExit(1);
    }
  })();
}

// CLI bootstrap. It runs SUPERVISED: a lock-held start stands by with backoff and
// serves health 200 instead of exiting, so a rolling deploy cannot crash-loop the
// new instance. The dynamic import inside keeps supervisor.ts → index.ts a one-way
// dependency.
if (isCliEntry(import.meta.url)) {
  void runWorkerCli();
}
