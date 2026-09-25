import { sql, type SQL } from "drizzle-orm";

/**
 * EVERY MESSAGE THE ACCOUNT OWNS: its own rows, the deleted ones out. History's list, History's
 * total and each mailbox's count in Settings ask this one question, so they state it once — the
 * mailbox count wrote its own WHERE and counted the deleted rows History leaves out.
 * `from` is the table or alias the statement names; the condition is also the History index's
 * partial predicate (`messages_account_msg_order_idx`).
 */
export function ownedMessages(accountId: string, from = "messages"): SQL {
  const t = sql.identifier(from);
  return sql`${t}.account_id = ${accountId} and ${t}.deleted_at is null`;
}
