import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { drafts, recordChange, type Tx } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type StorageCap } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { sendService, SEND_STALE_AFTER_MS, type SendService } from "./send-service.js";

/**
 * THE SCHEDULED-SEND PASS — the piece that turns an appointment (`drafts.send_at`, mail 0077)
 * into a delivery, by claiming due rows and pressing the ordinary send button on each.
 *
 * ── ONE IMPLEMENTATION, TWO HOSTS, AND WHY IT LIVES IN `services` ──────────────────────────
 *
 * The hosted deployment runs it on the API HOST (`GET /internal/sends/scheduled/run`, poked
 * every minute by the worker's `api-cron.ts`), and that placement is forced twice over by
 * measured facts, not preference: the production sync host's platform BLOCKS outbound SMTP
 * submission at the port level (`apps/worker/src/smtp-size.ts` — twelve hosts, every dial a
 * timeout, IMAP to the same host 300 ms), and the worker's runtime dependency set may not
 * include `@trafficflow/services` at all (its package.json records the measured Node-23
 * boot crash that promoting it caused). The standalone desktop runs the SAME function from its
 * local loop with its own send adapter — the sync pipeline's one-implementation rule, applied
 * to sending on a clock.
 *
 * ── THE CLAIM, AND WHY IT FLIPS `status` BACK TO `'draft'` ─────────────────────────────────
 *
 * `FOR UPDATE SKIP LOCKED` over `status = 'scheduled' AND send_at <= now`, then the claimed
 * rows go to `'draft'` IN THE SAME TRANSACTION — because `'draft'` is the one status
 * `SendService.reserve` accepts, and the whole point is to run THAT function unmodified.
 * `send_at` and `send_key` deliberately survive the flip: they are the recovery predicate. A
 * process that dies anywhere after this commit leaves a row that {@link claimDue}'s RECOVERY
 * arm re-finds once the appointment is {@link SEND_STALE_AFTER_MS} past due — and the retry
 * presents the SAME `send_key`, so `reserve`'s idempotency gate replays whatever the first
 * attempt achieved instead of delivering twice. That constant is reused rather than shadowed:
 * it is already the system's one answer to "how old must an attempt be before no invocation
 * can still be running".
 *
 * The claim window (status `'draft'`, `send_at` standing) is also what the user-facing verbs
 * key on: `ScheduleService.cancel` answers 409 "already being sent" for it, and
 * `ScheduleService.schedule` refuses to mint a second appointment over it.
 *
 * ── OUTCOMES, AND WHO CLEARS THE BOOKKEEPING ───────────────────────────────────────────────
 *
 *   sent / unverified   `SendService`'s own finalizers clear `send_at`/`send_key` in the same
 *                       transaction that records the terminal status, and emit the `draft`
 *                       change. Nothing to do here. An `unverified` row surfaces in Drafts
 *                       under the standing "we couldn't confirm this send" copy.
 *   ServiceError        a DETERMINISTIC refusal (the mailbox was disconnected by send time, the
 *                       recipients were removed, a prior attempt under this key is terminally
 *                       `failed`): the appointment is closed, the row returns to an ordinary
 *                       draft, and `send_error` carries the server's sentence for the Drafts
 *                       row to quote. Retrying a refusal that cannot change is not honesty.
 *   anything else       a TRANSIENT fault (the adapter's dial threw, the database blipped): the
 *                       row is RE-ARMED (`status = 'scheduled'` again) so the next pass
 *                       retries — unless the appointment is more than {@link
 *                       SCHEDULED_SEND_EXPIRY_MS} past due, at which point retrying quietly
 *                       forever would be the dishonest state and the row is closed with a
 *                       sentence instead. The re-arm is guarded on the row still being in the
 *                       claim window, so it can never resurrect a row a concurrent finalizer
 *                       settled.
 */

/**
 * Due rows one invocation will actually SEND. Three, deliberately small: the hosted pass runs
 * inside a serverless invocation with a 60-second ceiling, each send is an SMTP dial plus an
 * IMAP Sent-append on the user's own servers (seconds each, unbounded in the tail), and the
 * pass is re-poked every minute — so a burst simply drains a few per minute rather than one
 * invocation racing its own platform deadline mid-delivery. The claim takes only what will be
 * attempted now; everything else stays `'scheduled'` and is untouched.
 */
export const SCHEDULED_SEND_BATCH = 3;

/**
 * How far past due an appointment may still be KEPT at all. A day: long enough to ride out any
 * realistic outage (a self-hosted pass that was simply not running, a desktop that was closed
 * overnight), and short enough that "scheduled for 9:00" cannot silently become "sent
 * Thursday" — past this, a quiet late delivery is worse than an honest failure the user can
 * act on, so the row is closed with a sentence BEFORE anything dials. Applies only while no
 * reservation exists: a row whose send already reserved (`'sending'`) is the reservation
 * machinery's to finish — verify-by-Sent resolves it terminally, and closing it here would
 * strand a `pending` reservation for the stuck-send alarm to page on for ever.
 */
