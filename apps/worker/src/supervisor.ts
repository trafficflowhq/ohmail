import { silentLogger, type Logger } from "@trafficflow/core";
import {
  DEFAULT_HEALTH_PORT, DEFAULT_SERVING_NOTHING_MAX_MS, DEFAULT_SHARDS, DEFAULT_STALE_CYCLE_MAX_MS,
  DEFAULT_STANDBY_RETRY_MS,
  type WorkerConfig,
} from "./config.js";
import { evaluateHealth, startHealthServer, type HealthServer } from "./health.js";
import { acquireLeaderLock, leaderLockKeyFor, type LockLostError } from "./leader-lock.js";
import { startWorkerWithLock, type RunningWorker } from "./index.js";

export type SupervisorState = "standby" | "leader" | "failed" | "stopped";

export interface SupervisedWorker {
  /** The bound health port (resolved — `healthPort: 0` yields an ephemeral one in tests). */
  readonly healthPort: number;
  state(): SupervisorState;
  /** Resolves the moment this instance has won the lock AND is serving. */
  whenLeader(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The DEPLOYABLE entry point. The old CLI threw and `process.exit(1)`ed when
 * another instance held the leader lock — which is exactly what an overlapping
 * rolling deploy produces, so every deploy crash-looped the new instance and could be
 * marked failed. Instead:
 *
 *  • the health server comes up FIRST and answers 200 in standby — a hot spare
 *    that the platform kills can never take over. That patience has a bound:
 *    past `servingNothingMaxMs` an instance that still cannot take the lock is reporting a
 *    wedge, not a deploy. The bound is 24× a measured handover and above the platform's own
 *    health-check timeout, so it cannot be what fails a deployment;
 *  • a lock-held start logs `standby` and retries with a fixed backoff;
 *  • the standby that later wins the lock starts serving, in-process, with no restart;
 *  • a leader that LOSES its lock (session dropped, failover, `pg_terminate_backend`)
 *    quiesces and goes 503 rather than continuing to sync accounts another instance has
 *    legitimately taken over.
 *
 * `startWorker()` keeps its programmatic throw for callers (and the leader-lock test
 * semantics); the supervisor deliberately does NOT go through it — it owns the lock
 * acquisition so it can wait on it.
 */
export async function runWorkerSupervised(
  config: WorkerConfig,
  hooks: { onFatal?: (err: unknown) => void } = {},
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

  let state: SupervisorState = "standby";
  let worker: RunningWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fatal: unknown = null;
  /** Did the CURRENT attempt get the lock? Distinguishes "this instance is broken" from "the DB blinked". */
  let lockWon = false;
  /**
   * The verdict's two clocks, and they are set HERE rather than derived at probe time on purpose: a
   * value computed only when someone asks would restart on every probe and could never exceed
   * a bound. `standbySince` is the process's own start — the state machine only ever leaves
   * standby, never re-enters it — and `leaderSince` is the takeover instant.
   */
  const standbySince = Date.now();
  let leaderSince: number | null = null;
  /** The in-flight lock attempt, so stop() can wait for a takeover instead of racing it. */
  let inflight: Promise<void> | null = null;

  // Read through a function: `state` changes across awaits, which control-flow narrowing
  // cannot see (it would then call the second stop() check unreachable).
  const isStopped = (): boolean => state === "stopped";

  let announceLeader: () => void = () => { /* replaced below */ };
  const leaderPromise = new Promise<void>((resolve) => { announceLeader = resolve; });

  const health: HealthServer = await startHealthServer({
    port: config.healthPort ?? DEFAULT_HEALTH_PORT,
    snapshot: () => {
      const stats = worker?.stats();
      const now = Date.now();
      const leader = state === "leader";
      const standby = state === "standby";
      // A takeover in flight: the lock is ours and `startWorkerWithLock` has not returned. It
      // publishes as `standby: true` (the state machine has not moved yet) and it is the one
      // legitimate reason to be there for minutes, so the verdict measures it separately.
      const takingOver = standby && lockWon;
      const lastCycleAt = stats?.lastCycleAt ?? null;
      const error = fatal === undefined || fatal === null
        ? undefined
        : (fatal instanceof Error ? fatal.message : String(fatal));
      const expected = stats?.expected ?? 0;
      const connected = stats?.mailboxes ?? 0;
      const quarantined = stats?.quarantined ?? 0;
      const databaseFaultSince = stats?.databaseFaultSince ?? null;
      // ── THE NAMED CAUSES, STRAIGHT THROUGH ────────────────────────────────────────────────
      //
      // The worker builds this struct; this closure does not reinterpret it. Before HEALTH-REASON the
      // line here was `workerDegraded: stats?.degraded ?? false` — four conditions arriving as one
      // anonymous boolean, which is why `degraded: true, degradedReason: null` was a state the
      // endpoint could publish at all.
      //
      // The no-worker fallback (standby, or a takeover in flight) has to be the ALL-CLEAR: an
      // instance with no worker yet has no roster to fall short of, and its real conditions are
      // the standby clock's, which are measured below.
      const unserved = stats?.unserved
        ?? { total: 0, quarantined: 0, awaitingCredentials: 0, standDown: 0, leaseUnreadable: 0, unaccounted: 0 };
      const causes = stats?.causes
        ?? { databaseFault: false, dutyGap: false, unserved: 0, standDown: 0, capacityDropped: 0 };
      // THE VERDICT LIVES IN `health.ts` and not in this closure. It used to be one
      // expression here — `leader && expected > 0 && connected === 0 && quarantined > 0` — and
      // the two states it missed cost an eight-minute unannounced outage. A rule that decides
      // whether a deployment may go live is worth a truth table, and a truth table needs a
      // pure function to be a test of.
      const verdict = evaluateHealth({
        now, fatal: error !== undefined, leader, standby, takingOver,
        expected, connected,
        standbySince, leaderSince,
        lastCycleAt: lastCycleAt ? lastCycleAt.getTime() : null,
        maxMs, staleCycleMaxMs,
        ...causes,
      });
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
        databaseFaultSeconds: databaseFaultSince === null
          ? null
          : Math.round((now - databaseFaultSince.getTime()) / 1000),
        lastCycleAt: lastCycleAt ? lastCycleAt.toISOString() : null,
        lagSeconds: lastCycleAt ? Math.round((Date.now() - lastCycleAt.getTime()) / 1000) : null,
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
        error,
      };
    },
  });

  /** The leader lost its advisory lock: the worker already quiesced, so stop advertising. */
  function onLockLost(err: LockLostError): void {
    if (isStopped()) return;
    fatal = err;
    state = "failed";
    log.error("leadership_surrendered", { err, reason: "lock lost; health is now 503" });
    hooks.onFatal?.(err);
  }

  /** One lock attempt: become leader, or stand by and schedule the next attempt. */
  async function attempt(): Promise<void> {
    if (isStopped()) return;
    lockWon = false;
    const lock = await acquireLeaderLock(config.databaseUrl, lockKey);
    if (!lock) {
      log.info("standby", {
        retryInMs: retryMs,
        reason: "the leader lock is held elsewhere; health 200, serving nothing",
      });
      schedule();
      return;
    }
    // Past this point a failure is THIS instance's (bad KEK, broken DB schema): fatal, so
    // the platform replaces it. A failure to even reach the lock stays a standby retry.
    if (isStopped()) { await lock.release(); return; }          // raced with stop()
    lockWon = true;
    const started = await startWorkerWithLock(config, lock, { onLockLost });   // releases the lock if it throws
    // stop() may have been called WHILE we were taking over (a SIGTERM landing during a
    // standby's promotion). Publishing leadership now would leak this worker and its lock:
    // stop() already saw `worker === null` and returned.
    if (isStopped()) { await started.stop(); return; }
    worker = started;
    state = "leader";
    leaderSince = Date.now();
    log.info("leader_acquired", {});
    announceLeader();
  }

  /** Run an attempt while keeping it awaitable by stop(). */
  function runAttempt(): Promise<void> {
    const p = attempt();
    inflight = p;
    void p.catch(() => undefined).then(() => { if (inflight === p) inflight = null; });
    return p;
  }

  function schedule(): void {
    // Deliberately NOT unref'd: a standby process must stay alive to take over.
    timer = setTimeout(() => {
      timer = null;
      void runAttempt().catch((err: unknown) => {
        if (isStopped()) return;
        if (lockWon) {
          // We WON the lock and the worker itself failed → this instance is broken; health
          // turns 503 so the platform replaces it (the lock is already released).
          fatal = err;
          state = "failed";
          log.error("failed_after_takeover", { err });
          hooks.onFatal?.(err);
          return;
        }
        // Never reached the lock (a DB blip mid-deploy): stay standby and keep trying,
        // rather than exiting the hot spare that is supposed to be waiting (risk 10).
        log.error("standby_lock_attempt_failed", { err, retryInMs: retryMs });
        schedule();
      });
    }, retryMs);
  }

  // The FIRST attempt is awaited so a genuinely broken config (bad KEK, dead DB) still
  // fails the boot loudly instead of hiding behind a healthy-looking standby.
  try {
    await runAttempt();
  } catch (err) {
    await health.close();
    throw err;
  }

  return {
    healthPort: health.port,
    state: () => state,
    whenLeader: () => leaderPromise,
    async stop() {
      if (isStopped()) return; // idempotent: SIGINT+SIGTERM, or a test double-stop
      state = "stopped";
      if (timer) { clearTimeout(timer); timer = null; }
      // Wait out an in-flight takeover: `attempt()` re-checks the stopped flag after
      // `startWorkerWithLock` resolves and stops the worker it just started, so no worker
      // and no lock can survive this call.
      if (inflight) { try { await inflight; } catch { /* handled by the attempt's own catch */ } }
      const w = worker;
      worker = null;
      if (w) await w.stop();           // closes IMAP + DB and RELEASES the lock
      await health.close();
    },
  };
}
