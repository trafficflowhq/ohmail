/**
 * THE ONE-TIME QUARANTINE→\Junk SWEEP — explicitly invoked, never scheduled, dry-run by default.
 *
 * The 2026-08-22 amendment sends NEW spam verdicts to the provider's native `\Junk`
 * (`junk-filing.ts`). Mail already sitting in `ohmail/Quarantine` from earlier verdicts stays
 * there until somebody moves it, and this pass is that somebody — invoked once per mailbox by an
 * operator (`run-junk-sweep.ts`), with the account owner's standing spam verdicts as its whole
 * authority: everything physically in the pile is there because a verdict or a promoted rule put
 * it there, and the sweep executes those same verdicts against the destination they would choose
 * today.
 *
 * It is NOT SCHEDULED and must never be: the product rule allows user-commanded writes into
 * `\Junk`, and a RECURRING pass would be the organizer acting on its own initiative — the exact
 * boundary the amendment keeps. Two callers, both explicit: the operator runner above, and the
 * worker cycle's sweep-command consumption (`sync.ts`), which runs this pass ONCE per recorded
 * press — `mailboxes.junk_sweep_requested_at` (mail 0076), stamped by `POST /screener/junk/sweep`
 * on the account owner's own click. That is §16.1's carve-out to the letter: "an explicit human
 * press, recorded, executed by the worker under the organizer lease". A cycle with no stamp
 * runs nothing here.
 *
 * Same completion, same claims discipline as the live path: `completeFiling` runs only for
 * members the server's move actually named, so a member that vanished mid-sweep (`gone`) is left
 * for `changesSince` to adopt, and nothing is husked or marked that did not land in Junk.
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import { folderState, junkSweepCandidateWhere, messages, type Tx } from "@trafficflow/db";
import {
  FILING_BATCH_MAX, MessageGoneError, type MailboxAdapter, type MoveManyResult,
} from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import type { WorkerRepo, PendingFolderState } from "@trafficflow/core/adapters/drizzle-repo";
import { completeFiling, SPAM_PILE, type SpecialFolderMap } from "./junk-filing.js";

/**
 * THE SCAN'S STATE ACROSS CYCLES — a pure decision, extracted so it can be pinned by test
 * (a fully refused pile larger than one window never reported `examinedAll`,
 * because the tail window had not "started at the top"; the stamp then stood for ever and the
 * mailbox re-kicked the same refusals every cycle).
 *
 * One window per cycle. The cursor advances while a scan is unfinished — a window that landed
 * moves keeps advancing too (its refusals shrink on their own as later scans revisit them) —
 * and resets to the top when the scan runs off the end. `examinedAll` is true precisely when a
 * WHOLE scan — top to end, however many cycles it took — moved nothing: that is the one reading
 * that licenses the cycle to retire the command over a non-empty pile.
 */
export interface SweepScanState {
  /** The last examined id, or null for "the next window starts at the top". */
  after: string | null;
  /** Whether the scan IN PROGRESS (since the last top) has moved anything. */
  movedSinceTop: boolean;
}

