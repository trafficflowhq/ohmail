import { and, eq, lt, ne } from "drizzle-orm";
import { drafts, mailboxes, outboundSends, type Tx } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type SendAdapter } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, SettleFailed, TransientDialRefusal } from "./errors.js";
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
 * TWO numbers, because the two costs are two orders of magnitude apart and one bound cannot serve
 * both. **LOGINS** are capped at {@link SEND_RECONCILE_BATCH} per invocation — that is the
 * expensive thing, it is what the 60-second platform ceiling is budgeted against, and it is
 * counted where a connection is actually opened rather than where one is intended.
 * **ROWS EXAMINED** are capped at `SEND_RECONCILE_BATCH × SEND_RECONCILE_SCAN_FACTOR` from EACH
 * of the two claim windows — twelve and twelve, twenty-four today — because a row's mirror arm is
 * one indexed read and making it wait a minute for that buys nothing. The `error` window is sized
 * off the examination factor and NOT off the login budget, deliberately: rows in it are never
 * dialled, so pinning them to the number of logins would have throttled the one thing they can
 * still get (the mirror arm, and the give-up that ends them) to a quarter of its rate.
 *
 * One connection per DISTINCT mailbox (so N ids on one mailbox cost one LOGIN, not N, and a
 * mailbox already open is free rather than charged a slot), dialled only for a mailbox whose
 * status is `connected`, and on the hosted host wrapped in the same per-mailbox IMAP admission
 * counter every other dialler on that host goes through. No transaction spans a probe.
 */

/**
 * LOGIN ATTEMPTS one invocation may make — not rows it may resolve, which is up to
 * `this × SEND_RECONCILE_SCAN_FACTOR` from each of the two claim windows, since a mirror hit
 * settles a row terminally without a connection. ATTEMPTS rather than successes: a connect that
 * fails has still logged in as far as the provider is concerned. PINNED to {@link SCHEDULED_SEND_BATCH} rather than chosen:
 * this pass shares its host, its cadence and its platform ceiling with the scheduled sender, and
 * its per-dial cost is strictly smaller (a probe, never a submission). A number of its own would
 * be two constants that have to be reasoned about together and can drift apart.
 */
export const SEND_RECONCILE_BATCH = SCHEDULED_SEND_BATCH;

/**
 * How many stale rows one invocation EXAMINES FROM EACH CLAIM WINDOW, as a multiple of the
 * logins it may attempt. There are TWO windows, so the examination total is twice this times
 * the batch — twenty-four against a login budget of three, not four times it.
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
 * and answers with a paged scan.
 *
 * Three things together bound it here, and the third names what is left:
 *
 *  1. **The two costs are separated.** The MIRROR arm is one indexed read; the IMAP arm is a
 *     LOGIN. The batch bounds LOGINS, this factor bounds EXAMINATIONS, and a deferring row now
 *     costs one indexed read instead of a dial slot.
 *  2. **`error` mailboxes have their own window** (`claimStale`), so the source that can never be
 *     resolved by dialling cannot crowd out the rows this pass can actually finish.
 *  3. **A suspended account's rows are still in the dialable window**, because suspension is not
 *     a column this query can read — it is the injected `accountEligible` gate. One parked
 *     account with more than this many stranded sends can therefore still delay newer rows until
 *     its suspension lifts or the give-up fires. BOUNDED, NOT REMOVED, and said out loud rather
 *     than left for somebody to discover: the fix, if it is ever observed, is the paged
 *     eligibility-filtered keyset scan `schedule-send-pass.ts` already carries.
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

/**
 * PER-CALL CEILING on anything this pass does over a socket — the dial, and the Sent-folder
 * search — and the reason it exists at all is that the batch is NOT a time bound.
 *
 * The scheduled sender's 3 × 20 s = 60 s arithmetic works because `SendService.send` races every
 * attempt against {@link SEND_ATTEMPT_CEILING_MS}. This pass had no such race, and
 * `makeSendAdapter` passes no timeouts, so `DEFAULT_NET_TIMEOUTS` applies: a connect of 15 s, a
 * greeting of 15 s and a socket read of 25 s. Three mailboxes hanging in LOGIN or in the
 * post-login LIST is 75 s inside a 60-second platform ceiling — and being killed there is worse
 * than slow, because the `finally` that closes the held connections never runs and each one's
 * admission slot leaks until the stale-window reclaim.
 *
 * Ten seconds, with {@link SEND_RECONCILE_DIAL_DEADLINE_MS} refusing to start any further socket
 * work late in the invocation: the worst case is deadline + one dial + one probe + a bounded
 * teardown, inside the ceiling.
 *
 * TWO THINGS THIS DOES NOT BUY, said plainly because the first draft of this comment claimed
 * both. A breach is CHARGED a login — the LOGIN was issued and the provider saw it, and on the
 * hosted door the admission slot is held for the whole underlying connect however early we stop
 * waiting. And ten seconds is BELOW the adapter's own connect-plus-greeting allowance, so a
 * legitimately slow mailbox will breach it every cycle; that is survivable only because a breach
 * is {@link SendReconcileCeilingExceeded} and never reaches the give-up, so such a mailbox waits
 * indefinitely rather than being closed `unverified` for being slow.
 */
