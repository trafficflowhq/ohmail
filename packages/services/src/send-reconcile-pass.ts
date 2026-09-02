import { and, eq, lt } from "drizzle-orm";
import { drafts, mailboxes, outboundSends, type Tx } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type SendAdapter } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { SCHEDULED_SEND_BATCH, SCHEDULED_SEND_EXPIRY_MS } from "./schedule-send-pass.js";
import { sendService, SEND_STALE_AFTER_MS, type SendService } from "./send-service.js";

/**
 * THE RECONCILING PASS FOR STRANDED SEND RESERVATIONS — the piece that resolves an
 * `outbound_sends` row left `pending` by an attempt nobody is coming back for.
 *
 * ── WHAT IS STRANDED, AND WHY IT STOPPED BEING AN ACCIDENT ─────────────────────────────────
 *
 * A `pending` reservation is written BEFORE SMTP is touched and cleared by whichever finalizer
 * learns the outcome. If the process holding it dies in between — a crashed worker, a platform
 * kill, a serverless invocation that reached its ceiling mid-submission — the row survives with
 * nobody to finish it, and the draft it belongs to sits at `sending`, which every client renders
 * as "Sending…" for ever.
 *
 * Until the attempt ceiling landed, reaching that state took a crash. It does not any more: a
 * send that passes the ceiling ends its invocation with the reservation `pending` by DESIGN, and
 * the sole resolver was the client's own same-key retry (`SendService.resumeExisting`). That
 * resolver requires the person to come back to the same browser, with its durable key intact,
 * more than {@link SEND_STALE_AFTER_MS} later. Lose any of those — the tab closed, storage
 * cleared, the send started on another device — and the draft is permanently unreadable and
 * unretryable, which `finalizeFailed`'s own docblock calls "the same lie one surface over".
 *
 * This pass is that resolver, moved somewhere that does not depend on a browser tab being open.
 * It runs the IDENTICAL resolution — {@link SendService.resolveStale}, the single writer — so
 * there is no second opinion about what a stale reservation means.
 *
 * ── WHY IT LIVES IN `services`, AND WHERE IT RUNS ──────────────────────────────────────────
 *
 * `schedule-send-pass.ts`'s placement argument, verbatim and for the same measured reasons: the
 * hosted deployment runs it on the API HOST (`GET /internal/sends/reconcile/run`, poked every
 * minute by the worker's `api-cron.ts`) because the sync worker's platform blocks outbound SMTP
 * and `@trafficflow/services` is not in that app's runtime dependency set at all. `apps/server`
 * runs the same function from its own send clock.
 *
 * **TWO HOSTS TODAY, NOT THREE — the desktop does NOT run this yet.** `apps/sidecar/src/engine.ts`
 * calls `runScheduledSendPass` and nothing here, so a LOCAL install's only resolver is still the
 * client's own same-key retry: exactly the gap this pass closes everywhere else. The hook belongs
 * in that file's drain beside `sendScheduled` and is owned by the multi-mailbox lane while it
 * holds the file. Stated because the sentence above it used to claim all three hosts, which would
 * have made this file's own docblock the evidence that a desktop install was covered when it was
 * not — and `stuckSendMs` was widened on the strength of a reconciler those installs do not have.
 *
 * It is a SEPARATE route from the scheduled-send pass rather than folded into it: that
 * invocation already budgets three sends of up to twenty seconds each against its own
 * sixty-second platform kill, and appending an unrelated batch of probes to it would spend the
 * scheduled sender's remaining budget on this one's work.
 *
 * ── WHY NOTHING HERE CAN SEND ──────────────────────────────────────────────────────────────
 *
 * NEVER RESEND ON AMBIGUITY is the whole subject of this file, so the guarantee
 * is structural rather than a rule somebody follows:
 *
 *  · {@link SendService.resolveStale} contains no call to `send`, and this pass calls nothing
 *    else on the service;
 *  · the adapter this pass hands over is a PROBE-ONLY wrapper whose `send` throws
 *    ({@link probeOnly}), so a future edit that reached for it fails loudly rather than quietly
 *    putting an envelope on the wire;
 *  · the pass never enters `reserve`, which is the one path that would INSERT-and-send were the
 *    reservation row to have vanished underneath it;
 *  · every finalizer is compare-and-swap on `status='pending'`, so a second resolver is a no-op
 *    rather than an overwrite.
 *
 * ── THE BOUND ──────────────────────────────────────────────────────────────────────────────
 *
 * At most {@link SEND_RECONCILE_BATCH} rows per invocation, one connection per DISTINCT mailbox
 * in the batch (so N ids on one mailbox cost one LOGIN, not N), dialled only for a mailbox whose
 * status is `connected`, and on the hosted host wrapped in the same per-mailbox IMAP admission
 * counter every other dialler on that host goes through. No transaction spans a probe.
 */

