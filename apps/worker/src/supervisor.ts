import { silentLogger, type Logger } from "@trafficflow/core";
import { pgTransportOf, verifiedHandshakes } from "@trafficflow/db/cloud";
import {
  DEFAULT_DB_WAIT_BASE_MS, DEFAULT_DB_WAIT_CAP_MS, DEFAULT_FIRST_CONTACT_DEADLINE_MS, DEFAULT_HEALTH_PORT,
  DEFAULT_LOCK_HEARTBEAT_MS, DEFAULT_SERVING_NOTHING_MAX_MS, DEFAULT_SHARDS, DEFAULT_STALE_CYCLE_MAX_MS,
  DEFAULT_STANDBY_RETRY_MS, DEFAULT_STUCK_CYCLE_MAX_MS, DEFAULT_SURRENDER_DEADLINE_MS, takeoverDeadlineMsOf,
  timerMs, type WorkerConfig,
} from "./config.js";
import { asDatabaseFault, databaseAwayCodeOf, FIRST_CONTACT_TIMEOUT } from "./db-fault.js";
import { DatabaseFaultError } from "./dead-letter.js";
import {
  errorTokenOf, evaluateHealth, startHealthServer, stuckCycleBoundMs,
  type HealthInput, type HealthServer, type HealthVerdict,
} from "./health.js";
import { acquireLeaderLock, leaderLockKeyFor, type LeaderLock, type LockLostError } from "./leader-lock.js";
import { kekRetirementGate, KekRetiredVersionInUseError } from "./kek-retirement-gate.js";
import type { RetiredKekReferences } from "@trafficflow/db/cloud";
import { startWorkerWithLock, type RunningWorker, type WorkerStats } from "./index.js";

/**
 * `waiting`: the database has not answered this instance (a start with no answer yet, or a leader that
 * lost its lock or gave it up). `standby`: the lock is held elsewhere, or is won and the worker is
 * starting. `leader`: it holds the lock and runs the worker (a stuck one included, until the process
 * exits). `failed`: this instance refused or broke; the process exits.
 */
export type SupervisorState = "waiting" | "standby" | "leader" | "failed" | "stopped";

export interface SupervisedWorker {
  /** The bound health port (resolved — `healthPort: 0` yields an ephemeral one in tests). */
  readonly healthPort: number;
  state(): SupervisorState;
  /** Resolves once this instance leads and serves: at once while it does, else at its next takeover. */
  whenLeader(): Promise<void>;
  stop(): Promise<void>;
}

/** A leader's cycle stood still past its bound with no cause named. The process exits on it. */
export class StuckCycleError extends Error {
  readonly code = "STUCK_CYCLE";
  constructor() { super("the cycle has not moved for longer than its bound"); this.name = "StuckCycleError"; }
}

/** A leader that gave its leadership up could not close what it held in time. The process exits on it. */
export class SurrenderTimeoutError extends Error {
  readonly code = "SURRENDER_TIMEOUT";
  constructor() { super("the worker did not close what it held in time"); this.name = "SurrenderTimeoutError"; }
}

/** First contact was accepted and not answered inside its deadline. Its session is ended; the wait goes on. */
export class FirstContactTimeoutError extends Error {
  readonly code = FIRST_CONTACT_TIMEOUT;
  constructor() { super("the database did not answer first contact inside its deadline"); this.name = "FirstContactTimeoutError"; }
}

/** The lock was won and the worker's start did not finish inside its bound. The process exits on it. */
export class TakeoverTimeoutError extends Error {
  readonly code = "TAKEOVER_TIMEOUT";
  constructor() { super("the takeover did not finish inside its bound"); this.name = "TakeoverTimeoutError"; }
}

/**
 * The wait before attempt `n` (from 0) at a database that is away: `base × 2^n` up to `cap`, drawn
 * from the upper half of the step, so the cap is a cap and several instances do not dial together.
 * Never more than a timer holds.
 */
export function databaseWaitMs(n: number, base: number, cap: number, random: () => number): number {
  const step = timerMs(Math.min(cap, base * 2 ** Math.min(n, 30)));
  return Math.round(step * (0.5 + 0.5 * random()));
}

