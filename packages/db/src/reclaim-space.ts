import { sql, type SQL } from "drizzle-orm";
import { onServerPool, rootOf } from "./bound.js";
import { dialect, dialectOf } from "./dialect/index.js";

/** The tables whose deleted bytes a device hands back: each holds a sent letter's files in pieces. */
export type ReclaimedTable = "outbound_sent_copies" | "scheduled_send_files";

/** One whole statement per table: a name is a key here and never text put into a statement. */
const RECLAIM: Readonly<Record<ReclaimedTable, SQL>> = {
  outbound_sent_copies: sql`VACUUM outbound_sent_copies`,
  scheduled_send_files: sql`VACUUM scheduled_send_files`,
};

/**
 * HAND A TABLE'S DELETED BYTES BACK, where nothing else does. The desktop's store (PGlite) runs no
 * autovacuum, so without this every file a letter was sent with stays in the store's files; SQLite
 * reuses its freed pages and is sent nothing. A server pool is sent nothing either: its own
 * autovacuum does this, and VACUUM is a session's statement, refused inside the transaction every
 * statement of a bound handle rides in. Sent on the store's own handle, outside any transaction; a
 * failure is left to the store's open, which reclaims the same space.
 */
export async function reclaimSpace(db: object, table: ReclaimedTable): Promise<void> {
  if (onServerPool(db) || dialectOf(db) !== "pg") return;
  if (!Object.prototype.hasOwnProperty.call(RECLAIM, table)) throw new TypeError("a table this store does not reclaim");
  const store = rootOf(db);
  await dialect(store).exec(store, RECLAIM[table]).catch(() => { /* the store's open reclaims it */ });
}
