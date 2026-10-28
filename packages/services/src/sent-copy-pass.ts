import { and, asc, count, desc, eq, gt, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { mailboxes, outboundSentCopies } from "@trafficflow/db";
import { createLogger, type Logger, type OpenSendAdapter, type SendAdapter } from "@trafficflow/core/mail";
import { bridgeDb, bridgeTx, type Db, type ServiceContext } from "./context.js";
import { ServiceError, TransientDialRefusal } from "./errors.js";
import { SEND_RECONCILE_BATCH, SEND_RECONCILE_CLOSE_CEILING_MS } from "./send-reconcile-pass.js";
import {
  fileOnly, mailServerUnreachable, ownAttempts, sendService, SEND_COPY_OWED_CLAIM_MS, SEND_COPY_OWED_DEFER_MS,
  SEND_COPY_OWED_HOLD_MS, SEND_COPY_OWED_MAILBOX_UNIT, type OwedCopyFiling, type SendDeps, type SendService,
} from "./send-service.js";

/**
 * THE SERVER'S LATE PASS FOR OWED SENT COPIES — a delivered send whose copy did not reach Sent
 * inside its request (a restart, a deploy, an IMAP outage) is filed here, from the bytes the send
 * door recorded (`OwedCopyPolicy`). Cloud runs it on the API host, poked by the worker's clock
 * (`/internal/sends/sent-copies/run`); self-host runs it in-process on the send clock. Each row is
 * filed by `SendService.fileOwedCopy`, the step the desktop's drain runs: only for a send recorded
 * `sent`, looking in Sent first, deleted once there. NOTHING HERE SUBMITS MAIL: the connection is
 * `fileOnly`. Exactly once: the claim takes due rows `FOR UPDATE SKIP LOCKED` and leases them
 * ({@link SEND_COPY_OWED_CLAIM_MS}), and a copy this process is still filing is left alone.
 *
 * WHOSE A REFUSAL IS, AND HOW LONG THE MAILBOX WAITS, are two things. A refused filing is the copy's
 * own only when the server names the copy ({@link copyRefusedForItself}) or its mailbox took another
 * copy in this pass (after a refusal one is tried at once, the newest first: {@link probe}); only
 * that costs the copy one of its attempts. Anything else is its mailbox's — a refused dial or
 * sign-in, a dead connection, a ceiling breach, a second copy refused too, no other copy to try, or
 * no time to try one — and costs no attempt: every owed copy of the mailbox waits for one next try
 * on its ladder ({@link SENT_COPY_MAILBOX_WAITS_MS}), and a filed copy starts the ladder over. A copy
 * tried takes its turn ({@link takeTurn}), and copies due together are taken least recently tried
 * first, so one whose refusal could not be told never stands in front of the others again. Every
 * copy, whatever its refusals, is deleted {@link SEND_COPY_OWED_HOLD_MS} after it was recorded, or at
 * the next pass when one is filing it then.
 */

/** Due rows one pass takes; at most {@link SEND_RECONCILE_BATCH} logins serve them. */
export const SENT_COPY_PASS_WINDOW = 8;

/** The mailbox's ladder: its wait after the 1st, 2nd, … refusal of every copy in a row; the last repeats. */
export const SENT_COPY_MAILBOX_WAITS_MS: readonly number[] = [60_000, 600_000, 3_600_000, 21_600_000, 86_400_000];

/**
 * However far its ladder has climbed, a mailbox's wait ends this long before its soonest copy's hold
 * does: its copies are tried again then, in turn.
 */
export const SEND_COPY_OWED_LAST_TRY_MS = 60 * 60 * 1000;

/** A mailbox's run of refusals is kept below this, in `attempts`' hundreds; the ladder's last step repeats long before. */
const RUNS = 100;
/** Above the run, in multiples of this, `attempts` carries the copy's turn ({@link takeTurn}); 0 is never tried. */
export const SENT_COPY_TURN_UNIT = SEND_COPY_OWED_MAILBOX_UNIT * RUNS;
/** The highest turn the 32-bit column holds beside the other counts; past it a mailbox's turns are numbered again. */
export const SENT_COPY_TURN_MAX = Math.floor(2 ** 31 / SENT_COPY_TURN_UNIT) - 1;
const runOf = (attempts: number): number => Math.floor(attempts / SEND_COPY_OWED_MAILBOX_UNIT) % RUNS;
const turnOf = (attempts: number): number => Math.floor(attempts / SENT_COPY_TURN_UNIT);

/**
 * IMAP's answers about the message rather than its mailbox: too big (RFC 7889 `TOOBIG`, and
 * imapflow's own `APPENDLIMIT` check before it sends), or not a message the server can parse (`PARSE`).
 */
const COPY_REFUSAL_CODES: ReadonlySet<string> = new Set(["TOOBIG", "APPENDLIMIT", "PARSE"]);

/** Did the server refuse this copy for itself, not its mailbox? By the response code, never the text. */
export function copyRefusedForItself(err: unknown): boolean {
  const said = (err as { serverResponseCode?: unknown } | null)?.serverResponseCode;
  return typeof said === "string" && COPY_REFUSAL_CODES.has(said.toUpperCase());
}

/** One look plus one APPEND of a letter without files, on a host the platform ends at 60 s. */
export const SEND_COPY_OWED_CALL_CEILING_MS = 15_000;

/**
 * The same bound on a host nothing ends (self-host): a whole letter with files on a slow uplink,
 * still bounded so a trickling server cannot park the send clock behind it.
 */
export const SEND_COPY_OWED_HOST_CALL_CEILING_MS = 5 * 60 * 1000;

/**
 * With a budget, no new socket work starts past this. The sum the suite derives: this + the dial
 * (`SEND_RECONCILE_NET_TIMEOUTS`: connect, greeting, socket) + {@link SEND_COPY_OWED_CALL_CEILING_MS}
 * + the concurrent close (`SEND_RECONCILE_CLOSE_CEILING_MS`) = 56 s inside the platform's 60.
 */
export const SEND_COPY_OWED_DIAL_DEADLINE_MS = 10_000;

export interface OwedSentCopyPassDeps {
  /** The send transport — admitted on Cloud, `makeSendAdapter` with the reconciler's deadlines on self-host. */
  openSendAdapter: OpenSendAdapter;
  /** The projection's storage cap, as on the send door. */
  resolveStorageCap: NonNullable<SendDeps["resolveStorageCap"]>;
  /** The wall's gate, read on the claim transaction's handle; absent ⇒ every account may dial. */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
  /** The invocation's platform ceiling; absent on a host nothing ends. */
  budgetMs?: number;
  log?: Logger;
  now?: () => Date;
  /** Test seams. */
  sends?: SendService;
  batch?: number;
}

export interface OwedSentCopyPassResult {
  /** Due rows this pass took. */
  claimed: number;
  filed: number;
  /** Deleted without a dial: past the hold, the mailbox disabled or gone, or the send not `sent`. */
  dropped: number;
  /** A refused filing that waits its turn: its own wait, or its mailbox's ladder. */
  failed: number;
  /** Mailboxes put on their ladder: a refusal told the mailbox's, or a refused dial. */
  onLadder: number;
  /** Left for a later pass: no login left, past the deadline, a parked account, an unreachable dial,
   *  or its mailbox waiting. */
  deferred: number;
  /** Given up at its `SEND_COPY_OWED_MAX_ATTEMPTS`th refusal of its own. */
  gaveUp: number;
  /** Owed copies still recorded after this pass, every account. */
  remaining: number;
}

const defaultLog = createLogger({ service: "sent-copy-pass" });

class SentCopyCeilingExceeded extends Error {
  readonly code = "ETIMEDOUT";
  constructor(what: string, ms: number) {
    super(`sent-copy-pass: ${what} exceeded ${ms}ms`);
    this.name = "SentCopyCeilingExceeded";
  }
}

async function bounded<T>(what: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SentCopyCeilingExceeded(what, ms)), ms);
  });
  try {
    return await Promise.race([work, ceiling]);
  } catch (err) {
    void work.then(() => undefined, () => undefined);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Tear a handle down without waiting on what it is running. Never throws. */
function abandon(a: SendAdapter): void {
  try {
    if (a.forceClose) void Promise.resolve(a.forceClose()).catch(() => undefined);
    else void a.close().catch(() => undefined);
  } catch { /* going away regardless */ }
}

interface DueRow { sendId: string; accountId: string; mailboxId: string; attempts: number; createdAt: Date; eligible: boolean }

/** The better copy to tell a refusal by: the fewest refusals of its own, then the newest. */
function triesFirst(a: DueRow, b: DueRow): number {
  return ownAttempts(a.attempts) - ownAttempts(b.attempts) || b.createdAt.getTime() - a.createdAt.getTime();
}

/** One bounded pass. Never throws for a per-row fault; a claim fault propagates (the route's 503). */
export async function runOwedSentCopyPass(db: Db, deps: OwedSentCopyPassDeps): Promise<OwedSentCopyPassResult> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? ((): Date => new Date());
  const sends = deps.sends ?? sendService;
  const batch = deps.batch ?? SEND_RECONCILE_BATCH;
  const out: OwedSentCopyPassResult = { claimed: 0, filed: 0, dropped: 0, failed: 0, onLadder: 0, deferred: 0, gaveUp: 0, remaining: 0 };
  const startedAt = now().getTime();
  const ceilingMs = deps.budgetMs === undefined ? SEND_COPY_OWED_HOST_CALL_CEILING_MS : SEND_COPY_OWED_CALL_CEILING_MS;

  const rows = await claimOwed(db, now(), deps.accountEligible, sends, log, out);
  out.claimed = rows.length;
  /** The copies this pass leased (send → mailbox), in the order it took them; a charged one keeps its own wait. */
  const leased = new Map<string, string>();
  for (const r of rows) if (r.eligible) leased.set(r.sendId, r.mailboxId);

  const held = new Map<string, SendAdapter>();
  const shared = new Map<string, SendAdapter>();
  /** Mailboxes this pass stops on: waiting on their ladder, an admission refusal, a fault. */
  const done = new Set<string>();
  /** Mailboxes that took a copy in this pass: a later refusal there is that copy's own. */
  const proven = new Set<string>();
  /** Connections that overran a ceiling: the breach still owns the command queue. */
  const breached = new Set<string>();
  const tried = new Set<string>();
  let dialled = 0;
  /** No new socket work: past the deadline, or no login left for a mailbox without a connection. */
  const noRoom = (mailboxId: string): boolean =>
    (deps.budgetMs !== undefined && now().getTime() - startedAt >= SEND_COPY_OWED_DIAL_DEADLINE_MS)
    || (!shared.has(mailboxId) && dialled >= batch);
  const forget = (mailboxId: string): void => {
    const real = held.get(mailboxId);
    held.delete(mailboxId);
    shared.delete(mailboxId);
    breached.delete(mailboxId);
    if (real) abandon(real);
  };
  /** A connection that overran a ceiling, or is gone, carries no further filing: the next one dials. */
  const forgetIfSpent = (mailboxId: string): void => {
    if (breached.has(mailboxId) || held.get(mailboxId)?.isLive?.() === false) forget(mailboxId);
  };
  const contextOf = (row: DueRow): ServiceContext => (
    { db, accountId: row.accountId, userId: null, now, requestId: `sent-copy:${row.sendId}` }
  );
  /** One row's filing; null when it is left for a later pass with no verdict (parked, late, no login left, a fault). */
  const fileRow = async (row: DueRow): Promise<(OwedCopyFiling & { admissionRefused: boolean }) | null> => {
    tried.add(row.sendId);
    if (!row.eligible || done.has(row.mailboxId) || noRoom(row.mailboxId)) { out.deferred += 1; return null; }
    let admissionRefused = false;
    const watched = <T>(what: string, work: Promise<T>): Promise<T> => bounded(what, work, ceilingMs).catch((err: unknown) => {
      if (err instanceof SentCopyCeilingExceeded) breached.add(row.mailboxId);
      throw err;
    });
    const connect = async (): Promise<SendAdapter> => {
      const open = shared.get(row.mailboxId);
      if (open) return open;
      let real: SendAdapter;
      try {
        real = await deps.openSendAdapter(row.mailboxId);
      } catch (err) {
        admissionRefused = err instanceof TransientDialRefusal;
        // Refused before the wire (admission, no credentials): no login spent.
        if (!admissionRefused && !(err instanceof ServiceError)) dialled += 1;
        throw err;
      }
      dialled += 1;
      held.set(row.mailboxId, real);
      const wrapped = fileOnly({
        send: real.send.bind(real),
        messageInSent: (id) => watched("look", real.messageInSent(id)),
        ...(real.fileSentCopy
          ? { fileSentCopy: (raw: Buffer, id: string, o?: { look?: boolean }) => watched("filing", real.fileSentCopy!(raw, id, o)) }
          : {}),
        close: async () => { /* held for the pass; closed once at its end */ },
      });
      shared.set(row.mailboxId, wrapped);
      return wrapped;
    };
    try {
      const filing = await sends.fileOwedCopy(contextOf(row), row, connect, { resolveStorageCap: deps.resolveStorageCap, log });
      if (filing.step === "filed") {
        out.filed += 1;
        if (!proven.has(row.mailboxId)) {
          proven.add(row.mailboxId);
          await startLadderOver(db, row).catch((err: unknown) => {
            log.error("send_sent_copy_pass_hold_failed", { accountId: row.accountId, mailboxId: row.mailboxId, err });
          });
        }
      } else if (filing.step === "dropped") out.dropped += 1;
      else if (filing.step === "skipped") out.deferred += 1;
      // Refused, or its mailbox not reached: tried. A host-wide admission refusal tried nothing.
      else if (filing.step === "refused" || !admissionRefused) {
        await takeTurn(db, row).catch((err: unknown) => {
          log.error("send_sent_copy_pass_turn_failed", { accountId: row.accountId, sendId: row.sendId, err });
        });
      }
      return { ...filing, admissionRefused };
    } catch (err) {
      out.deferred += 1;
      forget(row.mailboxId);
      done.add(row.mailboxId);
      log.error("send_sent_copy_pass_row_failed", { accountId: row.accountId, sendId: row.sendId, err });
      return null;
    }
  };
  /** The copy's own refusal: one of its attempts, then its own wait (or, the last, given up). */
  const charge = async (row: DueRow, err: unknown): Promise<void> => {
    try {
      if (await sends.chargeOwedCopy(contextOf(row), row, err, { log }) === "gaveUp") out.gaveUp += 1;
      else out.failed += 1;
      leased.delete(row.sendId);
    } catch (fault) {
      out.deferred += 1;
      log.error("send_sent_copy_pass_row_failed", { accountId: row.accountId, sendId: row.sendId, err: fault });
    }
  };
  /** The mailbox's: no attempt spent, and every owed copy of it waits on its ladder. */
  const hold = async (row: DueRow): Promise<void> => {
    forget(row.mailboxId);
    done.add(row.mailboxId);
    out.onLadder += 1;
    // This pass's own leases on the mailbox: released to the wait, whenever they would end.
    const mine = [row.sendId, ...[...leased.keys()].filter((id) => leased.get(id) === row.mailboxId && id !== row.sendId)];
    try {
      const wait = await waitOnLadder(db, row, now(), mine);
      if (wait) {
        log.warn("send_sent_copy_mailbox_waits", {
          accountId: row.accountId, mailboxId: row.mailboxId, run: wait.run, until: wait.until.toISOString(),
        });
      }
    } catch (err) {
      log.error("send_sent_copy_pass_hold_failed", { accountId: row.accountId, mailboxId: row.mailboxId, err });
    }
  };
  /**
   * The next copy to tell a refusal by: of this mailbox's due copies, from this claim or claimed for
   * it now, the one with the fewest refusals of its own, the newest first.
   */
  const nextToTry = async (failed: DueRow): Promise<DueRow | null> => {
    const here = rows.filter((r) => !tried.has(r.sendId) && r.eligible
      && r.mailboxId === failed.mailboxId && r.accountId === failed.accountId).sort(triesFirst)[0] ?? null;
    const more = await claimToTell(db, failed, now(), tried, here, sends);
    if (more !== null) {
      out.claimed += 1;
      leased.set(more.sendId, more.mailboxId);
    }
    return more ?? here;
  };
  /**
   * WHOSE REFUSAL: another copy of the mailbox is filed at once ({@link nextToTry}). Taken, the
   * refusal was the copy's own (true). Refused too, not started in time or without a login, or no
   * other copy due: the mailbox's (false). A copy the server refuses for itself tells nothing; the
   * next. One whose connection was gone before it was answered is tried again on one more dial. A
   * pass files at most one more window of copies this way.
   */
  const probe = async (failed: DueRow): Promise<boolean> => {
    let dialledAgain = false;
    let again: DueRow | null = null;
    for (;;) {
      const spent = tried.size >= 2 * SENT_COPY_PASS_WINDOW || (dialledAgain && !shared.has(failed.mailboxId));
      if (spent || noRoom(failed.mailboxId)) {
        if (again !== null) out.deferred += 1;
        return false;
      }
      if (!shared.has(failed.mailboxId)) dialledAgain = true;
      const other: DueRow | null = again ?? await nextToTry(failed);
      again = null;
      if (other === null) return false;
      const res = await fileRow(other);
      if (res === null) return false;
      if (res.step === "filed") return true;
      if (res.step === "dropped" || res.step === "skipped") continue;
      if (res.step === "unreachable") { out.deferred += 1; return false; }
      forgetIfSpent(failed.mailboxId);
      if (copyRefusedForItself(res.err)) { await charge(other, res.err); continue; }
      if (mailServerUnreachable(res.err)) { forget(failed.mailboxId); again = other; continue; }
      out.failed += 1;
      return false;
    }
  };
  try {
    for (const row of rows) {
      if (tried.has(row.sendId)) continue;
      const res = await fileRow(row);
      if (res === null || res.step === "filed" || res.step === "dropped" || res.step === "skipped") continue;
      if (res.step === "unreachable") {
        out.deferred += 1;
        // A host-wide admission refusal is no fault of this mailbox: the lease alone.
        if (res.admissionRefused) { forget(row.mailboxId); done.add(row.mailboxId); }
        else await hold(row);
        continue;
      }
      forgetIfSpent(row.mailboxId);
      if (copyRefusedForItself(res.err) || proven.has(row.mailboxId) || await probe(row)) {
        await charge(row, res.err);
        continue;
      }
      out.failed += 1;
      await hold(row);
    }
  } finally {
    await Promise.all([...held.values()].map(async (a) => {
      try {
        await bounded("close", a.close(), SEND_RECONCILE_CLOSE_CEILING_MS);
      } catch {
        // A close that will not settle is abandoned, so its admission slot comes back.
        abandon(a);
      }
    }));
  }

  // scoped-by: a count over every account for the scheduler's health row; no row's content leaves
  const [left] = await db.select({ n: count() }).from(outboundSentCopies).where(eq(outboundSentCopies.seq, 0));
  out.remaining = Number(left?.n ?? 0);
  return out;
}

