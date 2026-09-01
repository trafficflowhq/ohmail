import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  mailboxes, messages, folderState, messageBodies, messageStates, claimIdempotencyKey, recordChange,
  upsertDesiredSeen, type LedgerTx, type Tx,
} from "@trafficflow/db";
import type { Destination, NativeLocator } from "@trafficflow/core/mail";
import { httpsUnsubscribeUri, unsubscribeHeaderState } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { foldersEnabled, userFolderById } from "./folders.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { materializeMessage } from "./dto/materialize.js";
import {
  clampLimit, clampPageLimit, decodeListCursor, decodeNullableKeysetCursor, encodeListCursor,
  encodeNullableKeysetCursor,
} from "./pagination.js";
import { requireUuid } from "./ids.js";
import type { Folder, MessageBodyBatchItem, MessageBodyDTO, MessageDTO, Page, WithheldMarker } from "./dto/types.js";

/**
 * The stored row's withheld marker as the wire carries it — the CLOSED set, projected verbatim
 * (mail 0062, widened by mail 0065). One function for the three body surfaces so they cannot
 * disagree about which markers exist; an unknown stored value is dropped rather than invented
 * into the union, which keeps a future migration's new reason a code deploy here first.
 */
function withheldOf(reason: string | null | undefined): { withheld: WithheldMarker } | Record<string, never> {
  return reason === "storage_cap" || reason === "junk_filed" || reason === "expunged"
    ? { withheld: reason }
    : {};
}

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
  view: string;          // validated against MessageView (400 on unknown), or "folder" + folderId
  cursor?: string;
  limit?: number;
  /**
   * With `view: "folder"`: one of the account's own folders by `folder` ENTITY id (the folders
   * foundation). The read is gated on the account's "Use folders" flag and scoped through the
   * mailbox join; an id that resolves to nothing — gone, excluded, another account's, or the
   * flag off — answers an EMPTY final page rather than an error, because every one of those is
   * a folder the interface no longer shows and a surface mid-transition must not render a
   * refusal about it.
   */
  folderId?: string;
  /**
   * With `view: "folder"` and NO cursor: start strictly below this keyset position — the
   * client mirror's boundary, so page one begins where the mirror ends. A cursor supersedes
   * it (the cursor is the position); the six fixed views ignore it entirely.
   */
  before?: { date: string | null; id: string };
}

export interface MessagePatchBody {
  unread?: boolean;
  folder?: string;
  /**
   * `"glance"` marks the surface's own involuntary read — the dwell commit, the stream sweep —
   * as opposed to a deliberate act. A glance-read LANDS (a resurfaced message keeps its genuine
   * read state, and reading it sticks — owner ruling 2026-08-26) but does NOT spend the
   * resurface pin: placement in Resurface is the attention signal, answered by dealing with the
   * row, and nobody pressed anything to get here. Absent ⇒ deliberate ⇒ spends.
   */
  via?: string;
}

