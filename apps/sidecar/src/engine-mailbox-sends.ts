import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  runAwayResponderPass, runScheduledSendPass, runSendReconcilePass, sendService,
} from "@trafficflow/services/mail";
import { runsPass } from "./composition-passes.js";
import { leaseStoodDown, type OrganizerWriteAuthority } from "@ohmail/organizer/lease";
import type { LocalRosterRow } from "./identity.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's sends: the scheduled letters, the away answers, the stranded and
 * the owed Sent copies.
 */
export function sendsSection(scope: EngineScope, box: MailboxScope, mb: LocalRosterRow): void {
      /** Has this runtime already said it composes no scheduled-send pass? See `sendScheduled`. */
      let noAppointmentsLogged = false;

      /**
       * Keep the send-later appointments this install made (mail 0077) — the standalone door's copy of the
       * clock the hosted deployment runs every minute. The same ONE implementation (`runScheduledSendPass` in
       * `@trafficflow/services`): the claim, the recovery arm and the outcome table must agree with what the
       * schedule verbs promised, or two hosts would disagree about one row. Only the transport differs —
       * `openLocalSend`, the exact adapter a manual send from this door dials — and the storage cap is this
       * tier's typed UNMETERED. On the drain cadence rather than a timer, the honest reading of "sends at
       * 9:00" on a door that exists only while the app is open: an appointment due while the app is closed
       * sends on the next launch's first drain. Failures are contained.
       */
      /**
       * @param gen  the connection generation the caller gated under, and @param conn the adapter
       *   instance it belongs to. Threaded in rather than read from the closure because this pass
       *   OUTLIVES a cycle: it is the caller's identity that decides whether a delivery is still
       *   this install's to make, and the closure's binding is exactly the thing that moves.
       */
      const sendScheduled = async (gen: number, conn: MailboxAdapter): Promise<void> => {
        /* ── AND NOT ON A COMPOSITION THAT KEEPS NO APPOINTMENTS ──────────────────────────────
         *
         * `composition-passes.ts` decides; a phone is the composition it excludes. The refusal is
         * HERE rather than at the drain's call site because `reader-drain.test.ts` reads that line
         * literally (`if (organizing) await sendScheduled(...)`) to prove the pass stays
         * organizer-only, and a second conjunct there would retire that guard silently.
         *
         * Once per runtime, not once per drain: a line on every poll would bury the one that says
         * something happened. `runScheduledSendPass` is never entered, so nothing is claimed. */
        if (!runsPass(scope.organizerKind, "scheduled-send")) {
          if (!noAppointmentsLogged) {
            noAppointmentsLogged = true;
            scope.log("scheduled_send_pass_not_composed", {
              kind: scope.organizerKind,
              reason: "this install keeps no send-later appointments, so no due appointment was "
                + "claimed or sent on this drain and none will be; the schedule verb refuses to "
                + "make one here, and mail keeps arriving",
            });
          }
          return;
        }
        try {
          const r = await runScheduledSendPass(scope.db as never, {
            /* ── THE PASS STOPS IF THIS MAILBOX STOPS BEING OURS WHILE IT RUNS ─────────────
             *
             * Checked BETWEEN ROWS rather than once before the pass, because the change this
             * defends against happens DURING it: the socket dies, a re-dial re-reads the lease
             * and finds a stranger's claim, and this loop is still holding appointments it
             * claimed under the old answer. One check at the top cannot see that; it has already
             * returned by the time it matters.
             *
             * `stopped` is in the predicate for the same reason — a removed mailbox must not go
             * on sending on its own behalf while `detach()` waits for the pass to end. */
            cancelled: () => box.stopped || gen !== box.generation || conn !== box.adapter,
            openSendAdapter: scope.openLocalSend,
            /* This mailbox's appointments only. The pass scans the whole store, which equalled
             * "this mailbox" when an install held one; with several, an unnarrowed scan would let
             * an organizing mailbox claim and SEND an appointment belonging to a mailbox this
             * install merely reads. The gate is per runtime, so each organizing mailbox keeps its
             * own and a reader's are left for whoever organizes it. */
            mailboxIds: [mb.id],
            resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
            keepOwedCopy: true,
            now: scope.now,
          });
          if (r.claimed > 0) {
            scope.log("scheduled_send_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              failed: r.failed, deferred: r.deferred,
            });
          }
        } catch (err) {
          scope.log("scheduled_send_pass_failed", {
            err,
            reason: "no due scheduled send was attempted this drain; the appointments stand and " +
              "the next drain claims them again, and mail continues to arrive either way",
          });
        }
      };

      /**
       * The away responder, on the door that only exists while the window is open (mail 0087). The same ONE
       * implementation the hosted API host runs (`runAwayResponderPass`): the reservation, the per-sender
       * throttle and the ledger must agree across every host, or two installs organizing one mailbox at
       * different moments would answer a correspondent twice. Only the transport differs (`openLocalSend`).
       * The promise is honest: replies go out while ohmail is open on this computer, and the settings pane
       * SAYS SO; overnight mail is answered on the next launch's first drain, bounded by the throttle.
       * Organizer only, twice over: the gate stops a reader spending a drain, the JOIN inside the pass makes
       * it impossible. `mailboxIds: [mb.id]` — each mailbox keeps its own.
       */
      /**
       * @param gen  the connection generation the caller gated under, @param conn the adapter
       *   instance it belongs to, and @param permit the organizer lease those two were gated on.
       *   All three threaded in rather than read from the closure because this pass OUTLIVES a
       *   cycle: it is the caller's own authority that decides whether a delivery is still this
       *   install's to make, and the closure's bindings are exactly the things that move.
       */
      const answerAway = async (
        gen: number, conn: MailboxAdapter, permit: OrganizerWriteAuthority,
      ): Promise<void> => {
        /** Set by the refusal below, read by `cancelled` so the pass ends where it stands. */
        let leaseLost = false;
        /* ── THE LEASE IS ASKED, BECAUSE THE CONNECTION ANSWERS SOMETHING ELSE ─────────────────
         * Choosing another organizer mid-pass leaves THIS socket open and healthy, so the
         * connection check admits every remaining reply and two installs answer one correspondent.
         * An away reply is irreversible mail sent in somebody's name, so the pass re-asks the
         * authority before its reservation and again at the dial — `check()` is the permit's own
         * bounded re-read — and a refusal both refuses this send and ends the pass.
         * An UNREADABLE lease is not a stand-down: a read that throws leaves the receipt untouched
         * (`lease.ts`), so the permit's `revoked` latch decides and an outage lets mail flow.
         */
        const refuse = (): void => {
          leaseLost = true;
          scope.log("away_responder_stood_down", {
            mailboxId: mb.id,
            reason: "another install holds this mailbox now, so this automatic reply was not sent "
              + "and the pass ends here; the install that holds it answers the same message from "
              + "its own pass, and mail continues to arrive either way",
          });
        };
        /* THE PASS'S OWN `stillOrganizing` — the permit's bounded re-read, and the only door the
           question has. The pass asks it before the reservation and at the dial, and only the pass
           can tell a refusal that dialled nothing from an SMTP throw: asked inside the transport,
           the refusal landed in the SMTP arm and kept a reservation this install never offered
           again. No permit at all is a refusal; an unreadable one is not (see above). */
        const stillOurs = async (): Promise<boolean> => {
          if (!("check" in permit)) {
            refuse();
            return false;
          }
          try {
            await permit.check();
            return true;
          } catch {
            if (!leaseStoodDown(permit)) return true;
            refuse();
            return false;
          }
        };
        try {
          const r = await runAwayResponderPass(scope.db as never, {
            /* ── THE PASS STOPS IF THIS MAILBOX STOPS BEING OURS WHILE IT RUNS ─────────────
             *
             * Checked BETWEEN ROWS rather than once before the pass, because the change this
             * defends against happens DURING it: the socket dies, a re-dial re-reads the lease
             * and finds a stranger's claim, and this loop is still holding appointments it
             * claimed under the old answer. One check at the top cannot see that; it has already
             * returned by the time it matters.
             *
             * `stopped` is in the predicate for the same reason — a removed mailbox must not go
             * on sending on its own behalf while `detach()` waits for the pass to end. */
            cancelled: () =>
              box.stopped || gen !== box.generation || conn !== box.adapter
              || leaseLost || leaseStoodDown(permit),
            openSendAdapter: scope.openLocalSend,
            stillOrganizing: stillOurs,
            mailboxIds: [mb.id],
            now: scope.now,
          });
          if (r.examined > 0) {
            scope.log("away_responder_pass", {
              accounts: r.accounts, examined: r.examined, sent: r.sent,
              unverified: r.unverified, throttled: r.throttled, suppressed: r.suppressed,
              deferredAccounts: r.deferredAccounts, deferredCandidates: r.deferredCandidates,
              capped: r.capped, refusedErased: r.refusedErased,
              refusedNotOrganizer: r.refusedNotOrganizer,
            });
          }
        } catch (err) {
          scope.log("away_responder_pass_failed", {
            err,
            reason: "no away reply was attempted this drain and no candidate was decided; the " +
              "next drain re-reads the same window, and mail continues to arrive either way",
          });
        }
      };

      /**
       * Settle a send this install started and never finished — the same implementation the
       * hosted host and self-host clock run. Deliberately NOT gated on organizing: it resolves
       * THIS install's own `pending` reservation (a Sent-folder read plus a compare-and-swap on a
       * row nobody else owns), so gating would strand someone demoted to reader between send and a
       * crash with a draft stuck "Sending…" (`send-reconcile-drain.test.ts`). No account filter —
       * a standalone store holds one account. The adapter is wrapped so `send` throws: a
       * structural proof this hook cannot deliver a second copy.
       */
      const reconcileStrandedSends = async (): Promise<void> => {
        try {
          const r = await runSendReconcilePass(scope.db as never, {
            openSendAdapter: scope.openLocalSend,
            /* NO account filter, and none is available: the pass is store-wide by design, exactly
               like the scheduled sender it settles for. That is correct on this door for a reason
               the hosted host does not have — a standalone store holds ONE account, so store-wide
               IS this install's own reservations. */
            now: scope.now,
            /* The last run's reservations, decided now rather than after the stale window: no
               attempt of theirs is alive (see `inheritedSends`). */
            ...(scope.inheritedSends.length > 0 ? { inherited: scope.inheritedSends } : {}),
          });
          if (r.claimed > 0) {
            scope.log("send_reconcile_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              deferred: r.deferred, resolvedElsewhere: r.resolvedElsewhere, gaveUp: r.gaveUp,
              forgotten: r.forgotten,
            });
          }
        } catch (err) {
          scope.log("send_reconcile_pass_failed", {
            err,
            reason: "no stranded reservation was resolved this drain; every row stays exactly as " +
              "it was and the next drain looks again — the pass never sends, so a failure here " +
              "cannot have delivered anything",
          });
        }
      };

      /** `SendService.owedCopiesRecorded` when this mailbox last read none owed; null before its first read. */
      let noneOwedAt: number | null = null;
      /**
       * File the Sent copies this mailbox still owes (`SendService.fileOwedCopies`): a delivered
       * send's copy that a quit, a crash or an outage left unfiled. Ungated like the reconciler: the
       * copy is of a letter THIS install delivered, and the pass only files, looking in Sent first.
       * The store is asked only while one may be owed: at this runtime's first drain, and once this
       * process records one after a read found none. An idle drain asks nothing here.
       */
      const fileOwedSentCopies = async (): Promise<void> => {
        const recorded = sendService.owedCopiesRecorded(mb.id);
        if (noneOwedAt === recorded) return;
        const ctx = { db: scope.db as never, accountId: scope.world.accountId, userId: null, now: scope.now, requestId: "owed-copies" };
        try {
          if (await sendService.owesSentCopies(ctx, mb.id)) {
            await sendService.fileOwedCopies(
              ctx, mb.id, { openSendAdapter: scope.openLocalSend, resolveStorageCap: async () => UNMETERED_STORAGE_CAP },
            );
            if (await sendService.owesSentCopies(ctx, mb.id)) return;
          }
          // Counted before the reads: a copy recorded since moved the count, and the next drain reads again.
          noneOwedAt = recorded;
        } catch (err) {
          scope.log("sent_copy_owed_pass_failed", {
            err,
            reason: "no owed Sent copy was filed this drain; each stays recorded and the next drain tries again",
          });
        }
      };
      box.sendScheduled = sendScheduled;
      box.answerAway = answerAway;
      box.reconcileStrandedSends = reconcileStrandedSends;
      box.fileOwedSentCopies = fileOwedSentCopies;
}
