import type { Tx } from "@trafficflow/db";
import { WriteDeclinedError, isImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { CYCLE_WAKE_REVISITS, nextTurnMessages } from "../config.js";
import { LockLostError } from "../leader-lock.js";
import { newCycleCensus, runSyncCycle, LeaderFencedError, refusalIsRemoval } from "@ohmail/organizer/sync";
import {
  driveOutstandingRequests, applyMetaRequests, settleOwnOutstandingRequests, shrinkMetaOnRefusal,
} from "@ohmail/organizer/request-drain";
import { isSharedDatabaseFault, breachSetAside } from "@ohmail/organizer/dead-letter";
import { asDatabaseFault } from "../db-fault.js";
import { ClassifierFaultError } from "../ai-circuit.js";
import { sensitiveBackfillPass } from "../sensitive-backfill.js";
import {
  markOrganizedThrough, stampMailboxSyncNow, stampInitialImportComplete, stampImportProgress, stampSyncProgress,
} from "../mailboxes.js";
import { syncProfileMirror } from "@ohmail/organizer/profile";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import {
  writeDoorOf, cycleWriteAuthority, leaseStoodDown, LeaseUnavailableError, leaseBlockReason,
  OrganizerStandDownError,
} from "@ohmail/organizer/lease";
import type { MailboxRuntime } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: the cycle: one visit per served mailbox. */
export function cycleSection(scope: WorkerScope): void {
    /** One sync pass over the rotation, then the per-account DB passes. Never throws. */
    async function cycle(): Promise<void> {
      if (scope.stopped) return;
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
      const settled = (rt: MailboxRuntime): boolean => rt.lastSuccessAt !== null && !woken(rt);
      /**
       * Runtimes still owed a bounded batch this pass: first-syncers, then the woken, then those whose
       * turns run long (`longTurns`: their one turn is the pass's longest, so it starts first), then the rest.
       */
      const pending: MailboxRuntime[] = [...scope.runtimes.values()]
        .filter((rt) => rt.lastSuccessAt === null)
        .concat(
          [...scope.runtimes.values()].filter(woken).sort((a, b) => (a.wokenAt ?? 0) - (b.wokenAt ?? 0)),
        )
        .concat([...scope.runtimes.values()].filter((rt) => settled(rt) && rt.longTurns))
        .concat([...scope.runtimes.values()].filter((rt) => settled(rt) && !rt.longTurns));
      /** Mailbox ids that have had their turn this pass — at most one each. */
      const servedIds = new Set<string>();
      /**
       * Admit first-syncers that joined the rotation since this pass planned it, at the front.
       *
       * Called only right after `yieldToRoster()`, i.e. at a point where nothing is suspended
       * inside an adapter — the same property that makes the pass's own detaches safe there.
       */
      function admitNewFirstSyncers(): void {
        for (const rt of scope.runtimes.values()) {
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
       * break per-mailbox serialization); and under {@link CYCLE_WAKE_REVISITS}, past which the mailbox keeps its wake and leads the next pass UNLESS another lane holds this one open (`heldOpenByAnother`).
       */
      function admitWoken(): void {
        for (const rt of scope.runtimes.values()) {
          if (rt.wokenAt === null) continue;
          // One turn a pass for a mailbox whose turns run long: its wake leads the next pass instead.
          if (rt.longTurns) continue;
          if (!servedIds.has(rt.mailboxId)) continue;
          if (scope.laneBusy.has(rt.mailboxId)) continue;
          if (pending.includes(rt)) continue;
          const spent = revisits.get(rt.mailboxId) ?? 0;
          const overCap = spent >= CYCLE_WAKE_REVISITS;
          if (overCap && !heldOpenByAnother()) continue;
          revisits.set(rt.mailboxId, spent + 1);
          revisitAllowed.add(rt.mailboxId);
          if (overCap) overCapAdmitted.add(rt.mailboxId);
          pending.unshift(rt);
        }
      }
      /**
       * PAST THE CAP, A TURN THAT CANNOT LENGTHEN THE PASS. A burst spends the four revisits in
       * seconds, and the fifth wake waited for the pass to end — its slowest lane, 149 s and 159 s
       * in production (2026-10-09). A pass is held open by a lane on a BOUNDED turn (an own turn or
       * an in-cap revisit), so a turn taken then costs the pass nothing — unless an unserved mailbox
       * that could take the lane is waiting for it. Over-cap lanes never count as the holder: two
       * woken mailboxes could otherwise keep each other's pass open for ever.
       */
      function heldOpenByAnother(): boolean {
        if (unservedWaiting()) return false;
        // A due lane (`admitDue`) holds here like an own turn: it is bounded, and a wake past the
        // cap admits nothing after it, so the two cannot keep each other's pass open.
        for (const id of inFlight.keys()) if (!overCapLanes.has(id)) return true;
        return false;
      }
      /** An unserved mailbox that could take a free lane right now: it goes before any second turn. */
      function unservedWaiting(): boolean {
        return pending.some((p) => !servedIds.has(p.mailboxId) && admissible(p));
      }
      /**
       * A lane on a mailbox's OWN turn of this pass (or an in-cap wake) is in flight: not an over-cap
       * wake, not a due turn. Only such a lane lets a due turn start, so due turns can never keep
       * each other's pass open: once the last of these returns, the due lanes drain and it ends.
       */
      function longLaneInFlight(): boolean {
        for (const id of inFlight.keys()) if (!overCapLanes.has(id) && !dueLanes.has(id)) return true;
        return false;
      }
      /**
       * A MAILBOX DUE ITS POLL AGAIN TAKES A FREE LANE (ROSTER-ROTATION-STUCK-UNDER-PARK).
       * A pass gives each mailbox one turn and ends when its lanes return, so two long batches used
       * to hold it open while the third lane idled and every other mailbox, due its poll again, waited
       * for them: 20 s at an 80 ms poll in the test that found it, a deep batch's length in
       * production. Admitted here, only while all of these hold, each one load-bearing:
       *  - a lane is free, and nothing already queued could take it (`queuedWaiting`): a due turn
       *    never goes ahead of a first turn, a new first-syncer or a rung doorbell's revisit;
       *  - a lane on a bounded turn of its own is in flight (`longLaneInFlight`), so a due turn only
       *    fills time the pass is already spending and never holds it open for anyone;
       *  - the mailbox has had its turn this pass, is in no lane (one turn of a mailbox at a time),
       *    is not already queued, is owed no post-loop action (`owedAfterThePass`), carries no unserved wake (a rung doorbell goes through
       *    `admitWoken` and its bound, unchanged), and its own `pollIntervalMs` has passed since its
       *    last visit ENDED, or a long turn (`longTurns`) holds the pass and a kick came after that visit. IDLE
       *    does not exempt it: the doorbell rings for new INBOX mail only, so flag changes from other
       *    devices and every other folder still arrive by the poll; its own turns are not long (one turn a pass);
       *  - it is admissible now (its account has no lane, and the heavy cap holds), so a heavy
       *    mailbox still holds only its own lane.
       * Oldest-due first, at most one candidate per free lane and per account. The fill loop below
       * consumes each through `revisitAllowed`, exactly once.
       */
      function admitDue(): void {
        let free = scope.cycleLanes - inFlight.size;
        if (free <= 0 || queuedWaiting() || !longLaneInFlight()) return;
        const now = Date.now();
        const accounts = new Set<string>();
        const due = dueCandidates().filter((rt) => now - rt.lastVisitEndedAt! >= scope.config.pollIntervalMs
          // A long turn holds this pass while another is owed: whoever was visited before that
          // kick goes again now rather than waiting out the import's turn.
          || (longInFlight > 0 && rt.lastVisitEndedAt! < scope.lastKickAt));
        for (const rt of due) {
          if (free <= 0) break;
          if (accounts.has(rt.accountId) || !admissible(rt)) continue;
          accounts.add(rt.accountId);
          revisitAllowed.add(rt.mailboxId);
          dueAdmitted.add(rt.mailboxId);
          pending.unshift(rt);
          free--;
        }
      }
      /**
       * Anything queued that could take a free lane now: an unserved mailbox, a first-syncer
       * (`admitNewFirstSyncers`) or a doorbell revisit (`admitWoken`). Each goes before a due turn;
       * counting only the unserved let due turns queue in front of a rung doorbell and hold it until
       * the long lanes ended.
       */
      function queuedWaiting(): boolean {
        return pending.some(admissible);
      }
      /**
       * A runtime this pass already queued for a post-loop detach (quarantine, reconnect, stand-down,
       * a closed connection) takes no due turn: one at `maxSyncFailures` would succeed, reset its
       * failures, and still be quarantined after the loop as broken.
       */
      function owedAfterThePass(rt: MailboxRuntime): boolean {
        return scope.closedOwed.has(rt.mailboxId) || toStandDown.includes(rt)
          || toQuarantine.some((q) => q.rt === rt) || toReconnect.some((r) => r.rt === rt);
      }
      /** Served, unwoken runtimes whose turns are not long, free to take another turn once due, oldest visit first. */
      function dueCandidates(): MailboxRuntime[] {
        return [...scope.runtimes.values()]
          .filter((rt) => servedIds.has(rt.mailboxId) && !scope.laneBusy.has(rt.mailboxId) && !pending.includes(rt)
            && rt.wokenAt === null && rt.lastVisitEndedAt !== null && !rt.longTurns && !owedAfterThePass(rt))
          .sort((a, b) => a.lastVisitEndedAt! - b.lastVisitEndedAt!);
      }
      /**
       * When the oldest ADMISSIBLE candidate comes due, if a lane is free and the pass is held by a
       * long lane: the instant the loop must wake for even though no lane returned and no doorbell
       * rang. Admissible only: one already due but held back by its account's lane or the heavy cap
       * can move only when a lane returns, which the race already waits for, and timing it would
       * re-arm a zero-delay timer every round, a spin for as long as that lane runs.
       */
      function nextDueAt(): number | null {
        if (scope.cycleLanes - inFlight.size <= 0 || queuedWaiting() || !longLaneInFlight()) return null;
        let at: number | null = null;
        for (const rt of dueCandidates()) {
          if (!admissible(rt)) continue;
          const due = rt.lastVisitEndedAt! + scope.config.pollIntervalMs;
          if (at === null || due < at) at = due;
        }
        return at;
      }
      /** Admitted by `admitDue`, lane not yet started — consumed at lane start. */
      const dueAdmitted = new Set<string>();
      /** Mailbox ids whose IN-FLIGHT lane is a due turn. */
      const dueLanes = new Set<string>();
      /** Due turns this pass gave, for `cycle_phases`. */
      let dueRevisits = 0;
      /**
       * {@link closedOwed}, served here: a runtime a lane is inside waits for that lane to return, and
       * one this pass will QUARANTINE is left to the post-loop step (main's order) — detached and
       * re-attached here, it would come back with zero failures and the quarantine would skip it.
       */
      async function detachClosedBetweenTurns(): Promise<void> {
        for (const [id, rt] of [...scope.closedOwed]) {
          if (scope.laneBusy.has(id)) continue;
          if (toQuarantine.some((q) => q.rt === rt)) continue;
          scope.closedOwed.delete(id);
          if (scope.runtimes.get(id) !== rt) continue;
          await scope.detach(rt, scope.CLOSED_DETACH_REASON);
          scope.requestRoster();
        }
      }
      /** Admitted past the cap, lane not yet started — consumed at lane start. */
      const overCapAdmitted = new Set<string>();
      /** Mailbox ids whose IN-FLIGHT lane was admitted past the cap. */
      const overCapLanes = new Set<string>();
      /**
       * Re-apply the PLANNING order to what is left of `pending`, so a wake that lands MID-PASS for a
       * mailbox that has NOT had its turn moves it forward instead of leaving it at its snapshot
       * position. `admitWoken` handles the already-served half; this is the other, measured one: the
       * pass plans its order once at the top, so a doorbell ringing two seconds into a seven-minute
       * pass for the last mailbox in the snapshot bought nothing (probe 2 of 2026-08-26 waited 478 s
       * with `wokenAt` set). A STABLE re-partition into the planner's four groups (first-syncers
       * untouched, then woken by oldest wake, then those whose turns run long, then the rest) — it moves mailboxes only BETWEEN turns
       * (never one a lane holds), consumes nothing, and admission re-applies every rule at fill time. Runs every turn; the array is at most the shard's mailbox count, so the sort is noise.
       */
      function reorderPending(): void {
        const rank = (rt: MailboxRuntime): number =>
          rt.lastSuccessAt === null ? 0 : rt.wokenAt !== null ? 1 : rt.longTurns ? 2 : 3;
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
      /** Lanes in flight holding a mailbox whose turns run long (`longTurns`). */
      let longInFlight = 0;
      /**
       * The length a mailbox's turn is steered toward: shorter while another mailbox of its account is
       * attached, since one cycle per account keeps that one out of every lane for the whole turn.
       */
      function turnTargetMs(rt: MailboxRuntime): number {
        for (const other of scope.runtimes.values()) {
          if (other !== rt && other.accountId === rt.accountId) return scope.sharedAccountTurnMs;
        }
        return scope.heavyTurnMs;
      }
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
        if (rt.owesBacklog && heavyInFlight >= scope.heavyLanes) return false;
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
        // A visit that does not reach the evaluation below leaves the gap pass withheld.
        scope.gapClearances.delete(rt.mailboxId);
        try {
          // ── THE LEASE IS RE-VERIFIED EVERY CYCLE, BEFORE THE PIPELINE RUNS ──────────────
          //
          // A claim is evidence for exactly the cycle that read it. Gating only at attach would
          // mean a mailbox that changed hands — a user adding it to another install, a takeover
          // authorized in Cloud's UI — kept being organized by this process until the next
          // restart, which is the steady-state dual organizing the lease exists to make
          // impossible. `runSyncCycle` ingests THROUGH the pipeline, so there is no weaker
          // "sync but do not organize" position available here: syncing IS organizing.
          const organize = await scope.mayOrganize(
            { mailboxId: rt.mailboxId, accountId: rt.accountId }, rt.lease, rt.holderSeen, rt, rt.adapter, "cycle",
            rt.requestKey,
            // Once per release: only the visit after an organizing cycle flushes.
            rt.role === "organizer" ? () => scope.leaveSettings(rt) : undefined,
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
          // Organizing leaves the window to the pass: the next reader look writes it once either way.
          if (organize) rt.holderSeen.gapOpen = undefined;
          if (organize && !wasOrganizer) {
            // BEFORE the cycle, so this very pass files into a tree that exists. It is idempotent
            // (the adapter creates only what is missing) and it is the first write this process is
            // entitled to make against this mailbox, which is why it is here and not one line
            // earlier: `mayOrganize` returning true is the entitlement.
            await rt.adapter.ensureFolders(writeDoorOf({ lease: rt.leasePermit }));
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
             * `runSyncCycle` runs this pass with no `importHold` and files the inherited
             * history into `ohmail/Screener`. BEFORE `runSyncCycle`, like `ensureFolders`: the first
             * cycle does the damage, so arming it afterwards arms it too late. */
            await rt.profile.armHoldFromFolder();
            scope.log.info("organizer_promoted", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "a human asked this install to organize this mailbox and the lease agreed; "
                + "the folder tree is ensured and this cycle organizes — no relaunch",
            });
            if (rt.agreeStamp) rt.agreeSweep = { stamp: rt.agreeStamp, cursor: null };
          }
          // Read once: a stamp spent without a flip (already organizing) owes nothing.
          rt.agreeStamp = null;
          // The sweep this promotion started, or the slices an earlier visit left; a demotion ends it.
          if (organize) await scope.agreeSweepVisit(rt);
          else rt.agreeSweep = null;
          if (!organize && wasOrganizer) {
            // The profile module's memory of ORGANIZING this mailbox goes with the role. See
            // `forgetOrganizerLife` for what it holds and why keeping it across a handover makes
            // the NEXT promotion skip its own preflight and then supersede the document the other
            // organizer left. Purely in-process; the durable markers stand.
            rt.profile.forgetOrganizerLife();
            scope.log.info("organizer_demoted_to_reader", {
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
            scope.noteBlock(scope.leaseBlocked, rt.mailboxId, null);
            await scope.refreshReaderHolder(
              { mailboxId: rt.mailboxId, accountId: rt.accountId }, rt.adapter, rt.holderSeen,
            );
            /* And cache the organizer's settings document, once per reader cycle (mail 0094). A
             * reader's own responder/rule/window/signature rows are inert: the ones in force are in the
             * published document of the install that HOLDS this mailbox, so the reader keeps a copy
             * and `GET /mailboxes/:id/profile` serves that (ruling 6's Critical). A SIBLING of
             * `refreshReaderHolder`, not a line inside it: that one RETURNS EARLY when no holder column
             * moved, so folded in, the mirror would refresh only when the HOLDER changed. Probed, not
             * asserted (`profileIo` is an accessor a double need not carry). The document read cannot
             * throw past it; its own SELECT and writes can, so the call is tagged: a dead database met
             * here is the shard's fault, never this mailbox's. */
            const mkIo = (rt.adapter as Partial<{
              profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
            }>).profileIo;
            if (typeof mkIo === "function") {
              /* A NAMED READER IDENTITY. `readOrganizerProfile` remembers a position per
                 identity, so borrowing this install's own would let a read and the organizer
                 write-behind share one anchor. */
              const io = mkIo.call(rt.adapter, { installId: "reader-profile-mirror", mailboxId: rt.mailboxId });
              await asDatabaseFault("cycle.syncProfileMirror", () => syncProfileMirror({
                db: scope.forAccount(rt.accountId).db, accountId: rt.accountId, mailboxId: rt.mailboxId, io,
                now: new Date(), log: (event, detail) => { scope.log.info(event, detail); },
              }));
            }
          } else {
            scope.leaseBlocked.delete(rt.mailboxId);
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
          const census = newCycleCensus();
          try {
            /* The routing hold, evaluated once per cycle (see `importHold` below); its outcome is
               also the gap pass's clearance, handed to the tail as data. */
            const importHold = rt.role === "organizer" ? await rt.profile.importHoldNow() : undefined;
            if (rt.role === "organizer") scope.gapClearances.set(rt.mailboxId, rt.profile.gapClearance());
            syncOutcome = await runSyncCycle({
            ...rt.deps, ...scope.aiFor(rt.mailboxId, rt.accountId), ...(await scope.screeningFor(rt.accountId)),
            census,
            batchMessages: rt.turnMessages,
            // Mail 0083. THE ROLE THE GATE JUST ANSWERED, spread over the attach-time deps so a
            // flip applies to THIS pass rather than to the one after the next re-attach. Placed
            // after the spread deliberately: it must win over `rt.deps.role`, which is only ever
            // the value the attach saw.
            role: rt.role,
            /* AND THE AUTHORITY THAT ROLE RIDES: the permit THIS cycle's gate took when it
             * organizes, a reader's authority when it does not. `mayOrganize` writes the permit
             * only on its organize arm, so for a reader `rt.leasePermit` is the attach seed or a
             * permit from before a demotion — whose page check re-ran the lease's write gate from
             * a reader cycle. One composition, the local engine's too (`cycleWriteAuthority`). */
            writeAuthority: cycleWriteAuthority(rt.role, rt.leasePermit),
            // Told when this pass HOLDS a first-contact sender at the gate — the suggest-owed
            // mark's writer ({@link SyncDeps.onScreenerHold}), fire-and-forget by design.
            onScreenerHold: scope.noteScreenerHold,
            // The cap is refreshed per cycle like the screening posture beside it, so an
            // upgrade's headroom (or a downgrade's new ceiling) applies without a re-attach.
            storageCap: await scope.storageCapFor(rt.accountId),
            // Inside a trial's floor the plan's own limit, the refill's ceiling; the same cached read.
            storagePlanLimit: await scope.storageCapFor.planLimit(rt.accountId),
            // The routing half of the organizer-profile hold (TAKEOVER-RESCREEN), EVALUATED
            // from the current facts at every cycle edge — never cached: the defects
            // measured that any arm/release choreography over a folder, a store and a
            // resolutions table that all move independently has a mirror-image race for every
            // ordering. `importHoldNow` reads what stands NOW (the folder verdict on a
            // clock — a short takeover TTL before the seed, the flush cadence after — plus a
            // serialize and an indexed read only while a foreign document is actually present)
            // and never throws: a faulted read answers the previous cycle, or a provably armed
            // hold before the first success. The attach-time preflight above remains for the
            // durable marker the confirm surface needs and for the write-behind's own hold.
            /* And only an organizer asks it. The flag governs whether the consent gate adopts placement
             * instead of screening, a decision only an organizer makes — a reader files nothing, so the
             * answer cannot change what its cycle does. Asking anyway was not free once the role gate
             * stopped readers from seeding: `importHoldNow`'s TTL is the flush interval for a
             * SEEDED install and `min(EVAL_TAKEOVER_TTL_MS, flushInterval)` for an unseeded one, so an
             * attached reader — which never seeds — would fetch the whole profile source out of
             * `ohmail/_meta` every 30 s for the life of the attachment instead of settling into the
             * five-minute cadence. A reader that polls a mailbox it does not organize is the model; a
             * reader that FETCHES a document it may not act on is not. */
              importHold,
            });
          } catch (err) {
            // Held for the split below — a fence is not a fault.
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
            // A write the lease did not admit at the command: the same NO, asked one step later.
            && !(cycleError instanceof WriteDeclinedError)
            // ── AND A SHARED-DATABASE FAULT IS NOT SOMETHING TO DRAIN THROUGH EITHER ─────────
            //
            // The arm below reads this class and sets `stopPass` — the whole point being to take
            // NO new mailbox while Postgres is down. A drain reached on that path cannot succeed:
            // every record it handles opens a transaction that fails and is swallowed, so the only
            // effects are one IMAP FETCH of `_meta` per mailbox and a burst of error logs, on
            // exactly the path that exists to stop doing work. It costs the shard a round trip per
            // mailbox to learn what the first mailbox already knew.
            && !isSharedDatabaseFault(cycleError);
          /* THIS CYCLE TOOK MAIL IN AND EMPTIED THE INBOUND BACKLOG: nothing the server stamped before
             its claim waits unorganized, so a hand-back's window may start there (mail 0169). */
          if (organize && cycleMayStillWrite && cycleError === null && syncOutcome !== null
            && !syncOutcome.hasBacklog && census.observed > 0 && rt.claimServerAt) {
            try {
              await markOrganizedThrough(scope.forAccount(rt.accountId).db, rt.mailboxId, rt.claimServerAt);
            } catch (err) {
              scope.log.warn("organized_through_write_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "where a hand-back's gap window starts could not be recorded; the last value "
                  + "stands, and a window opens no later than it did",
              });
            }
          }

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
                scope.forAccount(rt.accountId).db, { mailboxId: rt.mailboxId, accountId: rt.accountId, installId: scope.organizerInstallId, adapter: rt.adapter, requestKey: rt.requestKey },
                { installId: scope.organizerInstallId, kind: "cloud" }, new Date(),
                (event, detail) => scope.log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
            } catch (err) {
              scope.log.error("outstanding_requests_drive_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this cycle reads mail regardless; the next cycle tries again",
              });
            }
          } else {
            try {
              await applyMetaRequests(
                scope.forAccount(rt.accountId).db, { mailboxId: rt.mailboxId, accountId: rt.accountId, installId: scope.organizerInstallId, adapter: rt.adapter, requestKey: rt.requestKey }, new Date(),
                (event, detail) => scope.log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
              // THE ROLE FLIP'S OWN DEBT. Rows this install queued while it was a READER are
              // stranded the moment it becomes the organizer: nothing appends them any more, and
              // no ack will ever arrive because the organizer they are waiting for is this
              // process. Settled here, where the flip has demonstrably happened.
              await settleOwnOutstandingRequests(
                scope.forAccount(rt.accountId).db, { mailboxId: rt.mailboxId, accountId: rt.accountId }, new Date(),
                (event, detail) => scope.log.info(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail }),
              );
            } catch (err) {
              scope.log.error("organizer_requests_drain_failed", {
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
          scope.clearDatabaseFault();
          // …and the sync-block bucket, for the same reason the failure counter is cleared: this
          // mailbox is demonstrably being served, so `reconcileSyncBlocks` must CLEAR
          // `sync_blocked_reason` on the next pass instead of re-writing a `lease_unreadable` that
          // stopped being true. Without this the row would keep saying "nothing is organizing this
          // mailbox" about a mailbox that just completed a cycle — a row's claim is a contract,
          // broken here in the other direction.
          scope.leaseBlocked.delete(rt.mailboxId);
          // …and the read-ceiling bucket, on exactly the same evidence: a completed cycle read
          // this mailbox inside every bound, so the soft block stops being true and the clear
          // above falls out for it too. This is the whole of "it clears on the next healthy
          // cycle" — there is no clearing statement anywhere else.
          scope.readLimited.delete(rt.mailboxId);
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
            await scope.markRecovered(rt);
          }
          // …and the backoff's attempt count, for the reason spelled out where it used to live at
          // the end of `attach()`. A mailbox that completed a cycle is not in a failure backoff;
          // one that merely connected is not yet evidence of anything.
          scope.quarantine.delete(rt.mailboxId);
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
                () => stampMailboxSyncNow(scope.forAccount(rt.accountId).db, [rt.mailboxId], Date.now() - visitStartedMs));
            } catch (err) {
              // Swallowed for the MAILBOX, announced for the SHARD — see
              // `noteIfSharedDatabaseFault`. Nothing below changes.
              scope.noteIfSharedDatabaseFault(err, rt);
              scope.log.error("mailbox_sync_stamp_failed", {
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
                () => stampInitialImportComplete(scope.forAccount(rt.accountId).db, rt.mailboxId, new Date()));
            } catch (err) {
              scope.noteIfSharedDatabaseFault(err, rt);
              scope.log.error("mailbox_import_complete_stamp_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this mailbox's first import drained but initial_import_completed_at could " +
                  "not be written — the next no-backlog cycle re-attempts it, and the mailbox keeps " +
                  "serving either way",
              });
            }
          } else {
            // A cycle with a backlog: the first import still owes mail, so its clock moves. Search
            // reads it past the first day (`stampImportProgress`). Best-effort, like the stamp above.
            try {
              await asDatabaseFault("cycle.stampImportProgress",
                () => stampImportProgress(scope.forAccount(rt.accountId).db, rt.mailboxId, new Date()));
            } catch (err) {
              scope.noteIfSharedDatabaseFault(err, rt);
              scope.log.error("mailbox_import_progress_stamp_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err,
                reason: "this mailbox's first import still owes mail but sync_progress_at could not " +
                  "be written — the next cycle with a backlog re-attempts it, and the mailbox keeps " +
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
              db: scope.forAccount(rt.accountId).db as unknown as Tx, adapter: rt.adapter,
              accountId: rt.accountId, mailboxId: rt.mailboxId, log: scope.log,
            });
            if (repaired.ran) {
              scope.log.info("sensitive_fp_backfill_pass", {
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
            scope.log.error("sensitive_fp_backfill_failed", {
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
            scope.log.warn("watch_rearm_failed", {
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
            scope.log.error("sync_cycle_fenced", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              reason: "a mail-bearing write was refused because worker_heartbeats no longer " +
                "names this instance as the shard leader — quiescing instead of counting a " +
                "failure against the mailbox",
            });
            scope.handleLockLoss(new LockLostError("a mail-bearing write was fenced out mid-cycle", "LOCK_FENCED"));
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
            scope.noteDatabaseFault(err, { mailboxId: rt.mailboxId, accountId: rt.accountId });
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
            scope.noteBlock(scope.leaseBlocked, rt.mailboxId, leaseBlockReason(err));
            /* The gate refused before the request channel, so a folder too full to read is swept
               here, keyless; every other refusal runs nothing (`shrinkMetaOnRefusal`). */
            await shrinkMetaOnRefusal(err, {
              mailboxId: rt.mailboxId, accountId: rt.accountId, installId: scope.organizerInstallId, adapter: rt.adapter,
            }, new Date(), (event, detail) => { scope.log.info(event, detail); });
            rt.leaseUnavailableSince ??= Date.now();
            const unavailableMs = Date.now() - rt.leaseUnavailableSince;
            const due = unavailableMs >= scope.leaseUnavailableDetachMs;
            scope.log.warn("sync_cycle_lease_unavailable", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              // WHICH operation threw, from the error and not from this call site — the attach arm
              // has carried it since mail migration 0029 and the cycle arm, the one that fired over a
              // hundred times in
              // production, did not. `LeaseOp` is a compile-time literal from a closed union, so it
              // carries no privacy cost, and without it "the lease could not be read" is one
              // sentence for four different faults.
              op: err.op,
              threshold: scope.leaseUnavailableDetachMs,
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
          if (refusalIsRemoval(err)) {
            scope.log.info("sync_cycle_mailbox_removed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "this mailbox was removed while the cycle was reading it, so the pending "
                + "writes were refused rather than committed into a mailbox that is gone — NOT "
                + "counted toward maxSyncFailures and not quarantined",
            });
            return;
          }
          /* A DECLINED WRITE IS NOT A FAILING MAILBOX. The lease was asked at the command and did not
             admit it — the claim had aged past its window, or a stand-down was seen — so nothing of it
             was written and the cycle's own verdict line says where. The next cycle's gate re-reads
             the lease and renews or stands down; counting this would walk a healthy mailbox toward
             quarantine over our own handover. */
          if (err instanceof WriteDeclinedError) {
            scope.log.info("sync_cycle_write_declined", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, verdict: err.reason,
              reason: "a mail-server write was declined by the lease at the command — NOT counted "
                + "toward maxSyncFailures; the next cycle's gate decides",
            });
            return;
          }
          /* A STAND-DOWN IS NOT A FAILING MAILBOX EITHER. The permit this cycle rode saw another
             install take the mailbox and stopped the cycle at the page `stood_down_mid_cycle`
             names. Counted, a handover walked a healthy mailbox toward quarantine; the next
             cycle's gate demotes it and it goes on as a reader. */
          if (err instanceof OrganizerStandDownError) {
            scope.log.info("sync_cycle_stood_down", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, verdict: err.reason,
              reason: "another install took this mailbox during the cycle — NOT counted toward "
                + "maxSyncFailures; the next cycle's gate reads the lease and demotes",
            });
            return;
          }
          if (err instanceof ClassifierFaultError) {
            scope.log.warn("sync_cycle_classifier_fault", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, err,
              circuit: scope.classifierCircuit?.state(),
              reason: "model fault — NOT counted toward maxSyncFailures; the circuit degrades " +
                "this mailbox to rules-only routing and mail keeps flowing",
            });
            return;
          }
          /* A BREACH WHOSE MESSAGE WAS SET ASIDE IS PROGRESS: the row committed, the connection is
             retired and the next roster pass re-attaches. NOT counted toward maxSyncFailures. */
          /* A retired adapter rethrows the breach that retired it, so a later cycle over it meets the
             SAME object: already judged, and not a second failure. */
          const judged = typeof err === "object" && err !== null && scope.setAsideBreaches.has(err);
          const setAside = judged || breachSetAside(err, rt.deps.deadLetters);
          if (setAside && typeof err === "object" && err !== null) scope.setAsideBreaches.add(err);
          if (setAside) {
            scope.log.info("sync_cycle_set_aside", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              reason: "the server sent more of one message than it declared, or more for a batch than " +
                "it declared; that message is set aside, or the mail read before the batch overrun " +
                "was kept, and the connection retired — NOT counted toward maxSyncFailures and NOT " +
                "quarantined",
            });
          } else {
            rt.failures++;
            scope.log.error("sync_cycle_failed", {
              mailboxId: rt.mailboxId, accountId: rt.accountId,
              consecutiveFailures: rt.failures, maxSyncFailures: scope.maxSyncFailures, err,
              ...(isImapBoundExceeded(err) ? { ceiling: err.bound, ceilingLimit: err.limit } : {}),
            });
          }
          /* A first import that ended on one of OUR ceilings still read the mailbox: stamp the
             progress the `sync_lag` rule reads while no cycle has completed. Measured on a 25k
             fixture: the first cycle ran six minutes and ended here, one failure the quarantine
             arm below never sees. The catch must not rethrow, as the first-success stamp's. */
          if (rt.lastSuccessAt === null && isImapBoundExceeded(err)) {
            try {
              await asDatabaseFault("cycle.stampSyncProgress",
                () => stampSyncProgress(scope.forAccount(rt.accountId).db, rt.mailboxId, { fence: scope.fence }));
            } catch (stampErr) {
              scope.noteIfSharedDatabaseFault(stampErr, rt);
              scope.log.warn("mailbox_progress_stamp_failed", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, err: stampErr,
                reason: "a first import ended on a read ceiling and its progress could not be " +
                  "written; the lag alert measures from the last stamp it has",
              });
            }
          }
          if (!setAside && rt.failures >= scope.maxSyncFailures) toQuarantine.push({ rt, err });
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
        if (scope.stopped) break;
        // Serve the roster pass this cycle is sitting on. Lanes may be running while this pass works,
        // so "nothing is suspended inside an adapter" is no longer what makes it safe — `laneBusy` is:
        // the pass detaches nothing a lane is holding and defers it to `deferredLeaves`. NOT while
        // `stopPass` is set: the pass is winding down because the shared database is gone, and a roster
        // pass is a database read — attempting it once per draining lane would add `roster_pass_failed`
        // lines to the moment an operator least wants noise, and could not succeed. It stays owed and
        // runs after this cycle, where the queued entry `requestRoster` made would have run it.
        await detachClosedBetweenTurns();
        if (!stopPass) await scope.yieldToRoster();
        if (scope.stopped) break;
        // …and whatever that pass just adopted that has never synced goes to the front of what
        // is left of this pass, not to the back of the next one.
        admitNewFirstSyncers();
        // …and whoever rang the doorbell since their turn gets another one.
        admitWoken();
        // …and whoever rang it BEFORE their turn stops waiting at a position planned before the
        // wake existed — the mid-pass half of the wake ordering (see `reorderPending`).
        reorderPending();
        // …and a mailbox that came due its poll again while a long lane holds the pass takes a free
        // lane rather than waiting for that lane (see `admitDue`). After the reorder, at the front.
        admitDue();

        // Fill every free lane with the first ADMISSIBLE runtime, not merely the first one: a
        // mailbox held back by a busy account or by the heavy cap must not block the mailboxes
        // behind it, which would be head-of-line blocking reintroduced by the fix for it.
        while (!stopPass && !scope.stopped && inFlight.size < scope.cycleLanes) {
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
          if (scope.runtimes.get(rt.mailboxId) !== rt) continue;
          // THE WAKE IS SPENT ON ADMISSION, not on completion — see `MailboxRuntime.wokenAt`. A
          // signal that arrives during this very visit is about mail that landed after
          // `changesSince` answered, and must survive into the next pass. Whether this WAS a
          // woken admission is captured first — the visit stamps `last_sync_at` eagerly for
          // exactly the woken ones (see `visitMailbox`).
          const wokenVisit = rt.wokenAt !== null;
          // How long the doorbell waited for its turn — read before the wake is spent.
          if (rt.wokenAt !== null) {
            scope.log.info("wake_admitted", {
              mailboxId: rt.mailboxId, accountId: rt.accountId, wakeLatencyMs: Date.now() - rt.wokenAt,
            });
          }
          rt.wokenAt = null;
          const heavy = rt.owesBacklog;
          const long = rt.longTurns;
          busyAccounts.add(rt.accountId);
          scope.laneBusy.add(rt.mailboxId);
          const overCap = overCapAdmitted.delete(rt.mailboxId);
          if (overCap) overCapLanes.add(rt.mailboxId);
          const dueTurn = dueAdmitted.delete(rt.mailboxId);
          if (dueTurn) { dueLanes.add(rt.mailboxId); dueRevisits++; }
          if (heavy) heavyInFlight++;
          if (long) longInFlight++;
          // The bookkeeping is in a `finally` INSIDE the async body, so it has already run by the
          // time this promise settles — which is what lets the `Promise.race` below trust the
          // maps it re-reads on the next turn.
          const lane = (async () => {
            const visitStarted = Date.now();
            scope.visitStarts.set(rt.mailboxId, visitStarted);
            const successBefore = rt.lastSuccessAt;
            try {
              await visitMailbox(rt, wokenVisit);
            } finally {
              scope.visitStarts.delete(rt.mailboxId);
              scope.lastTurnEndAt = Date.now();
              const visitMs = Date.now() - visitStarted;
              const asked = rt.turnMessages;
              // Every turn's wall clock, so the lane that holds a pass open has a name: the
              // 2026-10-09 burst waited on a 271 s pass and no line said whose turn it was.
              scope.log.info("mailbox_visit", {
                mailboxId: rt.mailboxId, accountId: rt.accountId, visitMs,
                woken: wokenVisit, overCap, heavy, due: dueTurn, messages: asked,
              });
              // Only a completed turn measures what its limit costs.
              if (rt.lastSuccessAt !== successBefore) {
                rt.turnMessages = nextTurnMessages(asked, visitMs, turnTargetMs(rt), rt.owesBacklog);
                // One length for every mailbox: half the shorter target beside a sibling is a burst's turn.
                rt.longTurns = rt.owesBacklog && visitMs * 2 >= scope.heavyTurnMs;
              }
              rt.lastVisitEndedAt = Date.now();
              inFlight.delete(rt.mailboxId);
              busyAccounts.delete(rt.accountId);
              scope.laneBusy.delete(rt.mailboxId);
              overCapLanes.delete(rt.mailboxId);
              dueLanes.delete(rt.mailboxId);
              if (heavy) heavyInFlight--;
              if (long) longInFlight--;
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
        // …or when a mailbox comes due its poll while a long lane holds the pass (see `admitDue`):
        // nothing else would wake this loop before that lane returns.
        const dueAt = nextDueAt();
        let dueTimer: ReturnType<typeof setTimeout> | undefined;
        const dueSignal = dueAt === null ? null
          : new Promise<void>((r) => { dueTimer = setTimeout(r, Math.max(0, dueAt - Date.now())); });
        try {
          await Promise.race([...inFlight.values(), scope.wakeSignal, ...(dueSignal ? [dueSignal] : [])]);
        } finally {
          if (dueTimer !== undefined) clearTimeout(dueTimer);
        }
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
      if (scope.stopped) return;

      // ── AND THE MAILBOXES A ROSTER PASS COULD NOT TAKE WHILE A LANE HELD THEM ──────────────
      //
      // FIRST among the post-loop detaches, because leaving the duty is a strictly better answer
      // than any of the three below it: a mailbox that is no longer ours must not also be
      // quarantined for a failure it collected on the way out. `release` is the entitlement-lapse
      // release the roster pass would have done inline — see its site for why that is the ONE
      // teardown path that releases the organizer claim.
      for (const { rt, release, reason } of scope.deferredLeaves.splice(0)) {
        if (scope.runtimes.get(rt.mailboxId) !== rt) continue;
        if (release) await scope.releaseOrganizerClaim(rt, "this mailbox is no longer an enabled mailbox of this shard");
        await scope.detach(rt, reason);
      }

      // Persist what the loop above only knew in memory. Best-effort and deliberately BEFORE
      // the quarantine pass: a mailbox that synced this cycle earned its stamp regardless of
      // what happens to a different one below.
      try {
        await asDatabaseFault("cycle.stampMailboxSync",
          // ONE statement over the mailboxes of every account this cycle synced: on the roster's view.
          () => stampMailboxSyncNow(scope.roster, synced, Date.now() - passStartedMs));
      } catch (err) {
        scope.noteIfSharedDatabaseFault(err);
        scope.log.error("mailbox_sync_stamp_failed", {
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
        if (scope.runtimes.get(rt.mailboxId) !== rt) continue;
        await scope.detach(rt, "this mailbox's organizer lease could not be read for long enough to stop trying");
        // `reason: null` — the sync-block reason for this population is written by the
        // unreadable-lease arm itself (`lease_unreadable`), which is a better answer than
        // anything this line could add. See `SyncBlock`.
        scope.noteBlock(scope.leaseBlocked, rt.mailboxId, null);
      }

      // A mailbox that keeps failing at RUNTIME is detached and quarantined exactly like one
      // that failed to attach — otherwise a dead IDLE connection is retried forever and
      // `mailboxes` in /health keeps counting it as if it were serving.
      for (const { rt, err } of toQuarantine) {
        if (scope.runtimes.get(rt.mailboxId) !== rt) continue;
        await scope.detach(rt, `${rt.failures} consecutive sync failures`);
        await scope.quarantineMailbox(rt.mailboxId, rt.accountId, err, "sync");
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
        if (scope.runtimes.get(rt.mailboxId) !== rt) continue;
        await scope.detach(
          rt,
          `the organizer lease was unreadable for ${unavailableMs}ms (bound ${scope.leaseUnavailableDetachMs}ms) — ` +
          "the connection cannot serve this mailbox, so the next roster pass re-attaches it on a fresh one",
        );
      }

      // THE ROTATION ENDS HERE. Freshness and the pulse are stamped now, before the per-account
      // passes; FRESHNESS HONESTY is unchanged: advance only when work succeeded or there was
      // nothing to sync, so a dead leader never looks fresh.
      const rotationMs = Date.now() - passStartedMs;
      scope.lastRotationMs = rotationMs;
      scope.lastRotationEndAt = Date.now();
      scope.lastDueRevisits = dueRevisits;
      if (succeeded > 0 || scope.expected === 0) scope.lastCycleAt = new Date();
      await scope.beat();
      // …and the per-account passes run next, as their own queue entry behind this one.
      scope.kickTail();

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
      if (backlogged.length > 0 && !scope.stopped) {
        scope.log.info("backfill_progress", {
          mailboxes: backlogged.length, sample: backlogged.slice(0, 3),
          reason: "adapter reported a truncated batch — re-kicking rather than waiting for the poll interval",
        });
        scope.kickCycle();
      } else {
        // …and only once the MESSAGE backlog is drained does the THREAD backlog get a slice.
        // A mailbox still streaming its first sync has better uses for the queue, and the mail
        // arriving during it is threaded at ingest anyway — so waiting costs nothing but the
        // slices themselves, which are one-shot.
        scope.kickThreadBackfill();
      }
    }
    scope.cycle = cycle;
}
