import { eq } from "drizzle-orm";
import { mailboxes, whyTheyStayed, WHY_STAYED_IDS_MAX, type StayedWhy, type Tx } from "@trafficflow/db";
import { isUuid } from "./ids.js";
import { ServiceError } from "./errors.js";

/**
 * `GET /screener/stayed` — why each named message stayed where it is when its sender's rule moved
 * the rest (`@trafficflow/db#whyTheyStayed`). A read: it moves nothing and opens no mailbox. Ids are
 * the caller's own messages, bounded, and an id that is not the account's simply answers nothing.
 */
export interface StayedItem { id: string; why: StayedWhy }

export async function whyStayed(db: Tx, accountId: string, ids: readonly string[]): Promise<StayedItem[]> {
  if (ids.length > WHY_STAYED_IDS_MAX) {
    throw new ServiceError("validation_failed", 400, `at most ${WHY_STAYED_IDS_MAX} ids`);
  }
  if (ids.some((id) => !isUuid(id))) throw new ServiceError("validation_failed", 400, "ids must be message ids");
  // The we-answered shield's own set, as the backlog pass reads it: every address the account has a
  // mailbox for, a removed one's included, since a reply sent from it is still the person's.
  const own = (await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId))).map((r) => r.address.toLowerCase());
  const found = await whyTheyStayed(db, accountId, ids, own);
  return [...found].map(([id, why]) => ({ id, why }));
}
export { WHY_STAYED_IDS_MAX };