export function adoptSweepWindow(
  state: SweepScanState,
  window: { movedCount: number; candidates: number; lastId: string | null; junkFolder: string | null },
  limit: number,
): { state: SweepScanState; examinedAll: boolean } {
  const startedAtTop = state.after === null;
  const movedSinceTop = (startedAtTop ? false : state.movedSinceTop) || window.movedCount > 0;
  const ranOffTheEnd = window.junkFolder === null || window.candidates < limit;
  const examinedAll = window.junkFolder === null || (ranOffTheEnd && !movedSinceTop);
  const next: SweepScanState = ranOffTheEnd
    ? { after: null, movedSinceTop: false }
    : { after: window.lastId, movedSinceTop };
  return { state: next, examinedAll };
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
   * How many of {@link skipped} were skipped because the SOURCE LOCATOR WAS STALE — the message
   * moved, or `ohmail/Quarantine` was recreated under a new UIDVALIDITY — as opposed to the server
   * refusing the move.
   *
   * ── WHY THIS COUNT EXISTS RATHER THAN THE CALLER READING THE REASONS ────────────────────────
   *
   * The two are opposite facts wearing one shape. A REFUSED move is evidence about the pile: ask
   * again next cycle and the server will refuse again. A stale locator is evidence about our
   * bookkeeping and nothing else — the very next `changesSince` re-finds the message by Message-ID
   * and repoints it, after which the same sweep moves it without complaint.
   *
   * `sync.ts` retires the user's one-time sweep command when a full scan moved NOTHING, on the
   * reading that the server refuses every member. A folder recycled between the mirror's last scan
   * and the sweep makes EVERY member skip at once, which is indistinguishable from that reading if
   * you only count moves — so the press was consumed by a condition that would have cleared on its
   * own, and the offer came back asking the user to press again for mail nothing was wrong with.
   * This is the number that tells the two apart, and it is a count rather than a parse of English
   * reason strings so that it cannot go quietly wrong when a sentence is reworded.
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
   * Called before EVERY chunk's IMAP mutation. The worker cycle hands in its fresh leadership
   * read (`fenceImapMutation`) so a stale leader cannot move mail another worker has taken over;
   * the operator runner passes none. A throw here aborts the sweep — the members not yet moved
   * are left exactly where they were, and the stamp that requested the sweep is not consumed.
   */
  guard?: () => Promise<void>;
}): Promise<JunkSweepResult> {
  const { db, repo, adapter, accountId, mailboxId, execute, limit, afterId, guard } = opts;

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
   * THE COMPLETION RUNS OUTSIDE EVERY CATCH BELOW, and that is the fence's whole protection here.
   * The IMAP half of a member may fail on its own account (a UID the server no longer holds, a
   * refused MOVE) and is then SKIPPED and reported; the database half rides the repo's
   * `transaction` — which, from the worker cycle, IS the fenced group — and a throw out of it
   * is proof of lost leadership or a database fault, never evidence about a message. A catch
   * around it would read a fence refusal as "skip this one and carry on", and a stale worker
   * would keep issuing MOVEs beside the new leader. So it propagates, and the sweep aborts with
   * everything consistent: moved-but-uncompleted members are adopted by the next cycle's
   * `changesSince`, and the command stamp that requested the sweep is not retired.
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
   * IS THIS STILL THE USER'S DECISION? — asked at the WRITE boundary, not at the read.
   *
   * The candidate set above is read ONCE and the moves that act on it run for as long as the pile
   * takes. `desired_folder` has six writers that take no mailbox row (the API's move, the
   * Screener's apply, `rule-retro`, `ohbox-tidy`, `screener-auto`, the one-time re-screen), so a
   * user who restores a message out of the spam pile — or screens its sender in — while this pass
   * is working commits a NEWER decision against a set this pass already made up its mind about.
   *
   * `completeFolderState`'s witness catches that, and catches it correctly: the completion
   * declines and the newer intent stands. But it catches it AFTER the move, and this pass writes
   * to somebody's real mail server — the message is physically in `\Junk` by then, and the row is
   * left PENDING for the reconciler to carry back out. That self-heal needs a running worker and
   * costs the user a round trip through their spam folder for mail they had just rescued.
   *
   * So the same predicate the candidates came from is asked again, for THIS CHUNK only, one
   * indexed statement immediately before the network call. It does not close the window — nothing
   * short of holding a transaction open across an IMAP round trip would, and that trade is worse —
   * it narrows it from the whole pass to one chunk's latency, and the witness closes the rest.
   * The two are complementary and neither is redundant: this one stops the SERVER write, the
   * witness stops the DATABASE write.
   *
   * Deliberately NOT a re-read of `messages.native_locator`: a locator that moved is the
   * `MessageGoneError`/absent-from-batch path below, which is already a deferral rather than a
   * refusal. This asks only about the DESIRE.
   */
  const stillDesired = async (chunk: readonly PendingFolderState[]): Promise<Set<string>> => {
    const ids = chunk.map((p) => p.messageId);
    const live = await db.select({ messageId: messages.id }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(junkSweepCandidateWhere(accountId, mailboxId), inArray(messages.id, ids)));
    return new Set(live.map((r) => r.messageId));
  };

  for (let i = 0; i < pending.length; i += FILING_BATCH_MAX) {
    const wholeChunk = pending.slice(i, i + FILING_BATCH_MAX);
    // The leadership check before this chunk's IMAP writes — a refusal propagates, never caught
    // into `skipped`: it is proof of lost leadership (or, from the operator CLI, of a lost
    // ORGANIZER LEASE), not evidence about a message.
    // …and the decision check, in the same breath and for the same reason: both ask "may this
    // write still happen?", one about the mailbox, one about the message.
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
          result.skipped.push({ messageId: p.messageId, reason: "gone from ohmail/Quarantine (sync adopts it)" });
          continue;
        }
        await complete(p, newLoc);
      }
      continue;
    }
    // The per-message fallback issues its own IMAP writes — the same fresh leadership read
    // before them as before the batch it replaces.
    if (guard) await guard();
    for (const p of chunk) {
      let newLoc: NativeLocator;
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
          result.skipped.push({ messageId: p.messageId, reason: "gone from ohmail/Quarantine (sync adopts it)" });
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
