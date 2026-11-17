import { eq } from "drizzle-orm";
import type { SubjectHeading } from "@ohmail/wire";
import { accountSettings } from "./schema-mail.js";
import { lockSettingsStamp, recordChanges, type LedgerTx, type Tx } from "./change-log.js";

/**
 * WHAT A PERSON STATED FOR EVERY INSTALL OF A MAILBOX, as this store holds it (mail 0210): each
 * member a closed word with the instant it was stated. The mailbox's settings copy carries the
 * pairs, and an organizer that does not know them writes a copy without them, so this row is what
 * holds a statement between two writes and what states it again.
 *
 * ONE RULE DECIDES BETWEEN TWO STATEMENTS, here and on every other install: the later instant
 * holds, and of two with one instant the word that sorts later. So taking the same copy in twice,
 * or two copies in either order, ends in the same row.
 *
 * NOTHING HERE CLEARS A MEMBER. A copy that states nothing leaves the row as it stands.
 *
 * Each writer takes the settings row first and the account's counter second, the one order every
 * settings writer keeps.
 */

/** The members an account holds, each with the instant it was stated; an absent member is not stated. */
export interface HeldPreferences {
  /** Where a conversation's subject stands in the reader. */
  subject?: { value: SubjectHeading; at: Date };
}

/**
 * The same members as the row stores them: the word is the stored text. Whoever publishes or shows
 * one holds it to its closed set first, so a word no set has is nothing stated there.
 */
export type StoredPreferences = { [M in keyof HeldPreferences]?: { value: string; at: Date } };

type Member = keyof HeldPreferences;

/** Each member's pair of columns: how the row is read into it and written from it. A new member is a new line. */
const MEMBERS: { [M in Member]: { set: (value: string, at: Date) => Partial<typeof accountSettings.$inferInsert> } } = {
  subject: { set: (value, at) => ({ subjectHeading: value, subjectHeadingAt: at }) },
};

/** What the account holds stated. A word without its instant, or an instant without its word, states nothing. */
export async function readPreferences(db: Tx, accountId: string): Promise<StoredPreferences> {
  const [row] = await db.select({
    subject: accountSettings.subjectHeading, subjectAt: accountSettings.subjectHeadingAt,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const out: StoredPreferences = {};
  if (row !== undefined && row.subject !== null && row.subjectAt !== null) {
    const at = new Date(row.subjectAt);
    if (Number.isFinite(at.getTime())) out.subject = { value: row.subject, at };
  }
  return out;
}

/**
 * A PERSON'S PRESS. The word is stated at `now`, or one millisecond after the statement the row
 * holds when that one is not earlier: a press always outranks what it replaces, also where the
 * held instant came from a clock ahead of this one. Inside the caller's transaction; rings the
 * settings record. Returns the pair as stored.
 */
export async function statePreference<M extends Member>(
  tx: LedgerTx, accountId: string, member: M, value: NonNullable<HeldPreferences[M]>["value"], now: Date,
): Promise<NonNullable<HeldPreferences[M]>> {
  const t = tx as unknown as Tx;
  await lockSettingsStamp(tx, accountId, now);
  const held = (await readPreferences(t, accountId))[member];
  const at = new Date(Math.max(now.getTime(), held === undefined ? -Infinity : held.at.getTime() + 1));
  await t.update(accountSettings).set({ ...MEMBERS[member].set(value, at), updatedAt: now })
    .where(eq(accountSettings.accountId, accountId));
  await recordChanges(tx, [{ accountId, entityType: "settings", entityId: accountId, op: "update" }]);
  return { value, at } as NonNullable<HeldPreferences[M]>;
}

/** Does `stated` hold over `held`: the later instant, and of two with one instant the word that sorts later. */
function outranks(stated: { value: string; at: Date }, held: { value: string; at: Date } | undefined): boolean {
  if (held === undefined) return true;
  const d = stated.at.getTime() - held.at.getTime();
  return d > 0 || (d === 0 && stated.value > held.value);
}

/**
 * WHAT A FOUND COPY STATES, TAKEN IN. Per member: written only when the stated pair outranks the
 * held one, with the stated instant kept, so the same copy taken in again changes nothing. A member
 * the copy does not state is left alone. Rings the settings record when a member moved, and only
 * then. Inside the caller's transaction; a copy that states nothing costs no statement.
 * Returns the members that moved.
 */
export async function adoptPreferences(
  tx: LedgerTx, accountId: string, stated: HeldPreferences, now: Date,
): Promise<Member[]> {
  const offered = (Object.keys(MEMBERS) as Member[]).filter((m) => {
    const s = stated[m];
    return s !== undefined && Number.isFinite(s.at.getTime());
  });
  if (offered.length === 0) return [];
  const t = tx as unknown as Tx;
  await lockSettingsStamp(tx, accountId, now);
  const held = await readPreferences(t, accountId);
  const moved = offered.filter((m) => outranks(stated[m]!, held[m]));
  if (moved.length === 0) return [];
  let set: Partial<typeof accountSettings.$inferInsert> = { updatedAt: now };
  for (const m of moved) set = { ...set, ...MEMBERS[m].set(stated[m]!.value, stated[m]!.at) };
  await t.update(accountSettings).set(set).where(eq(accountSettings.accountId, accountId));
  await recordChanges(tx, [{ accountId, entityType: "settings", entityId: accountId, op: "update" }]);
  return moved;
}
