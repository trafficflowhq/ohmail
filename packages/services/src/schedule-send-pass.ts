import { and, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { drafts, outboundSends, recordChange, type Tx } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type StorageCap } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { sendService, SEND_STALE_AFTER_MS, type SendService } from "./send-service.js";

/**
 * THE SCHEDULED-SEND PASS — turns an appointment (`drafts.send_at`, mail 0077) into a delivery:
 * claim due rows, press the ordinary send button. Two hosts, one implementation: the API host
 * (`GET /internal/sends/scheduled/run`; the sync host blocks outbound SMTP) and the desktop's
 * local loop. CLAIM: `FOR UPDATE SKIP LOCKED`, flip to `'draft'` in one transaction — the status
 * `SendService.reserve` accepts; `send_at`/`send_key` survive as the recovery predicate, retried
 * after `SEND_STALE_AFTER_MS` under the SAME key, so idempotency replays rather than delivering
 * twice. OUTCOMES: sent/unverified — finalizers clear the bookkeeping; `ServiceError` — closed
 * with the sentence; else transient — RE-ARMED unless `SCHEDULED_SEND_EXPIRY_MS` past due.
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
  /**
   * STOP BEFORE THE NEXT DELIVERY — consulted between rows. A pass that has begun is not entitled
   * to finish: on the desktop the mailbox can change hands MID-PASS (the socket dies, a re-dial
   * re-reads the lease, a stranger's claim is found) while this loop holds rows claimed under the
   * old answer — no check BEFORE the pass can see it. `true` stops the loop where it stands;
   * claimed rows are left to the reconciler, the same recovery a crash takes. Absent means "never
   * cancel", so every hosted caller is unchanged.
   */
  cancelled?: () => boolean;

  /** The send transport — `makeSendAdapter` on the API host, the local dial on the desktop. */
  openSendAdapter: OpenSendAdapter;
  /** The sent-copy projection's cap — absent means the projection refuses (`SendDeps`' rule). */
  resolveStorageCap?: (ctx: ServiceContext) => Promise<StorageCap>;
  /**
   * MAY THIS ACCOUNT'S AUTOMATION STILL FIRE? — the suspension gate, INJECTED because the fact
   * lives in the cloud half (`account_suspensions`, `isSuspended` from `@trafficflow/db/cloud`)
   * and this pass ships in the desktop engine bundle, which may not name a cloud table. The
   * standalone door injects nothing ⇒ ELIGIBLE. Consulted INSIDE the claim transaction, before
   * the flip: an ineligible account's rows stay `'scheduled'`, sent promptly once the suspension
   * lifts, never dialled meanwhile. DEADLOCK RULE: the callback queries the CLAIM TRANSACTION's
   * own handle, never a captured outer `db` — on a one-connection pooled handle the read queues
   * behind the transaction awaiting it, and every run times out at the platform ceiling.
   */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
  /**
   * WHICH MAILBOXES THIS PASS MAY CLAIM FOR — absent means ALL, the hosted clock's shape.
   * Store-wide stops being right on the desktop once an install holds more than one mailbox:
   * mailboxes do not share a ROLE — a machine can organize one and merely read another, and a
   * reader must not send an appointment (one surviving a best-effort demotion close would go out
   * from an install the real organizer knows nothing about). Gating the whole pass on "every
   * mailbox organizes" withholds the ORGANIZER's own appointments. AN EMPTY ARRAY MEANS NONE, NOT
   * ABSENT: `undefined` is "no filter", `[]` is "nothing to claim for" — folded by truthiness, a
   * filterless desktop behaves like the hosted clock.
   */
  mailboxIds?: readonly string[];
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

  const rows = await claimDue(db, now(), batch, deps.accountEligible, log, deps.mailboxIds);
  result.claimed = rows.length;

  for (const row of rows) {
    /* BETWEEN ROWS, before this one is dialled — see `cancelled`. The rows already claimed
       above are the reconciler's, exactly as they would be after a crash here. */
    if (deps.cancelled?.()) { result.deferred += rows.length - result.sent - result.failed; break; }
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
        // `in_flight` OR `queued` — both defer, from opposite ends. `in_flight`: a live
        // invocation already owns this key (two pokes overlapping in the one window SKIP LOCKED
        // cannot arbitrate — after the claim committed). `queued`: this call's own submission
        // passed the attempt ceiling and was abandoned mid-flight, fate unknown — in-process it
        // may still land and finalize itself; if not, the row is a `sending` draft with its key
        // standing, exactly what the recovery arm claims once provably stale. Nothing is written
        // either way: closing here writes an ending this pass cannot prove; re-arming offers a
        // second envelope for a message that may already be gone.
        result.deferred += 1;
      }
    } catch (err) {
      if (err instanceof ServiceError) {
        // Deterministic refusal. When `reserve` itself threw, it rolled back — the row is an
        // ordinary 'draft' with the key standing; the close lands. When the refusal came AFTER
        // the reservation committed, the close DECLINES and the reservation is consulted:
        // `failed` — the pre-SMTP window finalized terminally and cleared `send_key`; nothing
        // retries — count FAILED. `pending` — the envelope went out and the Sent probe threw;
        // recovery replays once provably stale — count DEFERRED ("failed" would write an ending
        // this pass cannot prove). A RETRYABLE refusal is not deterministic: the case today is a
        // duplicate refused while the FIRST attempt is still `pending` — closing on it lost the
        // send. So a retryable refusal DEFERS: appointment and key stand, the row comes due
        // again.
        if (err.retryable === true) {
          // RE-ARM, exactly as the transient arm below does and guarded the same way: status still
          // 'draft' (the claim window's own state) and the SAME key. That matches only a row this
          // pass claimed and did not move past, so a row the reservation already advanced is left
          // alone. Leaving it at 'draft' would also come back — the recovery arm claims a keyed row
          // once it is provably stale — but not for ten minutes, and there is nothing to wait for
          // here: the appointment is still due and the next pass can judge it again.
          await (db as unknown as Tx).update(drafts)
            .set({ status: "scheduled", updatedAt: now() })
            .where(and(
              eq(drafts.id, row.id), eq(drafts.status, "draft"), eq(drafts.sendKey, row.sendKey),
            ));
          result.deferred += 1;
          log.warn("scheduled_send_deferred_retryable", {
            draftId: row.id, accountId: row.accountId, code: err.code,
          });
          continue;
        }
        const closed = await closeAppointment(db, ctx, row, err.message, log);
        if (closed || await reservationFailed(db, ctx, row)) result.failed += 1;
        else result.deferred += 1;
        log.warn("scheduled_send_refused", { draftId: row.id, accountId: row.accountId, code: err.code });
      } else {
        // TRANSIENT — and where the fault landed decides who owns the retry. Re-arm, guarded
        // on the claim window (status still 'draft', the SAME key): that matches only a fault
        // BEFORE the reservation existed, and the row simply comes due again next pass.
        //
        // A row the reservation already moved past matches nothing here ON PURPOSE, and there
        // are now two such rows, distinguished by the reservation exactly as the typed branch
        // above distinguishes them. A `failed` reservation is a definite non-delivery the
        // pre-SMTP window already finalized and explained; re-arming it would resend a message
        // whose refusal is recorded, and the guard on `send_key` is what stops that — the key is
        // already NULL. A `pending` one is the unknown-fate case the recovery arm owns.
        await (db as unknown as Tx).update(drafts)
          .set({ status: "scheduled", updatedAt: now() })
          .where(and(
            eq(drafts.id, row.id), eq(drafts.status, "draft"),
            eq(drafts.sendKey, row.sendKey),
          ));
        if (await reservationFailed(db, ctx, row)) {
          result.failed += 1;
          log.warn("scheduled_send_failed", { draftId: row.id, accountId: row.accountId, err });
        } else {
          result.deferred += 1;
          log.warn("scheduled_send_deferred", { draftId: row.id, accountId: row.accountId, err });
        }
      }
    }
  }

  return result;
}

