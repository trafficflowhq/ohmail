import { and, eq, exists, isNotNull } from "drizzle-orm";
import { messageBodies, messages } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * WHAT A LETTER GONE FROM THE SERVER KEEPS OF ITS HEADER BLOCK, and the only writes of
 * `message_bodies.headers` after ingest (`message-bodies-headers-write-once.test.ts`). When the
 * letter is known gone its block is cut down to {@link GONE_LETTER_HEADER_KEYS}; when it comes back
 * the whole block is written from its own bytes. Sender, recipients, subject and date stay in the
 * identity columns. Both writes act on one account's row, and neither writes a change row: every
 * read a person sees already skips a tombstone.
 */

/**
 * The lines readers of stored letters act on whether or not the letter is deleted:
 * `weAnsweredThisSenderWhere` (to, cc, in-reply-to, references), `autoReplyByUsWhere` and the
 * consent seed's review (the three automation lines), and the correspondent and threading reads.
 */
export const GONE_LETTER_HEADER_KEYS = [
  "to", "cc", "in-reply-to", "references", "auto-submitted", "precedence", "x-auto-response-suppress",
] as const;

/** The lines whose presence says a gone letter still holds a whole block (the tidy's question). */
export const WHOLE_BLOCK_HEADER_KEYS = [
  "from", "date", "subject", "message-id", "received", "content-type", "mime-version",
] as const;

/** A stored header map cut down to {@link GONE_LETTER_HEADER_KEYS}, reading own properties only. */
export function goneLetterHeaders(map: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of GONE_LETTER_HEADER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(map, key)) kept[key] = map[key];
  }
  return kept;
}

/** The stored block as a map: the device store may hand back its JSON as text; anything else reads empty. */
function blockOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Two header maps say the same, whatever order their keys were stored in. */
export function sameHeaderBlock(a: unknown, b: unknown): boolean {
  const canonical = (m: Record<string, unknown>): string =>
    JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
  return canonical(blockOf(a)) === canonical(blockOf(b));
}

/**
 * Cut a gone letter's stored block down: only on a tombstoned row of this account. The caller
 * holds that row (`scrubGone` updates it first), so a return committing beside it waits for the
 * cut or finds nothing to cut. Writes nothing when nothing would change. Returns whether it wrote.
 */
export async function reduceGoneHeaders(tx: Tx, accountId: string, messageId: string): Promise<boolean> {
  const gone = and(eq(messages.id, messageId), eq(messages.accountId, accountId), isNotNull(messages.deletedAt));
  const [body] = await tx.select({ headers: messageBodies.headers }).from(messageBodies).where(and(
    eq(messageBodies.messageId, messageId),
    exists(tx.select({ id: messages.id }).from(messages).where(gone)),
  )).limit(1);
  if (body === undefined) return false;
  const stored = blockOf(body.headers);
  if (Object.keys(goneLetterHeaders(stored)).length === Object.keys(stored).length) return false;
  await tx.update(messageBodies).set({ headers: goneLetterHeaders(stored) }).where(and(
    eq(messageBodies.messageId, messageId),
    exists(tx.select({ id: messages.id }).from(messages).where(gone)),
  ));
  return true;
}

/** Write a returned letter's whole block from its own bytes. Returns whether it wrote. */
export async function restoreLetterHeaders(
  tx: Tx, accountId: string, messageId: string, headers: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const own = and(eq(messages.id, messageId), eq(messages.accountId, accountId));
  const written = await tx.update(messageBodies).set({ headers: { ...headers } }).where(and(
    eq(messageBodies.messageId, messageId),
    exists(tx.select({ id: messages.id }).from(messages).where(own)),
  )).returning({ id: messageBodies.id });
  return written.length > 0;
}
