import { sql, type SQL } from "drizzle-orm";

/**
 * THE ACCOUNT OF A ROW'S PARENT, for an insert that holds the parent's id and not its account.
 *
 * Since mail 0201 `message_bodies`, `folder_state`, `flag_state`, `mailbox_credentials`,
 * `mailbox_folders` and `pairing_tokens` carry the account they used to borrow from their parent,
 * under a key onto the parent's `(id, account_id)`. Every insert into them names it. A writer
 * that has the account at hand writes the value; one whose signature carries only the parent's id
 * names one of these: a scalar subquery the statement runs per row, by primary key. It cannot
 * disagree with the parent, and it is NULL where there is no such parent, which a server refuses.
 * Plain SQL, the same text on both stores.
 */
export function accountOfMessage(messageId: string): SQL<string> {
  return sql<string>`(select account_id from messages where id = ${messageId})`;
}

/** {@link accountOfMessage} for a row that hangs off a mailbox. */
export function accountOfMailbox(mailboxId: string): SQL<string> {
  return sql<string>`(select account_id from mailboxes where id = ${mailboxId})`;
}

/** {@link accountOfMessage} for a row that hangs off a user. */
export function accountOfUser(userId: string): SQL<string> {
  return sql<string>`(select account_id from users where id = ${userId})`;
}