/**
 * The DEPLOYABLE entry point: one process that leads its shard whenever it can, and says what it is
 * doing while it cannot. The health server comes up FIRST.
 *
 * WHICH START FAILURES WAIT AND WHICH EXIT. A database that is AWAY (`databaseAwayCodeOf`: a refused or
 * closed connection, a server shutting down or starting up, no connection slot, a cancelled first
 * statement, a first contact that was accepted and not answered inside its deadline) is waited through
 * in this process, for as long as it takes: `waiting`, 503 `waiting_for_database`, the next attempt
 * after a growing, capped, jittered wait. Exiting on it handed the outage to the host's restart budget,
 * which a database away for ten minutes spends: on 12 November 2026 the worker exited 81 times and was
 * left stopped for 26 hours after the database came back. Everything else exits at once, as it always
 * has: a refused credential, a database that does not exist, a certificate that does not verify, a
 * missing setting, a schema or key ring this build refuses. Waiting on those would hide a broken
 * deployment behind a quiet instance. A takeover that does not finish inside its bound exits too: a
 * start that hangs cannot be ended from outside it, and the exit is what frees its lock.
 *
 * A lock held elsewhere is a `standby`: 200, a fixed retry, bounded by `servingNothingMaxMs` (a hot
 * spare the platform kills can never take over; one that waits for hours is a wedge). The instance that
 * wins the lock starts serving in-process. A leader that LOSES its lock (session dropped, failover,
 * `pg_terminate_backend`) quiesces exactly as before (`index.ts` `handleLockLoss`); what follows is no
 * longer the end of the process but this same waiting start, once everything the old worker held is
 * closed. `startWorker()` keeps its programmatic throw; the supervisor does NOT go through it — it owns
 * the lock acquisition so it can wait.
 */
