import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "./change-log.js";
import { contacts } from "./schema-mail.js";

/**
 * A PERSON'S ACT OUTRANKS INFERENCE (`contacts.source`, mail 0147): the rows an automatic writer
 * made for these addresses become a person's. Asked by every person-side writer after its insert,
 * which conflicts silently on an existing row. Nothing downgrades a row, and a NULL row already
 * reads as a person's, so only `'inferred'` is touched.
 */
export async function upgradeContactsToPerson(
  tx: Tx, accountId: string, addresses: readonly string[],
): Promise<void> {
  if (addresses.length === 0) return;
  await tx.update(contacts).set({ source: "person" })
    .where(and(eq(contacts.accountId, accountId), inArray(contacts.address, [...addresses]),
      eq(contacts.source, "inferred")));
}
