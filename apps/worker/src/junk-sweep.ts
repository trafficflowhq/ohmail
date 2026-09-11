/**
 * THE ONE-TIME QUARANTINE→\Junk SWEEP — explicitly invoked, never scheduled, dry-run by default. The
 * 2026-08-22 amendment sends NEW spam verdicts to the provider's native `\Junk` (`junk-filing.ts`); mail
 * already in `ohmail/Quarantine` stays until moved, and this pass is that mover — invoked once per mailbox
 * by an operator (`run-junk-sweep.ts`) with the account owner's standing spam verdicts as its authority. NOT
 * SCHEDULED and never must be: a recurring pass would be the organizer acting on its own initiative. Two
 * explicit callers: the operator runner, and the worker cycle's sweep-command consumption (`sync.ts`) once
 * per recorded press (`mailboxes.junk_sweep_requested_at`, mail 0076, `POST /screener/junk/sweep`) —
 * §16.1's carve-out. Same claims discipline as the live path: `completeFiling` runs only for members the
 * server named, so a vanished member (`gone`) is left for `changesSince` and nothing is husked in error. */

import { and, eq, gt, inArray } from "drizzle-orm";
import { folderState, junkSweepCandidateWhere, messages, type Tx } from "@trafficflow/db";
import {
  FILING_BATCH_MAX, MessageGoneError, type MailboxAdapter, type MoveManyResult,
} from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import type { WorkerRepo, PendingFolderState } from "@trafficflow/core/adapters/drizzle-repo";
import { completeFiling, SPAM_PILE, type SpecialFolderMap } from "./junk-filing.js";
import { assertMayWriteToMailbox, type MailboxWriteAuthority } from "./lease.js";

/**
 * THE SCAN'S STATE ACROSS CYCLES — a pure decision, extracted so it can be pinned by test (a fully
 * refused pile larger than one window never reported `examinedAll`, because the tail window had not
 * "started at the top"; the stamp then stood for ever and the mailbox re-kicked the same refusals every
 * cycle). One window per cycle: the cursor advances while a scan is unfinished (a window that moved keeps
 * advancing, its refusals shrinking as later scans revisit them) and resets to the top when it runs off
 * the end. `examinedAll` is true precisely when a WHOLE scan moved nothing — the one reading that licenses
 * the cycle to retire the command over a non-empty pile.
 */
export interface SweepScanState {
  /**
   * WHICH PRESS this state describes — the observed `junk_sweep_requested_at` token, or null before any
   * press has been seen. The cursor, the moved-since-top flag and the deferral allowance are all progress
   * through ONE command, and keyed to nothing they outlived it: a command that spent its allowance and
   * retired left the counter at its ceiling on a live attachment, so the person's NEXT press inherited a
   * spent allowance and its first barren scan retired it on the spot. A re-stamp mid-scan inherited the
   * previous cursor for the same reason. {@link sweepStateForPress} is the reset — a named function, not
   * an `if` at the call site, so it can be tested.
   */
  command: string | null;
  /** The last examined id, or null for "the next window starts at the top". */
  after: string | null;
  /** Whether the scan IN PROGRESS (since the last top) has moved anything. */
  movedSinceTop: boolean;
  /**
   * Whether the scan IN PROGRESS has deferred anything — a member skipped because its source locator was
   * stale rather than because the server refused it. Per SCAN, exactly like {@link movedSinceTop}, and for
   * the same reason: a deferral in an early window is a fact about the whole scan (the cursor moves past
   * that message), so the FINAL window can honestly report zero deferrals while the deferred row still
   * sits in the pile — and reading only the last window's count retired the command over exactly the mail
   * the deferral was protecting. Found by review, not test: the existing cases all fit inside one window.
   */
  deferredSinceTop: boolean;
  /**
   * How many CONSECUTIVE completed scans have been kept alive by deferrals alone — the termination bound;
   * without it the exemption is unbounded. A recreated folder can leave a stale locator on a row the
   * candidate predicate still admits while the old-epoch delete is never enumerated, so `remaining()` never
   * reaches zero and every scan defers the same row (re-kicking the mailbox for ever). So the exemption
   * holds for {@link SWEEP_MAX_DEFERRED_SCANS} completed scans and then stops — the same shape as the
   * sensitivity repair's bounded re-walks. It is PROCESS-LOCAL: a restart/reconnect/roster re-add resets it
   * to zero, so it bounds how long ONE attachment holds a press open, not the press's life (a durable
   * per-press column beside `junk_sweep_requested_at` is its own slice). Any scan that MOVES something
   * resets the counter — correct, because a draining pile has not stalled. */
  deferredScans: number;
}

