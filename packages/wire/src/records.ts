/**
 * THE SYNC FEED: the kinds of record it carries, one change of it, a page of changes and the
 * snapshot a cold start reads instead. The server builds these; every client applies them.
 */
import type { Cursor, Folder, ISODateTime } from "./base.js";
import type { CalendarRecordKind } from "./calendar.js";

// The client-visible entity kinds that flow through `/sync`. Growing this union is not free: a
// type here without a matching case in `materialize` is worse than none — the materializer falls
// through to `null`, `SyncService` reads a null entity as a TOMBSTONE, and every row of the new
// kind drains to the client as a `delete`. Add a kind together with its materializer
// (`packages/services/src/dto/materialize.ts`) in the same change. Tag ASSIGNMENTS are not a type
// here: they ride the existing `message` entity — one change per toggle; a separate `message_tag`
// entity would mean two changes at two seqs, with a window where the client has the assignment
// but not the tag it names.
export type MailRecordKind =
  | "message" | "thread" | "routing_decision" | "approval"
  | "draft" | "rule" | "message_state" | "folder"
  // Tag identity (name + hue). The assignment rides `message`; see above.
  | "tag"
  /**
   * The account's own settings row — added together with `materializeSettings`
   * (`packages/services/src/dto/materialize.ts`), the condition the rule above imposes. One row
   * per account, so `entity_id` is the ACCOUNT id and the op is always `"update"` (created lazily
   * by whichever knob writes first, never deleted). The change exists so a settings write rings
   * the wake channel and travels the delta feed: without it, a consent flip made on one surface
   * reached other signed-in surfaces only at their next full boot. The entity carries the row's
   * scalars, but the AUTHORITY stays `GET /consent` — clients treat the change as "re-ask now",
   * not a second consent read, so the two doors cannot drift.
   */
  | "settings"
  /**
   * A MAILBOX THIS ACCOUNT NO LONGER HOLDS — emitted with op `"delete"` and nothing else, so it
   * needs no materializer (`getChanges` short-circuits a delete into the tombstone bucket). The
   * entity id is the MAILBOX's id and the row is the whole receipt; a client cascades its own
   * dependents from it. ONE ROW FOR A WHOLE MAILBOX: a mirror learns only from this log, so a
   * removal that appends nothing here leaves every client rendering the mailbox it removed. NOT
   * written by an ordinary disconnect — a soft `MailboxService.delete` keeps the mail; only the
   * two acts that take a mailbox's mail off the store emit it (`wipeLocalMirror`,
   * `sweepMailboxData`).
   */
  | "mailbox"
  /**
   * A BOUGHT SCREENER SUGGESTION — the narrow verdict entity (owner decision 2026-09-18,
   * reversing "no model output in /sync": the entity carries the chip's fields, never the
   * model's text — see `storeScreenerSuggestion`). The entity id is the `routing_decisions`
   * ROW id; a re-buy emits a delete for the replaced row and a create for the new one in the
   * same transaction, so a mirror never holds two live rows for one purchase. Materialized by
   * `materializeScreenerSuggestion` (`packages/services/src/dto/materialize.ts`), which is
   * provenance-scoped: a pipeline decision's id materializes null under this type.
   */
  | "screener_suggestion"
  /**
   * THE ORGANIZER'S ARRANGEMENT OF A MAILBOX THIS INSTALL ONLY READS — a projection of the cached
   * document (`mailbox_profile_mirror`), never a second rule store. The entity id is the MAILBOX
   * id and the op is always `"update"`; it materializes only while `organizer_role` is not
   * `organizer`, so a promotion drains it as a tombstone. Rung by {@link recordMailboxProfileChange}.
   */
  | "mailbox_profile";

/** Every kind of record the feed carries: the mail's, and the calendar's once it has any. */
export type RecordKind = MailRecordKind | CalendarRecordKind;

export type ChangeOp = "create" | "update" | "move" | "delete";

/**
 * The kinds a device copy stores from the feed. NOT the whole {@link RecordKind}, which also
 * carries `settings`: that rings the wake channel and its authority is `GET /consent`, so no
 * mirror stores one. A client's `?types=` filter is a list at run time; the list proves itself
 * complete against this type, so a kind added to the feed does not compile until every such
 * list names it.
 */
export type SyncEntityType = Exclude<RecordKind, "settings">;

// ── /sync wire shapes (contract §3.1) ──────────────────────────────────────

/**
 * One change of the feed. `K` is the set of kinds its holder knows: the server's closed
 * {@link RecordKind} unless said otherwise. A device copy says otherwise ({@link MirrorChange}).
 */
export interface SyncChange<T = unknown, K extends string = RecordKind> {
  type: K;
  op: ChangeOp;
  id: string;
  /** Global monotonic per-account sequence — the order of record (§3.3). */
  seq: number;
  updatedAt: ISODateTime;
  /** The full resource DTO; OMITTED for op:"delete". */
  entity?: T;
  /** Present only for op:"move" on messages. */
  move?: { from: Folder | null; to: Folder };
}