const UNIT = sql.raw(String(SEND_COPY_OWED_MAILBOX_UNIT));
const RUN_SPAN = sql.raw(String(RUNS));
const TURN = sql.raw(String(SENT_COPY_TURN_UNIT));
/** `attempts` without its run of refusals: the copy's own attempts and its turn. */
const NO_RUN = sql`${outboundSentCopies.attempts} - ${UNIT} * ((${outboundSentCopies.attempts} / ${UNIT}) % ${RUN_SPAN})`;

/**
 * A MAILBOX WAITS AS ONE: every owed copy of it, the refused ones too, is next due at one moment,
 * the step of its ladder ({@link SENT_COPY_MAILBOX_WAITS_MS}) its oldest copy's run of refusals has
 * reached, and never past the soonest copy's last try ({@link SEND_COPY_OWED_LAST_TRY_MS}). The run
 * grows by one on every copy; no copy's own attempts or turn change. A copy is only ever moved later
 * (another pass's lease, a door's settle and a copy's own wait stand), but for this pass's own leases,
 * `mine`, released to it. Null when the mailbox owes nothing.
 */
async function waitOnLadder(db: Db, row: DueRow, at: Date, mine: readonly string[]): Promise<{ run: number; until: Date } | null> {
  // Piece 0 of every owed copy of the mailbox carries `attempts` and `next_attempt_at`.
  const owed = await db.select({ attempts: outboundSentCopies.attempts, createdAt: outboundSentCopies.createdAt })
    .from(outboundSentCopies)
    .where(and(
      eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.mailboxId, row.mailboxId), eq(outboundSentCopies.seq, 0),
    ))
    .orderBy(asc(outboundSentCopies.createdAt));
  if (owed.length === 0) return null;
  const run = Math.min(runOf(owed[0]!.attempts) + 1, RUNS - 1);
  const t = at.getTime();
  const step = SENT_COPY_MAILBOX_WAITS_MS[Math.min(run, SENT_COPY_MAILBOX_WAITS_MS.length) - 1]!;
  const lastTry = owed.map((r) => r.createdAt.getTime() + SEND_COPY_OWED_HOLD_MS - SEND_COPY_OWED_LAST_TRY_MS)
    .find((x) => x > t);
  const until = new Date(Math.max(t + SENT_COPY_MAILBOX_WAITS_MS[0]!, Math.min(t + step, lastTry ?? Infinity)));
  await bridgeTx(db).transaction(async (tx) => {
    await tx.update(outboundSentCopies)
      .set({ attempts: sql`${NO_RUN} + ${UNIT} * ${run}` })
      .where(and(
        eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.mailboxId, row.mailboxId), eq(outboundSentCopies.seq, 0),
      ));
    await tx.update(outboundSentCopies)
      .set({ nextAttemptAt: until })
      .where(and(
        eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.mailboxId, row.mailboxId), eq(outboundSentCopies.seq, 0),
        lt(outboundSentCopies.nextAttemptAt, until),
      ));
    for (const sendId of mine) {
      await tx.update(outboundSentCopies)
        .set({ nextAttemptAt: until })
        .where(and(
          eq(outboundSentCopies.sendId, sendId), eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.seq, 0),
        ));
    }
  });
  return { run, until };
}