/**
 * How many completed scans may be kept alive by deferrals alone before the command retires anyway.
 *
 * Three, matching the bounded re-walks next door. One is too few — a deferral's whole premise is
 * that the NEXT scan re-finds the message, and a single cycle may not include one. Unbounded is the
 * defect above. Three consecutive full scans in which nothing moved and something was deferred is
 * long enough to be evidence that the deferral is not going to clear.
 */
export const SWEEP_MAX_DEFERRED_SCANS = 3;

/** A scan that has seen no press yet — the value a fresh mailbox attachment starts from. */
export const SWEEP_SCAN_START: SweepScanState = {
  command: null, after: null, movedSinceTop: false, deferredSinceTop: false, deferredScans: 0,
};

/**
 * The scan state to run THIS press with — unchanged when the press is the one already in progress,
 * and a clean start otherwise. See {@link SweepScanState.command} for what went wrong without it.
 *
 * Deliberately total rather than a conditional at the call site: "is this still the same command"
 * is a decision, and a decision spelled inline in a 2000-line composition root is one nothing can
 * assert. The whole state is replaced rather than patched field by field, so a field added later
 * cannot be forgotten here — the compiler names it.
 */
export function sweepStateForPress(state: SweepScanState, command: string): SweepScanState {
  return state.command === command ? state : { ...SWEEP_SCAN_START, command };
}

/**
 * WHY A MEMBER WAS SKIPPED WHEN ITS SOURCE LOCATOR WAS STALE — one sentence, used by both arms.
 *
 * It read "(sync adopts it)", which asserts an adoption that may never come: `MessageGoneError`
 * covers a message that was permanently DELETED just as much as one that moved, and for that one
 * nothing re-finds it. Review was right to call that an over-claim — it is the same mistake as a
 * user-facing sentence promising a refresh will fix a deleted file, one layer down, where an
 * operator reads it. Conditional now, and a single constant so the two arms cannot drift into
 * saying different things about one condition.
 */
export const SWEEP_GONE_REASON =
  "not at the locator ohmail/Quarantine recorded — the next scan re-finds it if it still exists";

export function adoptSweepWindow(
  state: SweepScanState,
  window: {
    movedCount: number; candidates: number; lastId: string | null; junkFolder: string | null;
    /** This window's stale-locator count — `JunkSweepResult.deferred`. */
    deferredCount?: number;
  },
  limit: number,
): {
  state: SweepScanState; examinedAll: boolean; deferredSinceTop: boolean;
  exhaustedDeferrals: boolean;
  /**
   * THE GATE THE CYCLE ACTUALLY READS — the two halves combined here rather than at the call site.
   *
   * It was `deferredSinceTop && !exhaustedDeferrals` written out in `index.ts`, and a mutation
   * proved that spelling unguarded: dropping the bound there left every test green, because the
   * two halves were each covered on their own and their COMBINATION was covered nowhere. A
   * conjunction assembled at a call site is a decision with no name and no test; returning it from
   * the function that computes both halves gives it both.
   */
  deferralsHold: boolean;
} {
  const startedAtTop = state.after === null;
  const movedSinceTop = (startedAtTop ? false : state.movedSinceTop) || window.movedCount > 0;
  const deferredSinceTop =
    (startedAtTop ? false : state.deferredSinceTop) || (window.deferredCount ?? 0) > 0;
  const ranOffTheEnd = window.junkFolder === null || window.candidates < limit;
  const examinedAll = window.junkFolder === null || (ranOffTheEnd && !movedSinceTop);
  // The counter advances only on a COMPLETED scan that moved nothing and deferred something —
  // the exact state the exemption keeps alive. A scan that moved anything is progress and resets
  // it, because the pile is draining and the deferrals are not what is holding the command open.
  const completedBarrenDeferral = ranOffTheEnd && !movedSinceTop && deferredSinceTop;
  const deferredScans = movedSinceTop
    ? 0
    : completedBarrenDeferral ? state.deferredScans + 1 : state.deferredScans;
  const exhaustedDeferrals = deferredScans >= SWEEP_MAX_DEFERRED_SCANS;
  const next: SweepScanState = ranOffTheEnd
    ? { command: state.command, after: null, movedSinceTop: false, deferredSinceTop: false, deferredScans }
    : { command: state.command, after: window.lastId, movedSinceTop, deferredSinceTop, deferredScans };
  return {
    state: next, examinedAll, deferredSinceTop, exhaustedDeferrals,
    deferralsHold: deferredSinceTop && !exhaustedDeferrals,
  };
}

