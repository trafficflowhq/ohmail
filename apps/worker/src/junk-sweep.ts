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

import { eq } from "drizzle-orm";
import { folderState, junkSweepCandidateWhere, messages, type Tx } from "@trafficflow/db";
import { FILING_BATCH_MAX, type MailboxAdapter, type MoveManyResult } from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import type { WorkerRepo, PendingFolderState } from "@trafficflow/core/adapters/drizzle-repo";
import { completeFiling, SPAM_PILE, type SpecialFolderMap } from "./junk-filing.js";

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
   * Called before EVERY chunk's IMAP mutation. The worker cycle hands in its fresh leadership
   * read (`fenceImapMutation`) so a stale leader cannot move mail another worker has taken over;
   * the operator runner passes none. A throw here aborts the sweep — the members not yet moved
   * are left exactly where they were, and the stamp that requested the sweep is not consumed.
   */
  guard?: () => Promise<void>;
}): Promise<JunkSweepResult> {
  const { db, repo, adapter, accountId, mailboxId, execute, limit, guard } = opts;

  // Physically in the pile, still alive in the mirror, still DESIRED there — the ONE predicate
  // the API's preview counts by too (`junkSweepCandidateWhere`, packages/db). `native_locator`
  // is the primary instance's mirror, so this is exactly the set a per-message move can act on.
  const rows = await db.select({
    messageId: messages.id,
    subject: messages.subject,
    locator: messages.nativeLocator,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(junkSweepCandidateWhere(accountId, mailboxId))
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
    candidates, junkFolder: special.junkFolder, moved: [], skipped: [], dryRun: !execute,
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

  for (let i = 0; i < pending.length; i += FILING_BATCH_MAX) {
    const chunk = pending.slice(i, i + FILING_BATCH_MAX);
    // The leadership check before this chunk's IMAP writes — a refusal propagates, never caught
    // into `skipped`: it is proof of lost leadership, not evidence about a message.
    if (guard) await guard();
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
