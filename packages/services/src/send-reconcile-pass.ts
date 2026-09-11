import { and, eq, lt, ne } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { drafts, mailboxes, outboundSends, type Tx } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type SendAdapter } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, SettleFailed, TransientDialRefusal } from "./errors.js";
import { SCHEDULED_SEND_BATCH, SCHEDULED_SEND_EXPIRY_MS } from "./schedule-send-pass.js";
import { sendService, SEND_STALE_AFTER_MS, type SendService } from "./send-service.js";

/**
 * THE RECONCILING PASS FOR STRANDED SEND RESERVATIONS — resolves an `outbound_sends` row left
 * `pending` by an attempt nobody is coming back for, running the IDENTICAL resolution:
 * `SendService.resolveStale`, the single writer. TWO HOSTS, NOT THREE — the API host (`GET
 * /internal/sends/reconcile/run`) and `apps/server`; the desktop does NOT run it yet. NOTHING
 * HERE CAN SEND: `resolveStale` has no `send`; the adapter is PROBE-ONLY (its `send` throws); the
 * pass never enters `reserve`; every finalizer is compare-and-swap on `status='pending'`. LOGINS
 * cap at `SEND_RECONCILE_BATCH`, rows examined at batch × `SEND_RECONCILE_SCAN_FACTOR` per
 * window. One connection per DISTINCT mailbox; no transaction spans a probe.
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
 * How many stale rows one invocation EXAMINES FROM EACH CLAIM WINDOW, a multiple of the login
 * budget — two windows, twenty-four against three logins. The starvation a fixed `LIMIT 3` had:
 * the claim writes nothing, so a deferring row is left as found and, oldest-first, re-selected
 * next cycle — three permanently-deferring rows filled the window every minute and no newer
 * reservation was examined for a day. Three bounds: the costs are separated (the MIRROR arm is
 * one indexed read, the IMAP arm a LOGIN); `error` mailboxes have their own window; and the
 * residual is NAMED — a suspended account's rows sit in the dialable window, so one parked
 * account can still delay newer rows.
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
 * THE DEADLINES THIS PASS HANDS ITS ADAPTER — threaded into the connection, never raced from
 * outside. Racing was tried and removed: imapflow serialises commands, so an abandoning caller
 * does not stop a timed-out operation — a graceful close waits out the very hang it escaped
 * (`ImapAdapter.forceClose`); and a caller-side ceiling below the adapter's own allowance
 * breached every slow-but-working mailbox. Handed shorter deadlines, a breach is the adapter's
 * own answer. Eight, eight and ten (defaults: fifteen, fifteen, twenty-five); a cold LOGIN is 1–3
 * s. These bound connect, greeting and INACTIVITY, not a command whose responses keep arriving
 * (`IMAP_READ_DEADLINE_MS`, 180 s) — a KNOWN residual: nothing is written on that path.
 */
export const SEND_RECONCILE_NET_TIMEOUTS = {
  connectionMs: 8_000,
  greetingMs: 8_000,
  socketMs: 10_000,
} as const;

/**
 * PER-CALL CEILING on the Sent-folder SEARCH, and nothing else. The dial is handed
 * `SEND_RECONCILE_NET_TIMEOUTS` instead of being raced; this one remains because the SEARCH's
 * adapter-side bound is `IMAP_READ_DEADLINE_MS` — 180 seconds, three times this invocation — so
 * "the adapter will stop it" is true only on a timescale that has already lost (`socketMs` is an
 * INACTIVITY timer, and a server trickling untagged responses is never idle — `imap-bounds.ts`'s
 * slow-loris instrument). A breach here is this pass's own impatience, never evidence — but past
 * the day-long give-up it is still UNDECIDABLE, which that deadline exists to end. The handle is
 * destroyed either way: the abandoned SEARCH still owns the command queue.
 */
export const SEND_RECONCILE_CALL_CEILING_MS = 10_000;