export const SEND_RECONCILE_CALL_CEILING_MS = 10_000;

/**
 * How late into an invocation a NEW dial may still be started. Past this the remaining rows are
 * deferred exactly as if the login budget were spent — they keep their mirror arm, and they are
 * first in line next minute. Bounds the tail the per-call ceiling cannot: three calls that each
 * take the full ten seconds are fine; three that start at second fifty-nine are not.
 */
export const SEND_RECONCILE_DIAL_DEADLINE_MS = 25_000;

/**
 * A CEILING BREACH, kept apart from a work rejection.
 *
 * `send-service.ts`'s own `raceCeiling` returns `{timedOut:true}` rather than throwing for
 * exactly this reason: "the mailbox did not answer in time" and "the mailbox refused" are
 * different facts and a caller that collapses them logs a hung provider and a broken socket
 * identically. This pass needs the distinction for something sharper than a log line — a row
 * whose probe merely RAN OUT OF TIME must never reach the give-up, because a mailbox that is
 * simply slower than our ceiling is reachable, and closing its reservation `unverified` would be
 * the wrong terminal write for a mailbox that was answering the whole time.
 */
export class SendReconcileCeilingExceeded extends Error {
  constructor(what: string, ceilingMs: number) {
    super(`send-reconcile: ${what} exceeded ${ceilingMs}ms`);
    this.name = "SendReconcileCeilingExceeded";
  }
}

/**
 * Tear an adapter down without waiting for it — the ONLY safe teardown for a handle whose
 * operation we have abandoned.
 *
 * `ImapAdapter.forceClose`'s docblock is the whole argument and it names this caller's mistake:
 * imapflow serialises commands, so a graceful LOGOUT queues BEHIND the hung command, and
 * "a caller abandoning a timed-out operation that then awaited `close` would wait exactly as long
 * as the hang it was escaping". This pass did precisely that — a 10-second probe ceiling followed
 * by an awaited `close()` cost the ceiling PLUS the underlying socket timeout, three times over.
 *
 * An adapter without `forceClose` (a spy) is closed politely, but never awaited by the caller:
 * the promise is followed only to keep a rejection from going unhandled.
 */
function abandon(adapter: SendAdapter): void {
  if (adapter.forceClose) {
    try { adapter.forceClose(); } catch { /* the socket is going away regardless */ }
    return;
  }
  void adapter.close().catch(() => { /* already broken; nothing to do */ });
}

/**
 * Race one socket operation against a ceiling. The abandoned promise is followed and its adapter
 * ABANDONED rather than closed politely — see {@link abandon}, which is where the cost of getting
 * this wrong is recorded.
 */
