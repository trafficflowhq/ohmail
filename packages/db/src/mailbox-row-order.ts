import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { dialect, type Dialect, type LockMode } from "./dialect/index.js";

/**
 * AN ACCOUNT'S MAILBOX ROWS, SEVERAL AT ONCE, ARE TAKEN IN ID ORDER. A plan reads a small table in
 * the heap's order, so a statement that locked several rows in its own scan's order met one taking
 * them in id order crosswise: each held a row the other asked for, and Postgres aborted one (40P01,
 * a 500 on the Screener press beside the worker's pass-end stamp or a person's pull). A statement
 * that locks one row by its id needs neither.
 */

/**
 * Every mailbox row of the account FOR SHARE, or the ones `only` names (none for an empty list), in id
 * order: the role locks a decision's held bags take, or the rows a press that travels asks behind (a
 * request row for each holder), taken before the press writes its delta (taken again there, free):
 * right after its rule-key lock, or its settings row.
 */
export async function lockAccountMailboxes(tx: Tx, accountId: string, only?: readonly string[]): Promise<void> {
  if (only !== undefined && only.length === 0) return;
  const mine = eq(mailboxes.accountId, accountId);
  await dialect(tx).forUpdate(
    tx.select({ id: mailboxes.id }).from(mailboxes)
      .where(only === undefined ? mine : and(mine, inArray(mailboxes.id, [...only])))
      .orderBy(asc(mailboxes.id)),
    { mode: "share" },
  );
}

/**
 * The rows `where` names, as the predicate of an UPDATE or DELETE that writes several of them: they
 * are locked in id order first, `id in (select id … order by id for no key update)`. `no key update`
 * is what an UPDATE of the other columns takes anyway, so the statement waits on nothing new; a
 * DELETE passes `update`. Raw, as the doorbell's sub-select in `send-service.ts`: a locked builder
 * inside a statement renders otherwise. The device store's clause is empty (one writer).
 */
export function mailboxRowsInIdOrder(d: Dialect, where: SQL, mode: LockMode = "no key update"): SQL {
  return sql`${mailboxes.id} in (select ${mailboxes.id} from ${mailboxes} where ${where} order by ${mailboxes.id} ${d.lockClause({ mode })})`;
}