/**
 * Rows one invocation resolves. PINNED to {@link SCHEDULED_SEND_BATCH} rather than chosen: this
 * pass shares its host, its cadence and its platform ceiling with the scheduled sender, and its
 * per-row cost is strictly smaller (a probe, never a submission). A number of its own would be
 * two constants that have to be reasoned about together and can drift apart.
 */
export const SEND_RECONCILE_BATCH = SCHEDULED_SEND_BATCH;

/**
 * How many stale rows one invocation EXAMINES, as a multiple of the rows it may DIAL.
 *
 * ── THE STARVATION THIS EXISTS TO PREVENT, WHICH A FIXED `LIMIT 3` HAD ──────────────────────
 *
 * The claim writes nothing — there is no status to flip — so its `SKIP LOCKED` is released when
 * the short transaction commits, before any probe. A row that DEFERS is therefore left exactly
 * as it was found, and being ordered oldest-first it is selected again on the very next cycle.
 * Three permanently-deferring rows (a mailbox stuck in `error`, a suspended account, a probe that
 * keeps throwing) would fill the whole window every minute until the 24-hour give-up, and **no
 * newer stranded reservation would be examined for a day** — every draft behind them reading
 * "Sending…" the entire time. That is the head-of-line failure `schedule-send-pass.ts` documents
 * and answers with a paged scan; gating the dial rather than the claim, which this pass does for
 * suspended accounts, covers only that one of the three sources.
 *
 * The answer here is cheaper than paging because the two costs are wildly different: the MIRROR
 * arm is one indexed read and the IMAP arm is a LOGIN. So the batch bounds DIALS, this factor
 * bounds examinations, and every row in the wider window still gets its mirror arm — which is the
 * arm that resolves a stranded row without a connection at all. A deferring row now costs one
 * indexed read and yields its dial slot to a row that can use it.
 */
export const SEND_RECONCILE_SCAN_FACTOR = 4;

/**
 * How long a reservation may stay UNDECIDABLE before it is closed as `unverified` anyway —
 * {@link SCHEDULED_SEND_EXPIRY_MS}, a day, pinned to the appointment expiry for the same reason
 * the batch is pinned: it is the same judgement (past this, an honest ambiguous answer beats a
 * row nobody can act on) about the same mail.
 *
 * It applies ONLY to a row this pass cannot decide — a mailbox in `error` it may not dial, an
 * account whose automation is parked, a probe that keeps throwing. A row it CAN decide is decided
 * on the first cycle, whatever its age.
 */
export const SEND_RECONCILE_GIVE_UP_MS = SCHEDULED_SEND_EXPIRY_MS;

const defaultLog = createLogger({ service: "send-reconcile" });

export interface SendReconcilePassDeps {
  /** The send transport — `makeSendAdapter` on the API host, the local dial on the desktop. */
  openSendAdapter: OpenSendAdapter;
  /**
   * MAY THIS ACCOUNT'S AUTOMATION STILL DIAL? — the suspension gate, injected for
   * `ScheduledSendPassDeps.accountEligible`'s reason (the fact lives in the cloud half and this
   * pass ships in the desktop engine bundle, which may not name a cloud table), read on the
   * HANDED handle for its deadlock reason, and ABSENT ⇒ eligible for its reason too.
   *
   * ── IT GATES THE DIAL, NOT THE CLAIM, AND THAT IS A DELIBERATE DIFFERENCE ─────────────────
   *
   * The scheduled pass excludes an ineligible account's rows from the claim, and needs a paged,
   * eligibility-filtered scan to stop a parked account's backlog starving everyone behind it.
   * Here, excluding is worse than useless: a stranded row is by construction among the OLDEST
   * candidates (nothing else resolves it), so a parked account's strandings would fill this
   * batch's `ORDER BY created_at` window every minute, for ever, and the rows behind them would
   * never be examined — the exact starvation, without the paging that answers it.
   *
   * Gating the DIAL keeps the invariant the suspension exists for (a suspended account's
   * credentials are never used to open a socket) while letting the row be examined, counted, and
   * closed by the give-up. The mirror arm still runs for it, and that is not automation: it is a
   * read of our own database recording a send that has ALREADY happened.
   */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
  log?: Logger;
  now?: () => Date;
  /** Test seams. */
  batch?: number;
  sends?: SendService;
}

