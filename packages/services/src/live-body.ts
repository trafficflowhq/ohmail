import { and, desc, eq, isNull } from "drizzle-orm";
import { mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { isHuskSameMessage, normalizeMime, prepareHtmlForStorage, type NormalizedMessage } from "@trafficflow/core/mail";
import { ServiceError } from "./errors.js";
import { isUuid } from "./ids.js";
import type { ServiceContext } from "./context.js";

/**
 * LOAD IT NOW — the text of a letter emptied for space, read from the person's own mail server for one
 * view and never kept. One read, joining the message to its mailbox with both account predicates the
 * session's, so an unknown id and another account's answer the same 404; a letter whose text is kept
 * here is refused (409), as is one the server holds a different letter for. The per-account
 * admission, the IMAP door and its deadlines are the caller's ports. This writes NOTHING: no body,
 * no counter, no change row, no search words, no flag (the fetch is `BODY.PEEK`), and no content
 * reaches a log.
 */

/** Places on the server one load reads, primary first. */
export const LIVE_BODY_PLACES = 3;
/** The storage refill's per-letter ceiling: over it the letter stays empty here too. */
export const LIVE_BODY_MAX_BYTES = 8 * 1024 * 1024;
/** Letters one account may load in an hour (`reserveIpSlot`, namespace `live-body`, keyed by account). */
export const LIVE_BODY_PER_HOUR = 60;

/** One place the letter occupies on the server: a UID is a fact only under its epoch. */
export interface LiveBodyPlace {
  folder: string;
  uidvalidity: bigint;
  uid: number;
}

/** What the server answered for the letter's places, in the order asked. */
export type LiveBodyRead =
  | { raw: Uint8Array }
  /** No place still holds it under the epoch it was recorded at. */
  | { gone: true }
  /** Present, and over {@link LIVE_BODY_MAX_BYTES} by its own stated size. */
  | { oversize: true };

export interface LiveBodyPorts {
  /**
   * Admits one load for the session's account, or refuses it (429). Absent on a host that empties
   * no letter for space: such a host answers 409 before it is asked.
   */
  admit?: (ctx: ServiceContext) => Promise<boolean>;
  /** Reads the letter at its first place that holds it, on an admitted, deadline-bound connection. */
  read: (mailboxId: string, places: readonly LiveBodyPlace[], maxBytes: number) => Promise<LiveBodyRead>;
}

export interface LiveBody {
  text: string;
  /** Through the same gate a stored body passes (`prepareHtmlForStorage`). */
  html: string | null;
}

const notFound = (): ServiceError => new ServiceError("not_found", 404, "message not found");

export async function liveBody(ctx: ServiceContext, messageId: string, ports: LiveBodyPorts): Promise<LiveBody> {
  if (!isUuid(messageId)) throw notFound();
  const [row] = await ctx.db.select({
    mailboxId: messages.mailboxId, dedupKey: messages.dedupKey, messageIdHeader: messages.messageIdHeader,
    withheld: messageBodies.withheldReason,
  }).from(messages)
    .innerJoin(mailboxes, and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.accountId, ctx.accountId)))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId), isNull(messages.deletedAt)))
    .limit(1);
  if (!row) throw notFound();
  if (row.withheld !== "storage_cap") {
    throw new ServiceError("text_kept", 409, "this letter's text was not emptied for space, so there is nothing to load");
  }
  if (ports.admit && !(await ports.admit(ctx))) {
    throw new ServiceError("rate_limited", 429, "too many letters loaded from the mail server this hour; try again later",
      { retryAfter: 600 }, true);
  }
  const places = await ctx.db.select({
    folder: messageInstances.folder, uidvalidity: messageInstances.uidvalidity, uid: messageInstances.uid,
  }).from(messageInstances)
    .where(and(eq(messageInstances.messageId, messageId), eq(messageInstances.accountId, ctx.accountId)))
    .orderBy(desc(messageInstances.isPrimary), desc(messageInstances.lastSeenAt))
    .limit(LIVE_BODY_PLACES);
  const gone = (): ServiceError =>
    new ServiceError("letter_gone", 410, "the mail server no longer holds this letter where ohmail last saw it");
  if (places.length === 0) throw gone();
  const found = await ports.read(row.mailboxId, places, LIVE_BODY_MAX_BYTES);
  if ("gone" in found) throw gone();
  if ("oversize" in found) {
    throw new ServiceError("letter_too_large", 413, "this letter is too large to load here; it is complete on your mail server");
  }
  let fresh: NormalizedMessage;
  try {
    fresh = await normalizeMime(Buffer.from(found.raw));
  } catch {
    throw new ServiceError("letter_unreadable", 409, "this letter could not be read from the mail server");
  }
  // The place may hold another letter now (a folder renumbered without a new epoch): its text is refused.
  if (!isHuskSameMessage({ id: messageId, dedupKey: row.dedupKey, messageIdHeader: row.messageIdHeader }, fresh)) {
    throw new ServiceError("letter_mismatch", 409, "the mail server holds a different letter at this place, so nothing was shown");
  }
  return { text: fresh.textBody, html: prepareHtmlForStorage(fresh.htmlBody) };
}