/** A FILED COPY STARTS ITS MAILBOX'S LADDER OVER: no copy of it carries a run of refusals any more. */
async function startLadderOver(db: Db, row: DueRow): Promise<void> {
  await db.update(outboundSentCopies)
    .set({ attempts: NO_RUN })
    .where(and(
      eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.mailboxId, row.mailboxId), eq(outboundSentCopies.seq, 0),
      sql`${outboundSentCopies.attempts} % ${TURN} >= ${UNIT}`,
    ));
}

/**
 * A TRIED COPY TAKES ITS TURN: one past every turn of its mailbox's copies, so a claim takes the
 * copies due together least recently tried first, one never tried (turn 0) before any. Written each
 * time the copy is tried: refused, or its mailbox not reached. The table has no column for when a
 * copy was last tried, and its lease is `next_attempt_at`, which a wait moves on, so the turn is kept
 * in `attempts` ({@link SENT_COPY_TURN_UNIT}). At {@link SENT_COPY_TURN_MAX} the mailbox's turns are
 * numbered again from 1, in their order.
 */
async function takeTurn(db: Db, row: DueRow): Promise<void> {
  await bridgeTx(db).transaction(async (tx) => {
    const owed = await tx.select({ sendId: outboundSentCopies.sendId, attempts: outboundSentCopies.attempts })
      .from(outboundSentCopies)
      .where(and(
        eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.mailboxId, row.mailboxId), eq(outboundSentCopies.seq, 0),
      ));
    let top = owed.reduce((n, r) => Math.max(n, turnOf(r.attempts)), 0);
    if (top >= SENT_COPY_TURN_MAX) {
      const turns = [...new Set(owed.map((r) => turnOf(r.attempts)).filter((n) => n > 0))].sort((a, b) => a - b);
      const renumbered = new Map(turns.map((n, i) => [n, i + 1]));
      for (const r of owed) {
        if (turnOf(r.attempts) === 0) continue;
        await tx.update(outboundSentCopies)
          .set({ attempts: sql`${outboundSentCopies.attempts} % ${TURN} + ${TURN} * ${renumbered.get(turnOf(r.attempts))!}` })
          .where(and(
            eq(outboundSentCopies.sendId, r.sendId), eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.seq, 0),
          ));
      }
      top = turns.length;
    }
    await tx.update(outboundSentCopies)
      .set({ attempts: sql`${outboundSentCopies.attempts} % ${TURN} + ${TURN} * ${top + 1}` })
      .where(and(
        eq(outboundSentCopies.sendId, row.sendId), eq(outboundSentCopies.accountId, row.accountId), eq(outboundSentCopies.seq, 0),
      ));
  });
}