export interface JunkSweepCandidate { messageId: string; subject: string; ref: string }

export interface JunkSweepResult {
  /** Messages physically in `ohmail/Quarantine` when the pass started. */
  candidates: JunkSweepCandidate[];
  /** The resolved native junk path, or null — in which case nothing can move. */
  junkFolder: string | null;
  /** Members whose move LANDED and whose completion committed. Empty on a dry run. */
  moved: string[];
  /** Members the source no longer held (adopted later by sync), or whose move failed. */
  skipped: Array<{ messageId: string; reason: string }>;
  /**
   * How many of {@link skipped} were skipped because the SOURCE LOCATOR WAS STALE — the message moved, or
   * `ohmail/Quarantine` was recreated under a new UIDVALIDITY — as opposed to the server refusing the move.
   * Opposite facts in one shape: a REFUSED move is evidence about the pile (it refuses again next cycle); a
   * stale locator is about our bookkeeping (the next `changesSince` re-finds the message by Message-ID and
   * repoints it, then the sweep moves it). `sync.ts` retires the one-time command when a full scan moved
   * NOTHING; a folder recycled between scans makes EVERY member skip at once, indistinguishable from that
   * if you only count moves — so the press was consumed by a self-clearing condition. This count tells the
   * two apart, and is a count rather than a parse of reason strings so it cannot go wrong on a reword.
   */
  deferred: number;
  dryRun: boolean;
}