/**
 * How many due candidates one claim PAGE examines — four batches' worth per page. It exists for
 * the eligibility gate: a suspended account's due rows are the OLDEST rows by construction
 * (they sit unsent while the suspension lasts), so a scan that stopped at `batch` could fill
 * itself entirely with rows it then refuses to flip and starve every other account behind them.
 */
export const SCHEDULED_SEND_SCAN_FACTOR = 4;

/**
 * How many DISTINCT accounts one claim may consult the eligibility gate about — the walk's
 * runaway brake, deliberately NOT a page count. A page cap with no memory between invocations
 * meant N+1 parked accounts starved everything behind them PERMANENTLY, every minute
 * re-discovering the same N and exiting. Bounding by accounts examined finishes the walk whenever
 * fewer distinct accounts are parked (a parked account costs one page and one PK lookup per
 * claim). Two hundred keeps the saturated walk inside the serverless ceiling — and two hundred
 * suspended accounts with due appointments in one minute is an operator-scale event, so hitting
 * the brake is LOGGED loudly, not absorbed as a quiet defer.
 */
export const SCHEDULED_SEND_SCAN_ACCOUNTS = 200;

/**
 * Claim what this invocation will attempt: DUE appointments first, then RECOVERY — rows whose
 * claim (or invocation) died mid-flight, identified by `send_key` standing on a row
 * `SEND_STALE_AFTER_MS` past due and no longer `'scheduled'`. Both under `FOR UPDATE SKIP
 * LOCKED`, so two hosts split the work instead of double-claiming — and a user's `cancel`,
 * contending on the same row lock, either wins outright or observes the committed flip and
 * answers "already being sent". The ELIGIBILITY GATE runs inside the transaction, before the
 * flip, per distinct account: an ineligible account's rows stay `'scheduled'`, dialled the cycle
 * after the suspension lifts, never counted toward the batch.
 */