/**
 * Ceiling on the end-of-pass teardown, which is a shorter job than a probe: a LOGOUT on a healthy
 * connection is one round trip. It is separate from {@link SEND_RECONCILE_CALL_CEILING_MS} because
 * it lands at the very end of the invocation, where the remaining budget is smallest — and the
 * derived worst case in the suite is what forced it to be its own number rather than a reuse.
 */
export const SEND_RECONCILE_CLOSE_CEILING_MS = 5_000;

/**
 * How late into an invocation NEW socket work may still start; past this, remaining rows defer as
 * if the login budget were spent — they keep their mirror arm and are first in line next minute.
 * TWELVE, and the number IS the arithmetic: this deadline + the dial bounded by
 * `SEND_RECONCILE_NET_TIMEOUTS` (8 + 8) + the probe ceiling (`SEND_RECONCILE_CALL_CEILING_MS`) +
 * the concurrent teardown (`SEND_RECONCILE_CLOSE_CEILING_MS`) = 53 s inside the platform's 60.
 * The suite DERIVES that sum from the constants and has caught two wrong versions: twenty-five
 * seconds put the total at 61, and a first derivation omitted `socketMs` — the constant most
 * likely to be raised was the one the guard could not see. A normal dial is 1–3 s.
 */
export const SEND_RECONCILE_DIAL_DEADLINE_MS = 12_000;

/**
 * A CEILING BREACH, kept apart from a work rejection. `send-service.ts`'s own `raceCeiling`
 * returns `{timedOut:true}` rather than throwing for the same reason: "did not answer in time"
 * and "refused" are different facts, and a caller that collapses them logs a hung provider and a
 * broken socket identically. This pass needs the distinction for more than a log line: a row
 * whose probe merely RAN OUT OF TIME must never reach the give-up — a mailbox slower than our
 * ceiling is reachable, and closing its reservation `unverified` would be the wrong terminal
 * write for a mailbox that was answering the whole time.
 */
export class SendReconcileCeilingExceeded extends Error {
  constructor(what: string, ceilingMs: number) {
    super(`send-reconcile: ${what} exceeded ${ceilingMs}ms`);
    this.name = "SendReconcileCeilingExceeded";
  }
}

/**
 * Tear an adapter down without waiting — the ONLY safe teardown for a handle whose operation we
 * abandoned. `ImapAdapter.forceClose`'s docblock names this caller's mistake: imapflow serialises
 * commands, so a graceful LOGOUT queues BEHIND the hung command, and a caller awaiting `close`
 * waits exactly as long as the hang it was escaping — this pass did precisely that: a 10-second
 * ceiling followed by an awaited `close()` cost the ceiling PLUS the socket timeout, three times
 * over. An adapter without `forceClose` (a spy) is closed politely but never awaited: the promise
 * is followed only to keep a rejection from going unhandled.
 */
function abandon(adapter: SendAdapter): void {
  // NOTHING HERE MAY THROW, and the two guards are separate hazards rather than belt-and-braces.
  // This is called from the per-row `catch` and from the teardown's `finally`, so a throw would
  // break the "never throws for a per-row fault" contract in the first place and replace the
  // pass's whole result with a 503 in the second. And `Promise.resolve(...)` is what covers an
  // implementation that declared `forceClose(): void` but returns a promise — the seam's `void`
  // return type accepts an `async` body, and this repository already has a
  // `forceClose(): Promise<void>` elsewhere, whose rejection a bare try/catch cannot see.
  try {
    if (adapter.forceClose) {
      void Promise.resolve(adapter.forceClose()).catch(() => { /* going away regardless */ });
      return;
    }
    void adapter.close().catch(() => { /* already broken; nothing to do */ });
  } catch { /* a synchronous throw from either is still a teardown that happened */ }
}