/**
 * A due copy of the refused row's mailbox beyond this pass's claim, the fewest refusals of its own
 * and the newest first, claimed and leased in one short transaction when it tells better than
 * `here` (the claim's own). A copy this process is still filing is passed over.
 */
async function claimToTell(
  db: Db, failed: DueRow, at: Date, tried: ReadonlySet<string>, here: DueRow | null, sends: SendService,
): Promise<DueRow | null> {
  const d = dialect(db);
  return bridgeTx(db).transaction(async (tx) => {
    const found = await d.skipLocked(tx.select({
      sendId: outboundSentCopies.sendId, accountId: outboundSentCopies.accountId, mailboxId: outboundSentCopies.mailboxId,
      attempts: outboundSentCopies.attempts, createdAt: outboundSentCopies.createdAt,
    })
      .from(outboundSentCopies)
      .where(and(
        eq(outboundSentCopies.accountId, failed.accountId), eq(outboundSentCopies.mailboxId, failed.mailboxId),
        eq(outboundSentCopies.seq, 0), lte(outboundSentCopies.nextAttemptAt, at), notInArray(outboundSentCopies.sendId, [...tried]),
      ))
      .orderBy(asc(sql`${outboundSentCopies.attempts} % ${UNIT}`), desc(outboundSentCopies.createdAt))
      .limit(4), { of: outboundSentCopies });
    const r = found.find((f) => !sends.filingCopy(f.sendId));
    if (r === undefined) return null;
    const candidate: DueRow = { ...r, eligible: true };
    if (here !== null && triesFirst(here, candidate) <= 0) return null;
    await tx.update(outboundSentCopies)
      .set({ nextAttemptAt: new Date(at.getTime() + SEND_COPY_OWED_CLAIM_MS) })
      .where(and(
        eq(outboundSentCopies.sendId, r.sendId), eq(outboundSentCopies.accountId, r.accountId), eq(outboundSentCopies.seq, 0),
      ));
    return candidate;
  });
}