async function claimDue(
  db: Db, now: Date, batch: number,
  accountEligible: ((accountId: string, db: Db) => Promise<boolean>) | undefined,
  log: Logger,
  mailboxIds: readonly string[] | undefined,
): Promise<ClaimedRow[]> {
  const d = dialect(db);
  /* NONE MEANS NONE, decided before a transaction is opened. See the field's own note: an empty
     list is a caller saying it has no mailboxes to claim for, and `inArray(col, [])` is not a
     reliable way to say that across drivers. */
  if (mailboxIds !== undefined && mailboxIds.length === 0) return [];
  return (db as unknown as Tx).transaction(async (tx) => {
    // One eligibility read per distinct account this claim touches, memoised for both arms —
    // and run ON THIS TRANSACTION's handle, never a captured outer one (the deadlock rule on
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
    const ineligibleAccounts = (): string[] =>
      [...eligibility.entries()].filter(([, ok]) => !ok).map(([id]) => id);

    /**
     * A PAGED, ELIGIBILITY-FILTERED SCAN — keyset on `(send_at, id)`, and every page after the
     * first excludes the accounts already found ineligible IN THE QUERY, so a suspended
     * account's parked backlog costs the page that discovers it and nothing per row. Without
     * the pagination, an account owning the oldest `scan`-many due rows re-filled the fixed
     * window every cycle and everything behind it was NEVER claimed — the same starvation the
     * scan factor was added against, standing one shelf higher.
     */
    interface Candidate { id: string; accountId: string; sendKey: string | null; sendAt: Date | null; status?: string }
    const pagedScan = async (base: () => ReturnType<typeof and>, want: number): Promise<Candidate[]> => {
      const taken: Candidate[] = [];
      let after: { sendAt: Date; id: string } | null = null;
      // The walk runs until the batch fills or the candidates are EXHAUSTED — pages exclude
      // known-ineligible accounts, so it always advances — and stops early only at the
      // account-count brake, which is logged as saturation below (the state must be loud).
      while (taken.length < want && eligibility.size < SCHEDULED_SEND_SCAN_ACCOUNTS) {
        const skip = ineligibleAccounts();
        // SKIP LOCKED through the seam: on the server it is what lets several runners share one
        // window without queueing behind each other, and on the device store it is the identity
        // for the same reason the lock is — one serialized writer, nothing to skip.
        const rows: Candidate[] = await d.skipLocked(tx.select({
          id: drafts.id, accountId: drafts.accountId, sendKey: drafts.sendKey,
          sendAt: drafts.sendAt, status: drafts.status,
        }).from(drafts)
          .where(and(
            base(),
            /* THE MAILBOX NARROWING, in the scan rather than in either arm's `base()`, so the
               due arm and the stale-recovery arm cannot drift apart about it. A recovered
               'sending' row belongs to exactly the same mailbox its appointment did. */
            ...(mailboxIds === undefined ? [] : [inArray(drafts.mailboxId, [...mailboxIds])]),
            // The keyset bound's params are serialized EXPLICITLY (ISO text + casts): a raw
            // `Date` in a sql`` fragment bypasses drizzle's column mapping, and postgres-js
            // refuses it — PGlite tolerated it, which is exactly the class of green the
            // pg-suite rule exists to distrust.
            ...(after
              ? [sql`(${drafts.sendAt}, ${drafts.id}) > (${d.ts(after.sendAt)}, ${d.castUuid(after.id)})`]
              : []),
            ...(skip.length > 0 ? [notInArray(drafts.accountId, skip)] : []),
          ))
          .orderBy(drafts.sendAt, drafts.id)
          .limit(batch * SCHEDULED_SEND_SCAN_FACTOR));
        if (rows.length === 0) break;
        for (const row of rows) {
          if (taken.length >= want) break;
          if (eligibility.size >= SCHEDULED_SEND_SCAN_ACCOUNTS && !eligibility.has(row.accountId)) break;
          if (await eligible(row.accountId)) taken.push(row);
        }
        const last = rows[rows.length - 1]!;
        after = { sendAt: last.sendAt as Date, id: last.id };
      }
      if (taken.length < want && eligibility.size >= SCHEDULED_SEND_SCAN_ACCOUNTS) {
        // Operator-scale: this many distinct parked accounts owning due appointments in one
        // claim is an incident, and a quiet defer here is how it would stay invisible.
        log.error("scheduled_send_scan_saturated", { count: eligibility.size });
      }
      return taken;
    };

    const due = await pagedScan(
      () => and(eq(drafts.status, "scheduled"), lte(drafts.sendAt, now), isNotNull(drafts.sendKey)),
      batch,
    );

    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    const recovery = due.length >= batch ? [] : await pagedScan(
      () => and(
        isNotNull(drafts.sendKey),
        lte(drafts.sendAt, staleBefore),
        // 'draft' = the claim committed and the sender died; 'sending' = the reservation was
        // made and the finalizer never ran. Both answer to the SAME stored key, which is what
        // makes the retry a replay. 'scheduled' rows are the due arm's; terminal rows have no key.
        inArray(drafts.status, ["draft", "sending"]),
      ),
      batch - due.length,
    );

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
/**
 * Did the reservation under this row's key end TERMINALLY as a definite non-delivery? The
 * discriminator between "already finished and explained" and "fate unknown, recovery owns it" —
 * indistinguishable from the exception alone. Read from the reservation row because that is where
 * the answer is authoritative: `SendService` writes it in the same transaction that clears the
 * appointment, so the two never disagree. Only on the failure path and only when the close
 * declined — one query per failure, none per delivery. A read failure answers `false`, routing
 * the row to DEFERRED: the conservative direction — recovery re-examines the row rather than an
 * operator being told an ending never proven.
 */
async function reservationFailed(db: Db, ctx: ServiceContext, row: ClaimedRow): Promise<boolean> {
  try {
    const found = await (db as unknown as Tx).select({ status: outboundSends.status })
      .from(outboundSends)
      .where(and(
        eq(outboundSends.accountId, ctx.accountId),
        eq(outboundSends.idempotencyKey, row.sendKey),
      ))
      .limit(1);
    return found[0]?.status === "failed";
  } catch {
    return false;
  }
}

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