export interface SendReconcilePassResult {
  /** Stale `pending` reservations this invocation examined. */
  claimed: number;
  /** Resolved `sent` — the minted id was in the mirror or in the Sent folder. */
  sent: number;
  /** Resolved `unverified`, INCLUDING the give-ups counted separately below. */
  unverified: number;
  /** Left exactly as found: undecidable now, decidable later. */
  deferred: number;
  /** The compare-and-swap matched nothing — another resolver had already written the outcome. */
  resolvedElsewhere: number;
  /** Of `unverified`, how many were closed by the age give-up rather than by evidence. */
  gaveUp: number;
}

/** One row the claim selected, with the two joined facts the resolution needs. */
interface StaleRow {
  send: typeof outboundSends.$inferSelect;
  mailboxId: string;
  /** `connected` | `error` | `disabled` — `schema-mail.ts`, NOT `active`. */
  mailboxStatus: string;
  /** The suspension gate's verdict for this row's account, read inside the claim transaction. */
  eligible: boolean;
}

/**
 * One bounded pass. NEVER throws for a per-row fault — one undecidable reservation must not stop
 * the others, and the summary counts what happened instead.
 */
export async function runSendReconcilePass(
  db: Db, deps: SendReconcilePassDeps,
): Promise<SendReconcilePassResult> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? ((): Date => new Date());
  const batch = deps.batch ?? SEND_RECONCILE_BATCH;
  const sends = deps.sends ?? sendService;
  const result: SendReconcilePassResult = {
    claimed: 0, sent: 0, unverified: 0, deferred: 0, resolvedElsewhere: 0, gaveUp: 0,
  };

  const rows = await claimStale(
    db, now(), batch * SEND_RECONCILE_SCAN_FACTOR, deps.accountEligible,
  );
  result.claimed = rows.length;
  if (rows.length === 0) return result;

  /** Dials spent this invocation. The batch bounds THIS, not the number of rows examined. */
  let dialled = 0;

  // ONE real connection per distinct mailbox in the batch, closed once at the end. The wrapper
  // handed to the service reports `close()` as done immediately so the per-row `finally` inside
  // `resolveStale` does not tear down a connection the next row still needs.
  const held = new Map<string, SendAdapter>();
  const shared = new Map<string, SendAdapter>();
  const openOnce: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
    const cached = shared.get(mailboxId);
    if (cached) return cached;
    const real = await deps.openSendAdapter(mailboxId);
    held.set(mailboxId, real);
    const wrapper = probeOnly(real);
    shared.set(mailboxId, wrapper);
    return wrapper;
  };
  /**
   * FORGET A CONNECTION THAT JUST FAILED, so the rest of the batch re-dials instead of reusing a
   * dead socket. Without this the memo is a liability rather than a saving: one broken handle
   * would fail every remaining row on that mailbox, and for the rows past the give-up that is not
   * a harmless defer — they would be closed terminal `unverified` off a single connection
   * failure, having never had an answer from the server, when a fresh dial would very likely have
   * said `sent`.
   */
  const forget = async (mailboxId: string): Promise<void> => {
    const real = held.get(mailboxId);
    held.delete(mailboxId);
    shared.delete(mailboxId);
    if (real) await real.close().catch(() => { /* it is already broken; that is the point */ });
  };

  try {
    for (const row of rows) {
      const ctx: ServiceContext = {
        db, accountId: row.send.accountId, userId: null, now, requestId: `reconcile:${row.send.id}`,
      };
      const ageMs = now().getTime() - row.send.createdAt.getTime();
      const givingUp = ageMs > SEND_RECONCILE_GIVE_UP_MS;

      /**
       * THE DIAL GATE. `connected` is the only status this pass opens a socket on, and the two
       * refusals are refusals for different reasons:
       *
       *  · `disabled` — the person disconnected this mailbox. There is nothing to dial and there
       *    never will be, so the row is decided NOW as `unverified` rather than left to page.
       *  · `error` — the mailbox is already failing authentication or connection. Dialling it
       *    adds another failed LOGIN to whatever the provider is counting, which is how a
       *    recoverable error becomes a locked account; so the row waits, and the give-up closes
       *    it if the mailbox never comes back.
       *
       * An account whose automation is parked is treated exactly as `error`: no socket, wait,
       * and the give-up still applies. See {@link SendReconcilePassDeps.accountEligible}.
       */
      const mayDial = row.mailboxStatus === "connected" && row.eligible;
      /**
       * What a mirror miss MEANS for this row, and the three no-dial cases are NOT the same:
       *
       *  · `disabled` decides NOW. There is no dial to wait for, so deferring would only park
       *    the row until the give-up closes it a day later with the identical answer — a day of
       *    a draft reading "Sending…" bought for nothing.
       *  · `error`, or a parked account, WAITS. Both are expected to change: a mailbox is
       *    repaired, a suspension lifts, and the row is then decided by evidence instead of by
       *    default. The give-up is the bound on that patience.
       */
      /**
       * OUT OF DIAL BUDGET is its own case, and it must never close a row. The row is perfectly
       * dialable; this invocation simply spent its logins on older ones. Deferring costs a minute
       * — and it still got its mirror arm, which is the arm that resolves most rows anyway.
       * Folding it into the give-up would close a reservation the pass never actually probed.
       */
      const outOfBudget = mayDial && dialled >= batch;
      const willDial = mayDial && !outOfBudget;
      const wouldWait = !mayDial && row.mailboxStatus !== "disabled";
      const onMiss: "unverified" | "defer" =
        outOfBudget ? "defer"
        : row.mailboxStatus === "disabled" ? "unverified"
        : wouldWait && !givingUp ? "defer"
        : "unverified";
      if (willDial) dialled += 1;
      /**
       * Was this row closed because a DAY PASSED, or because the answer was knowable? Recorded
       * as a fact here rather than inferred from the outcome afterwards, because the two are
       * indistinguishable at that point — a `disabled` mailbox produces `undialable` whatever
       * its row's age, so an age-plus-outcome test would count every old disconnected mailbox as
       * a give-up and make the loudest counter on this pass mean something it does not.
       */
      let closedByAge = wouldWait && givingUp && !outOfBudget;

      let outcome;
      try {
        outcome = await sends.resolveStale(
          ctx, row.send, row.mailboxId, willDial ? openOnce : null, onMiss,
        );
      } catch (err) {
        // The probe threw (a dead socket, a deadline, `ImapBoundExceeded`). The row is UNTOUCHED
        // — writing a terminal state off a connection that failed is the ambiguity this path
        // exists to avoid — unless it is old enough that no further cycle is worth waiting for,
        // in which case the mirror arm gets one last read and then the honest ambiguous answer.
        //
        // The connection is dropped from the memo first, whatever happens next: the rows behind
        // this one on the same mailbox must re-dial rather than inherit a socket that has just
        // proved it cannot answer.
        await forget(row.mailboxId);
        if (!givingUp) {
          result.deferred += 1;
          log.warn("send_reconcile_deferred", {
            sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId, err,
          });
          continue;
        }
        // THE GIVE-UP RE-RESOLUTION IS GUARDED TOO. It lives inside a `catch`, so an uncaught
        // fault here — a transaction error, a pool timeout — would escape the per-row `try`,
        // escape the loop, and abort the whole pass: the route would answer 503 and every
        // remaining row in the batch would be skipped, which is precisely what this function's
        // "never throws for a per-row fault" contract forbids. One row may not cost the others.
        try {
          closedByAge = true;
          outcome = await sends.resolveStale(ctx, row.send, row.mailboxId, null, "unverified");
        } catch (giveUpErr) {
          result.deferred += 1;
          log.warn("send_reconcile_deferred", {
            sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId,
            err: giveUpErr,
          });
          continue;
        }
      }

      if (outcome.by === "elsewhere") {
        result.resolvedElsewhere += 1;
        continue;
      }
      if (outcome.by === "deferred") {
        result.deferred += 1;
        continue;
      }
      if (outcome.status === "sent") {
        result.sent += 1;
        log.info("send_reconcile_sent", {
          sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId,
          decidedBy: outcome.by,
        });
        continue;
      }
      result.unverified += 1;
      if (closedByAge) {
        // LOUD, because it is the one outcome that is a decision about time rather than about
        // evidence: a whole day of cycles could not decide this row, and somebody's draft is
        // being closed as ambiguous on that basis.
        result.gaveUp += 1;
        log.warn("send_reconcile_gave_up", {
          sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId,
          mailboxId: row.mailboxId, state: row.mailboxStatus,
        });
      } else {
        log.warn("send_reconcile_unverified", {
          sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId,
          decidedBy: outcome.by,
        });
      }
    }
  } finally {
    for (const adapter of held.values()) {
      await adapter.close().catch(() => { /* already broken; the pass is over either way */ });
    }
  }

  return result;
}

