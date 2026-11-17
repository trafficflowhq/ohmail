import type { Tx } from "@trafficflow/db";
import {
  claimHeartbeat, refreshHeartbeat, type LastResortReport, lastResortLogLines, runAlertPass, lastResortSucceeded,
  heartbeatLogLine, planeOpsStateLine, firingToLog, lastResortFailed,
} from "@trafficflow/db/cloud";
import { type UnservedBreakdown, type DegradedCauses, anyDegradedCause } from "../health.js";
import { leaderLockKeyFor, LockLostError } from "../leader-lock.js";
import { apiFaultPrunePass } from "../api-fault-prune.js";
import { alertGapPrunePass } from "../alert-gap-prune.js";
import { alertDrillPass } from "../alert-drill-pass.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: the heartbeat, what the process counts about itself, and the alert pass. */
export function heartbeatSection(scope: WorkerScope): void {
    /**
     * Stamp this leader's row in `worker_heartbeats` — the durable evidence that makes
     * "no leader lock held for > 2 minutes" answerable by a process that is not this one.
     *
     * BEST EFFORT, always. A failed beat must never abort a sync cycle: the worst case is a
     * false "worker down" alert, and the alternative — observability code that can take a
     * working worker offline — is strictly worse than the fault it reports.
     *
     * THE FIRST BEAT OF A TAKEOVER CLAIMS THE ROW AND NO LATER ONE DOES. Every beat used to be the
     * claiming upsert, written with no proof of the lock behind it: a leader whose lock session had
     * gone mute and been ended at the server took the row back from its lawful successor at the end of
     * its next rotation, and from then on the write fence let the one without the lock write and
     * refused the one with it. The claim now writes the row and, holding it, asks the database whether
     * the lock's session (its pid and its mark) holds the lock; on a no the write is taken back. A
     * claim that fails is tried again by the next beat, which is safe because it asks again. After it,
     * a beat only renews, and what a renewal finds is final: a row that no longer names this takeover
     * is a lost lock ({@link renew}).
     */
    async function beat(): Promise<void> {
      if (scope.stopped) return;
      try {
        if (scope.claimed) { await renew(); return; }
        const landed = await claimHeartbeat(
          scope.roster as unknown as Tx,
          { shardIndex: scope.shardIndex, instanceId: scope.leaderToken, shards: scope.shards, startedAt: scope.startedAt, ...counters() },
          { pid: scope.lock.backendPid, key: leaderLockKeyFor(scope.shardIndex), mark: scope.lock.mark },
        );
        if (landed) scope.claimed = true;
        else scope.handleLockLoss(new LockLostError("the database does not show this instance's session holding the lock", "LOCK_UNCLAIMED"));
      } catch (err) {
        scope.log.warn("heartbeat_write_failed", { err });
      }
    }

    /**
     * Renew the row this takeover claimed. A renewal that THROWS is a failed beat and nothing more (the
     * database being away deposes nobody). One that matches NO ROW has been told something: the row
     * names another holder, or nobody. That is a lost lock, quiesced as one; it is never claimed again
     * from here.
     */
    async function renew(): Promise<void> {
      const mine = await refreshHeartbeat(scope.roster as unknown as Tx, { shardIndex: scope.shardIndex, instanceId: scope.leaderToken, ...counters() });
      if (!mine) scope.handleLockLoss(new LockLostError("the heartbeat row no longer names this instance", "LOCK_SUPERSEDED"));
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
      for (const id of scope.servedIds) {
        if (scope.runtimes.has(id)) continue;
        b.total++;
        const lease = scope.leaseBlocked.get(id);
        if (scope.quarantine.has(id)) b.quarantined++;
        else if (scope.awaitingCreds.has(id)) b.awaitingCredentials++;
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
        databaseFault: scope.dbFaultSince !== null,
        dutyGap: scope.dutyGap,
        // Stand-downs subtracted: a mailbox another organizer holds is not a shortfall of this
        // worker's. `UnservedBreakdown.standDown` carries the ruling and the measurement.
        unserved: u.total - u.standDown,
        standDown: u.standDown,
        capacityDropped: scope.truncated,
      };
    }

    /** The live scheduling numbers, shared by `beat`, `pulse` and `stats`. */
    function counters(): {
      mailboxes: number; expected: number; accounts: number; quarantined: number;
      degraded: boolean; lastCycleAt: Date | null; aiCircuitOpenSince: Date | null;
      aiProviderOkAt: Date | null;
    } {
      const connected = scope.runtimes.size;
      return {
        mailboxes: connected,
        expected: scope.expected,
        accounts: scope.dutyAccounts.length,
        // A mailbox that is BACK in the rotation is not quarantined, whatever the map still
        // holds, and since attach stopped draining this filter carries more weight rather than less: the entry
        // is now spent on the mailbox's first SUCCESSFUL CYCLE, not at the end of its attach, so
        // the window in which a mailbox is both in `runtimes` and still in `quarantine` is a
        // whole cycle wide instead of a few statements. Without the filter, `degraded` would read
        // as a fault during every perfectly good re-attach — and `/health`'s `quarantined` is
        // read by the deploy gate, so that would be a self-inflicted 503.
        quarantined: [...scope.quarantine.keys()].filter((id) => !scope.runtimes.has(id)).length,
        // DERIVED from the named causes, never ORed separately. This used to read
        // `dutyGap || truncated > 0 || connected < expected || dbFaultSince !== null` — four
        // conditions, one boolean, and by the time `/health` saw it there was no name left to
        // publish. `anyDegradedCause` is the same predicate over the struct that carries the names.
        degraded: anyDegradedCause(degradedCauses()),
        lastCycleAt: scope.lastCycleAt,
        // The classifier circuit's age, published so something outside this process can see it. The
        // breaker is in-process by design (one circuit per process, sharing one API key), so an outage
        // that opens it is invisible to every other host: mail keeps arriving, files by rules alone,
        // and nothing fails, times out or writes an error row — the whole point of the breaker, and why
        // the state has to leave the process (a fault whose entire symptom is "mail is routed worse"
        // cannot be noticed by a liveness check). FIRST open of the current run, not the newest: the
        // cooldown doubles per trip and the breaker half-opens between them, so an hour's outage
        // produces a series whose latest is always minutes old. Cleared by the first success, so a
        // closed circuit publishes null and the rule stops firing on its own.
        aiCircuitOpenSince: scope.classifierCircuit?.state().firstOpenedAt ?? null,
        // The other half of the sentence above. A closed circuit means "no outage" only if this
        // process has actually had an answer; before its first success it means "no attempt", and
        // a worker replacing another mid-outage is in exactly that state. Publishing it lets the
        // row keep an inherited outage instead of reading a new process's silence as recovery.
        aiProviderOkAt: scope.classifierCircuit?.state().lastSuccessAt ?? null,
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
     * about itself). It renews like every beat after the claim (`renew`): the UPDATE is guarded on `(shard, instance, leader = true)` in the statement — a timer must never resurrect a surrendered leader. The cost: a wedged serial queue keeps beating, caught instead by `sync_lag` at fifteen minutes (a recorded follow-up).
     * NOT BEFORE THE CLAIM: the timer's first tick can come before the boot beat, and a renewal that
     * finds no row of its own yet would read that as superseded and depose every leader at its start.
     */
    async function pulse(): Promise<void> {
      if (scope.stopped || !scope.claimed) return;
      try {
        await renew();
      } catch (err) {
        scope.log.warn("heartbeat_refresh_failed", { err });
      }
    }

    /** What this process last logged per firing alert — see `firingToLog`. */
    const alertFiringLogged = new Map<string, string>();
    /** The plane read this process last logged — see `planeOpsStateLine`. */
    const planeOpsLogged: { key: string | null } = { key: null };
    /** The last-resort page's context and its lines (`alert-last-resort.ts`). */
    const lastResortCtx = () => ({
      sinks: scope.alertSinks, driver: "worker" as const, environment: scope.environment, now: new Date(),
      deliveryStreak: scope.alertDeliveryStreak,
    });
    const logLastResort = (report: LastResortReport | null): void => {
      if (!report) return;
      for (const line of lastResortLogLines(report)) {
        if (line.level === "error") scope.log.error(line.event, line.fields);
        else scope.log.warn(line.event, line.fields);
      }
    };
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
        const result = await runAlertPass(scope.roster as unknown as Tx, {
          ...(scope.config.alertFirstReadMs !== undefined ? { firstReadMs: scope.config.alertFirstReadMs } : {}),
          sinks: scope.alertSinks, shards: [], source: "worker", environment: scope.environment,
          deliveryStreak: scope.alertDeliveryStreak,
          // The roster's parked set: an account it does not sync is never on duty for a page. The
          // at-cap reader is this driver's to run: a pass is periodic, a console request is not.
          parkedAccounts: scope.parkedAccountsReader,
          accountsAtCap: scope.alertReaders.accountsAtCap,
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
          // An API arm exists only where this worker drives the API host's internal routes (the
          // secret is shared); there, an API driver that has never run is dark, not a choice.
          apiArmExpected: Boolean(scope.config.apiCron),
          // The schedule this leader holds, for `api_cron_stale`, with the in-process 5xx poll as one
          // more target. `null` on shards > 0, on the self-hosted organizer and after quiescing:
          // unread, so it clears none of shard 0's rows.
          apiCron: scope.apiCron || scope.signalPoll ? {
            since: (scope.apiCron ?? scope.signalPoll)!.since(),
            targets: [
              ...(scope.apiCron?.health() ?? []),
              ...(scope.signalPoll ? [{ ...scope.signalPoll.health(), inProcess: true as const }] : []),
            ],
          } : null,
          // The billing plane's own failures (`/v1/ops`), shard 0 only; `null` reads nothing.
          planeOps: scope.shardIndex === 0 ? scope.alertReaders.planeOps : null,
        });
        // What the pass did is written HERE, before any further await: `/health`'s pager verdict
        // reads the streak this pass just moved, so a line that waited on a later step lagged it,
        // and was lost for the streak when a later step threw.
        const planeLine = planeOpsStateLine(planeOpsLogged, result);
        if (planeLine?.level === "warn") scope.log.warn("plane_ops_state", planeLine.fields);
        else if (planeLine) scope.log.info("plane_ops_state", planeLine.fields);
        for (const alert of firingToLog(alertFiringLogged, result.firing)) {
          scope.log.warn("alert_firing", {
            alertKey: alert.key, kind: alert.kind, severity: alert.severity,
            count: alert.count, oldestSeconds: alert.oldestSeconds, detail: alert.detail,
          });
        }
        for (const key of result.resolved) scope.log.info("alert_resolved", { alertKey: key });
        for (const key of result.closedUnconfirmed) scope.log.info("alert_closed_unconfirmed", { alertKey: key });
        // What the mail policy did: a held page, the day's digest, the resolutions a pager was told.
        for (const held of result.mailHeld) {
          scope.log.info("alert_mail_held", { alertKey: held.alertKey, kind: held.kind, retryAt: held.retryAt });
        }
        if (result.digest) scope.log.info("alert_digest_sent", { count: result.digest.lines.length + result.digest.more });
        if (result.resolutionsTold.length > 0) {
          scope.log.info("alert_resolutions_told", { alertKeys: result.resolutionsTold });
        }
        if (result.notified.length > 0) {
          scope.log.warn("alert_notified", {
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
          scope.log.error("alert_sink_degraded", {
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
          scope.log.error("alerts_undeliverable", {
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
          scope.log.error("alerts_undeliverable", {
            firing: result.firing.length,
            reason: "no alert sink is configured — set TF_ALERT_EMAIL " +
              "(with RESEND_API_KEY + MAIL_FROM) or TF_ALERT_WEBHOOK_URL",
          });
        }
        // The pass completed: close a last-resort episode, then the bounded dead-man ping.
        logLastResort(await lastResortSucceeded(scope.alertLastResort, lastResortCtx()));
        if (scope.alertHeartbeat.state === "on") {
          const line = heartbeatLogLine(scope.alertHeartbeatLogged, await scope.alertHeartbeat.ping());
          if (line?.event === "alert_heartbeat_failed") scope.log.warn("alert_heartbeat_failed", line.fields);
          else if (line) scope.log.info("alert_heartbeat_restored", line.fields);
        }
        // `api_faults`' seven-day retention, on the cadence of the arm that reads the table.
        // AFTER the pass, never before: the rules read a ten-minute window, so a prune ahead of
        // them could only ever delete rows they were about to ignore — and if it throws, the
        // pass has already delivered. It swallows its own faults; see the module.
        await apiFaultPrunePass(scope.roster as unknown as Tx, new Date(), scope.log);
        // `alert_driver_gaps`' hundred days, on the same terms.
        await alertGapPrunePass(scope.roster as unknown as Tx, new Date(), scope.log);
        // A drill the API queued for this driver (`alert-drill-pass.ts`): last, after every line of
        // the real pass, so it cannot delay a page. Shard 0 only; it never throws.
        await alertDrillPass(scope.roster as unknown as Tx, { sinks: scope.alertSinks, environment: scope.environment, now: new Date(), log: scope.log, shardIndex: scope.shardIndex });
      } catch (err) {
        scope.log.error("alert_pass_failed", { err });
        // A database that is gone or unusable pages from memory, reading and writing nothing. Never throws.
        logLastResort(await lastResortFailed(scope.alertLastResort, err, lastResortCtx()));
      }
    }
    scope.beat = beat;
    scope.unservedBreakdown = unservedBreakdown;
    scope.degradedCauses = degradedCauses;
    scope.counters = counters;
    scope.pulse = pulse;
    scope.alertPass = alertPass;
}