async function bounded<T>(
  what: string, work: Promise<T>, ceilingMs: number, onLateAdapter?: (v: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendReconcileCeilingExceeded(what, ceilingMs)), ceilingMs);
  });
  try {
    return await Promise.race([work, ceiling]);
  } catch (err) {
    // Followed whatever happened, so a LOGIN that lands after we stopped waiting cannot leave an
    // authenticated connection with no handle to it.
    void work.then(
      (v) => { if (onLateAdapter) onLateAdapter(v); },
      () => { /* it failed too; there is nothing to tear down */ },
    );
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

  /**
   * Wall clock at the start, for {@link SEND_RECONCILE_DIAL_DEADLINE_MS} — captured BEFORE the
   * claim, not after. The claim reads two windows of up to twelve rows each plus the injected
   * suspension read per distinct account, and on a loaded pool that is seconds the deadline would
   * otherwise believe it still had.
   */
  const startedAt = now().getTime();
  const rows = await claimStale(
    db, now(), batch * SEND_RECONCILE_SCAN_FACTOR, batch * SEND_RECONCILE_SCAN_FACTOR,
    deps.accountEligible,
  );
  result.claimed = rows.length;
  if (rows.length === 0) return result;

  /**
   * LOGINS actually opened this invocation. The batch bounds THIS, not the rows examined — and
   * counting real connections rather than intentions is load-bearing: a row the mirror answers,
   * or one whose mailbox refuses admission, opens no socket, and charging it a slot would defer
   * healthy dialable rows behind it having spent nothing. That is the head-of-line block the
   * scan factor exists to remove, relocated from the claim window into the budget.
   */
  let dialled = 0;

  // ONE real connection per distinct mailbox in the batch, closed once at the end. The wrapper
  // handed to the service reports `close()` as done immediately so the per-row `finally` inside
  // `resolveStale` does not tear down a connection the next row still needs.
  const held = new Map<string, SendAdapter>();
  const shared = new Map<string, SendAdapter>();
  const openOnce: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
    const cached = shared.get(mailboxId);
    if (cached) return cached;
    /**
     * CHARGE THE ATTEMPT, NOT THE SUCCESS — and the difference is the whole point of the cap.
     *
     * `makeSendAdapter` connects, which LOGS IN. A mailbox with a rotated password or an
     * unreachable host therefore costs a real login and then throws, and charging only the
     * successful path meant those cost NOTHING: `mayDial` is satisfied by `status='connected'`,
     * and nothing in this pass ever demotes a mailbox (only the sync worker writes `'error'`), so
     * every dialable row of a broken-but-`connected` mailbox would attempt a fresh login every
     * minute — up to the whole examination window rather than the batch. That is verbatim the
     * hazard the `error` window exists to avoid ("another failed LOGIN is how a recoverable fault
     * becomes a locked account"), made worse by the change meant to remove head-of-line blocking.
     *
     * A {@link TransientDialRefusal} is the one throw that costs nothing, because it is raised
     * BEFORE the wire: the admission counter refusing, or failing to answer. Everything else
     * touched the network and is charged.
     */
    let real: SendAdapter;
    try {
      real = await bounded(
        "dial", deps.openSendAdapter(mailboxId), SEND_RECONCILE_CALL_CEILING_MS, abandon,
      );
    } catch (err) {
      // FREE ONLY IF NOTHING REACHED THE WIRE, and there are two such refusals, not one.
      // `TransientDialRefusal` is the admission counter; `ServiceError` is `makeSendAdapter`
      // finding no `mailbox_credentials` rows — a pure SELECT, decided before a socket exists.
      // Charging either would let a mailbox that cannot be dialled AT ALL drain the login budget
      // and defer every genuinely dialable row behind it: the head-of-line block this pass keeps
      // being fixed for, re-entered from the other side.
      if (!(err instanceof TransientDialRefusal) && !(err instanceof ServiceError)) dialled += 1;
      throw err;
    }
    dialled += 1;
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
    // ABANDONED, not closed. This is called because something went wrong on or through this
    // connection, so a graceful LOGOUT would queue behind whatever is hung — see {@link abandon}.
    if (real) abandon(real);
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
      // A mailbox this invocation ALREADY holds a connection to is free: reusing it is the whole
      // point of the memo, and charging it a slot would make "N ids on one mailbox cost one
      // LOGIN, not N" false — a mailbox with a dozen strandings would drain three a minute over
      // one socket it had already paid for.
      const lateInTheInvocation =
        now().getTime() - startedAt >= SEND_RECONCILE_DIAL_DEADLINE_MS;
      // THE DEADLINE APPLIES EVEN TO A MAILBOX ALREADY OPEN, and only the LOGIN budget does not.
      // Skipping the whole test for a memoised connection was right for the budget (reusing a
      // socket costs no login) and wrong for the clock: the dialable window holds
      // `batch × SEND_RECONCILE_SCAN_FACTOR` rows and the case this file keeps citing is "a
      // mailbox with a dozen strandings", so twelve probes on one connection consulted no time
      // bound at all and could outlive the invocation exactly as the hung dials did.
      const outOfBudget = mayDial
        && ((!shared.has(row.mailboxId) && dialled >= batch) || lateInTheInvocation);
      const willDial = mayDial && !outOfBudget;
      const onMiss: "unverified" | "defer" =
        outOfBudget ? "defer"
        : willDial ? "unverified"
        : row.mailboxStatus === "disabled" ? "unverified"
        : givingUp ? "unverified"
        : "defer";
      /**
       * Was this row closed because a DAY PASSED, or because the answer was knowable? Recorded
       * as a fact here rather than inferred from the outcome afterwards, because the two are
       * indistinguishable at that point — a `disabled` mailbox produces `undialable` whatever
       * its row's age, so an age-plus-outcome test would count every old disconnected mailbox as
       * a give-up and make the loudest counter on this pass mean something it does not.
       */
      let closedByAge =
        !willDial && !outOfBudget && row.mailboxStatus !== "disabled" && givingUp;

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
        // A WRITE THAT FAILED AFTER THE EVIDENCE WAS IN NEVER GIVES UP, whatever the row's age.
        // The give-up's mirror-only re-resolution would take a probe answer of "the message IS in
        // Sent", throw it away, and record `unverified` — terminally — for a message the server
        // had confirmed milliseconds earlier. The database is what failed; the next cycle
        // re-probes and re-writes, and `pending` is exactly what a failed commit should leave.
        // A CEILING BREACH NEVER REACHES THE GIVE-UP. The mailbox did not refuse and did not
        // fail — it was slower than our ten seconds, which for a dial is BELOW the adapter's own
        // connect-plus-greeting allowance. Giving up on that would write terminal `unverified`
        // for a mailbox that was reachable the whole time, every minute, until the day expired.
        // It is charged a login (the wire was touched) and it waits.
        if (err instanceof SendReconcileCeilingExceeded) {
          result.deferred += 1;
          log.warn("send_reconcile_timed_out", {
            sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId,
            mailboxId: row.mailboxId, err,
          });
          continue;
        }
        if (err instanceof SettleFailed) {
          // The DATABASE is what failed, so whatever connection exists — if any — is not
          // implicated and is kept. Tearing one down here would make the rows behind this one
          // re-dial and re-login for a fault the mailbox had no part in, and under the login
          // accounting those re-dials spend the budget, deferring everything else.
          //
          // "If any" is exact rather than cautious: a `SettleFailed` can be raised with nothing
          // asked of the mailbox at all — the mirror arm settles before any dial, and the
          // undialable arm never dials — so this branch is not evidence that a socket is healthy.
          // It is evidence that the socket is not the problem, which is all the decision needs.
          result.deferred += 1;
          // ITS OWN EVENT, at error level, for the give-up failure's reason one branch down: a
          // settle that fails deterministically leaves these rows `pending` for ever with
          // `gaveUp: 0`, which is indistinguishable from a healthy pass full of undialable
          // mailboxes if it is logged as an ordinary defer.
          log.error("send_reconcile_settle_failed", {
            sendId: row.send.id, accountId: row.send.accountId, draftId: row.send.draftId, err,
          });
          continue;
        }
        // Anything else: the handle is treated as SUSPECT and dropped. Not because everything
        // reaching here came from the connection — a pool timeout in the mirror read, or a throw
        // from `resolveStale`'s own close, land here too and the socket had no part in either —
        // but because the two are not distinguishable at this point and the costs are asymmetric:
        // discarding a healthy handle costs one re-dial, keeping a dead one costs every remaining
        // row on that mailbox. (A factory that refused before connecting left no entry, so this is
        // a no-op there.)
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
          // ITS OWN EVENT, not the quiet one. A give-up that could not be WRITTEN is the 24-hour
          // bound silently ceasing to exist: if this starts failing for every row the pass
          // reports rising `deferred` with `gaveUp: 0`, which is indistinguishable from a healthy
          // pass full of undialable mailboxes, while the reservations stay `pending` for ever.
          // `gaveUp` is documented as the loud counter; the failure to reach it has to be louder,
          // not quieter.
          log.error("send_reconcile_give_up_failed", {
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
    // BOUNDED, and sequential closes are why: three handles whose LOGOUT queues behind a hung
    // command would add three socket timeouts AFTER all the work, past the platform ceiling, with
    // nothing left to show for it. These are handles the pass believes are healthy, so the polite
    // path is tried — with a ceiling, and `abandon` behind it.
    for (const adapter of held.values()) {
      try {
        await bounded("close", adapter.close(), SEND_RECONCILE_CALL_CEILING_MS);
      } catch {
        abandon(adapter);
      }
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
    messageInSent: (messageId: string) => bounded(
      "probe", real.messageInSent(messageId), SEND_RECONCILE_CALL_CEILING_MS,
    ),
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
  db: Db, now: Date, dialWindow: number, waitWindow: number,
  accountEligible: ((accountId: string, db: Db) => Promise<boolean>) | undefined,
): Promise<StaleRow[]> {
  return (db as unknown as Tx).transaction(async (tx) => {
    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    const page = (dialable: boolean, limit: number) => tx.select({
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
        dialable ? ne(mailboxes.status, "error") : eq(mailboxes.status, "error"),
      ))
      .orderBy(outboundSends.createdAt)
      .limit(limit)
      .for("update", { of: outboundSends, skipLocked: true });

    /**
     * TWO WINDOWS, because a mailbox in `error` can never be resolved by dialling and would
     * otherwise monopolise the one window there was.
     *
     * A row on an `error` mailbox is never dialled — a probe there is another failed LOGIN, which
     * is how a recoverable fault becomes a locked account — so it defers on every cycle until the
     * give-up, and being among the oldest by construction it is re-selected every minute. One
     * mailbox stuck in `error` with a dozen strandings would therefore fill a single oldest-first
     * window for a full day and no other account's reservation would be examined at all.
     *
     * Giving those rows their OWN window removes that structurally: they still get the MIRROR arm
     * (a disconnected mailbox does not un-send the mail that already left it, and the mirror may
     * well hold it) and the give-up still closes them, but they cannot crowd out the rows this
     * pass can actually finish. It is the SAME SIZE as the dialable window, not a small one —
     * sized off the examination factor because these rows are never dialled, so pinning them to
     * the login budget would throttle the only two things they can still get. The honest cost:
     * an invocation now examines up to twice what it did before the split, all of it indexed
     * reads.
     *
     * **The residual, stated rather than papered over:** a SUSPENDED account's rows sit in the
     * dialable window (suspension is not a column this query can read — it is the injected
     * `accountEligible` gate), so one parked account with more than `dialWindow` stranded sends
     * can still delay newer rows until its suspension lifts or the give-up fires. Bounded, not
     * removed. `schedule-send-pass.ts` answers the same shape with a paged, eligibility-filtered
     * keyset scan, which is the fix if this is ever observed.
     */
    const found = [
      ...await page(true, dialWindow),
      ...await page(false, waitWindow),
    ];

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