export async function runWorkerSupervised(
  config: WorkerConfig,
  hooks: {
    onFatal?: (err: unknown) => void;
    /**
     * TEST SEAM for the key-retirement gate. Absent means the real one (`kek-retirement-gate.ts`),
     * the only state production is in. It is asked until it has answered once, before the lock,
     * and only when `config.kekRetiredThrough` declares a version retired.
     */
    kekRetirementGate?: (databaseUrl: string, retiredThrough: number, signal?: AbortSignal) => Promise<RetiredKekReferences>;
    /** TEST SEAM for the wait's jitter. Absent means `Math.random`. */
    random?: () => number;
  } = {},
): Promise<SupervisedWorker> {
  const shards = config.shards ?? DEFAULT_SHARDS;
  const shardIndex = config.shardIndex ?? 0;
  const retryMs = config.standbyRetryMs ?? DEFAULT_STANDBY_RETRY_MS;
  const lockKey = leaderLockKeyFor(shardIndex);
  // Same seam as `startWorkerWithLock`: silent unless a host injects one. The supervisor's
  // lines carry `shard` because "which shard is standing by" is the only question a rolling
  // deploy makes an operator ask.
  const log: Logger = (config.logger ?? silentLogger).child({ shard: shardIndex, shards });

  const maxMs = config.servingNothingMaxMs ?? DEFAULT_SERVING_NOTHING_MAX_MS;
  const staleCycleMaxMs = config.staleCycleMaxMs ?? DEFAULT_STALE_CYCLE_MAX_MS;
  const stuckCycleMaxMs = config.stuckCycleMaxMs ?? DEFAULT_STUCK_CYCLE_MAX_MS;
  const waitBaseMs = config.dbWaitBaseMs ?? DEFAULT_DB_WAIT_BASE_MS;
  const waitCapMs = config.dbWaitCapMs ?? DEFAULT_DB_WAIT_CAP_MS;
  // Each of these goes to a timer, so each is at most what a timer holds (`timerMs`).
  const surrenderDeadlineMs = timerMs(config.surrenderDeadlineMs ?? DEFAULT_SURRENDER_DEADLINE_MS);
  const firstContactDeadlineMs = timerMs(config.firstContactDeadlineMs ?? DEFAULT_FIRST_CONTACT_DEADLINE_MS);
  const takeoverDeadlineMs = takeoverDeadlineMsOf(config);
  const watchMs = timerMs(config.lockHeartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS);
  const random = hooks.random ?? Math.random;
  const retiredThrough = config.kekRetiredThrough ?? 0;

  let state: SupervisorState = "waiting";
  let worker: RunningWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  let fatal: unknown = null;
  /** Did the CURRENT attempt get the lock? Distinguishes "this instance is broken" from "the DB blinked". */
  let lockWon = false;
  /**
   * The lock of this instance's last takeover. A session it had to end without the unlock's answer may
   * still hold the lock at the server (`LeaderLock.ghost`); the next attempt ends that session first,
   * or this instance would stand by behind itself for as long as the server takes to notice.
   */
  let lastLock: LeaderLock | null = null;
  /**
   * The verdict's clocks, set HERE rather than derived at probe time on purpose: a value computed only
   * when someone asks would restart on every probe and could never exceed a bound. Each is set on
   * entry into its state: `waitingSince` when the database stops answering (a surrendering leader
   * carries its own fault's start over, so the clock spans the outage), `standbySince` when the lock
   * is found held, `leaderSince` at the takeover.
   */
  let waitingSince: number | null = Date.now();
  let standbySince = Date.now();
  let leaderSince: number | null = null;
  /** The code the last attempt failed with, and how many attempts in a row found the database away. */
  let waitingCode: string | null = null;
  let awayAttempts = 0;
  /** The retirement gate has answered "nothing retired is in use"; it is not asked again. */
  let gateCleared = retiredThrough === 0;
  /** The in-flight lock attempt, so stop() can wait for a takeover instead of racing it. */
  let inflight: Promise<void> | null = null;
  /** Ends the sessions of the step of first contact in flight (`contact`). */
  let contacting: AbortController | null = null;
  /** A worker that gave its leadership up and is still closing what it held. */
  let closing: Promise<boolean> | null = null;
  /** The stuck cycle has been reported to the host's hook; it is reported once. */
  let stuckReported = false;
  let leaderWaiters: Array<() => void> = [];

  // Read through a function: `state` changes across awaits, which control-flow narrowing
  // cannot see (it would then call the second stop() check unreachable).
  const isStopped = (): boolean => state === "stopped";
  const isLive = (): boolean => state !== "stopped" && state !== "failed";

  /** Everything the verdict may know, read once: the answer `/health` gives and the act below share it. */
  function healthInput(stats: WorkerStats | undefined, now: number): HealthInput {
    // The no-worker fallback (waiting, standby, or a takeover in flight) has to be the ALL-CLEAR:
    // an instance with no worker yet has no roster to fall short of, and its real conditions are
    // the supervisor's own clocks.
    const causes = stats?.causes
      ?? { databaseFault: false, dutyGap: false, unserved: 0, standDown: 0, capacityDropped: 0 };
    const standby = state === "standby";
    return {
      now, fatal: fatal !== undefined && fatal !== null,
      leader: state === "leader", standby,
      // A takeover in flight: the lock is ours and `startWorkerWithLock` has not returned. It is the
      // one legitimate reason to be in standby for minutes, so the verdict measures it separately.
      takingOver: standby && lockWon,
      waiting: state === "waiting", waitingSince,
      expected: stats?.expected ?? 0, connected: stats?.mailboxes ?? 0,
      standbySince, leaderSince,
      lastCycleAt: stats?.lastCycleAt?.getTime() ?? null,
      cycleProgressAt: stats?.cycleProgressAt?.getTime() ?? null,
      lastRotationMs: stats?.lastRotationMs ?? null,
      databaseFaultSince: stats?.databaseFaultSince?.getTime() ?? null,
      maxMs, staleCycleMaxMs, stuckCycleMaxMs, pollIntervalMs: config.pollIntervalMs,
      ...causes,
    };
  }

  const health: HealthServer = await startHealthServer({
    port: config.healthPort ?? DEFAULT_HEALTH_PORT,
    snapshot: () => {
      const stats = worker?.stats();
      const now = Date.now();
      const input = healthInput(stats, now);
      const { leader, standby, takingOver, expected, connected } = input;
      const lastCycleAt = stats?.lastCycleAt ?? null;
      // The refusal's own sentence says what to put back and is this product's; any other error is
      // named by class and code alone (`errorTokenOf`: a driver's message can carry a host and port).
      const error = fatal === undefined || fatal === null
        ? undefined
        : (fatal instanceof KekRetiredVersionInUseError ? fatal.message : errorTokenOf(fatal));
      const quarantined = stats?.quarantined ?? 0;
      const databaseFaultSince = stats?.databaseFaultSince ?? null;
      const unserved = stats?.unserved
        ?? { total: 0, quarantined: 0, awaitingCredentials: 0, standDown: 0, leaseUnreadable: 0, unaccounted: 0 };
      // THE VERDICT LIVES IN `health.ts` and not in this closure. It used to be one
      // expression here — `leader && expected > 0 && connected === 0 && quarantined > 0` — and
      // the two states it missed cost an eight-minute unannounced outage. A rule that decides
      // whether a deployment may go live is worth a truth table, and a truth table needs a
      // pure function to be a test of.
      const verdict = evaluateHealth(input);
      return {
        // The build identity, first in the body because it is the first thing to read:
        // every other field below is a claim ABOUT a build, and worth nothing until you know
        // which one made it. Resolved once at boot (`loadConfig`), not per probe.
        version: config.buildVersion ?? "dev",
        buildError: config.buildError ?? null,
        leader,
        standby,
        takingOver,
        mailboxes: connected,
        accounts: stats?.accounts ?? 0,
        expected,
        quarantined,
        awaitingCredentials: stats?.awaitingCredentials ?? 0,
        truncated: stats?.truncated ?? 0,
        // Deliberately NOT in `evaluateHealth`'s input: a message the product cannot parse is not a
        // reason to refuse a deployment, and the platform gates a deploy on this endpoint. It is a number
        // to read, never a verdict.
        escalatedMessages: stats?.escalatedMessages ?? 0,
        degraded: verdict.degraded,
        degradedReason: verdict.degradedReason,
        // The breakdown behind `roster_shortfall`. Published whatever the verdict, so that an
        // all-zero object is itself the answer to "is anything unserved" — a field that appears
        // only when something is wrong makes its own absence ambiguous.
        unserved,
        healthy: verdict.healthy,
        unhealthyReason: verdict.unhealthyReason,
        waitingForLockSeconds: standby && !takingOver
          ? Math.round((now - standbySince) / 1000)
          : null,
        waitingForDatabaseSeconds: input.waiting && waitingSince !== null
          ? Math.round((now - waitingSince) / 1000)
          : null,
        waitingForDatabaseCode: input.waiting ? waitingCode : null,
        databaseFaultSeconds: databaseFaultSince === null
          ? null
          : Math.round((now - databaseFaultSince.getTime()) / 1000),
        lastCycleAt: lastCycleAt ? lastCycleAt.toISOString() : null,
        lagSeconds: lastCycleAt ? Math.round((Date.now() - lastCycleAt.getTime()) / 1000) : null,
        lastRotationMs: stats?.lastRotationMs ?? null,
        lastTailMs: stats?.lastTailMs ?? null,
        tail: stats?.tail ?? null,
        // The KEK identity, published field-for-field (risk 2). The API host renders the
        // same `kekEnvIdentity()` object, so drift is a one-glance JSON comparison.
        kekFingerprint: config.kek?.fingerprint ?? null,
        kekActiveVersion: config.kek?.active ?? null,
        kekVersionCount: config.kek?.count ?? null,
        // The API host's exact shape, under the same key, so the drift check really is a diff.
        kek: config.kek
          ? { active: config.kek.active, count: config.kek.count, fingerprint: config.kek.fingerprint }
          : null,
        shard: { index: shardIndex, shards },
        // `[]` when there is no worker yet — a standby has composed no sinks and run no pass,
        // and an empty list is the honest answer rather than a fabricated healthy one.
        alertSinks: stats?.alertSinks ?? [],
        // Null until a worker runs: a standby has no arms to judge.
        pager: stats?.pager ?? null,
        // Same contract: a standby has scheduled nothing, and `[]` is the honest report.
        apiCron: stats?.apiCron ?? [],
        // The wall's reader (mail 0124): the worker's own answer once it runs; before that, the
        // config fact it will be composed from — never a fabricated `composed`.
        parkedReader: stats?.parkedReader ?? (config.entitlements ? "composed" : "absent"),
        dbTls: pgTransportOf(config.databaseUrl) === "verified" && verifiedHandshakes(config.databaseUrl) > 0,
        error,
      };
    },
    // The whole snapshot, counts included, answers only the configured credential (config.ts).
    detailSecret: config.healthDetailSecret ?? null,
  });

  /** This instance refused or broke: 503 `fatal`, and the host's hook ends the process. */
  function fail(err: unknown, event: string, fields: Record<string, unknown> = {}): void {
    if (!isLive()) return;
    fatal = err;
    state = "failed";
    stopWatch();
    log.error(event, { err, ...fields });
    hooks.onFatal?.(err);
  }

  function stopWatch(): void {
    if (watch) clearInterval(watch);
    watch = null;
  }

  /**
   * A leader stops leading and starts over as a waiting start. The order holds the single-leader
   * guarantee: this instance stops calling itself leader at once, everything the old worker held is
   * closed (its pass drained, its mailboxes detached, its pool ended, its lock session ended), and
   * only then is the lock asked for again. A worker that cannot be closed inside the deadline (a
   * statement on a connection that neither answers nor closes) ends the process instead, as a lost
   * lock always did: two workers in one process is not a state to wait in.
   */
  function surrender(since: number): void {
    const w = worker;
    if (!w || !isLive()) return;
    worker = null;
    stopWatch();
    state = "waiting";
    waitingSince = since;
    waitingCode = null;
    awayAttempts = 0;
    leaderSince = null;
    lockWon = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const closed = Promise.race([
      w.stop().then(() => true, (err: unknown) => { log.error("worker_stop_failed", { err }); return true; }),
      new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), surrenderDeadlineMs); }),
    ]).finally(() => { clearTimeout(deadline); });
    closing = closed;
    void closed.then((done) => {
      if (closing === closed) closing = null;
      if (!isLive()) return;
      if (!done) { fail(new SurrenderTimeoutError(), "surrender_timed_out", { boundMs: surrenderDeadlineMs }); return; }
      schedule(0);
    });
  }

  /**
   * The leader lost its advisory lock: the worker already quiesced, so stop advertising and start over.
   * A lock lost while the worker was still starting is dealt with where that start returns (`attempt`).
   */
  function onLockLost(err: LockLostError): void {
    if (!isLive() || !worker) return;
    log.error("leadership_surrendered", { err, reason: "lock lost; waiting to lead again" });
    surrender(worker.stats().databaseFaultSince?.getTime() ?? Date.now());
  }

  /**
   * The leader's own watch, on the verdict `/health` gives. A cycle that stood still past its bound
   * with a database fault on record: give the leadership up and wait for the database in this process
   * (a fresh pool and a fresh lock session when it answers). With no cause named: the host's hook ends
   * the process, because a pass that never returns cannot be stopped from inside, and the host starts
   * it again. Until it is gone this instance still holds the lock and still answers `stuck_cycle`.
   */
  function watchCycle(): void {
    const w = worker;
    if (state !== "leader" || !w || stuckReported) return;
    const stats = w.stats();
    const now = Date.now();
    const input = healthInput(stats, now);
    const reason: HealthVerdict["unhealthyReason"] = evaluateHealth(input).unhealthyReason;
    const boundMs = stuckCycleBoundMs(input);
    if (reason === "stuck_cycle") {
      stuckReported = true;
      const err = new StuckCycleError();
      log.error("stuck_cycle_exiting", {
        err, waitedMs: now - (input.cycleProgressAt ?? input.leaderSince ?? now), boundMs,
        rotationMs: stats.lastRotationMs ?? 0, mailboxes: stats.mailboxes,
      });
      hooks.onFatal?.(err);
      return;
    }
    // Either clock past the bound: the fault's own age, or a cycle that stood still that long
    // before the fault was named.
    const failingSince = input.databaseFaultSince ?? now;
    const stoodStill = now - (input.cycleProgressAt ?? input.leaderSince ?? now);
    if (reason === "database_fault" && (now - failingSince >= boundMs || (input.connected > 0 && stoodStill >= boundMs))) {
      log.error("stuck_cycle_surrendered", {
        outageMs: now - failingSince, boundMs,
        reason: "the database has failed for longer than the stuck bound; waiting for it to lead again",
      });
      surrender(failingSince);
    }
  }

  /** The database did not answer: stay (or become) `waiting` and try again after a growing wait. */
  function waitForDatabase(err: unknown, code: string): void {
    if (state !== "waiting") { state = "waiting"; waitingSince = Date.now(); awayAttempts = 0; }
    waitingCode = code;
    const retryInMs = databaseWaitMs(awayAttempts, waitBaseMs, waitCapMs, random);
    // Once per outage at `error`; every further attempt keeps its own line a level down.
    if (awayAttempts === 0) {
      log.error("waiting_for_database", {
        err, retryInMs,
        reason: "the database is away; this instance waits and retries for as long as it takes, health 503",
      });
    } else {
      log.warn("standby_lock_attempt_failed", { err, retryInMs });
    }
    awayAttempts++;
    schedule(retryInMs);
  }

  /** The database answered: whatever this attempt finds, the wait is over. */
  function databaseReached(): void {
    if (awayAttempts > 0) {
      log.info("database_reached", { waitedMs: Date.now() - (waitingSince ?? Date.now()), attempts: awayAttempts });
    }
    awayAttempts = 0;
    waitingSince = null;
    waitingCode = null;
  }

  /**
   * One step of first contact under its deadline. The driver bounds the handshake alone: a session
   * that completed it and is then neither answered nor closed would hold the attempt for ever, with
   * no retry behind it. Past the deadline the step's own sessions are ended (`signal`) and the step
   * fails as a database that is away; an answer that still arrives is handed to `late` and never used.
   */
  async function contact<T>(step: (signal: AbortSignal) => Promise<T>, late: (answer: T) => void): Promise<T> {
    const ending = new AbortController();
    contacting = ending;
    let expired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const answer = step(ending.signal);
    void answer.then((a) => { if (expired) late(a); }, () => undefined);
    try {
      return await Promise.race([
        answer,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            expired = true;
            ending.abort();
            reject(new FirstContactTimeoutError());
          }, firstContactDeadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (contacting === ending) contacting = null;
    }
  }

  /**
   * One attempt: reach the database, then become leader, or stand by and schedule the next attempt.
   * Resolves when the attempt has been dealt with; rejects only for a failure that is this
   * deployment's own (the caller exits on it).
   */
  async function attempt(): Promise<void> {
    if (!isLive()) return;
    lockWon = false;
    let lock: LeaderLock | null;
    try {
      // ── THE KEY-RETIREMENT GATE, BEFORE THE LOCK ─────────────────────────────────────────────
      //
      // A ring that declares versions retired (`packages/core/src/crypto.ts`) is sound only while no
      // stored secret names one of them, and only the database can say so. Asked before the lock, so a
      // refused worker never becomes the leader, not even for an instant; and no deployment is read
      // healthy before the verdict, because an instance that has not reached the database answers 503
      // (`waiting`). A gate that cannot reach the database is the database being away, never a
      // retirement verdict. With nothing retired the database is not asked at all.
      if (!gateCleared) {
        const refs = await asDatabaseFault("first_contact", () => contact(
          (signal) => (hooks.kekRetirementGate ?? kekRetirementGate)(config.databaseUrl, retiredThrough, signal),
          () => { /* a verdict that came after its deadline is asked for again */ },
        ));
        if (!isLive()) return;
        if (refs.total > 0) {
          // No lock is taken. The health endpoint is up so the refusal is READABLE (503, `error`
          // naming what to put back); the count is this log line's, never the public endpoint's
          // (fields on the logger's census only: `version` is the highest retired one, `rows` the
          // envelopes still naming a retired version; the re-wrap's census names their sites).
          fail(new KekRetiredVersionInUseError(refs), "kek_retired_version_in_use", {
            version: refs.retiredThrough,
            rows: refs.total,
            reason: "a stored secret still names a retired key version; this worker will not take the leader " +
              "lock, and health answers 503 so the deployment fails and the running one keeps serving",
          });
          return;
        }
        gateCleared = true;
      }
      lock = await asDatabaseFault("first_contact", () => contact(
        (signal) => acquireLeaderLock(config.databaseUrl, lockKey, {
          signal, evict: lastLock?.ghost() ?? null,
          onEvicted: () => {
            log.warn("lock_ghost_evicted", {
              reason: "the session of this instance's last lock was still open at the server; it was ended there",
            });
          },
        }),
        // Never lead on a lock that arrived after its deadline: the attempt has moved on.
        (held) => { void held?.release().catch(() => undefined); },
      ));
    } catch (err) {
      if (!isLive()) return;
      const code = databaseAwayCodeOf(err);
      // Not the database being away: this deployment's own fault, under its own class in the log.
      if (code === null) throw err instanceof DatabaseFaultError ? err.cause : err;
      waitForDatabase(err, code);
      return;
    }
    if (!isLive()) { await lock?.release(); return; }           // raced with stop()
    databaseReached();
    if (!lock) {
      if (state !== "standby") { state = "standby"; standbySince = Date.now(); }
      log.info("standby", {
        retryInMs: retryMs,
        reason: "the leader lock is held elsewhere; health 200, serving nothing",
      });
      schedule(retryMs);
      return;
    }
    // Past this point a failure is THIS instance's (bad KEK, broken DB schema): fatal, so
    // the platform replaces it.
    lockWon = true;
    lastLock = lock;
    // The lock is ours and the worker is starting: published as a takeover, as it always was.
    if (state !== "standby") { state = "standby"; standbySince = Date.now(); }
    let started: RunningWorker;
    // releases the lock if it throws
    const starting = startWorkerWithLock(config, lock, { onLockLost });
    let overdue: ReturnType<typeof setTimeout> | undefined;
    try {
      started = await Promise.race([
        starting,
        new Promise<never>((_, reject) => {
          overdue = setTimeout(() => { reject(new TakeoverTimeoutError()); }, takeoverDeadlineMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof TakeoverTimeoutError) {
        // The start is still running and still holds the lock, so the lock is not released under
        // it: this throw ends the process, which frees it. Should the start ever return first, it
        // is closed.
        void starting.then((late) => late.stop(), () => undefined).catch(() => undefined);
        throw err;
      }
      const code = databaseAwayCodeOf(err);
      if (code === null || !isLive()) throw err;
      // The database went away under the takeover. The lock is released and the pool closed
      // (`startWorkerWithLock`), so this is the waiting start again, not a broken instance.
      lockWon = false;
      waitForDatabase(err, code);
      return;
    } finally {
      clearTimeout(overdue);
    }
    // stop() may have been called WHILE we were taking over (a SIGTERM landing during a
    // standby's promotion). Publishing leadership now would leak this worker and its lock:
    // stop() already saw `worker === null` and returned.
    if (!isLive()) { await started.stop(); return; }
    worker = started;
    if (started.stats().lockLost) {
      // The lock went while the worker was starting: it never led, and it has quiesced.
      log.error("leadership_surrendered", { reason: "lock lost during the takeover; waiting to lead again" });
      surrender(Date.now());
      return;
    }
    stuckReported = false;
    state = "leader";
    leaderSince = Date.now();
    watch = setInterval(watchCycle, watchMs);
    log.info("leader_acquired", {});
    for (const resolve of leaderWaiters.splice(0)) resolve();
  }

  /** Run an attempt while keeping it awaitable by stop(). */
  function runAttempt(): Promise<void> {
    const p = attempt();
    inflight = p;
    void p.catch(() => undefined).then(() => { if (inflight === p) inflight = null; });
    return p;
  }

  function schedule(inMs: number): void {
    if (!isLive()) return;
    // Deliberately NOT unref'd: a waiting or standby process must stay alive to take over.
    timer = setTimeout(() => {
      timer = null;
      void runAttempt().catch((err: unknown) => {
        // We WON the lock and the worker itself failed, or the database answered with a refusal
        // that is this deployment's own: health turns 503 and the host replaces the instance (a
        // lock that was won is already released).
        fail(err, lockWon ? "failed_after_takeover" : "start_refused");
      });
    }, inMs);
  }

  // The FIRST attempt is awaited so a genuinely broken deployment (a refused credential, a missing
  // key, a schema this build refuses) still fails the boot loudly. A database that is away does not
  // reject it: the attempt resolves with this instance waiting.
  try {
    await runAttempt();
  } catch (err) {
    state = "stopped";
    await health.close();
    throw err;
  }

  return {
    healthPort: health.port,
    state: () => state,
    whenLeader: () => (state === "leader"
      ? Promise.resolve()
      : new Promise<void>((resolve) => { leaderWaiters.push(resolve); })),
    async stop() {
      if (isStopped()) return; // idempotent: SIGINT+SIGTERM, or a test double-stop
      state = "stopped";
      leaderWaiters = [];
      if (timer) { clearTimeout(timer); timer = null; }
      stopWatch();
      // Wait out an in-flight TAKEOVER: `attempt()` re-checks the stopped flag after
      // `startWorkerWithLock` resolves and stops the worker it just started, so no worker
      // and no lock can survive this call. An attempt that has not won the lock is not waited
      // for (it may sit in a dial for the driver's whole connect timeout): its sessions are ended
      // here, and it releases a lock it wins after this point itself.
      contacting?.abort();
      if (inflight && lockWon) { try { await inflight; } catch { /* handled by the attempt's own catch */ } }
      // …and a worker that was already closing, inside its own deadline.
      if (closing) await closing;
      const w = worker;
      worker = null;
      if (w) await w.stop();           // closes IMAP + DB and RELEASES the lock
      await health.close();
    },
  };
}
