import { and, eq, sql } from "drizzle-orm";
import {
  pruneIdempotencyKeys, noticeSinkFor, setNoticeSink, accountSettings, mailboxCredentials, mailboxes,
  messages, folderState, junkSweepCandidateWhere,
} from "@trafficflow/db";
import { makeOwnedDb, makeChangeWakeHub, type OwnedDb, type ChangeWakeFanout } from "@trafficflow/db/cloud";
import {
  makeAiCreditGate, withSetupPool,
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
  /* The abandoned-claim sweep — the janitor half of the exclusive AI-attempt claim. Cloud, for
   * the same reason the staging sweep is:
   * `ai_attempt_claims` exists only where there is a ledger to coordinate. */
  pruneAiAttemptClaims,
  type AiCreditGate,
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
import { runSyncCycle, LeaderFencedError, type SyncDeps } from "./sync.js";
import { adoptSweepWindow, junkSweepPass, type SweepScanState } from "./junk-sweep.js";

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
import { ruleRetroPass } from "./rule-retro.js";
import { ohboxTidyPass } from "./ohbox-tidy.js";
import { screenerAutoApplyPass } from "./screener-auto.js";
import { screenerAutoSuggestPass } from "./screener-auto-suggest.js";
import { syncKickPass } from "./sync-kick.js";
import { sensitiveBackfillPass } from "./sensitive-backfill.js";
import { storageEvictPass } from "./storage-evict.js";
import { awayResponderPass } from "./away-responder.js";
import { isCliEntry, flushExit, installCrashHandlers } from "./entry.js";
import {
  startPushWake, pushEndpointGuardFromEnv, vapidFromEnv, type RunningPushWake,
} from "./push-wake.js";
import { driverWriteRaceReason } from "./driver-write-race.js";
import { recordSmtpMaxSize, smtpSizeDial } from "./smtp-size.js";
import type { Tx } from "@trafficflow/db";
import {
  loadEnabledMailboxes, loadMailboxCreds, loadMailboxById, bootstrapEnvCreds,
  markMailboxFailed, markMailboxConnected, markMailboxStoodDown, clearOrganizerStandDown,
  markMailboxSyncBlocked, clearMailboxSyncBlock,
  classifyMailboxError, mailboxErrorDetail,
  stampMailboxSyncNow, stampInitialImportComplete, makeSyncWriteFence, type LeaderFence,
  accountsOf, loadServedAccounts, accountInShard,
  type EnabledMailbox, type MailboxErrorPhase, type MailboxSyncBlockReason,
} from "./mailboxes.js";
import { OrganizerProfileSync } from "./profile.js";
import {
  readMailboxLease, releaseMailboxClaim, cloudInstallId, CLOUD_DISPLAY_NAME, LeaseUnavailableError,
  type LeaseSelf,
} from "./lease.js";

/** How often the leader runs the global maintenance pass (expired-idempotency-key sweep). */
export const MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

/**
 * How often the leader runs the BUBBLE-UP RESURFACING pass, and NOT CONFIGURABLE.
 *
 * There is no `TF_BUBBLE_UP_EVERY_MS`, deliberately. An env var here is the "absent config
 * selects the dangerous branch" trap this repository keeps paying for: unset, an
 * `?? SOMETHING` would pick a period nobody chose, and the failure is silent — a snoozed
 * message resurfaces late, or a deployment that meant 60 s runs the pass hourly, and the only
 * symptom is a user's dated promise arriving whenever. `config.ts`'s own note about a proxy for
 * time that silently retunes itself is the same lesson from the other direction.
 *
 * 60 s because that is the granularity the promise is made at: `AppShell`'s resurface action
 * names a wall-clock minute (`format.ts`, next Friday 09:00 UTC), and the default
 * `pollIntervalMs` is 60 s anyway, so a shorter period would buy nothing but extra queries.
 */
export const BUBBLE_UP_EVERY_MS = 60_000;

/**
 * How often the leader runs the THREAD-JOIN HEAL, and NOT CONFIGURABLE — a `const` for the
 * reason {@link BUBBLE_UP_EVERY_MS} is: an unset `?? something` would silently pick a period
 * nobody chose.
 *
 * Six hours, not sixty seconds, because the pass repairs a presentation defect, not a promise:
 * a conversation a forward split renders as two threads until the heal joins them, and the
 * joining evidence (`conversationJoinVerdict`) needs the counterparty's REPLY to have arrived
 * anyway — which takes hours to days in human mail. Every cycle would be a fleet-wide GROUP BY
 * bought against no user-visible latency.
 */
export const THREAD_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;

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
   * (`ESCALATE_AFTER_ATTEMPTS`) — mail that is recorded, still probed once per deployed build, and
   * no longer plausibly one deploy away from working.
   *
   * A COUNT and nothing else, deliberately: which mailbox and which UID are in `message_failures`
   * and in the worker's own log line, and neither belongs on a public endpoint. Nothing PAGES on
   * this number — `/health` is polled, not alerted on — so it is a window rather than an alarm. The
   * path that pages is a heartbeat column plus a fifth alert rule, and that is a cloud migration and
   * a grant-census change of its own.
   */
  escalatedMessages: number;
  /**
   * The last cycle in which at least one mailbox actually SYNCED (or in which there was
   * genuinely nothing to sync). Deliberately NOT "the last time the timer fired": an empty
   * or all-failed cycle must not refresh freshness, or `/health` lies about a dead leader.
   */
  lastCycleAt: Date | null;
  /**
   * EVERY CONFIGURED PAGER ARM, AND WHETHER IT IS ACTUALLY DELIVERING.
   *
   * The startup line has always named the arms (`worker_serving alertSinks:["mail"]`), and a
   * name is not a state: an arm that has refused every delivery since the day it was
   * configured appears in that list exactly like a working one, and did — the webhook arm sat
   * in it, dead, for months. A second vendor makes that worse rather than better, because the
   * surviving arm keeps the pages landing and there is then no symptom at all.
   *
   * So the standing per-arm verdict is published: closed outcome codes, counts and timestamps,
   * never the vendor's error sentence (that is drain-bound and this endpoint is not). A
   * `lastOkAt: null` with `attempts: 0` is the honest report for an arm nobody has exercised —
   * absence of evidence, said out loud rather than read as health.
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
   * whenever the lease has answered at all since.
   *
   * ── THE FIELD A MEASURED LEASE OUTAGE DID NOT HAVE ─────────────────────────────────────
   *
   * `LeaseUnavailableError` is exempt from `maxSyncFailures` BY CLASS in `cycle()`, and that
   * exemption is CORRECT — an infrastructure fault must never write `status='error'` on a
   * customer's mailbox. What was missing is a second observer on the exempt arm: a membership
   * test can say "this cycle could not read the lease" but not "for how long", so nothing could
   * tell a provider blip from a socket that died ten minutes ago and is never coming back. In
   * one production incident every served mailbox sat in the second state for most of an hour
   * reporting `leader` and `serving`.
   *
   * On the runtime rather than in a closure map, because it is a property of ONE connection: a
   * detach drops the runtime, the next roster pass builds a fresh one starting at `null`, and that
   * reset is exactly right — the new connection has not failed to read anything yet.
   *
   * Cleared whenever `mayOrganize` RESOLVES, either way. A stand-down proves the lease readable
   * just as an organize verdict does; only a throw means "we could not look".
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
   * The lease-relevant columns of this mailbox's row, as the last roster pass read them.
   *
   * Re-read every `TF_ROSTER_INTERVAL_MS` rather than captured at attach, because
   * `takeover_authorized_at` is stamped by ANOTHER process (the connect flow) while this one is
   * already serving the mailbox. A value captured once would mean a user's explicit "yes, move
   * this to Cloud" did nothing until the worker happened to restart.
   */
  lease: { takeoverAuthorizedAt: Date | null; disabledReason: string | null };
  /**
   * This mailbox's LAST cycle ended still owing work — a truncated inbound batch
   * (`hasBacklog`) or filing that hit the reconciler's per-cycle budget (`owesFiling`).
   *
   * It is what the rotation's fast-lane reservation keys on, and it is the mailbox's OWN report
   * rather than a guess from its size: a huge mailbox that has finished importing is
   * light, and a small mailbox mid-first-import is heavy. The same two flags already drive
   * the `backfill_progress` re-kick, so this costs one assignment and introduces no new notion of
   * "big".
   *
   * FALSE at attach, deliberately, and it is the one value that could be argued either way. A
   * fresh runtime has not said anything yet, and presuming it heavy would hold the whole shard's
   * first pass out of the reserved lane — at boot every mailbox is fresh, so a presume-heavy
   * default would make the first rotation after every deploy the narrowest one. It costs at most
   * one cycle of a backfilling mailbox occupying the fast lane, after which it reports for itself.
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
   * channel named it — or `null` when nothing is owed.
   *
   * ── WHY A KICK NEEDS A NAME AND NOT JUST A TIMER ──────────────────────────────────────────────
   *
   * `adapter.watch(() => kickCycle())` is the whole of the realtime path, and `kickCycle` schedules
   * a rotation, not a visit. So a mailbox whose doorbell rang went to the back of a queue with
   * every other mailbox on the shard in front of it, and the measurement is what that costs: a
   * 15.5-minute visit gap for a mailbox on a wake channel that answers in under a second.
   *
   * Recording WHICH mailbox rang turns the kick into a priority instead of a nudge. Oldest wake
   * first, so a mailbox that has been ringing since the start of a backfill is served before one
   * that rang a moment ago — the same oldest-first rule the rest of this file's ordering uses.
   *
   * Cleared when the mailbox is ADMITTED to a lane, not when the cycle completes: a wake that
   * arrives DURING its own visit is about mail that landed after `changesSince` was answered, and
   * clearing on completion would swallow it.
   */
  wokenAt: number | null;
}

/** A detached mailbox waiting out its exponential retry backoff. */
interface Quarantine {
  attempts: number;
  retryAt: number;
  reason: string;
  /**
   * Mail migration 0039's column. Did `retry_after` actually get written for this mailbox?
   *
   * ── WHY A FLAG AND NOT "JUST READ THE COLUMN" ────────────────────────────────────────────
   *
   * Because `retry_after IS NULL` has to mean exactly one thing before it can be a release
   * signal, and without this flag it means two: "an operator cleared it" and "the durable write
   * never landed". The second is a normal outcome here — `markMailboxFailed` is fenced (a
   * disabled row, or another instance now leads the shard) and is best-effort against a database
   * that may be the very thing that is broken.
   *
   * Conflating them is not a cosmetic bug. The roster gate would read the NULL as "try now", the
   * attach would fail again, the write would fail again, and the mailbox would be re-dialled
   * every `rosterIntervalMs` for as long as the condition lasted — the exact silent DoS against
   * a customer's provider that the block at the end of `attach()` spends twenty lines forbidding,
   * arrived at from the other direction. So the column governs only when we know it is OURS.
   */
  persisted: boolean;
}

