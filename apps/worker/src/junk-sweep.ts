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
 * It is NOT wired into the worker cycle and must never be: the product rule allows
 * user-commanded writes into `\Junk`, and a recurring pass would be the organizer acting on its
 * own initiative — the exact boundary the amendment keeps.
 *
 * Same completion, same claims discipline as the live path: `completeFiling` runs only for
 * members the server's move actually named, so a member that vanished mid-sweep (`gone`) is left
 * for `changesSince` to adopt, and nothing is husked or marked that did not land in Junk.
 */

import { and, isNull, eq, sql } from "drizzle-orm";
import { messages, type Tx } from "@trafficflow/db";
import { FILING_BATCH_MAX, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
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
}): Promise<JunkSweepResult> {
  const { db, repo, adapter, accountId, mailboxId, execute, limit } = opts;

  // Physically in the pile, still alive in the mirror. `native_locator` is the primary
  // instance's mirror, so this is exactly the set a per-message move can act on.
  const rows = await db.select({
    messageId: messages.id,
    subject: messages.subject,
    locator: messages.nativeLocator,
  }).from(messages)
    .where(and(
      eq(messages.mailboxId, mailboxId),
      eq(messages.accountId, accountId),
      isNull(messages.deletedAt),
      sql`${messages.nativeLocator} ->> 'folder' = ${SPAM_PILE}`,
    ))
    .orderBy(messages.id)
    .limit(limit ?? 10_000);

  const candidates: JunkSweepCandidate[] = rows.map((r) => ({
    messageId: r.messageId, subject: r.subject,
    ref: (r.locator as { ref?: string } | null)?.ref ?? "",
  }));

  // Read-only on both branches: one LIST, nothing created (findSpecialFolders' own contract).
  const special: SpecialFolderMap = typeof adapter.findSpecialFolders === "function"
    ? await adapter.findSpecialFolders().then((f) => ({ junkFolder: f.junk, trashFolder: f.trash }))
    : { junkFolder: null, trashFolder: null };

  const result: JunkSweepResult = {
    candidates, junkFolder: special.junkFolder, moved: [], skipped: [], dryRun: !execute,
  };
  if (!execute || special.junkFolder === null || candidates.length === 0) return result;

  const junk = special.junkFolder;
  const pending: PendingFolderState[] = candidates.map((c) => ({
    messageId: c.messageId, desiredFolder: SPAM_PILE, observedFolder: SPAM_PILE,
    lastSetBy: "us", nativeLocator: { folder: SPAM_PILE, ref: c.ref },
  }));

  for (let i = 0; i < pending.length; i += FILING_BATCH_MAX) {
    const chunk = pending.slice(i, i + FILING_BATCH_MAX);
    // The batched fast path when the adapter can prove it, per-message otherwise — the
    // reconciler's exact fallback shape, minus its deferral machinery: a sweep is one
    // invocation, so a refusal is reported and left rather than scheduled.
    let batched = false;
    if (typeof adapter.moveMany === "function") {
      try {
        const res = await adapter.moveMany(chunk.map((p) => p.nativeLocator!), junk);
        if (res.batched) {
          batched = true;
          for (const p of chunk) {
            const newLoc = res.moved.get(p.nativeLocator!.ref);
            if (!newLoc) {
              result.skipped.push({ messageId: p.messageId, reason: "gone from ohmail/Quarantine (sync adopts it)" });
              continue;
            }
            await repo.transaction(async (r) => {
              await completeFiling(r, accountId, mailboxId, p, newLoc, special);
              await r.recordAudit(accountId, "sweep.junk_filed",
                { messageId: p.messageId, from: p.nativeLocator, newLocator: newLoc },
                { action: "move", locator: newLoc, toFolder: SPAM_PILE });
            });
            result.moved.push(p.messageId);
          }
        }
      } catch {
        batched = false;
      }
    }
    if (batched) continue;
    for (const p of chunk) {
      try {
        const newLoc = await adapter.move(p.nativeLocator!, junk);
        await repo.transaction(async (r) => {
          await completeFiling(r, accountId, mailboxId, p, newLoc, special);
          await r.recordAudit(accountId, "sweep.junk_filed",
            { messageId: p.messageId, from: p.nativeLocator, newLocator: newLoc },
            { action: "move", locator: newLoc, toFolder: SPAM_PILE });
        });
        result.moved.push(p.messageId);
      } catch (err) {
        result.skipped.push({
          messageId: p.messageId,
          reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    }
  }
  return result;
}
