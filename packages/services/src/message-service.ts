import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  assertOrganizerRole,
  mailboxes, mailboxFolders, messages, folderState, messageBodies, messageStates, claimIdempotencyKey,
  recordChange, upsertDesiredSeen, ringFilingDoorbell, type LedgerTx, type OrganizedBy, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import type { Destination, NativeLocator } from "@trafficflow/core/mail";
import { createLogger, httpsUnsubscribeUri, unsubscribeHeaderState } from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { foldersEnabled, userFolderById } from "./folders.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import {
  materializeMessage, materializeMessages, materializeMessagesInOrder,
} from "./dto/materialize.js";
import {
  clampLimit, clampPageLimit, decodeKeysetCursor, decodeListCursor, decodeNullableKeysetCursor,
  encodeListCursor, encodeNullableKeysetCursor,
} from "./pagination.js";
import { requireUuid } from "./ids.js";
import {
  moveDestinationWord, routeMailboxWrite, writeReaderRequest, type PendingRequest,
} from "./reader-request.js";
import type {
  Folder, MessageBodyBatchItem, MessageBodyDTO, MessageDTO, Page, TrashRowDTO, WithheldMarker,
} from "./dto/types.js";

/**
 * Where a best-effort filing doorbell reports a throw. Module scope and not injected: it is a
 * single warn line on a path whose failure costs one rotation, and nothing reads it back.
 */
const doorbellLog = createLogger({ service: "filing" });

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
 * The batch cap, and why there is one. The route runs ONE transaction that allocates one
 * `change_log` seq per message from a row lock on `account_sync_state`, so the transaction's
 * duration is the window during which every other mutation on this account blocks. An uncapped
 * "select all, mark read" would hold that lock for tens of thousands of allocations on a 60 s
 * `maxDuration` platform — the request dies mid-flight and the client retries the same impossible
 * thing. 200 is `DEFAULT_SYNC_BATCH_MAX_MESSAGES`, deliberately: already the batch size the
 * system is tuned for. A client with more sends more requests, which also makes progress visible.
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
 * A move or delete that became a REQUEST — this install reads the mailbox, another organizes it,
 * and the press is now waiting on that install (mail 0094). `dto` IS THE MESSAGE UNMOVED, and
 * that is the point: a request writes DESIRED state on the machine that holds the mailbox, and
 * NOTHING here — so the DTO is the row exactly as it stood before the press, and the client
 * renders "waiting for <holder>" beside a message that has not moved, rather than moving it
 * optimistically and un-moving it when the organizer refuses. There is no `seq`: nothing changed
 * in this install's store, and a `seq` would advance every client's cursor past a change that
 * does not exist.
 */
export interface MoveRequestResult {
  pending: true;
  requestId: string;
  holder: OrganizedBy;
  /** The message as it still stands, unmoved. */
  dto: MessageDTO;
}

/**
 * A patch's result. `seq` is the LAST emitted change seq (null when the patch was
 * a no-op — neither `unread` nor `folder` supplied).
 */
export interface PatchResult {
  dto: MessageDTO;
  seq: number | null;
  /**
   * PRESENT WHEN THE `folder` HALF BECAME A REQUEST (mail 0094) — this install reads the mailbox
   * and another one organizes it, so the re-file is waiting on {@link PendingRequest.holder}.
   *
   * The two halves of a patch are decided SEPARATELY because they are separately permitted:
   * `unread` is the reader's one legitimate IMAP write and still lands locally, while the folder
   * change travels. So a patch carrying both can apply one half here and queue the other, and
   * `seq` describes only what this store actually did.
   */
  pending?: PendingRequest;
}

/**
 * (date, id) keyset, and the third position the tuple used to lose. Ordered `date desc NULLS
 * LAST, id desc`; the cursor carries both components. `messages.date` IS NULLABLE and the null is
 * a POSITION: it is the sender's own `Date:` header, and this encoder used to write epoch `0` for
 * it — two defects: the undated tail was UNREACHABLE (the next page asked for rows older than
 * 1970, so the list ended early), and the ORDER BY and the predicate disagreed (drizzle's bare
 * `DESC` is `NULLS FIRST` in PostgreSQL while the `before` predicate was written for NULLS LAST).
 * `nulls last` is not a new opinion: the snapshot bootstrap, the Screener's sort key and the
 * client mirror already treat undated mail as oldest; this surface was the odd one out.
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
   * The other mode: name the messages instead of paging through them. Present means
   * `after`/`limit` are ignored and exactly these ids are answered, capped at {@link
   * BODIES_IDS_MAX}. It exists for the thread open — a conversation needs its siblings' bodies at
   * once, and asking per message is N requests through the client's own concurrency limiter, so
   * the tail of a thread does not begin loading until a whole round trip has finished. The two
   * modes are the SAME ROUTE because they are the same read of the same rows under the same
   * `cost: "read"` and ownership proof; only the row selection differs. A second route would be a
   * second place for the account scoping to be written.
   */
  ids?: string[];
}