/**
 * Take this pass's rows in one short transaction. The drop window deletes, without a dial, a row
 * past {@link SEND_COPY_OWED_HOLD_MS}, due or not, unless it is due within a lease from now (another
 * pass may be filing it: the next pass deletes it), and a due row on a `disabled` or missing
 * mailbox. The dial window takes due rows on a `connected`, unstamped mailbox, the longest due first,
 * of those due together the least recently tried ({@link takeTurn}), then the oldest, `FOR UPDATE OF
 * outbound_sent_copies SKIP LOCKED`, and leases them: {@link SEND_COPY_OWED_CLAIM_MS} while they are
 * filed, {@link SEND_COPY_OWED_DEFER_MS} for an account that may not dial. A mailbox in `error` is
 * not dialled; the hold reaches its rows.
 */
async function claimOwed(
  db: Db, at: Date, accountEligible: OwedSentCopyPassDeps["accountEligible"], sends: SendService, log: Logger,
  out: OwedSentCopyPassResult,
): Promise<DueRow[]> {
  const d = dialect(db);
  return bridgeTx(db).transaction(async (tx) => {
    const holdFrom = new Date(at.getTime() - SEND_COPY_OWED_HOLD_MS);
    const leaseEnd = new Date(at.getTime() + SEND_COPY_OWED_CLAIM_MS);
    const onItsMailbox = and(
      eq(mailboxes.id, outboundSentCopies.mailboxId), eq(mailboxes.accountId, outboundSentCopies.accountId),
    );
    const doomed = await d.skipLocked(tx.select({
      sendId: outboundSentCopies.sendId, accountId: outboundSentCopies.accountId, mailboxId: outboundSentCopies.mailboxId,
      createdAt: outboundSentCopies.createdAt, status: mailboxes.status, present: mailboxes.id,
    })
      .from(outboundSentCopies)
      .leftJoin(mailboxes, onItsMailbox)
      .where(and(
        eq(outboundSentCopies.seq, 0),
        // Past the hold whenever its mailbox's ladder would next try it (the bound is the hold), but never under a live lease.
        or(and(
          lt(outboundSentCopies.createdAt, holdFrom),
          or(lte(outboundSentCopies.nextAttemptAt, at), gt(outboundSentCopies.nextAttemptAt, leaseEnd)),
        ), and(
          lte(outboundSentCopies.nextAttemptAt, at), or(eq(mailboxes.status, "disabled"), isNull(mailboxes.id)),
        )),
      ))
      .orderBy(asc(outboundSentCopies.createdAt))
      .limit(SENT_COPY_PASS_WINDOW * 4), { of: outboundSentCopies });
    for (const r of doomed) {
      await tx.delete(outboundSentCopies)
        .where(and(eq(outboundSentCopies.sendId, r.sendId), eq(outboundSentCopies.accountId, r.accountId)));
      const reason = r.present === null ? "mailbox_gone" : r.status === "disabled" ? "mailbox_disabled" : "held_too_long";
      log.warn("send_sent_copy_missing", { accountId: r.accountId, sendId: r.sendId, mailboxId: r.mailboxId, reason });
      out.dropped += 1;
    }

    const due = await d.skipLocked(tx.select({
      sendId: outboundSentCopies.sendId, accountId: outboundSentCopies.accountId,
      mailboxId: outboundSentCopies.mailboxId, attempts: outboundSentCopies.attempts, createdAt: outboundSentCopies.createdAt,
    })
      .from(outboundSentCopies)
      .innerJoin(mailboxes, onItsMailbox)
      .where(and(
        eq(outboundSentCopies.seq, 0), lte(outboundSentCopies.nextAttemptAt, at),
        eq(mailboxes.status, "connected"), isNull(mailboxes.erasedAt),
      ))
      .orderBy(
        asc(outboundSentCopies.nextAttemptAt), asc(sql`${outboundSentCopies.attempts} / ${TURN}`), asc(outboundSentCopies.createdAt),
      )
      .limit(SENT_COPY_PASS_WINDOW), { of: outboundSentCopies });

    const verdicts = new Map<string, boolean>();
    const rows: DueRow[] = [];
    for (const r of due) {
      // The send request still filing it in this process owns it.
      if (sends.filingCopy(r.sendId)) continue;
      let eligible = verdicts.get(r.accountId);
      if (eligible === undefined) {
        eligible = accountEligible ? await accountEligible(r.accountId, bridgeDb(tx)) : true;
        verdicts.set(r.accountId, eligible);
      }
      const lease = eligible ? SEND_COPY_OWED_CLAIM_MS : SEND_COPY_OWED_DEFER_MS;
      await tx.update(outboundSentCopies)
        .set({ nextAttemptAt: new Date(at.getTime() + lease) })
        .where(and(
          eq(outboundSentCopies.sendId, r.sendId), eq(outboundSentCopies.accountId, r.accountId), eq(outboundSentCopies.seq, 0),
        ));
      rows.push({ ...r, eligible });
    }
    return rows;
  });
}
