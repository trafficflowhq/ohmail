import { ImapConnectionClosedError, WriteDeclinedError, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { agreeSweepRun, makeDrizzleRepo, type AgreeSweepCursor } from "@trafficflow/core/adapters/drizzle-repo";
import type { Tx, LedgerTx } from "@trafficflow/db";
import { runSyncCycle, type CycleCensus } from "@ohmail/organizer/sync";
/* The memo the cycle's `knownSet` takes, from its OWN subpath and not through the loop's module:
   `one-pipeline.test.ts` holds this file's value import from `@ohmail/organizer/sync` to
   `runSyncCycle` alone, because a second value out of the loop's module would be a second piece of
   the pipeline running here. This is per-attachment state, not a piece of the pipeline. */
import { KnownSetCache } from "@ohmail/organizer/known-set";
import { startTailProgress } from "./drain-tail-progress.js";
import {
  LeaseUnavailableError, OrganizerStandDownError, cycleWriteAuthority, leaseBlockReason,
} from "@ohmail/organizer/lease";
import { sweepHeld } from "@ohmail/organizer/profile";
import { shrinkMetaOnRefusal } from "@ohmail/organizer/request-drain";
import type { ArrivalReader } from "./arrival-backfill.js";
/* MAIL FROM A GAP, the worker's pass for the same reason: on this door no worker rules the mail
   that arrived while nothing organized the mailbox. */
import {
  markOrganizedThrough,
} from "@ohmail/organizer/gap-catchup";
/* THE CORRESPONDENT RETRO, the worker's pass for `ruleRetroPass`'s reason: nobody this account
   wrote to waits at the gate, and on this door no worker will ever walk the held set. */
import {
  CORRESPONDENT_RETRO_EVERY_MS, screenerCorrespondentRetroPass,
} from "@ohmail/organizer/screener-correspondent-retro";
import { threadJoinHealPass } from "@ohmail/organizer/thread-join-heal";
import { inboundQuietPass } from "@ohmail/organizer/inbound-quiet";
import { inStoreLane } from "./store-lanes.js";
import type { LocalRosterRow } from "./identity.js";
import { mirroredMessageCount } from "./local-mirror.js";
import { stampSynced } from "./sync-stamp.js";
import { localRetentionDue, runLocalRetention } from "./local-retention.js";
import { stampNow } from "./pass-cadence.js";
import { loopTurn } from "./loop-hold.js";
import type { LoopDelayReader, LoopDelaySample } from "./loop-delay.js";
import type { SidecarConfig } from "./engine-types.js";
import { LOCAL_JOIN_HEAL_EVERY_MS, LOCAL_INBOUND_QUIET_EVERY_MS, summarizeDrain } from "./engine-routes.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/** The desktop's engine, one section: one mailbox's drain: the cycle, the known set, the settled drain. */
export function drainSection(scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow): void {
      /**
       * The drain itself. Never called from outside this closure, and — since the mailbox-removal design — reached
       * by a READER as well as by an organizer; the `organizing` the GATE handed this pass is what
       * separates them, both for the passes below and for the `role` every cycle runs under.
       */
      /**
       * @param gen  the connection generation the caller read the organizer lease under. Every
       *   step below that WRITES to the mailbox re-checks it, and the drain abandons itself with
       *   {@link ConnectionReplacedError} rather than continuing over a connection it never gated.
       * @param conn the adapter instance that generation belongs to. Passed as a VALUE and spread
       *   over `syncDeps` for each cycle, so that even inside one cycle a re-dial cannot move the
       *   mail: the pipeline writes to the connection whose lease this pass read, or it fails.
       * @param organizing THE ROLE THE GATE READ FOR THIS PASS, passed as a value for the reason
       *   `gen` and `conn` are. It used to read `organizer.organizing` — a field that outlives the
       *   gate and that a stop, a hand-back or a failed poll rewrites mid-pass, so two readers
       *   inside one pass could disagree, and a pass that could not establish its role at all
       *   depended on the gate's unreadable arm having written the cache before the drain read it.
       *   One reading per pass; the cache is re-established at the NEXT pass's gate.
       */
      /**
       * THE KNOWN-SET MEMO, ONE PER ATTACHMENT — `packages/organizer/src/known-set.ts`, on this door.
       * Without it every idle cycle re-read every locator this mailbox holds. DIRTY BY DEFAULT:
       * the proxy drops it on every repo method not classified neutral, `runSyncCycle` on any
       * throw. Two legs hold it here — this process holds an EXCLUSIVE lock on the data directory,
       * so nothing else can write the projection; and the app's own routes share the store without
       * going through the cycle's repo, so the change-log mark {@link changeLogMark} is the
       * comparison. The one writer with no change row is the removal wipe, which runs after the
       * runtime has left the roster, so this memo dies with the attachment that owns it.
       */
      const knownSet = new KnownSetCache(mb.id);
      /** The change-log mark this runtime's last drain left behind; `null` is an unknown. */
      box.knownSetMark = null;

      /**
       * One drain's run of the agree's sweep: one settings-folder read, then up to the core's slice
       * bound. Keeps the cursor while slices remain. Never throws: a failure leaves the letters to
       * the Screener's offer, and says so.
       */
      const sweepAfterAgree = async (sweep: { stamp: Date; cursor: AgreeSweepCursor | null }): Promise<void> => {
        try {
          const clearance = await box.profileSync.sweepClearance();
          const out = await agreeSweepRun(scope.db as unknown as Parameters<typeof agreeSweepRun>[0], {
            accountId: scope.world.accountId, mailboxId: mb.id, stamp: sweep.stamp, held: sweepHeld(clearance), now: scope.now(),
            knowledgeFor: (tx) => makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]),
            ledgerOf: (tx) => tx as unknown as LedgerTx,
            cursor: sweep.cursor,
            ...(config.agreeSweepSlice !== undefined ? { slice: config.agreeSweepSlice } : {}),
            ...(scope.agreePages !== undefined ? { pages: scope.agreePages } : {}),
            ...(scope.agreeSlices !== undefined ? { maxSlices: scope.agreeSlices } : {}),
            ...(scope.walkTurn !== undefined ? { turn: scope.walkTurn } : {}),
          });
          box.agreeSweep = out.next === null ? null : { stamp: sweep.stamp, cursor: out.next };
          scope.log("organizer_agree_sweep", {
            mailboxId: mb.id, verdict: out.verdict, moved: out.total, count: out.senders,
            slices: out.slices, done: out.next === null,
            why: clearance.kind === "unread" ? clearance.why : null,
          });
        } catch (err) {
          box.agreeSweep = null;
          scope.log("organizer_agree_sweep_failed", {
            err, mailboxId: mb.id,
            reason: "the agree's in-window letters were not given to the Screener; the Screener's "
              + "offer still names them",
          });
        }
      };

      const drain = async (
        maxCycles: number, gen: number, conn: MailboxAdapter, organizing: boolean, turns: LoopDelayReader | null,
      ): Promise<number> => {
        // The marker-surfacing preflight, at the top of the drain both doors share. Routing no
        // longer depends on it (`importHoldNow` re-evaluates each cycle) but the confirm
        // surface does: the hold it offers is readable only through the durable marker this
        // preflight writes; without it a takeover could route in hold mode with no candidate on
        // screen and no release. One folder read per pre-seed entry, nothing once seeded or held.
        // ORGANIZER ONLY — a reader has nothing to inherit and never arms the hold.
        /* THE CONNECTION CHECK SITS ABOVE THE ROLE CHECK, on its own line, and both of those
           facts matter. Above, because a pass whose connection has been replaced is stale
           whatever role it holds — a reader cycling over a dead socket is the wedge too. On its
           own line, because `reader-drain.test.ts` reads THIS FILE and requires the role gate to
           be literally `if (organizing) await …`: a source census cannot see through a
           brace, and folding the two together would silently retire a guard that exists to keep
           an organizer-only mailbox write off a reader's drain. */
        box.assertSameConnection(gen, conn);
        if (organizing) await box.profileSync.armHoldFromFolder();
        /* THE AGREE'S SWEEP, after the hold preflight: `agreeSweepRun` decides whether the spent
           stamp was a person's first agree and moves the counted set as intents, slice by slice,
           which this drain's cycles then carry to the mailbox. */
        if (organizing && box.agreeSweep !== null) await sweepAfterAgree(box.agreeSweep);
        // BEFORE the cycles, not after: a resurface is a local database fact and does not depend on
        // the mailbox being reachable, so it must survive a cycle that throws on a dead connection.
        /* THE INSTALL'S OWN WORK, ONCE. See {@link onceForTheAccount}: another mailbox's drain that
           is already doing this is doing it for everybody. ORGANIZER ONLY, and the same
           `if (organizing)` the three passes around it take: the flip writes the triage state the
           mailbox's real organizer owns, so a stood-down install running it surfaces mail a second
           time, on a device nobody handed the mailbox to. The gate is the pass's own docblock held
           to rather than reworded. Literal and on one line, like its neighbours — `reader-drain`
           reads this file and a source census cannot see through a brace. */
        if (organizing) await scope.onceForTheAccount(scope.resurfaceDue);
        /* A RULE'S RETRO WALK, before the cycles for the same reason: the moves it desires are
           reconciled by the cycles of THIS drain. Organizer only, literal, on one line. */
        if (organizing) await scope.onceForTheAccount(scope.retroDue);
        /* MAIL FROM A GAP, once a quiet drain of this tenure has brought the observed folders up to
           date; this drain's cycles reconcile what it desires. Organizer only, literal, on one line. */
        if (organizing) await scope.onceForTheAccount(scope.gapCatchupDue);
        // Due appointments next, ahead of the cycles: a scheduled send has a clock and must not
        // wait out a backlog drain nor be skipped by an inbound cycle's throw (its SMTP dial fails
        // independently and the pass re-arms the row). ORGANIZER ONLY, per `SyncDeps.role`: a
        // stand-down's close of appointments it can no longer keep is best-effort, so a due one
        // can survive into a reader launch, and an ungated pass would claim and SEND it from an
        // install the mailbox's organizer knows nothing about, at a time nobody re-chose.
        box.assertSameConnection(gen, conn);
        if (organizing) await box.sendScheduled(gen, conn);
        // The away responder, directly after the appointment clock and gated the same way. AFTER
        // the cycles would be wrong for the reason the placement note above gives about
        // `sendScheduled`: an away reply has a clock on it too — it is a promise about mail that
        // has just arrived — and it must not wait out a hundred-cycle backlog drain. Its own SMTP
        // dial fails independently of the inbound cycles, and the pass contains its own faults.
        /* ITS OWN CHECK, not the one above `sendScheduled`. The scheduled-send pass sits between
           them and can take a long time — a batch of deliveries, each with its own dial — so by
           the time this line is reached the connection may have been replaced twice over. A guard
           six lines up is a guard about a different moment. */
        box.assertSameConnection(gen, conn);
        if (organizing) await box.answerAway(gen, conn, box.leasePermit);
        /* AND THE RECONCILER — UNGATED, unlike the two lines above it. See its own note: those two
           SEND on the mailbox's behalf and a reader must not; this one settles a reservation THIS
           install wrote, by reading. Gating it would leave a demoted install saying "Sending…" for
           ever, since no other install holds that reservation. After the sender, because the
           sender is the only thing on this door that creates one. */
        await box.reconcileStrandedSends();
        await box.fileOwedSentCopies();
        let cycles = 0;
        /** Did a cycle report an empty backlog, or did the loop simply run out of cycles? */
        let drained = false;
        /** The INBOUND half alone — did any cycle report an empty adapter backlog? The import
            stamp below reads THIS, never `drained`: `initial_import_completed_at`'s contract (and
            the hosted worker's behaviour) is "the inbound backlog emptied", independent of any
            outbound filing the reconciler still owes — a re-opened delete filing or a budget-capped
            queue must extend the DRAIN without withholding the import stamp. */
        let inboundDrained = false;
        // ── ONCE PER DRAIN, BESIDE THE LEASE AND FOR THE SAME REASON ───────────────────────────
        //
        // A drain is one logical pass over a backlog the adapter hands over in bounded batches, and
        // the posture it is filed under must be one posture: re-reading between two batches would
        // let a mailbox change its mind halfway through its own backlog. It is NOT hoisted into
        // `syncDeps` above, which is built once per process — that would freeze the posture for the
        // life of the engine, so an edit in Settings would need a relaunch to take effect.
        const { actSettings, impersonation, ...screening } = await scope.screeningNow();
        /* WHEN THIS DRAIN BEGAN, for the first-import clock. A drain is up to a hundred cycles, and
           the one that finds a first import open lands a large mailbox's first pages before it
           reports — 13.7 minutes of a 47.4-minute import on the reference rig, which the reported
           duration used to leave out. `performance.now()`, matching the reporter's own clock. */
        const passStartedAt = performance.now();
        // The same instant on the store's clock, for `last_sync_at` (see `stampSynced`).
        const passStartedWall = scope.now();
        // Per-cycle wall durations, summarized into one `sync_drain` line below — the read that
        // attributes desktop CPU and quit lag to the pipeline. `Date.now()` deliberately, not the
        // injected `now()`: a test may freeze that clock, and a frozen clock would report every
        // cycle as 0 ms.
        const cycleMs: number[] = [];
        /* What the store's own fsyncs cost this drain: on PGlite they run on the engine's thread. */
        const syncsAtStart = scope.opened.storeSyncs();
        /* WHAT THIS DRAIN DID, counted — the reading behind the idle-cost gates below. `census`
           is the shared loop's own (mailbox-sized derivations, the rows they walked, and what the
           adapter handed over); `checkpoints` is this file's. Both are folded into `sync_drain`,
           so a settled mailbox's poll says in one line whether it did anything at all. */
        /* Zeroed here rather than through a helper, for the import rule above: the TYPE still
           comes from the loop, so a counter added there stops this line compiling — which is the
           direction that keeps a census honest. */
        const census: CycleCensus = {
          cursorBuilds: 0, locatorReads: 0, locatorRows: 0, cursorFolders: 0, observed: 0,
        };
        let checkpoints = 0;
        /* WHERE THE CHANGE LOG STOOD WHEN THIS DRAIN BEGAN — the comparison BOTH gates below
           take, read here and not at the caller because the lease gate writes `ohmail/_meta`
           between the two. One indexed aggregate per drain. The memo's drop is the first gate:
           the app's own routes write this store without going through the cycle's repo, and each
           writes a change row. It is RECORDED at the drain's end as the value read HERE — a route
           that wrote while the drain ran would otherwise be folded into the end reading and drop
           nothing. An unreadable mark is an UNKNOWN and takes the drop path. */
        await scope.knownSetStatisticsOnce();
        const markAtStart = await box.changeLogMark();
        if (markAtStart === null || box.knownSetMark === null || markAtStart !== box.knownSetMark) {
          knownSet.drop("the store moved outside the drain");
        }
        while (!box.stopped && !box.handedBack && cycles < maxCycles) {
          /* THE REFUSAL, AT EVERY CYCLE EDGE. A drain runs for up to a hundred cycles and each
             one moves mail, so the question "is this still the connection I gated?" has to be
             asked repeatedly rather than once at the top. Between two edges the pipeline writes
             to `conn` — the instance, spread below — so a swap cannot redirect a cycle that is
             already running either. */
          box.assertSameConnection(gen, conn);
          const cycleStart = Date.now();
          // The model is resolved once per cycle and never held: `classifierForCycle()` answers
          // `undefined` with no verified model or after repeated faults, so `planChange`'s
          // `classifier &&` short-circuits to rules — the floor between "a suggestion is missing"
          // and "mail stopped arriving". Holding the port across that transition would stall the
          // mailbox behind the first message rules could not settle. `hasBacklog` (inbound the
          // adapter owes) and `owesFiling` (outbound the reconciler owes — budgeted filing, or a
          // delete whose park re-opened a row) are BOTH "is there more to do": stopping on backlog
          // alone declared quiet with a move pending and left a delete unfinished until next poll.
          /* Accounted per cycle, not per drain. The bound was once recorded around the whole
           * `drainPass` (up to a hundred cycles), so a flapping socket miscounted: served cycles
           * that should have ended an outage did not, and a later death advanced the streak from
           * where it stood rather than from one. So a COMPLETED cycle clears the streak and a
           * connection-class failure inside the loop starts its own; the wrapper around `drainPass`
           * still covers failures OUTSIDE the loop — the gate most of all. */
          let cycleServed = false;
          let hasBacklog: boolean;
          let owesFiling: boolean;
          try {
            /**
             * THE CYCLE RUNS IN THE INGEST LANE, and every statement it issues inherits it.
             *
             * This is the only place the name is given: `store-lanes.ts` schedules the one PGlite
             * connection between the mail coming in and everything else asking for it, and an
             * async context is how a statement six calls deep says which it is without every repo
             * method growing a parameter. Unnamed work is interactive, so the reverse mistake —
             * a window's read counted as ingest — is not reachable from here.
             */
            const outcome = await inStoreLane("ingest", async () => runSyncCycle({
            ...box.syncDeps,
            census, knownSet,
            /* THE GATED CONNECTION, spread over `syncDeps`'s live getter on purpose. The getter is
               what lets a re-dialled mailbox use its new connection; this is what stops a drain
               that is ALREADY RUNNING from being handed one. Both are needed and they are not in
               tension: the getter serves the next pass, this serves the current one. */
            adapter: conn,
            ...screening, classifier: scope.ai.classifierForCycle(),
            // Mail 0083. THE ROLE THE GATE ANSWERED FOR THIS DRAIN, spread after `syncDeps` so it
            // wins: a demoted install keeps draining, and every cycle it runs from here is a READER
            // cycle — the mirror grows, `\Seen` is pushed, and nothing is moved, filed or created.
            // `organizing` is the gate's own answer for THIS pass, handed down rather than read
            // back off the engine, so a demotion or a promotion applies to the very next PASS.
            role: organizing ? "organizer" : "reader",
            // The FIRST cycle of a drain files pending moves before its folder walk, so a Move
            // rung by a press reaches the server first. Later cycles follow the previous tail.
            fileBeforeWalk: cycles === 0,
            // A demoted install keeps draining as a READER, and a reader holds no lease — its
            // `\Seen` push is the one verb it may write. The hosted worker's composition, from the
            // same role expression, so "no lease" and "not asked" stay apart at the write boundary.
            writeAuthority: cycleWriteAuthority(organizing ? "organizer" : "reader", box.leasePermit),
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED from
            // the current facts at every cycle edge — never cached; see the worker's cycle for
            // the argument (many arm/release orderings were tried, each with a
            // mirror-image race). One `ohmail/_meta` FETCH per cycle; a store serialize and an
            // indexed read only when a foreign document is present; a faulted read answers what
            // the previous cycle answered.
            importHold: await box.profileSync.importHoldNow(),
          }));
            /* AN ANSWER OVER A CONNECTION WHOSE CLOSE WAS ALREADY REPORTED is neither served nor
               drained: what it read after the close is not the mailbox. */
            if (box.connectionDeadSince !== null && box.deadGeneration === gen && !box.deadByBreach) {
              box.assertSameConnection(gen, conn);      // a replaced connection is refused by name
              throw new ImapConnectionClosedError("the connection closed while this cycle ran");
            }
            cycleServed = true;
            ({ hasBacklog, owesFiling } = outcome);
          } catch (err) {
            /* ── A HAND-OVER IS A STATE CHANGE, NOT A FAILED DRAIN ──────────────────────────
             *
             * `runSyncCycle` makes a mid-cycle stand-down terminal and THROWS it, which the
             * hosted worker's callers need — `reconcile-cron.ts` answers that class with its own
             * stand-down bookkeeping. Here nobody above answers it: the throw reaches
             * `syncUntilQuiet`'s catch, which drops the idle ladder to base, the poll then logs
             * `sync_cycle_failed` and a press is refused in those words — "your sync failed" for
             * somebody moving organizing to their other machine, and the drain's own tail lost
             * with it. The cycle stopped writing at its page; this ends the DRAIN at that page.
             * Nothing is recorded here: the cycle has already written its `stood_down_mid_cycle`
             * verdict, the post-drain writes are refused by the permit's own last verdict, and
             * the next pass's gate re-reads the lease and answers reader — the one derivation of
             * that state. NOT `LeaseUnavailableError`: an unreadable lease is a question with no
             * answer, it keeps counting toward the connection bound, and it leaves as it did.
             */
            /* A DECLINED WRITE ends the drain the same way: nothing of it went out, and the next
               pass's gate re-reads the lease. Remembered so this pass's tail writes nothing either. */
            if (err instanceof WriteDeclinedError) { box.drainDeclined = true; break; }
            if (!(err instanceof OrganizerStandDownError)) throw err;
            break;
          } finally {
            if (cycleServed) box.noteCycleServed();
            /* THE PAGE ENDS WITH THE CYCLE, served or not: what it took is durable before the
               next cycle edge decides anything. */
            await scope.opened.endIngestPage?.();
          }
          cycleMs.push(Date.now() - cycleStart);
          cycles++;
          if (!hasBacklog) inboundDrained = true;
          if (!hasBacklog && !owesFiling) { drained = true; break; }
          /* THE HAND-BACK'S EDGE, and it has to be HERE, ahead of the yield: on a phone leaving
             the screen with no service the platform pauses timers, so a latch read after the
             `setTimeout` below is never read. A cycle's own progress is socket-driven, so this
             edge is reached in the background; the release then runs next in the queue. */
          if (box.handedBack) {
            scope.log("organizer_hand_back_at_cycle_edge", { mailboxId: mb.id, cycles });
            break;
          }
          // Yield, so a backlog drain cannot starve the request handler sharing this event loop.
          await new Promise((r) => setTimeout(r, 0));
        }
        /* AND FOLD THE LOG IN, ONCE, WHERE THE DRAIN ENDS. Inside the loop it cost what it was
           meant to save: a checkpoint re-logs every page touched after it as a full page image,
           11.4 MB a fold on a warm import, so the log grew by half again a message and the store
           spent its time writing it — 23.11 transactions a second against 38.53 with this line
           here. What a kill replays is bounded between folds by the store's own five-minute
           checkpointer, measured at 751 ms a whole interval deep. See {@link INGEST_FOLD_WAL_BYTES}. */
        /* AND ONLY WHEN THE DRAIN TOOK MAIL. `cycles > 0` is true on every settled poll, so the
           growth read was asked once per poll of every open mailbox for a log nothing had
           written — a statement per mailbox per interval, bought for nothing. A drain that wrote
           without taking mail still folds: the tail's condition below compares the change-log
           mark across the WHOLE drain, so a cycle that only applied queued commands is caught
           there, on a read that drain already pays. */
        /* THE UPKEEP RUNS ONE STEP AT A TIME, IN THE STORE'S LANE. Outside it the scheduler is off and
           PGlite answers in microtasks, so the steps ran back to back without a turn — 128 to 282 ms of
           the thread at a first import's end, and a search due inside waited it out. Each step takes a
           turn first, and inside the lane the scheduler shares the connection between its statements. */
        const upkeep = async <T>(step: () => Promise<T>): Promise<T> => {
          await loopTurn();
          return inStoreLane("ingest", step);
        };
        /* A FOLD OR CHECKPOINT WAITS FOR THE WINDOW TO GO QUIET (`db.ts`), AND THE DRAIN DOES NOT WAIT
           WITH IT: the store's chain says when it cannot start at once, and the drain goes on with
           `null` while the work stays queued, so the next pass and its moves are not held. */
        const unlessItWaits = <T>(ask: (onWait: () => void) => Promise<T>): Promise<T | null> =>
          upkeep(() => new Promise<T | null>((resolve, reject) => { ask(() => resolve(null)).then(resolve, reject); }));
        if (cycles > 0 && census.observed > 0
          && (await unlessItWaits((onWait) => scope.opened.foldIfLogGrew(onWait)))?.folded) checkpoints += 1;
        if (cycles > 0 && census.observed > 0) await upkeep(() => scope.statisticsUpkeep.noteIngested(census.observed));
        /* THIS DRAIN TOOK MAIL IN AND EMPTIED THE INBOUND BACKLOG under its gate's claim, so a hand-back's
           window may start at that claim's server stamp (mail 0169). */
        if (organizing && inboundDrained && !box.drainDeclined && census.observed > 0 && box.claimServerAt !== null) {
          const through = box.claimServerAt;
          await upkeep(() => markOrganizedThrough(scope.db as unknown as Tx, mb.id, through)).catch((err: unknown) => {
            scope.log("organized_through_write_failed", {
              err, reason: "where a hand-back's gap window starts could not be recorded; the last value stands",
            });
          });
        }
        /* RETENTION, the hosted horizon on this store: hourly, one batch, never while mail comes in.
           Asked before the lane, which would itself read as mail coming in. See `local-retention.ts`. */
        if (cycles > 0 && localRetentionDue(scope.db)) {
          await upkeep(() => runLocalRetention(scope.db as unknown as Tx, scope.world.accountId, scope.now(), scope.log));
        }
        /* ONE LINE PER DRAIN, WRITTEN AT THE DRAIN'S END — a settled mailbox emits it every poll
           interval, so it stays quiet; a slow or spinning drain is the line that shows it.
           `slowestMs` above the poll interval is the signal to chase. It reports the WHOLE drain,
           tail included, because the tail takes the last checkpoint and the count of those is what
           says whether an idle poll did anything at all; the `finally` is what keeps a tail that
           throws from taking the record of the cycles that ran with it. Literal field keys, not a
           spread of the summary object: the log census refuses a call site whose field set it
           cannot read statically. See `summarizeDrain`. */
        let drainLineWritten = false;
        const turnsRead = (): LoopDelaySample | null => {
          const t = turns?.read() ?? null;
          if (t) scope.drainTurns.fold(t);
          return t;
        };
        const writeDrainLine = (): void => {
          if (drainLineWritten || cycles === 0) return;
          drainLineWritten = true;
          const shape = summarizeDrain(cycleMs);
          const syncsAtEnd = scope.opened.storeSyncs();
          const fsynced = syncsAtStart && syncsAtEnd ? {
            n: syncsAtEnd.files + syncsAtEnd.directories - syncsAtStart.files - syncsAtStart.directories,
            ms: Math.round(syncsAtEnd.ms - syncsAtStart.ms),
          } : null;
          scope.log("sync_drain", {
            cycles: shape.cycles, totalMs: shape.totalMs, slowestMs: shape.slowestMs, drained,
            observed: census.observed, cursorBuilds: census.cursorBuilds,
            locatorReads: census.locatorReads, locatorRows: census.locatorRows,
            cursorFolders: census.cursorFolders, checkpoints,
            storeFsyncs: fsynced?.n ?? null, storeFsyncMs: fsynced?.ms ?? null,
            loopDelayMaxMs: turnsRead()?.maxMs ?? null,
          });
        };
        /* AND THE TAIL SAYS SO WHILE IT RUNS. Everything below is written after the last cycle and
           before the drain line, so on a first import it is the window nobody could see into. A
           tail that finishes inside the interval writes nothing. */
        const tail = startTailProgress(scope.log);
        try {
          tail.phase("suggest-new");
          /* AFTER THE CYCLES, AND THAT ORDER IS THE FEATURE. The senders this asks about are the ones
             the cycles above just brought in, so running it first would spend a whole drain behind the
             mail it is about. It is also OUTSIDE the loop for `resurfaceDue`'s reason turned round: a
             backlog drain is up to a hundred cycles, and asking after each of them would page through
             the same queue a hundred times for one arrival. Before the checkpoint below, so the rows it
             writes are folded into the same fold. */
          await scope.onceForTheAccount(() => scope.suggestNew(screening.ohboxBar));
          /* AND ACT ON WHAT IS STORED, immediately after — the advice just bought is the advice the
             setting promises to act on, and a sender left waiting for a cycle is the whole defect.
             Inside the same once-per-account guard for `suggestNew`'s reason: the queue is per
             account, not per cycle. Behind the organizer gate, unlike `suggestNew`: filing a
             sender writes the rules the mailbox's organizer owns, so a reader never enters it. */
          if (organizing) await scope.onceForTheAccount(() => scope.actOnSuggestions(actSettings));
          /* AND RELEASE WHO WE WROTE TO — the worker's correspondent retro: teach `contacts` our Sent
             copies, release their held mail to the Ohbox, retire an auto-act spam rule over one.
             Behind the organizer gate (it writes the mailbox's desired state and rules), time-gated
             like the join heal, and CONTAINED: held mail stays held and the next gated drain asks. */
          /* THE LIST ADDRESSES FIRST (mail 0150): the retro below asks them before it releases a
             claim, so on the first drain after an update they are read before it runs. */
          tail.phase("list-address-backfill");
          await upkeep(() => scope.onceForTheAccount(scope.backfillListAddresses));
          /* A HELD IMPERSONATION FILED TO SPAM, ONLY WHEN OWED and behind the organizer gate: it writes the
             mailbox's desired state. After the list addresses, which keep a list's claims held. A failed
             settings read reads as off, and a mailbox whose settings question is open or unread waits:
             an Import may bring a tie or the off choice. */
          tail.phase("screener-impersonation");
          if (census.observed > 0) scope.impersonationOwed = true;
          const impersonationOn = impersonation?.on === true;
          if (impersonationOn && scope.impersonationLastOn === false) scope.impersonationOwed = true;
          scope.impersonationLastOn = impersonationOn;
          const impersonationOver = scope.settledMailboxIds();
          if (impersonationOver.join(" ") !== scope.impersonationSettledOver) scope.impersonationOwed = true;
          const impersonationDue = async (): Promise<void> => {
            if (!scope.impersonationOwed || impersonation === undefined || !impersonation.on) return;
            await upkeep(() => scope.fileImpersonations(impersonation, impersonationOver));
          };
          if (organizing) await scope.onceForTheAccount(impersonationDue);
          tail.phase("correspondent-retro");
          const correspondentRetroDue = async (): Promise<void> => {
            if (!scope.passDue(scope.lastCorrespondentRetroAt, CORRESPONDENT_RETRO_EVERY_MS)) return;
            scope.lastCorrespondentRetroAt = stampNow(scope.cadenceClocks);
            try {
              const r = await screenerCorrespondentRetroPass(scope.db as unknown as Tx, { accountId: scope.world.accountId, now: scope.now });
              if (r.released > 0 || r.retired > 0 || r.learned > 0) {
                scope.log("correspondent_retro", { learned: r.learned, released: r.released, retired: r.retired });
              }
            } catch (err) {
              scope.log("correspondent_retro_failed", {
                err,
                reason: "nothing held was released and no rule was retired; each sender is its own " +
                  "transaction, so the next gated drain re-reads the evidence and asks again",
              });
            }
          };
          if (organizing) await scope.onceForTheAccount(correspondentRetroDue);
          // The 0.25.9 press repair, behind the organizer gate: it writes the rules this store owns.
          if (organizing) await scope.onceForTheAccount(scope.repairInferredPresses);
          // The act's past admissions retired, behind the same gate and for the same reason.
          if (organizing) await scope.onceForTheAccount(scope.retireActAdmissions);
          /* AND THE HISTORICAL-NAME REPAIR LAST OF ALL THE WORK, which is the ordering claim the
             suite pins rather than a preference. It is about rows that have been on this disk for as
             long as the install has existed, so nothing it does is urgent, and a cold launch's first
             drain is exactly when the user is watching an empty window fill up. Running it before the
             cycles — or between them — would spend a page of parsing and a write transaction in front
             of the mail somebody is waiting for, every launch, to correct a display name they have
             been reading past for months. Before the checkpoint below for `suggestNew`'s reason: the
             rows it writes belong in the same fold. */
          tail.phase("sender-check-backfill");
          await upkeep(() => scope.onceForTheAccount(scope.backfillSenderChecks));
          tail.phase("name-repair");
          await upkeep(() => scope.onceForTheAccount(scope.backfillStoredNames));
          /* REJOIN THE CONVERSATIONS A FORWARD SPLIT, the same pass the hosted worker runs
             (`@ohmail/organizer/thread-join-heal`) for the reason every pass above is the
             worker's: on this door the store under the user's home IS the authority, no worker
             anywhere else will ever visit it, and a second implementation of the join evidence
             would be a second population of merges decided by different rules. Time-gated
             in-launch (six hours, like the hosted gate) because it repairs presentation — a
             conversation reading as two threads — and its pre-filter is a GROUP BY nobody should
             pay per drain. After the name repair, before the stamp, so its change rows fold into
             the same checkpoint. A failure is CONTAINED like every pass above: threads stay
             split, mail keeps arriving, the next gated drain asks again. */
          tail.phase("thread-join-heal");
          if (scope.passDue(scope.lastJoinHealAt, LOCAL_JOIN_HEAL_EVERY_MS)) {
            scope.lastJoinHealAt = stampNow(scope.cadenceClocks);
            try {
              const r = await threadJoinHealPass({
                db: scope.db as unknown as Tx, apply: true, accountId: scope.world.accountId, log: undefined,
                cursor: scope.joinHealCursor,
              });
              // Persist the resume point for every capped walk — never reset it on a failure: a
              // deterministically failing group would pin the walk to its own page and starve the
              // tail. The pass already retries a failure once in-run, so what remains is
              // persistent and waits for the wrap-around.
              scope.joinHealCursor = r.capped && r.cursor ? r.cursor : undefined;
              if (r.merged > 0) scope.log("thread_join_heal", { merged: r.merged, moved: r.messagesMoved, skipped: r.skipped });
              // A `_failed` suffix, or the sidecar's log filter files it as informational and the
              // only diagnostic of a caught merge failure is lost (`createSidecarLog` classifies
              // by name; see apps/sidecar/src/log.ts).
              if (r.failed > 0) scope.log("thread_join_heal_failed", { failed: r.failed, merged: r.merged, skipped: r.skipped });
            } catch (err) {
              scope.log("thread_join_heal_failed", {
                err,
                reason: "no group committed partially — each is one transaction; split threads " +
                  "stay split and the next gated drain re-reads reality",
              });
            }
          }
          /* NOTICE THE MAILBOX A PROVIDER-SIDE FORWARD EMPTIED — the same pass the hosted worker
             runs (`@ohmail/organizer/inbound-quiet`), for the reason every pass above is the
             worker's: this store is the authority for this install, no worker anywhere else will
             judge it, and a second implementation of the predicate would tell the same mailbox's
             owner two different stories across the doors. Time-gated in-launch (six hours, the
             hosted gate) because the windows it judges are fortnights. After the heal, before the
             stamp — it writes no change rows (the mailbox panel polls `GET /mailboxes`), so the
             checkpoint ordering is indifferent, and the tail keeps all the maintenance in one
             place. A failure is CONTAINED like every pass above: episodes already stamped stand,
             mail keeps arriving, the next gated drain asks again. */
          tail.phase("inbound-quiet");
          if (scope.passDue(scope.lastInboundQuietAt, LOCAL_INBOUND_QUIET_EVERY_MS)) {
            scope.lastInboundQuietAt = stampNow(scope.cadenceClocks);
            try {
              const r = await inboundQuietPass(scope.db as unknown as Tx, scope.now(), { accountId: scope.world.accountId });
              if (r.tripped > 0 || r.cleared > 0) {
                scope.log("inbound_quiet_pass", { tripped: r.tripped, cleared: r.cleared });
              }
            } catch (err) {
              scope.log("inbound_quiet_pass_failed", {
                err,
                reason: "the quiet-mailbox judgment was skipped this drain; stamped episodes " +
                  "stand, nothing trips or clears, and the next gated drain re-reads reality",
              });
            }
          }
          /* HOW FAR THIS MAILBOX HAS GOT, WRITTEN DOWN. On a hosted account these two columns are the
             worker's; here this process IS the worker, and the window's sync line reads them to tell a
             first import apart from a settled mailbox. `inboundDrained` is the distinction that
             matters for the second stamp: a drain that ran out of CYCLES with inbound mail still owed
             has not finished the import, and saying it had would tell somebody their mailbox was
             complete with half of it still on its way — while outbound filing the reconciler still
             owes (the OTHER reason the loop keeps going) is not import and must not withhold the
             stamp. See `sync-stamp.ts`. */
          /* ARRIVAL TIMES THIS STORE LOST, one bounded page, for every role: a read of INTERNALDATE on the
             gated connection, the store's reads and writes in this drain's upkeep. An open window's intake goes first. */
          /* LETTERS THAT LEFT THE SERVER EARLIER lose the words they still hold, a page per drain and
             for every role: a reader's store holds them too. */
          tail.phase("gone-letter-tidy");
          await upkeep(() => scope.onceForTheAccount(scope.tidyGoneLetters));
          tail.phase("arrival-backfill");
          const readArrivals = (conn as Partial<ArrivalReader>).readArrivals;
          if (box.arrivals !== null && typeof readArrivals === "function" && !box.drainDeclined && !box.handedBack) {
            box.assertSameConnection(gen, conn);
            await box.arrivals.step({ readArrivals: (f, v, u) => readArrivals.call(conn, f, v, u) }, upkeep).catch((err: unknown) => {
              scope.log("arrival_backfill_failed", {
                err, mailboxId: mb.id, phase: "store", attempts: 1,
                reason: "the letters still missing an arrival time could not be read from the store; the next drain asks again",
              });
            });
          }
          tail.phase("stamp");
          if (cycles > 0) {
            const stamps = await upkeep(() => stampSynced(scope.db, mb.id, scope.now(), inboundDrained, passStartedWall));
            /* HOW LONG THE FIRST IMPORT TOOK, from the stamps that just decided it — the number
               nobody could read off a log before. The count is a thunk so a settled mailbox's pass
               pays nothing for it; see `first-sync.ts`. */
            await scope.firstSyncLog.report(mb.id, stamps, () => mirroredMessageCount(scope.db, mb.id), passStartedAt);
            /* AND WHETHER THE IMPORT IS STILL OPEN, from the SAME stamps — the state a surface
               renders must not be able to disagree with the line a log carries about one pass. */
            box.firstSync.noteStamps(stamps);
          }
          /* THE TAIL'S FOLD, AND ONLY WHEN THE TAIL WROTE. The suggestions, the name repair, the
             join heal and the stamps all write after the last cycle's fold, and the periodic
             checkpointer bounds the log to five minutes and nothing narrower. But a settled
             mailbox's whole tail is `stampSynced`'s one-row `last_sync_at`, which the next drain
             re-derives — a crash that loses it costs nothing, and it does not earn a fold. Every
             tail pass writing mail writes a change row, so the mark is the comparison; an
             unreadable mark takes the fold rather than skipping it. `inbound_quiet` writes no
             change row and says so itself. AWAITED, and `checkpoint()` never throws. */
          tail.phase("checkpoint");
          const markAtEnd = await box.changeLogMark();
          const tailWrote = markAtStart === null || markAtEnd === null || markAtEnd !== markAtStart;
          if (cycles > 0 && (census.observed > 0 || tailWrote)) {
            if ((await unlessItWaits((onWait) => scope.opened.checkpoint(onWait))) !== null) checkpoints += 1;
          }
          // What the memo above is held against next time — see the note at `markAtStart`.
          box.knownSetMark = markAtStart;
        } finally {
          // The timer goes before the drain line whatever happened, including a throw — a tail
          // that died would otherwise keep saying it was running until the process ended.
          tail.end();
          writeDrainLine();
        }
        if (drained) scope.searchWarmup?.settled();
        return cycles;
      };
      /* THE STORE'S SENTENCE, SETTLED AT EVERY DRAIN'S END (both doors drain through here): a store
         mark anywhere on what the drain threw raises it, a write the store committed since lowers it. */
      const settledDrain = async (
        maxCycles: number, gen: number, conn: MailboxAdapter, organizing: boolean,
      ): Promise<number> => {
        // One loop monitor per drain, stopped whatever the drain did.
        const turns = config.loopDelay?.() ?? null;
        try {
          const cycles = await drain(maxCycles, gen, conn, organizing, turns);
          box.deadLetters.settleStoreFault(undefined);
          return cycles;
        } catch (err) {
          box.deadLetters.settleStoreFault(err);
          throw err;
        } finally {
          if (turns) {
            scope.drainTurns.fold(turns.read());
            turns.stop();
          }
        }
      };

      /* THE REFUSED-ARM SHRINK, one spelling for the poll's gate and the launch's: a `_meta` too full
         to read is swept on the connection the gate asked. A failed sweep's line carries the thrown
         value, so it names its class and code (DESKTOP-LAUNCH-ARM-DOES-NOT-SHRINK). */
      const shrinkRefusedMeta = (err: unknown, conn: MailboxAdapter): Promise<boolean> => shrinkMetaOnRefusal(err, {
        mailboxId: mb.id, accountId: scope.world.accountId, installId: scope.installId, adapter: conn,
      }, scope.now(), (event, detail) => {
        const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
        if (event === "meta_shrink") {
          scope.log("meta_shrink", {
            mailboxId: mb.id, phase: "lease_refused", ran: detail.ran === true,
            swept: num(detail.swept), moved: num(detail.moved),
          });
        } else {
          scope.log("organizer_requests_note", { mailboxId: mb.id, outcome: event, err: detail.err });
        }
      });

      /* A CYCLE THAT DIED ON THE LEASE marks the runtime unreadable, with the reason — the poll's
         failure and a resume's alike, so a phone opened over a refused gate names it at once. */
      const markLeaseRefused = (err: unknown): void => {
        if (!(err instanceof LeaseUnavailableError)) return;
        box.organizer = {
          ...box.organizer,
          unreadableSince: box.organizer.unreadableSince ?? new Date().toISOString(),
          unreadableReason: leaseBlockReason(err),
        };
      };
      box.knownSet = knownSet;
      box.settledDrain = settledDrain;
      box.shrinkRefusedMeta = shrinkRefusedMeta;
      box.markLeaseRefused = markLeaseRefused;
}
