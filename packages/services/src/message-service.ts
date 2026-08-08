import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  messages, folderState, flagState, messageBodies, claimIdempotencyKey, recordChange, type Tx,
} from "@trafficflow/db";
import type { Destination, NativeLocator } from "@trafficflow/core/mail";
import { httpsUnsubscribeUri, unsubscribeHeaderState } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { materializeMessage } from "./dto/materialize.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Folder, MessageBodyBatchItem, MessageBodyDTO, MessageDTO, Page } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
/** Materialize inside the ambient tx (reads its uncommitted writes) — same query surface as Db. */
const asDb = (tx: Tx): Db => tx as unknown as Db;

/** The six canonical folders a message may live in / be moved to (core `Destination`). */
const FOLDERS: Destination[] = [
  "INBOX", "ohmail/Screener", "ohmail/Reads",
  "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];
const FOLDER_SET = new Set<string>(FOLDERS);

/**
 * The seven client "views". Five map directly to a `folder_state.desiredFolder`;
 * `new_for_you`/`previously_seen` are the unread/read split of the Imbox (INBOX).
 */
export type MessageView =
  | "imbox" | "feed" | "paper_trail" | "screened" | "quarantine"
  | "new_for_you" | "previously_seen";

const VIEW_FOLDER: Record<MessageView, Destination> = {
  imbox: "INBOX",
  feed: "ohmail/Reads",
  paper_trail: "ohmail/Receipts",
  screened: "ohmail/Screened",
  quarantine: "ohmail/Quarantine",
  new_for_you: "INBOX",
  previously_seen: "INBOX",
};
/** null ⇒ no unread constraint; the two Imbox splits pin unread true/false. */
const VIEW_UNREAD: Partial<Record<MessageView, boolean>> = {
  new_for_you: true,
  previously_seen: false,
};

export interface ListMessagesOptions {
  view: string;          // validated against MessageView (400 on unknown)
  cursor?: string;
  limit?: number;
}

export interface MessagePatchBody {
  unread?: boolean;
  folder?: string;
}

/** `PATCH /messages` — one read-state decision applied to up to {@link MARK_SEEN_MAX_IDS} messages. */
export interface MarkSeenBody {
  ids?: unknown;
  unread?: unknown;
}

/**
 * The batch cap, and why there is one at all.
 *
 * The route runs ONE transaction that allocates one `change_log` seq per message from a row
 * lock on `account_sync_state`, so the transaction's duration is the window during which
 * every other mutation on this account blocks. An uncapped "select all, mark read" on a
 * very large mailbox would hold that lock for tens of thousands of allocations and as many
 * updates, on a platform with a 60 s `maxDuration` — the request dies mid-flight and the client
 * retries the same impossible thing.
 *
 * 200 is the same number as `DEFAULT_SYNC_BATCH_MAX_MESSAGES`, deliberately: it is already the
 * batch size the system is tuned for end to end, and a second, different "how many is too many"
 * would be a number nobody could justify. A client with more than 200 sends more than one
 * request, which is also what makes progress visible.
 */
export const MARK_SEEN_MAX_IDS = 200;

/** A batch read-state result: the updated DTOs plus the LAST emitted seq for `X-Sync-Seq`. */
export interface MarkSeenResult {
  items: MessageDTO[];
  seq: number | null;
}

/** Postgres would raise 22P02 on a malformed uuid, which is a 500 for what is plainly a 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MoveBody {
  folder: string;
}

/** Idempotency handle the route threads in when an `Idempotency-Key` is present. */
export interface MoveIdempotency {
  key: string;
  requestHash: string;
}

/** A move's result: the DTO plus the `move` change seq to echo as `X-Sync-Seq`. */
export interface MoveResult {
  dto: MessageDTO;
  seq: number;
}

/**
 * A patch's result. `seq` is the LAST emitted change seq (null when the patch was
 * a no-op — neither `unread` nor `folder` supplied).
 */
export interface PatchResult {
  dto: MessageDTO;
  seq: number | null;
}

// ── (date, id) keyset cursor. The list is ordered by `date desc, id desc`; the
// cursor carries both components so the next page resumes exactly after the last
// row under that composite order (the plain id-cursor helper only base64s the
// opaque payload string). ──
function encodeMsgCursor(date: Date | null, id: string): string {
  return encodeListCursor(`${date ? date.getTime() : 0}:${id}`);
}
function decodeMsgCursor(cursor: string): { date: Date; id: string } {
  const raw = decodeListCursor(cursor);
  const i = raw.indexOf(":");
  return { date: new Date(Number(raw.slice(0, i))), id: raw.slice(i + 1) };
}

export interface GetBodiesOptions {
  /** Opaque keyset cursor — the last `messages.id` a previous page returned. */
  after?: string;
  limit?: number;
  /**
   * THE OTHER MODE: name the messages instead of paging through them.
   *
   * Present ⇒ `after`/`limit` are ignored and exactly these ids are answered, capped at
   * {@link BODIES_IDS_MAX}. It exists for the thread open — a conversation needs its siblings'
   * bodies at once, and asking per message is N requests through the client's own concurrency
   * limiter, so the tail of a thread does not begin loading until a whole round trip has finished.
   *
   * The two modes are the SAME ROUTE because they are the same read of the same rows under the
   * same `cost: "read"` and the same ownership proof; only the row selection differs. A second
   * route would have been a second place for the account scoping to be written.
   */
  ids?: string[];
}

/**
 * The batch text pull bounds, and why each one exists on a `maxDuration = 60` lambda.
 *
 * `limit` defaults to 50 and is capped at 100: each row here is a whole stored body — the
 * redacted `text`, and for non-sensitive mail the sanitized `html` — not a compact DTO, so a
 * page is far heavier than a list page and 100 is the most rows one request may name.
 *
 * The BYTE BUDGET is the real fence, because the count cap alone is not one. A single page of
 * newsletter html can be hundreds of KiB, so 100 marketing bodies would push megabytes through
 * the lambda and past its time budget. Accumulated `text` + `html` is measured as the page is
 * assembled and the page stops early once it crosses ~4 MiB, returning a `nextCursor` so the
 * client resumes exactly after the last row it received. At least one row is always returned
 * even when it alone exceeds the budget — otherwise one oversized body would stall pagination
 * for ever.
 */
export const BODIES_DEFAULT_LIMIT = 50;
export const BODIES_MAX_LIMIT = 100;

/**
 * How many ids `?ids=` may name.
 *
 * Twenty rather than the keyset mode's hundred, because this mode is INTERACTIVE — a reader is
 * waiting for it with a thread half-drawn — and because the id list is a client-chosen set rather
 * than a page the server controls. It is well past any conversation a reader scrolls.
 *
 * OVER THE CAP IS A REFUSAL, NOT A TRUNCATION, and that asymmetry with `limit` (which clamps) is
 * deliberate: a clamped page is honest because it carries a cursor for the rest, while a truncated
 * id list is indistinguishable from "those messages have no body" and the caller cannot tell which
 * of the two it got. The client splits its own list — see `BODIES_IDS_MAX` in the engine — so this
 * is a contract guard rather than a state the product reaches.
 */
export const BODIES_IDS_MAX = 20;
export const BODIES_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * MessageService — the read/patch/move surface over `messages`.
 * Reads are account-scoped (a cross-account id is a 404). Every client-visible
 * mutation runs ONE short `db.transaction` that writes the entity + a `change_log`
 * row — and, for a move, DEFERS the physical IMAP move to the worker:
 * the handler only writes `folder_state` desired=<target>, lastSetBy='us',
 * reconcileStatus='pending'; the always-on worker's `reconcileMailbox` performs the
 * IMAP move on its next cycle. The API NEVER opens an IMAP connection.
 */
export class MessageService {
  async list(ctx: ServiceContext, opts: ListMessagesOptions): Promise<Page<MessageDTO>> {
    const view = this.validView(opts.view);
    const limit = clampLimit(opts.limit);
    const desiredFolder = VIEW_FOLDER[view];
    const unread = VIEW_UNREAD[view];

    const filters = [
      eq(messages.accountId, ctx.accountId),
      eq(folderState.desiredFolder, desiredFolder),
    ];
    if (unread !== undefined) filters.push(eq(messages.unread, unread));
    if (opts.cursor) {
      const c = decodeMsgCursor(opts.cursor);
      // Keyset for `date desc, id desc`: strictly "older" rows than the cursor tuple.
      filters.push(or(lt(messages.date, c.date), and(eq(messages.date, c.date), lt(messages.id, c.id)))!);
    }

    const rows = await ctx.db.select({ id: messages.id, date: messages.date }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters))
      .orderBy(desc(messages.date), desc(messages.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items: MessageDTO[] = [];
    for (const r of pageRows) {
      const dto = await materializeMessage(ctx.db, ctx.accountId, r.id);
      if (dto) items.push(dto);
    }
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > limit && last ? encodeMsgCursor(last.date, last.id) : null;
    return { items, nextCursor };
  }

  async get(ctx: ServiceContext, id: string): Promise<MessageDTO> {
    // materializeMessage already scopes by accountId → null covers both missing
    // and cross-account (IDOR): indistinguishable, both 404.
    const dto = await materializeMessage(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("not_found", 404, "message not found");
    return dto;
  }

  async getBody(ctx: ServiceContext, id: string): Promise<MessageBodyDTO> {
    // message_bodies has NO account_id column → we MUST prove ownership through
    // `messages` FIRST, otherwise the body is an IDOR read.
    const [msg] = await ctx.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
    if (!msg) throw new ServiceError("not_found", 404, "message not found");

    const [body] = await ctx.db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, id)).limit(1);
    // The stored `text` is already sensitivity-redacted — returned as-is,
    // never re-derived. A message with no ingested body yields an empty body.
    const headers = (body?.headers as Record<string, unknown>) ?? {};
    // The unsubscribe posture is DERIVED here, from the raw headers this endpoint already holds,
    // and only the enum + optional https link cross the wire — the raw headers do NOT enter the
    // client mirror. `unsubscribeUrl` is the sender's own https page and rides only the
    // `not_one_click` case (one-click is acted on by the server route, whose POST token never
    // reaches the client).
    const unsubscribe = unsubscribeHeaderState(headers);
    return {
      messageId: id,
      text: body?.text ?? "",
      html: body?.html ?? null,
      headers,
      loadedRemoteContent: body?.loadedRemoteContent ?? false,
      unsubscribe,
      unsubscribeUrl: unsubscribe === "not_one_click" ? httpsUnsubscribeUri(headers) : null,
    };
  }

  /**
   * The batch text pull — the foundation of the macOS Cloud-local text mirror.
   *
   * Keyset-paginates the account's message bodies by `messages.id` (ascending), returning the
   * STORED ROW VERBATIM: `text` is already sensitivity-redacted and positively-sensitive mail
   * has `html: null` at write time (`packages/core/src/pipeline.ts`), so this NEVER re-derives a
   * secret and NEVER rehydrates. Ownership is proven through `messages` — `message_bodies` has no
   * `account_id`, exactly as {@link getBody} handles it — and the query LEFT-JOINs
   * `message_bodies` and joins NOTHING ELSE: no headers, no attachment bytes, no other table.
   * That absence IS the no-rehydrate guarantee, so there is deliberately no rehydrate path here.
   */
  async getBodies(ctx: ServiceContext, opts: GetBodiesOptions): Promise<Page<MessageBodyBatchItem>> {
    if (opts.ids !== undefined) return this.getBodiesByIds(ctx, opts.ids);
    const limit = Math.min(Math.max(1, opts.limit ?? BODIES_DEFAULT_LIMIT), BODIES_MAX_LIMIT);

    const filters = [eq(messages.accountId, ctx.accountId)];
    if (opts.after) {
      const after = decodeListCursor(opts.after);
      // The cursor is a message id; a malformed one would reach Postgres and raise 22P02 — a 500
      // for a plainly bad request. Reject it as a 400 first, the same guard `markSeen` applies.
      if (!UUID_RE.test(after)) throw new ServiceError("validation_failed", 400, "invalid cursor");
      filters.push(gt(messages.id, after));
    }

    // `limit + 1`: the extra row is how a further page is detected without a second query.
    const rows = await ctx.db.select({
      messageId: messages.id,
      text: messageBodies.text,
      html: messageBodies.html,
      loadedRemoteContent: messageBodies.loadedRemoteContent,
    }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(...filters))
      .orderBy(asc(messages.id))
      .limit(limit + 1);

    const items: MessageBodyBatchItem[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, limit)) {
      const text = r.text ?? "";
      const html = r.html ?? null;
      items.push({ messageId: r.messageId, text, html, loadedRemoteContent: r.loadedRemoteContent ?? false });
      bytes += Buffer.byteLength(text, "utf8") + (html ? Buffer.byteLength(html, "utf8") : 0);
      // Stop AFTER including the row that crossed the budget, so at least one row always makes
      // progress; the cursor below carries the rest.
      if (bytes >= BODIES_BYTE_BUDGET) break;
    }

    // A next page exists iff a fetched row sits beyond the last one included — either the
    // `limit + 1` sentinel, or a row skipped when the byte budget stopped the loop early.
    const last = items[items.length - 1];
    const nextCursor = last && items.length < rows.length ? encodeListCursor(last.messageId) : null;
    return { items, nextCursor };
  }

  /**
   * `GET /messages/bodies?ids=…` — the NAMED-IDS mode of the same route. The thread open.
   *
   * ── AN ID THIS ACCOUNT DOES NOT OWN IS SIMPLY ABSENT ──────────────────────────────────────
   *
   * Ownership is proven the same way {@link getBody} and the keyset mode prove it —
   * `message_bodies` has no `account_id`, so the join through `messages` with
   * `eq(messages.accountId, …)` IS the authorization — but the RESPONSE to a foreign id differs
   * from the batch read-state route's, and the difference is deliberate on both sides.
   * `PATCH /messages` REJECTS the whole request on a foreign id because it is a write and a
   * partial batch would be unrepresentable. This is a read, and a read that answered 404 for
   * "you do not own this" would be an existence oracle: a probe could walk ids and learn which
   * exist in someone else's account from the status code. Absent is the only answer that
   * distinguishes nothing — an unknown id, another account's id and a deleted id are one outcome.
   *
   * The caller therefore matches rows by `messageId` and must treat a short answer as normal.
   *
   * ── AND THIS MODE JOINS THE HEADERS, WHICH THE KEYSET MODE MUST NOT ───────────────────────
   *
   * The keyset mode feeds the macOS local text mirror and joins NOTHING but the body row: that
   * absence IS its no-rehydrate guarantee, and it is asserted structurally (the wire item's key
   * set is pinned). This mode feeds a READER — the same surface `getBody` feeds — so it owes the
   * same unsubscribe posture, or a thread's siblings would silently lose a control the message
   * above them has. The raw headers still never cross the wire: what leaves is the derived enum
   * plus, for `not_one_click` only, the sender's own https page, exactly as `getBody` does it.
   * Deriving it here rather than re-deriving it in the client keeps one implementation of the
   * rule.
   *
   * NO BYTE BUDGET SHORTCUT AND NO CURSOR. The budget still applies — a thread of twenty
   * newsletters is real — but there is no cursor to resume from, so a truncated answer is simply
   * a short one and the client asks for what is missing per message. `nextCursor` is `null`
   * always: this mode does not page.
   */
  private async getBodiesByIds(
    ctx: ServiceContext,
    ids: string[],
  ): Promise<Page<MessageBodyBatchItem>> {
    if (ids.length === 0) return { items: [], nextCursor: null };
    if (ids.length > BODIES_IDS_MAX) {
      throw new ServiceError(
        "validation_failed", 400, `at most ${BODIES_IDS_MAX} ids may be requested at once`,
      );
    }
    // A malformed id would reach Postgres and raise 22P02 — a 500 for a plainly bad request. The
    // same guard the cursor gets above, and it leaks nothing: whether a string is a uuid is
    // decidable without the database.
    for (const id of ids) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        throw new ServiceError("validation_failed", 400, "invalid message id");
      }
    }

    const rows = await ctx.db.select({
      messageId: messages.id,
      text: messageBodies.text,
      html: messageBodies.html,
      headers: messageBodies.headers,
      loadedRemoteContent: messageBodies.loadedRemoteContent,
    }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, ids)))
      .orderBy(asc(messages.id))
      .limit(BODIES_IDS_MAX);

    const items: MessageBodyBatchItem[] = [];
    let bytes = 0;
    for (const r of rows) {
      const text = r.text ?? "";
      const html = r.html ?? null;
      const headers = (r.headers as Record<string, unknown>) ?? {};
      const unsubscribe = unsubscribeHeaderState(headers);
      items.push({
        messageId: r.messageId,
        text,
        html,
        loadedRemoteContent: r.loadedRemoteContent ?? false,
        unsubscribe,
        unsubscribeUrl: unsubscribe === "not_one_click" ? httpsUnsubscribeUri(headers) : null,
      });
      bytes += Buffer.byteLength(text, "utf8") + (html ? Buffer.byteLength(html, "utf8") : 0);
      // Stop AFTER the row that crossed the budget, so one oversized body cannot starve the
      // answer entirely. What is left out is asked for per message by the client.
      if (bytes >= BODIES_BYTE_BUDGET) break;
    }
    return { items, nextCursor: null };
  }

  async patch(ctx: ServiceContext, id: string, body: MessagePatchBody): Promise<PatchResult> {
    const folder = body.folder !== undefined ? this.validFolder(body.folder) : undefined;
    if (body.unread !== undefined && typeof body.unread !== "boolean") {
      throw new ServiceError("validation_failed", 400, "unread must be a boolean");
    }

    const seq = await asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, unread: messages.unread, nativeLocator: messages.nativeLocator,
      }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      let last: bigint | null = null;

      if (body.unread !== undefined) {
        await tx.update(messages).set({
          unread: body.unread,
          // WHEN reading happened, stamped by the statement that decides THAT it happened.
          // Marking unread clears it: the message has no reading to be ordered by any more, and
          // leaving the old instant behind would file a message the user deliberately put back
          // into "Earlier" as recently finished with. See `messages.lastReadAt`.
          lastReadAt: body.unread ? null : ctx.now(),
          updatedAt: ctx.now(),
        }).where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId)));
        // The read model AND the intent, in the same transaction. Writing only `messages.unread`
        // was the original bug: the flag never reached the mailbox, so it survived nothing.
        await this.upsertDesiredSeen(tx, id, !msg.unread, !body.unread, ctx.now());
        last = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: id, op: "update", meta: null,
        });
      }

      if (folder !== undefined) {
        const observed = await this.observedFolder(tx, id, msg.nativeLocator);
        await this.upsertDesired(tx, id, observed, folder, ctx.now());
        last = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: id, op: "move",
          meta: { from: observed, to: folder },
        });
      }

      return last;
    });

    const dto = await materializeMessage(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("internal", 500, "message vanished after write");
    return { dto, seq: seq === null ? null : Number(seq) };
  }

  /**
   * `PATCH /messages { ids, unread }` — ONE read-state decision over up to
   * {@link MARK_SEEN_MAX_IDS} messages.
   *
   * It exists because the single-message PATCH could not express what the UI does. Marking a
   * selection read was N requests, N transactions and N seqs, so a client that lost the network
   * halfway left half a selection flipped and no way to tell which half; and the engine's
   * optimistic overlay had to guess an ordering the server never promised.
   *
   * FOUR properties, each one load-bearing:
   *
   *  · **ONE transaction.** All N updates, all N `change_log` rows and all N `flag_state`
   *    upserts commit together or not at all. A partial batch is unrepresentable, which is what
   *    lets the client apply its optimistic overlay to the whole selection.
   *  · **Account scoping is a REJECTION, not a filter.** One id belonging to another account fails
   *    the whole request with 404 and rolls back every other message in it. Silently skipping
   *    foreign ids would answer 200 to a probe and let it learn, from the response length,
   *    which ids exist in someone else's account — no cross-account disclosure is absolute and it
   *    binds here. Unknown and cross-account are the same 404, indistinguishable, for the same reason.
   *  · **One `recordChange` PER MESSAGE.** The delta feed is per-entity; a single change for a
   *    batch would be an entity id the client cannot resolve. The per-account seq stays gap-free
   *    because `allocateSeq` holds the counter row's lock for the whole transaction.
   *  · **`flag_state` desired-state only. NO IMAP.** The API never opens a connection
   *    to apply organization. This writes what the user wants; `reconcileFlags` in the worker
   *    puts `\Seen` on the real server on its next cycle.
   */
  async markSeen(ctx: ServiceContext, body: MarkSeenBody): Promise<MarkSeenResult> {
    if (typeof body.unread !== "boolean") {
      throw new ServiceError("validation_failed", 400, "unread must be a boolean");
    }
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new ServiceError("validation_failed", 400, "ids must be a non-empty array of message ids");
    }
    if (body.ids.length > MARK_SEEN_MAX_IDS) {
      throw new ServiceError(
        "payload_too_large", 413,
        `ids must contain at most ${MARK_SEEN_MAX_IDS} message ids`,
      );
    }
    for (const id of body.ids) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        throw new ServiceError("validation_failed", 400, "ids must be message ids");
      }
    }
    const unread = body.unread;
    // De-duplicated but ORDER-PRESERVING: the same id twice is one update and one change, and
    // the caller's order is the order the deltas land in.
    const ids = [...new Set(body.ids as string[])];

    const seq = await asTx(ctx).transaction(async (tx) => {
      const owned = await tx.select({ id: messages.id, unread: messages.unread })
        .from(messages)
        .where(and(inArray(messages.id, ids), eq(messages.accountId, ctx.accountId)));
      // The scoping predicate above is the whole of account scoping here. If the count does not match, at
      // least one id is missing or belongs to someone else — throw, and the transaction takes
      // every other write with it.
      if (owned.length !== ids.length) {
        throw new ServiceError("not_found", 404, "message not found");
      }
      const observedById = new Map(owned.map((m) => [m.id, !m.unread]));

      let last: bigint | null = null;
      // ONE instant for the whole batch, read once HERE rather than per row inside the loop. A
      // selection marked read in a single gesture is one reading event, so its members must not
      // spread themselves across the order by however long the transaction took: they tie, and
      // the sort's own id tiebreak keeps them in a stable order among themselves.
      const readAt = unread ? null : ctx.now();
      for (const id of ids) {
        await tx.update(messages).set({ unread, lastReadAt: readAt, updatedAt: ctx.now() })
          .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId)));
        await this.upsertDesiredSeen(tx, id, observedById.get(id) ?? false, !unread, ctx.now());
        last = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: id, op: "update", meta: null,
        });
      }
      return last;
    });

    const items: MessageDTO[] = [];
    for (const id of ids) {
      const dto = await materializeMessage(ctx.db, ctx.accountId, id);
      if (dto) items.push(dto);
    }
    return { items, seq: seq === null ? null : Number(seq) };
  }

  async move(
    ctx: ServiceContext, id: string, body: MoveBody,
    opts: { idempotency?: MoveIdempotency | null } = {},
  ): Promise<MoveResult> {
    const folder = this.validFolder(body.folder);

    return asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({ id: messages.id, nativeLocator: messages.nativeLocator }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      // Write DESIRED state only. observedFolder is the worker's truth — read
      // and PRESERVE it (never overwrite on conflict); the worker flips it when the
      // physical IMAP move lands. NO adapter, NO IMAP here.
      const observed = await this.observedFolder(tx, id, msg.nativeLocator);
      await this.upsertDesired(tx, id, observed, folder, ctx.now());
      const seqBig = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: id, op: "move",
        meta: { from: observed, to: folder },
      });
      const seq = Number(seqBig);

      const dto = await materializeMessage(asDb(tx), ctx.accountId, id);
      if (!dto) throw new ServiceError("internal", 500, "message vanished after write");

      // Store the verbatim response IN this tx so a commit-then-crash retry
      // replays the same 200 + seq (never re-executing the move). Copied from
      // PushService — services can't import packages/api, so we insert directly.
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: dto,
          seq: seq,
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return { dto, seq };
    });
  }

  // ── helpers ──

  /** The observed folder: the folder_state truth, else the message's native locator, else INBOX. */
  private async observedFolder(tx: Tx, id: string, nativeLocator: unknown): Promise<string> {
    const [fs] = await tx.select({ observedFolder: folderState.observedFolder }).from(folderState)
      .where(eq(folderState.messageId, id)).limit(1);
    if (fs) return fs.observedFolder;
    const loc = (nativeLocator as NativeLocator | null) ?? null;
    return loc?.folder ?? "INBOX";
  }

  /**
   * Upsert `flag_state` desired=<seen>, us — preserving `observed_seen` on conflict.
   *
   * `observedSeen` is only ever supplied for the INSERT, and the fallback is the message's
   * current `messages.unread`: before anyone has expressed an intent, the read model IS what the
   * server last told us. On conflict the column is deliberately omitted from the `set`, exactly
   * as `upsertDesired` omits `observedFolder` — the worker owns it, and an API request that
   * overwrote it would erase the record of what IMAP actually says and make the reconciler
   * believe it had already converged.
   *
   * `reconcileStatus` is therefore recomputed IN SQL against the STORED `observed_seen`, not
   * against the value guessed at call time: on the update path the caller's guess is stale by
   * definition. Both writers use the same rule — `pending` only when desired ≠ observed — so a
   * no-op click never queues an IMAP round trip.
   */
  private async upsertDesiredSeen(
    tx: Tx, id: string, observedSeen: boolean, desiredSeen: boolean, now: Date,
  ): Promise<void> {
    await tx.insert(flagState).values({
      messageId: id, desiredSeen, observedSeen,
      lastSetBy: "us", reconcileStatus: desiredSeen === observedSeen ? "reconciled" : "pending",
      conflict: false,
    }).onConflictDoUpdate({
      target: flagState.messageId,
      set: {
        desiredSeen, lastSetBy: "us", conflict: false, updatedAt: now,
        reconcileStatus: sql`case when ${flagState.observedSeen} = ${desiredSeen} then 'reconciled' else 'pending' end`,
      },
    });
  }

  /** Upsert folder_state desired=<folder>, pending, us — preserving observedFolder on conflict. */
  private async upsertDesired(tx: Tx, id: string, observed: string, folder: string, now: Date): Promise<void> {
    await tx.insert(folderState).values({
      messageId: id, desiredFolder: folder, observedFolder: observed,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      // observedFolder deliberately omitted → preserved (worker owns it).
      set: { desiredFolder: folder, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: now },
    });
  }

  private validView(v: string): MessageView {
    if (!(v in VIEW_FOLDER)) {
      throw new ServiceError("validation_failed", 400, "view must be one of imbox, feed, paper_trail, screened, quarantine, new_for_you, previously_seen");
    }
    return v as MessageView;
  }

  private validFolder(v: unknown): Folder {
    if (typeof v !== "string" || !FOLDER_SET.has(v)) {
      throw new ServiceError("validation_failed", 400, "folder is not a canonical folder");
    }
    return v as Folder;
  }
}

export const messageService = new MessageService();
