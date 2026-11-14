import { isImapBoundExceeded, type MailboxAdapter, ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import { breachSetAside } from "../dead-letter.js";
import {
  type MailboxErrorPhase, classifyMailboxError, isProviderRefusal, markMailboxReadLimited,
  markMailboxProviderUnavailable, markMailboxFailed, mailboxErrorDetail, markMailboxConnected,
} from "../mailboxes.js";
import type { MailboxRuntime } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: a failing mailbox set aside and taken back, and what a dropped connection means. */
export function quarantineSection(scope: WorkerScope): void {
    async function quarantineMailbox(
      mailboxId: string, accountId: string, reason: unknown, phase: MailboxErrorPhase,
    ): Promise<void> {
      const prev = scope.quarantine.get(mailboxId);
      const attempts = (prev?.attempts ?? 0) + 1;
      // Prefer the server's own backoff hint, bounded by our ceiling. imapflow parses MS365's
      // throttle reply — "Suggested Backoff Time: 92415 milliseconds" — onto the error as
      // `err.throttleReset` (imapflow@1.5.0). It is MILLISECONDS, raw; reading it as seconds sleeps
      // for a day. This worker parsed it and threw it away, so a provider that told us exactly when to
      // come back was retried on our own ladder regardless — which earns the next throttle. `Math.max`
      // then `Math.min` is the contract: the hint may only LENGTHEN the wait (never shorter than the
      // ladder) and may never escape `retryMaxMs` (a hostile hint cannot park a mailbox for ever).
      // `Number.isFinite` rather than `typeof === "number"`: `Math.max(x, NaN)` is NaN, `retryAt`
      // becomes NaN, and every `Date.now() >= NaN` is false — the mailbox would never leave quarantine.
      const raw = (reason as { throttleReset?: unknown } | null | undefined)?.throttleReset;
      const hint = Number.isFinite(raw) ? (raw as number) : 0;
      const wait = Math.min(Math.max(scope.backoffFor(attempts), hint), scope.retryMaxMs);
      const retryAt = Date.now() + wait;
      scope.quarantine.set(mailboxId, {
        attempts, retryAt,
        reason: reason instanceof Error ? reason.message : String(reason),
        // Optimistic-false: the entry exists from this statement onwards, and the write below is
        // awaited. Until it returns true the in-memory instant governs, which is the pre-0039
        // behaviour and the correct fallback.
        persisted: false,
      });
      // The row now records WHY, not merely THAT. See `markMailboxFailed` for why the detail is
      // an allowlisted token and never the error's message. Still best-effort: a worker
      // deployed ahead of mail migration 0023 fails this write and logs it, rather than crashing on a
      // column that does not exist yet — a mailbox must never be un-quarantined by a
      // bookkeeping failure.
      const code = classifyMailboxError(reason, phase);
      /**
       * A ceiling we set is not a broken mailbox — the one arm that does not write `error`.
       * `ImapBoundExceeded` is raised by this codebase, never by the server: the mailbox
       * authenticated, answered, and sent more than one pass takes. `classifyMailboxError` reads
       * response codes, errnos and a flag, none of which a bound breach carries, so it answers `sync`
       * and the row used to say the mailbox failed. The backoff is UNCHANGED (the ladder runs, the
       * in-memory entry is written, `retry_after` persists it) — only the row's verdict moves. Keyed
       * on the CLASS, not a bound code, so a ceiling added later is covered without being enumerated.
       */
      const bounded = isImapBoundExceeded(reason);
      /* …and the second soft arm (mail 0130): the SERVER said "not now" — a throttle, or
         `UNAVAILABLE`/`LIMIT`. Same row shape as a ceiling of ours, a different reason, and the
         wait above already honours its hint. Asked only when the ceiling did not answer. */
      const soft = bounded ? "read_limited" as const
        : isProviderRefusal(reason) ? "provider_unavailable" as const : null;
      if (soft) scope.noteBlock(scope.readLimited, mailboxId, soft);
      try {
        // Mail migration 0039: the same statement now also records WHEN. That is what makes this backoff
        // survive a restart and — the point of the column — releasable by an operator, because
        // until now the only exits from quarantine were the ladder expiring and a redeploy.
        const softOpts = { fence: scope.fence, retryAfter: new Date(retryAt) };
        const written = soft === "read_limited"
          ? await markMailboxReadLimited(scope.db, mailboxId, softOpts)
          : soft === "provider_unavailable"
          ? await markMailboxProviderUnavailable(scope.db, mailboxId, softOpts)
          : await markMailboxFailed(
            scope.db, mailboxId, { code, detail: mailboxErrorDetail(reason) },
            { fence: scope.fence, retryAfter: new Date(retryAt) },
          );
        // Only a write that LANDED lets the column govern this mailbox. Re-read from the map
        // rather than closed over: the entry could have been dropped by a roster pass while this
        // write was in flight, and resurrecting it here would re-quarantine a mailbox that has
        // left the duty.
        if (written) {
          const held = scope.quarantine.get(mailboxId);
          if (held) held.persisted = true;
        }
        if (!written) {
          // FENCED, not failed. Either the user disconnected this mailbox while the attempt was
          // in flight, or another instance now leads this shard — in both cases the row we would
          // have written is a stale claim, and refusing it IS the correct outcome. Logged at
          // info because it is a normal handover, not an incident.
          scope.log.info("mailbox_failure_write_fenced", {
            mailboxId, accountId, errorCode: code,
            reason: "the mailbox is disabled or this instance no longer leads the shard",
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
     * Called from two places, which is the fix for a bug this file used to carry: the attach
     * path wrote it once and the comment claimed "the next roster pass writes it" if that
     * failed. It did not — `reconcileRoster` skips anything already in `runtimes`, so a mailbox
     * whose recovery write failed served correctly while its row said `error` FOREVER, which is
     * indistinguishable from the outage this slice is about. The roster pass now calls this too.
     */
    async function markRecovered(mb: { mailboxId: string; accountId: string }): Promise<void> {
      try {
        const written = await markMailboxConnected(scope.db, mb.mailboxId, { fence: scope.fence });
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
    const setAsideBreaches = new WeakSet<object>();

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
        const progress = (typeof err === "object" && err !== null && setAsideBreaches.has(err))
          || breachSetAside(err, rt.deps.deadLetters);
        if (progress) {
          await scope.detach(rt, "retired after a message was set aside — the next roster pass re-attaches it");
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
    scope.setAsideBreaches = setAsideBreaches;
    scope.closedOwed = closedOwed;
    scope.CLOSED_DETACH_REASON = CLOSED_DETACH_REASON;
    scope.handleConnectionError = handleConnectionError;
}
