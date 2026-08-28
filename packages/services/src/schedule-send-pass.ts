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
  /**
   * MAY THIS ACCOUNT'S AUTOMATION STILL FIRE? — the suspension gate, INJECTED because the fact
   * lives in the cloud half (`account_suspensions`, read with `isSuspended` from
   * `@trafficflow/db/cloud`) and this pass ships in the desktop engine bundle, which may not
   * name a cloud table. The hosted route and the self-host clock inject the real read; the
   * standalone door injects nothing, which resolves to ELIGIBLE — its store has no suspension
   * concept, and the machine's own login is the boundary.
   *
   * Consulted INSIDE the claim transaction, before the flip, so an ineligible account's due
   * rows are left exactly as they stand — still `'scheduled'`, re-examined next cycle, sent
   * promptly once the suspension lifts, and never dialled meanwhile. The worker's own passes
   * make the same ruling from the other end (a suspended account is in no shard's roster):
   * "a suspended account's automation must not keep firing", and a pass that dials SMTP with
   * retained credentials is exactly such automation.
   *
   * ── THE READ RUNS ON THE HANDLE THE PASS HANDS OVER, AND THAT IS A DEADLOCK RULE ──────────
   *
   * The callback receives the CLAIM TRANSACTION's own handle and must query THAT, never a
   * captured outer `db`. On a pooled handle that serves one connection per invocation — the
   * serverless shape — the claim transaction holds that connection, so a read on the captured
   * outer handle queues behind the very transaction awaiting it: every run of the sender clock
   * then times out at the platform ceiling and no appointment fires, which is how this rule
   * was learned. The injectors' whole body is `isSuspended(handle, accountId)`, so handing
   * the handle through costs one parameter and removes the failure class.
   */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
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

  const rows = await claimDue(db, now(), batch, deps.accountEligible);
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
        // A terminally-failed prior reservation under this key. The appointment is over — and
        // `includeSending` is TRUE here alone, because "failed" is the reservation machinery's
        // own word that the reservation is terminal, which is exactly the proof the close's
        // 'sending' exclusion exists to demand.
        await closeAppointment(db, ctx, row,
          "A prior send attempt under this schedule failed and was not delivered.", log,
          { includeSending: true });
        result.failed += 1;
      } else {
        // `in_flight`: a live invocation already owns this key (two pokes overlapping in the
        // one window SKIP LOCKED cannot arbitrate — after the claim committed). Nothing is
        // written; the recovery arm re-finds the row once the attempt is provably dead.
        result.deferred += 1;
      }
    } catch (err) {
      if (err instanceof ServiceError) {
        // Deterministic refusal. When `reserve` itself threw, it rolled back and the row is an
        // ordinary 'draft' — the close lands and the sentence goes in the Drafts row. When the
        // refusal came AFTER the reservation committed (`makeSendAdapter` refusing over deleted
        // credentials is the measured shape), the row is 'sending' and the close DECLINES by
        // its own predicate: the reservation stands, the recovery arm replays the key once the
        // row is stale, and verify-by-Sent ends it terminally — so that outcome is counted as
        // DEFERRED, because "failed" would be this pass writing up an ending it cannot prove.
        const closed = await closeAppointment(db, ctx, row, err.message, log);
        if (closed) result.failed += 1;
        else result.deferred += 1;
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
 * How many due candidates one claim EXAMINES to fill its batch of {@link SCHEDULED_SEND_BATCH}
 * sends — four batches' worth. It exists for the eligibility gate: a suspended account's due
 * rows are the OLDEST rows by construction (they sit unsent while the suspension lasts), so a
 * scan that stopped at `batch` could fill itself entirely with rows it then refuses to flip
 * and starve every other account behind them. Four is deliberately small — the scan is a
 * per-minute indexed read, suspension is rare, and an account with more than nine due
 * appointments parked behind a suspension delays other accounts by at most one cycle per
 * batch it fills.
 */
export const SCHEDULED_SEND_SCAN_FACTOR = 4;

/**
 * Claim what this invocation will attempt: DUE appointments first, then RECOVERY — rows whose
 * claim (or whole invocation) died mid-flight, identified by `send_key` standing on a row that
 * is `{SEND_STALE_AFTER_MS}` past due and no longer `'scheduled'`. Both under
 * `FOR UPDATE SKIP LOCKED`, so two hosts (or an overlapping poke) split the work instead of
 * double-claiming a row — and a user's `cancel`, which contends on the same row lock, either
 * wins outright or observes the claim's committed flip and answers "already being sent".
 *
 * The ELIGIBILITY GATE runs inside the transaction, before the flip, per account rather than
 * per row (one read per distinct account this scan touched): an ineligible account's rows are
 * left untouched — still `'scheduled'`, still due, dialled the cycle after the suspension
 * lifts — and never counted toward the batch.
 */
async function claimDue(
  db: Db, now: Date, batch: number,
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>,
): Promise<ClaimedRow[]> {
  return (db as unknown as Tx).transaction(async (tx) => {
    const scan = batch * SCHEDULED_SEND_SCAN_FACTOR;
    const candidates = await tx.select({
      id: drafts.id, accountId: drafts.accountId, sendKey: drafts.sendKey, sendAt: drafts.sendAt,
    }).from(drafts)
      .where(and(eq(drafts.status, "scheduled"), lte(drafts.sendAt, now), isNotNull(drafts.sendKey)))
      .orderBy(drafts.sendAt)
      .limit(scan)
      .for("update", { skipLocked: true });

    // One eligibility read per distinct account in the scan, memoised for both arms — and run
    // ON THIS TRANSACTION's handle, never a captured outer one (the deadlock rule on
    // `ScheduledSendPassDeps.accountEligible`).
    const eligibility = new Map<string, boolean>();
    const eligible = async (accountId: string): Promise<boolean> => {
      if (!accountEligible) return true;
      const held = eligibility.get(accountId);
      if (held !== undefined) return held;
      const answer = await accountEligible(accountId, tx as unknown as Db);
      eligibility.set(accountId, answer);
      return answer;
    };

    const due: typeof candidates = [];
    for (const row of candidates) {
      if (due.length >= batch) break;
      if (await eligible(row.accountId)) due.push(row);
    }

    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    const recoveryCandidates = due.length >= batch ? [] : await tx.select({
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
    const recovery: typeof recoveryCandidates = [];
    for (const row of recoveryCandidates) {
      if (await eligible(row.accountId)) recovery.push(row);
    }

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
 * closed by a stale failure from the old one. Answers whether anything closed, so the caller's
 * counters can tell a settled failure from a row the predicate protected.
 */
async function closeAppointment(
  db: Db, ctx: ServiceContext, row: ClaimedRow, sentence: string, log: Logger,
  opts: { includeSending?: boolean } = {},
): Promise<boolean> {
  try {
    return await (db as unknown as Tx).transaction(async (tx) => {
      const closed = await tx.update(drafts)
        .set({ status: "draft", sendAt: null, sendKey: null, sendError: sentence, updatedAt: ctx.now() })
        .where(and(
          eq(drafts.id, row.id), eq(drafts.accountId, ctx.accountId),
          // THE KEY IS THE GUARD: a re-scheduled row carries a fresh key, so a stale failure
          // from the old appointment can never close the new one.
          eq(drafts.sendKey, row.sendKey),
          // And never a row that is 'sending' or terminal — unless the CALLER proved the
          // reservation terminal (`includeSending`, the failed-replay branch alone). 'sending'
          // means a RESERVATION EXISTS (reserve commits the flip and the INSERT in one
          // transaction) — a `ServiceError` thrown after that commit (the adapter factory
          // refusing over deleted credentials is the measured shape) does NOT prove a
          // rollback, and closing on it would clear the `send_key` the recovery arm replays,
          // stranding a `pending` reservation nothing can ever resolve while the stuck-send
          // alarm pages on it. Left standing, the recovery arm re-presents the key once the
          // row is stale and verify-by-Sent ends it terminally. Terminal rows' finalizers
          // already spoke.
          opts.includeSending
            ? sql`${drafts.status} in ('draft', 'sending', 'scheduled')`
            : sql`${drafts.status} in ('draft', 'scheduled')`,
        ))
        .returning({ id: drafts.id });
      if (closed.length > 0) {
        await recordChange(tx, {
          accountId: ctx.accountId, entityType: "draft", entityId: row.id, op: "update", meta: null,
        });
      }
      return closed.length > 0;
    });
  } catch (err) {
    // The next pass's recovery arm re-finds the row (the key still stands); nothing is lost.
    log.warn("scheduled_send_close_failed", { draftId: row.id, err });
    return false;
  }
}
