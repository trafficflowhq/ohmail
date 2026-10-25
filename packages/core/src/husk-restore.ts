import { and, eq, isNull, sql } from "drizzle-orm";
import {
  applyBodyBytesDelta, bodyBytesOf, lockAccountStorage, messageBodies, messages, recordChange,
  recordRefilledForSpace, reserveBodyBytes, EVICT_LOW_WATER_RATIO,
  type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { fingerprintDedupKey, messageFingerprint, normalizeMessageId, runtimeDedupKey } from "./identity.js";
import { prepareHtmlForStorage } from "./html-storage.js";
import { reindexMessageSearch } from "./message-search.js";
import type { NormalizedMessage } from "./types.js";

/**
 * Un-husking a `junk_filed` body — the one verify/rewrite both restore doors share. A spam
 * verdict that filed to native `\Junk` husked the stored body (mail 0065): the bytes live on in
 * Junk, the master. Two doors out: the "Not junk" rescue, and everything else — the worker's scan
 * sees the message alive in a watched folder with a husked body. Both end here: the identity
 * witness, the at-cap posture and the byte accounting are POLICY. The witness: normalized
 * Message-ID, or the fingerprint reproducing the husk's dedup key; an unresolved locator writes
 * NOTHING. The lock-and-recheck is the idempotency: `FOR UPDATE`, the reason must still stand —
 * one restore, whoever wins. At cap the husk STANDS: a declined reserve aborts the rewrite.
 */
export type JunkUnhuskOutcome = "restored" | "not_husked" | "identity_mismatch" | "at_cap";

/** The husk row's identity, as both doors already select it. */
export interface JunkHuskIdentity {
  id: string;
  dedupKey: string;
  messageIdHeader: string | null;
}

/** The two-witness identity check — see the module header for why it is load-bearing. */
export function isHuskSameMessage(husk: JunkHuskIdentity, fresh: NormalizedMessage): boolean {
  if (fingerprintDedupKey(messageFingerprint(fresh)) === husk.dedupKey || runtimeDedupKey(fresh) === husk.dedupKey) return true;
  const stored = normalizeMessageId(husk.messageIdHeader);
  const got = normalizeMessageId(fresh.canonical.messageIdHeader);
  return stored !== null && got !== null && stored === got;
}

/**
 * VERIFY + REWRITE for one `junk_filed` husk whose bytes the caller re-read. Opens its own
 * transaction (a savepoint when the caller is already inside one — the worker's fence), takes
 * the row lock only after the caller's network read is done, and answers what happened; it
 * never throws for a policy outcome, only for infrastructure.
 */
export async function unhuskJunkFiledBody(db: Tx, args: {
  accountId: string;
  husk: JunkHuskIdentity;
  fresh: NormalizedMessage;
  /** The account's cap in bytes; `null` = the unmetered tier's declaration. */
  capBytes: number | null;
  now?: Date;
}): Promise<JunkUnhuskOutcome> {
  const { accountId, husk, fresh, capBytes } = args;
  if (!isHuskSameMessage(husk, fresh)) return "identity_mismatch";

  const d = dialect(db);
  return db.transaction(async (tx) => {
    const [live] = await d.forUpdate(tx
      .select({ text: messageBodies.text, html: messageBodies.html, withheld: messageBodies.withheldReason })
      .from(messageBodies)
      .where(eq(messageBodies.messageId, husk.id))
      .limit(1));
    if (live?.withheld !== "junk_filed") return "not_husked"; // restored already, or another policy's husk
    const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
    const oldBytes = bodyBytesOf({ text: live.text ?? "", html: live.html ?? null });
    const newBytes = bodyBytesOf({ text: fresh.textBody, html: storedHtml });
    const grow = newBytes - oldBytes;
    if (grow > 0) {
      if (!(await reserveBodyBytes(tx, d, accountId, grow, capBytes))) return "at_cap";
    } else if (grow < 0) {
      await applyBodyBytesDelta(tx, d, accountId, grow);
    }
    await tx.update(messageBodies).set({
      text: fresh.textBody,
      html: storedHtml,
      withheldReason: null,
    }).where(eq(messageBodies.messageId, husk.id));
    // The refilled body's words, in the same transaction (mail 0125).
    await reindexMessageSearch(tx as unknown as Tx, accountId, husk.id);
    await tx.update(messages).set({
      snippet: fresh.textBody.replace(/\s+/g, " ").trim().slice(0, 200),
      updatedAt: args.now ?? new Date(),
    }).where(and(eq(messages.id, husk.id), eq(messages.accountId, accountId)));
    await recordChange(tx, {
      accountId, entityType: "message", entityId: husk.id, op: "update", meta: null,
    });
    return "restored";
  });
}

/**
 * What one storage refill did: `grew` is how many bytes the counter moved by (or would have).
 * `gone` is a message that left this mailbox's live letters between the read and the lock.
 */
export type StorageCapRefill =
  | { outcome: "refilled"; grew: number }
  | { outcome: "no_room"; grew: number }
  | { outcome: "not_capped" }
  | { outcome: "gone" }
  | { outcome: "identity_mismatch" };

/**
 * VERIFY + REWRITE for one `storage_cap` husk whose bytes the storage refill re-read from the mail
 * server. The counter row is locked first and the room is read under that lock: the text comes back
 * only while the counter stays at or under the trim's mark (`EVICT_LOW_WATER_RATIO` of the cap),
 * so a letter the trim just emptied never fits the room it left. The body is re-checked under its
 * own lock, so a letter refilled by someone else is never counted twice. The snippet is left alone:
 * the trim never cleared it.
 */
export async function refillStorageCapBody(db: Tx, args: {
  accountId: string;
  mailboxId: string;
  husk: JunkHuskIdentity;
  fresh: NormalizedMessage;
  capBytes: number;
  now?: Date;
}): Promise<StorageCapRefill> {
  const { accountId, mailboxId, husk, fresh, capBytes } = args;
  if (!isHuskSameMessage(husk, fresh)) return { outcome: "identity_mismatch" };

  const d = dialect(db);
  const mark = Math.floor(capBytes * EVICT_LOW_WATER_RATIO);
  return db.transaction(async (tx) => {
    const used = await lockAccountStorage(tx, d, accountId);
    const [letter] = await tx.select({
      at: sql<Date>`coalesce(${messages.date}, ${messages.createdAt})`.mapWith(messages.createdAt),
    }).from(messages).where(and(
      eq(messages.id, husk.id), eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId),
      isNull(messages.deletedAt),
    )).limit(1);
    if (!letter) return { outcome: "gone" } as const;
    const [live] = await d.forUpdate(tx
      .select({ text: messageBodies.text, html: messageBodies.html, withheld: messageBodies.withheldReason })
      .from(messageBodies)
      .where(eq(messageBodies.messageId, husk.id))
      .limit(1));
    if (live?.withheld !== "storage_cap") return { outcome: "not_capped" } as const;
    // Stored exactly as ingest stores a body: the text, and the html through the one storage gate.
    const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
    const grew = bodyBytesOf({ text: fresh.textBody, html: storedHtml })
      - bodyBytesOf({ text: live.text ?? "", html: live.html ?? null });
    if (used + grew > mark) return { outcome: "no_room", grew } as const;
    await tx.update(messageBodies).set({
      text: fresh.textBody,
      html: storedHtml,
      withheldReason: null,
    }).where(eq(messageBodies.messageId, husk.id));
    await recordRefilledForSpace(tx, d, accountId, grew, letter.at);
    await reindexMessageSearch(tx as unknown as Tx, accountId, husk.id);
    await tx.update(messages).set({ updatedAt: args.now ?? new Date() })
      .where(and(eq(messages.id, husk.id), eq(messages.accountId, accountId)));
    await recordChange(tx, {
      accountId, entityType: "message", entityId: husk.id, op: "update", meta: null,
    });
    return { outcome: "refilled", grew } as const;
  });
}
