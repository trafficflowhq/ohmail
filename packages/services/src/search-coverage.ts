import { sql, type SQL } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { ServiceContext } from "./context.js";

/** A canonical uuid, the only account id this module ever spells as a literal. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DOES THE STORE HOLD THE WHOLE MAILBOX YET? Not while any of the account's mailboxes still has
 * its first import open: mail 0038's per-mailbox stamp, the one the sync line reads, written by the
 * worker and by the engine on a desktop or phone. A removed or erased mailbox is not coming in.
 * `inline` spells a uuid account as a literal so a statement that carries no parameter (the search
 * session's warm settings) can hold the fact; any other id is bound.
 */
export function importOpen(accountId: string, opts: { inline?: boolean } = {}): SQL {
  const account = opts.inline === true && UUID.test(accountId) ? sql.raw(`'${accountId.toLowerCase()}'`) : sql`${accountId}`;
  return sql`exists (select 1 from ${mailboxes} where ${mailboxes.accountId} = ${account}
    and ${mailboxes.status} <> 'disabled' and ${mailboxes.erasedAt} is null
    and ${mailboxes.initialImportCompletedAt} is null)`;
}

/** A positional boolean as either store answers it: Postgres a boolean, the device 1 or 0. */
export function truthy(v: unknown): boolean {
  return v === true || v === 1;
}

/** The fact read on its own, for a store with no search session (the device). */
export async function storeStillImporting(ctx: ServiceContext): Promise<boolean> {
  const [row] = await dialect(ctx.db).exec(ctx.db, sql`select ${importOpen(ctx.accountId)} as open`);
  return truthy(row?.[0]);
}