/**
 * A change as a device copy holds it: any kind. A client tolerates a kind it has never heard of
 * (forward-compatible parsing), and it keeps rows of its own under kinds the server never sends.
 */
export type MirrorChange<T = unknown> = SyncChange<T, string>;

export interface SyncResponse<K extends string = RecordKind> {
  changes: {
    creates: SyncChange<unknown, K>[];
    updates: SyncChange<unknown, K>[];
    moves: SyncChange<unknown, K>[];
    deletes: SyncChange<unknown, K>[];
  };
  cursor: Cursor;
  hasMore: boolean;
  serverTime: ISODateTime;
}

/**
 * How far back the snapshot reaches, SERVED rather than agreed: a constant compiled into the
 * client disagrees with the server the first time either moves. `days` is the recency floor,
 * `minRows` the volume floor, and a snapshot serves whichever is LARGER — a quiet mailbox still
 * bootstraps into something usable, a busy one is not cut at ninety days minus one message.
 * `maxRows` is the CEILING over both, which makes the window a function of the POLICY rather than
 * of the mailbox: `days` alone keeps everything recent. Optional on the wire because a server
 * older than the field states no ceiling, which is what that server does.
 */
export interface SnapshotWindow {
  days: number;
  minRows: number;
  maxRows?: number;
}

/**
 * `GET /sync/snapshot` — the bootstrap reader. It reuses `SyncChange` because the client's apply
 * path is the thing worth protecting: it already sorts by seq, upserts on (type,id) and refuses
 * an older-or-equal seq — a bespoke snapshot shape would need a second apply path, and two apply
 * paths over one store is how a mirror holds a state neither can explain. A snapshot row is a
 * `SyncChange` with `op: "create"` and the full DTO. EVERY row carries `seq = asOfSeq`, making
 * the older-or-equal guard correct for free: a later delta wins, a re-read of the same page is
 * ignored. `nextCursor` is `null` when complete, opaque, encoding `asOfSeq` beside the keyset
 * position — every page reads one consistent point.
 */
export interface SnapshotResponse {
  asOfSeq: number;
  changes: SyncChange[];
  nextCursor: string | null;
  window: SnapshotWindow;
  /**
   * WHICH RUN OF THE STORE `asOfSeq` BELONGS TO — stated because the client MINTS its own `/sync`
   * cursor from `asOfSeq`, so a snapshot that does not say leaves that cursor naming no run. A
   * store that cannot lose a committed row states nothing, and a client that sees nothing mints
   * the shape it always did. See `SyncService.decodeCursor`.
   */
  storeGeneration?: number;
}

/**
 * One page of `GET /sync/snapshot` — the cold-start path replacing `since=0`, which replays the
 * whole change log; a snapshot is the current state, one `op:"create"` per live row, read at
 * one consistent point ({@link asOfSeq}). Three properties a consumer may rely on: every page
 * reads the SAME point (a delta drain resuming at `asOfSeq` misses nothing); page 1 is all live
 * state plus the newest page of messages, later pages messages only, newest-first; `nextCursor`
 * is opaque and `null` on the last page — never a `/sync` cursor. `window` is informational:
 * the client must not adopt it as its storage policy.
 */
export interface SyncSnapshotPage {
  /**
   * The sequence number the whole snapshot was read at. The client commits `String(asOfSeq)` as
   * its `/sync` cursor — and only with the LAST page (contract §3.3): a crash mid-snapshot must
   * leave the cursor at "0" so the next start re-snapshots rather than resuming from a point it
   * never fully applied.
   */
  asOfSeq: number;
  /** Live rows as full DTOs. Always `op:"create"`, always `seq === asOfSeq`. */
  changes: MirrorChange[];
  /** The server's opaque paging token; `null` ⇒ this was the last page. */
  nextCursor: string | null;
  /**
   * What the server paged with. Informational — see the note above. `maxRows` is the server's ROW
   * ceiling beside `days` and `minRows`; optional because a server older than the field states no
   * ceiling, which is what that server does.
   */
  window: { days: number; minRows: number; maxRows?: number };
  /**
   * WHICH RUN OF THE SERVER'S STORE `asOfSeq` BELONGS TO, when that store can lose a committed
   * row and re-derive it at the same seq (the desktop's local one). It travels into the cursor
   * this client mints from `asOfSeq` — {@link encodeSeqCursor} — so the server can refuse a
   * cursor belonging to a run that ended. ABSENT from a server that states none, and a cursor
   * minted without it is the shape this client has always sent.
   */
  storeGeneration?: number;
}

/**
 * The `view_meta` row of a device's first completed sync (id `feed_since`), written once by the
 * engine's drain. A reading stream whose line cannot be placed cuts here; before any visit nothing
 * is cut, and an unread letter is new until read.
 */
export interface FeedSinceMeta {
  at: ISODateTime;
}