/**
 * The always-on worker. ONE process, ONE leader lock per shard; it then syncs ALL
 * enabled mailboxes of ALL accounts in its shard — a second registered account is
 * never silently unsynced — reading each mailbox's credentials from
 * `mailbox_credentials` (envelope-decrypted via the KeyProvider).
 *
 * The roster is LIVE, not a startup snapshot: a `TF_ROSTER_INTERVAL_MS` pass re-reads the
 * shard's enabled mailboxes and reconciles the runtime map — accounts that registered after
 * boot are connected without a restart, and mailboxes that were disabled or deleted are
 * unwatched and CLOSED instead of being kept on an IDLE connection forever (the
 * billing-downgrade and credential-deletion paths both produce exactly that).
 *
 * Failure isolation is per mailbox: a bad mailbox is marked status='error', DETACHED, and
 * retried with exponential backoff, never aborting the others — and never stalling another
 * ACCOUNT. Runtime failures count too: `maxSyncFailures` consecutive cycle errors detach the
 * mailbox rather than logging the same error forever. A mailbox that comes back is restored
 * to status='connected' only after a VERIFIED recovery (connect + folders + two full sync
 * cycles).
 *
 * Cycles and roster passes are SERIALIZED on one queue, so a roster pass can never start beside
 * a cycle, and `stop()` awaits the in-flight work instead of yanking the DB and the lock away
 * from it.
 *
 * A cycle nevertheless SERVES an owed roster pass from inside its own queue entry (see
 * `yieldToRoster`), which is what stops a customer's brand-new mailbox waiting out an unrelated
 * mailbox's backfill before anything connects to it at all.
 *
 * INSIDE one cycle entry, up to `cycleLanes` mailboxes are visited AT ONCE (see the lane
 * block in `cycle()`). This paragraph used to say parallelism "would only add connection
 * pressure" and that the per-account seq row lock serializes writers anyway; the second half is
 * why the concurrency key is the ACCOUNT and not the mailbox, and the first half was measured
 * false — one mailbox's deep backfill put most of its shard's mailboxes past the 15-minute
 * sync-lag threshold
 * and left another 15.5 minutes between visits on a sub-second wake channel. What has NOT changed
 * is that one mailbox is visited by one cycle at a time, that the write fence and the organizer
 * lease see exactly what they always did, and that every lane is joined before the pass ends.
 *
 * SECURITY: the worker host holds KEK material (config.keyProvider / TF_KEK_V1) because
 * it must decrypt per-mailbox credentials to connect — same trust level as the API.
 * Treat this process accordingly.
 *
 * PROGRAMMATIC contract (unchanged, and depended on by `test/leader-lock.test.ts`
 * semantics): if another process holds the lock this THROWS. The CLI does NOT use this
 * path — it stands by instead of exiting (`supervisor.ts`).
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

    // ── OAuth2 (Exchange/M365) token source — one per process, per-mailbox cache. ───────────────
    //
    // Constructed UNCONDITIONALLY, even on a deployment with no `MS_OAUTH_*` set and no oauth
    // mailboxes: the refusal for a missing client secret has to NAME the missing variable, and that
    // only happens if the provider exists to be asked. A password-only deployment simply never
    // invokes it — an oauth row is the only thing that reaches `fetchAccessToken`. The rotated-token
    // write targets the mailbox's OWN imap row, and is the only write this port makes.
    // ONE WRITER of a rotated refresh token, shared with the API host (`rotateMailboxOAuthSecret`,
    // `packages/db`). It was a hand-written update here and a second one there; the
    // `transport = 'imap'` predicate is what stops a rotation overwriting an unrelated smtp row and
    // is not a thing to state twice.
    const updateSecret: UpdateSecretPort = (mailboxId, ciphertextEnc, keyVersion) =>
      rotateMailboxOAuthSecret(db, {
        mailboxId, ciphertext: ciphertextEnc, keyVersion, now: new Date(),
      });
    /**
     * THE REGISTRATION IS RESOLVED AT TOKEN TIME, FROM THE CONFIG STORE, WITH ENV AS THE FALLBACK.
     *
     * Not at boot. An Entra client secret expires on Azure's schedule, and when it does every oauth
     * mailbox in the fleet stops refreshing — silently, because `refreshAccessToken` correctly
     * classifies a rejected client as "we could not ask" rather than as a dead credential, so nothing
     * is quarantined and nothing pages. The remedy is an operator pasting a new secret into the admin
     * console, and this worker process may not have restarted for weeks. So the value is read on the
     * refresh path, through the SAME resolver the API's onboarding routes call
     * (`resolveOAuthProviderConfig`), which is what makes it impossible for the two to sign with
     * different clients or to disagree about whether env may override a disabled row.
     *
     * `enabled` is deliberately NOT consulted here. It is the ONBOARDING switch — whether a new
     * consent ceremony may start — and refusing to refresh an already-connected mailbox because the
     * operator turned onboarding off would take working mailboxes down as a side effect of closing a
     * door. A registration whose credentials are gone still refuses, by way of the named
     * `OAuthConfigError` the token client throws on an empty id or secret.
     */
    const oauthTokenProvider: OAuthTokenProvider = new MicrosoftTokenProvider({
      clientId: config.msOAuth?.clientId ?? "",
      clientSecret: config.msOAuth?.clientSecret ?? "",
      defaultTenant: config.msOAuth?.tenant ?? "common",
      resolveClient: async () => {
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

    // ── Structured logs + the alert pass ───────────────────────────────────────────────
    //
    // Every line this worker emits from here on is one JSON object carrying `instanceId` and
    // `shard`, and every per-mailbox line adds `accountId`/`mailboxId` — the two ids that
    // turn "a sync cycle failed" into "THIS customer's mail stopped". Bound once, on a child
    // logger, so no call site can forget them.
    //
    // The DEFAULT is `silentLogger`, not a stdout logger, for every path except the CLI: a
    // library that prints because its host forgot to inject something is a library that
    // pollutes somebody's test output. `runWorkerSupervised` (and therefore the deployed
    // process) injects
    // a real one; `startWorker` called directly from a test stays quiet unless it asks.
    const instanceId = config.instanceId ?? instanceIdFrom();
    const environment = config.environment ?? "production";
    const startedAt = new Date();
    const log: Logger = (config.logger ?? silentLogger).child({
      instanceId, shard: shardIndex, shards, environment,
    });

    /**
     * THE LEADER EPOCH, as the two mailbox lifecycle writes see it.
     *
     * `worker_heartbeats` is already the durable, atomically-claimed record of "who leads shard
     * N" — `writeHeartbeat` overwrites `instance_id` on takeover and `refreshHeartbeat` refuses
     * a surrendered leader's late pulse against exactly this predicate. Passing it into
     * `markMailboxFailed` / `markMailboxConnected` fences those writes with the SAME definition
     * rather than a second one, and `clearHeartbeat` takes it so a surrender cannot clobber a
     * successor's claim. See the fencing block in `mailboxes.ts`.
     *
     * The first beat is written before any attach (`reconcileRoster`, `firstBeatPending`), so
     * the row exists by the time either mailbox write can fire. If that best-effort beat failed,
     * the fence closes and the write is refused and LOGGED (`mailbox_failure_write_fenced`)
     * rather than landing unfenced — the safe direction, and a visible one.
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
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *  THE SHARED-DEPENDENCY CONDITION — WHEN OUR OWN DATABASE IS THE THING THAT IS BROKEN
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * `null` ⇒ the database is answering. Otherwise the ms instant the current run of database
     * faults began, kept in MEMORY on purpose: it is the state in which the database cannot be
     * written to, so a column recording it would be exactly as unreachable as the thing it
     * reports. `/health` is served out of this process and touches no database (see
     * `health.ts`), which makes it the only surface that still works during the condition it
     * describes.
     *
     * ONE CONDITION FOR THE PROCESS, not one per mailbox, because that is what the fault IS —
     * the same argument the classifier circuit is built on (`aiFor`): a per-mailbox counter over
     * a shared dependency converges thirteen times slower and reports thirteen incidents.
     */
    let dbFaultSince: number | null = null;
    /** Database faults observed in the CURRENT run. Reported once at the end, not once each. */
    let dbFaults = 0;
    const quarantine = new Map<string, Quarantine>();
    /**
     * Mailboxes on the duty that this process is NOT SERVING, and since when (mail 0029).
     *
     * ── WHY THE BUCKETS CARRY A CLOCK NOW ─────────────────────────────────────────────────
     *
     * They were bare `Set<string>`s, and the whole of a measured half-hour silence lived in that: a
     * membership test can say "not served" but not "not served for how long", so no catch arm
     * could decide whether the state had lasted long enough to be worth writing down, and every
     * arm settled for a log line. `since` is what lets ONE place make that decision.
     *
     * ── AND WHY `reason` IS NULLABLE ──────────────────────────────────────────────────────
     *
     * `null` means "accounted for, but the ROW ALREADY EXPLAINS ITSELF". It is the stand-down case
     * and only that: `mayOrganize` returning false (`attach`, and again in `cycle`) has already
     * written `status='disabled'` plus `disabled_reason` through `markMailboxStoodDown`, which
     * CLEARS these two columns in the same statement. Writing `lease_unreadable` on top would be
     * this pass contradicting itself, and it would be a strictly worse answer than the one already
     * on the row — "somebody else is organizing it" beats "we could not read the lease".
     */
    interface SyncBlock {
      /** `Date.now()` when this process FIRST observed this block. Never moved by a re-observation. */
      since: number;
      /** What to write on the row, or `null` when the row already says something better. */
      reason: MailboxSyncBlockReason | null;
    }
    const awaitingCreds = new Map<string, SyncBlock>();
    /**
     * Mailboxes this pass did not attach because of the ORGANIZER LEASE — either another
     * organizer holds them (the row is now `disabled` and the next roster pass will not offer
     * them again) or the lease could not be read at all.
     *
     * It exists because `roster_invariant_violated` is an assertion that every mailbox of the
     * duty is in exactly one accounted-for bucket, and a mailbox we deliberately declined to
     * organize is accounted for. Without this set the gate would page an operator about its own
     * correct behaviour, every thirty seconds — which is how a real alert becomes noise.
     *
     * A lease-unavailable mailbox still counts toward `expected`, so `/health` keeps reporting
     * `degraded` while it lasts. That is the honest answer: nothing is syncing it.
     *
     * THE TWO POPULATIONS ARE NOT THE SAME STATE and mail 0029 is where that starts to matter —
     * only the "could not read it" half gets a `reason`. See {@link SyncBlock}.
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
     * Enter (or stay in) the shared-database condition — ONE incident, however many mailboxes.
     *
     * ── WHY THE LOUD LINE IS EDGE-TRIGGERED ───────────────────────────────────────────────────
     *
     * "(d) surface as the worker-wide condition it is — the health surface and ONE alert, not
     * thirteen" is half of what this fix owes, and a `log.error` per occurrence would deliver the
     * thirteen. A shard of thirteen mailboxes under a two-minute outage produces one `error` here
     * and one `info` when it clears; the per-occurrence detail rides `debug`, where the operator
     * who wants the mailbox-by-mailbox trace can still get it.
     *
     * `runAlertPass` is deliberately NOT the surface for this one, and that is not an oversight:
     * every rule it evaluates is a query (`packages/db/src/alerts.ts`), so during the fault it
     * describes, it cannot run. The two things that still work are this process's own log stream
     * and its `/health`, and both carry it.
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
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  A BEST-EFFORT CATCH MAY SWALLOW THE MAILBOX'S VERDICT. IT MAY NOT SWALLOW THE SHARD'S.
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * `cycle()` is full of catches that deliberately do nothing: a `last_sync_at` that could not
     * be written, an `initial_import_completed_at`, a per-account pass. Every one of them is right
     * about the MAILBOX — a freshness column must never walk a healthy mailbox toward
     * `status='error'` — and every one of them was also silently correct about the SHARD, which
     * it is not entitled to be.
     *
     * MEASURED in production, and it is a defect the lanes exposed rather than one they invented. With
     * the rotation serial, a database that died mid-pass met the NEXT mailbox's `runSyncCycle` and
     * was announced by the arm the origin-tagging fix built for it. With lanes, every mailbox can be past
     * `runSyncCycle` at the same instant — so an outage landing in that window is met only by the
     * bookkeeping writes, all of which catch, and the shard announced NOTHING: `/health` answered
     * `degraded: false, databaseFaultSince: null` through a total outage. The diagnostic run reads
     * `mailbox_sync_stamp_failed: 2`, `bubble_up_failed: 2`, `workflow_drain_failed: 2`,
     * `rule_retro_failed: 2` — and no `worker_database_fault` at all.
     *
     * So the catches keep doing exactly what they did, and additionally ANNOUNCE. Nothing is
     * counted against a mailbox, nothing is quarantined, no row is touched; `noteDatabaseFault` is
     * edge-triggered, so a whole cycle's worth of these produces one incident.
     *
     * IT ONLY WORKS ON CALLS THAT NAME THEIR ORIGIN, which is why the call sites are wrapped in
     * `asDatabaseFault` and why only SOME of them are. A pure-database call — `stampMailboxSync`,
     * `loadServedAccounts`, the per-account passes — is our database by construction, so tagging it
     * states a fact. `sensitiveBackfillPass`, `ohboxTidyPass` and `screenerAutoPass` are NOT
     * wrapped and must not be: each holds the customer's adapter as well, so a tag around the whole
     * call would promote a provider failure to a shard-wide condition. That is `loadMailboxCreds`'
     * argument in `db-fault.ts`, applied to the three calls it applies to.
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

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  A ROSTER PASS THAT IS OWED, AND THE CYCLE THAT WAS SITTING ON IT
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // `reconcileRoster` is the ONLY path by which a mailbox joins the rotation, and the roster
    // is a live re-read rather than a boot snapshot — `roster.e2e.test.ts` has proven that since
    // the first version of this worker and it still passes. What it could not see is that the
    // pass shares its queue with
    // `cycle()`, which is ONE entry covering every attached mailbox at one bounded batch each.
    //
    // Measured against the live deployment: `worker_heartbeats.last_cycle_at` did not move for
    // ten minutes. One cycle entry held the queue that whole time while
    // `beat_at` stayed fresh, because the pulse is the one thing that runs off it. `expected`
    // and `mailboxes` in that row are recomputed only inside a roster pass, so the heartbeat
    // reported the pre-existing count throughout — which is exactly what the starvation report
    // said, and
    // why nothing in the mailbox's own row explained it: nothing was wrong with the row.
    //
    // So adoption was not broken. It was STARVED, and the starvation term was the WHOLE cycle
    // rather than one mailbox's share of it: at the shipped `maxMailboxes` of 64 that is hours,
    // and it grows with every customer the shard takes on. A new customer connects their mailbox
    // and watches nothing happen, which is the first thing they ever ask this product to do.
    //
    // THE FIX IS SCHEDULING, NOT CONCURRENCY. `rosterPending` says a pass is owed; `cycle()`
    // serves it BETWEEN two mailboxes, inside its own queue entry, where no adapter operation is
    // suspended. Nothing new runs in parallel — `stop()`'s `drain()` still covers the pass,
    // because it is part of the entry the queue is already awaiting.
    //
    // THE FLAG IS AN ACCELERATOR AND THE QUEUE ENTRY IS THE FLOOR. `requestRoster` does both,
    // and the redundancy is load-bearing rather than defensive: on an idle shard — no runtimes,
    // or every cycle finishing in milliseconds — nothing ever reaches a yield point, so a
    // flag-only design would stop adopting entirely on precisely the deployments where the bug
    // did not exist.
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

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE ONE PROPERTY THE SINGLE QUEUE USED TO GIVE FOR FREE
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // The queue above is unchanged: ONE entry at a time, cycles and roster passes both, and
    // `stop()` still drains it. What changed is the INSIDE of a cycle entry, which now visits up
    // to `cycleLanes` mailboxes at once instead of one.
    //
    // The mid-cycle adoption's safety argument was "a roster pass runs between two mailboxes, where NOTHING is
    // suspended inside an adapter". That sentence bought exactly one thing — a pass may never
    // close an adapter somebody is using — and with lanes in flight it is no longer literally
    // true, so the property it bought is stated and enforced directly instead of being inherited
    // from the shape.
    //
    // `laneBusy` is the enforcement. `reconcileRoster` is the ONE detach site reachable from
    // inside a running cycle (the other three — `handleConnectionError`, `handleLockLoss`,
    // `stop()` — each take their own `serialize` entry and therefore cannot start until the whole
    // cycle entry has returned), and it now SKIPS a mailbox a lane is inside and hands it to
    // `deferredLeaves`, which the cycle drains after its lanes have joined. That is the same
    // "detached after the loop, never inside it" discipline `toStandDown`/`toQuarantine`/
    // `toReconnect` already follow, extended to the one caller that could not previously need it.
    //
    // In the steady state both are empty: a roster pass detaches only on disable, deletion or a
    // cap eviction, so this costs one Set membership test per pass on every deployment where
    // nothing is being turned off.
    /** Mailbox ids a lane of the RUNNING cycle is currently inside. */
    const laneBusy = new Set<string>();
    /** Runtimes a roster pass wanted to detach while a lane held them; drained by `cycle()`. */
    const deferredLeaves: Array<{ rt: MailboxRuntime; release: boolean; reason: string }> = [];

    /**
     * THIS mailbox is owed a visit — its IDLE fired, or the enforced-sync scan named it.
     *
     * Keeps the OLDEST unserved wake (`??=`), so a mailbox ringing repeatedly through a long
     * backfill is ordered by when it FIRST rang rather than by its most recent signal — otherwise
     * a chatty mailbox would keep resetting itself to the back of the woken group.
     *
     * Silently ignores a mailbox this process does not serve. Both callers are already scoped to
     * `runtimes` (the IDLE callback belongs to an attached adapter, `syncKickPass` filters on the
     * served set), so this is the race between a signal in flight and a detach, and dropping it is
     * correct: a mailbox that is no longer attached has no lane to be prioritized into, and the
     * next attach re-establishes IDLE.
     */
    function noteWake(mailboxId: string): void {
      const rt = runtimes.get(mailboxId);
      if (!rt) return;
      rt.wokenAt ??= Date.now();
      nudgeCycle();
    }

    // ── AND A RUNNING CYCLE HAS TO BE ABLE TO HEAR IT ─────────────────────────────────────
    //
    // The dispatcher inside `cycle()` blocks on `Promise.race(lanes)` — it wakes when a lane
    // FINISHES, which is the wrong event for this: a wake that lands while three lanes are inside
    // long batches would not be looked at until one of them returned, so the mailbox would wait a
    // bounded batch (~254 s measured) for a signal that answered in under a second. This is the
    // other thing the race waits on.
    //
    // ONE pending promise, re-armed on every fire, rather than a fresh one per turn: the naive
    // form leaves every superseded promise unresolved and holds its `resolve` for the life of the
    // process. It never rejects, so the race can never reject either.
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

    // ── The AI spend gates ──────────────────────────────────────────────────────────
    //
    // One gate per (account, reason), memoised, because a gate carries the small set of
    // "sources I charged" that tells a refund apart from a giveaway — rebuilding it per
    // cycle would throw that away and a refund after a model failure would silently do
    // nothing. Keyed by account and NEVER by config: this process serves every enabled
    // mailbox in its shard, so one worker meters many customers.
    //
    // The gates are wired UNCONDITIONALLY, before any live model is. That ordering is the
    // point: metering must exist before the spend does, not after — the
    // opposite order is a deployment where customers are charged and nothing limits what
    // they cost. Today `config.classifier` does not exist and `config.drafter` is usually
    // absent, so these gates run against branches that do not fire yet; the day a model is
    // wired, the meter is already there.
    const gates = new Map<string, AiCreditGate>();
    function gateFor(
      accountId: string,
      reason: "debit_classify" | "debit_workflow",
      opts: { exclusive?: boolean } = {},
    ): AiCreditGate {
      const key = `${reason}:${opts.exclusive ? "x:" : ""}${accountId}`;
      let gate = gates.get(key);
      if (!gate) {
        gate = makeAiCreditGate(db as unknown as Tx, accountId, { reason, ...opts });
        gates.set(key, gate);
      }
      return gate;
    }
    const classifyGateFor = (accountId: string): AiCreditGate => gateFor(accountId, "debit_classify");
    const workflowGateFor = (accountId: string): AiCreditGate => gateFor(accountId, "debit_workflow");
    /**
     * THE AUTO-SUGGEST PASS'S OWN GATE — same `debit_classify` reason, `exclusive: true`, and a
     * SEPARATE instance from `classifyGateFor` (hence the `x:` in the memo key).
     *
     * The exclusivity has to be per CALL SITE and not per reason, which is why this is not one
     * more flag on the shared gate. The ingest pipeline charges `debit_classify` too, and it is
     * deliberately NOT exclusive in this change: its loser path is "file the message on rules
     * alone", a routing decision with its own consequences, and trading a measured money defect
     * for an unmeasured routing one is not a fix. This pass's loser path is "skip the candidate,
     * the API is buying it" — nothing at all.
     *
     * What it closes is the double-charge that needs no unusual behaviour from
     * anybody: this pass and a person pressing Suggest select the same representative held
     * message by construction, so cron and press racing one sender is an everyday event on any
     * opted-in account. Both sides now take the claim on the same ledger source, which is what
     * makes them exclude each other rather than merely deduplicate.
     */
    const screenerAutoGateFor = (accountId: string): AiCreditGate =>
      // `withSetupPool` — the cron half of the Screener draws the same screening-only setup
      // pool as the request path, BEFORE the main balance, over the SAME memoized inner gate
      // (so the exclusive claim and the in-process refund marker stay one instance per
      // account). No other worker gate wears the wrapper: that is what scopes the pool to
      // screening.
      withSetupPool(db as unknown as Tx, accountId,
        gateFor(accountId, "debit_classify", { exclusive: true }));

    // ── The LIVE classifier, behind a per-process circuit breaker ─────────────────────
    //
    // ONE circuit for the process, because the failure domain is the shared API key and
    // endpoint: per-mailbox circuits would each burn their own faults into the same outage,
    // and `cycle()` walks the rotation serially so one counter converges fastest.
    //
    // `circuit.port()` is resolved PER CYCLE at the call sites below and never cached: while
    // the circuit is open it answers `undefined`, `pipeline.ts`'s `classifier &&` short-
    // circuits before the money question, and the message files rules-only with neither a
    // model call nor a debit. Holding a wrapper across the open transition would instead
    // charge every message and then fail it.
    //
    // Absent classifier ⇒ no circuit and today's behaviour exactly (rules-only routing).
    const classifierCircuit: ClassifierCircuit | undefined = config.classifier
      ? makeClassifierCircuit(config.classifier, { log })
      : undefined;
    /** The classifier + gate pair for one mailbox's cycle. */
    function aiFor(mailboxId: string, accountId: string): Pick<SyncDeps, "classifier" | "credits"> {
      const gate = classifyGateFor(accountId);
      if (!classifierCircuit) return { credits: gate };
      return {
        classifier: classifierCircuit.port(),
        // The metered gate is what teaches the circuit which ledger attempt it charged, so a
        // trip can refund the message it just abandoned. See `ai-circuit.ts`.
        credits: classifierCircuit.meter(mailboxId, gate),
      };
    }

    // ── THE ACCOUNT'S OHBOX POSTURE, RESOLVED PER ACCOUNT AND CACHED WITH A SHORT TTL ─────────
    //
    // One worker serves many accounts, so the posture is resolved from THAT account's
    // `account_settings` row, never from config — the same reason the spend gate is built from the
    // mailbox row's `accountId`. Cached briefly so a user toggling the posture takes effect within a
    // cycle or two without a DB read on every cycle for every mailbox, and short enough that the
    // change is not perceptibly delayed.
    //
    // A read FAULT resolves to the lenient default (`DEFAULT_OHBOX_POLICY`) and does NOT poison the
    // cache — a transient blip must never demote a real person's mail, and must not stick. This is
    // the same absent-config-selects-safe rule `resolveOhboxPolicy` states.
    // ── AND THE SCREENING CUTOFF, OFF THE SAME ROW AND THE SAME READ ─────────────────────────
    //
    // `screening_baseline_at - dormancy_days` (mail migration 0056): mail that arrived before it keeps its
    // arrival folder instead of being held at the consent gate. The arithmetic is done HERE, once
    // per account per TTL, and a resolved instant is threaded into `planChange` — the engine never
    // sees the two components, for the reason `PlanDeps.screeningCutoff` gives.
    //
    // A NULL baseline resolves to `undefined`, which is "no cutoff" and therefore the pre-0056
    // routing. So does a read fault, on exactly the rule the posture beside it follows: the safe
    // direction for an unknown is the consent gate, and a transient blip must not start leaving a
    // stranger's mail in the INBOX. That is why the catch returns only `ohboxPolicy` — every other
    // field, this one included, is absent there on purpose.
    // ── AND THE STORAGE CAP, PER ACCOUNT, ON THE SAME DISCIPLINE ──────────────────────────────
    //
    // The hosted worker is THE metered composition: `SyncDeps.storageCap` is required, the local
    // engines type `UNMETERED_STORAGE_CAP`, and this resolver is the one place a subscription row
    // becomes the number ingest reserves against. Resolved at attach for the runtime's base deps
    // and refreshed in the per-cycle spread below, so a plan change moves the cap within a cycle.
    const storageCapFor = makeStorageCapResolver(db as unknown as Tx, log);
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

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE ORGANIZER LEASE, wired
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // The invariant: exactly one active organizer per mailbox, enforced by a lease in
    // `ohmail/_meta` — the mailbox is the only medium a LOCAL install and Cloud share. The
    // lease engine existed, with a GreenMail two-worlds test beside it, and NOTHING
    // called it, while real mailboxes were organized by Cloud with no claim in `ohmail/_meta`
    // at all (verified against the live logins: the folder did not exist).
    //
    // The gate runs at TWO seams and both are necessary:
    //
    //  · `attach()`, immediately after `connect()` and BEFORE `ensureFolders()`. Everything
    //    after that line writes to somebody's mailbox — `ensureFolders` creates the `ohmail/*`
    //    tree and `runKickstart` re-routes the Screener backlog. The dual-mode rule for this
    //    seam: reconnect is
    //    learn-then-act, and an organizer reads the lease BEFORE its first move. A gate
    //    that ran only in `cycle()` would let every attach organize a mailbox somebody else
    //    holds, once per quarantine retry, for ever. Moving the first DRAIN off this path
    //    deliberately left this gate where it was.
    //  · `cycle()`, immediately before `runSyncCycle`. This is the RE-VERIFICATION, and it is
    //    what turns a lease into an exclusion: a claim is only evidence for the cycle that read
    //    it, so a mailbox that changed hands while we were attached stops being organized on the
    //    next pass rather than at the next restart. It is also the gate the FIRST
    //    sync of every mailbox passes through, the attach path no longer syncing anything.
    //
    // Both seams are guarded by ordering rather than by reading: `attach-nonblocking.e2e.test.ts`
    // asserts that no `ensureFolders` precedes its mailbox's first `organize` verdict, and that no
    // `changesSince` runs without a verdict recorded since the previous one.
    //
    // ONE ORGANIZER IDENTITY FOR THE WHOLE PROCESS, and it is not `instanceId`. See the block
    // above `cloudInstallId` in `lease.ts`: a per-process id would make every leader failover
    // read as a new organizer arriving, and the incoming worker would disable the mailbox the
    // outgoing one was healthily serving.
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
     * Read the lease for one mailbox and, when it says no, make that durable.
     *
     * Returns `true` iff this process may organize this mailbox right now. Throws
     * {@link LeaseUnavailableError} when the lease could not be read at all — never a
     * stand-down, because "somebody else holds this" and "I could not look" must not be
     * reachable from one another. Both call sites exempt that
     * class the way they already exempt `ClassifierFaultError`.
     *
     * The stand-down write is FENCED like every other mailbox lifecycle write, and a fenced-out
     * write still stands the mailbox down IN THIS PROCESS: the row belongs to whoever leads the
     * shard now, but the decision not to organize is ours and is not contingent on recording it.
     */
    async function mayOrganize(
      mb: { mailboxId: string; accountId: string },
      lease: { takeoverAuthorizedAt: Date | null; disabledReason: string | null },
      nonce: { leaseNonce: string | null },
      adapter: MailboxAdapter,
      phase: "attach" | "cycle",
    ): Promise<boolean> {
      const outcome = await readMailboxLease({
        adapter,
        self: leaseSelfFor(nonce),
        now: new Date(),
        // The no-seize-back rule. The stamp is what tells "the user just added this
        // mailbox to Cloud" apart from "the subscription lapsed and came back", which are
        // otherwise identical to the gate.
        takeover: lease.takeoverAuthorizedAt ? "authorized" : "none",
        ...(organizerStaleAfterMs !== undefined ? { staleAfterMs: organizerStaleAfterMs } : {}),
        log: (event, detail) => { log.info(event, { ...detail, mailboxId: mb.mailboxId, accountId: mb.accountId }); },
      });

      if (outcome.organize) {
        nonce.leaseNonce = outcome.nonce;
        // ONE-SHOT. The authorization bought this becoming and no other; leaving it set would
        // let a lapse-then-resubscribe seize the mailbox back months later from whatever a human
        // deliberately moved it to. Written only when there IS something to clear, so the steady
        // state is zero extra writes per cycle.
        if (lease.takeoverAuthorizedAt || lease.disabledReason) {
          try {
            await clearOrganizerStandDown(db, mb.mailboxId, { fence });
            lease.takeoverAuthorizedAt = null;
            lease.disabledReason = null;
          } catch (err) {
            // The gate already said organize and our claim is already written. Failing to spend
            // the stamp costs one more cycle of it being spendable, never correctness.
            log.warn("organizer_takeover_clear_failed", { mailboxId: mb.mailboxId, accountId: mb.accountId, err });
          }
        }
        return true;
      }

      lease.disabledReason = outcome.reason;
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
        const written = await markMailboxStoodDown(db, mb.mailboxId, outcome.reason, { fence });
        if (!written) {
          log.info("organizer_stand_down_write_fenced", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox is already disabled or this instance no longer leads the shard",
          });
        }
      } catch (err) {
        log.error("organizer_stand_down_write_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "this process has stopped organizing the mailbox regardless; the row could " +
            "not record why, so the UI will show an ordinary disabled mailbox",
        });
      }
      return false;
    }

    /**
     * RELEASE the claim on a mailbox this process is no longer entitled to organize.
     *
     * The roster half of the entitlement gate has existed since billing landed — `entitlementsFor` drops a
     * lapsed account's mailboxes out of `loadEnabledMailboxes`, `reconcileRoster` detaches them.
     * That is not enough on its own. A dropped row leaves a FRESH claim in `ohmail/_meta`, and a
     * fresh Cloud claim stands a desktop install down: the user cancels, clicks "Organize from
     * this Mac", and the button appears to do nothing for the whole staleness window because
     * their own machine keeps reading our claim and standing itself down again. Ten minutes of a
     * product that looks broken, at the exact moment somebody has just chosen to leave.
     *
     * So the claim is deleted while the connection that can delete it is still open. This is the
     * ONLY teardown path that releases: `detach` is also reached by a connection error, a
     * quarantine, a lost lock and a clean stop, and in every one of those Cloud fully intends to
     * keep organizing — releasing there would hand the mailbox away on a deploy.
     *
     * Best effort, always. A failed release costs the winner one staleness window; a release
     * that could abort a detach would be strictly worse than the fault it reports.
     */
    async function releaseOrganizerClaim(rt: MailboxRuntime, why: string): Promise<void> {
      try {
        const released = await releaseMailboxClaim(rt.adapter, organizerInstallId);
        if (released === 0) return;
        log.info("organizer_claim_released", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, claims: released, reason: why,
        });
      } catch (err) {
        log.warn("organizer_claim_release_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, err,
          reason: "the claim will age out of ohmail/_meta on its own; until it does, a LOCAL " +
            "install that tries to take this mailbox over stands itself down again",
        });
      }
    }

    async function quarantineMailbox(
      mailboxId: string, accountId: string, reason: unknown, phase: MailboxErrorPhase,
    ): Promise<void> {
      const prev = quarantine.get(mailboxId);
      const attempts = (prev?.attempts ?? 0) + 1;
      // PREFER THE SERVER'S OWN BACKOFF HINT, BOUNDED BY OUR CEILING.
      //
      // imapflow parses MS365's throttle reply — `BAD Request is throttled. Suggested Backoff
      // Time: 92415 milliseconds` — and hangs the number on the error as `err.throttleReset`
      // (`imapflow@1.5.0/lib/imap-flow.js:853-863`). It is MILLISECONDS, assigned raw with no
      // unit conversion; reading it as seconds and multiplying by 1000 sleeps for a day. Until
      // now this worker parsed it via the library and then threw it away, so a provider that
      // told us exactly when to come back was retried on our own ladder regardless — which is
      // what earns the next throttle.
      //
      // `Math.max` then `Math.min` is the whole contract: the hint may only LENGTHEN the wait
      // (a hint shorter than the ladder loses, so a throttling provider can never talk us into
      // retrying sooner than our own backoff), and it may never escape `retryMaxMs` (a hostile
      // or mis-parsed hint cannot park a mailbox indefinitely). `backoffFor` is deliberately
      // untouched — the ladder is still the floor, and `mailboxes.ts:381-383` points here for it.
      //
      // `Number.isFinite` rather than `typeof === "number"`: `Math.max(x, NaN)` is NaN, which
      // would make `retryAt` NaN, and every `Date.now() >= NaN` is false — the mailbox would
      // never leave quarantine. imapflow's own `!isNaN` guard means it cannot send one today;
      // this is the wait computation refusing to depend on that.
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
      try {
        // Mail migration 0039: the same statement now also records WHEN. That is what makes this backoff
        // survive a restart and — the point of the column — releasable by an operator, because
        // until now the only exits from quarantine were the ladder expiring and a redeploy.
        const written = await markMailboxFailed(
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
      log.error("mailbox_quarantined", {
        mailboxId, accountId, attempts, retryInMs: wait, errorCode: code, err: reason,
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
     * ONE MAILBOX'S CONNECTION DIED ASYNCHRONOUSLY — contain it to that mailbox.
     *
     * This is the callback every adapter is handed, and it is the half of a crash-loop
     * post-mortem that the placement fix does not cover. `ImapFlow` reports a socket that FAILED —
     * a server `BYE`, an `ETIMEOUT` — by EMITTING `error`; with no listener Node raises an
     * uncaught exception and `entry.ts` exits the process — so one customer's provider hiccup
     * took down every account in the shard and the platform restarted the container every ~26 s.
     * The adapter now always listens (`ImapAdapter.guardAsyncErrors`), and this decides what
     * the failure costs: exactly one mailbox, detached and quarantined with its normal
     * exponential backoff, while every other mailbox keeps syncing.
     *
     * ── AND IT NOW ALSO HEARS A SOCKET THAT MERELY *ENDED* ─────────────────────────────────
     *
     * "reports a dead socket by emitting `error`" was the claim this comment used to make, and it
     * was wrong in the direction that cost most of an hour of production silence: imapflow calls its own
     * `close()` on `_socketClose`/`_socketEnd`/a failed IDLE recovery, and `close()` emits
     * **`close`**, never `error`. Nothing listened, so `onConnectionError` never fired and this
     * function never ran — the drain had zero connection events for a total outage. The adapter now
     * routes `close` here too, as an {@link ImapConnectionClosedError}, suppressed for teardowns we
     * asked for.
     *
     * ── AND IT COSTS SOMETHING DIFFERENT, WHICH IS THE RULE APPLIED RATHER THAN RELITIGATED ──
     *
     * The rule is explicit that the consequence of a dead connection is DETACH and not
     * quarantine, because quarantine writes `status='error'` plus an exponential backoff for an
     * INFRASTRUCTURE fault — "the socket timed out" rendered to a customer as "your mailbox is
     * broken". That argument does not stop applying because the detector changed. It applies HARDER
     * here: the measured incident timeline fits `WORKER_NET_TIMEOUTS.socketMs` (120 s) → socket timeout →
     * failed NOOP recovery → a silent `close()`, so the event this branch now hears is exactly the
     * one that would have marked a healthy customer's mailbox `error` and bumped its `retry_count` — for a
     * connection the worker's own deadline ended. Any provider that drops an idle connection would
     * do the same on a schedule.
     *
     * So the two shapes are separated, by CLASS and never by a driver string (imapflow has both a
     * `NoConnection` and an `EConnectionClosed`, so keying on either would be keying on its
     * internals):
     *
     *  · the connection ERRORED (`error`: a `BYE`, an `ETIMEOUT`, a TLS failure) → detach AND
     *    quarantine, exactly as before. Unchanged, and `connection-error.e2e.test.ts`
     *    still asserts `quarantined === 1` for it;
     *  · the connection merely ENDED (`close`) → DETACH ONLY. No `status='error'`, no
     *    `error_code`, no `retry_count`, no backoff — so the next roster pass re-dials within
     *    `rosterIntervalMs` (30 s) instead of waiting out `retryBaseMs` (60 s, doubling), and the
     *    row keeps telling the truth. This is what makes it the FAST path; routed into the
     *    quarantine it would have been the slow one.
     *
     * The cost of not quarantining, written down rather than discovered: a provider that accepts
     * LOGIN, allows the lease read and the folder ops, establishes IDLE and THEN closes produces a
     * re-dial every roster interval for ever, where a backoff would have widened to 16 minutes. It
     * is not unbounded and it is not silent — `mailbox_connection_error` + `mailbox_detached` +
     * `mailbox_attach_started` fire on every iteration, and because no cycle ever completes,
     * `last_sync_at` stops advancing and the `sync_lag` rule pages at 15 minutes. A login the
     * provider actually REJECTS still quarantines through `attach()`'s own catch, so the loop only
     * exists for a provider that accepts everything and serves nothing.
     *
     * This is NOT the only detector, deliberately: `guardAsyncErrors` returns early for any client
     * with no event surface, i.e. for every fake in this suite, so `cycle()` independently bounds
     * the lease-unavailable arm by duration and detaches on it. Event-driven detection is the fast
     * path (seconds); the bound is the one that cannot be bypassed by composition.
     *
     * ON THE QUEUE, not inline. Two reasons, and both are correctness rather than tidiness:
     * a detach must never close an adapter a cycle is using, and an error raised DURING
     * `attach()` — which itself runs on the queue — must land after that attach has finished
     * and had its own catch, or the mailbox would be quarantined twice and its backoff would
     * double on the first failure.
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
     * REGISTER one mailbox into the rotation: connect, prove the organizer lease, ensure the
     * folder tree, join `runtimes`, kickstart once, establish IDLE. It does NOT sync — the
     * first drain and restart convergence both ride `cycle()`, and the reason is
     * measured rather than aesthetic: with two inline sync cycles here, one production mailbox held
     * this function for over six minutes and the next mailbox in the roster was not dialled at all until it
     * returned.
     *
     * EVERY failure path closes the adapter it just opened — previously a throw from
     * `ensureFolders()` or the inline drain leaked the connection, because the adapter had not
     * been pushed onto the tracked list yet.
     */
    async function attach(mb: EnabledMailbox): Promise<void> {
      // ── THE SETUP IS INSIDE THE BOUNDARY ──────────────────────────────────────────────────
      //
      // `loadMailboxCreds` and `makeAdapter` used to run ABOVE the `try` below, and that is a
      // shard-wide outage waiting for one corrupt row. A credential envelope that cannot be
      // decrypted — bad ciphertext, a key version this deployment no longer carries — or an
      // `adapterFactory` that refuses one mailbox's configuration threw from OUTSIDE every catch
      // in this file. On a cold start that rejected `startWorkerWithLock`, closed every mailbox
      // already attached and released the shard lock; on a timer roster pass the pass-level catch
      // logged and stopped, so the second and every later unattached mailbox were never visited. The
      // roster is stable oldest-first, so the same bad row led every pass: healthy mailboxes
      // behind it stayed unsynced for ever, and the failing one never reached an accounted retry
      // bucket at all.
      //
      // `adapter` is therefore nullable and the catch below null-guards its close. That is the
      // whole shape of the fix: everything that can fail on behalf of ONE mailbox happens where
      // that mailbox's own catch can see it.
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

        // ── WHAT THIS MAILBOX'S SUBMISSION SERVER WILL ACCEPT (mail 0055) ────────────────────
        //
        // Attempted here because this is a place that already holds decrypted SMTP credentials
        // for a mailbox nobody is asking to change. The rule and its bounds are
        // `learnSmtpMaxSize`'s; the timeouts and the write are `smtp-size.ts`'s.
        //
        // ON THE MANAGED DEPLOYMENT THIS ALWAYS FAILS, and that is measured rather than assumed:
        // Railway blocks outbound submission ports, so every dial from here answers "Connection
        // timeout" while the IMAP dial to the same host on 993 completes in the next log line.
        // The managed service learns these numbers from the API host on a schedule instead. This
        // arm is kept because it is correct wherever egress is open — a self-hosted worker on
        // somebody's own network — and it is bounded to one refused connection per mailbox per
        // process, logged at `info`.
        //
        // AWAITED rather than fired and forgotten, and it is worth saying why: the alternative
        // leaves a promise rejecting into nothing on a path whose whole purpose is that one
        // mailbox's failure stays one mailbox's failure.
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

        // ── THE ORGANIZER LEASE, BEFORE THE FIRST MOVE ────────────────────────────────────
        //
        // Here and not below `ensureFolders()`: every line after this one WRITES to somebody's
        // mailbox. `ensureFolders` creates the `ohmail/*` tree and `runKickstart` re-routes the
        // Screener backlog. If another organizer holds this mailbox, neither may happen — and
        // "learn then act" is the rule for exactly this seam, because reconnect-after-sleep is
        // when a mailbox is most likely to have changed hands.
        //
        // Taking the first DRAIN off this path did NOT move this gate, and the
        // ordering it protects is now guarded rather than argued: `ensure_folders` may not
        // precede `lease_organize` for any mailbox
        // (`test/attach-nonblocking.e2e.test.ts`, claim 5).
        //
        // Standing down here returns EARLY and leaves the mailbox out of `runtimes`, so this
        // attach ends with the connection closed by the `finally`-shaped path below rather than
        // with a quarantine: it is not a failure, so it must not earn a retry backoff. The row
        // is now `disabled`, so the next roster pass does not offer it again.
        //
        // The nonce this gate writes is carried onto the runtime below rather than discarded:
        // it is the clone defence's memory, and a gate whose nonce is thrown away re-arms that
        // defence from scratch on every cycle.
        const leaseState = { leaseNonce: null as string | null };
        const leaseRow = {
          takeoverAuthorizedAt: mb.takeoverAuthorizedAt, disabledReason: mb.disabledReason,
        };
        const tLease = Date.now();
        if (!(await mayOrganize(mb, leaseRow, leaseState, adapter, "attach"))) {
          // `reason: null` — `markMailboxStoodDown` has already written `disabled` plus
          // `disabled_reason` AND cleared the sync-block columns in that same statement. See
          // `SyncBlock`.
          noteBlock(leaseBlocked, mb.mailboxId, null);
          try { await adapter.close(); } catch { /* ignore */ }
          return;
        }
        const leaseMs = Date.now() - tLease;
        leaseBlocked.delete(mb.mailboxId);
        const tFolders = Date.now();
        await adapter.ensureFolders();
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
        let sweepScan: SweepScanState = { after: null, movedSinceTop: false };
        const deps: SyncDeps = {
          repo, adapter, accountId: mb.accountId, mailboxId: mb.mailboxId,
          // ── THE LEADER FENCE OVER THIS MAILBOX'S MAIL-BEARING WRITES ─────────────────────
          //
          // The SAME `fence` the lifecycle writes key on — one definition of "am I still the
          // leader of this shard", never two — extended to everything `runSyncCycle` persists
          // and to its IMAP mutations. Before this line existed, a worker whose advisory lock
          // had dropped kept committing messages, advancing cursors, appending change_log rows
          // and issuing IMAP moves for the rest of its cycle beside the new leader: the fence
          // covered `mailboxes.status` and nothing that carries mail.
          //
          // `() => lockLost` is the synchronous tripwire: `handleLockLoss` flips it the moment
          // loss is observed, so the in-flight cycle refuses its NEXT write and unwinds instead
          // of running out its batch — which is what lets the detach queued behind this cycle
          // actually run. `stopped` is deliberately NOT part of it: a graceful shutdown lets
          // in-flight writes complete, exactly as before.
          fence: makeSyncWriteFence(db, mb.mailboxId, fence, () => lockLost),
          credits: classifyGateFor(mb.accountId),
          // Whose `Authentication-Results` this mailbox may believe, resolved from the
          // SAME host string the adapter above dials. Empty for every provider the table does
          // not name, which routes exactly as before this field existed; for Gmail/Microsoft it
          // is what lets a forged known-contact `From` be demoted to the Screener.
          trustedAuthservIds: providerAuthservIds(creds.imap.host),
          // ── ONE LEDGER PER ATTACHMENT, AND THAT LIFETIME IS THE DESIGN ───────────────────
          //
          // Per mailbox, because a written-off UID is meaningless in another mailbox's folders.
          // Built HERE rather than per cycle, because the two things it remembers are both
          // cross-cycle: how many times a message has already failed, and which UIDs must stay
          // out of the known-set so their bodies are not re-fetched on every pass. A ledger
          // rebuilt per cycle would count every attempt as the first and never reach a terminal
          // decision — which is the wedge, restated.
          //
          // THE PARAGRAPH THAT USED TO BE HERE IS NOW FALSE, and it is worth saying so rather than
          // deleting it: it read "the durable record is owed (a migration is a separate decision),
          // and until it exists a restart is how a parser fix reaches the mail it fixes." That was
          // true, and it was also a mail-loss defect — the Sent folder's cursor is a UID watermark,
          // so a restart does NOT re-offer a skipped Sent UID and nothing ever would. Mail migration 0041
          // landed the table. `runSyncCycle` hydrates this ledger from it at the top of every cycle
          // and re-reads owed UIDs by UID, so this object being dropped on detach now costs nothing
          // at all.
          deadLetters: new DeadLetterLedger(),
          // ── ONE KNOWN-SET MEMO PER ATTACHMENT, FOR THE SAME REASON AS THE LEDGER ────────
          //
          // `buildCursor` re-read this mailbox's ENTIRE `message_instances` join at the top of
          // every cycle — thousands of rows a call on a real mailbox, once per poll interval, for the
          // life of the attachment. It is state this process wrote and that nobody else may write
          // while it holds the mailbox, so it is remembered instead, and any write that could move
          // it drops the memo. See `known-set.ts`.
          //
          // Built HERE and not per cycle, because per-cycle is what it already was. Built per
          // ATTACHMENT and not per process, because the lifetime is the safety argument: a mailbox
          // that changes hands is detached and re-attached, and the new runtime starts cold. It is
          // dropped explicitly on detach, on the lock-loss tripwire and on every stand-down below,
          // rather than left to garbage collection — a memo of somebody else's mailbox must stop
          // existing at the moment leadership is in doubt, not at the moment nothing references it.
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
               * window inside one cycle (review rounds 3 and 4).
               */
              const res = await junkSweepPass({
                db: db as unknown as Tx, repo: fencedRepo, adapter: attachedAdapter,
                accountId: mb.accountId, mailboxId: mb.mailboxId, execute: true, guard: hooks.guard,
                limit: JUNK_SWEEP_PER_CYCLE,
                ...(sweepScan.after !== null ? { afterId: sweepScan.after } : {}),
              });
              const adopted = adoptSweepWindow(sweepScan, {
                movedCount: res.moved.length,
                candidates: res.candidates.length,
                lastId: res.candidates.at(-1)?.messageId ?? null,
                junkFolder: res.junkFolder,
              }, JUNK_SWEEP_PER_CYCLE);
              sweepScan = adopted.state;
              return {
                moved: res.moved, skipped: res.skipped, junkFolder: res.junkFolder,
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

        // ── REGISTERING THE MAILBOX *IS* WHAT ATTACH IS FOR ────────────────────────────────
        //
        // This line used to be a fix for a reporting bug — `reconcileOnRestart` drained inline
        // below it, `runtimes` stayed empty for the length of that drain, and `stats()` plus
        // every heartbeat said `mailboxes: 0` while the process was doing the single busiest
        // thing it ever does. Measured in production: a first import ingested thousands of
        // messages over most of an hour while the heartbeat reported zero mailboxes, and
        // "hard at work" was indistinguishable from "dead".
        //
        // Now the drain is gone from this function and this line is the POINT of it,
        // not a mitigation: attach connects, proves the lease, ensures the folders, joins the
        // rotation and establishes IDLE. Everything that reads mail rides `cycle()`, which
        // already owns bounded batches, the `hasBacklog` re-kick and the `last_sync_at` stamp.
        // Measured cost of the old shape, twice in production: about six minutes each time
        // for one mailbox, during which the NEXT mailbox was not dialled at all.
        //
        // `unwatch` is null until IDLE is established a few lines down and is patched onto the
        // same object; `detach()` already tolerates a null `unwatch`, and the serial queue
        // guarantees no cycle or roster pass interleaves with a mid-flight attach — including
        // with mid-cycle adoption, because a mid-cycle pass runs INSIDE the cycle's queue entry rather
        // than beside it, so this attach still has the queue to itself for its whole duration.
        //
        // The failure path is unchanged: the catch below deletes the runtime and quarantines, so
        // a mailbox that dies in `runKickstart` or `watch` does not linger in the rotation.
        const rt: MailboxRuntime = {
          accountId: mb.accountId, mailboxId: mb.mailboxId, adapter, deps, unwatch: null,
          failures: 0, lastSuccessAt: null, leaseNonce: leaseState.leaseNonce,
          lease: leaseRow,
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

        // ── MAKE THE MAILBOX SCREENER-SHAPED, ONCE, BEFORE THE FIRST DRAIN ───────────────
        //
        // Here and not in `cycle()`: it is a once-per-mailbox pass (`mailboxes.kickstart_at`,
        // mail migration 0025), and it has to run BEFORE the first drain. Import the Sent folder's
        // recipients into `contacts` first and the very first routing decision already knows who
        // the user's correspondents are; import them afterwards and hundreds of messages have already
        // been filed into the Screener and need re-routing.
        //
        // Moving the drain from the line below this one onto the cycle loop left the
        // ordering intact for a reason worth stating: the first cycle is queued
        // behind the roster pass this attach belongs to, so it cannot begin until every attach
        // of the pass — and therefore this kickstart — has returned.
        //
        // Mid-cycle adoption restated the mechanism without weakening the guarantee, and the old wording
        // ("queued behind … (`serialize`)") is now false, which is why it is rewritten rather
        // than left standing. A roster pass can now run mid-cycle, from inside that cycle's own
        // queue entry (`yieldToRoster`). The ordering re-derives from two facts: the mailbox
        // attached here is NOT in the running cycle's `rotation`, which was snapshotted at its
        // top, and the mid-cycle pass is AWAITED, so it returns only once every attach — hence
        // every kickstart — has finished. This mailbox's first `runSyncCycle` is therefore the
        // `kickCycle` entry the pass queued, which is strictly behind the cycle in flight.
        //
        // It stays here
        // rather than moving to the cycle because it is once-per-mailbox and marker-gated, and a
        // virgin mailbox's Screener backlog is empty, so it is cheap on the one path that must
        // stay fast.
        //
        // A FAILURE HERE MUST NOT FAIL THE ATTACH, for the same reason a model fault must not:
        // the mailbox is connected and its folders exist, and shaping is an improvement to
        // routing, not a precondition for it. The marker is written only on success, so the
        // next attach simply tries again — and a mailbox whose Sent folder is unreadable still
        // syncs perfectly well, it just screens more.
        const tKickstart = Date.now();
        try {
          const shaped = await runKickstart({
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

        // ── NOTHING THAT DRAINS RUNS HERE — A RULE NOW APPLIED TO THE DRAIN ITSELF ────────
        //
        // Two changes deleted work from this exact line, for the same reason, and the second one
        // is the reason the first was not enough.
        //
        // The first version ran `runThreadBackfill` here: pure database work, minutes of it on a
        // large backlog, while the connection above was dialled, authenticated, NOT yet
        // in IDLE (`adapter.watch` is below) and with nothing awaiting it. The socket outlived
        // its timeout, imapflow emitted the failure on a client with no `error` listener, and an
        // uncaught exception took the process down every ~26 s for eight minutes. `try/catch`
        // could never have helped: the throw did not come out of the call it wrapped. The rule
        // was therefore stronger than "catch it" — **nothing that does not need the connection
        // runs while the connection is held and unattended.**
        //
        // A later measurement covered what was STILL here: `reconcileOnRestart`, two full sync cycles.
        // About six minutes for one mailbox against 2.3 s for the
        // other, twice, with the next mailbox's `attach_started` 88 ms after the previous
        // `attached` — so at `maxMailboxes=64` the last mailbox is not dialled for hours after a
        // deploy. And because `last_sync_at` is stamped by `cycle()` and by nothing else, a boot
        // spent draining here fired `sync_lag` saying "their owners are not receiving mail" about
        // mailboxes that were visibly ingesting in the same log. Every deploy paged falsely.
        //
        // So restart convergence rides `cycle()` now, and it needs nothing new to do it: the
        // cycle already re-verifies the lease, runs the SAME `runSyncCycle`, owns bounded batches
        // and re-kicks itself while `hasBacklog`, and stamps `last_sync_at`. Two
        // consequences that used to need arguing are now facts of the shape:
        //
        //  · convergence is no longer once-per-attach but every-cycle-until-converged, which is
        //    strictly stronger than the two passes `reconcileOnRestart` promised;
        //  · a model fault can no longer fail an attach, because no classifier runs on this path.
        //    The `ClassifierFaultError` exemption that used to sit here is now only in `cycle()`,
        //    where the class is exempted for the same reason it always was.
        //
        // The guard is `test/attach-nonblocking.e2e.test.ts`: B's `connect()` must
        // precede A's first AND second `changesSince`, and A's backlog must drain over several
        // cycles on ONE connection. Re-adding a single `await runSyncCycle(deps)` here turns it
        // red — that mutation was watched fail when the change landed.
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
        // ── THE QUARANTINE ENTRY IS *NOT* CLEARED HERE. IT MOVED WITH THE DRAIN ───────────
        //
        // `quarantine.delete(mb.mailboxId)` was the last line of this function, and its reason was
        // exact: the entry carries the exponential backoff's attempt count, and clearing it BEFORE
        // the drain would reset a struggling provider's backoff to the base delay on every retry —
        // the mailbox hammered at the minimum interval for ever.
        //
        // The drain moved, so "the end of a successful attach" IS now "before the drain",
        // and leaving the delete here reintroduces exactly that bug for the one class of mailbox it
        // was written about: a login the provider accepts whose every sync cycle throws. Attach
        // would succeed, clear the count, the cycles would fail into a fresh attempts=1 quarantine,
        // the next roster pass would attach again, for ever at `retryBaseMs`. Nothing about that is
        // observable in `stats()` — `quarantined` excludes anything in `runtimes` — so it would have
        // been a silent DoS against a customer's provider.
        //
        // It is therefore spent on the first SUCCESSFUL cycle, beside the recovery write and for
        // the same reason: both are claims that the mailbox works, and only a completed cycle is
        // evidence of that. Guarded in `mailbox-failure.e2e.test.ts` ("the backoff GROWS"), which
        // asserts the `retryInMs` sequence rather than the row's monotonic counter — the counter
        // grows either way and cannot see this.

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
        // ── THE RECOVERY WRITE IS NOT HERE. IT IS ON THE CYCLE PATH ───────────────────────
        //
        // It used to be, and the definition it enforced was "connect + folders + two full sync
        // cycles + IDLE": the heartbeat may count a mailbox that is mid-drain, but the STATUS
        // COLUMN may only say `connected` about one that has actually synced. That invariant is
        // unchanged and still worth exactly as much — a mailbox whose login works but whose every
        // cycle throws must not flip error → connected → error on each backoff retry, or Settings
        // shows "connected" flashes about a mailbox that has never once synced.
        //
        // What changed is that "two inline cycles" was a PROXY for "actually synced", available
        // here only because the drain was here. With the drain on the cycle loop the real thing
        // is available instead: `rt.needsRecovery` is spent in `cycle()` after the first
        // successful `runSyncCycle`, and a mailbox whose cycles all throw accumulates toward
        // quarantine without ever being called connected. Writing it here now would be strictly
        // weaker than the line it replaced — it would mean "the login worked".
      } catch (err) {
        if (unwatch) { try { await unwatch(); } catch { /* ignore */ } }
        if (adapter) { try { await adapter.close(); } catch { /* ignore */ } }  // never leak a half-open login
        runtimes.delete(mb.mailboxId);
        // ── A SHARED-SERVICE FAULT IS NOT THIS MAILBOX'S FAULT ───────────────────────────────
        //
        // The credential read moved inside this `try`, and that read is a DATABASE read. Left
        // unexempted, one database blip would quarantine every mailbox of the shard in turn and write
        // `status='error'` on each — "the database was unreachable for ninety seconds" rendered as
        // "your mailbox is broken", which is a measured incident's exact shape. So it is
        // rethrown instead: the roster pass fails, no mailbox row is touched, no backoff is
        // earned, and the next pass retries the whole roster.
        //
        // Exempted BY CLASS, like `LeaseUnavailableError` below it — the same reason, that a
        // threshold cannot be tuned into a wrong answer. Everything genuinely attributable to THIS
        // mailbox (an envelope that will not decrypt, an adapter that refuses its configuration, a
        // login the provider rejects) still quarantines exactly as before, and iteration continues
        // to the next mailbox instead of the pass dying on the first bad row.
        if (isDatabaseFault(err)) {
          log.error("mailbox_attach_database_fault", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "a shared database or transport failure, NOT this mailbox — the roster pass " +
              "fails without marking any mailbox at fault, and the next pass retries",
          });
          throw err;
        }
        // A LEASE WE COULD NOT READ IS NOT A BROKEN MAILBOX, and it must not be quarantined into
        // an exponential backoff. Exempted BY CLASS, the pattern `ClassifierFaultError` already
        // establishes below: exempting by class rather than by threshold arithmetic is what
        // keeps "an infrastructure fault can never quarantine a mailbox" true at every tuning of
        // `maxSyncFailures`. The mailbox is simply not attached this pass; the next roster pass
        // — thirty seconds — tries again, and the ONLY thing that did not happen is organizing
        // a mailbox we could not prove was ours.
        //
        // Since mail migration 0029: it RECORDS, and `reconcileSyncBlocks` decides whether the state has lasted
        // long enough to be worth the row. Until that split existed this arm's `log.warn` was the
        // ONLY trace of a mailbox nothing was syncing, and it once stayed the only trace for half an hour.
        if (err instanceof LeaseUnavailableError) {
          noteBlock(leaseBlocked, mb.mailboxId, "lease_unreadable");
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

      // ── SAY SOMETHING BEFORE THE FIRST ATTACH, AND LEAVE DURABLE EVIDENCE ──────────────
      //
      // A boot-time outage was once invisible for two hours, and this is the half of that which
      // is not about locks. A leader whose first roster pass blocks inside `attach` — a hung
      // provider dial, a first `ensureFolders` against a real server, a database wait — had
      // written NO heartbeat row and emitted NO log since taking the lock. From the outside,
      // "wedged mid-boot" and "never started" and "no mailboxes to serve" are the same thing:
      // an absence. Nothing can page on an absence it cannot distinguish from idleness.
      //
      // So the beat happens before anything that can BLOCK. It is deliberately a beat and not
      // just a log: a log line is only visible to whoever is tailing, while the heartbeat row
      // is what an EXTERNAL watchdog reads. `beat()` is already best-effort, so a failed write
      // here cannot stop the boot it is reporting.
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

      // …AND THE FIRST BEAT SAYS WHAT THE DUTY IS, NOT `0/0`.
      //
      // The boot beat used to fire above this block, before the roster was even read, so the
      // first row a watchdog ever saw was `mailboxes: 0, expected: 0, degraded: false` — which
      // reads as "this worker is healthy and has nothing to do". For a leader about to spend
      // three minutes attaching two real mailboxes that is the most misleading sentence the row
      // can contain, and it is what an operator was looking at during the incident.
      //
      // Moved to HERE, after `expected` is known, it says `0/2, degraded` instead: booting, not
      // yet serving. The blocking risk that trade reintroduces is exactly one DB read — against
      // the same database the beat itself writes to, so a read that hangs would have hung the
      // beat too.
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

      // Detach anything no longer in the duty: soft-disabled (the billing-downgrade path), deleted,
      // or pushed out of the cap. Leaving it attached keeps an IDLE connection open — and keeps
      // syncing a mailbox whose credentials may already have been deleted.
      for (const rt of [...runtimes.values()]) {
        if (stopped) return;
        if (!desired.has(rt.mailboxId)) {
          // ── NOT WHILE A LANE IS INSIDE IT ────────────────────────────────────────────────
          //
          // This is the ONE detach reachable from inside a running cycle — a roster pass served
          // by `yieldToRoster` — and with lanes it can now land on a mailbox whose `changesSince`
          // is suspended. Closing that adapter would abort a batch mid-flight and, through
          // `releaseOrganizerClaim` below, hand the mailbox away while this process is still
          // organizing it.
          //
          // DEFERRED, never skipped: the cycle drains `deferredLeaves` once its lanes have
          // joined, so the mailbox leaves in the same cycle it stopped being ours in. The
          // duty-gap check further down is not affected — a mailbox still in `runtimes` is
          // `served` by it, which is what it is until the drain runs.
          if (laneBusy.has(rt.mailboxId)) {
            deferredLeaves.push({
              rt, release: true, reason: "no longer an enabled mailbox of this shard",
            });
            continue;
          }
          // ── THE ENTITLEMENT LAPSE RELEASES THE CLAIM, NOT JUST THE ROSTER ROW ──────────
          //
          // BEFORE the detach, because the detach closes the connection that can do it. This is
          // the ONLY teardown path that releases, and the discrimination is the point:
          // `detach` is also reached by a connection error, a quarantine, a lost lock and a
          // clean stop, and in every one of those Cloud fully intends to keep organizing — a
          // release there would hand the mailbox to a desktop install on every deploy.
          //
          // Leaving the duty is the opposite: the account lapsed, the user disconnected the
          // mailbox, or the cap evicted it. In all three Cloud has stopped being this mailbox's
          // organizer, and a live claim it no longer renews is what makes the user's own machine
          // stand ITSELF down for the length of the staleness window — a leave-anytime product
          // whose "Organize from this Mac" button appears to do nothing for ten minutes at
          // exactly the moment somebody chose to leave.
          await releaseOrganizerClaim(rt, "this mailbox is no longer an enabled mailbox of this shard");
          await detach(rt, "no longer an enabled mailbox of this shard");
        }
      }
      for (const id of [...awaitingCreds.keys()]) if (!desired.has(id)) awaitingCreds.delete(id);
      for (const id of [...quarantine.keys()]) if (!desired.has(id)) quarantine.delete(id);
      for (const id of [...leaseBlocked.keys()]) if (!desired.has(id)) leaseBlocked.delete(id);

      // ── ATTACH WHAT IS MISSING, THEN KICK A CYCLE IF ANYTHING NEW CAME UP ────────────────
      //
      // `attach()` syncs nothing at all, so a mailbox that joins the rotation here
      // has no mail processed until a cycle runs — and `setInterval` fires for the FIRST time only
      // after a full period, which in production is 60 s. That is the same 68 s dead window the
      // takeover kick below `worker_serving` was measured against and exists to close, reopened
      // per mailbox at every roster pass. Nothing fails and NOTHING LOGS if this kick is
      // forgotten, which is why it is guarded (`attach-nonblocking.e2e.test.ts`, claim 7) rather
      // than trusted.
      //
      // In a `finally`, so an `attach` that rethrows a shared-database fault mid-loop still kicks
      // for the mailboxes it did bring up before the pass died. `kickCycle` is idempotent
      // (`cycleQueued`), checks `stopped` itself, and queues behind this pass rather than
      // interleaving with it.
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
              takeoverAuthorizedAt: mb.takeoverAuthorizedAt, disabledReason: mb.disabledReason,
            };
            // CONVERGE THE ROW ONTO REALITY — but only about a mailbox that has actually SYNCED.
            //
            // This mailbox is attached; if its row still says `error` the recovery write failed or
            // was fenced, and until this line existed NOTHING retried it. The old comment claimed
            // "the next roster pass writes it" and this loop's `continue` was the proof that it did
            // not — the mailbox would sync perfectly while Settings → Mailboxes and the admin
            // console called it broken, for the life of the process. `mb.status` is re-read from
            // the database every pass, so this is a no-op the moment the write lands.
            //
            // `lastSuccessAt !== null` is the non-blocking-attach half. Before it, "attached" implied "drained
            // twice", so being in `runtimes` was itself evidence of a sync. It no longer is, and
            // without this clause a mailbox whose login works and whose every cycle throws would be
            // converged to `connected` by this pass 30 seconds later — resurrecting, from the
            // roster, exactly the "connected flashes on a mailbox that has never synced" the attach
            // path was careful never to write.
            if (mb.status !== "connected" && attached.lastSuccessAt !== null) await markRecovered(mb);
            continue;
          }
          // ── THE BACKOFF GATE, AND SINCE MAIL MIGRATION 0039 THE ROW CAN OVERRULE THE MAP ─
          //
          // Three cases, and the ORDER of the first two is the whole of the release path:
          //
          //  1. an entry whose durable write LANDED (`persisted`) is governed by `mb.retryAfter`,
          //     re-read from the database on this very pass. `retry_after IS NULL` therefore means
          //     "somebody cleared it" — the admin release write — and this mailbox is attached
          //     NOW instead of waiting out a ladder nobody can otherwise reach. The map entry is
          //     deliberately NOT deleted: `attempts` is the ladder's input, and resetting it here
          //     would hand a struggling provider a fresh minimum-interval retry loop. A release
          //     buys one immediate attempt, not a clean slate;
          //  2. an entry whose write did NOT land falls back to `q.retryAt`, which is the
          //     pre-0039 behaviour exactly. See `Quarantine.persisted` for why a NULL column must
          //     not be read as a release when we never wrote it;
          //  3. NO map entry but a future `retry_after` on the row — a mailbox this process has
          //     never quarantined because the process is NEW. It is SEEDED below rather than
          //     attached, which is the half that makes a quarantine survive a restart at all.
          const q = quarantine.get(mb.mailboxId);
          if (q) {
            const until = q.persisted ? (mb.retryAfter?.getTime() ?? null) : q.retryAt;
            if (until !== null && now < until) continue;
          } else if (mb.retryAfter && now < mb.retryAfter.getTime()) {
            // ── THE RESTART SEED ────────────────────────────────────────────────────────────
            //
            // Without this a fresh leader forgets every backoff and re-dials every parked mailbox
            // at once, which is (a) the gap this column was added to close, still open, and (b) a
            // way to turn a deploy during a provider outage into a burst of retries. Two details
            // are load-bearing:
            //
            //  · `attempts` is floored at the row's `retry_count`, so the ladder resumes where the
            //    outage actually is instead of restarting at the base delay. The two counters are
            //    allowed to disagree (`mailboxes.ts` says why), and this is the one place the
            //    durable one is the better estimate — the alternative is attempt 1 for a mailbox
            //    that has failed forty times;
            //  · `persisted: true`, because this entry was READ from the column. It is governed by
            //    the column from here on, so an operator's release reaches it on the next pass.
            //
            // Seeding also keeps the roster invariant honest: `unexplained` below counts anything
            // neither served, awaiting credentials, quarantined nor lease-blocked, so a mailbox
            // skipped on the row alone would log `roster_invariant_violated` every 30 s and page a
            // human about correct behaviour.
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
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  THE SINGLE WRITER OF `sync_blocked_reason` (mail migration 0029)
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * One place reads the three buckets, compares elapsed time against ONE threshold, and writes
     * or clears. The catch arms above only RECORD, and that split is the design rather than
     * tidiness: an arm that decided for itself would need its own copy of the grace, its own
     * fenced write, and its own idea of when to clear — three copies, in the three places least
     * likely to be exercised. It is also what makes the credentials and capacity arms fall out for
     * free: they were never about the lease, they were about a mailbox nobody is serving.
     *
     * ── LAST IN THE ROSTER PASS, DELIBERATELY ─────────────────────────────────────────────
     *
     * `attach` runs above it and populates this pass's buckets, so a mailbox that recovered this
     * pass is cleared in the same pass rather than one interval later. `selected` is used and not
     * `served`, because the capacity arm's mailboxes are precisely the ones `served` excludes.
     *
     * ── WHY THE WRITE REPEATS AND THE CLEAR DOES NOT ──────────────────────────────────────
     *
     * A blocked mailbox is re-written every pass. That is idempotent — `markMailboxSyncBlocked`
     * COALESCEs `sync_blocked_since`, so the column holds the start of the block and not the time
     * of the latest pass — and it is what CONVERGES the row when another writer clears the columns
     * while the block is still in force (`PATCH /mailboxes/:id` with a status change does exactly
     * that). A write-once design would leave that row silent for the life of the process.
     *
     * The clear, by contrast, is gated on the row ACTUALLY CARRYING a reason, read fresh from the
     * database this pass. Without that gate a healthy shard would issue one pointless UPDATE per
     * mailbox per roster interval, for ever.
     *
     * ── BEST-EFFORT, ALWAYS ───────────────────────────────────────────────────────────────
     *
     * This is bookkeeping about mailboxes that are ALREADY not being served. A failure here must
     * not abort the roster pass that is attaching the healthy ones, and a worker deployed ahead of
     * mail migration 0029 fails every one of these writes on a column that does not exist yet — which is
     * loud in the log and harmless to the rotation, exactly as `markMailboxFailed`'s own
     * best-effort treatment was for its own column.
     */
    async function reconcileSyncBlocks(selected: readonly EnabledMailbox[]): Promise<void> {
      const nowMs = Date.now();
      for (const mb of selected) {
        if (stopped) return;
        const block = leaseBlocked.get(mb.mailboxId)
          ?? awaitingCreds.get(mb.mailboxId)
          ?? capDropped.get(mb.mailboxId);
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
      // ── AND MAKE IT AUDIBLE TO A CYCLE THAT IS ALREADY BLOCKED ON ITS LANES ────────────────
      //
      // `yieldToRoster` is at the top of the dispatcher loop, and that loop only goes round when
      // a lane finishes. So a pass owed while every lane is inside a long batch waited out a
      // bounded batch (~254 s measured) before it was even LOOKED at — the adoption fix's residual
      // ("the residual bound is ONE bounded batch"), unchanged by lanes on their own. The nudge
      // spends it: the pass is served at the next turn of the loop, with the lanes still running.
      //
      // Safe for exactly one reason, and it is the reason `laneBusy` exists: the pass's detach
      // loop skips any mailbox a lane is inside. Everything else it does — attaching a mailbox
      // with no lane, recomputing the duty, converging rows — never touches a live batch.
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
     * Run the owed pass, if it is still owed.
     *
     * The flag is cleared BEFORE the await, not after: a timer tick landing while the pass is
     * running is a request for the NEXT pass — it has not been served by a read that already
     * happened — and clearing afterwards would swallow it.
     *
     * Reached from two places, never concurrently: the queued entry above, and `yieldToRoster`
     * from inside a running cycle. Both are on the one queue, so "the queued entry starts while
     * a cycle holds the queue" is not a state this program has.
     */
    async function servePendingRoster(): Promise<void> {
      if (stopped || !rosterPending) return;
      rosterPending = false;
      const waitedMs = Date.now() - rosterPendingSince;
      // ── THE HALF OF THE STARVATION FINDING THAT WAS "AND NOTHING SURFACES IT" ──────────
      //
      // A pass that is owed and cannot run emitted NOTHING while it was happening: no log, no
      // counter, no column. `mailboxes`/`expected` in the heartbeat cannot show it — they are
      // written BY the pass that is not running — so from the outside a starved shard and a
      // healthy one are the same row. This line is the difference, and it is a `warn` because
      // a pass later than its own interval means one queue entry ran longer than the interval,
      // which is worth knowing even when it is a legitimately slow backfill.
      //
      // `latencyMs` and not `waitedMs`, which is the name this line wants: the logger's
      // ALLOWED_FIELDS list is the primary redaction control and a key that is not on it has its
      // VALUE dropped, silently, leaving a line that reports a delay without saying how long.
      // Widening that list is a change to the shared logger for one call site, so the call site
      // takes the existing name instead. Proven rather than assumed — the first version of this
      // line emitted `waitedMs` and its own test read `NaN`.
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
     * Hand the queue to an owed roster pass, from inside the cycle that is holding it.
     *
     * CALLED FROM EXACTLY ONE PLACE: the top of the rotation's dispatcher loop, which is the only
     * point in a cycle where no mailbox is being TAKEN and the runtime map is not being walked.
     *
     * ── WHAT THIS COMMENT USED TO SAY, AND WHY IT CHANGED ────────────────────────────────────
     *
     * It said "…WHERE NO ADAPTER OPERATION IS SUSPENDED: between two mailboxes of the rotation.
     * That restriction is the whole safety argument". The restriction bought exactly one thing —
     * a pass may never close an adapter somebody is using — and lanes make it no longer literally
     * true, so the property is now enforced by name rather than inherited from the shape:
     * `laneBusy` holds the mailbox ids a lane is inside, and `reconcileRoster` defers their
     * detach (and their claim release) to `deferredLeaves` instead of doing it under a live batch.
     *
     * The same comment declined a tighter adoption bound: "the residual bound is ONE bounded
     * batch rather than one roster interval, and that trade is deliberate: the tighter bound is
     * only purchasable with real concurrency between `attach` and a running cycle, and that is
     * how a mailbox ends up with two organizers." The premise was too broad. Two organizers come
     * from two things organizing ONE mailbox; a mailbox being attached has no lane, and the
     * rotation's per-account key keeps every other mailbox to one visit at a time. So the bound
     * IS the roster interval now — `requestRoster` nudges a cycle blocked on its lanes — and the
     * one thing this worker may never do is still impossible, structurally.
     *
     * `reconcileRoster` is called through `servePendingRoster` DIRECTLY and never through
     * `serialize`: this code is already inside the queue's running entry, and `tail.then(...)`
     * would wait for an entry that cannot finish until this call returns.
     */
    async function yieldToRoster(): Promise<void> {
      if (stopped || !rosterPending) return;
      // ── A ROSTER PASS THAT THROWS MUST NOT TAKE THE ROTATION WITH IT ───────────────────────
      //
      // `requestRoster`'s own queued entry has always caught this and said why — *"a roster pass
      // is a DB read: a failure is a DB blip, not a reason to stop serving the mailboxes already
      // attached"* — and the in-cycle path had no catch at all. The same failure was therefore
      // tolerated on one path and fatal on the other, which was an asymmetry rather than a
      // decision.
      //
      // It is not cosmetic, and the shape it produces is a livelock. `loadEnabledMailboxes` reads
      // through the bare handle rather than the tagged repo, so a dead database throws an
      // UNTAGGED `ECONNREFUSED` here — which `isSharedDatabaseFault` correctly declines to call
      // ours (it is byte-identical to a dead IMAP host, see `db-fault.ts`). Uncaught, that throw
      // left `cycle()` BEFORE a single lane had been admitted, so:
      //
      //   · no lane ran, so no TAGGED fault was ever raised, so `noteDatabaseFault` never fired
      //     and `/health` kept answering `degraded: false` through a total outage — the
      //     announcement path bypassed entirely, by a read that happens before it;
      //   · `kickCycle`'s backstop could not cover it either, for the same reason: it asks
      //     `isSharedDatabaseFault`, and this throw is untagged;
      //   · and the next cycle did the same thing, for as long as the outage lasted.
      //
      // Caught here, the pass is skipped, the rotation runs, the lanes meet the database through
      // the tagged repo, and the outage is announced by the arm that exists for it. Measured:
      // `shared-db-fault.pg.test.ts` times out waiting for the outage to reach a cycle without
      // this, and the frequency tracks how often a pass is owed — which is why it surfaced when
      // `requestRoster` began nudging a running cycle rather than only the timer serving it.
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
      // ══════════════════════════════════════════════════════════════════════════════════════
      //  A MAILBOX THAT HAS NEVER SYNCED GOES TO THE FRONT, NOT THE BACK
      // ══════════════════════════════════════════════════════════════════════════════════════
      //
      // This used to be `[...runtimes.values()]` walked in Map insertion order, which is roster
      // order, which is oldest-first. So the newest mailbox on the shard is served LAST, and its
      // first sync waits out every other mailbox's bounded batch. Mid-cycle adoption fixed the
      // ADOPTION term
      // of that and wrote the residual down in the same breath — *"one backfilling mailbox still
      // dominates ~10 minutes today"* — and this is that residual, which is the larger term:
      // attach is under a second, the first CYCLE is the whole rotation.
      //
      // Measured in production, on a shard with three cold
      // backfills: a newly created mailbox attached in 601 ms and its first cycle came
      // 12.8 minutes later — by which time its provider had closed the idle connection, so that
      // cycle raised `LeaseUnavailableError(NoConnection)`, the mailbox was detached and
      // re-attached at the BACK of the rotation, and the next 13 minutes did the same thing.
      // `coalesce(last_sync_at, created_at)` aged past an hour and a half with `status='connected'` throughout.
      // A re-attach appends to the Map, so a mailbox whose connection cannot survive one rotation
      // is deterministically served last for ever: it is not slow, it is a livelock.
      //
      // TWO CHANGES. The first-syncer rule's own text said "and neither is concurrency", quoting
      // the earlier ruling that a strict adoption bar "is only purchasable with real concurrency between
      // attach and a running cycle, and that price is the dual-organizer bug". The lanes buy some of
      // that concurrency and do NOT pay that price — see the lane block below — but the
      // ordering is unchanged and is still what decides who is served first:
      //
      //  1. the pass starts with the runtimes that have never completed a cycle, oldest-first
      //     within each group, so ordering is still stable and every mailbox still gets exactly
      //     one bounded batch per pass;
      //  2. a never-synced runtime the interleaved roster pass adopts MID-PASS is admitted to the
      //     FRONT of what is left, instead of waiting for the next pass. Without this the fix
      //     would not cover the case it was found in — a mailbox connected during somebody
      //     else's backfill — because that mailbox is not in the snapshot at all.
      //
      // `lastSuccessAt` and not the row's `last_sync_at`, deliberately: it is per RUNTIME, so a
      // mailbox that synced for days and was then detached and re-dialled comes back as a
      // first-syncer for one pass. That is the intended reading — a fresh connection has proven
      // nothing yet, and a mailbox whose connection keeps dying is exactly the one that must not
      // be served last.
      //
      // THE BOUND IS `servedIds`, and it is what keeps a LIVE queue finite: one turn per mailbox
      // id per pass. Without it, a mailbox that is re-attached by every roster pass (the
      // production case above) could be re-admitted indefinitely inside one cycle.
      //
      // ── AND THE SECOND GROUP: WHOEVER RANG THE DOORBELL ─────────────────────────────────────
      //
      // Between the first-syncers and everybody else sit the mailboxes with an unserved wake —
      // an IDLE that fired, or an enforced-sync stamp. They are the mailboxes with a person
      // waiting at the other end, and before this they were ordered by nothing at all: the wake
      // asked for A cycle and then took its ordinary place in it, which is how a sub-second wake
      // channel produced a 15.5-minute visit gap. Oldest wake first inside the group.
      //
      // BELOW the first-syncers and not above them, because the first-syncer production case is the
      // worse one: a never-synced mailbox that is served last is a livelock, while a woken one
      // that waits a turn is a delay. The two groups mostly do not compete anyway — a first sync
      // is heavy and a wake is light, so the lane reservation below puts them in different lanes.
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
       * Re-admit a mailbox whose doorbell rang AFTER its turn in this pass.
       *
       * Without this, lanes shorten the rotation and leave the CYCLE as the unit a wake waits for:
       * one bounded batch, ~254 s measured, for a signal that answered in under a second. With it,
       * and with a lane held back for mailboxes that owe nothing, the wait is the time to find a
       * free lane.
       *
       * FOUR CONDITIONS, and each is load-bearing rather than defensive:
       *
       *  · an unserved wake (`wokenAt`), which is the only thing that earns a second turn at all.
       *    It is spent on admission, so this cannot re-trigger on its own;
       *  · already served this pass — a mailbox that has NOT had its turn is in `pending` already
       *    and must keep the first-syncer ordering rather than being moved by this;
       *  · not currently in a lane. A mailbox mid-visit will observe its own wake on the next pass
       *    (the wake outlives the visit, deliberately — see `MailboxRuntime.wokenAt`), and
       *    re-admitting it here is the one thing that would break per-mailbox serialization;
       *  · under {@link CYCLE_WAKE_REVISITS}, which is the floor under the hole this puts in
       *    `servedIds`. Past it the mailbox KEEPS its wake and leads the next pass, which is the
       *    pre-lane behaviour — so the worst case of this mechanism is what shipped.
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
       * Re-apply the PLANNING order to what is left of `pending`, so a wake that lands MID-PASS
       * for a mailbox that has NOT had its turn yet moves it forward instead of leaving it at its
       * snapshot position.
       *
       * `admitWoken` above handles the already-served half of the wake story; this is the other
       * half, and it was the measured one: the pass plans its order once at the top, so a
       * doorbell that rang two seconds into a seven-minute pass for the last mailbox in the
       * snapshot bought nothing at all — probe 2 of the 2026-08-26 measurement waited 478 s with
       * `wokenAt` set the whole time, because its position was fixed before its wake existed.
       *
       * A STABLE re-partition into the exact three groups the planner used — first-syncers
       * (their internal order untouched), then woken by oldest wake, then the rest in their
       * existing order — so this cannot invert anything the planning comment promises. It moves
       * mailboxes only BETWEEN dispatcher turns (never a runtime a lane holds — those are not in
       * `pending`), consumes nothing, and admission still applies every rule (`servedIds`,
       * account exclusivity, the heavy cap) at the moment a lane is filled. Runs on every
       * dispatcher turn; the array is at most the shard's mailbox count, so the sort is noise.
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

      // ══════════════════════════════════════════════════════════════════════════════════════
      //  THE ROTATION RUNS SEVERAL MAILBOXES AT ONCE, AND WHICH ONES IS THE DESIGN
      // ══════════════════════════════════════════════════════════════════════════════════════
      //
      // Everything above this line is still true: one queue entry, one turn per mailbox per pass,
      // first-syncers-first ordering, the mid-pass roster service. What changes is that the walk pulls
      // up to `cycleLanes` mailboxes at a time instead of one, under three admission rules. Each
      // is a load-bearing invariant rather than a tuning choice, and each has a mutation recorded
      // in `roster-serialization.pg.test.ts`.
      //
      //  1. ONE CYCLE PER MAILBOX, ALWAYS. Structural and unchanged: `servedIds` bounds a mailbox
      //     to one turn per pass, and the queue bounds the process to one `cycle()` at a time, so
      //     there is no composition in which two cycles of one mailbox overlap. Per-mailbox
      //     serialization is load-bearing in `sync.ts`, in the fence, and in the organizer lease,
      //     and nothing here weakens it.
      //
      //  2. ONE CYCLE PER ACCOUNT. The concurrency key is the ACCOUNT, not the mailbox, which is
      //     a strictly stronger claim than (1) and is here for a measurable reason rather than
      //     caution: `recordChange` → `allocateSeq` takes the account's `account_sync_state` ROW
      //     LOCK and holds it to commit (`packages/db/src/change-log.ts`). Two mailboxes of one
      //     account running at once would meet on that row, and the worker's connections carry
      //     `lock_timeout: 30_000` (`WORKER_TIMEOUTS`), so the meeting is either a 30-second stall
      //     or a `55P03` — counted against a mailbox whose provider did nothing wrong. Keying on
      //     the account removes the contention by construction instead of tuning a timeout.
      //
      //  3. A LANE IS RESERVED FOR MAILBOXES THAT OWE NOTHING. `heavyLanes` bounds how many
      //     runtimes with `owesBacklog` may be in flight, leaving `CYCLE_FAST_LANES` for the rest.
      //     Without it three cold backfills fill three lanes and a woken mailbox is behind a deep
      //     batch again — the 15.5-minute measurement with a smaller constant. The guard asserts
      //     BOTH directions: the fast mailbox's latency AND that the heavy one keeps draining.
      //
      // THE FENCE IS UNAFFECTED, and this was checked rather than assumed. Leadership is
      // per SHARD and read-only; the fence's claim statement is `SELECT … FOR UPDATE` on the
      // MAILBOX row, so two lanes claim two different rows and never contend. `LeaderFencedError`
      // reaches `handleLockLoss`, which is idempotent, so two lanes refused in the same instant
      // quiesce once.
      //
      // THE POOL IS THE CEILING, and it is why `cycleLanes` is clamped rather than trusted:
      // `makeOwnedDb` opens `WORKER_POOL_MAX` connections for this whole process and a fenced
      // write group holds one for its transaction. See `resolveCycleLanes`.
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
       * One mailbox's turn. NEVER throws and never rejects — every arm is handled inside.
       *
       * `woken` says this visit was admitted on a wake (IDLE fired, or the sync-kick scan named
       * it) — captured at admission, because admission is also what SPENDS `rt.wokenAt`. It buys
       * one thing: an EAGER `last_sync_at` stamp on success, beside the first-success stamp and
       * for a client-facing reason rather than an alerting one. The pull affordance's spinner
       * settles on "every mailbox's `lastSyncAt` moved past my request" (`PullNewMail.tsx`,
       * `POST /sync/pull`), and the batched stamp at the end of the pass can be MINUTES behind
       * the visit that actually served the wake — an honest scan reported dishonestly late. One
       * UPDATE per woken visit, i.e. per doorbell ring or per real arrival, never per rotation.
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
          );
          // THE LEASE ANSWERED, SO IT IS READABLE — whichever way it answered. A
          // stand-down is evidence about this connection every bit as strong as an organize verdict:
          // it means `ohmail/_meta` was created and FETCHed successfully and somebody else's claim
          // was in it. Only a THROW means "we could not look", so only a throw may advance the
          // clock. Written on the line after the call rather than inside the `organize` branch for
          // exactly that reason — putting it there would leave a mailbox that alternates
          // stand-down / unreadable accumulating toward a detach it has not earned.
          rt.leaseUnavailableSince = null;
          if (!organize) {
            // The lease named somebody else. The detach that follows the loop drops this too, but
            // the verdict is the event and this is where it is known: from here on, every UID this
            // process remembers about this mailbox belongs to another organizer's mailbox.
            rt.deps.knownSet?.drop("organizer stand-down");
            toStandDown.push(rt);
            return;
          }
          // The classifier is resolved HERE, once per cycle, from the circuit — not stored on
          // `rt.deps`. That is what lets an outage degrade this mailbox to rules-only between
          // one cycle and the next without touching `sync.ts`, `pipeline.ts` or `SyncDeps`.
          /** When THIS visit's scan began — the eager stamp backdates to it (same rule as the pass). */
          const visitStartedMs = Date.now();
          const { hasBacklog, owesFiling } = await runSyncCycle({
            ...rt.deps, ...aiFor(rt.mailboxId, rt.accountId), ...(await screeningFor(rt.accountId)),
            // The cap is refreshed per cycle like the screening posture beside it, so an
            // upgrade's headroom (or a downgrade's new ceiling) applies without a re-attach.
            storageCap: await storageCapFor(rt.accountId),
          });
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
          // ── THE VERIFIED-RECOVERY WRITE, ON THE PATH THAT CAN ACTUALLY VERIFY IT ────────
          //
          // Moved here from `attach()`. The bar it used to clear was "connect +
          // folders + two inline sync cycles + IDLE", which was a PROXY for "has actually
          // synced" that happened to be reachable before attach returned. Here every success is
          // a real cycle, so the bar is the thing itself — and a mailbox whose login works but
          // whose every cycle throws now never flips to `connected` at all; its failures
          // accumulate toward quarantine instead, which is the honest outcome.
          //
          // Spent once (`needsRecovery = false` regardless of the write's fate) because
          // `markRecovered` never throws: a write that was fenced or failed is retried by the
          // roster pass, which re-reads `mb.status` from the database every pass and is gated on
          // this same runtime having completed a cycle. Retrying it from here every cycle
          // instead would be one pointless UPDATE per cycle for the life of a disabled mailbox.
          if (rt.needsRecovery) {
            rt.needsRecovery = false;
            await markRecovered(rt);
          }
          // …and the backoff's attempt count, for the reason spelled out where it used to live at
          // the end of `attach()`. A mailbox that completed a cycle is not in a failure backoff;
          // one that merely connected is not yet evidence of anything.
          quarantine.delete(rt.mailboxId);
          // ── THE PORTABLE PROFILE'S WRITE-BEHIND TICK ─────────────────────────────────────
          //
          // HERE and only here, because this line is reachable only after `mayOrganize` said
          // organize AND `runSyncCycle` completed — the lease gate above is the single-writer
          // mechanism, and the profile module deliberately re-derives none of it. Never throws;
          // a settings copy that cannot be written must not count against a mailbox whose
          // provider did nothing wrong. Debounced inside (`TF_PROFILE_FLUSH_MS`), so a burst of
          // screener verdicts between two ticks is one append.
          await rt.profile.onOrganize();
          // ── THE FIRST STAMP DOES NOT WAIT FOR THE REST OF THE ROTATION ──────────────────
          //
          // The batched write below the loop stamps everything that synced this pass, and that is
          // still the steady-state writer. But this loop is SERIAL, so until this line existed a
          // mailbox's very first `last_sync_at` waited on every other mailbox's bounded batch —
          // and `coalesce(last_sync_at, created_at) < now() - 15 minutes` (`packages/db/src/
          // alerts.ts`) is measured from the moment the ROW was created, not from this pass. Two
          // ways that pages a healthy first connect:
          //
          //  · WIDTH. A real two-mailbox shard measured most of ten minutes to the first
          //    completed pass after a deploy, leaving only a few minutes
          //    of margin. A third backfilling mailbox on the shard spends it.
          //  · SHUTDOWN. `if (stopped) return;` at the top of this loop returns BEFORE the
          //    batched write, so a deploy landing mid-rotation discards the stamp for every
          //    mailbox that had already synced in that pass. With a long backfill and this
          //    repo's deploy cadence, consecutive restarts keep the column NULL across passes
          //    that each genuinely succeeded.
          //
          // ONCE PER ATTACH, not once per process: `attach()` mints `lastSuccessAt: null`, so a
          // dead-connection detach and re-attach arms this again — correctly, because a fresh
          // connection's first success is new evidence. So the cost is one extra UPDATE per
          // attach, and the batching rationale on `stampMailboxSync` still governs everything
          // after it.
          //
          // The pass-1 double write is DELIBERATE, not an oversight to be optimized away: if this
          // write fails, the batched one covers the same row in the same pass, which is what lets
          // `firstSuccess` be spent once without leaving an orphan.
          //
          // `woken` joins `firstSuccess` here (2026-08-26): a visit admitted on a wake stamps
          // eagerly too, because the pull affordance settles its spinner on `lastSyncAt` moving
          // past its request instant, and the batched stamp at pass end can be minutes behind the
          // visit that answered the wake. Same double-write posture, one UPDATE per doorbell ring
          // or real arrival — never one per rotation.
          //
          // THE `catch` IS LOAD-BEARING AND MUST NEVER RETHROW OR `continue`. Uncaught, a failed
          // bookkeeping UPDATE would fall into this loop's `catch (err)` arm, miss the
          // `LeaseUnavailableError`/`ClassifierFaultError` exemptions, increment `rt.failures` and
          // walk a customer's row toward `status='error'` and a detach — a mailbox marked broken
          // because a freshness column could not be written.
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

          // ── THE FIRST IMPORT IS FINISHED, SO SAY SO — ONCE ──────────────────────────────
          //
          // `hasBacklog === false` is the one honest end-of-import signal the worker has: this
          // cycle drained everything the adapter owed, so the mailbox is no longer a partial one.
          // `stampInitialImportComplete` guards on `initial_import_completed_at IS NULL`, so this
          // is a once-per-mailbox write — every later no-backlog cycle matches zero rows — and the
          // client reads a NULL stamp as a FLOOR under "still importing" regardless of what its own
          // mirror is doing, which is what stops a tab that caught up to a partial server state
          // from calling the mailbox done.
          //
          // NOT gated on `firstSuccess`: a mailbox large enough to drain in bounded batches
          // completes several cycles WITH a backlog before the one that clears it, so the stamp
          // belongs to the first no-backlog cycle, not the first successful one.
          //
          // A FAILURE HERE MUST NOT FAIL THE CYCLE, the same rule the `last_sync_at` stamp and the
          // sensitive-backfill pass below both follow: the mailbox is connected and serving, and a
          // freshness column that could not be written is retried on the next no-backlog cycle. An
          // uncaught throw would fall into this loop's `catch (err)` arm, miss the
          // `LeaseUnavailableError`/`ClassifierFaultError` exemptions and walk a healthy mailbox
          // toward `status='error'`.
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

          // ── PUTTING BACK THE HTML A CLASSIFIER FALSE POSITIVE THREW AWAY ────────────────
          //
          // A click tracker's percent-escaped slash spelled `2fa`, so ordinary newsletters,
          // invoices and monitoring alerts were judged to carry an authentication code and were
          // stored redacted with their html discarded. The classifier is fixed; the mail that
          // was already damaged is not, and the only remaining copy of that html is the message
          // on the server.
          //
          // HERE, AND NOT IN THE ATTACH ARM WHERE THE KICKSTART LIVES. The kickstart is cheap on
          // a virgin mailbox — an empty Screener backlog — so it can sit in front of the first
          // drain. This one is a network read per damaged message, and a mailbox with two
          // hundred of them would hold up its own first sync while it repaired mail nobody is
          // waiting on. On the cycle it costs a marker read per mailbox once the pass is done,
          // and mail keeps flowing while the repair proceeds a few messages at a time.
          //
          // AFTER a SUCCESSFUL `runSyncCycle`, deliberately: the pass shares this cycle's
          // connection, so it must not run on one that has just failed to sync, and the failure
          // arm below has already decided what such a connection is worth.
          //
          // A FAILURE HERE MUST NOT FAIL THE CYCLE, for the reason the kickstart's own catch
          // gives: the mailbox is connected and syncing, and repairing an old body is a
          // correction to a record rather than a precondition for anything. The marker is
          // written only on a completed walk, so a failure simply retries next cycle. The catch
          // is INSIDE the success path and swallows everything, which is what keeps a repair
          // fault out of `rt.failures` — a mailbox must never walk toward `status='error'`
          // because a two-week-old newsletter could not be re-read.
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
              });
            }
          } catch (err) {
            log.error("sensitive_fp_backfill_failed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              reason: "no marker was written, so the next cycle retries; every message keeps the " +
                "body it already had and nothing about this mailbox's syncing is affected",
            });
          }

          // ── PUT THE CONNECTION BACK ON WATCH — THE LAST ACT OF EVERY SUCCESSFUL VISIT ────
          //
          // Everything above re-SELECTed other folders on this same connection, and imapflow
          // idles on whichever mailbox is CURRENTLY selected — so without this line the IDLE
          // established at attach watches the last folder the visit touched, an INBOX arrival
          // emits no `exists`, and the push channel is dead from the first cycle onward while
          // looking healthy. That was the measured production state on 2026-08-26: p50 194 s /
          // p90 431 s from arrival to mirror across 48 h, entirely poll-driven. One SELECT per
          // visit is the whole cost, and only the success path pays it — a failed visit is
          // connection trouble, and the detach/re-attach that follows re-establishes the watch
          // from scratch.
          //
          // Swallowed like the two passes above it and for the same reason: a re-arm that could
          // not SELECT is the connection dying, which the adapter's own `close` listener turns
          // into a detach — it is not evidence against the mailbox and must not walk it toward
          // `status='error'` over a wake channel.
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
          // ── A FENCED-OUT WRITE IS PROOF OF LOST LEADERSHIP, NOT A MAILBOX FAULT ─────────
          //
          // `worker_heartbeats` stopped naming this instance as the shard's leader while a
          // mail-bearing write was in flight — the write was REFUSED with nothing persisted
          // (see `makeSyncWriteFence`), and every later write of this cycle would be refused
          // for the same reason. So the response is the lock-loss response, not the failure
          // ladder: quiesce the whole instance and let the supervisor re-acquire. Counting
          // this toward `maxSyncFailures` would quarantine a healthy mailbox over OUR handover,
          // and continuing the pass would spend a full rotation collecting the same refusal
          // once per mailbox. FIRST among the arms because it is the only one that ends the
          // pass — `handleLockLoss` is idempotent, so a tripwire-initiated unwind that already
          // ran it costs nothing here.
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
          // ── OUR DATABASE FAILING IS NOT THIRTEEN MAILBOXES FAILING ───────────────────────
          //
          // Until this arm existed the cycle path exempted three classes and read EVERY other
          // throw as evidence against the mailbox that happened to be mid-cycle. A Postgres
          // outage is not selective: it fails the first mailbox, then the second, then the rest,
          // once per pass — so at `maxSyncFailures` the whole shard walks into quarantine one
          // mailbox at a time, each with `status='error'` on a customer's row and an exponential
          // backoff earned against a provider that answered every request correctly. The shard
          // then stays dark for the length of the ladder AFTER the database comes back, which is
          // the part that makes it more than cosmetic: the outage outlives its own cause.
          //
          // It is exempted BY ORIGIN, and that is the one thing this arm could not have been
          // built on before. `db-fault.ts` has the measurements; the short version is that a
          // Postgres that is not listening throws `code: "ECONNREFUSED"` — the same `name` and
          // the same `code` a dead IMAP host throws — so no predicate over the error could
          // separate "our database is down" from "this customer's provider is down". Every
          // database call `runSyncCycle` makes now goes through a wrapped repo or the wrapped
          // fence transaction, so the answer is recorded at the call instead of inferred from it.
          //
          // FOUR CONSEQUENCES, and they are the four halves of the finding:
          //
          //  a. `rt.failures` is NOT incremented. The mailbox keeps whatever genuine failures it
          //     had — this is not a reset — and cannot be quarantined by our outage at any
          //     tuning of `maxSyncFailures`, which is why the exemption is a class test and not
          //     a threshold comparison. The same rule `ClassifierFaultError` states below.
          //  b. `quarantineMailbox` is not called, so no backoff entry is written and no
          //     `mailboxes.status`/`retry_count` write is attempted. The row is untouched — the
          //     honest outcome, since nothing about the mailbox changed.
          //  c. THE PASS STOPS. A dead database means stop writing, not stop this mailbox: every
          //     remaining mailbox would collect the identical failure, one IMAP round trip each,
          //     for nothing. `break` and not `return`, deliberately — the post-loop bookkeeping
          //     below is all best-effort and already catches its own failures, and it holds the
          //     `last_sync_at` stamp for the mailboxes that DID sync before the fault, which a
          //     transient blip must not throw away.
          //  d. it is reported ONCE, as the shard-wide condition it is. See `noteDatabaseFault`.
          //
          // AFTER the fence arm, which is not arbitrary: `LeaderFencedError` is thrown by the
          // fence's own refusal path (`underFence`) rather than by a database call, so it never
          // carries this tag — but it is the more specific claim and the one that must reach
          // `handleLockLoss`, so it is tested first and a takeover during a database blip
          // still quiesces instead of being read as an outage. The reverse order would be a
          // swallowed fence refusal.
          //
          // AND THE BOUNDARY, STATED. This predicate is deliberately NOT
          // `classifyIngestFault(err).domain === "infrastructure"`. That one calls the CUSTOMER'S
          // IMAP host infrastructure too, which is correct where it is used and would be the
          // inverse defect here: a provider that refuses to answer is exactly what quarantine
          // exists for, and exempting it would dissolve mailbox isolation itself. An
          // ambiguous timeout with no origin therefore stays a per-mailbox fault — a missed
          // exemption costs a self-clearing quarantine, a wrong one costs isolation.
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
          // A MODEL FAULT IS NOT A MAILBOX FAILURE, and must never count toward quarantine.
          //
          // Without this, three failed polls of a third-party API detach the mailbox and write
          // `status='error'` — a model-provider incident rendered as "your mailbox is broken". The
          // circuit has already counted this fault and will open on it; the message stays
          // un-ingested and the cursor unadvanced, so the next cycle re-plans the same mail
          // rules-only. Nothing here is lost, so nothing here should be punished.
          //
          // The exemption is keyed on the ERROR CLASS rather than on a threshold comparison, so
          // "an outage can never quarantine a mailbox" holds at every tuning of `maxSyncFailures`
          // and of the circuit's own threshold.
          // ── A LEASE WE COULD NOT READ IS NOT A MAILBOX FAILURE — AND IT IS NOT NOTHING EITHER ──
          //
          // The exemption stays, and it stays BY CLASS: a mailbox whose `ohmail/_meta` cannot be
          // read must not be read as "no claim, so organize" (the dual-organizer bug through the
          // back door) and must not be read as "stand down" either, because a stand-down is STICKY
          // and one transient network error would permanently disable a mailbox nobody else
          // wants. Quarantining here would be the same mistake with a
          // backoff attached: `status='error'` plus a retry delay, on a customer's row, for a fault
          // that is ours or the network's.
          //
          // WHAT THIS ARM USED TO SAY, AND WHY THAT SENTENCE WAS THE OUTAGE:
          //
          //   "So: nothing happens this cycle. Nothing is ingested, nothing is quarantined, and
          //    the next cycle asks again."
          //
          // In a measured production incident the next cycle asked again over a hundred times.
          // Every served mailbox emitted `sync_cycle_lease_unavailable` with
          // `causeCode="NoConnection"` for most of an hour; the row read `status=connected`,
          // `sync_blocked_reason=NULL`, `error_code=NULL`, `retry_count=0` throughout; `/health`
          // said `leader` and `serving`; and it healed only on a process restart. Every layer
          // behaved as documented and the composition was a do-nothing loop with no exit. So the
          // comment was not describing a safe default — it was documenting an outage as policy, and
          // in this repository a comment is the claim under test.
          //
          // THREE THINGS HAPPEN NOW, and none of them is a quarantine:
          //
          //  1. it RECORDS, on EVERY occurrence — `noteBlock` is idempotent (it refuses to move
          //     `since` when the reason is unchanged), so "every occurrence" costs one map read and
          //     keeps the FIRST observation. This is not optional bookkeeping: a cycle-path detach
          //     that left the mailbox in no bucket would make `roster_invariant_violated` page every
          //     30 s about this fix's own behaviour;
          //  2. it CLOCKS, so a provider blip and a socket that died ten minutes ago stop being the
          //     same observation. `mayOrganize` resolving clears it, above;
          //  3. past `leaseUnavailableDetachMs` it DETACHES — after the loop, with `toStandDown` and
          //     `toQuarantine` — and the next roster pass re-attaches on a FRESH connection, because
          //     attach is connect + gate + folders + IDLE, i.e. attach IS reconnect. Re-attaching
          //     also converts an undiagnosable steady state into outcomes this file already handles:
          //     a live-but-unreadable lease lands in the attach arm's own `noteBlock`, and a login
          //     the provider now rejects quarantines through the attach catch, correctly attributed.
          //
          // `releaseOrganizerClaim` is NOT called here and must never be: releasing on connection
          // death would hand the mailbox to a desktop install on every provider blip. `:1201` stays
          // the only release site. Guarded by `dead-connection.e2e.test.ts` claim 5, which asserts
          // `FakeMetaFolder.removals` does not move across detach and re-attach.
          if (err instanceof LeaseUnavailableError) {
            noteBlock(leaseBlocked, rt.mailboxId, "lease_unreadable");
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

      // ── THE DISPATCHER ────────────────────────────────────────────────────────────────────
      //
      // Work-stealing and not waves, and the difference is the whole point of the slice. A wave
      // scheduler — take N, await all N, take the next N — costs `max(wave)` per wave, so the
      // heavy mailbox still dominates the wave it is in and the measured rotation barely moves:
      // 3×254 s + 10×2 s serial is 782 s, and in waves of three it is ~766 s. Lanes that refill
      // the instant one frees cost `max(total/N, longest)` instead — ~260 s for the same shard —
      // which is the point at which a mailbox waits for its OWN batch rather than for the shard's.
      //
      // The roster yield is at the TOP, exactly where the adoption fix put it, and it is now the only
      // place a mailbox is taken from `pending`. Lanes may be in flight across it, which is the
      // one property the adoption fix's original sentence promised and `laneBusy` now enforces directly.
      for (;;) {
        if (stopped) break;
        // ── SERVE THE ROSTER PASS THIS CYCLE IS SITTING ON ──────────────────────────────
        //
        // Lanes may be running while this pass does its work, so "nothing is
        // suspended inside an adapter" is no longer what makes it safe — `laneBusy` is. The
        // pass detaches nothing a lane is holding and defers it to `deferredLeaves` instead.
        //
        // NOT while `stopPass` is set. The pass is winding down because the shared database is
        // gone, and a roster pass is a database read: attempting it once per draining lane would
        // add `roster_pass_failed` lines to the one moment an operator least wants log noise, and
        // could not succeed. It stays owed and runs after this cycle, which is where the queued
        // entry `requestRoster` made would have run it anyway.
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
          // ── AND THEN DISTRUST THE SNAPSHOT, BY IDENTITY AND NOT BY PRESENCE ─────────────
          //
          // `pending` was planned at the top of this cycle and a roster pass may since have
          // detached this mailbox — disabled, deleted, billing lapsed, evicted by the cap. The
          // single queue used to make that impossible; the yield above is what trades it away,
          // so it becomes a line of code and gets a test. (The first-syncer rule admits new runtimes to
          // `pending` but never revalidates the ones already in it — that is this guard's job.)
          //
          // `runtimes.get(id) !== rt` and NOT `!runtimes.has(id)`, because a ten-minute cycle
          // spans many roster intervals: one pass can detach a mailbox and a later one re-attach
          // it as a NEW runtime with a NEW connection. `has` is true for that, and the stale `rt`
          // this loop is holding carries the CLOSED adapter — its failures would climb to
          // `maxSyncFailures`, and `detach(staleRt)` deletes by mailbox id, evicting the healthy
          // runtime, leaking its live IDLE login and writing `status='error'` on a mailbox that
          // is working perfectly.
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

      // ── STANDING DOWN MEANS STOPPING ENTIRELY, NOT MIRRORING QUIETLY ────────────────────
      //
      // The dual-organizer rule: the loser stands down on its next cycle and STOPS SYNCING
      // ENTIRELY — it does not keep passively mirroring. A 'read-only' IMAP loop is half the
      // dual-organizer bug surface: it still observes folders, still feeds `adopt_external`,
      // still burns a connection. So the runtime is detached and the login closed, exactly as
      // a quarantine would — but with NO backoff entry, because this is not a failure and must
      // never be retried on a timer. The row is `disabled`, so the next roster pass does not
      // offer the mailbox again; only a human re-enabling it does.
      //
      // Outside the loop, like the quarantine pass, so a detach can never close an adapter the
      // rotation is still walking.
      // The identity guard here is the same one the rotation loop carries and for the same
      // reason: these three lists were validated when they were PUSHED, and a roster pass has
      // been able to run between then and now since mid-cycle adoption. Detaching a stale `rt` deletes the
      // map entry a healthy re-attached runtime owns.
      //
      // SAY WHAT IS AND IS NOT PROVEN. The HARM is proven — deleting the guard on the rotation
      // loop above turns `roster-preemption.e2e.test.ts`'s stale-runtime claim red with
      // `mailboxes: 3` where 4 are attached, which is the healthy runtime being evicted. The
      // three guards below are the same rule at the same risk, and each ALONE is not covered:
      // removing any one of them leaves the suite green. Proving one needs a mailbox that
      // reaches a post-loop list AND is detached and re-attached by two later mid-cycle passes
      // before the loop ends — four mailboxes and three parks. Written down rather than
      // asserted, so the next person knows which line is evidence and which is argument.
      for (const rt of toStandDown) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        await detach(rt, `another organizer holds this mailbox (${rt.lease.disabledReason ?? "organized elsewhere"})`);
        // `reason: null` — the row is `disabled` with a `disabled_reason`, which is a strictly
        // better answer than any sync-block member, and `markMailboxStoodDown` cleared these two
        // columns in the statement that wrote it. See `SyncBlock`.
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

      // ── A CONNECTION THAT CANNOT READ ITS OWN LEASE IS DETACHED, NOT QUARANTINED ───────────
      //
      // The whole distinction, in three properties this loop has and the quarantine loop above does
      // not:
      //
      //  · NO backoff entry and NO `status='error'`. This is an infrastructure fault, so the row
      //    keeps saying `connected` while `sync_blocked_reason` says `lease_unreadable` — which is
      //    the honest pair, and it is what the by-class exemption exists to protect. A mailbox must
      //    never be marked broken because our socket died.
      //  · NO `releaseOrganizerClaim`. Cloud fully intends to keep organizing this mailbox; a
      //    release here would hand it to a desktop install on every provider blip and break "exactly
      //    one active organizer per mailbox" in the one direction that loses a customer's mail.
      //  · The mailbox is left in `leaseBlocked` by the arm that queued it, so
      //    `roster_invariant_violated` stays quiet: a detached-and-accounted-for mailbox is not a
      //    duty gap. Deleting the `noteBlock` above turns this loop into a pager.
      //
      // Outside the rotation loop for the reason the other two are: a detach must never close an
      // adapter the loop is still walking.
      for (const { rt, unavailableMs } of toReconnect) {
        if (runtimes.get(rt.mailboxId) !== rt) continue;
        await detach(
          rt,
          `the organizer lease was unreadable for ${unavailableMs}ms (bound ${leaseUnavailableDetachMs}ms) — ` +
          "the connection cannot serve this mailbox, so the next roster pass re-attaches it on a fresh one",
        );
      }

      // ── THE DB PASSES RUN OVER THE SHARD'S FULL ENABLED SET, NOT THE ATTACHED DUTY ──────
      //
      // This used to be `dutyAccounts`, which is `accountsOf(served)` where
      // `served = selected.slice(0, maxMailboxes)`. That cap exists to bound IMAP CONNECTIONS
      // and nothing else, and neither pass below opens one: `ToolApplyContext`
      // (`packages/core/src/ai/workflows/executor.ts`) is `{repo, tx, accountId, runId,
      // stepIndex, now, drafter, credits}` with NO adapter, `file_message` is annotated NEVER
      // IMAP, and `bubbleUpPass` is one SELECT plus one UPDATE per due row. So an account whose
      // mailbox fell past the cap had its `workflow_runs` row accepted with a 202 and drained by
      // nobody, and its snoozed messages would never resurface — for a reason that does not
      // apply to either pass. `dutyAccounts` stays the list for the THREAD BACKFILL below,
      // which genuinely needs an attached mailbox.
      //
      // Multi-shard is closed by construction: `shardPredicate` (`mailboxes.ts`) is
      // `hashtext(account_id) % shards`, so an account belongs to exactly one shard's list and
      // two shards' workers can never both claim the same row.
      //
      // DELIBERATE SCOPE, unchanged and now stated for BOTH passes (write it down, do not
      // rediscover it): the list derives from ENABLED MAILBOXES. An account whose every mailbox
      // is `status='disabled'` — precisely what the billing-downgrade path produces —
      // appears in no shard's list, so it gets no workflow drain, no time scan AND NO BUBBLE-UP
      // FLIP; any already-`pending` workflow_runs and any due `bubbled_up` message_states it
      // has sit untouched until the account is re-enabled. That is the intended semantics for
      // all three (a suspended account's automation must not keep firing, and resurfacing mail
      // into an ohbox nobody is entitled to sync is the same act), and it is why "disable,
      // never delete" is safe here. The consequence the disabling path owns: when it disables an
      // account it must also park or cancel that account's pending runs, or they accumulate
      // forever.
      //
      // FALLBACK, NOT FAILURE. `dutyAccounts` is in-memory and could not throw; this is a query
      // and can. On a database fault the cycle degrades to the OLD, NARROWER list rather than
      // skipping the passes entirely — a subset is what shipped until this slice, and it beats a
      // cycle in which no account is drained at all.
      // NO SECOND PREEMPTION POINT HERE, and the absence is a decision rather than an omission.
      //
      // A yield before the per-account passes below is safe — the detaches are done and nothing
      // beyond this line touches an adapter — and it was written, and then removed, because NO
      // TEST CAN DRIVE IT. The passes are database work with no injectable delay, so the branch
      // cannot be made to matter deterministically, and a guard nobody has watched fail is not
      // evidence. What it would have bought is bounded and small: a mailbox connected during the
      // DB passes waits them out, and the queued pass runs the moment this cycle returns.
      //
      // So `cycle()` has exactly ONE preemption point — between two mailboxes — which is also
      // the whole safety argument, in one sentence, with nothing to qualify.
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

      // ── THE BUBBLE-UP RESURFACING PASS, IN THE LOOP AND TIME-GATED ──────────────────────
      //
      // It lives here rather than in a platform cron for the reason `pruneIdempotencyKeys`
      // below does, and the argument is stronger here because the alternative is disproved
      // rather than merely worse: `runBubbleUpCron` takes `acquireLeaderLock(…,
      // leaderLockKeyFor(shardIndex))` — the SAME lock this process is holding right now — so a
      // platform cron on this shard would be a process whose only function, while the worker is
      // healthy, is to start, fail to take the lock and exit. The wrapper is a manual backstop
      // for a DEAD worker; it was never a scheduler target. The worker is already the single
      // elected writer, so exactly one process runs this, and a failure is a logged error and
      // never a cycle abort.
      //
      // Until this call existed nothing in production flipped `bubbled_up` back:
      // `AppShell`'s resurface shortcut hid the message and showed the user a DATED promise
      // ("Resurfaces {when}", a real next-Friday-09:00 timestamp) that no code could keep.
      //
      // BEFORE the workflow block, not after: a message coming due may satisfy a `time`
      // trigger's target set in this same tick, and the reverse order would delay that a full
      // cycle for nothing.
      //
      // TIME-GATED, and not per-cycle-unconditional and not its own `setInterval`. A second
      // off-queue writer is unearned for a pass costing one query per account, and the detach
      // loops above exist precisely because a pass that is not on this queue can close an
      // adapter the cycle is walking.
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
            { drafter: config.drafter ?? unconfiguredDrafter, credits: workflowGateFor(accountId), accountId },
            nowTick,
          );
        } catch (err) {
          noteIfSharedDatabaseFault(err);
          log.error("workflow_drain_failed", { accountId, err });
        }
      }

      // ── APPLY A NEW RULE TO MAIL THAT IS ALREADY FILED ──────────────────────────────
      //
      // Its OWN try/catch and its own loop, not folded into the workflow block above, for the
      // reason that block's comment already gives: one account's failure must not skip the rest,
      // and a workflow error must not skip this. They share nothing.
      //
      // It runs HERE, on the worker, and not on the API host, because writing thousands of
      // `folder_state` rows inside `POST /rules` is the thing this slice exists to stop — the
      // sheet used to fire one `POST /messages/:id/move` per matching message from the browser,
      // each taking the account's `account_sync_state` row lock, and abandoned the rest if the
      // tab closed. The pass needs nothing from the services package (the dependency rule,
      // `test/deps.test.ts`): the db and core packages are the whole of its imports,
      // which is what makes this the right host rather than a dodge.
      //
      // The package is named in prose rather than in backticks on purpose: `deps.test.ts` scans
      // this file's raw TEXT for that specifier and does NOT strip comments, so writing it here
      // fails the dependency rule from a comment. That is the same "a mention is not a call" defect
      // `test/every-pass-has-a-producer.test.ts` documents having fixed in itself; deps.test.ts
      // has not, and hardening it belongs to whoever owns that guard.
      //
      // It is NOT time-gated, unlike `bubbleUpPass`. The pass's own per-cycle write budget
      // (`RULE_RETRO_WRITES_PER_CYCLE`) already bounds what it does, its owed probe is one
      // indexed query against a PARTIAL index that holds zero rows in the steady state, and a
      // user who has just clicked a destination is waiting for their mail to move — a gate would
      // add latency to the one thing this feature is.
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

      // ── FILE THE ALREADY-MISFILED AUTOMATED MAIL OUT OF THE OHBOX ───────────────────────
      //
      // Its OWN try/catch and loop, for the reason the retro block above has one: one account's
      // failure must not skip the rest. It is the durable, one-time-per-opt-in half of the
      // `people_only` posture — the live engine demotes NEW mail, this re-routes the backlog that
      // was placed before the account opted in.
      //
      // Like the retro pass it lives here, on the worker, and needs nothing beyond the db and core
      // packages — the same dependency-direction reason that pass gives (`deps.test.ts` scans this
      // file's raw text, so the reason is stated without naming the forbidden package). It is owed
      // work only for an account that flipped to `people_only` (or pressed "tidy now"), which the
      // pass checks itself with one PK read; for every other account the call is that read and no
      // more. NOT time-gated: its own per-cycle write budget bounds what it does, and an owner who
      // just opted in is waiting for their Ohbox to shrink.
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

      // ── REJOIN THE CONVERSATIONS A FORWARD SPLIT ────────────────────────────────────────
      //
      // A forward re-entering the mailbox carries no References, so one human conversation
      // becomes two header chains and renders as two threads — correctly, under the ingest
      // rule, which is why no ingest change can close it. The heal merges them once the
      // evidence completes (`conversationJoinVerdict` — same account, same base subject, the
      // same non-self correspondent on BOTH chains, the later chain opening with a
      // reply/forward prefix, inside a 14-day window), performing exactly the merge the user's
      // own `POST /threads/merge` performs, change rows included.
      //
      // TIME-GATED like `bubbleUpPass` and unlike the retro/tidy passes, because nobody is
      // waiting on it: the pass is a repair of presentation, its own budget bounds a run, and
      // its pre-filter is a per-account GROUP BY that would buy nothing run per-cycle.
      // Its OWN try/catch and loop: one account's failure must not skip the rest.
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
            db as unknown as Tx, { accountId, log }, new Date(),
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

      // ── BUY THE MODEL'S ADVICE ABOUT INCOMING HELD SENDERS ───────────────────────────────
      //
      // Its OWN try/catch and loop, for the reason every block above has one. It runs AFTER the
      // deterministic auto-apply directly above it, and that order is load-bearing rather than
      // cosmetic: that pass files the obvious bulk OUT of the Screener with no model and no
      // spend, so anything it takes this cycle is a sender this one never pays to ask about.
      // Wrong way round and the account buys advice about newsletters that were about to be
      // filed for free.
      //
      // The ONLY pass here that spends money, and the only thing in the product that spends with
      // no press in the same minute. Three bounds hold it — the `auto_suggest_at` watermark (the
      // pre-opt-in backlog is never drained by flipping a switch), a ten-sender page per account
      // per cycle, and `spend()` before every model call with the first refusal stopping the
      // account. Off by default: for an account that has not opted in this is one PK read, and
      // for a deployment with no model (or with the classifier circuit OPEN) it is not even that.
      //
      // The gate books the SAME `debit_classify` reason the ingest path meters with, which is what
      // makes the ledger's `classify:screener:<message_id>` source a real duplicate check across
      // this pass, the client's on-open batch and the manual ladder.
      //
      // It is a DIFFERENT gate instance from `classifyGateFor`, though — `screenerAutoGateFor`,
      // which is exclusive. A duplicate check was never enough here: it makes the second buyer of
      // one message free and cannot make it not happen, so this pass and a user pressing Suggest
      // both reached the model for one credit. See that function.
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
              credits: screenerAutoGateFor(accountId),
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

      // ── THE AWAY RESPONDER'S SENDER — the only pass here that SENDS MAIL ─────────────────
      //
      // Its OWN try/catch and loop, for the reason every block above has one: one account's failure
      // must not skip the rest. It runs LAST of the per-account passes, and that position is
      // load-bearing rather than cosmetic — `folder_state` is what `audience='screened_in'` reads,
      // so a reply must not be decided before the passes above have finished placing this cycle's
      // mail. A message with no placement yet is treated as un-admitted, so getting the order wrong
      // would suppress replies rather than send wrong ones; last is still the correct order.
      //
      // `openSend` hands over the ATTACHED adapter for the mailbox the message arrived in — the one
      // this process already holds the organizer lease on, with SMTP configured from the same
      // credential rows. `null` for a mailbox this instance is not attached to, which is a
      // suppression and not an error: the shard that does hold it answers instead.
      for (const accountId of passAccounts) {
        if (stopped) return;
        try {
          const { ran, sent, suppressed, capped } = await awayResponderPass(
            db as unknown as Tx,
            {
              accountId, log,
              openSend: async (mailboxId) => runtimes.get(mailboxId)?.adapter ?? null,
            },
            new Date(),
          );
          if (ran && sent > 0) log.info("away_responder_pass", { accountId, sent, suppressed, capped });
        } catch (err) {
          log.error("away_responder_failed", {
            accountId, err,
            reason: "no reply is sent when this throws — the at-most-once claim commits in the same " +
              "statement it is read by, so a failure before SMTP leaves the sender unanswered and " +
              "a failure after it leaves the claim spent; neither sends a second copy",
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
        // ── ABANDONED AI WORK CLAIMS ───────────────────────────────────────────────────
        //
        // A SIZE control and never a correctness one, which is the whole reason it can sit in an
        // hourly slot: an expired claim is already claimable by the next caller, so nothing waits
        // on this sweep and a failed one costs a little table and no exclusivity. What it removes
        // is the tail no caller ever comes back for — a holder that died on a message nobody asks
        // about again — since the normal end of a claim is its holder releasing it.
        try {
          const claims = await pruneAiAttemptClaims(db as unknown as Tx, new Date());
          if (claims > 0) log.info("ai_claims_pruned", { pruned: claims });
        } catch (err) {
          log.error("ai_claim_prune_failed", {
            err,
            reason: "expired claims stay claimable regardless — the next caller takes one over " +
              "rather than waiting for this sweep, so nothing is blocked by this failing",
          });
        }
        // ── EXPIRED STAGED ATTACHMENT BYTES: THE OBJECT, THEN THE ROW ───────────────────
        //
        // A hosted send puts attachment bytes in a private bucket and references them; the row
        // carries a 24-hour `expires_at` and this is the half that makes that a fact rather than
        // a promise. Same slot and same reasoning as the prune above it — the worker is the
        // single elected writer, so exactly one process sweeps — and a failure is a logged
        // warning, never a cycle abort.
        //
        // THE ABANDONED UPLOAD IS THE CASE THAT MATTERS: a ticket minted, a compose window
        // closed, no object ever written. `remove` treats a storage 404 as success precisely so
        // that row goes; a sweep that read the 404 as failure would keep every abandoned ticket
        // for the life of the deployment while reporting nothing.
        //
        // IT DRAINS. This used to take ONE 200-row page per hourly slot, which any
        // account minting faster than that outran permanently — and since the predicate is the
        // clock rather than an identity, one such account starved cleanup for every other account
        // on the deployment. `sweepExpiredStagingFor` now pages until the expired set is empty,
        // under a row ceiling and a wall-clock budget stated on the constants in
        // `@trafficflow/db/cloud`. The per-account mint quota that makes the arithmetic close is
        // the other half of the same fix, at the mint.
        //
        // WHAT IS LOGGED IS CHOSEN SO A BACKLOG CANNOT BE SILENT, which is the failure this whole
        // finding was about. `drained: false` means rows are still expired when the pass ends —
        // either a bound bound (`stoppedBy`) or a bucket refusing deletes (`failedPages`) — and
        // it is a warning even though nothing threw, because a clean-looking number over a
        // growing bucket is exactly what went wrong before.
        //
        // The skip is LOGGED rather than silent. A deployment whose API stages and whose worker
        // has no bucket configured grows that bucket forever, and the only place that is visible
        // is here.
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

      // ── BACKFILL DRAIN ─────────────────────────────────────────────────────────────────
      //
      // A mailbox mid-backfill is drained as fast as the queue allows instead of one bounded
      // batch per `pollIntervalMs`: at two hundred messages a cycle, a 60 s poll would take a
      // twenty-thousand-message mailbox ~100 hours. Queued through `kickCycle`, so it lands on the
      // SAME serial queue as the roster pass — the drain cannot starve roster reconciliation,
      // and `stop()` still awaits whatever is in flight.
      //
      // Termination: a truncated batch always commits at least one message (the adapter's
      // anti-stall rule), so the known-set grows every pass and the backlog strictly shrinks.
      // A mailbox that instead keeps FAILING runs into `maxSyncFailures` and is quarantined.
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

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE THREAD BACKFILL, BEHIND THE CYCLE AND BOUNDED
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // What the first version got wrong was placement, not the pass: it ran to exhaustion on the
    // attach seam,
    // in front of a live IMAP connection, and killed the process (see the placement note in
    // `attach()`). Four properties replace it, and
    // each one is a guard in `test/thread-backfill-placement.e2e.test.ts`:
    //
    //  1. **Attach never waits for it.** There is no call to it on that path at all, which is a
    //     stronger statement than "it is fast": a backfill that hangs for ever cannot delay an
    //     attach it is not part of.
    //  2. **It is a SEPARATE queue entry, not the tail of `cycle()`.** Inline, a slow slice
    //     would sit between the cycle's work and the `beat()` that publishes its freshness, and
    //     would hold the queue against the roster pass for the whole slice. As its own entry it
    //     runs after the cycle has already reported, and a roster pass queued meanwhile is
    //     served between two slices rather than after all of them. It deliberately does NOT
    //     touch `lastCycleAt` or call `beat()` — it is not a cycle, and freshness it did not
    //     earn is exactly the lie /health was fixed to stop telling.
    //  3. **Bounded twice, by pages AND by wall clock**, so one enormous mailbox cannot starve
    //     the cycle it rides on. Resuming is free: the predicate is `thread_id IS NULL`.
    //  4. **It cannot throw into anything.** The body catches, and the queued task carries its
    //     own `.catch` — a rejection escaping `serialize` would become an unhandled rejection,
    //     which `installCrashHandlers` turns into `exit(1)`: the exact shape of the outage.
    //
    // PACING: one slice per completed cycle, and NO self re-kick. The message-backfill drain
    // above re-kicks itself because its progress is guaranteed by the adapter's anti-stall
    // rule; this pass's progress depends on every examined row leaving the predicate, so a
    // regression in `setMessageThread` would turn a self-re-kicking loop into a pinned CPU
    // against the live database. At 2 000 rows a slice even a large first import is a handful of
    // slices — minutes, for work that happens once in the life of an account.

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
     * WHY THE DUTY IS NOT FULLY SERVED, RIGHT NOW — the count and its decomposition.
     *
     * Set arithmetic over `servedIds` against the rotation and the three block maps. Bounded by
     * `maxMailboxes` (64), so it is cheap enough to run on every `/health` probe and on every beat,
     * and it touches no database — which `/health` may never do.
     *
     * THE BUCKET ORDER IS A PRECEDENCE, and it has to be, because the maps are genuinely not
     * disjoint. The reachable overlap is quarantine + stand-down: a mailbox whose backoff expires
     * is offered to `attach`, `mayOrganize` declines it, and the quarantine entry is deliberately
     * NOT deleted (its `attempts` is the ladder's input — see the release path above). So it is in
     * both maps at once and something has to break the tie.
     *
     * QUARANTINE WINS, and the reason is the asymmetry of being wrong rather than a claim that the
     * quarantine is the fresher fact — it is not; the stand-down came from the more recent attach.
     * Calling a stood-down mailbox quarantined costs a degraded reading that is arguably a false
     * one. Calling a quarantined mailbox stood down HIDES a real fault, because `standDown` is
     * excluded from the calculus by design. A conservative error stays visible; the other one is
     * an assertion quietly weakened, and this file is not the place to trade a real quarantine
     * against a tidier count.
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
      degraded: boolean; lastCycleAt: Date | null;
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
      };
    }

    /**
     * THE OFF-QUEUE PULSE — the fix for a worker that looks dead while it is working hardest.
     *
     * Every other beat in this file happens at the END of something: a cycle, an attach, a
     * roster pass. That was fine until a real first sync arrived. `cycle()` drains one bounded
     * batch per pass — and `attach()` used to drain two before it returned — so a
     * leader backfilling a large mailbox writes nothing for minutes at a time, and the
     * `worker_down` rule reads `beat_at` staleness and nothing else. Moving the drain off attach
     * shortens the longest single silence but does NOT remove it: one bounded cycle over a slow
     * provider is still minutes, and the re-kick loop runs them back to back. At two minutes it pages a human about a worker that is
     * ingesting mail as fast as the provider will serve it, and the platform is entitled to
     * replace the instance mid-backfill. A first sync should not look like an outage.
     *
     * So the pulse runs on the LOCK-VERIFY timer, off the serial queue, and it is deliberately
     * not a second timer: it fires only after `lock.verify()` has answered `held: true`, so the
     * claim "shard 0 has a live leader" is backed by the lock itself rather than by a process
     * asserting it about itself. It uses `refreshHeartbeat`, whose UPDATE is guarded on
     * `(shard, instance, leader = true)` — the one thing a timer must never do is resurrect a
     * leader that has already surrendered, and that guard is in the statement rather than in a
     * `stopped` check here, because a check and a write are not atomic.
     *
     * WHAT THIS COSTS, WRITTEN DOWN RATHER THAN DISCOVERED: a worker whose SERIAL QUEUE is
     * wedged — a provider dial with no timeout — now keeps beating and no longer trips
     * `worker_down` in two minutes. That fault is still caught, by the `sync_lag` rule reading
     * `last_sync_at` at fifteen minutes, and `last_cycle_at` (which advances only on a cycle
     * that actually synced) still says so on the row itself. Fifteen minutes to notice a wedge
     * is the price of not paging on every large first sync; a `last_cycle_at` clause on the
     * leader rule is a recorded follow-up.
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
     * One alert pass, from the WORKER side.
     *
     * It covers the three DB-visible rules (failed billing events, stuck sends, sync lag) and
     * deliberately does NOT include itself: `shards: []` skips the leader-liveness rule,
     * because a process reporting that it is alive is not evidence of anything. That rule is
     * the API host's job (`GET /internal/alerts`), which is a different process on a
     * different platform — see the header of `packages/db/src/alerts.ts`.
     *
     * Never throws: it runs off a timer, and an unhandled rejection here would take down a
     * worker that is syncing mail perfectly well.
     */
    async function alertPass(): Promise<void> {
      try {
        const result = await runAlertPass(db as unknown as Tx, {
          sinks: alertSinks, shards: [], source: "worker", environment,
          deliveryStreak: alertDeliveryStreak,
        });
        for (const alert of result.firing) {
          log.warn("alert_firing", {
            alertKey: alert.key, kind: alert.kind, severity: alert.severity,
            count: alert.count, oldestSeconds: alert.oldestSeconds, detail: alert.detail,
          });
        }
        for (const key of result.resolved) log.info("alert_resolved", { alertKey: key });
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

    // ══════════════════════════════════════════════════════════════════════════════════════
    //  THE LOCK MACHINERY STARTS BEFORE THE INITIAL ROSTER, NOT AFTER IT
    // ══════════════════════════════════════════════════════════════════════════════════════
    //
    // The initial roster pass attaches every mailbox, and each attach used to also drain
    // two bounded batches inline — minutes per mailbox on a real deployment. While that ran, the two
    // things that make this process observable and safe did not exist yet, because both were
    // created AFTER the `await` below. The ordering stays even though the roster pass is now
    // bounded by connect-time: a lock lost during a slow provider dial still has to be handled
    // while it is happening, and 64 mailboxes' worth of connects is not a short window either.
    //
    //  · the pulse, so the boot window wrote one heartbeat and then nothing until the drain
    //    finished. `/health` answered 200 with `standby: true, mailboxes: 0` (the supervisor is
    //    still inside its first `attempt()`), and a worker busily ingesting was indistinguishable
    //    from an idle one — and from a dead one;
    //  · the lock guard, so a lock LOST during a long boot attach was not handled until the
    //    whole roster pass returned. Two workers could be draining the same mailbox for the
    //    length of a backfill, which is the exact split-brain this guard exists to prevent.
    //
    // The cost of moving them up is that `handleLockLoss` can now fire before the work timers
    // exist, so those become nullable and are null-guarded — the same discipline the `booted`
    // declaration above records for its own temporal-dead-zone reason.

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
    // TAKEOVER KICK. `setInterval` fires for the FIRST time only after a full period, so
    // without this line a standby that has just won the lock waits `pollIntervalMs` — 60 s in
    // production — before its first cycle. Measured across a real rolling deploy that showed
    // up as a 68 s gap between the outgoing instance's last cycle and the incoming one's
    // first, while the deploy config promised a much shorter handover; the lock handover was
    // never the slow
    // part (about five seconds), the idle wait for the first tick was.
    //
    // It used to be a partial defence: `attach()` ran `reconcileOnRestart` per mailbox, so mail
    // was not actually unsynced for that minute and only the per-account workflow drains, the
    // time scan and the closing heartbeat waited. That is no longer true and this
    // line covers MAIL as well — attach registers a mailbox and syncs nothing, so without a kick
    // a fresh leader would hold two live IMAP connections and process no mail for a full poll
    // interval.
    //
    // It is now the second of two kicks and the redundancy is deliberate: `reconcileRoster`
    // kicks whenever a pass attached anything, which already covers this boot. `kickCycle` is
    // idempotent, and a boot that depended on the roster pass's kick would be one refactor away
    // from a silent 60 s dead start. Queued rather than awaited: `startWorkerWithLock` must
    // return so the supervisor can publish leadership, and `serialize` puts this behind the
    // initial roster pass that is already on the queue.
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
     * THE API-CRON SCHEDULE — this worker as the clock for the API host's internal passes
     * (billing reconcile hourly, session reap and the SMTP SIZE back-fill daily). The whole
     * argument — why the worker and not the platform cron those routes were written for, why
     * the cadence restarts with leadership, and every overlap arm — is the header of
     * `api-cron.ts`; what is decided HERE is only WHO schedules:
     *
     *  · inside `startWorkerWithLock`, so only the leader-lock holder ever pokes — a rolling
     *    deploy's outgoing and incoming instances cannot both drive a route;
     *  · shard 0 only, because these passes are deployment-wide, not per-shard, and N shard
     *    leaders poking hourly is N−1 too many;
     *  · armed by config (`TF_API_CRON_URL` + `TF_API_CRON_SECRET`), so a self-hosted compose
     *    with its own scheduler stays quiet.
     */
    if (config.apiCron && shardIndex === 0) {
      apiCron = startApiCron({ baseUrl: config.apiCron.baseUrl, secret: config.apiCron.secret, log });
    }
    // ENFORCED SYNC (mail migration 0049): a short scan for mailboxes the API stamped `sync_requested_at`.
    // OFF the serial queue like the alert pass — it is one indexed read plus a compare-and-clear,
    // no adapter operation — and its `kick` REQUESTS a cycle rather than running one, so the actual
    // sync still goes through the single queue. Scoped to `runtimes` so it only ever hastens a
    // mailbox this instance organizes.
    //
    // SINGLE-FLIGHT, because `setInterval` does not wait for its callback: a database that takes
    // longer than 3 s to answer stacks a new pass on top of the slow one every tick — each holding
    // a pool connection, all racing the same compare-and-clear — which turns one slow read into
    // pool pressure at exactly the moment the database is struggling. A tick that finds the
    // previous pass still running skips; the stamp it would have seen is still there for the next.
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
     * ── THE UNIFIEDPUSH WAKE SENDER ───────────────────────────────────────────────────────────
     *
     * Here rather than in the API for the reason `push_subscriptions` had no sender for months:
     * the thing that knows mail arrived is whatever ingested it, and on both the managed host and
     * a self-host compose that is THIS process. The serverless API has no place to keep a LISTEN
     * or a debounce window.
     *
     * It is fed by the change-wake hub rather than called from the ingest path, and that is a
     * decision worth stating: `change_log` is the one place every writer converges — this worker's
     * sync loop, an API mutation, a cron pass — so subscribing to the channel means a wake fires
     * for anything a device would want to pull, not only for the arrivals this file happens to
     * know about. It costs ONE session-mode connection for the whole process (the hub's invariant
     * is streams : connections = N : 1), lazily dialled and released on `end()`.
     *
     * ONLY THE LEADER SENDS. This whole body runs with the shard's advisory lock held; a standby
     * is still waiting for it and reaches none of this, and `clearTimers` takes the sender down
     * the instant the lock is lost. Two instances POSTing to one endpoint is the duplicate-wake
     * shape, and it is the same argument the organizer lease makes about IMAP.
     *
     * The construction cannot fail the boot: a hub whose LISTEN will not establish registers the
     * callback anyway and retries, and the device's own foreground sync is the reliability floor
     * under all of it. Wrapped anyway, because a boot that dies here would take mail syncing with
     * it for a latency feature.
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
       * Said at BOOT rather than left to the first wake, because "are encrypted wakes on" is a fact
       * an operator wants when the process starts — and because both the `absent` and `configured`
       * arms are deliberately silent from then on.
       *
       * `state` and `reason`, and NOT `vapid`/`encryptedWakes`: the logger allow-lists field NAMES
       * and drops the rest. The first managed deploy of this line logged
       * `droppedFields=["vapid","encryptedWakes"]` and therefore said nothing at all — the exact
       * failure the allow-list reports rather than hides. `state` carries the three-valued answer
       * (`configured` / `absent` / `invalid`), which is the whole fact.
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
 * answerable inside a single-file bundle. The self-host organizer image bundles this package
 * into one file, and that file holds FIVE `isCliEntry(import.meta.url)` main guards (this
 * one and the four cron CLIs), all reading the SAME `import.meta.url`. Run directly, all
 * five fire: the crons finish their pass and `flushExit(0)` — a clean exit that kills the
 * supervisor mid-boot, measured as a restart loop on the bundled organizer's first compose
 * boot. So the bundle's entry stub neutralizes `argv[1]` (no guard can match) and starts
 * THIS function explicitly; `scripts/bundle-host.mjs` carries the other half of the story.
 * Under `node dist/index.js` and `tsx src/index.ts` nothing changes: the guard below calls
 * the same function.
 */
export async function runWorkerCli(): Promise<void> {
  await (async () => {
    // THE composition root for logging. `startWorkerWithLock` defaults to `silentLogger` so
    // no test or embedder inherits stdout noise; the process that a human actually deploys
    // is the one that turns the logger on, and it does it exactly once, here.
    //
    // It starts UNBOUND — no `instanceId`, no `environment` — because those come from
    // `loadConfig()`, and reading the environment is one of the two things most likely to
    // fail on a fresh deploy. A logger that cannot exist until the configuration parses is a
    // logger that cannot report a configuration that does not parse. So the bootstrap logger
    // is built first, the crash handlers are hung off it, and it is REPLACED (not rebuilt at
    // each call site) once the config is in hand. `installCrashHandlers` reads it lazily for
    // exactly that reason.
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

      // LIGHT THE NOTICE CHANNEL, ONCE, AND LAZILY.
      //
      // `packages/db` drops notices until a host installs a sink, so without this line the drain is
      // silent rather than structured: strictly safer than the postgres.js default of dumping the raw
      // notice object, but zero diagnostics. Installed here, AFTER `cliLog` has been rebuilt with
      // `instanceId`/`environment`, so a `pg_notice` line is attributable to an instance.
      //
      // Read through a closure rather than captured by value, for the same reason
      // `installCrashHandlers({ log: () => cliLog })` above does it: `cliLog` is REPLACED, not
      // rebuilt at each call site, so a sink holding the value would keep logging through the
      // pre-config logger for the life of the process.
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