/** `PATCH /messages` — one read-state decision applied to up to {@link MARK_SEEN_MAX_IDS} messages. */
export interface MarkSeenBody {
  ids?: unknown;
  unread?: unknown;
  /** See {@link MessagePatchBody.via} — the batch form carries the same label. */
  via?: unknown;
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

/**
 * ── (date, id) KEYSET, AND THE THIRD POSITION THE TUPLE USED TO LOSE ──────────────────────────
 *
 * The list is ordered by `date desc NULLS LAST, id desc`; the cursor carries both components so
 * the next page resumes exactly after the last row under that composite order.
 *
 * **`messages.date` IS NULLABLE and the null is a POSITION, not a missing value.** It is the
 * sender's own `Date:` header — `mime.ts:503` writes `parsed.date ?? null`, so any stranger can
 * produce one by omitting the header — and this encoder used to write epoch `0` for it. Two
 * separate defects came out of that one substitution:
 *
 *  1. **The undated tail was unreachable.** `0` says "1970-01-01", so the next page asked for rows
 *     strictly older than that. Every remaining undated row was skipped and the list simply ended
 *     early, with no cursor and nothing said.
 *  2. **The ORDER BY and the predicate disagreed inside this one class.** Drizzle's `desc()` emits
 *     bare `ORDER BY … DESC`, which in PostgreSQL is `DESC NULLS FIRST` — so undated mail sorted
 *     at the TOP of every view — while the `before` branch's predicate below (copied from
 *     `sync-service.ts:807-811`) was written for NULLS LAST. Rows were selected under one order
 *     and sorted under another.
 *
 * `nulls last` is not a new opinion: the snapshot bootstrap (`sync-service.ts:848`) already orders
 * that way with an explicit-null cursor, the Screener collapses null to epoch 0 in its own sort key
 * (`screener-service.ts:1137`), and the client mirror sorts a missing date last
 * (`client-engine/src/engine.ts:1886`). Three of the four surfaces already treated undated mail as
 * oldest; this one was the odd one out, and only because nobody wrote a `nulls` clause.
 */
function encodeMsgCursor(date: Date | null, id: string): string {
  return encodeNullableKeysetCursor(date === null ? null : date.getTime(), id);
}
function decodeMsgCursor(cursor: string): { date: Date | null; id: string } {
  // The KEYSET decoder, not the bare-id one: this family orders by (date, id). Using the shared
  // `decodeListCursor` for both made each shape valid on the other's routes, so a tuple sent to
  // `/contacts` bound `"1712…:<uuid>"` against a uuid column — the 22P02 the validator exists to
  // stop, reintroduced by the validator being too generous. The NULLABLE variant, because this is
  // the only family whose sort column admits one.
  const { millis, id } = decodeNullableKeysetCursor(cursor);
  return { date: millis === null ? null : new Date(millis), id };
}

/**
 * THE ONE KEYSET PREDICATE, so the cursor branch and the `before` branch cannot fork again.
 *
 * "Strictly after `(date, id)`" under `date desc nulls last, id desc`:
 *  · a DATED position — older dates, then the same date with a smaller id, then the whole undated
 *    tail, which sorts after every dated row;
 *  · an UNDATED position — only the rest of that tail, since nothing sorts after it.
 *
 * Identical to `sync-service.ts:807-811`, which is where the shape was already correct.
 */
function afterKeyset(pos: { date: Date | null; id: string }): SQL {
  return pos.date === null
    ? and(isNull(messages.date), lt(messages.id, pos.id))!
    : or(
        lt(messages.date, pos.date),
        and(eq(messages.date, pos.date), lt(messages.id, pos.id)),
        isNull(messages.date),
      )!;
}

/** `date desc NULLS LAST, id desc` — see {@link encodeMsgCursor} for why the clause is explicit. */
const MSG_ORDER = [sql`${messages.date} desc nulls last`, desc(messages.id)];

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
 * `limit` defaults to 50 and is capped at 100: each row here is a whole stored body — the full
 * `text` and the sanitized `html` — not a compact DTO, so a page is far heavier than a list page
 * and 100 is the most rows one request may name.
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
 * THE SIZE PROBE — how the byte budget bounds the TRANSFER and not merely the response.
 *
 * The budget used to be spent inside a loop over rows PostgreSQL had already sent and this process
 * had already materialized: the response was correctly bounded and the cost was not, which is the
 * definition of the class: a budget enforced after the read is not a budget. A sender chooses each body's size — the
 * IMAP raw-message ceiling admits roughly 32 MiB — so an authenticated `?limit=100` could pull
 * gigabytes over the wire and answer with a small page.
 *
 * `octet_length` is the reason a second query is cheaper than the first one was. For a `text`
 * column PostgreSQL answers it from the varlena header (`toast_raw_datum_size`) — the stored
 * length is read WITHOUT detoasting or transferring the value — so this projection costs a header
 * read per row and returns two integers. The prefix that fits the budget is then fetched for real.
 *
 * `octet_length` and NOT `length`: the budget is bytes and `length()` counts CHARACTERS, which for
 * any non-ASCII body (most mail) under-counts by up to a factor of four and would put the ceiling
 * back above the transfer it exists to bound. It is the same UTF-8 byte count
 * `Buffer.byteLength(x, "utf8")` produced when the accounting was done in JS, so the number the
 * budget compares against has not changed — only when it is known.
 */
const BODY_BYTES = sql<number>`coalesce(octet_length(${messageBodies.text}), 0)
  + coalesce(octet_length(${messageBodies.html}), 0)`;

/**
 * The longest prefix of `sized` whose cumulative bytes fit {@link BODIES_BYTE_BUDGET}, INCLUDING
 * the row that crosses it.
 *
 * Including the crossing row is the old loop's behaviour kept verbatim, and it is load-bearing in
 * both directions: at least one row is always returned, so a single oversized body cannot stall
 * pagination for ever, and the transfer is therefore bounded by the budget PLUS one row rather
 * than by the budget exactly. That "plus one row" is the honest statement of the bound.
 */
function prefixUnderBudget(sized: readonly { messageId: string; bytes: number | string | null }[]): string[] {
  const take: string[] = [];
  let bytes = 0;
  for (const r of sized) {
    take.push(r.messageId);
    // `octet_length` is int4 and postgres.js hands back a number, but a driver that widened it to
    // a string (bigint-safe modes do) would make `+=` a concatenation and the comparison always
    // false — an unbounded transfer restored by a driver setting. Normalize before adding.
    bytes += Number(r.bytes ?? 0) || 0;
    if (bytes >= BODIES_BYTE_BUDGET) break;
  }
  return take;
}

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
    // ── ONE OF THE USER'S OWN FOLDERS (the folders foundation) ─────────────────────────────
    // The same keyset walk the six views get, addressed by the folder ENTITY id and filtered
    // on the folder's canonical path within its own mailbox — the exact list the folder view
    // renders, continued past the client mirror's bootstrap window.
    if (opts.view === "folder") {
      if (typeof opts.folderId !== "string" || opts.folderId === "") {
        throw new ServiceError("validation_failed", 400, "view=folder requires folderId");
      }
      // SHAPE, before it reaches `mailbox_folders.id`. Without it a malformed `?folderId=` is
      // 22P02 from Postgres and a 500 to the caller — see `ids.ts`.
      requireUuid(opts.folderId, "folderId");
      if (!(await foldersEnabled(ctx.db, ctx.accountId))) return { items: [], nextCursor: null };
      const uf = await userFolderById(ctx.db, ctx.accountId, opts.folderId);
      if (uf === null) return { items: [], nextCursor: null };
      const filters = [
        eq(messages.accountId, ctx.accountId),
        eq(messages.mailboxId, uf.mailboxId),
        eq(folderState.desiredFolder, uf.folder),
        isNull(messages.deletedAt),
      ];
      // The caller's mirror boundary, page one only — the same keyset predicate the cursor
      // builds, from a client-named position instead of a server-minted cursor. VALIDATED at
      // the wire: a non-UUID id would bind against the uuid column and surface as a Postgres
      // 22P02 (a 500 for a malformed request), and an unparseable date silently selecting the
      // null-date branch would answer the WRONG page while looking like a success.
      if (!opts.cursor && opts.before) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.before.id)) {
          throw new ServiceError("validation_failed", 400, "beforeId must be a message id");
        }
        const bd = opts.before.date === null ? null : new Date(opts.before.date);
        if (bd !== null && Number.isNaN(bd.getTime())) {
          throw new ServiceError("validation_failed", 400, "beforeDate must be an ISO instant");
        }
        filters.push(afterKeyset({ date: bd, id: opts.before.id }));
      }
      return this.pageOf(ctx, {
        limit: clampLimit(opts.limit),
        cursor: opts.cursor,
        filters,
      });
    }
    const view = this.validView(opts.view);
    const limit = clampLimit(opts.limit);
    const desiredFolder = VIEW_FOLDER[view];
    const unread = VIEW_UNREAD[view];

    const filters = [
      eq(messages.accountId, ctx.accountId),
      eq(folderState.desiredFolder, desiredFolder),
      // Mail 0065: a tombstoned row keeps its folder_state (the reaper stamps `deleted_at` and
      // touches nothing else), so without this predicate an expunged message kept appearing in
      // its former view from THIS endpoint while `/sync` had already tombstoned it and a fresh
      // snapshot excluded it — three answers to one question.
      isNull(messages.deletedAt),
    ];
    if (unread !== undefined) filters.push(eq(messages.unread, unread));
    if (opts.cursor) {
      // Keyset for `date desc nulls last, id desc`: strictly "older" rows than the cursor tuple,
      // including the undated tail, which sorts after every dated row.
      filters.push(afterKeyset(decodeMsgCursor(opts.cursor)));
    }

    const rows = await ctx.db.select({ id: messages.id, date: messages.date }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters))
      .orderBy(...MSG_ORDER)
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

  /**
   * One keyset page over `messages ⋈ folder_state` — the view walk's exact body, shared with
   * the folder branch so the two cannot fork on ordering, cursor shape or tombstone handling.
   */
  private async pageOf(
    ctx: ServiceContext,
    args: { limit: number; cursor?: string; filters: SQL[] },
  ): Promise<Page<MessageDTO>> {
    const filters = [...args.filters];
    if (args.cursor) filters.push(afterKeyset(decodeMsgCursor(args.cursor)));
    const rows = await ctx.db.select({ id: messages.id, date: messages.date }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters))
      .orderBy(...MSG_ORDER)
      .limit(args.limit + 1);
    const pageRows = rows.slice(0, args.limit);
    const items: MessageDTO[] = [];
    for (const r of pageRows) {
      const dto = await materializeMessage(ctx.db, ctx.accountId, r.id);
      if (dto) items.push(dto);
    }
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > args.limit && last ? encodeMsgCursor(last.date, last.id) : null;
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
    // The stored `text` and `html` are the FULL original body — returned as-is, never re-derived
    // and never redacted (a message's own owner always sees their own mail in full). A message with
    // no ingested body yields an empty body.
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
      // The row's own marker, verbatim (mail 0062/0065): present ONLY when policy emptied the
      // content, so an ordinary empty body stays exactly the wire it was.
      ...withheldOf(body?.withheldReason),
    };
  }

  /**
   * The batch text pull — the foundation of the macOS Cloud-local text mirror.
   *
   * Keyset-paginates the account's message bodies by `messages.id` (ascending), returning the
   * STORED ROW VERBATIM: `text` and `html` are the full original body written at ingest
   * (`packages/core/src/pipeline.ts`), so this NEVER re-derives anything and NEVER rehydrates.
   * Ownership is proven through `messages` — `message_bodies` has no
   * `account_id`, exactly as {@link getBody} handles it — and the query LEFT-JOINs
   * `message_bodies` and joins NOTHING ELSE: no headers, no attachment bytes, no other table.
   * That absence IS the no-rehydrate guarantee, so there is deliberately no rehydrate path here.
   */
  async getBodies(ctx: ServiceContext, opts: GetBodiesOptions): Promise<Page<MessageBodyBatchItem>> {
    if (opts.ids !== undefined) return this.getBodiesByIds(ctx, opts.ids);
    const limit = clampPageLimit(opts.limit, BODIES_DEFAULT_LIMIT, BODIES_MAX_LIMIT);

    const filters = [eq(messages.accountId, ctx.accountId)];
    if (opts.after) {
      const after = decodeListCursor(opts.after);
      // The cursor is a message id; a malformed one would reach Postgres and raise 22P02 — a 500
      // for a plainly bad request. Reject it as a 400 first, the same guard `markSeen` applies.
      if (!UUID_RE.test(after)) throw new ServiceError("validation_failed", 400, "invalid cursor");
      filters.push(gt(messages.id, after));
    }

    // ── PASS 1: THE SIZES. `limit + 1` — the extra row is how a further page is detected. ──
    // No body value is selected here, so the whole candidate window costs two integers a row
    // however large the bodies are. See {@link BODY_BYTES}.
    const sized = await ctx.db.select({ messageId: messages.id, bytes: BODY_BYTES }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(...filters))
      .orderBy(asc(messages.id))
      .limit(limit + 1);

    const underBudget = prefixUnderBudget(sized.slice(0, limit));
    if (underBudget.length === 0) return { items: [], nextCursor: null };

    // ── PASS 2: THE BODIES, for exactly the prefix that fits. ──
    // Account-scoped AGAIN rather than trusting pass 1's ids: `message_bodies` has no
    // `account_id`, so the join through `messages` with this predicate IS the authorization, and
    // an authorization that holds only because an earlier query filtered correctly is one edit
    // away from not holding. `underBudget.length` ≤ `limit` ≤ BODIES_MAX_LIMIT, so the `IN` list
    // is bounded by the page ceiling, not by the account's size.
    const rows = await ctx.db.select({
      messageId: messages.id,
      text: messageBodies.text,
      html: messageBodies.html,
      loadedRemoteContent: messageBodies.loadedRemoteContent,
      withheldReason: messageBodies.withheldReason,
    }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, underBudget)))
      .orderBy(asc(messages.id))
      .limit(underBudget.length);

    const items: MessageBodyBatchItem[] = rows.map((r) => ({
      messageId: r.messageId,
      text: r.text ?? "",
      html: r.html ?? null,
      loadedRemoteContent: r.loadedRemoteContent ?? false,
      // The marker rides the MIRROR mode deliberately: without it a withheld body mirrors as
      // an empty complete one, the gap query never re-asks, and the desktop tells the same
      // lie the web used to. A fact about the stored row, not a rehydrate.
      ...withheldOf(r.withheldReason),
    }));

    // A next page exists iff a CANDIDATE row sits beyond the last one included — either the
    // `limit + 1` sentinel, or a row the byte budget stopped short of. Measured against `sized`
    // and not against `items`: a row deleted between the two passes would otherwise end the walk.
    const last = items[items.length - 1];
    const nextCursor = last && underBudget.length < sized.length
      ? encodeListCursor(last.messageId)
      : null;
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

    // PASS 1 — the sizes of the ids this account actually owns, in the answer's own order. A
    // twenty-message thread of newsletters is real, so this mode needs the byte-aware selection
    // as much as the keyset one does; it just has no cursor to offer for the remainder.
    const sized = await ctx.db.select({ messageId: messages.id, bytes: BODY_BYTES }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, ids)))
      .orderBy(asc(messages.id))
      .limit(BODIES_IDS_MAX);

    const underBudget = prefixUnderBudget(sized);
    if (underBudget.length === 0) return { items: [], nextCursor: null };

    // PASS 2 — the bodies AND the headers for that prefix, account-scoped again for the reason
    // the keyset mode gives. The budget covers `text` + `html`; the `headers` bag rides this mode
    // only, is bounded by at most {@link BODIES_IDS_MAX} rows, and is the input to the derived
    // posture below rather than something that crosses the wire.
    const rows = await ctx.db.select({
      messageId: messages.id,
      text: messageBodies.text,
      html: messageBodies.html,
      headers: messageBodies.headers,
      loadedRemoteContent: messageBodies.loadedRemoteContent,
      withheldReason: messageBodies.withheldReason,
    }).from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, underBudget)))
      .orderBy(asc(messages.id))
      .limit(underBudget.length);

    const items: MessageBodyBatchItem[] = rows.map((r) => {
      const headers = (r.headers as Record<string, unknown>) ?? {};
      const unsubscribe = unsubscribeHeaderState(headers);
      return {
        messageId: r.messageId,
        text: r.text ?? "",
        html: r.html ?? null,
        loadedRemoteContent: r.loadedRemoteContent ?? false,
        unsubscribe,
        unsubscribeUrl: unsubscribe === "not_one_click" ? httpsUnsubscribeUri(headers) : null,
        ...withheldOf(r.withheldReason),
      };
    });
    return { items, nextCursor: null };
  }

  async patch(ctx: ServiceContext, id: string, body: MessagePatchBody): Promise<PatchResult> {
    const folder = body.folder !== undefined ? this.validFolder(body.folder) : undefined;
    if (body.unread !== undefined && typeof body.unread !== "boolean") {
      throw new ServiceError("validation_failed", 400, "unread must be a boolean");
    }
    const glance = this.validVia(body.via);

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
        await upsertDesiredSeen(tx, id, !msg.unread, !body.unread, ctx.now());
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

      // A DELIBERATE read — or a re-file — spends the resurface. The batch route (`markSeen`)
      // has always cleared it; this route marking the same message read through a different verb
      // must not leave the pin standing, or which client a user reads in decides whether their
      // Ohbox stays pinned. A GLANCE (`via: "glance"` — the stream sweep's per-id PATCH) marks
      // read WITHOUT spending: the read sticks (owner ruling 2026-08-26), the pin is answered
      // by dealing with the row. Re-filing is dealing with it, so `folder` spends regardless.
      if ((body.unread === false && !glance) || folder !== undefined) {
        const spent = await this.spendResurface(tx, ctx, [id]);
        if (spent !== null) last = spent;
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
    const glance = this.validVia(body.via);
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
        await upsertDesiredSeen(tx, id, observedById.get(id) ?? false, !unread, ctx.now());
        last = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: id, op: "update", meta: null,
        });
      }

      // A DELIBERATE read spends the resurface — see `spendResurface`. Only when marking read
      // (`unread === false`), and never for a GLANCE (`via: "glance"` — the Ohbox dwell commit):
      // the glance's read lands like any other (owner ruling 2026-08-26), but the pin is
      // answered by dealing with the row, and nobody pressed anything to get here. Marking
      // unread must not touch triage either way.
      if (!unread && !glance) {
        const spent = await this.spendResurface(tx, ctx, ids);
        if (spent !== null) last = spent;
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
      let seqBig = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: id, op: "move",
        meta: { from: observed, to: folder },
      });
      // Re-filing spends the resurface (see `spendResurface`) — BEFORE the materialize below,
      // so the DTO this route answers (and stores for idempotent replay) already says `none`.
      const spent = await this.spendResurface(tx, ctx, [id]);
      if (spent !== null) seqBig = spent;
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

  /**
   * DELETE — the third user-commanded write of the 2026-08-22 amendment (imap-types.ts): the
   * message rides to the provider's native `\Trash` and leaves the mirror's living views.
   *
   * ── NEVER AN EXPUNGE, AND REFUSED WHEN TRASH DOES NOT EXIST ────────────────────────────────
   *
   * The physical move is `folder_state.desired_folder = <the mailbox's trash path>` — the same
   * desired-state seam every move rides, drained by the worker (the API never opens IMAP). The
   * trash path comes from the connect-time discovery (`mailboxes.trash_folder`); a mailbox with
   * NONE gets a 422 `no_trash_folder` UP FRONT and nothing is written, because the only other
   * ways to "delete" — expunging, or hiding mail that stays in the Imbox on the server — are
   * respectively the destructive write the product rule forbids and the mirror lying about the
   * mailbox.
   *
   * ── THE MIRROR SIDE IS ONE `delete` CHANGE ────────────────────────────────────────────────
   *
   * `deleted_at` stamps the row (kept — it is the message's identity) and every living view
   * excludes it; the `change_log` `delete` rides the same seam every client already applies, so
   * web, desktop and mobile tombstone on their next drain with no new code. A restore performed
   * in the user's own client re-appears through the adopt path, which clears the stamp and
   * re-emits the entity — "a LATER create resurrects", end to end.
   *
   * A message with NO server copy (`native_locator` null — a fixture, a seeded row) is
   * tombstoned without a folder_state write: there is nothing to move, and a pending move at a
   * locator that never existed would hang the "Filing N messages…" count for ever.
   */
  async delete(
    ctx: ServiceContext, id: string,
    opts: { idempotency?: MoveIdempotency | null } = {},
  ): Promise<MoveResult> {
    return asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, nativeLocator: messages.nativeLocator, mailboxId: messages.mailboxId,
      }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      const hasCopy = (msg.nativeLocator as NativeLocator | null) !== null;
      let trash: string | null = null;
      if (hasCopy) {
        const [mb] = await tx.select({ trashFolder: mailboxes.trashFolder }).from(mailboxes)
          .where(eq(mailboxes.id, msg.mailboxId)).limit(1);
        trash = mb?.trashFolder ?? null;
        if (trash === null) {
          throw new ServiceError(
            "no_trash_folder", 422,
            "this mailbox has no Trash folder, and ohmail never expunges — delete the message in your own mail client instead",
          );
        }
      }

      const now = ctx.now();
      if (hasCopy && trash !== null) {
        const observed = await this.observedFolder(tx, id, msg.nativeLocator);
        await this.upsertDesired(tx, id, observed, trash as Folder, now);
      }
      await tx.update(messages).set({ deletedAt: now, updatedAt: now })
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId)));
      let seqBig = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: id, op: "delete", meta: null,
      });
      // Deleting is dealing with a resurfaced row, exactly as re-filing is.
      const spent = await this.spendResurface(tx, ctx, [id]);
      if (spent !== null) seqBig = spent;
      const seq = Number(seqBig);

      const dto = await materializeMessage(asDb(tx), ctx.accountId, id);
      if (!dto) throw new ServiceError("internal", 500, "message vanished after write");

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
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return { dto, seq };
    });
  }

  // ── helpers ──

  /**
   * READING — OR RE-FILING — A RESURFACED ROW SPENDS THE RESURFACE.
   *
   * The worker flips a due `bubbled_up` state to `resurfaced` (see `bubbleUpPass`), which pins
   * the row at the top of the Ohbox. The pin is answered by the user DEALING with the row, and
   * exactly two verbs are dealing with it: DELIBERATELY marking it read (a settled reply marks
   * the parent read through the same route, so it counts too) and filing it somewhere. Both
   * clear the state back to `none` IN THE CALLER'S TRANSACTION, so "Resurfaced" never outlives
   * the act that answered it — and never survives into the materialized DTO the same transaction
   * returns. Merely OPENING the row is deliberately neither: a glance does not spend the
   * resurface. Since the 2026-08-26 ruling the glance's READ still lands (`via: "glance"` on
   * `markSeen`/`patch` marks read and skips this) — what a glance cannot do is take the pin down.
   *
   * One implementation for every route that can perform those verbs — the batch `markSeen`, the
   * single-message `patch` (both arms) and `move` — because the first defect here was exactly a
   * route gap: only the batch route cleared, so which client a user read in decided whether
   * their pin came down.
   *
   * Scoped to `state = 'resurfaced'` alone: a `bubbled_up` row keeps its schedule (filing a
   * snoozed message elsewhere does not cancel the return the user asked for), and the bottom
   * piles are cleared by their own explicit transitions. Emitted as `message_state` updates so
   * every client drops the pin on the next `/sync`; the caller has already emitted the paired
   * `message` change its DTO projection rides on.
   */
  // `LedgerTx`, not `Tx`: this writes the change log, and only a real transaction may.
  private async spendResurface(tx: LedgerTx, ctx: ServiceContext, ids: string[]): Promise<bigint | null> {
    const cleared = await tx
      .update(messageStates)
      .set({ state: "none", bubbleUpAt: null, updatedAt: ctx.now() })
      .where(and(
        inArray(messageStates.messageId, ids),
        eq(messageStates.accountId, ctx.accountId),
        eq(messageStates.state, "resurfaced"),
      ))
      .returning({ id: messageStates.id });
    let last: bigint | null = null;
    for (const r of cleared) {
      last = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message_state", entityId: r.id, op: "update", meta: null,
      });
    }
    return last;
  }

  /** The observed folder: the folder_state truth, else the message's native locator, else INBOX. */
  private async observedFolder(tx: Tx, id: string, nativeLocator: unknown): Promise<string> {
    const [fs] = await tx.select({ observedFolder: folderState.observedFolder }).from(folderState)
      .where(eq(folderState.messageId, id)).limit(1);
    if (fs) return fs.observedFolder;
    const loc = (nativeLocator as NativeLocator | null) ?? null;
    return loc?.folder ?? "INBOX";
  }

  // The `flag_state` intent writer lives in `@trafficflow/db` (`flag-intent.ts`) now — the
  // Screener's mark-read-on-dismiss and the worker's read-state retro pass write the same
  // intent, and a second copy would be a second answer to when a `\Seen` round trip is owed.

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

  /**
   * `via` is `"glance"` or absent — anything else is a 400, not a silent "deliberate", because
   * a client that misspells the label would otherwise spend pins it meant to protect and nothing
   * would ever fail. Returns whether this request is a glance.
   */
  private validVia(v: unknown): boolean {
    if (v === undefined) return false;
    if (v !== "glance") {
      throw new ServiceError("validation_failed", 400, "via must be \"glance\" when present");
    }
    return true;
  }
}

export const messageService = new MessageService();