export const SCHEDULED_SEND_EXPIRY_MS = 24 * 60 * 60 * 1000;

const defaultLog = createLogger({ service: "scheduled-send" });

export interface ScheduledSendPassDeps {
  /** The send transport — `makeSendAdapter` on the API host, the local dial on the desktop. */
  openSendAdapter: OpenSendAdapter;
  /** The sent-copy projection's cap — absent means the projection refuses (`SendDeps`' rule). */
  resolveStorageCap?: (ctx: ServiceContext) => Promise<StorageCap>;
  log?: Logger;
  now?: () => Date;
  /** Test seams. */
  batch?: number;
  sends?: SendService;
}

export interface ScheduledSendPassResult {
  /** Rows claimed this invocation (due + recovered). */
  claimed: number;
  sent: number;
  unverified: number;
  /** Appointments closed with a `send_error` sentence. */
  failed: number;
  /** Transient faults re-armed for the next pass. */
  deferred: number;
}

interface ClaimedRow {
  id: string;
  accountId: string;
  sendKey: string;
  sendAt: Date;
  /**
   * True for a recovered `'sending'` row — a reservation exists (reserve commits the flip and
   * the INSERT in one transaction), so the expiry close may not touch it and a transient fault
   * leaves it exactly as found. Everything claimed from `'scheduled'` or recovered at `'draft'`
   * provably has none yet.
   */
  mayHaveReservation: boolean;
}

/** One bounded pass. Never throws for a per-row fault — one broken appointment must not stop the rest. */
export async function runScheduledSendPass(
  db: Db, deps: ScheduledSendPassDeps,
): Promise<ScheduledSendPassResult> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? ((): Date => new Date());
  const batch = deps.batch ?? SCHEDULED_SEND_BATCH;
  const sends = deps.sends ?? sendService;
  const result: ScheduledSendPassResult = { claimed: 0, sent: 0, unverified: 0, failed: 0, deferred: 0 };

  const rows = await claimDue(db, now(), batch);
  result.claimed = rows.length;

  for (const row of rows) {
    const ctx: ServiceContext = {
      db, accountId: row.accountId, userId: null, now, requestId: `sched:${row.id}`,
    };
    // TOO LATE IS ITS OWN ANSWER, decided BEFORE anything dials — see the constant. Only for a
    // row with no reservation; a recovered 'sending' row runs the send below regardless of age,
    // because verify-by-Sent is what resolves its reservation terminally.
    if (!row.mayHaveReservation
      && now().getTime() - row.sendAt.getTime() > SCHEDULED_SEND_EXPIRY_MS) {
      await closeAppointment(db, ctx, row,
        "The scheduled time passed more than a day ago, so this was not sent. Review the message and send it again.",
        log);
      result.failed += 1;
      log.warn("scheduled_send_expired", { draftId: row.id, accountId: row.accountId });
      continue;
    }
    try {
      const res = await sends.send(ctx, row.id, row.sendKey, {
        openSendAdapter: deps.openSendAdapter,
        ...(deps.resolveStorageCap ? { resolveStorageCap: deps.resolveStorageCap } : {}),
        // No request pipeline carries bytes at send time — the draft row stores none and the
        // adapter dials from this process — so the truthful surface is the local engine's.
        surfaceMaxTotalBytes: null,
        log,
      });
      if (res.status === "sent") {
        result.sent += 1;
        log.info("scheduled_send_sent", { draftId: row.id, accountId: row.accountId });
      } else if (res.status === "unverified") {
        result.unverified += 1;
        log.warn("scheduled_send_unverified", { draftId: row.id, accountId: row.accountId });
      } else if (res.status === "failed") {
        // A terminally-failed prior reservation under this key. The appointment is over.
        await closeAppointment(db, ctx, row,
          "A prior send attempt under this schedule failed and was not delivered.", log);
        result.failed += 1;
      } else {
        // `in_flight`: a live invocation already owns this key (two pokes overlapping in the
        // one window SKIP LOCKED cannot arbitrate — after the claim committed). Nothing is
        // written; the recovery arm re-finds the row once the attempt is provably dead.
        result.deferred += 1;
      }
    } catch (err) {
      if (err instanceof ServiceError) {
        // Deterministic refusal — retrying it unchanged cannot succeed, so the honest ending
        // is the sentence in the Drafts row. `reserve` throws inside its transaction, so the
        // reservation rolled back and the row is an ordinary 'draft' again.
        await closeAppointment(db, ctx, row, err.message, log);
        result.failed += 1;
        log.warn("scheduled_send_refused", { draftId: row.id, accountId: row.accountId, code: err.code });
      } else {
        // TRANSIENT — and where the fault landed decides who owns the retry. Re-arm, guarded
        // on the claim window (status still 'draft', the SAME key): that matches only a fault
        // BEFORE the reservation existed, and the row simply comes due again next pass. A row
        // `reserve` already moved to 'sending' matches nothing here ON PURPOSE — its
        // reservation stands, so the recovery arm replays the key once the row is provably
        // stale and verify-by-Sent gives it a terminal answer; meanwhile the drafts list's
        // stale-`sending` copy is the user-visible truth. Either way this pass writes no
        // failure it cannot prove.
        await (db as unknown as Tx).update(drafts)
          .set({ status: "scheduled", updatedAt: now() })
          .where(and(
            eq(drafts.id, row.id), eq(drafts.status, "draft"),
            eq(drafts.sendKey, row.sendKey),
          ));
        result.deferred += 1;
        log.warn("scheduled_send_deferred", { draftId: row.id, accountId: row.accountId, err });
      }
    }
  }

  return result;
}

