import { ATTACH_DEADLINE_MS, resolveAttachConcurrency } from "../config.js";
import { AttachPool } from "../attach-pool.js";
import type { MailboxRuntime } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: the one queue cycles and roster passes share, the attach pool and the wake. */
export function queueSection(scope: WorkerScope): void {
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
    scope.rosterPending = false;
    /** When the OLDEST unserved request was made — the delay `roster_pass_delayed` reports. */
    scope.rosterPendingSince = 0;
    /** A queued entry is already waiting to serve it; do not queue a second. */
    scope.rosterQueued = false;

    // ── One serial queue for cycles AND roster passes. A roster pass must never close an
    //    adapter a sync cycle is using, and stop() must be able to wait for whatever is in
    //    flight before it closes the DB and releases the lock.
    //
    //    ONE QUEUE, AND A CYCLE IS TWO ENTRIES: the rotation, which serves a roster pass it is
    //    holding up BETWEEN two mailboxes (`yieldToRoster`), and the per-account tail behind it
    //    (`cycleTail`), which yields between slices. No two entries ever run concurrently. The
    //    attaches a pass schedules run beside them in `attachPool`; a mailbox joins `runtimes`, and
    //    so becomes visible to any entry, only once its attach has finished.
    scope.tail = Promise.resolve() as Promise<unknown>;
    function serialize<T>(fn: () => Promise<T>): Promise<T> {
      const run = scope.tail.then(fn, fn);
      scope.tail = run.catch(() => undefined);
      return run;
    }
    async function drain(): Promise<void> { try { await scope.tail; } catch { /* logged at source */ } }

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
     * THE ATTACHES, OFF THE QUEUE (CLOUD-ROSTER-REATTACH-IS-SERIAL). A roster pass schedules its
     * attaches here and returns; at most `attachConcurrency` run at once, one per provider host, each
     * under `attachDeadlineMs`. An attach joins `runtimes` only once it has finished, which is what
     * lets it run beside a cycle: nothing reads a mailbox before its attach is done.
     */
    const attachDeadlineMs = scope.config.attachDeadlineMs ?? ATTACH_DEADLINE_MS;
    const attachPool = new AttachPool({
      concurrency: resolveAttachConcurrency(scope.config.attachConcurrency),
      deadlineMs: attachDeadlineMs,
      onDeadline: (j) => {
        scope.log.warn("mailbox_attach_deadline", {
          mailboxId: j.mailboxId, accountId: j.accountId, latencyMs: attachDeadlineMs,
          reason: "the attach did not finish within its deadline; its connection is closed and the " +
            "mailbox backs off as a timeout",
        });
      },
      onFault: (err) => {
        // Today's "the pass fails and the next pass retries": nothing queued behind a shared fault runs.
        const dropped = attachPool.dropQueued();
        scope.log.error("roster_attach_faulted", {
          err, queued: dropped,
          reason: "an attach met a shared database fault; the attaches still queued are dropped and the " +
            "next roster pass schedules them again",
        });
      },
    });
    scope.attachPoolRef = attachPool;

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
    /** Every mailbox of `accountId` this process serves is owed a visit — work a tail pass wrote. */
    function wakeAccount(accountId: string): void {
      for (const rt of scope.runtimes.values()) if (rt.accountId === accountId) noteWake(rt.mailboxId);
      scope.kickCycle();
    }

    function noteWake(mailboxId: string): void {
      const rt = scope.runtimes.get(mailboxId);
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
    function armWake(): void { scope.wakeSignal = new Promise<void>((r) => { scope.fireWake = r; }); }
    armWake();
    /** Tell a cycle that is blocked on its lanes that there is something new to look at. */
    function nudgeCycle(): void {
      const fire = scope.fireWake;
      armWake();
      fire();
    }

    function backoffFor(attempts: number): number {
      return Math.min(scope.retryBaseMs * 2 ** Math.max(0, attempts - 1), scope.retryMaxMs);
    }
    scope.serialize = serialize;
    scope.drain = drain;
    scope.laneBusy = laneBusy;
    scope.deferredLeaves = deferredLeaves;
    scope.attachDeadlineMs = attachDeadlineMs;
    scope.attachPool = attachPool;
    scope.wakeAccount = wakeAccount;
    scope.noteWake = noteWake;
    scope.nudgeCycle = nudgeCycle;
    scope.backoffFor = backoffFor;
}