/**
 * The batch text pull bounds, on a `maxDuration = 60` lambda. `limit` defaults to 50, capped at
 * 100: each row is a whole stored body — the full `text` and sanitized `html` — so a page is far
 * heavier than a list page. The BYTE BUDGET is the real fence: a single page of newsletter html
 * can be hundreds of KiB, so 100 marketing bodies would push megabytes through the lambda.
 * Accumulated `text` + `html` is measured as the page is assembled and the page stops early past
 * ~4 MiB, returning a `nextCursor` so the client resumes exactly after the last row it received.
 * At least one row is always returned even when it alone exceeds the budget — otherwise one
 * oversized body would stall pagination for ever.
 */
export const BODIES_DEFAULT_LIMIT = 50;
export const BODIES_MAX_LIMIT = 100;

/**
 * How many ids `?ids=` may name. Twenty rather than the keyset mode's hundred, because this mode
 * is INTERACTIVE — a reader is waiting with a thread half-drawn — and the id list is a
 * client-chosen set rather than a page the server controls; it is well past any conversation a
 * reader scrolls. Over the cap is a REFUSAL, not a truncation, and the asymmetry with `limit`
 * (which clamps) is deliberate: a clamped page is honest because it carries a cursor for the
 * rest, while a truncated id list is indistinguishable from "those messages have no body". The
 * client splits its own list, so this is a contract guard rather than a state the product
 * reaches.
 */
export const BODIES_IDS_MAX = 20;
export const BODIES_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * The size probe — how the byte budget bounds the TRANSFER, not merely the response. The budget
 * used to be spent inside a loop over rows PostgreSQL had already sent: the response was bounded
 * and the cost was not — a budget enforced after the read is not a budget, and a sender chooses
 * each body's size. `octet_length` is why a second query is cheaper than the first was: for a
 * `text` column PostgreSQL answers from the varlena header, WITHOUT detoasting or transferring
 * the value; the fitting prefix is then fetched for real. `octet_length` and NOT `length`: the
 * budget is bytes, and `length()` counts CHARACTERS — under-counting non-ASCII mail by up to 4x.
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

/** One sized candidate row: the id and the bytes its body would cost to transfer. */
interface SizedCandidate { messageId: string; bytes: number | string | null }

/**
 * Size, then fetch — two passes, ONE SNAPSHOT. A byte budget spent on pass 1's answer bounds pass
 * 2's transfer only if the two passes see THE SAME ROWS: under READ COMMITTED each statement
 * takes its own snapshot, so a body empty when sized could be filled in by the worker between the
 * statements — pass 2 then transfers a body the budget was never asked about; a hundred of those
 * is the unbounded read, restored by a race. `repeatable read` + `read only` pins both to one
 * snapshot — the same fix `serializeOrganizerProfile` uses — and PGlite is real Postgres, so the
 * level holds on both stores. The transaction is cheap: two selects with no user work between
 * them.
 */
