import { isImapBoundExceeded, type MailboxAdapter, ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import { breachSetAside } from "@ohmail/organizer/dead-letter";
import {
  type MailboxErrorPhase, classifyMailboxError, isProviderRefusal, markMailboxReadLimited,
  markMailboxProviderUnavailable, markMailboxFailed, mailboxErrorDetail, markMailboxConnected,
} from "../mailboxes.js";
import type { MailboxRuntime } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: a failing mailbox set aside and taken back, and what a dropped connection means. */
export function quarantineSection(scope: WorkerScope): void {
    async function quarantineMailbox(
      mailboxId: string, accountId: string, reason: unknown, phase: MailboxErrorPhase, kickAsRead?: string | null,
    ): Promise<void> {
      const prev = scope.quarantine.get(mailboxId);
      const attempts = (prev?.attempts ?? 0) + 1;
      const code = classifyMailboxError(reason, phase);
      const bounded = isImapBoundExceeded(reason);
      const soft = bounded ? "read_limited" as const
        : isProviderRefusal(reason) ? "provider_unavailable" as const : null;
      // A server's hint can lengthen its wait. Throttled connections and read limits keep
      // their shorter ladder. Outages without a hint can back off to the full cap.
      const raw = (reason as { throttleReset?: unknown } | null | undefined)?.throttleReset;
      const hint = Number.isFinite(raw) ? (raw as number) : 0;
      const limit = bounded || hint > 0
        ? Math.min(scope.retryBaseMs * 16, scope.retryMaxMs) : scope.retryMaxMs;
      const wait = Math.min(Math.max(scope.backoffFor(attempts), hint), limit);
      const retryAt = Date.now() + wait;
      scope.quarantine.set(mailboxId, {
        attempts, retryAt,
        reason: reason instanceof Error ? reason.message : String(reason),
        persisted: false,
      });
      try {
        // Mail migration 0039: the same statement now also records WHEN. That is what makes this backoff
        // survive a restart and — the point of the column — releasable by an operator, because
        // until now the only exits from quarantine were the ladder expiring and a redeploy.
        const opts = { fence: scope.fence, retryAfter: new Date(retryAt), kickAsRead };
        const written = soft === "read_limited"
          ? await markMailboxReadLimited(scope.forAccount(accountId).db, mailboxId, opts)
          : soft === "provider_unavailable"
          ? await markMailboxProviderUnavailable(scope.forAccount(accountId).db, mailboxId, opts)
          : await markMailboxFailed(
            scope.forAccount(accountId).db, mailboxId, { code, detail: mailboxErrorDetail(reason) },
            opts,
          );
        // Only a write that LANDED lets the column govern this mailbox. Re-read from the map
        // rather than closed over: the entry could have been dropped by a roster pass while this
        // write was in flight, and resurrecting it here would re-quarantine a mailbox that has
        // left the duty.
        if (written) {
          const held = scope.quarantine.get(mailboxId);
          if (held) held.persisted = true;
        }
        if (written && soft) scope.noteBlock(scope.readLimited, mailboxId, soft);
        if (!written) {
          scope.quarantine.delete(mailboxId);
          // A newer sign-in, a disconnect or a leader change supersedes this attempt.
          scope.log.info("mailbox_failure_write_fenced", {
            mailboxId, accountId, errorCode: code,
            reason: "the mailbox changed or this instance no longer leads the shard",
          });
        }
      } catch (err) {
        scope.log.error("mailbox_failure_write_failed", {
          mailboxId, accountId, errorCode: code, err,
          reason: "the mailbox is quarantined in memory but its row could not record why",
        });
      }
      // `errorCode` is the code that was WRITTEN, so a bounded refusal reports none: the row
      // carries `sync_blocked_reason` instead, and naming `sync` here would send a reader looking
      // for an `error_code` the row does not hold. The event and its level are unchanged — the
      // backoff is real either way, and four suites read this line's `attempts`/`retryInMs`.
      scope.log.error("mailbox_quarantined", {
        mailboxId, accountId, attempts, retryInMs: wait, err: reason,
        ...(soft ? { syncBlockedReason: soft } : { errorCode: code }),
        ...(bounded ? { ceiling: reason.bound, ceilingLimit: reason.limit } : {}),
      });
    }

    /**
     * Persist a VERIFIED recovery, and never let its failure tear down a working mailbox.
     *
     * A successful sync clears any failure. During attach, passing the kick stamp clears an
     * authentication failure once the login succeeds. A later sync can still report its own failure.
     * If the database write fails, a serving mailbox's roster pass retries it.
     */
    async function markRecovered(
      mb: { mailboxId: string; accountId: string }, authKickAsRead?: string | null,
    ): Promise<void> {
      try {
        const written = await markMailboxConnected(
          scope.forAccount(mb.accountId).db, mb.mailboxId, { fence: scope.fence, authKickAsRead },
        );
        if (!written) {
          // The disconnect case is the one that matters here: a recovery that began from an
          // `error` snapshot must not resurrect a mailbox the user has since disconnected, and
          // must not overwrite a replacement leader's view of it. `reconcileRoster` detaches
          // the runtime on its next pass.
          scope.log.info("mailbox_recovery_write_fenced", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox is disabled or this instance no longer leads the shard",
          });
          return;
        }
        if (authKickAsRead !== undefined) scope.quarantine.delete(mb.mailboxId);
        scope.log.info("mailbox_recovered", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, status: "connected",
        });
      } catch (err) {
        scope.log.error("mailbox_status_write_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "mailbox recovered but its status row could not be updated — the next roster " +
            "pass retries this while the mailbox stays attached and serving",
        });
      }
    }

    /**
     * One mailbox's connection died asynchronously — contain it to that mailbox. This is the callback
     * every adapter is handed. `ImapFlow` reports a socket that FAILED by EMITTING `error`; with no
     * listener Node raises an uncaught exception and `entry.ts` exits the process, so one customer's
     * hiccup took down the shard and restarted the container every ~26 s. It now also hears a socket
     * that merely ENDED: imapflow calls `close()` on `_socketClose`/a failed IDLE recovery, which
     * emits `close`, never `error` — nothing listened, so a total outage had zero connection events.
     * The two shapes are separated BY CLASS (never a driver string): ERRORED → detach AND quarantine;
     * merely ENDED → DETACH ONLY (no `error`, no backoff), so the next roster pass re-dials in 30 s rather than waiting out `retryBaseMs`. ON THE QUEUE, so a detach never closes an adapter a cycle is using. An error on a connection whose attach is still running goes to that attach (`AttachPool.noteLost`), never to the rotation.
     */
    /* THE CYCLE'S OWN VERDICT on a breach it ended on, keyed on the error object: the connection
       handler runs later on the queue, and by then another cycle's `beginCycle` may have cleared
       the ledger's record of what the breaching cycle wrote. */
    const recoverableReadBreaches = new WeakSet<object>();

    /**
     * CLOSED CONNECTIONS A RUNNING PASS DETACHES BETWEEN TWO TURNS. The queue entry below waits for
     * the whole cycle, and a pass held open by one slow lane kept eight dead connections attached for
     * 6.7 min on 2026-10-09 (their wakes failing `NoConnection`). `detachClosedBetweenTurns` serves
     * them at the dispatcher's top, where the roster yield already detaches; the queued entry then
     * finds a different runtime (or none) and does nothing — never the re-attached one.
     */
    const closedOwed = new Map<string, MailboxRuntime>();
    const CLOSED_DETACH_REASON = "the provider connection closed — the next roster pass re-attaches it on a fresh one";

    function handleConnectionError(
      mailboxId: string, accountId: string, err: unknown, raisedOn: MailboxAdapter | null = null,
    ): void {
      if (scope.stopped) return;
      const ended = err instanceof ImapConnectionClosedError;
      const current = scope.runtimes.get(mailboxId);
      // ROUTED BY ADAPTER. Attaches run beside the queue now, so an error can come from a connection
      // whose attach has not finished (it is not in `runtimes` yet): that attach is told, and throws at
      // its next checkpoint. One from a connection no longer in the rotation is about nothing current.
      if (raisedOn !== null && current?.adapter !== raisedOn) {
        scope.attachPool.noteLost(mailboxId, raisedOn, err);
        scope.log.error("mailbox_connection_error", {
          mailboxId, accountId, err,
          reason: "a connection that is not in the rotation failed; an attach still using it gives up " +
            "at its next step, and nothing in the rotation is touched",
        });
        return;
      }
      const atError = current;
      if (ended && atError) { closedOwed.set(mailboxId, atError); scope.nudgeCycle(); }
      scope.log.error("mailbox_connection_error", {
        mailboxId, accountId, err,
        reason: ended
          ? "the provider connection ENDED (imapflow emitted `close`, which nothing listened for " +
            "until the dead-connection fix); detaching THIS mailbox so the next roster pass re-dials it — NOT " +
            "quarantined, because a socket that closed is not a broken mailbox"
          : "the provider connection emitted an error; detaching THIS mailbox and quarantining it " +
            "unless a read bound retired it after setting a message aside — before this listener " +
            "existed the same event exited the process",
      });
      void scope.serialize(async () => {
        const rt = scope.runtimes.get(mailboxId);
        // Already gone: the attach path's own catch owns it, a roster pass detached it, or a
        // second `error` followed the first. Nothing to do, and nothing to double-count.
        if (!rt || scope.stopped) return;
        // The error belongs to the runtime it was raised on: any detach since (between two turns,
        // a roster pass, the reconnect list) and re-attach made a NEW one, which this must not close.
        if (atError && rt !== atError) return;
        if (ended) {
          if (closedOwed.get(mailboxId) === rt) closedOwed.delete(mailboxId);
          await scope.detach(rt, CLOSED_DETACH_REASON);
          return;
        }
        /* After the cycle on this queue: a breach whose message the cycle set aside is progress,
           so the mailbox is re-attached by the next roster pass and not quarantined. */
        const progress = (typeof err === "object" && err !== null && recoverableReadBreaches.has(err))
          || breachSetAside(err, rt.deps.deadLetters);
        if (progress) {
          await scope.detach(rt, "the cycle checkpointed before the connection retired; the next roster pass re-attaches it");
          return;
        }
        await scope.detach(rt, "the provider connection emitted an error");
        await quarantineMailbox(mailboxId, accountId, err, "sync");
      }).catch((e: unknown) => {
        scope.log.error("connection_error_handling_failed", { mailboxId, accountId, err: e });
      });
    }
    scope.quarantineMailbox = quarantineMailbox;
    scope.markRecovered = markRecovered;
    scope.recoverableReadBreaches = recoverableReadBreaches;
    scope.closedOwed = closedOwed;
    scope.CLOSED_DETACH_REASON = CLOSED_DETACH_REASON;
    scope.handleConnectionError = handleConnectionError;
}
