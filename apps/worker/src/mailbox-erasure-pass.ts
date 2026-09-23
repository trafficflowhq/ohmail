import { and, asc, isNotNull, isNull, type SQL } from "drizzle-orm";
import { eraseOwedMailbox, mailboxes, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";

/**
 * THE MAILBOX ERASURE PASS — the sweep a "Remove and erase" press owes. The request stamps
 * `mailboxes.erased_at` and answers; this pass erases the stamped mailbox's rows in bounded steps
 * (`@trafficflow/db`'s `mailbox-erasure.ts`, ≤ `ERASE_BATCH` messages a step, one transaction each)
 * until `erasure_done_at` is set. Resumable from the tombstone alone: a restart re-reads the owed
 * pairs and each step deletes what it read. One mailbox at a time per account, oldest stamp first.
 */

/** Steps one pass may run across every owed mailbox, each of `ERASE_BATCH` messages. */
export const MAILBOX_ERASURE_STEPS_PER_PASS = 20;

/** Wall clock one pass may spend, checked between steps: the cycle it rides also syncs mail. */
export const MAILBOX_ERASURE_PASS_BUDGET_MS = 10_000;

/** How many owed stamps one pass reads; the index `mailboxes_erasure_owed_idx` holds only these. */
const OWED_READ = 50;

export interface MailboxErasurePassResult {
  /** Mailboxes this pass ran steps on. */
  mailboxes: number;
  steps: number;
  /** Erasures this pass finished. */
  finished: number;
  messagesErased: number;
}

export async function mailboxErasurePass(
  db: Tx,
  opts: { now: () => Date; shard?: SQL | undefined; clock?: () => number },
): Promise<MailboxErasurePassResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const where = [isNotNull(mailboxes.erasedAt), isNull(mailboxes.erasureDoneAt)];
  if (opts.shard) where.push(opts.shard);
  const owed = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId })
    .from(mailboxes).where(and(...where))
    .orderBy(asc(mailboxes.erasedAt), asc(mailboxes.id)).limit(OWED_READ);
  const seen = new Set<string>();
  const queue = owed.filter((r) => (seen.has(r.accountId) ? false : (seen.add(r.accountId), true)));

  const out: MailboxErasurePassResult = { mailboxes: 0, steps: 0, finished: 0, messagesErased: 0 };
  const spent = (): boolean => clock() - started >= MAILBOX_ERASURE_PASS_BUDGET_MS;
  for (const r of queue) {
    if (out.steps >= MAILBOX_ERASURE_STEPS_PER_PASS || spent()) break;
    const run = await eraseOwedMailbox(db, dialect(db), {
      accountId: r.accountId, mailboxId: r.id, now: opts.now,
      maxSteps: MAILBOX_ERASURE_STEPS_PER_PASS - out.steps, until: spent,
    });
    if (run.steps > 0) out.mailboxes += 1;
    out.steps += run.steps;
    out.messagesErased += run.messagesErased;
    if (run.done) out.finished += 1;
  }
  return out;
}
