import { and, asc, eq, gt, isNotNull, isNull, notExists, type SQL } from "drizzle-orm";
import { accounts, eraseOwedMailbox, mailboxes, readDrainCursor, repairFinishedMailboxErasure, writeDrainCursor, type Tx } from "@trafficflow/db";
import { mailboxStorageStats } from "@trafficflow/db/cloud";
import { dialect } from "@trafficflow/db/dialect";

/**
 * THE MAILBOX ERASURE PASS — the sweep a "Remove and erase" press owes. The request stamps
 * `mailboxes.erased_at` and answers; this pass erases the stamped mailbox's rows in bounded steps
 * (`@trafficflow/db`'s `mailbox-erasure.ts`, ≤ `ERASE_BATCH` messages a step, one transaction each)
 * until `erasure_done_at` is set. Resumable from the tombstone alone: a restart re-reads the owed
 * pairs and each step deletes what it read. One mailbox at a time per account, oldest stamp first.
 */

/** Steps one pass may run across every owed mailbox, each of `ERASE_BATCH` messages. */
const MAILBOX_ERASURE_STEPS_PER_PASS = 20;

/** Wall clock one pass may spend, checked between steps: the cycle it rides also syncs mail. */
export const MAILBOX_ERASURE_PASS_BUDGET_MS = 10_000;

/** How many owed stamps one pass reads; the index `mailboxes_erasure_owed_idx` holds only these. */
const OWED_READ = 50;

interface MailboxErasurePassResult {
  /** Mailboxes this pass ran steps on. */
  mailboxes: number;
  steps: number;
  /** Erasures this pass finished. */
  finished: number;
  messagesErased: number;
  /** Erasures finished before the last step cleared the signature, cleared now. */
  signaturesCleared: number;
  /** Erasures finished before the steps took the settings hashes off their audit rows, cleared now. */
  settingsHashesCleared: number;
}

export async function mailboxErasurePass(
  db: Tx,
  opts: {
    now: () => Date;
    shard?: SQL | undefined;
    clock?: () => number;
    forAccount?: (id: string) => Tx;
    repairKey?: string;
  },
): Promise<MailboxErasurePassResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const accountErased = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.id, mailboxes.accountId), isNotNull(accounts.erasedAt)));
  const where = [isNotNull(mailboxes.erasedAt), isNull(mailboxes.erasureDoneAt), notExists(accountErased)];
  if (opts.shard) where.push(opts.shard);
  const owed = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId })
    .from(mailboxes).where(and(...where))
    .orderBy(asc(mailboxes.erasedAt), asc(mailboxes.id)).limit(OWED_READ);
  const seen = new Set<string>();
  const queue = owed.filter((r) => (seen.has(r.accountId) ? false : (seen.add(r.accountId), true)));

  const out: MailboxErasurePassResult = {
    mailboxes: 0, steps: 0, finished: 0, messagesErased: 0,
    signaturesCleared: 0, settingsHashesCleared: 0,
  };
  const spent = (): boolean => clock() - started >= MAILBOX_ERASURE_PASS_BUDGET_MS;
  for (const r of queue) {
    if (out.steps >= MAILBOX_ERASURE_STEPS_PER_PASS || spent()) break;
    const bound = opts.forAccount?.(r.accountId) ?? db;
    const run = await eraseOwedMailbox(bound, dialect(bound), {
      accountId: r.accountId, mailboxId: r.id, now: opts.now,
      maxSteps: MAILBOX_ERASURE_STEPS_PER_PASS - out.steps, until: spent,
    });
    if (run.steps > 0) out.mailboxes += 1;
    out.steps += run.steps;
    out.messagesErased += run.messagesErased;
    if (run.done) {
      out.finished += 1;
      // The storage estimate's snapshot of it goes with it (cloud 0057); a crash before this line
      // leaves a row the next snapshot of the account deletes, and no reader joins an erased mailbox.
      await bound.delete(mailboxStorageStats)
        .where(and(eq(mailboxStorageStats.accountId, r.accountId), eq(mailboxStorageStats.mailboxId, r.id)));
    }
  }
  if (spent()) return out;
  // The roster can see finished tombstones. Only the account handle can see their audit evidence.
  const repairPass = opts.repairKey === undefined ? null : `mailbox_erasure_repair:${opts.repairKey}`;
  const after = repairPass === null ? null : (await readDrainCursor(db, repairPass))?.messageId ?? null;
  const finished = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId })
    .from(mailboxes).where(and(isNotNull(mailboxes.erasureDoneAt), opts.shard, after ? gt(mailboxes.id, after) : undefined))
    .orderBy(asc(mailboxes.id)).limit(OWED_READ);
  for (const r of finished) {
    if (spent()) return out;
    const repaired = await repairFinishedMailboxErasure(opts.forAccount?.(r.accountId) ?? db, r.accountId, r.id);
    out.signaturesCleared += repaired.signaturesCleared;
    out.settingsHashesCleared += repaired.settingsHashesCleared;
    if (repairPass !== null) {
      const now = opts.now();
      await writeDrainCursor(db, repairPass, { at: now, messageId: r.id }, now);
    }
  }
  if (repairPass !== null && after !== null && finished.length < OWED_READ) {
    await writeDrainCursor(db, repairPass, null, opts.now());
  }
  return out;
}