/**
 * Race one operation against a ceiling.
 *
 * The abandoned promise is FOLLOWED — its rejection swallowed — so an operation that fails after
 * we stopped waiting cannot surface as an unhandled rejection. It is not otherwise acted on: the
 * only caller that needed to tear down a late arrival was the dial, and the dial is no longer
 * raced. Whoever holds the handle abandons it; see {@link abandon}.
 */
async function bounded<T>(what: string, work: Promise<T>, ceilingMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendReconcileCeilingExceeded(what, ceilingMs)), ceilingMs);
  });
  try {
    return await Promise.race([work, ceiling]);
  } catch (err) {
    void work.then(
      () => { /* the caller that owns the handle is the one that tears it down */ },
      () => { /* it failed too; nothing to do */ },
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
   * `ScheduledSendPassDeps.accountEligible`'s reasons (cloud-half fact; read on the HANDED
   * handle; absent ⇒ eligible). IT GATES THE DIAL, NOT THE CLAIM: a stranded row is by
   * construction among the OLDEST candidates, so excluding a parked account from the claim would
   * fill the `ORDER BY created_at` window every minute and nothing behind it would be examined.
   * Gating the DIAL keeps the invariant (suspended credentials never open a socket) while the row
   * is examined, counted, and closed by the give-up. The mirror arm still runs — reading our own
   * record of a send that ALREADY happened is not automation.
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
  /** Has the deadline already pre-empted a row this invocation? One log line, not twelve. */
  let preempted = false;

  // ONE real connection per distinct mailbox in the batch, closed once at the end. The wrapper
  // handed to the service reports `close()` as done immediately so the per-row `finally` inside
  // `resolveStale` does not tear down a connection the next row still needs.
  const held = new Map<string, SendAdapter>();
  const shared = new Map<string, SendAdapter>();
  const openOnce: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
    const cached = shared.get(mailboxId);
    if (cached) return cached;
    /**
     * CHARGE THE ATTEMPT, NOT THE SUCCESS — the difference is the whole point of the cap.
     * `makeSendAdapter` connects, which LOGS IN: a rotated password or unreachable host costs a
     * real login and then throws, and charging only success meant those cost NOTHING — `mayDial`
     * is satisfied by `status='connected'` and nothing here demotes a mailbox, so every dialable
     * row of a broken-but-`connected` mailbox attempted a fresh login every minute; another
     * failed LOGIN is how a recoverable fault becomes a locked account. A `TransientDialRefusal`
     * is the one throw that costs nothing — raised BEFORE the wire (the admission counter
     * refusing, or failing to answer). Everything else touched the network and is charged.
     */
    let real: SendAdapter;
    try {
      // NOT raced. `SEND_RECONCILE_NET_TIMEOUTS` bounds this inside the adapter, so a failure
      // here is the mailbox's answer and not ours — which is what lets the give-up act on it.
      real = await deps.openSendAdapter(mailboxId);
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
       * THE DIAL GATE. `connected` is the only status this pass opens a socket on; the two
       * refusals differ: `disabled` — the person disconnected the mailbox; nothing to dial, ever,
       * so the row is decided NOW as `unverified` rather than left to page. `error` — the mailbox
       * is already failing; dialling adds another failed LOGIN to whatever the provider counts,
       * which is how a recoverable error becomes a locked account — so the row waits, and the
       * give-up closes it if the mailbox never returns. An account whose automation is parked is
       * treated exactly as `error`: no socket, wait, give-up still applies (`accountEligible`).
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
      // SAID OUT LOUD, ONCE PER INVOCATION. A claim slow enough to spend the whole deadline
      // would silently disable the IMAP arm for every row — `deferred` rising with no dial ever
      // attempted, which reads exactly like a healthy pass full of undialable mailboxes. That is
      // the ambiguity the settle-failure and give-up-failure lines exist against, and the deadline
      // is now inside the same budget as the claim, so it is reachable the same way.
      if (outOfBudget && lateInTheInvocation && !preempted) {
        preempted = true;
        log.warn("send_reconcile_deadline_preempted", {
          accountId: row.send.accountId, claimed: rows.length, dialled,
        });
      }
      const willDial = mayDial && !outOfBudget;
      const onMiss: "unverified" | "defer" =
        willDial ? "unverified"
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
      // PAST THE DAY, ANY ROW THIS PASS DID NOT DECIDE IS CLOSED — including one it simply never
      // got to. `outOfBudget` used to be excluded, on the reasoning that closing a row we never
      // probed is unfair; a day of never getting to it is not a near miss, it is the same
      // permanent "Sending…" by another route, and the ruling's rule is undecidable-past-24h
      // rather than probed-and-undecided. A `disabled` mailbox is still not a give-up: that one
      // was decided on its first cycle, by evidence.
      let closedByAge = !willDial && row.mailboxStatus !== "disabled" && givingUp;

      let outcome;
      try {
        outcome = await sends.resolveStale(
          ctx, row.send, row.mailboxId, willDial ? openOnce : null, onMiss,
        );
      } catch (err) {
        // The probe threw (a dead socket, a deadline, `ImapBoundExceeded`). The row is UNTOUCHED
        // — a terminal state off a failed connection is the ambiguity this path exists to avoid —
        // unless it is old enough that no cycle is worth waiting for: then the mirror arm gets
        // one last read and the honest ambiguous answer. A WRITE THAT FAILED AFTER THE EVIDENCE
        // WAS IN NEVER GIVES UP, whatever the row's age: the give-up's mirror-only re-resolution
        // would take a probe answer of "the message IS in Sent", throw it away, and record
        // `unverified` terminally. The database is what failed; the next cycle re-probes, and
        // `pending` is exactly what a failed commit should leave. A CEILING BREACH NEVER REACHES
        // THE GIVE-UP: the mailbox was merely slower than our ten seconds — charged a login (the
        // wire was touched), and it waits.
        if (err instanceof SendReconcileCeilingExceeded && !givingUp) {
          // BEFORE the give-up, and only before it. A breach is not evidence about the mailbox,
          // so a fresh row waits — but a row a whole DAY of cycles could not decide is exactly
          // what the give-up is for; exempting it outright strands the draft at "Sending…" for
          // ever with `gaveUp: 0`, charging a login a minute to a mailbox whose Sent SEARCH is
          // simply slower than ten seconds — the state this module exists to end, reintroduced by
          // a rule meant to protect it. THE HANDLE MUST GO FIRST: the abandoned SEARCH still owns
          // imapflow's command queue, so leaving it memoised queues every following row on this
          // mailbox behind a command that can never answer — each burning the full ceiling, none
          // charged a login ("already open"), the socket destroyed only at pass end.
          await forget(row.mailboxId);
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
        // Anything else — including a ceiling breach that has now aged past the give-up: the
        // handle is treated as SUSPECT and dropped. Not because everything
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
    // BOUNDED AND CONCURRENT, and that is arithmetic rather than taste: closing three handles in sequence
    // under a ten-second ceiling each is thirty seconds AFTER all the work, which put the worst
    // case past the platform's sixty and got the loop itself killed — leaving the remaining
    // handles unclosed and their admission slots held, the exact harm the bound exists to avoid.
    await Promise.all([...held.values()].map(async (adapter) => {
      try {
        await bounded("close", adapter.close(), SEND_RECONCILE_CLOSE_CEILING_MS);
      } catch {
        abandon(adapter);
      }
    }));
  }

  return result;
}

/**
 * THE ADAPTER THIS PASS PROBES THROUGH — the one that CANNOT send. `send` throws rather than
 * being omitted: omitting means typing the seam narrower, and the compiler would be the only
 * thing between a future edit and an envelope; a throw survives a cast, and the message names the
 * invariant so the stack trace explains itself. `close` is a no-op ON PURPOSE:
 * `SendService.resolveStale` closes the adapter it was handed in a `finally` — right for a
 * per-request caller, wrong for a batch probing several ids on one connection. The real handle is
 * closed once, by the pass.
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
    // `forceClose` is DELIBERATELY ABSENT, not overlooked. The core seam tells a consumer to fall
    // back to `close` when it is missing, and this wrapper's `close` is a no-op — so forwarding a
    // real teardown here would let `resolveStale` destroy a socket the next row of this batch
    // still needs, while omitting it means a caller that tries falls back to a no-op and tears
    // nothing down. Only the pass may destroy these handles, and it holds the real ones to do it.
  };
}

/**
 * Select the stale reservations this invocation will examine. `FOR UPDATE OF outbound_sends SKIP
 * LOCKED` — `OF` because a bare `FOR UPDATE` over this join would also lock `drafts` and
 * `mailboxes`, and a `mailboxes` row lock is what `finalizeSent`'s doorbell note forbids. The
 * lock is a courtesy: this claim writes nothing, so two pokes can select the same row — but not
 * both write it (the finalizers are compare-and-swap); overlap costs a duplicate probe, never a
 * wrong outcome. NO predicate on `drafts.status`: the subject is the RESERVATION, which must stop
 * paging whatever became of the draft — a hand-recovered draft still leaves a `pending` row.
 * `ORDER BY created_at`, oldest first.
 */
async function claimStale(
  db: Db, now: Date, dialWindow: number, waitWindow: number,
  accountEligible: ((accountId: string, db: Db) => Promise<boolean>) | undefined,
): Promise<StaleRow[]> {
  const d = dialect(db);
  return (db as unknown as Tx).transaction(async (tx) => {
    const staleBefore = new Date(now.getTime() - SEND_STALE_AFTER_MS);
    // SKIP LOCKED through the seam, restricted to the send rows: on the server it is what lets
    // several runners share one window instead of queueing, and on the device store it is the
    // identity for the same reason the lock is — one serialized writer, nothing to skip.
    const page = (dialable: boolean, limit: number) => d.skipLocked(tx.select({
      id: outboundSends.id,
      accountId: outboundSends.accountId,
      idempotencyKey: outboundSends.idempotencyKey,
      draftId: outboundSends.draftId,
      mintedMessageId: outboundSends.mintedMessageId,
      providerMessageId: outboundSends.providerMessageId,
      status: outboundSends.status,
      sentAt: outboundSends.sentAt,
      createdAt: outboundSends.createdAt,
      // Mail 0095 — projected so the `StaleRow` literal below stays the row's full shape. Both
      // are NULL on everything this pass sees: it selects `pending` rows only, and a resolution
      // is by definition a terminal outcome.
      resolvedBy: outboundSends.resolvedBy,
      resolvedAt: outboundSends.resolvedAt,
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
      .limit(limit), { of: outboundSends });

    /**
     * TWO WINDOWS, because a mailbox in `error` can never be resolved by dialling and would
     * monopolise the one window: its rows defer every cycle and, oldest by construction, are
     * re-selected every minute — one `error` mailbox with a dozen strandings would fill an
     * oldest-first window for a day. Their OWN window removes that structurally: they still get
     * the MIRROR arm and the give-up still closes them. SAME SIZE as the dialable window — sized
     * off the examination factor, since these rows are never dialled. The residual, stated: a
     * SUSPENDED account's rows sit in the dialable window (suspension is the injected gate, not a
     * column), so one parked account can still delay newer rows; bounded, not removed.
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
          // Mail 0095. Carried so this literal stays the row's full shape; the pass reads its
          // rows through `INNER JOIN drafts` and only ever handles `pending`, so neither field
          // is ever set on anything it sees.
          resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt,
        },
        mailboxId: r.mailboxId,
        mailboxStatus: r.mailboxStatus,
        eligible: await eligible(r.accountId),
      });
    }
    return rows;
  });
}
