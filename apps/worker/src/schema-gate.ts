import {
  CLOUD_LEDGER_JOURNAL_TAG, CLOUD_LEDGER_RUN_MARKER, CLOUD_LEDGER_SCHEMA_BEHIND,
  CloudLedgerSchemaBehindError, cloudLedgerSchemaReady, isCloudLedgerSchemaBehind, makeOwnedDb,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core";

/**
 * THE WORKER'S HALF OF THE CLOUD 0031 DEPLOY GATE.
 *
 * The API's `/health` census answers `503 schema_incomplete` when
 * `credit_rollup_runs.duration_ms` is missing, so a hosted API deployed ahead of the migration
 * is refused. The worker was not: the platform's health check for it is MEMORY-ONLY — it reads a
 * snapshot and touches no database, deliberately, so a probe can never add load — and therefore
 * it never asked the question at all. A worker could take the leader lock, start serving, and
 * then swallow the run-row insert's 42703 on every pass, leaving the run ledger silently
 * stationary while the console read the gap as stale aggregates.
 *
 * So the worker asks the same question of the same column, ONCE, before it goes anywhere near
 * the leader lock. It cannot ask it through the health endpoint without giving that endpoint a
 * database connection, which is the property the endpoint exists to keep.
 *
 * The three names come from `@trafficflow/db/cloud`, which is also where the API route reads
 * them: the worker's dependency boundary (`apps/worker/src` may import `@trafficflow/core` and
 * `@trafficflow/db` only, enforced by the worker's dependency test) rules out sharing them
 * through the route, and duplicating them here would be the drift the shared constant removes.
 */
export { CLOUD_LEDGER_SCHEMA_BEHIND, CloudLedgerSchemaBehindError };

/**
 * Probe the cloud ledger's marker column on its OWN short-lived handle.
 *
 * A dedicated handle for the same reason `acquireLeaderLock` opens its own connection: this runs
 * before the worker has composed anything, there is no pool yet, and the answer decides whether a
 * pool should be built at all. `makeOwnedDb` rather than a bare driver so the one statement runs
 * under the same server-side deadlines (`WORKER_TIMEOUTS`) as everything else this process does,
 * and it is closed in a `finally`, so a refused boot leaves nothing behind on the server.
 *
 * A connection failure PROPAGATES rather than answering `false`. "The database is unreachable"
 * and "the database is older than this bundle" are different faults with different remedies, and
 * a probe that collapsed them would report a migration gap during a network blip — the standby
 * retry exists for the first one and must keep it.
 */
export async function cloudLedgerSchemaGate(databaseUrl: string): Promise<boolean> {
  const owned = makeOwnedDb(databaseUrl);
  try {
    return await cloudLedgerSchemaReady(owned.db as unknown as Tx);
  } finally {
    await owned.close();
  }
}

/** What a roll-up failure is: this host ahead of its migration, or an ordinary fault. */
export type RollupFailureVerdict = "schema_behind" | "logged";

/**
 * THE ONE PREDICATE FOR A ROLL-UP THROW, so the cycle has no second opinion.
 *
 * `runCreditRollupPass` returns ordinary failures in its report and throws for exactly one
 * cause. That cause must not be a log line: it means this worker cannot record that it ran, on
 * every pass, for as long as it is deployed — the state the API's deploy gate refuses outright.
 * So it is escalated through `onSchemaBehind`, which the supervisor turns into the same named
 * fatal its boot gate raises, and the platform replaces the instance.
 *
 * Everything else stays a logged error, which is the pre-existing behaviour and is right: a
 * throw from this pass must never take the maintenance tail — and the sweeps that already ran
 * with it.
 *
 * It RETURNS its verdict as well as acting on it, so a test can watch the decision rather than
 * infer it from a log.
 */
export function reportRollupFailure(
  err: unknown, log: Logger, onSchemaBehind?: (err: Error) => void,
): RollupFailureVerdict {
  if (isCloudLedgerSchemaBehind(err)) {
    log.error("credit_rollup_schema_behind", {
      err,
      journalTag: CLOUD_LEDGER_JOURNAL_TAG,
      marker: `${CLOUD_LEDGER_RUN_MARKER.table}.${CLOUD_LEDGER_RUN_MARKER.column}`,
      reason: "the run row cannot be written because this worker is deployed ahead of the " +
        "cloud ledger's migration, so every pass would do its work and be unable to record " +
        "that it did; leadership is surrendered and health goes 503 rather than leaving the " +
        "run ledger stationary behind a healthy-looking instance",
    });
    onSchemaBehind?.(err instanceof Error ? err : new CloudLedgerSchemaBehindError());
    return "schema_behind";
  }
  // Unreachable by the pass's contract for every other cause, and caught anyway: an unexpected
  // throw here would take the whole maintenance tail with it, including the sweeps above that
  // have already run.
  log.error("credit_rollup_threw", { err });
  return "logged";
}