/**
 * Claim what this invocation will attempt: DUE appointments first, then RECOVERY — rows whose
 * claim (or whole invocation) died mid-flight, identified by `send_key` standing on a row that
 * is `{SEND_STALE_AFTER_MS}` past due and no longer `'scheduled'`. Both under
 * `FOR UPDATE SKIP LOCKED`, so two hosts (or an overlapping poke) split the work instead of
 * double-claiming a row — and a user's `cancel`, which contends on the same row lock, either
 * wins outright or observes the claim's committed flip and answers "already being sent".
 */
async function claimDue(db: Db, now: Date, batch: number): Promise<ClaimedRow[]> {
  return (db as unknown as Tx).transaction(async (tx) => {
    const due = await tx.select({
      id: drafts.id, accountId: drafts.accountId, sendKey: drafts.sendKey, sendAt: drafts.sendAt,
    }).from(drafts)
      .where(and(eq(drafts.status, "scheduled"), lte(drafts.sendAt, now), isNotNull(drafts.sendKey)))
      .orderBy(drafts.sendAt)
      .limit(batch)
      .for("update", { skipLocked: true });

    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    const recovery = due.length >= batch ? [] : await tx.select({
      id: drafts.id, accountId: drafts.accountId, sendKey: drafts.sendKey, sendAt: drafts.sendAt,
      status: drafts.status,
    }).from(drafts)
      .where(and(
        isNotNull(drafts.sendKey),
        lte(drafts.sendAt, staleBefore),
        // 'draft' = the claim committed and the sender died; 'sending' = the reservation was
        // made and the finalizer never ran. Both answer to the SAME stored key, which is what
        // makes the retry a replay. 'scheduled' rows are the due arm's; terminal rows have no key.
        inArray(drafts.status, ["draft", "sending"]),
      ))
      .orderBy(drafts.sendAt)
      .limit(batch - due.length)
      .for("update", { skipLocked: true });

    if (due.length > 0) {
      await tx.update(drafts)
        .set({ status: "draft", updatedAt: now })
        .where(inArray(drafts.id, due.map((r) => r.id)));
    }
    // A recovered 'sending' row is left exactly as found: `SendService.send` owns it from here.

    return [
      // Non-null casts on each arm's own predicate; `mayHaveReservation` per its field's note.
      ...due.map((r) => ({
        id: r.id, accountId: r.accountId,
        sendKey: r.sendKey as string, sendAt: r.sendAt as Date, mayHaveReservation: false,
      })),
      ...recovery.map((r) => ({
        id: r.id, accountId: r.accountId,
        sendKey: r.sendKey as string, sendAt: r.sendAt as Date,
        mayHaveReservation: r.status === "sending",
      })),
    ];
  });
}

/**
 * Close an appointment that will not be kept: bookkeeping cleared, the sentence stored, the row
 * an ordinary draft again — and a `draft` change emitted, because this is the one terminal
 * outcome `SendService`'s finalizers do not announce (they never ran, or ended in rollback).
 * Guarded on `send_key` so a re-scheduled row (fresh key) can never have its NEW appointment
 * closed by a stale failure from the old one.
 */
async function closeAppointment(
  db: Db, ctx: ServiceContext, row: ClaimedRow, sentence: string, log: Logger,
): Promise<void> {
  try {
    await (db as unknown as Tx).transaction(async (tx) => {
      const closed = await tx.update(drafts)
        .set({ status: "draft", sendAt: null, sendKey: null, sendError: sentence, updatedAt: ctx.now() })
        .where(and(
          eq(drafts.id, row.id), eq(drafts.accountId, ctx.accountId),
          // THE KEY IS THE GUARD: a re-scheduled row carries a fresh key, so a stale failure
          // from the old appointment can never close the new one.
          eq(drafts.sendKey, row.sendKey),
          // And never a row that reached a real terminal status — its finalizer already spoke.
          sql`${drafts.status} in ('draft', 'sending', 'scheduled')`,
        ))
        .returning({ id: drafts.id });
      if (closed.length > 0) {
        await recordChange(tx, {
          accountId: ctx.accountId, entityType: "draft", entityId: row.id, op: "update", meta: null,
        });
      }
    });
  } catch (err) {
    // The next pass's recovery arm re-finds the row (the key still stands); nothing is lost.
    log.warn("scheduled_send_close_failed", { draftId: row.id, err });
  }
}
