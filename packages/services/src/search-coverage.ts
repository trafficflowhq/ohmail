import { and, eq, isNull, ne } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";

/**
 * DOES THE STORE HOLD THE WHOLE MAILBOX YET? Not while any of the account's mailboxes still has
 * its first import open: mail 0038's per-mailbox stamp, the one the sync line reads, written by
 * the worker and by the engine on a desktop or phone. A removed or erased mailbox is not coming
 * in. Every search answer carries this, so "your whole mailbox" is said only over a store that
 * has taken all of it in.
 */
export async function storeStillImporting(ctx: ServiceContext): Promise<boolean> {
  const open = await ctx.db.select({ id: mailboxes.id }).from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, ctx.accountId), ne(mailboxes.status, "disabled"),
      isNull(mailboxes.erasedAt), isNull(mailboxes.initialImportCompletedAt),
    ))
    .limit(1);
  return open.length > 0;
}
