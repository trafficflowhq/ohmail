import { sql, type SQL } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import type { ServiceContext } from "./context.js";

/** A canonical uuid, the only account id this module ever spells as a literal. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long an unwritten first-import stamp is read as an import in flight: the sync line's own
 * absolute window (`IMPORT_FLOOR_MAX_MS`, apps/webapp/app/shell/mail-state.ts), one number pinned
 * equal by test/import-floor-parity.test.ts. Past it the stamp alone is no grounds for the claim.
 */
export const IMPORT_OPEN_MAX_MS = 86_400_000;

/**
 * DOES THE STORE HOLD THE WHOLE MAILBOX YET? Not while any of the account's mailboxes still has
 * its first import open: mail 0038's per-mailbox stamp, the one the sync line reads, written by the
 * worker and by the engine on a desktop or phone, unwritten and connected within
 * {@link IMPORT_OPEN_MAX_MS} of `now`. A removed or erased mailbox is not coming in. `inline`
 * spells a uuid account and the instant as literals so a statement that carries no parameter (the
 * search session's warm settings, Postgres only) can hold the fact; any other id is bound.
 */
export function importOpen(d: Dialect, accountId: string, now: Date, opts: { inline?: boolean } = {}): SQL {
  const inline = opts.inline === true && d.name === "pg" && UUID.test(accountId);
  const account = inline ? sql.raw(`'${accountId.toLowerCase()}'`) : sql`${accountId}`;
  const since = new Date(now.getTime() - IMPORT_OPEN_MAX_MS);
  // An ISO instant is digits and punctuation; Postgres reads the quoted literal as the column's type.
  const floor = inline ? sql.raw(`'${since.toISOString()}'`) : d.ts(since);
  return sql`exists (select 1 from ${mailboxes} where ${mailboxes.accountId} = ${account}
    and ${mailboxes.status} <> 'disabled' and ${mailboxes.erasedAt} is null
    and ${mailboxes.initialImportCompletedAt} is null and ${mailboxes.createdAt} > ${floor})`;
}

/** A positional boolean as either store answers it: Postgres a boolean, the device 1 or 0. */
export function truthy(v: unknown): boolean {
  return v === true || v === 1;
}

/** The fact read on its own, for a store with no search session (the device). */
export async function storeStillImporting(ctx: ServiceContext): Promise<boolean> {
  const d = dialect(ctx.db);
  const [row] = await d.exec(ctx.db, sql`select ${importOpen(d, ctx.accountId, ctx.now())} as open`);
  return truthy(row?.[0]);
}