/**
 * THE ADAPTER THIS PASS PROBES THROUGH — the one that CANNOT send.
 *
 * `send` throws rather than being omitted, because omitting it would mean typing the seam as
 * something narrower and the compiler would then be the only thing standing between a future
 * edit and an envelope; a throw is a guarantee that survives a cast. The message names the
 * invariant so the stack trace explains itself.
 *
 * `close` is a no-op ON PURPOSE: {@link SendService.resolveStale} closes the adapter it was
 * handed in a `finally`, which is right for a per-request caller and wrong for a batch that
 * probes several ids on one connection. The real handle is closed once, by the pass.
 */
function probeOnly(real: SendAdapter): SendAdapter {
  return {
    send: () => {
      throw new Error(
        "send-reconcile: this pass may never submit — it resolves an existing reservation by "
        + "reading, and a reservation whose fate is unknown is finalized `unverified`, never resent",
      );
    },
    messageInSent: (messageId: string) => real.messageInSent(messageId),
    close: async () => { /* held for the batch; the pass closes the real handle once */ },
  };
}

/**
 * Select the stale reservations this invocation will examine.
 *
 * `FOR UPDATE OF outbound_sends SKIP LOCKED` — `OF` because a bare `FOR UPDATE` over this join
 * would also lock the `drafts` and `mailboxes` rows, and a row lock on `mailboxes` is the one
 * thing `finalizeSent`'s doorbell note forbids: the finalize of a message that has ALREADY left
 * must never queue behind anybody holding that row.
 *
 * The lock is a courtesy rather than the guarantee. This claim writes nothing — there is no
 * status to flip, because the row's `pending` state IS the durable job and inventing a claim
 * column would be a migration to buy what the compare-and-swap already provides — so the lock
 * lives only as long as this short transaction and two pokes a moment apart can still select the
 * same row. What they CANNOT do is both write it: the finalizers are compare-and-swap, so the
 * second resolver reads the first's answer and reports it. Overlapping pokes cost a duplicate
 * probe, never a wrong outcome.
 *
 * **No predicate on `drafts.status`.** The subject here is the RESERVATION, and it must stop
 * paging the stuck-send alarm whatever became of the draft — a draft somebody already recovered
 * by hand still leaves a `pending` row nobody will ever resolve. The draft is protected by its
 * own compare-and-swap inside the finalizers instead.
 *
 * `ORDER BY created_at` so the oldest — the ones a person has been staring at longest — go first.
 */
