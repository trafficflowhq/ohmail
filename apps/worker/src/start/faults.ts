import { isSharedDatabaseFault } from "../dead-letter.js";
import { tailStageRunner } from "../tail-stage.js";
import type { MailboxSyncBlockReason } from "../mailboxes.js";
import type { SyncBlock, WorkerScope } from "./scope.js";

/** The worker's start function, one section: what the worker notes about a mailbox it cannot serve and about a database that answers badly. */
export function faultsSection(scope: WorkerScope): void {
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
      scope.dbFaults++;
      if (scope.dbFaultSince === null) {
        scope.dbFaultSince = Date.now();
        scope.log.error("worker_database_fault", {
          ...at, err,
          reason: "a call to OUR OWN database failed — this is a shared-dependency condition, not " +
            "a fault of this mailbox. No mailbox is counted toward maxSyncFailures, no provider " +
            "backoff is earned, and this pass stops rather than collecting the same failure once " +
            "per mailbox. /health reports degraded until a cycle completes",
        });
        return;
      }
      scope.log.debug("worker_database_fault_repeat", {
        ...at, err, count: scope.dbFaults,
        outageMs: Date.now() - scope.dbFaultSince,
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
    /** The cycle tail's one runner: announces a connection fault before the stage's own line. */
    const { runTailStage, tailFaultNote } = tailStageRunner((err) => noteDatabaseFault(err));

    function clearDatabaseFault(): void {
      if (scope.dbFaultSince === null) return;
      scope.log.info("worker_database_recovered", {
        outageMs: Date.now() - scope.dbFaultSince, faults: scope.dbFaults,
        reason: "a sync cycle completed, so the database is answering again — the roster was never " +
          "quarantined and resumes at its normal cadence",
      });
      scope.dbFaultSince = null;
      scope.dbFaults = 0;
    }
    scope.noteBlock = noteBlock;
    scope.announced = announced;
    scope.smtpSizeAttempted = smtpSizeAttempted;
    scope.noteDatabaseFault = noteDatabaseFault;
    scope.noteIfSharedDatabaseFault = noteIfSharedDatabaseFault;
    scope.runTailStage = runTailStage;
    scope.tailFaultNote = tailFaultNote;
    scope.clearDatabaseFault = clearDatabaseFault;
}
