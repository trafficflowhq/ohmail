import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  pruneIdempotencyKeys, pruneSendFingerprints, noticeSinkFor, setNoticeSink, accounts, accountSettings, mailboxCredentials, mailboxes,
  messages, folderState, junkSweepCandidateWhere, closeStoodDownAppointments,
  RELEASED_ORGANIZER_SEND_SENTENCE, capabilitiesColumn, exportPendingMovesOnStandDown,
  UNMETERED, isMetered, AccountErasedError, type EntitlementsComposition,
  type StandDownExport,
} from "@trafficflow/db";
import {
  makeEntitlementsClient, refundObligationsOn, makeOwnedDb, makeChangeWakeHub, type OwnedDb, type ChangeWakeFanout,
  entitlementsFaultRecorder, alertReadersOf,
  markScreenerSuggestOwed, owedSuggestAccounts, clearScreenerSuggestOwed,
  pruneErasedBearers, pruneErasedNotices, pruneAuthThrottle, plantReopenedCatchUp, dropUntoldCatchUps } from "@trafficflow/db/cloud";
import {
  runAlertPass, firingToLog, planeOpsStateLine,
  webhookAlertSink,
  resendAlertSink,
  telegramAlertSink,
  sinkHealthOf, pagerVerdictOf, type PagerVerdict,
  newDeliveryStreak,
  newLastResortState, lastResortFailed, lastResortSucceeded, lastResortLogLines,
  alertHeartbeatFor, heartbeatLogLine, type LastResortReport, type HeartbeatLogMemory,
  claimHeartbeat,
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
  reconcileStagingOrphansFor, StagingListingUnsupportedError, ENTITLEMENTS_CALL_BUDGET_MS,
  type AlertSink,
  type AlertSinkHealth,
  type AttachmentStagingStorage,
} from "@trafficflow/db/cloud";
import {
  createLogger, silentLogger, resolveOhboxPolicy, resolveScreeningCutoff, DEFAULT_OHBOX_POLICY, type Logger,
  providerAuthservIds,
  MicrosoftTokenProvider, type OAuthTokenProvider, type UpdateSecretPort, type FetchLike,
  type MicrosoftClientCredentials, type MicrosoftClientKind,
  type ClassifierPort,
} from "@trafficflow/core";
import { agreeSweepRun, makeDrizzleRepo, mailboxProviderAuthservIds, recordSpecialFolders, storedFoldersOf, type AgreeSweepCursor } from "@trafficflow/core/adapters/drizzle-repo";
import { makeSignatureCheck } from "@trafficflow/core/adapters/dkim";
import { makeDnsDkimKeys } from "@trafficflow/core/adapters/dkim-keys";
import {
  ImapAdapter, ImapConnectionClosedError, WORKER_NET_TIMEOUTS, WriteDeclinedError, learnSmtpMaxSize,
  isImapBoundExceeded,
  type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import {
  aiProviderLine, loadConfig, keyProviderFromKekEnv, selectionOf, instanceIdFrom, WorkerConfigError,
  DEFAULT_MAX_MAILBOXES, DEFAULT_SHARDS, DEFAULT_ROSTER_INTERVAL_MS,
  DEFAULT_LOCK_HEARTBEAT_MS, LOCK_UNPROVEN_HEARTBEATS, DEFAULT_MAILBOX_RETRY_MS, DEFAULT_MAX_SYNC_FAILURES,
  DEFAULT_ALERT_INTERVAL_MS, DEFAULT_SYNC_BLOCK_GRACE_MS,
  DEFAULT_LEASE_UNAVAILABLE_DETACH_MS, resolveCycleLanes, CYCLE_FAST_LANES, CYCLE_WAKE_REVISITS,
  resolveTailTurn, TAIL_SLICE_BUDGET_MS, resolveAttachConcurrency, ATTACH_DEADLINE_MS,
  resolveHeavyTurnMs, resolveSharedAccountTurnMs, nextTurnMessages, TURN_START_MESSAGES,
  type WorkerConfig,
} from "./config.js";
import {
  AttachAbortedError, AttachDeadlineError, AttachPool, hostKeyOf, type AttachTicket,
} from "./attach-pool.js";
import { TAIL_SECTION_PLAN, type TailSectionName } from "./cycle-tail-plan.js";
import { profileProducerVersion } from "./build-version.js";
import {
  anyDegradedCause, type DegradedCauses, type UnservedBreakdown,
} from "./health.js";
import { acquireLeaderLock, leaderLockKeyFor, LockLostError, type LeaderLock } from "./leader-lock.js";
import { startApiCron, type ApiCronHandle, type ApiCronTargetHealth } from "./api-cron.js";
import { apiClocksLead } from "./api-clocks-lead.js";
import { startPlatformSignalPoll, type PlatformSignalPollHandle } from "./platform-signal-poll.js";
import { newCycleCensus, runSyncCycle, LeaderFencedError, refusalIsRemoval, UNLABELLED_BUILD, type SyncDeps } from "./sync.js";
import {
  applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests, shrinkMetaOnRefusal,
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
export const JUNK_SWEEP_PER_CYCLE = 200;
import { makeStorageCapResolver } from "./storage-cap.js";
import { breachSetAside, DatabaseFaultError, DeadLetterLedger, isDatabaseFault, isSharedDatabaseFault } from "./dead-letter.js";
import { KnownSetCache } from "./known-set.js";
import { checkedDial, dialHostGuardFromEnv } from "./dial-host-guard.js";
import { markDatabaseFaults, asDatabaseFault } from "./db-fault.js";
import { tailStageRunner } from "./tail-stage.js";
import { runKickstart } from "./kickstart.js";
import {
  runThreadBackfill, THREAD_BACKFILL_SLICE_MS, THREAD_BACKFILL_SLICE_PAGES,
} from "./thread-backfill.js";
import { makeClassifierCircuit, ClassifierFaultError, type ClassifierCircuit } from "./ai-circuit.js";
import { attributedIngestClassifier, attributedWorkflowDrafter, makeAiUsageBuffer } from "./ai-usage.js";
import { workflowDrainPass, workflowTimeScanPass, unconfiguredDrafter } from "./workflow-cron.js";
import { bubbleUpPass } from "./bubble-up-cron.js";
import { threadJoinHealPass } from "./thread-join-heal.js";
import { makeThreadJoinHealWalk } from "./thread-join-heal-walk.js";
import { inboundQuietPass } from "./inbound-quiet.js";
import { makeAwayReplySweep } from "./away-reply-sweep.js";
import { ruleRetroPass } from "./rule-retro.js";
import { gapCatchupPass, gapOpenStart, NO_FOLDER_READ, type TravelledGap } from "./gap-catchup.js";
import { dialect } from "@trafficflow/db/dialect";
import { gateReleasePass } from "./gate-release.js";
import { senderCheckRetirement } from "./sender-check-backfill.js";
import { listAddressBackfillPass } from "./list-address-backfill.js";
import { apiFaultPrunePass } from "./api-fault-prune.js";
import { alertGapPrunePass } from "./alert-gap-prune.js";
import { alertDrillPass } from "./alert-drill-pass.js";
import { retentionPrunePass, signInRetentionPass } from "./retention-prune.js";
import { ohboxTidyPass } from "./ohbox-tidy.js";
import { screenerActConsentFrom, screenerAutoActPass } from "./screener-auto-act.js";
import { screenerImpersonationPass, type ImpersonationWalk } from "./screener-impersonation.js";
import { retireActAdmissionsPass } from "./act-admission-retire.js";
import {
  CORRESPONDENT_RETRO_EVERY_MS, screenerCorrespondentRetroPass,
} from "./screener-correspondent-retro.js";
import { screenerAutoSuggestPass } from "./screener-auto-suggest.js";
import { refundObligationDrainPass } from "./refund-obligation-drain.js";
import { mailboxErasurePass } from "./mailbox-erasure-pass.js";
import { SYNC_KICK_SIGNAL_GAP_MS, startSyncKickBell, syncKickPass, type SyncKickBell } from "./sync-kick.js";
import { calendarSection, type CalendarRunner } from "./start/calendar.js";
import { sensitiveBackfillPass } from "./sensitive-backfill.js";
import { SEARCH_INDEX_ACCOUNTS_PER_TAIL, searchIndexBackfillPass, searchIndexOwedAccounts } from "@trafficflow/core/mail";
import { HTML_WORDS_ACCOUNTS_PER_TAIL, htmlWordsBackfillPass, htmlWordsOwedAccounts } from "./html-words-backfill.js";
import { goneLetterTidyAccounts, goneLetterTidyPass } from "./gone-letter-tidy.js";
import { storageEvictPass } from "./storage-evict.js";
import { storageStatsPass } from "./storage-stats.js";
import { isCliEntry, flushExit, installCrashHandlers } from "./entry.js";
import {
  startPushWake, pushEndpointGuardFromEnv, vapidFromEnv, type RunningPushWake,
} from "./push-wake.js";
import { driverWriteRaceReason } from "./driver-write-race.js";
import { makeSmtpSizeDial, recordSmtpMaxSize } from "./smtp-size.js";
import type { LedgerTx, Tx, OrganizerRole, OrganizerState } from "@trafficflow/db";
import {
  loadEnabledMailboxes, loadRosterMailboxes, loadMailboxCreds, loadMailboxById, bootstrapEnvCreds, BootstrapRefusedError,
  markMailboxFailed, markMailboxReadLimited, markMailboxProviderUnavailable, markMailboxConnected,
  markMailboxStoodDown, stampSyncProgress,
  clearOrganizerStandDown,
  markMailboxReleased, readTravellingGapSince, refreshOrganizerHolder, resumeParkedMailbox, deleteParkedPushRows,
  markOrganizedThrough, markMailboxSyncBlocked, clearMailboxSyncBlock,
  classifyMailboxError, isProviderRefusal, mailboxErrorDetail,
  stampMailboxSyncNow, stampInitialImportComplete, stampImportProgress, makeSyncWriteFence, type LeaderFence,
  accountsOf, organizedMailboxIdsOf, accountInShard, accountShardFilter, shardFilter, loadAttachHosts,
  type EnabledMailbox, type MailboxDisabledReason, type MailboxErrorPhase,
  type MailboxSyncBlockReason, type ParkedAccountsReader,
} from "./mailboxes.js";
import { OrganizerProfileSync, readNewestSettings, sweepHeld, syncProfileMirror, type SweepClearance } from "./profile.js";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import {
  readMailboxLease, acquireLeasePermit, releaseMailboxClaim, cloudInstallId, CLOUD_DISPLAY_NAME,
  LeaseUnavailableError, leaseBlockReason, leaseStoodDown, DEFAULT_STALE_AFTER_MS, writeDoorOf,
  cycleWriteAuthority, OrganizerStandDownError,
  type OrganizerWriteAuthority,
  type LeaseSelf, type LeasePeekCapableAdapter,
} from "./lease.js";
// The APPEND-less read of `ohmail/_meta` — see `LeasePeekCapableAdapter`. A reader LOOKS at the
// lease every cycle to keep `organizer_state` and the holder columns honest, and looking must
// never write a claim: `readLeasePeek` takes the read-only IO and creates nothing.
import {
  readLeasePeek, answerLeasePeek, deriveRequestKey, makeClockCorrectionWatch, resumesOwnClaim, withMinted,
  type OrganizerIntent,
} from "@trafficflow/core/adapters/organizer-lease";
import { maintenanceGate } from "./maintenance-gate.js";
import type { SyncBlock, TailWalk, WorkerScope } from "./start/scope.js";
import { faultsSection } from "./start/faults.js";
import { queueSection } from "./start/queue.js";
import { leaseGateSection } from "./start/lease-gate.js";
import { quarantineSection } from "./start/quarantine.js";
import { attachSection } from "./start/attach.js";
import { rosterSection } from "./start/roster.js";
import { cycleSection } from "./start/cycle.js";
import { cycleTailSection } from "./start/cycle-tail.js";
import { heartbeatSection } from "./start/heartbeat.js";

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
 * Each account's heal time per walk, summed over its slices, and NOT CONFIGURABLE for the reason above.
 * Ten slice clocks: when one slice covers a group or two, the group budget alone kept an account owed
 * for hundreds of tails, so the gate never shut and every tail paid for a walk that merged nothing.
 */
export const THREAD_JOIN_HEAL_WALK_MS = 10 * TAIL_SLICE_BUDGET_MS;

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
 *
 * THE FLOOR, since the scan also runs when the change log signals (`startSyncKickBell`): what a lost
 * signal, or a stamp written with none, waits at most. Measured on the managed service on 2026-11-14:
 * two statements on `mailboxes`, 9,931 calls each in eight hours. It stays 3 s while writers of the
 * stamp exist that send no signal in their commit, and while the gaps written against it stand
 * (`FILING_DOORBELL_MIN_GAP_MS` in `packages/db/src/filing-doorbell.ts`, the mailbox service's pull).
 */
export const SYNC_KICK_EVERY_MS = 3_000;

/**
 * The suggest-owed mark writer's per-account pacing (cloud 0039) — how often one account's held
 * ingests may write the durable mark. Thirty seconds, half the poll interval: a first import
 * holding hundreds of senders costs a handful of upserts instead of one per message, while an
 * account quiet for a cycle always gets its mark through. A paced-away write is covered by the
 * in-process hint (same cycle) and by the cycle itself (the backstop), so this is a cost dial,
 * never a correctness one. A `const` for {@link SYNC_KICK_EVERY_MS}'s reason.
 */
export const SUGGEST_OWED_MARK_GAP_MS = 30_000;

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
   * Up to when the cycle is known to have MOVED: the later of the last rotation that ended and the
   * last mailbox turn that returned, whatever their outcome, and never later than the start of the
   * oldest turn still running. Null before the first. What `/health`'s stuck rule measures, and it
   * is about movement, not success: a turn that fails has returned (a mailbox that keeps failing is
   * quarantined, and a restart mends no password), a rotation is one turn per mailbox and may run
   * long while its turns keep ending, and one turn that never returns holds the clock back however
   * many others end beside it.
   */
  cycleProgressAt: Date | null;
  /** The last rotation's wall clock, and the last completed tail walk's work time (ms). */
  lastRotationMs: number | null;
  lastTailMs: number | null;
  /** Where a tail walk in progress is — section name, account INDEX and count; null between walks. */
  tail: { section: string; account: number; of: number } | null;
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
  /** `pagerVerdictOf(alertSinks)`: `dead` is every arm refusing, `unarmed` no arm at all. */
  pager: PagerVerdict;
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
  /**
   * WHETHER THE PARKED-ACCOUNTS READER IS COMPOSED (mail 0124, the wall). `absent` is a host
   * with no `config.entitlements` — the self-host truth, where nobody parks. On the managed
   * deployment `absent` is the dangerous branch (a refused account keeps syncing while its
   * owner meets the 402), so the Cloud deploy gate asserts `composed` off this field.
   */
  parkedReader: "composed" | "absent";
}

export interface RunningWorker {
  stop(): Promise<void>;
  stats(): WorkerStats;
}

export interface WorkerHooks {
  /**
   * The advisory lock is provably gone (session dropped / another backend owns it). The
   * worker has ALREADY quiesced — every mailbox detached, every timer cleared — so this is
   * purely the signal for the supervisor to stop advertising leadership, close this worker
   * (`stop()`) and start over as a waiting start.
   */
  onLockLost?: (err: LockLostError) => void;
  }

/** A mailbox that connected successfully and is now part of the sync rotation. */
export interface MailboxRuntime {
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
  /**
   * The cycle's deps AS THE ATTACH BUILT THEM — everything whose lifetime is the attachment. The
   * PERMIT is not among them and the type says so: it is `rt.leasePermit`, written by the gate at
   * every cycle, and an attach-time copy of it would be a receipt from before the last handover.
   */
  deps: Omit<SyncDeps, "writeAuthority">;
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
   * EVERY NONCE THIS PROCESS MINTED FOR THIS MAILBOX — beside {@link leaseNonce}, in memory and per
   * mailbox for the same two reasons, replaced through `withMinted` and never cleared by an answer.
   *
   * A renewal that COMMITS and loses its response leaves the folder carrying a claim this worker
   * wrote and was never told about; with only the acknowledged nonce remembered, the next gate read
   * it as a restored clone and stood the running worker down over its own write. `LeaseSelf`
   * carries the rule; this is where the worker keeps its half.
   */
  leaseMintedNonces: readonly string[];
  /**
   * HOW MANY CLOCK CORRECTIONS THIS MAILBOX HAS ALREADY ACTED ON — latched per mailbox against the
   * process-wide watch, because a correction is a fact about the MACHINE and every mailbox it
   * organizes needs the one renewal it licenses. See `makeClockCorrectionWatch`.
   */
  seenClockCorrections: number;
  /**
   * WHAT THIS MAILBOX'S WRITES RIDE ON — the permit the last gate took, or the named reason there
   * is none. Written by `mayOrganize` on both arms and handed to `runSyncCycle`, so every
   * destructive write inside the cycle asks the lease again instead of resting on the cycle's
   * opening read.
   */
  leasePermit: OrganizerWriteAuthority;
  /**
   * The stamp the last promotion spent, read once by the visit that promoted (`mayOrganize`
   * writes it); that visit starts {@link agreeSweep} from it.
   */
  agreeStamp?: Date | null;
  /** The server's stamp on the claim this cycle's gate wrote (`organized_through` when the cycle finishes). */
  claimServerAt?: Date | null;
  /**
   * The agree's sweep in progress: each organizing visit runs it (`agreeSweepRun`) until its cursor
   * is null; any other verdict, a throw or a demotion clears it. Memory only: a crash mid-sweep
   * leaves the rest to the Screener's offer.
   */
  agreeSweep?: { stamp: Date; cursor: AgreeSweepCursor | null } | null;
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
    /**
     * Mail 0088. THE PERSON'S STOP, RECORDED — the term that keeps a released mailbox from resuming
     * on its own (`resumesOwnClaim`). Set by the release write, cleared by a promotion.
     */
    organizerReleasedAt: Date | null;
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
    /** What this reader last wrote of the gap window (`gap_since`): open, closed, or unknown. */
    gapOpen?: boolean;
    /** When this reader last looked (epoch ms): a look after a quiet stretch writes the window again. */
    lastLookAt?: number;
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
  /**
   * `Date.now()` when this mailbox's last visit ENDED, or `null` before its first. A mailbox
   * with no unserved wake is due its poll again once `pollIntervalMs` has passed since then, and may take a
   * turn inside a pass that a long lane is holding open; see `admitDue` in `cycle()`.
   */
  lastVisitEndedAt: number | null;
  /**
   * How many message bodies this mailbox's next turn may fetch, steered toward `heavyTurnMs` by
   * `nextTurnMessages` after every completed turn. In memory only: a fresh attach starts small, so a
   * backlog turn after a restart cannot hold the first pass for a full batch.
   */
  turnMessages: number;
  /**
   * Its last completed turn owed a backlog and ran at least half the lone target (`heavyTurnMs`),
   * whatever its own: an import's turn, not a burst drained in seconds. Only such a mailbox takes one
   * turn a pass, leads the pass, and makes a kick serve the others while it runs; FALSE at attach, like `owesBacklog`.
   */
  longTurns: boolean;
}

/** A detached mailbox waiting out its exponential retry backoff. */
export interface Quarantine {
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
  /** Each organized mailbox's last settings clearance, as data for the gap pass (which opens no IMAP). */
  const gapClearances = new Map<string, SweepClearance>();
  const scope = {} as WorkerScope;
  /** The attaches in flight, for the same reason: the startup catch must stop and await them. */
  scope.attachPoolRef = null as AttachPool | null;
  /** The same, for the timers: the startup catch must be able to disarm them (see below). */
  scope.stopTimers = null as (() => void) | null;

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
    const msRegistration = async (want: MicrosoftClientKind): Promise<MicrosoftClientCredentials> => {
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
    };
    const oauthTokenProvider: OAuthTokenProvider = new MicrosoftTokenProvider({
      clientId: config.msOAuth?.clientId ?? "",
      clientSecret: config.msOAuth?.clientSecret ?? "",
      defaultTenant: config.msOAuth?.tenant ?? "common",
      // The calendar's Microsoft trade asks the same resolver (`scope.msRegistration`): one reader of the registration.
      resolveClient: msRegistration,
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
    // Both reads name the database as their origin, as the roster read does (`loadRosterMailboxes`):
    // a start that meets a refused or reset dial here waits for the database (`supervisor.ts`).
    if (config.mailboxId && config.imap) {
      const envMailboxId = config.mailboxId;
      const row = await asDatabaseFault("boot.envMailbox", () => loadMailboxById(db, envMailboxId));
      if (!row) throw new Error(`TF_MAILBOX_ID ${config.mailboxId} does not exist`);
      if (config.accountId && row.accountId !== config.accountId) {
        throw new Error(
          `TF_ACCOUNT_ID ${config.accountId} does not own TF_MAILBOX_ID ${config.mailboxId} ` +
          `(it belongs to account ${row.accountId}); refusing to bootstrap credentials`,
        );
      }
      const envCreds = { mailboxId: envMailboxId, imap: config.imap, smtp: config.smtp };
      try {
        await asDatabaseFault("boot.envCreds", () => bootstrapEnvCreds(db, keyProvider, envCreds));
      } catch (err) {
        // A REFUSAL IS NOT A FAULT, AND IT IS NOT SILENT EITHER. The mailbox this deployment is
        // configured for has been removed, or its account erased; recreating its sealed
        // credentials is the one thing a restart must not do, and taking the whole worker down
        // over it would stop every other mailbox this process serves. So: one named line, and
        // the run continues with the removal standing.
        const refusal = err instanceof DatabaseFaultError ? err.cause : err;
        if (!(refusal instanceof BootstrapRefusedError) && !(refusal instanceof AccountErasedError)) throw err;
        (config.logger ?? silentLogger).warn("env_creds_bootstrap_refused", {
          mailboxId: config.mailboxId,
          reason: refusal instanceof BootstrapRefusedError
            ? "this mailbox has been removed; its credentials were deleted with it and env will "
              + "not put them back"
            : "this mailbox's account has been erased; nothing may be written against it",
        });
      }
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
    /** The length a turn's message limit is steered toward (`MailboxRuntime.turnMessages`); half of it is a long turn. */
    const heavyTurnMs = resolveHeavyTurnMs(config.heavyTurnMs);
    const sharedAccountTurnMs = resolveSharedAccountTurnMs(config.sharedAccountTurnMs, heavyTurnMs);
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
      ?? ((cfg, ctx) => new ImapAdapter(cfg, {
        onConnectionError: ctx.onConnectionError,
        log: (event, detail) => { log.info(event, { ...detail, mailboxId: ctx.mailboxId, accountId: ctx.accountId }); },
      }));
    /**
     * THIS DEPLOYMENT'S POLICY ON THE HOSTS IT MAY DIAL, decided once, here, for every attach
     * below. `loadConfig` supplies it for the deployed process; a programmatic caller that
     * supplied none gets the ENVIRONMENT's answer rather than a silent dial by name, which is
     * the same input read the same way — absent enforces, `TF_PROBE_ALLOW_PRIVATE=1` admits.
     */
    const dialHostGuard = config.dialHostGuard ?? dialHostGuardFromEnv();

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
     * THIS TAKEOVER'S NAME in `worker_heartbeats`: the instance id and eight hex of its own. The row
     * is renewed, surrendered and the write fence passed BY NAME, so the name has to be one takeover's
     * and nobody else's. `instanceId` alone is a host's (a replica id, else the hostname): two workers
     * on one host would renew, and write mail, on each other's claim.
     */
    const leaderToken = `${instanceId}:${randomUUID().slice(0, 8)}`;
    /**
     * The leader epoch, as the two mailbox lifecycle writes see it. `worker_heartbeats` is already
     * the durable, atomically-claimed record of "who leads shard N" — the takeover's claim overwrites
     * `instance_id` (`claimHeartbeat`, once, and only while the database shows the lock held), and
     * every later beat renews that row or finds it gone (`refreshHeartbeat`), against exactly this
     * predicate. Passing it into `markMailboxFailed`/`markMailboxConnected`
     * fences those writes with the SAME definition, and `clearHeartbeat` takes it so a surrender
     * cannot clobber a successor's claim. The first beat is written before any attach, so the row
     * exists by the time either write fires; a failed beat closes the fence and the write is refused
     * and LOGGED (`mailbox_failure_write_fenced`) rather than landing unfenced — the safe direction.
     */
    const fence: LeaderFence = { shardIndex, instanceId: leaderToken };
    const alertIntervalMs = config.alertIntervalMs ?? DEFAULT_ALERT_INTERVAL_MS;
    const alertSinks: AlertSink[] = [];
    const hook = webhookAlertSink(config.alertWebhookUrl, config.alertPost);
    if (hook) alertSinks.push(hook);
    // The MAIL arm — the product's own transactional mailer, added when the webhook arm's
    // endpoint turned out to blackhole this host's egress (see `alert-mail.ts` for the
    // measurement). Both arms share the injected `alertPost` seam, so no test opens a socket.
    const mailArm = resendAlertSink(
      {
        apiKey: config.resendApiKey, from: config.mailFrom, to: config.alertEmail,
        consoleUrl: config.adminUrl,
      },
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
     * three minutes of escalation latency. The alarms built on it are rows: a fresh streak is no
     * evidence, so `alert_sink_degraded` is withheld rather than resolved until an arm delivers,
     * and `alert_driver_undeliverable` reads the streak `recordAlertPass` keeps in the database.
     */
    const alertDeliveryStreak = newDeliveryStreak();
    /**
     * The last-resort page when the pass cannot use the database (`alert-last-resort.ts`): memory
     * only, for this leadership's life. These arms already avoid the database, so they are reused.
     */
    const alertLastResort = newLastResortState();
    /** `TF_ALERT_HEARTBEAT_URL`: the dead-man GET after every completed pass. */
    const alertHeartbeat = alertHeartbeatFor(config.alertHeartbeatUrl, config.alertHeartbeatGet);
    const alertHeartbeatLogged: HeartbeatLogMemory = { last: null };

    scope.stopped = false;
    scope.lockLost = false;
    scope.lastCycleAt = null as Date | null;
    /** When a rotation and a mailbox's turn last ended, and when each turn still running began (`cycleProgressAt`). */
    scope.lastRotationEndAt = null as number | null;
    scope.lastTurnEndAt = null as number | null;
    const visitStarts = new Map<string, number>();
    /** The last rotation's and the last completed tail's wall clock, for `/health` and `cycle_phases`. */
    scope.lastRotationMs = null as number | null;
    /** How many due turns (`admitDue`) the last rotation gave, for `cycle_phases`. */
    scope.lastDueRevisits = 0;
    scope.lastTailMs = null as number | null;
    scope.dutyAccounts = [] as string[];
    /* THE ROSTER ROWS BEHIND `dutyAccounts`, kept because a per-account pass that writes mail state
       needs to know WHICH MAILBOXES of that account this process organizes — an account id cannot
       say. Written in the same statement as `dutyAccounts`, so the two never disagree. */
    scope.dutyMailboxes = [] as readonly EnabledMailbox[];
    // Time-gate for the global maintenance pass; starts "due" so a fresh leader sweeps once.
    const maintenanceDue = maintenanceGate(MAINTENANCE_EVERY_MS);
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
     * `maintenanceDue` does, and here it matters more: a message whose `bubble_up_at` fell
     * due while the previous leader was being replaced must resurface on the new leader's FIRST
     * cycle, not one {@link BUBBLE_UP_EVERY_MS} after the takeover.
     */
    scope.lastBubbleUpAt = 0;
    /** When each served account last had its correspondent retro — due at a new leader's first cycle. */
    const correspondentRetroAt = new Map<string, number>();
    /** The act's past admissions retired, per account, once per process: where each walk stands. */
    const actAdmissionsRetired = new Set<string>();
    const actAdmissionCursor = new Map<string, string>();
    /** The accounts whose gone letters a tidy found clean, for this process's life. */
    const goneLettersTidied = new Set<string>();
    /**
     * The thread-join heal's gate and resume points. Starts "due" like `lastBubbleUpAt`, and here
     * the reason is survival rather than latency: a deployment cadence shorter than
     * {@link THREAD_JOIN_HEAL_EVERY_MS} would otherwise mean the pass NEVER runs — a
     * scheduled pass that no schedule ever reaches, which this repo has paid for before. Each
     * slice runs under the tail's slice clock; a cut account stays owed and keeps the gate open
     * for the next tail walks until it finishes or spends {@link THREAD_JOIN_HEAL_WALK_MS}. In memory:
     * a leader handover starts from the top.
     */
    const joinHealWalk = makeThreadJoinHealWalk(THREAD_JOIN_HEAL_EVERY_MS, THREAD_JOIN_HEAL_WALK_MS);
    /**
     * Time-gate for the inbound-quiet pass. Starts "due" like the thread-join heal and for
     * its exact reason: a deployment cadence shorter than {@link INBOUND_QUIET_EVERY_MS} would
     * otherwise mean the forwarding-detection heuristic NEVER runs. The first-cycle cost is one
     * bounded grouped aggregate per served account.
     */
    scope.lastInboundQuietAt = 0;
    /**
     * The per-process sweep. It owns the gate AND every account's resume point, so an attempt that
     * could not finish is continued rather than restarted — see its own docblock for why that used
     * to be two locals here and why review was right to call that untestable.
     */
    const awayReplySweep = makeAwayReplySweep();
    /** Starts DUE. Only paces the RETRY; the gate is the sweep's. */
    scope.lastAwayReplySweepAt = 0;
    /**
     * ACCOUNTS WHOSE INGEST HELD A SENDER THIS PROCESS'S CYCLE HAS NOT VISITED YET — the
     * in-process half of the suggest-owed mark (cloud 0039). The DURABLE half is the table; this
     * set is what makes the mark visible to the SAME cycle that ingested the hold (the writer is
     * fire-and-forget, so its commit can land after the owed read). Consumed by the owed-first
     * serve; a crash loses only the hint, never the row.
     */
    const suggestOwedHints = new Set<string>();
    /**
     * ACCOUNTS THE IMPERSONATION PASS OWES NOTHING, in this process, with the mailboxes its last run
     * went over: that run read the switch on, ended uncut and failed nowhere. Anything else is owed — an
     * account not yet visited, one ingest held a sender for since (`noteScreenerHold` removes it), one
     * whose switch read off, so the next tail sees it turned on, and one whose mailboxes' settings
     * questions opened or closed since.
     */
    const impersonationSettled = new Map<string, string>();
    /** Each account's walk of its waiting senders, kept between tails. */
    const impersonationWalks = new Map<string, ImpersonationWalk>();
    /**
     * The mark writer's per-account pacing — one durable upsert per account per
     * {@link SUGGEST_OWED_MARK_GAP_MS}, so a first import holding hundreds of senders costs a
     * handful of writes rather than one per message. A paced-away write is covered twice over:
     * the hint above reaches this cycle, and the 60 s cycle serves every account regardless.
     */
    const suggestOwedMarkedAt = new Map<string, number>();
    /**
     * Told by ingest that it HELD a first-contact sender ({@link SyncDeps.onScreenerHold}).
     * Fire-and-forget by design — the cycle is the backstop for a lost mark — and it may never
     * throw into the sync cycle, so the write's failure is one log line. Gated on the opt-in
     * INSIDE the statement (`markScreenerSuggestOwed` reads `auto_suggest_at` in the same
     * INSERT … SELECT), so an opted-out account costs one indexed read and gains no row.
     */
    const noteScreenerHold = (accountId: string): void => {
      suggestOwedHints.add(accountId);
      impersonationSettled.delete(accountId);
      const last = suggestOwedMarkedAt.get(accountId) ?? 0;
      if (Date.now() - last < SUGGEST_OWED_MARK_GAP_MS) return;
      suggestOwedMarkedAt.set(accountId, Date.now());
      void markScreenerSuggestOwed(db as unknown as Tx, accountId).catch((err: unknown) => {
        log.warn("screener_suggest_owed_mark_failed", {
          accountId, err,
          reason: "the durable suggest-owed mark could not be written; the in-process hint " +
            "still serves this cycle and the 60 s cycle remains the backstop — latency, not loss",
        });
      });
    };
    /**
     * One-shot: the boot announcement and its heartbeat happen on the FIRST roster pass only.
     * Declared HERE with the rest of the closure state rather than beside `cycleQueued` — a
     * `let` in temporal dead zone throws if `reconcileRoster` is ever called earlier than its
     * declaration, and "safe because of current call order" is not a property worth relying on.
     */
    scope.booted = false;
    /** The boot beat, which fires once the first roster pass knows what the duty IS. */
    scope.firstBeatPending = true;
    /**
     * This takeover's claim of the heartbeat row has landed (`beat`). Kept by the beat itself and not by
     * the boot beat's place above: which beat comes first is call order, and a claim must not rest on it.
     */
    scope.claimed = false;
    scope.expected = 0;
    scope.truncated = 0;
    scope.dutyGap = false;
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
    scope.servedIds = [] as readonly string[];
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
    scope.dbFaultSince = null as number | null;
    /** Database faults observed in the CURRENT run. Reported once at the end, not once each. */
    scope.dbFaults = 0;
    const quarantine = new Map<string, Quarantine>();
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
     * is what makes `reconcileSyncBlocks` clear the row on the next healthy pass, the other arms'
     * mechanism. It holds `provider_unavailable` too (mail 0130), cleared by the same evidence.
     */
    const readLimited = new Map<string, SyncBlock>();
    /**
     * Mailboxes of PARKED accounts (mail 0124, the wall) — the fifth arm. At closure scope for
     * `capDropped`'s reason: the parked set is recomputed from the reader every pass, and a map
     * rebuilt with it would restart `since` each time. Entries leave the moment the account reads
     * open again, and `reconcileSyncBlocks`'s clear arm erases the row's reason the same pass.
     */
    const parkedBlocked = new Map<string, SyncBlock>();
    /**
     * Parked accounts whose untold catch-ups this leader has already dropped for the current
     * closure. An account leaves it when it reads open again; a failed drop keeps it out, so the
     * next pass tries again, and a new leader drops once for every account it reads parked. Kept
     * per closure so a parked account costs one statement, not one per pass.
     */
    const closureDropped = new Set<string>();
    Object.assign(scope, {
      config, lock, db, runtimes, gapClearances, repo, keyProvider, oauthTokenProvider, msRegistration, shards, shardIndex,
      maxMailboxes, cycleLanes, heavyLanes, heavyTurnMs, sharedAccountTurnMs, rosterIntervalMs, retryBaseMs,
      retryMaxMs, maxSyncFailures, syncBlockGraceMs, leaseUnavailableDetachMs, selection, makeAdapter, dialHostGuard,
      environment, startedAt, log, leaderToken, fence, alertSinks, alertDeliveryStreak, alertLastResort,
      alertHeartbeat, alertHeartbeatLogged, visitStarts, maintenanceDue, stagingStorage, correspondentRetroAt,
      actAdmissionsRetired, actAdmissionCursor, goneLettersTidied, joinHealWalk, awayReplySweep, suggestOwedHints,
      impersonationSettled, impersonationWalks, noteScreenerHold, quarantine, awaitingCreds, leaseBlocked,
      capDropped, readLimited, parkedBlocked, closureDropped, aiFor, screeningFor, kickCycle, handleLockLoss,
    } satisfies Partial<WorkerScope>);
    faultsSection(scope);

    queueSection(scope);

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
    // Each failed call is a warn line and an `api_faults` row (arm `worker`, one per path per
    // minute). NOT awaited: this client answers the per-mailbox path, which must not wait on a write.
    const recordEntitlementsFault = entitlementsFaultRecorder(() => db as unknown as Tx, "worker", { log });
    const entitlements: EntitlementsComposition = config.entitlements
      ? makeEntitlementsClient({
        baseUrl: config.entitlements.url, secret: config.entitlements.secret,
        ...(config.entitlements.accessTtlMs !== undefined ? { ttlMs: config.entitlements.accessTtlMs } : {}),
        onCallFault: (f) => { void recordEntitlementsFault(f); },
      })
      : UNMETERED;
    /** The spend half the call sites take — `undefined` where nothing meters. */
    const spend = isMetered(entitlements) ? entitlements : undefined;
    /**
     * WHERE A SPEND THAT BOUGHT NOTHING IS REMEMBERED (cloud 0036) — composed on exactly the
     * condition `spend` is, because the two are halves of one fact: a host that can charge can
     * lose a refund, and a host that cannot charge owes nothing. Derived from `spend` rather than
     * from `config` a second time, so the pair cannot drift
     * (`refund-obligation-composition.test.ts`).
     */
    const obligations = spend ? refundObligationsOn(db as unknown as Tx) : undefined;
    /**
     * WHERE A MODEL CALL'S USAGE GOES, composed on `spend`'s condition: ingest classification and
     * workflow steps into a bounded buffer the entitlements port takes every 30 s (and twice in
     * `stop()`), the Screener's and the proposer's on their own releases. Armed here, so a
     * metered call no hook attributed is warned about; an unmetered host records nothing.
     */
    const usageRelay = spend ? config.aiUsage : undefined;
    const recordUsage = isMetered(entitlements) ? entitlements.recordUsage?.bind(entitlements) : undefined;
    const usageBuffer = usageRelay && recordUsage
      ? makeAiUsageBuffer({ port: { recordUsage }, log, budgetMs: ENTITLEMENTS_CALL_BUDGET_MS })
      : undefined;
    usageRelay?.arm();

    /**
     * WHICH ACCOUNTS ARE PARKED (mail 0124, the wall) — ONE reader for the roster AND the alert
     * pass, composed from the SAME client the spend sites take; `null` on a deployment that
     * meters nothing, the self-host truth: nobody parks. `ok: false ⇒ parked`; a fault answers
     * the verdict this process holds, else the rows' stored closure, else allow. The pass once
     * read no parked set and paged hourly about accounts this roster had parked
     * (`alert-pass-callers-name-parked`).
     */
    const alertReaders = alertReadersOf(entitlements);
    const parkedAccountsReader: ParkedAccountsReader | null = alertReaders.parkedAccounts;
    // The plane's own failures are deployment-wide facts: shard 0's leader reads them, one read a
    // minute whatever the shard count (the apiCron rule). Said once, so an operator sees the watch.
    log.info("plane_ops_watch", alertReaders.planeOps === null
      ? { state: "off", reason: "no ENTITLEMENTS_URL: this worker reads no billing plane" }
      : shardIndex === 0 ? { state: "on" }
      : { state: "off", shard: shardIndex, reason: "the plane is read by shard 0's leader alone" });

    // The LIVE classifier, behind a per-process circuit breaker. ONE circuit for the process, because
    // the failure domain is the shared API key and endpoint — per-mailbox circuits would each burn
    // their own faults into the same outage, and `cycle()` walks the rotation serially so one counter
    // converges fastest. `circuit.port()` is resolved PER CYCLE and never cached: while open it
    // answers `undefined`, `pipeline.ts`'s `classifier &&` short-circuits before the money question,
    // and the message files rules-only with no model call and no debit; holding a wrapper across the
    // open transition would charge every message and then fail it. Its usage is attributed per
    // mailbox's account in `aiFor`, as ingest, into `usageBuffer`. Absent when managed AI is not
    // armed: the rules-only deployment records and spends nothing.

    // Absent classifier ⇒ no circuit and today's behaviour exactly (rules-only routing).
    const classifierCircuit: ClassifierCircuit | undefined = config.classifier
      ? makeClassifierCircuit(config.classifier, { log })
      : undefined;
    /** The ingest classifier, its calls attributed to `accountId`, where usage is recorded. */
    function attributedIngest(port: ClassifierPort | undefined, accountId: string): ClassifierPort | undefined {
      return port && usageRelay && usageBuffer
        ? attributedIngestClassifier(port, accountId, usageRelay.hook, usageBuffer)
        : port;
    }
    /** The classifier + gate pair for one mailbox's cycle. */
    function aiFor(mailboxId: string, accountId: string): Pick<SyncDeps, "classifier" | "credits"> {
      if (!classifierCircuit) return { ...(spend ? { credits: spend } : {}) };
      return {
        // The SAME mailbox id both halves take: `meter` records this mailbox's charge and the
        // wrapper clears this mailbox's record on a success. Two different ids there, or one
        // omitted, is how a success for one mailbox forfeits another's refund.
        classifier: attributedIngest(classifierCircuit.port(mailboxId), accountId),
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
    const storageCapFor = makeStorageCapResolver(entitlements, db as unknown as Tx, log);
    /* ONE KEY LOOKUP FOR THE PROCESS: the sender-signature check where a mailbox's provider names no
       authserv-id (`pipeline.ts#signatureVerdict`). Its cache holds public DNS answers only. */
    const signatureCheck = makeSignatureCheck({ keys: makeDnsDkimKeys() });
    const SCREENING_TTL_MS = 30_000;
    type ScreeningDeps = Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff" | "signatures">;
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
          blockAutoUnsubscribeAt: accountSettings.blockAutoUnsubscribeAt,
        }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
        const cutoff = resolveScreeningCutoff(row?.baselineAt, row?.dormancyDays);
        const value: ScreeningDeps = {
          ohboxPolicy: resolveOhboxPolicy(row?.policy ?? null),
          ...(row?.bar ? { ohboxBar: row.bar } : {}),
          ...(cutoff ? { screeningCutoff: cutoff } : {}),
          // A one-click letter's sender is worth confirming while a screen-out may unsubscribe.
          signatures: { ...signatureCheck, listLetters: (row?.blockAutoUnsubscribeAt ?? null) === null },
        };
        screeningCache.set(accountId, { at: now, value });
        return value;
      } catch (err) {
        // Do NOT cache the fault: the next cycle re-reads, and until then we route LENIENT for the
        // posture and with NO CUTOFF for the gate — which is the strict direction for the gate —
        // and confirm one-click senders for no unsubscribe.
        log.warn("screening_pref_read_failed", { accountId, err });
        return { ohboxPolicy: DEFAULT_OHBOX_POLICY, signatures: { ...signatureCheck, listLetters: false } };
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
    Object.assign(scope, {
      spend, obligations, usageRelay, usageBuffer, alertReaders, parkedAccountsReader, classifierCircuit,
      storageCapFor, signatureCheck, organizerInstallId, organizerDisplayName, organizerStaleAfterMs,
    } satisfies Partial<WorkerScope>);
    leaseGateSection(scope);

    quarantineSection(scope);

    attachSection(scope);

    rosterSection(scope);

    cycleSection(scope);

    cycleTailSection(scope);

    heartbeatSection(scope);

    scope.cycleQueued = false;
    function kickCycle(): void {
      // Heard by a pass a long turn holds open, which serves the other mailboxes (`admitDue`).
      scope.lastKickAt = Date.now();
      scope.nudgeCycle();
      if (scope.stopped || scope.cycleQueued) return;
      scope.cycleQueued = true;
      void scope.serialize(async () => { scope.cycleQueued = false; await scope.cycle(); }).catch((err: unknown) => {
        // A DATABASE FAULT THAT ESCAPED THE ROTATION LOOP IS STILL THE SHARD-WIDE CONDITION.
        //
        // `cycle()` does more than walk mailboxes — its post-loop bookkeeping catches its own,
        // but this is the backstop, and without this line a fault that reached
        // it would be an `error` line and NOTHING ELSE: `/health` would keep answering
        // `degraded: false` about a worker that has stopped syncing. Recorded through the same
        // one-incident path, so it cannot double-announce an outage the loop already named.
        if (isSharedDatabaseFault(err)) scope.noteDatabaseFault(err);
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
    scope.verifyErrors = 0;
    scope.hbTimer = null as ReturnType<typeof setInterval> | null;
    scope.pollTimer = null as ReturnType<typeof setInterval> | null;
    scope.rosterTimer = null as ReturnType<typeof setInterval> | null;
    scope.alertTimer = null as ReturnType<typeof setInterval> | null;
    scope.syncKickBell = null as SyncKickBell | null;
    /**
     * The UnifiedPush wake sender and the LISTEN it feeds from. Not timers, but they belong to
     * `clearTimers` for the reason that function actually serves: it is "stop doing work NOW",
     * and it is what `handleLockLoss` and the startup-failure path both call. A deposed leader
     * that kept POSTing wakes would have a successor doing the same thing beside it — two wakes
     * per message, and a device that cannot tell which instance is authoritative. The hub's
     * `end()` is awaited nowhere here on purpose: it closes a socket, `clearTimers` is called
     * from synchronous paths, and a LISTEN left to the idle close is bounded.
     */
    scope.pushWake = null as RunningPushWake | null;
    scope.wakeHub = null as ChangeWakeFanout | null;
    /**
     * The API-cron scheduler (`api-cron.ts`). In `clearTimers` for the push-wake's exact
     * reason: a deposed leader that kept poking the reconcile route would overlap its
     * successor's pokes — the one concurrency the scheduler cannot guard from inside one
     * process — so "stop doing work NOW" must take it down with the rest.
     */
    scope.apiCron = null as ApiCronHandle | null;
    /** The 5xx poll (`platform-signal-poll.ts`): shard 0's leader only, stopped with the rest. */
    scope.signalPoll = null as PlatformSignalPollHandle | null;
    /** The calendar's passes: stopped with the rest, their turns awaited by the stop below. */
    scope.calendar = null as CalendarRunner | null;
    function clearTimers(): void {
      if (scope.pollTimer) clearInterval(scope.pollTimer);
      if (scope.rosterTimer) clearInterval(scope.rosterTimer);
      if (scope.alertTimer) clearInterval(scope.alertTimer);
      if (scope.hbTimer) clearInterval(scope.hbTimer);
      scope.pollTimer = scope.rosterTimer = scope.alertTimer = scope.hbTimer = null;
      // Before the hub it listens on: a deposed leader's bell rings nothing.
      scope.syncKickBell?.stop();
      scope.syncKickBell = null;
      scope.apiCron?.stop();
      scope.apiCron = null;
      scope.signalPoll?.stop();
      scope.signalPoll = null;
      // Kept on the scope: the stop awaits its turns once they have unwound.
      scope.calendar?.stop();
      scope.pushWake?.stop();
      scope.pushWake = null;
      const hub = scope.wakeHub;
      scope.wakeHub = null;
      if (hub) void hub.end().catch(() => { /* a LISTEN that will not close politely is closed by the socket */ });
    }
    scope.stopTimers = clearTimers;
    function handleLockLoss(err: LockLostError): void {
      if (scope.lockLost || scope.stopped) return;
      scope.lockLost = true;
      scope.stopped = true;                              // stop triggering any new work immediately
      scope.attachPool.abortAll();                       // and end every attach in flight, at its next step
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
      void scope.serialize(async () => {
        await scope.attachPool.settled();
        for (const rt of [...runtimes.values()]) await scope.detach(rt, "leader lock lost");
        // Surrender the heartbeat too. Leaving the last beat behind would keep the shard
        // looking alive for the whole `leaderStaleMs` window while nothing is syncing —
        // the alert would arrive two minutes after we already KNEW.
        try { await clearHeartbeat(db as unknown as Tx, fence); }
        catch (e) { log.warn("heartbeat_clear_failed", { err: e }); }
      }).catch(() => undefined);
      hooks.onLockLost?.(err);
    }
    void lock.lost.then(handleLockLoss);
    /**
     * PROVEN, OR NOT SURE. Each heartbeat asks the lock's own session whether it still holds the lock.
     * Two answers were acted on, a close and "not held", and a session that gives neither (it stays
     * open and nothing comes back) left its leader believing for good, with every later check queued
     * behind the first: a successor took the lock the server had freed and two processes led. So the
     * heartbeats since the last proof are counted, BEFORE anything is awaited, and after
     * `LOCK_UNPROVEN_HEARTBEATS` of them this instance is not sure: it quiesces as on any lost lock.
     * One check is out at a time. A check that is REJECTED is logged and asked again at the next
     * heartbeat; it proves nothing either way, so the count runs on.
     *
     * Heartbeats that ASKED, and not an age read off the clock: a process that did not run for a
     * while (a stalled loop, a suspended host) has not gone unanswered, it has not asked, and a step
     * of the wall clock is no evidence about a lock in either direction.
     *
     * The pulse follows a proof and is not waited for: it is a write on the POOL, and a pool that
     * does not answer must not stop the lock from being proven. That case is the cycle's (a database
     * fault, a stuck cycle), not a lost lock.
     *
     * When lock and pool both stop answering, this ends the leadership after those heartbeats;
     * closing the worker then waits for statements that never answer, and the process exits at its
     * close deadline, where it used to exit at the stuck bound. Under `startWorker()`, which has no
     * supervisor, a quiesced worker stays quiesced, as on any lost lock.
     */
    scope.unproven = 0;
    scope.verifying = false;
    scope.pulsing = false;
    scope.hbTimer = setInterval(() => {
      if (scope.stopped) return;
      if (scope.unproven >= LOCK_UNPROVEN_HEARTBEATS) {
        handleLockLoss(new LockLostError(`the lock was not proven for ${scope.unproven} heartbeats`, "LOCK_UNPROVEN"));
        return;
      }
      scope.unproven++;
      if (scope.verifying) return;
      scope.verifying = true;
      void (async () => {
        try {
          const held = await lock.verify();
          if (scope.stopped) return;
          scope.verifyErrors = 0;
          if (!held) { handleLockLoss(new LockLostError("heartbeat found the lock no longer held", "LOCK_NOT_HELD")); return; }
          scope.unproven = 0;
          // PROVEN LEADER, THEN PULSE. The order is the point: the row's claim that this shard
          // has a live leader is now backed by the advisory lock answering `held`, not by a
          // process asserting it about itself. A verify that FAILS deliberately skips the
          // pulse — an unproven leader should go stale, which is what the alert reads.
          if (!scope.pulsing) {
            scope.pulsing = true;
            void scope.pulse().finally(() => { scope.pulsing = false; });
          }
        } catch (err) {
          if (scope.stopped) return;
          // A failed heartbeat QUERY is not proof of loss (a slow DB, a statement timeout).
          // Genuine loss arrives via `lock.lost` (connection close), a `held: false` answer,
          // or the count above.
          scope.verifyErrors++;
          log.error("lock_verify_failed", { consecutiveFailures: scope.verifyErrors, err });
        } finally {
          scope.verifying = false;
        }
      })();
    }, heartbeatMs);

    // ── Initial roster (inside the queue, so the first timer tick cannot overlap it). The boot pass
    //    alone waits for its attaches, which run in parallel (see `reconcileRoster`).
    await scope.serialize(() => scope.reconcileRoster({ awaitAttaches: true }));
    // Beat again now the roster is known: a leader that takes 60 s to write its first real
    // heartbeat is a leader the alerter reports as down for the first minute of every
    // deploy, which is how a real alert becomes noise on day one.
    await scope.beat();

    log.info("worker_serving", {
      mailboxes: runtimes.size, accounts: scope.dutyAccounts.length,
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

    if (alertHeartbeat.state === "unusable") {
      log.error("alert_heartbeat_unusable", {
        configVar: alertHeartbeat.configVar, reason: "set but not one plain http(s) URL; no heartbeat is sent",
      });
    }

    scope.pollTimer = setInterval(() => { kickCycle(); }, config.pollIntervalMs);
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
    scope.rosterTimer = setInterval(() => { scope.requestRoster(); }, rosterIntervalMs);
    // The alert pass runs OFF the serial queue: it is four aggregate reads and must not wait
    // behind a slow IMAP cycle — the cycle being slow is one of the things it reports on.
    scope.alertTimer = setInterval(() => { void scope.alertPass(); }, alertIntervalMs);
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
      scope.apiCron = startApiCron({
        baseUrl: config.apiCron.baseUrl, secret: config.apiCron.secret, log,
        ...config.apiCron.schedule,
        // One clock per pass: a row an API program drives on its own clock is left to it while one leads.
        apiLeads: () => apiClocksLead(db),
      });
    }
    // The 5xx poll, on this worker's own platform credential (`TF_SIGNAL_*`): deployment-wide, so shard 0.
    if (config.signals && shardIndex === 0) {
      scope.signalPoll = startPlatformSignalPoll({ db: db as unknown as Tx, signals: config.signals, log });
    }
    // Enforced sync (mail 0049): a short scan for mailboxes the API stamped `sync_requested_at`. OFF
    // the serial queue like the alert pass — it is one indexed read plus a compare-and-clear, no
    // adapter operation — and its `kick` REQUESTS a cycle rather than running one, so the actual sync
    // still goes through the single queue. Scoped to `runtimes` so it only hastens a mailbox this
    // instance organizes. SINGLE-FLIGHT, because `setInterval` does not wait for its callback: a
    // database taking longer than 3 s stacks a new pass on the slow one every tick, each holding a pool
    // connection and racing the same compare-and-clear — one slow read turned into pool pressure at the
    // worst moment. A tick that finds the previous pass running skips; the stamp is there next time.
    // THE DOORBELL: the same scan also starts when the change log signals, so a stamp whose writer
    // signalled in its commit is served at once and the timer is the floor under it. The hub is made
    // here, outside the push wake's `try` below, so a wake sender that cannot start leaves the bell
    // its signal. A signal for an account this process serves no mailbox of starts nothing.
    const changeSignals = makeChangeWakeHub(config.databaseUrl, log);
    scope.wakeHub = changeSignals;
    const syncKickAskedFor = new Map<string, string>();
    const syncKickFloorMs = config.syncKickFloorMs ?? SYNC_KICK_EVERY_MS;
    scope.syncKickBell = startSyncKickBell({
      pass: async (by) => {
        const scanned = await syncKickPass({
          db: db as unknown as Tx,
          served: () => runtimes.keys(),
          // The SAME two halves the IDLE callback uses: name the mailbox that is owed a
          // visit, then ask for a cycle. `syncKickPass` already knows which mailbox it is
          // hastening — before this the kick discarded that and asked for an undifferentiated
          // rotation, so the mailbox whose Sent copy the user is watching for waited behind every
          // other mailbox on the shard exactly as an IDLE-woken one did.
          kick: (mailboxId) => { scope.noteWake(mailboxId); kickCycle(); },
          // A stamped mailbox nobody here serves yet — a new one — asks for its roster pass now.
          requestRoster: scope.requestRoster, askedFor: syncKickAskedFor,
          // A served mailbox with an unspent lease press ("Organize here" or "Hand the mailbox
          // back"): the roster refreshes its lease columns, so the cycle this kick asks for gates
          // on the press rather than on the value read before it. Asking only; the fenced gate
          // decides, and it honours a release first.
          leasePressed: () => { scope.requestRoster(); },
          log,
        });
        if (scanned.kicked.length > 0 || scanned.rosterFor.length > 0) {
          log.info("sync_kick", { kind: by, count: scanned.kicked.length, cleared: scanned.cleared, mailboxes: scanned.rosterFor.length });
        }
      },
      floorMs: syncKickFloorMs,
      gapMs: SYNC_KICK_SIGNAL_GAP_MS,
      source: changeSignals,
      owns: (accountId) => {
        for (const rt of runtimes.values()) if (rt.accountId === accountId) return true;
        return false;
      },
      isStopped: () => scope.stopped,
      log,
    });
    log.info("sync_doorbell_started", { everyMs: syncKickFloorMs, ms: SYNC_KICK_SIGNAL_GAP_MS });
    // The calendar's passes: a bell of their own on the same signal, off the serialized queue.
    calendarSection(scope);

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
      scope.pushWake = startPushWake({
        db: db as unknown as Tx,
        source: changeSignals,
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
      scope.pushWake = null;
    }

    /** {@link WorkerStats.cycleProgressAt}. A memory read. */
    function cycleProgressAt(): Date | null {
      const moved = Math.max(scope.lastRotationEndAt ?? 0, scope.lastTurnEndAt ?? 0);
      const running = visitStarts.size > 0 ? Math.min(...visitStarts.values()) : null;
      if (running === null) return moved > 0 ? new Date(moved) : null;
      return new Date(moved > 0 ? Math.min(moved, running) : running);
    }

    scope.teardown = null as Promise<void> | null;
    return {
      stats(): WorkerStats {
        return {
          ...scope.counters(),
          // NOT in `counters()`, for the same reason `truncated` is not: those fields are also the
          // `worker_heartbeats` payload and that table has no column for either. Both are memory
          // reads, so `/health` still touches no database.
          causes: scope.degradedCauses(),
          unserved: scope.unservedBreakdown(),
          awaitingCredentials: awaitingCreds.size,
          truncated: scope.truncated,
          // NOT part of `counters()`, for the reason `escalatedMessages` gives below it: those
          // fields are also the `worker_heartbeats` payload and that table has no column for this
          // one. It is a memory read, so `/health` still touches no database — which for THIS
          // field is not merely a nicety but the whole point, since it reports the state in which
          // the database cannot be read.
          databaseFaultSince: scope.dbFaultSince === null ? null : new Date(scope.dbFaultSince),
          lockLost: scope.lockLost,
          // Summed off the attached ledgers, which hold what the last hydration read — so this is a
          // memory read and `/health` still touches no database, which is the one thing that
          // endpoint may never do. It is NOT part of `counters()`: those fields go into
          // `worker_heartbeats` as well, and that table has no column for this one.
          escalatedMessages: [...runtimes.values()]
            .reduce((n, r) => n + (r.deps.deadLetters?.escalated ?? 0), 0),
          // Derived rather than stored, so it cannot drift from the streak the pass actually
          // mutates. `sinkHealthOf` reads memory only — `/health` still touches no database.
          alertSinks: sinkHealthOf(alertSinks, alertDeliveryStreak),
          // The pager's own verdict over the same arms: `dead` when every arm refuses.
          pager: pagerVerdictOf(sinkHealthOf(alertSinks, alertDeliveryStreak)),
          // The API-cron schedule's per-target report — a memory read like everything else
          // here. `[]` when the arm is unconfigured, on shards > 0, or after quiescing.
          apiCron: scope.apiCron?.health() ?? [],
          parkedReader: parkedAccountsReader ? "composed" : "absent",
          cycleProgressAt: cycleProgressAt(),
          lastRotationMs: scope.lastRotationMs,
          lastTailMs: scope.lastTailMs,
          tail: scope.tailPosition(),
        };
      },
      stop(): Promise<void> {
        // Idempotent (SIGINT + SIGTERM, or a supervisor stop racing a fatal path).
        scope.teardown ??= (async () => {
          scope.stopped = true;
          // The attaches in flight are force-closed now and awaited below, before anything closes.
          scope.attachPool.abortAll();
          // FIRST, and before `clearHeartbeat` below: the pulse runs off the serial queue, so
          // a timer left armed here could land its refresh after the surrender. The guarded
          // UPDATE would refuse it anyway (`leader = true` is false by then) — this is the
          // belt to that suspenders, and it also stops a beat racing `owned.close()`.
          clearTimers();
          // THE BUFFERED USAGE, TWICE, each bounded by one call budget: the held lines now, before
          // a drain that can outlive a platform's grace window, and the in-flight cycle's tail
          // after it. A `flushExit(1)` fatal path flushes nothing; the daily reconcile shows it.
          await usageBuffer?.flush();
          await scope.drain();                   // let the in-flight cycle/roster pass finish
          await scope.attachPool.settled();      // and every attach, which unwinds without a row write
          await scope.calendar?.settled();       // and every calendar turn, which ends at its next step
          await usageBuffer?.flush();
          usageBuffer?.stop();
          try {
            for (const rt of [...runtimes.values()]) await scope.detach(rt, "worker stopping");
            // Hand the shard back BEFORE the pool closes: a clean shutdown that left its last
            // beat behind would look alive for two more minutes, and a deploy that failed to
            // start its replacement would then be reported two minutes late.
            if (!scope.lockLost) {
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
        return scope.teardown;
      },
    };
  } catch (err) {
    // The lock guard and its pulse now start BEFORE the initial roster pass, so a startup
    // failure after that point leaves an armed timer holding the event loop open and writing
    // to a pool that is about to close. `stopTimers` is set once they exist.
    scope.stopTimers?.();
    // An attach still running holds a connection and may still write: end it before closing anything.
    scope.attachPoolRef?.abortAll();
    try { await scope.attachPoolRef?.settled(); } catch { /* the pool never rejects */ }
    for (const rt of runtimes.values()) {
      if (rt.unwatch) { try { await rt.unwatch(); } catch { /* ignore */ } }
      try { await rt.adapter.close(); } catch { /* ignore */ }
    }
    try { await owned.close(); } catch { /* ignore */ }
    // The start's own error is the one that travels: the caller reads it to tell a database that
    // went away from an instance that is broken.
    try { await lock.release(); } catch (e) { (config.logger ?? silentLogger).error("lock_release_failed", { err: e }); }
    throw err;
  }
}

/** `account/mailbox` ids for a log line, bounded so one bad config cannot flood the log. */
export function sample(mbs: readonly EnabledMailbox[], n = 3): string {
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
export async function runWorkerCli(
  seams: {
    /** TEST SEAM: the parsed configuration, before anything reads it. Absent in every deployed process. */
    configure?: (config: WorkerConfig) => WorkerConfig;
  } = {},
): Promise<void> {
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
      // The model client's `ai_call` lines read `cliLog` at each call, after it is rebuilt below.
      const parsed = loadConfig(process.env, { log: () => cliLog });
      const config = seams.configure ? seams.configure(parsed) : parsed;
      cliLog = createLogger({
        service: "worker",
        fields: { instanceId: config.instanceId ?? instanceIdFrom(), environment: config.environment },
      });
      // Which model this organizer runs on, and whether it meters — the line an operator, and a
      // managed deploy, reads first.
      cliLog.info("ai_provider_configured", aiProviderLine(config));

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
        ...(err instanceof WorkerConfigError
          ? { configVar: err.configVar, ...(err.remedy ? { reason: err.remedy } : {}) }
          : {}),
      });
      flushExit(1);
    }
  })();
}

// CLI bootstrap. It runs SUPERVISED: a lock-held start stands by and serves health 200 instead of
// exiting, so a rolling deploy cannot crash-loop the new instance, and a start that cannot reach the
// database waits and retries instead of exiting, so an outage cannot spend the host's restarts. What
// still exits 1: a refused or broken deployment, a cycle that stopped moving, a worker that could not
// be closed (`supervisor.ts`). The dynamic import inside keeps supervisor.ts → index.ts a one-way
// dependency.
if (isCliEntry(import.meta.url)) {
  void runWorkerCli();
}