export async function junkSweepPass(opts: {
  db: Tx;
  repo: WorkerRepo & { transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T> };
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  execute: boolean;
  limit?: number;
  /**
   * KEYSET cursor: only candidates whose id sorts AFTER this one (the pass's stable id order).
   * The worker cycle carries the last id it examined across cycles, so a refused prefix is
   * walked past one bounded window per cycle and a candidate is never skipped when the set
   * shrinks between windows (an OFFSET over a mutable set would). Absent (the
   * default) is the pass as the CLI runs it: from the top.
   */
  afterId?: string;
  /**
   * Called before EVERY IMAP mutation — once per chunk before the batched command, and once per
   * MESSAGE on the per-message fallback. A throw here aborts the sweep: the members not yet moved
   * are left exactly where they were, and the stamp that requested the sweep is not consumed.
   *
   * TWO QUESTIONS, ONE OBJECT, asked by `assertMayWriteToMailbox` in one order. Leadership is
   * worker-to-worker (a stale leader must not move mail another worker took over); the lease is
   * install-to-install (this process must not write to a mailbox its owner has moved to their own
   * machine). The caller states which halves it holds; a dry run holds neither.
   */
  writeAuthority: MailboxWriteAuthority;
}): Promise<JunkSweepResult> {
  const { db, repo, adapter, accountId, mailboxId, execute, limit, afterId, writeAuthority } = opts;

  // Physically in the pile, still alive in the mirror, still DESIRED there — the ONE predicate
  // the API's preview counts by too (`junkSweepCandidateWhere`, packages/db). `native_locator`
  // is the primary instance's mirror, so this is exactly the set a per-message move can act on.
  const rows = await db.select({
    messageId: messages.id,
    subject: messages.subject,
    locator: messages.nativeLocator,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(afterId !== undefined
      ? and(junkSweepCandidateWhere(accountId, mailboxId), gt(messages.id, afterId))
      : junkSweepCandidateWhere(accountId, mailboxId))
    .orderBy(messages.id)
    .limit(limit ?? 10_000);

  const candidates: JunkSweepCandidate[] = rows.map((r) => ({
    messageId: r.messageId, subject: r.subject,
    ref: (r.locator as { ref?: string } | null)?.ref ?? "",
  }));

  // Read-only on both branches: one LIST, nothing created (findSpecialFolders' own contract).
  // `sentFolder` null: the sweep files SPAM only, and the delete completion's Sent exclusion —
  // the one reader of that field — is unreachable from a spam-pile desire.
  const special: SpecialFolderMap = typeof adapter.findSpecialFolders === "function"
    ? await adapter.findSpecialFolders().then((f) => ({ junkFolder: f.junk, trashFolder: f.trash, sentFolder: null }))
    : { junkFolder: null, trashFolder: null, sentFolder: null };

  const result: JunkSweepResult = {
    candidates, junkFolder: special.junkFolder, moved: [], skipped: [], deferred: 0, dryRun: !execute,
  };
  if (!execute || special.junkFolder === null || candidates.length === 0) return result;

  const junk = special.junkFolder;
  const pending: PendingFolderState[] = candidates.map((c) => ({
    messageId: c.messageId, desiredFolder: SPAM_PILE, observedFolder: SPAM_PILE,
    lastSetBy: "us", nativeLocator: { folder: SPAM_PILE, ref: c.ref },
  }));

  /**
   * THE COMPLETION RUNS OUTSIDE EVERY CATCH BELOW, and that is the fence's whole protection here. The IMAP
   * half of a member may fail on its own (a UID the server no longer holds, a refused MOVE) and is SKIPPED
   * and reported; the database half rides the repo's `transaction` — from the worker cycle, the fenced
   * group — and a throw out of it is proof of lost leadership or a database fault, never about a message. A
   * catch would read a fence refusal as "skip this one and carry on", and a stale worker would keep issuing
   * MOVEs beside the new leader. So it propagates, the sweep aborts consistent (moved-but-uncompleted
   * members adopted by the next cycle's `changesSince`), and the command stamp is not retired.
   */
  const complete = async (p: PendingFolderState, newLoc: NativeLocator): Promise<void> => {
    await repo.transaction(async (r) => {
      await completeFiling(r, accountId, mailboxId, p, newLoc, special);
      await r.recordAudit(accountId, "sweep.junk_filed",
        { messageId: p.messageId, from: p.nativeLocator, newLocator: newLoc },
        { action: "move", locator: newLoc, toFolder: SPAM_PILE });
    });
    result.moved.push(p.messageId);
  };

  /**
   * IS THIS STILL THE USER'S DECISION? — asked at the WRITE boundary, not the read. The candidate set is
   * read ONCE and the moves run for as long as the pile takes; `desired_folder` has six writers taking no
   * mailbox row (the API move, the Screener's apply, `rule-retro`, `ohbox-tidy`, `screener-auto`, the
   * one-time re-screen), so a user restoring a message or screening its sender in commits a NEWER decision.
   * `completeFolderState`'s witness catches that AFTER the move, but this pass writes to a real mail server,
   * so the same predicate the candidates came from (`junkSweepCandidateWhere`, carrying the Quarantine
   * physical-locator test) is re-asked for THIS CHUNK before the network call — it narrows the window, the
   * witness closes the rest. The old "asks only about the DESIRE" claim was false; a row dropped for a
   * moved locator is mis-reported as a withdrawn verdict, named here rather than fixed in the reason string. */
  const stillDesired = async (chunk: readonly PendingFolderState[]): Promise<Set<string>> => {
    const ids = chunk.map((p) => p.messageId);
    const live = await db.select({ messageId: messages.id }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(junkSweepCandidateWhere(accountId, mailboxId), inArray(messages.id, ids)));
    return new Set(live.map((r) => r.messageId));
  };

  for (let i = 0; i < pending.length; i += FILING_BATCH_MAX) {
    const wholeChunk = pending.slice(i, i + FILING_BATCH_MAX);
    // Before this chunk's IMAP writes. A refusal propagates, never caught into `skipped`: it is
    // proof of a lost lease or lost leadership, not evidence about a message. Ordered before
    // `stillDesired` deliberately — a process that has lost the lease must not spend a query on
    // the mailbox either. Only under `execute`: a dry run reads no lease, because a lease read
    // RENEWS our claim, which is itself a write.
    if (execute) await assertMayWriteToMailbox(writeAuthority);
    const desired = await stillDesired(wholeChunk);
    const chunk = wholeChunk.filter((p) => desired.has(p.messageId));
    for (const p of wholeChunk) {
      if (!desired.has(p.messageId)) {
        result.skipped.push({
          messageId: p.messageId,
          reason: "the spam verdict was withdrawn after this sweep began (newer intent stands)",
        });
      }
    }
    if (chunk.length === 0) continue;
    // The batched fast path when the adapter can prove it, per-message otherwise — the
    // reconciler's exact fallback shape, minus its deferral machinery: a sweep is one
    // invocation, so a refusal is reported and left rather than scheduled. ONLY the IMAP call
    // sits in the try: its refusal is what selects the fallback.
    let batched: MoveManyResult | null = null;
    if (typeof adapter.moveMany === "function") {
      // AGAIN, because `stillDesired` sits between the ask above and this write: an unbounded
      // database wait there can outlive the permit's TTL, so the receipt would be checked and then
      // spent after it expired. The first ask refuses to spend a query, this one the WRITE.
      if (execute) await assertMayWriteToMailbox(writeAuthority);
      try {
        const res = await adapter.moveMany(chunk.map((p) => p.nativeLocator!), junk);
        if (res.batched) batched = res;
      } catch {
        batched = null;
      }
    }
    if (batched !== null) {
      for (const p of chunk) {
        const newLoc = batched.moved.get(p.nativeLocator!.ref);
        if (!newLoc) {
          // A UID the batch did not return is the batch's own `MessageGoneError` — the source no
          // longer holds it. DEFERRED, not refused: the next scan re-finds it by Message-ID.
          result.deferred++;
          result.skipped.push({ messageId: p.messageId, reason: SWEEP_GONE_REASON });
          continue;
        }
        await complete(p, newLoc);
      }
      continue;
    }
    // THE PER-MESSAGE FALLBACK ASKS PER MESSAGE, NOT ONCE FOR THE RUN. It used to ask ONCE and then issue
    // up to `FILING_BATCH_MAX` separate `adapter.move()` commands under a comment claiming "the same fresh
    // leadership read as before the batch" — one read before FIFTY writes, so a takeover after the third
    // move let the remaining forty-seven proceed unchecked. This module's rule is *"EVERY IMAP mutation is
    // preceded by `fenceImapMutation`"*; the batched arm above is one command (where "before the batch" and
    // "before every write" coincide), and here they do not. The cost is real and right: under the worker's
    // fence a fifty-message fallback costs fifty indexed reads, under the CLI's permit a comparison until
    // the TTL lapses. This is the RARE path (no `moveMany`, or a refused batch) and every write is destructive.
    for (const p of chunk) {
      let newLoc: NativeLocator;
      // OUTSIDE the `try`, and the placement is load-bearing: the catch below ends in a generic arm
      // that files the error against THIS MESSAGE and carries on, so a refusal raised inside it
      // would be read as evidence about a message and the sweep would keep moving mail.
      if (execute) await assertMayWriteToMailbox(writeAuthority);
      try {
        newLoc = await adapter.move(p.nativeLocator!, junk);
      } catch (err) {
        if (err instanceof MessageGoneError) {
          // The same fact the batched arm above reports by absence, and it gets the same reading
          // and the same words: the source does not hold this message any more, so there is
          // nothing to move and nothing is wrong. `changesSince` re-adopts it by Message-ID and a
          // later sweep window moves it. Counted as DEFERRED so the cycle does not read a
          // recycled folder as a pile the server refuses — see {@link JunkSweepResult.deferred}.
          result.deferred++;
          result.skipped.push({ messageId: p.messageId, reason: SWEEP_GONE_REASON });
          continue;
        }
        result.skipped.push({
          messageId: p.messageId,
          reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        continue;
      }
      await complete(p, newLoc);
    }
  }
  return result;
}