async function sizedThenFetch<R extends { messageId: string }>(
  ctx: ServiceContext,
  spec: {
    /** The candidate window, sizes only — never a body value. */
    window: (tx: Db) => PromiseLike<SizedCandidate[]>;
    /** How many of the window are eligible (the rest is the has-more sentinel), or `null` for all. */
    take: number | null;
    /** The bodies for the prefix that fits. */
    fetch: (tx: Db, ids: string[]) => PromiseLike<R[]>;
    item: (row: R) => MessageBodyBatchItem;
    /** Given the ids taken and the whole candidate window, the cursor for the rest. */
    cursor: (taken: string[], candidates: readonly SizedCandidate[]) => string | null;
  },
): Promise<Page<MessageBodyBatchItem>> {
  return asTx(ctx).transaction(async (tx) => {
    const db = asDb(tx);
    const candidates = await spec.window(db);
    const eligible = spec.take === null ? candidates : candidates.slice(0, spec.take);
    const taken = prefixUnderBudget(eligible);
    if (taken.length === 0) return { items: [], nextCursor: null };
    const rows = await spec.fetch(db, taken);
    return { items: rows.map(spec.item), nextCursor: spec.cursor(taken, candidates) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
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
    /**
     * Trash — mail this account deleted in ohmail (mail 0099). BEFORE `validView`: Trash is not
     * one of the seven views — it is the PROVIDER's folder, and its rows are TOMBSTONED, so this
     * read must not exclude `deleted_at`. In it: rows whose desired folder IS this mailbox's own
     * Trash path (the `mailboxes` join makes that per-mailbox). NOT in it: expunge-reaper
     * tombstones, mail trashed in ANOTHER client (the worker never reads the provider's Trash),
     * and mail whose FOLDER was deleted. Ordered by DELETION (`folder_state.updated_at desc`),
     * not date — the order a person looking for what they just deleted expects. No
     * `foldersEnabled` gate: Trash is the provider's own system folder.
     */
    if (opts.view === "trash") return this.listTrash(ctx, opts);
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
    /**
     * One page, one set of round-trips. This was `for (const r of pageRows) await
     * materializeMessage(...)`, and the singular form is a one-element wrapper over the batch: a
     * page cost six sequential queries PER ROW where the batch costs six for the page whatever
     * its size — the shape `materializeMessages` was written to end. On a store that serialises
     * (PGlite is the desktop's) those round-trips are the read's whole latency, so every other
     * request waits behind them. `deleted: "include"` keeps the singular's exact selection: only
     * the round-trips change.
     */
    const items = await materializeMessagesInOrder(
      ctx.db, ctx.accountId, pageRows.map((r) => r.id), { deleted: "include" },
    );
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > limit && last ? encodeMsgCursor(last.date, last.id) : null;
    return { items, nextCursor };
  }

  /**
   * ONE KEYSET PAGE OF TRASH — see the block at {@link MessageService.list}'s `trash` arm for
   * what is in this list, what is deliberately not, and why it is ordered by deletion time.
   *
   * A METHOD OF ITS OWN and not an inline arm, because it is the only read here whose row type
   * is wider than `MessageDTO`: a caller that wants `trashedAt`/`restoreTo` typed asks for this
   * directly, and `list` delegates so the route keeps one door.
   */
  async listTrash(ctx: ServiceContext, opts: ListMessagesOptions): Promise<Page<TrashRowDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [
      eq(messages.accountId, ctx.accountId),
      // The row's OWN mailbox's Trash path — see the block above for why this is a join and
      // not a literal. A mailbox with NO Trash folder has `trash_folder` null and the
      // comparison is null, so its rows are absent: correct, since a delete there is refused
      // 422 up front and nothing was ever filed.
      sql`${folderState.desiredFolder} = ${mailboxes.trashFolder}`,
    ];
    if (opts.cursor) {
      const { millis, id } = decodeKeysetCursor(opts.cursor);
      filters.push(or(
        lt(folderState.updatedAt, new Date(millis)),
        and(eq(folderState.updatedAt, new Date(millis)), lt(messages.id, id)),
      )!);
    }
    const rows = await ctx.db
      .select({ id: messages.id, trashedAt: folderState.updatedAt, trashedFrom: folderState.trashedFrom, mailboxId: messages.mailboxId })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(and(...filters))
      .orderBy(desc(folderState.updatedAt), desc(messages.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    /* `deleted: "include"` — the whole point. Without it every row this predicate found
       materializes null and the list is empty, which is exactly what a suite with no
       tombstoned fixture would call a pass. */
    const dtos = await materializeMessages(
      ctx.db, ctx.accountId, pageRows.map((r) => r.id), { deleted: "include" },
    );
    const items: TrashRowDTO[] = [];
    for (const r of pageRows) {
      const dto = dtos.get(r.id);
      if (!dto) continue;
      items.push({
        ...dto,
        trashedAt: r.trashedAt.toISOString(),
        restoreTo: await this.resolveRestoreTarget(ctx, r.mailboxId, r.trashedFrom),
      });
    }
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > limit && last
      ? encodeListCursor(`${last.trashedAt.getTime()}:${last.id}`)
      : null;
    return { items, nextCursor };
  }

  /**
   * Where a restore puts this message — the stored origin, resolved, or INBOX. The stored value
   * is never trusted: `trashed_from` is a folder PATH written at the delete, and the folder can
   * be renamed away while the mail sits in Trash — a desired folder the server does not have is a
   * move the reconciler refuses for ever. So the value is CHECKED; the fallback is INBOX, not a
   * refusal. `restoreTo` travels with every item. Live targets: INBOX and the five `ohmail/*`
   * folders, plus a path `mailbox_folders` still carries for THIS mailbox — deliberately NOT the
   * "Use folders" participation filter: that answers "is this folder a surface", this asks "does
   * the server have it". Account-scoped through the `mailboxes` join.
   */
  private async resolveRestoreTarget(
    ctx: ServiceContext, mailboxId: string, trashedFrom: string | null,
  ): Promise<string> {
    if (trashedFrom === null || trashedFrom === "") return "INBOX";
    if (FOLDER_SET.has(trashedFrom)) return trashedFrom;
    const [live] = await ctx.db.select({ id: mailboxFolders.id })
      .from(mailboxFolders)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
      .where(and(
        eq(mailboxFolders.mailboxId, mailboxId),
        eq(mailboxFolders.folder, trashedFrom),
        eq(mailboxes.accountId, ctx.accountId),
      ))
      .limit(1);
    return live ? trashedFrom : "INBOX";
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
    // The batch, for the reason written at `list`'s own page: round-trips constant in the page
    // size, and `deleted: "include"` so only the round-trips change.
    const items = await materializeMessagesInOrder(
      ctx.db, ctx.accountId, pageRows.map((r) => r.id), { deleted: "include" },
    );
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
   * The batch text pull — the foundation of the macOS Cloud-local text mirror. Keyset-paginates
   * the account's message bodies by `messages.id` ascending, returning the STORED ROW VERBATIM:
   * `text` and `html` are the full original body written at ingest, so this NEVER re-derives and
   * NEVER rehydrates. Ownership is proven through `messages` — `message_bodies` has no
   * `account_id`, exactly as {@link getBody} handles it — and the query LEFT-JOINs
   * `message_bodies` and joins NOTHING ELSE: no headers, no attachment bytes, no other table.
   * That absence IS the no-rehydrate guarantee.
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

    return sizedThenFetch(ctx, {
      window: (tx) => tx.select({ messageId: messages.id, bytes: BODY_BYTES }).from(messages)
        .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
        .where(and(...filters))
        .orderBy(asc(messages.id))
        // `limit + 1`: the extra row is how a further page is detected without a second query.
        .limit(limit + 1),
      take: limit,
      fetch: (tx, underBudget) => tx.select({
        messageId: messages.id,
        text: messageBodies.text,
        html: messageBodies.html,
        loadedRemoteContent: messageBodies.loadedRemoteContent,
        withheldReason: messageBodies.withheldReason,
      }).from(messages)
        .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
        .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, underBudget)))
        .orderBy(asc(messages.id))
        .limit(underBudget.length),
      // The marker rides the MIRROR mode deliberately: without it a withheld body mirrors as
      // an empty complete one, the gap query never re-asks, and the desktop tells the same
      // lie the web used to. A fact about the stored row, not a rehydrate.
      item: (r) => ({
        messageId: r.messageId,
        text: r.text ?? "",
        html: r.html ?? null,
        loadedRemoteContent: r.loadedRemoteContent ?? false,
        ...withheldOf(r.withheldReason),
      }),
      // A next page exists iff a CANDIDATE row sits beyond the last one included — either the
      // `limit + 1` sentinel, or a row the byte budget stopped short of.
      //
      // The cursor comes from the last CANDIDATE, never from the last ITEM. They are the same id
      // whenever pass 2 answered in full, and they differ in the one case that matters: a row
      // deleted between the passes makes `items` shorter, and if the deleted row was the ONLY
      // one taken then `items` is empty — so an item-derived cursor would be `null` and the
      // client's body walk would stop while candidates remained. (Round 1 of the review found
      // this; `limit=1` reaches it with one deletion.)
      cursor: (taken, candidates) => taken.length < candidates.length
        ? encodeListCursor(taken[taken.length - 1]!)
        : null,
    });
  }

  /**
   * `GET /messages/bodies?ids=…` — the named-ids mode, the thread open. A foreign id is simply
   * ABSENT: `PATCH /messages` rejects the whole request on one (a partial batch write is
   * unrepresentable), but this is a READ, and a 404 for "you do not own this" would be an
   * existence oracle — absent distinguishes nothing: unknown, foreign and deleted are one
   * outcome. This mode joins the HEADERS, which the keyset mode must not: that mode's
   * join-nothing absence IS its no-rehydrate guarantee; this feeds a READER and owes the
   * unsubscribe posture `getBody` derives — raw headers never cross the wire. No cursor: a
   * truncated answer is simply a short one; `nextCursor` is `null` always.
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

    // The same size-then-fetch under one snapshot the keyset mode uses — a twenty-message thread
    // of newsletters is real, so this mode needs the byte-aware selection as much as that one
    // does. It differs in two places only: the whole window is eligible (there is no has-more
    // sentinel to hold back), and there is no cursor to offer for the remainder, so a truncated
    // answer is simply a short one and the client asks per message for what is missing.
    return sizedThenFetch(ctx, {
      window: (tx) => tx.select({ messageId: messages.id, bytes: BODY_BYTES }).from(messages)
        .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
        .where(and(eq(messages.accountId, ctx.accountId), inArray(messages.id, ids)))
        .orderBy(asc(messages.id))
        .limit(BODIES_IDS_MAX),
      take: null,
      // PASS 2 joins the HEADERS, which the keyset mode must not. The budget covers `text` +
      // `html`; the `headers` bag rides this mode only, is bounded by at most BODIES_IDS_MAX rows,
      // and is the input to the derived posture below rather than something that crosses the wire.
      fetch: (tx, underBudget) => tx.select({
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
        .limit(underBudget.length),
      item: (r) => {
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
      },
      cursor: () => null,
    });
  }

  async patch(ctx: ServiceContext, id: string, body: MessagePatchBody): Promise<PatchResult> {
    const folder = body.folder !== undefined ? this.validFolder(body.folder) : undefined;
    if (body.unread !== undefined && typeof body.unread !== "boolean") {
      throw new ServiceError("validation_failed", 400, "unread must be a boolean");
    }
    const glance = this.validVia(body.via);
    let pending: PendingRequest | undefined;

    /* WHICH MAILBOX NOW OWES A MOVE — captured inside the transaction and rung AFTER it commits.
       `null` when this request wrote no desired folder: an `unread`-only patch owes the organizer
       nothing new, and ringing for it would wake the worker for work that does not exist. */
    let filed: string | null = null;
    const seq = await asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, unread: messages.unread, nativeLocator: messages.nativeLocator,
        // Which mailbox this message is in, and the name BOTH installs have for the message —
        // the `folder` half below asks about the right row and, on a mailbox this install only
        // reads, names the message in the request. Mail 0083 added the mailbox id to `move`'s and
        // `delete`'s own selects for the same reason.
        mailboxId: messages.mailboxId, dedupKey: messages.dedupKey,
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
        /**
         * This is the move door under another name, and it was not gated (mail 0094). `move` and
         * this branch write the SAME row the SAME way, and the reconciler turns either into a
         * physical IMAP move — mail 0083 gated `move` and `delete` and missed this one, so a
         * reader could re-file mail by spelling the request differently: a false state now, and a
         * QUEUE of moves that fires on promotion. The census could not see it (it asks whether a
         * FILE calls the refusal, and this file does at the other doors); it now pins call sites
         * per file. The `unread` half is NOT inside this branch: `\Seen` is the reader's one
         * legitimate IMAP write.
         */
        const route = await routeMailboxWrite(
          tx as unknown as Tx, ctx.accountId, msg.mailboxId, "message.move",
        );
        if (route.route === "request") {
          pending = await writeReaderRequest(tx as unknown as Tx, ctx, {
            mailboxId: msg.mailboxId,
            kind: "message.move",
            payload: { dedupKey: msg.dedupKey, destination: moveDestinationWord(folder) },
            holder: route.holder,
          });
        } else {
          // The locked re-check, on `move`'s argument exactly — the routing read above takes no
          // lock, so a demotion can commit between the two.
          await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);
          const observed = await this.observedFolder(tx, id, msg.nativeLocator);
          // The mailbox that now owes a move, rung AFTER this transaction commits.
          filed = msg.mailboxId;
          // `null` — a filing is not a delete, and this write CLEARS any origin the row carried
          // from an earlier delete. See `upsertDesired`'s own parameter block. The request branch
          // above writes no `folder_state` row, so there is nothing there to clear.
          await this.upsertDesired(tx, id, observed, folder, ctx.now(), null);
          last = await recordChange(tx, {
            accountId: ctx.accountId, entityType: "message", entityId: id, op: "move",
            meta: { from: observed, to: folder },
          });
        }
      }

      // A DELIBERATE read — or a re-file — spends the resurface. The batch route has always
      // cleared it; this route marking the same message read through a different verb must not
      // leave the pin standing, or which client a user reads in decides whether their Ohbox stays
      // pinned. A GLANCE (`via: "glance"`) marks read WITHOUT spending: the read sticks, and the
      // pin is answered by dealing with the row. Re-filing is dealing with it, so `folder` spends
      // regardless — and only when it actually re-filed: a QUEUED re-file has moved nothing here,
      // so spending the pin would be a local write about a move that has not happened, leaving
      // the row unpinned if the organizer refuses. `move`'s request path spends nothing for the
      // same reason.
      if ((body.unread === false && !glance) || (folder !== undefined && pending === undefined)) {
        const spent = await this.spendResurface(tx, ctx, [id]);
        if (spent !== null) last = spent;
      }

      return last;
    });
    /* THE DOORBELL, AFTER THE COMMIT. See {@link MessageService.ringFiledMailbox}: inside the
       transaction this deadlocked against every other writer of the mailbox row — measured on
       real Postgres as `40P01`, with a 500 to one of two concurrent decisions. */
    if (filed !== null) await this.ringFiledMailbox(ctx, filed);

    const dto = await materializeMessage(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("internal", 500, "message vanished after write");
    return {
      dto, seq: seq === null ? null : Number(seq),
      ...(pending === undefined ? {} : { pending }),
    };
  }

  /**
   * `PATCH /messages { ids, unread }` — ONE read-state decision over up to {@link
   * MARK_SEEN_MAX_IDS} messages; the single PATCH could not express a selection, so a lost
   * network left half of one flipped. Four load-bearing properties: ONE transaction (a partial
   * batch is unrepresentable); account scoping is a REJECTION — one foreign id fails the whole
   * request with 404, since skipping would let a probe learn from the response length which ids
   * exist elsewhere; one `recordChange` PER MESSAGE (the delta feed is per-entity; `allocateSeq`
   * holds the counter lock for the whole transaction); `flag_state` desired-state only, NO IMAP —
   * `reconcileFlags` applies `\Seen` next cycle.
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

    // The batch: this route accepts up to 200 ids, and the singular form made that 200 x 6
    // statements awaited one after another. `deleted: "include"` is the receipt reader's rule —
    // these are rows the transaction above just wrote.
    const items = await materializeMessagesInOrder(
      ctx.db, ctx.accountId, ids, { deleted: "include" },
    );
    return { items, seq: seq === null ? null : Number(seq) };
  }

  async move(
    ctx: ServiceContext, id: string, body: MoveBody,
    opts: { idempotency?: MoveIdempotency | null } = {},
  ): Promise<MoveResult | MoveRequestResult> {
    const folder = this.validFolder(body.folder);

    /* WHICH MAILBOX NOW OWES A MOVE — captured inside the transaction and rung AFTER it commits.
       `null` when this request wrote no desired folder, so the organizer is not woken for work
       that does not exist. */
    let filed: string | null = null;
    const answer = await asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, nativeLocator: messages.nativeLocator,
        // Mail 0083 — which mailbox this message is in, so the role is asked about the right row.
        mailboxId: messages.mailboxId,
        // Mail 0094 — the name BOTH installs have for this message. A request travels between two
        // stores with different primary keys, so the record names the message by its dedup key.
        dedupKey: messages.dedupKey,
      }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");
      /**
       * A reader moves nothing here — it ASKS (mail 0083, then 0094). This door writes
       * `desired_folder` with `last_set_by='us'`, and the reconciler turns that into a physical
       * IMAP move — on a mailbox another install organizes, two organizers moving one person's
       * mail, reached through a button. Mail 0083 refused outright; 0094 keeps the refusal of the
       * LOCAL WRITE — nothing below this branch runs for a reader — and replaces the dead end
       * with a request the holder applies. No `folder_state` row is written here, so a later
       * promotion inherits no queue of moves. The skip stops a reader EXECUTING an intent; this
       * stops one being RECORDED.
       */
      const route = await routeMailboxWrite(
        tx as unknown as Tx, ctx.accountId, msg.mailboxId, "message.move",
      );
      if (route.route === "request") {
        return this.requestMove(tx, ctx, {
          messageId: id, mailboxId: msg.mailboxId, dedupKey: msg.dedupKey,
          destination: moveDestinationWord(folder), holder: route.holder,
        }, opts);
      }
      /* THE LOCKED RE-CHECK, AND IT IS NOT REDUNDANT WITH THE BRANCH ABOVE.
       * `routeMailboxWrite` is a PLAIN read — right for choosing a branch, and not evidence about
       * a write that has not started. Under READ COMMITTED the worker's lease gate can commit a
       * demotion between the two, so the share lock is what actually stands between this write and
       * a reader crossing the door. See `assertOrganizerRole`'s own header for the interleaving. */
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);

      // Write DESIRED state only. observedFolder is the worker's truth — read
      // and PRESERVE it (never overwrite on conflict); the worker flips it when the
      // physical IMAP move lands. NO adapter, NO IMAP here.
      const observed = await this.observedFolder(tx, id, msg.nativeLocator);
      filed = msg.mailboxId;
      // `null` — see the `patch` arm above and `upsertDesired`'s parameter block: a move CLEARS
      // the delete origin, which is what makes a second delete from a new folder honest.
      await this.upsertDesired(tx, id, observed, folder, ctx.now(), null);
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

    /* THE DOORBELL, AFTER THE COMMIT. See {@link MessageService.ringFiledMailbox}: inside the
       transaction this deadlocked against every other writer of the mailbox row — measured on
       real Postgres as `40P01`, with a 500 to one of two concurrent decisions. */
    if (filed !== null) await this.ringFiledMailbox(ctx, filed);

    return answer;
  }

  /**
   * DELETE — the message rides to the provider's native `\Trash` and leaves the living views.
   * NEVER an expunge, and refused when Trash does not exist: the physical move is desired state
   * drained by the worker, and a mailbox with NO discovered trash path gets a 422
   * `no_trash_folder` UP FRONT — the alternatives are the destructive write the product forbids,
   * or the mirror lying. The mirror side is one `delete` change: `deleted_at` stamps the row
   * (kept — it is the message's identity), and a restore in the user's own client re-appears
   * through the adopt path. A message with NO server copy is tombstoned without a folder_state
   * write: a pending move at a locator that never existed would hang the filing count for ever.
   */
  async delete(
    ctx: ServiceContext, id: string,
    opts: { idempotency?: MoveIdempotency | null } = {},
  ): Promise<MoveResult | MoveRequestResult> {
    /* WHICH MAILBOX NOW OWES A MOVE — captured inside the transaction and rung AFTER it commits.
       `null` when this request wrote no desired folder, so the organizer is not woken for work
       that does not exist. */
    let filed: string | null = null;
    const answer = await asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, nativeLocator: messages.nativeLocator, mailboxId: messages.mailboxId,
        dedupKey: messages.dedupKey,
      }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      /**
       * A reader deletes nothing here — it ASKS. A delete is a move to Trash plus a tombstone, so
       * the argument above applies; what 0094 adds is that the press travels as a `message.move`
       * whose destination is the WORD `trash`. The Trash lookup below is deliberately NOT reached
       * on this path: `mailboxes.trash_folder` is discovered at connect by the install that is
       * CONNECTED — a reader's copy is a guess about somebody else's server, routinely NULL — so
       * asking it here would refuse a deliverable request with `422 no_trash_folder`, a
       * true-sounding sentence about the wrong machine. The word travels unresolved and
       * `applyMessageMove` resolves it on the organizer, the only place the answer exists.
       */
      const route = await routeMailboxWrite(
        tx as unknown as Tx, ctx.accountId, msg.mailboxId, "message.move",
      );
      if (route.route === "request") {
        return this.requestMove(tx, ctx, {
          messageId: id, mailboxId: msg.mailboxId, dedupKey: msg.dedupKey,
          destination: "trash", holder: route.holder,
        }, opts);
      }
      // The locked re-check — see `move`'s note on why the plain read above does not replace it.
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);

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
      /* WHERE IT CAME FROM — read BEFORE the desired write, because that write is what makes
         `observed` stop being the answer moments later (the organizer flips it to Trash when
         the physical move lands). Hoisted out of the branch below so the change row can carry
         it: a message with no server copy has no folder it rode from, so both stay null.

         `observed === trash` means the message is ALREADY in the Trash path — a delete pressed
         twice, or mail the organizer had filed there. There is nothing to remember, and
         remembering Trash as an origin would make a restore put it back where it is. */
      let observed: string | null = null;
      if (hasCopy && trash !== null) {
        observed = await this.observedFolder(tx, id, msg.nativeLocator);
        filed = msg.mailboxId;
        await this.upsertDesired(
          tx, id, observed, trash as Folder, now,
          observed === trash ? null : observed,
        );
      }
      await tx.update(messages).set({ deletedAt: now, updatedAt: now })
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId)));
      let seqBig = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: id, op: "delete",
        /* HISTORY ONLY, and NOTHING READS IT (mail 0099). The `move` verb beside this one has
           always recorded `{from, to}`; the delete recorded `null`, so the two verbs' history
           read differently for no reason. This closes that, and it is deliberately not the
           restore's operand — `change_log` has a retention horizon (`change-log.ts`), so a
           restore reading it would work for a week and then silently stop. `folder_state`
           .trashed_from is the durable answer. `null` for a message with no server copy: there
           was no move, so there is no from and no to. */
        meta: observed !== null && trash !== null ? { from: observed, to: trash } : null,
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

    /* THE DOORBELL, AFTER THE COMMIT. See {@link MessageService.ringFiledMailbox}: inside the
       transaction this deadlocked against every other writer of the mailbox row — measured on
       real Postgres as `40P01`, with a 500 to one of two concurrent decisions. */
    if (filed !== null) await this.ringFiledMailbox(ctx, filed);

    return answer;
  }

  /**
   * RESTORE — put a deleted message back where it was (mail 0099). It does NOT un-delete: it
   * writes the desired folder, pending, `us` — never `messages.deleted_at`. The message is IN the
   * provider's Trash; clearing the tombstone here would show mail in a pile while the server
   * still has it in Trash. Sequence: intent → the organizer's move → the passive read observes →
   * `clearDeletedOnAdopt` un-deletes and re-emits the entity. Refusals: a READER restores nothing
   * (asked FIRST); 409 `not_in_trash` for a row not in this mailbox's Trash path; a REPLAY is
   * answered from the idempotency key.
   */
  async restore(
    ctx: ServiceContext, id: string,
    opts: { idempotency?: MoveIdempotency | null } = {},
  ): Promise<{ restoreTo: string; pending: true; seq: number }> {
    let filed: string | null = null;
    const answer = await asTx(ctx).transaction(async (tx) => {
      const [msg] = await tx.select({
        id: messages.id, nativeLocator: messages.nativeLocator, mailboxId: messages.mailboxId,
      }).from(messages)
        .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      // A READER RESTORES NOTHING — see the header. First, so the sentence is the true one.
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);

      const [mb] = await tx.select({ trashFolder: mailboxes.trashFolder }).from(mailboxes)
        .where(eq(mailboxes.id, msg.mailboxId)).limit(1);
      const trash = mb?.trashFolder ?? null;
      const [fs] = await tx.select({
        desiredFolder: folderState.desiredFolder, trashedFrom: folderState.trashedFrom,
      }).from(folderState).where(eq(folderState.messageId, id)).limit(1);
      /* THE ONE PREDICATE — "is this message in this mailbox's Trash". A missing `folder_state`
         row, a mailbox with no Trash path, and a desired folder that is anything else all answer the
         same 409, because all three mean the same thing to a caller: there is nothing here to
         restore. */
      if (trash === null || !fs || fs.desiredFolder !== trash) {
        throw new ServiceError("not_in_trash", 409, "this message is not in Trash");
      }

      const target = await this.resolveRestoreTarget(ctx, msg.mailboxId, fs.trashedFrom);
      const now = ctx.now();
      filed = msg.mailboxId;
      /* `trashed_from: null` — the origin has been spent. A message restored and deleted again
         records its NEW origin at that delete; leaving this set would let the second delete
         inherit the first one's answer. Passed explicitly because `upsertDesired` requires it. */
      await this.upsertDesired(tx, id, trash, target, now, null);
      const seq = Number(await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: id, op: "move",
        meta: { from: trash, to: target },
      }));
      /* THE REPLAY OF A LOST RESPONSE IS ANSWERED AS APPLIED — see the header's own block on why
         the 409 was the wrong answer to it. The verbatim `{restoreTo, pending}` the route returns
         is stored IN this transaction, exactly as `move` and `delete` store theirs, so a commit
         followed by a lost response replays one answer rather than executing twice. */
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: { restoreTo: target, pending: true },
          seq,
          now: ctx.now(),
        });
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }
      return { restoreTo: target, pending: true as const, seq };
    });

    /* THE DOORBELL, AFTER THE COMMIT — {@link MessageService.ringFiledMailbox}'s measured rule.
       A restore is the one filing where the wait is most visible: the row has left Trash and has
       not arrived anywhere, so asking the organizer to come sooner is worth a statement. */
    if (filed !== null) await this.ringFiledMailbox(ctx, filed);

    return answer;
  }

  // ── helpers ──

  /**
   * Reading — or re-filing — a resurfaced row SPENDS the resurface. The worker flips a due
   * `bubbled_up` to `resurfaced`, pinning the row at the top of the Ohbox; exactly two verbs deal
   * with it: deliberately marking it read (a settled reply counts) and filing it. Both clear the
   * state to `none` IN THE CALLER'S TRANSACTION, so "Resurfaced" never outlives the act that
   * answered it. A GLANCE is neither: the read lands, the pin stays. One implementation for every
   * route — the first defect was a route gap: only the batch route cleared, so which client a
   * user read in decided whether their pin came down. Scoped to `state = 'resurfaced'` alone.
   * Emitted as `message_state` updates so every client drops the pin on the next `/sync`.
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

  /**
   * Upsert folder_state desired=<folder>, pending, us — preserving observedFolder on conflict.
   *
   * IT DOES NOT RING THE WORKER'S DOORBELL, and that is a correction rather than an omission:
   * {@link MessageService.ringFiledMailbox} does, after the transaction commits, for the measured
   * reason written out there.
   */
  private async upsertDesired(
    tx: Tx, id: string, observed: string, folder: string, now: Date,
    /**
     * WHERE THIS MESSAGE CAME FROM, for a delete — and `null` for everything else (mail 0099).
     *
     * REQUIRED rather than optional, and that is the whole design of this parameter. The column
     * has to be CLEARED by every non-Trash desired write, or a message filed out of Trash and
     * deleted again from somewhere else would restore to the origin of its previous life. An
     * optional argument makes forgetting the clear the default: a new door would write
     * `desired_folder` and leave a stale origin behind, and nothing would fail. Required, a
     * caller cannot write the desired folder without saying what this becomes.
     */
    trashedFrom: string | null,
  ): Promise<void> {

    await tx.insert(folderState).values({
      messageId: id, desiredFolder: folder, observedFolder: observed,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false, trashedFrom,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      // observedFolder deliberately omitted → preserved (worker owns it).
      // `trashedFrom` is deliberately NOT omitted: it is written on every conflict, which is
      // what makes "every non-trash write clears it" true of an existing row and not only of a
      // fresh one. See the parameter's own block.
      set: { desiredFolder: folder, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: now, trashedFrom },
    });
  }

  /**
   * Ask the organizer to come sooner — AFTER the commit, never inside it. The ROTATION decides
   * the wait, so one pending move waited minutes; every other filing verb rings this doorbell and
   * the move door did not. Inside the transaction it DEADLOCKED, measured: the transaction
   * already holds row locks on `messages` and `folder_state`, so adding a `mailboxes` lock closed
   * a cycle — real Postgres answered `40P01` for two concurrent decisions over ONE mailbox; three
   * pg suites caught it, PGlite saw none. Post-commit and best-effort: a crash between commit and
   * ring costs ONE ROTATION, and a throw is swallowed — a committed decision must not be reported
   * as failed by the thing that was only trying to make it faster.
   */
  private async ringFiledMailbox(ctx: ServiceContext, mailboxId: string): Promise<void> {
    try {
      await ringFilingDoorbell(ctx.db as unknown as Tx, mailboxId, ctx.now());
    } catch (err) {
      /* SWALLOWED FOR THE CALLER, NEVER FOR THE LOG. The decision has committed and the poll is
         the floor beneath this either way — so the throw must not reach the person who filed the
         message. What it must not do is vanish: a bare `catch {}` here makes a doorbell that
         THREW and a doorbell that was never rung read identically from outside, which is the
         shape that turns a slow rotation into an unfalsifiable report. One warn line, and the
         `err` field rather than a hand-extracted class: this logger derives `errorClass` and the
         cause at the emit site and refuses the driver's own message by design. */
      doorbellLog.warn("filing_doorbell_failed", {
        accountId: ctx.accountId,
        mailboxId,
        err,
        reason: "the filing itself COMMITTED; only the ask-the-organizer-sooner stamp failed, so "
          + "the move lands on the next rotation instead of within seconds",
      });
    }
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
   * Write the move request and answer `pending`. No local write of any kind happens here. Shared
   * by `move` and `delete` because the two differ only in which word they name, and two copies of
   * "compose the payload, claim the idempotency key, materialize the unmoved row" is how one of
   * them ends up claiming the key with the wrong status. The idempotency claim stores `202` — the
   * status the live call returns — so a replay answers what the first press answered. `seq: null`
   * because nothing changed in this store; a seq here would advance every client's cursor past a
   * change that does not exist.
   */
  private async requestMove(
    tx: Tx, ctx: ServiceContext,
    r: {
      messageId: string; mailboxId: string; dedupKey: string; destination: string;
      holder: OrganizedBy;
    },
    opts: { idempotency?: MoveIdempotency | null },
  ): Promise<MoveRequestResult> {
    const requestId = randomUUID();
    const pending = await writeReaderRequest(tx, ctx, {
      mailboxId: r.mailboxId,
      kind: "message.move",
      // EXACTLY what `validateMovePayload` re-checks on the other side, and nothing else. The
      // payload crosses an install boundary through a header another machine wrote, so the
      // organizer validates it again independently — this is the door's half of that pair.
      payload: { dedupKey: r.dedupKey, destination: r.destination },
      holder: r.holder,
      requestId,
    });

    const dto = await materializeMessage(asDb(tx), ctx.accountId, r.messageId);
    if (!dto) throw new ServiceError("internal", 500, "message vanished after write");
    const result: MoveRequestResult = { ...pending, dto };

    if (opts.idempotency) {
      const claimed = await claimIdempotencyKey(tx, {
        accountId: ctx.accountId,
        key: opts.idempotency.key,
        requestHash: opts.idempotency.requestHash,
        responseStatus: 202,
        responseJson: result,
        seq: null,
        now: ctx.now(),
      });
      if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
    }
    return result;
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
