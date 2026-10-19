import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { folderState, messageInstances, messages, type Tx } from "@trafficflow/db";
import { BLANK_DEDUP_KEYS, type BlankMessageRow } from "../blank-repair.js";

/**
 * The store read behind `WorkerRepo.listBlankMessages` (`drizzle-repo.ts`), in its own module so the
 * phone's build can leave it out with the rest of the blank repair (`apps/sidecar/src/phone/aliases.js`
 * substitutes a twin that refuses; the phone runs no repair).
 *
 * Three reads: the rows, by key and by the columns an empty parse leaves empty, with their
 * folder_state; then their places, bounded; then how many places each holds, unbounded, so a count is
 * never the bound's. `to_addresses` is read off the row rather than compared in SQL, where one store
 * spells it jsonb and the other text.
 */
export async function listBlankMessageRows(db: Tx, mailboxId: string, placeLimit: number): Promise<BlankMessageRow[]> {
  const rows = await db.select({
    id: messages.id, to: messages.toAddresses,
    desired: folderState.desiredFolder, observed: folderState.observedFolder, lastSetBy: folderState.lastSetBy,
  }).from(messages)
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.mailboxId, mailboxId),
      inArray(messages.dedupKey, [...BLANK_DEDUP_KEYS]),
      isNull(messages.messageIdHeader), eq(messages.subject, ""), eq(messages.fromAddress, ""),
      isNull(messages.date), eq(messages.attachmentCount, 0), isNull(messages.deletedAt),
    ))
    .orderBy(asc(messages.id));
  const blank = rows.filter((r) => Array.isArray(r.to) && r.to.length === 0);
  if (blank.length === 0) return [];
  const places = await db.select({
    messageId: messageInstances.messageId, folder: messageInstances.folder,
    uidvalidity: messageInstances.uidvalidity, uid: messageInstances.uid, isPrimary: messageInstances.isPrimary,
  }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), inArray(messageInstances.messageId, blank.map((r) => r.id))))
    .orderBy(desc(messageInstances.isPrimary), asc(messageInstances.folder), asc(messageInstances.uid))
    .limit(placeLimit);
  const counted = await db.select({
    messageId: messageInstances.messageId, n: sql<number>`count(*)`.mapWith(Number),
  }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), inArray(messageInstances.messageId, blank.map((r) => r.id))))
    .groupBy(messageInstances.messageId);
  return blank.map((r) => ({
    messageId: r.id,
    places: places.filter((p) => p.messageId === r.id).map((p) => ({
      folder: p.folder, uidValidity: String(p.uidvalidity), uid: p.uid, isPrimary: p.isPrimary,
    })),
    placeCount: counted.find((c) => c.messageId === r.id)?.n ?? 0,
    folderState: r.desired !== null && r.observed !== null && r.lastSetBy !== null
      ? { desired: r.desired, observed: r.observed, lastSetBy: r.lastSetBy } : null,
  }));
}