async function claimStale(
  db: Db, now: Date, batch: number,
  accountEligible: ((accountId: string, db: Db) => Promise<boolean>) | undefined,
): Promise<StaleRow[]> {
  return (db as unknown as Tx).transaction(async (tx) => {
    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    const found = await tx.select({
      id: outboundSends.id,
      accountId: outboundSends.accountId,
      idempotencyKey: outboundSends.idempotencyKey,
      draftId: outboundSends.draftId,
      mintedMessageId: outboundSends.mintedMessageId,
      providerMessageId: outboundSends.providerMessageId,
      status: outboundSends.status,
      sentAt: outboundSends.sentAt,
      createdAt: outboundSends.createdAt,
      mailboxId: drafts.mailboxId,
      mailboxStatus: mailboxes.status,
    })
      .from(outboundSends)
      .innerJoin(drafts, eq(drafts.id, outboundSends.draftId))
      .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
      .where(and(
        eq(outboundSends.status, "pending"),
        lt(outboundSends.createdAt, staleBefore),
      ))
      .orderBy(outboundSends.createdAt)
      .limit(batch)
      .for("update", { of: outboundSends, skipLocked: true });

    // One eligibility read per DISTINCT account, memoised, and run on THIS transaction's handle
    // rather than a captured outer one — the deadlock rule on
    // `ScheduledSendPassDeps.accountEligible`: on a pooled handle serving one connection per
    // invocation, the captured form queues behind the very transaction awaiting it.
    const verdicts = new Map<string, boolean>();
    const eligible = async (accountId: string): Promise<boolean> => {
      if (!accountEligible) return true;
      const held = verdicts.get(accountId);
      if (held !== undefined) return held;
      const answer = await accountEligible(accountId, tx as unknown as Db);
      verdicts.set(accountId, answer);
      return answer;
    };

    const rows: StaleRow[] = [];
    for (const r of found) {
      rows.push({
        send: {
          id: r.id, accountId: r.accountId, idempotencyKey: r.idempotencyKey, draftId: r.draftId,
          mintedMessageId: r.mintedMessageId, providerMessageId: r.providerMessageId,
          status: r.status, sentAt: r.sentAt, createdAt: r.createdAt,
        },
        mailboxId: r.mailboxId,
        mailboxStatus: r.mailboxStatus,
        eligible: await eligible(r.accountId),
      });
    }
    return rows;
  });
}
