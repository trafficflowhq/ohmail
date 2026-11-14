/**
 * @ohmail/client-engine — the wire vocabulary's VALUES. The shapes themselves are declared once,
 * in `@ohmail/wire`, without importing any backend package, and are re-exported here under the
 * names this package has always given them; what stays in this file is what runs: the lists, the
 * view maps, the errors and the cursor helpers. Clients tolerate unknown fields and entity types
 * (forward-compatible parsing), hence the open unions. The `§` references cite the Cloud API
 * contract document, which is not public — the citations stay because they are load-bearing
 * where the file is authored; nothing here depends on reading it.
 */

import type {
  Assert, Complete, Cursor, EngineMutation, FeedView, Folder, MutationKind, OhmailView, ScreenerWaitingPageDTO,
  SensitivityFlags, SyncChange as WireSyncChange, SyncEntityType, SyncResponse as WireSyncResponse,
  TriageState as WireTriageState, WithheldMarker,
} from "@ohmail/wire";
import type { KnownMirrorEntityType } from "./mirror-bounds.js";

/* The vocabulary's types, from their one home. */
export type {
  BodyState, ChangeOp, ComposeAttachment, Cursor, EmailAddress, EngineDraft, EngineMessage, EngineMessageExtras,
  EngineMutation, FailedAtGateDTO, FeedSinceMeta, FeedView, Folder, FolderEntity, HeldReleaseGroupDTO, ISODateTime,
  MailboxProfileEntity, MessageBody, MessageBodyBatchWire, MessageBodyRecord, MessageBodyWire, MessageStateDTO,
  MutationKind, OhmailView, RuleKeyAddress, ScreenDest, ScreenerHeldMail, ScreenerSegment, ScreenerSenderDTO,
  ScreenerSuggestionEntity, ScreenerWaitingDTO, ScreenerWaitingPageDTO, ScreenerWaitingSenderDTO, SensitivityFlags,
  SyncEntityType, SyncSnapshotPage, TriageItemDTO, UnscreenedGroupDTO, UnsubscribeHeaderState, UnsubscribeRefusal, UnsubscribeResult,
  WaitingRequestWire, WaitingTargetWire, WaterlineMeta, WithheldMarker,
} from "@ohmail/wire";
/*
 * Three names this package gives a wire type of another name. A rule and a tag as a device copy
 * reads them (the server's records are the wire's `RuleDTO` and `TagDTO`), and every triage state
 * that crosses the wire.
 */
export type { RuleEntity as RuleDTO, TagEntity as TagDTO, TriageState as TriageWireState } from "@ohmail/wire";
// The News pile's pre-0.22 folder name: mirror rows written before the organizer renamed the
// folder still carry it, so the view map admits both spellings (`VIEW_OF_FOLDER` below).
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";

/**
 * The EntityType values the server's `/sync` feed carries today (contract
 * §3.1). `"tag"` joined late, and the move is the point: it sat only in
 * {@link MirrorEntityType} among the demo types, so `TagView`, `TagPicker`
 * and `t` all worked against fixtures while a real account drained a feed
 * with no vocabulary for a tag and rendered an empty picker forever. Tag
 * ASSIGNMENTS are deliberately not a type here — they ride the `message`
 * entity (`MessageDTO.labels`), so a client can never hold an assignment
 * naming a tag it has not received.
 */
/**
 * THE SAME SET AS A VALUE, PROVEN AGAINST THE WIRE'S UNION (`SyncEntityType`) — one set, not two.
 *
 * A client's `?types=` filter is a list at run time, so a hand-written union goes stale silently:
 * the phone's list predated `mailbox`, so it never asked for the receipt, never ran the cascade,
 * and a mailbox removed on the paired desktop stayed on the phone with its mail. Proving the
 * list against the union makes such a filter complete. NOT the server's whole `EntityType`, which
 * also carries `settings`: that rings the wake channel and its authority is `GET /consent`, so no
 * mirror stores one.
 */
export const SYNC_ENTITY_TYPES = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
  /**
   * A mailbox this account no longer holds, and it arrives ONLY as `op: "delete"` — the server
   * emits nothing else under this type ({@link MAILBOX_TYPE}). The id is the mailbox's, and the
   * mirror cascades from it: every row keyed by that mailbox goes, in the same apply.
   */
  "mailbox",
  /**
   * A bought Screener suggestion — the narrow verdict entity ({@link ScreenerSuggestionEntity}).
   * Keyed by the stored row's id; a re-buy arrives as a delete + create pair in one page, so the
   * mirror never holds two live rows for one purchase. A surface groups by `senderKey` — the
   * suggestion is ABOUT a sender, bought from one message — and renders the newest `boughtAt`.
   */
  "screener_suggestion",
  /**
   * The organizer's arrangement of a mailbox this install only reads ({@link MailboxProfileEntity}),
   * keyed by the mailbox. A tombstone means the local rules decide that mailbox again.
   */
  "mailbox_profile",
] as const satisfies readonly SyncEntityType[];
type _SyncEntityTypesComplete = Assert<Complete<SyncEntityType, typeof SYNC_ENTITY_TYPES>>;

/** The `mailbox_profile` entity's own name — the partition, the bounds table and the tests agree on it. */
export const MAILBOX_PROFILE_TYPE = "mailbox_profile";

/**
 * The `"mailbox"` row's own name, because three places have to agree on it — the store's cascade,
 * the engine's count, and the fixture world that has always kept client-local `mailbox` rows
 * under the same key. A literal typed three times is a literal that can disagree twice.
 */
export const MAILBOX_TYPE = "mailbox";

/**
 * Everything the LOCAL mirror stores. Beyond the synced types, the engine keeps
 * client-local entities for the demo/fixture world (`screener_sender`,
 * `triage_item`), view metadata (`view_meta`, e.g. the Reads waterline) and
 * hydrated message bodies (`message_body`). `mailbox` rows are both: the demo
 * world writes them locally and a real account receives the delete above.
 * Unknown strings are tolerated by design.
 */
export type MirrorEntityType =
  | KnownMirrorEntityType
  | (string & {});

/**
 * THE CLOSED HALF IS THE BOUNDS TABLE'S OWN LIST, so the two cannot drift: a `/sync` type this
 * package learns must be added to {@link MIRROR_ENTITY_TYPES} — where `MIRROR_BOUNDS` then
 * refuses it without an answer — rather than only here, where nothing would ask what bounds it.
 * The assertion is a type, evaluated by `tsc -b`, and it is the direction the `Record` cannot
 * cover on its own.
 */
type SyncTypesAreKnown = SyncEntityType extends KnownMirrorEntityType ? true : never;
const _syncTypesAreKnown: SyncTypesAreKnown = true;
void _syncTypesAreKnown;

// ── /sync wire shapes (contract §3.1) ──────────────────────────────────────

/** One change as this mirror holds it: the wire's change, its kind widened to {@link MirrorEntityType}. */
export type SyncChange<T = unknown> = WireSyncChange<T, MirrorEntityType>;
/** One `/sync` page as this mirror applies it: the wire's page, with the same widening. */
export type SyncResponse = WireSyncResponse<MirrorEntityType>;

// ── entity DTO mirrors ─────────────────────────────────────────────────────

/**
 * This client's word for a triage state a person can CHOOSE: the wire's set without `resurfaced`.
 * The extra member is kept OUT of `TriageState`, and that is load-bearing: `TriageState` is this
 * client's word for a bottom pile (`TriageItemDTO.pile` is its piles), and a resurfaced message
 * belongs to NO pile — it is pinned at the top of the Ohbox — so widening `TriageState` would
 * invite a fourth pile that must never exist. Every state that crosses the wire is
 * `TriageWireState`: server-set by `bubbleUpPass`, and client-settable for "resurface this now"
 * (a past `bubbleUpAt` pins nothing on standalone).
 */
export type TriageState = Exclude<WireTriageState, "resurfaced">;

/**
 * Is this message's body withheld from the reader — now always NO. It used
 * to blank mail flagged sensitive; that is removed: the mail already sits
 * in full on the person's own server, so hiding the app's copy only hid it
 * from the one person entitled to read it, and the detector over-fired on
 * ordinary mail. Sensitivity is still a label (kept out of automatic AI),
 * but it no longer withholds the body. The predicate stays as a single
 * named seam — its callers gate body fetch, search indexing and the body
 * cache — a constant `false` on purpose.
 */
export function isProtectedMessage(
  _m: { sensitivity?: SensitivityFlags | null; protected?: unknown } | null | undefined,
): boolean {
  return false;
}

// ── message bodies ─────────────────────────────────────────────────────────

/** The closed set as a value, read by every narrowing so a new member reaches all of them. */
const WITHHELD_MARKER_LIST = ["storage_cap", "junk_filed", "expunged", "too_large"] as const satisfies readonly WithheldMarker[];
type _WithheldMarkersComplete = Assert<Complete<WithheldMarker, typeof WITHHELD_MARKER_LIST>>;
export const WITHHELD_MARKERS: readonly WithheldMarker[] = WITHHELD_MARKER_LIST;
export const isWithheldMarker = (w: unknown): w is WithheldMarker =>
  (WITHHELD_MARKERS as readonly unknown[]).includes(w);

// ── view metadata ──────────────────────────────────────────────────────────

/**
 * Each stream's `view_meta` row id. One mapping, shared by the `feed_mark_seen`
 * effect that writes the line and the partition selector that reads it, so the two
 * can never disagree about where a view's waterline lives.
 */
export function waterlineIdOf(view: FeedView): string {
  return view === "reads" ? "reads_waterline" : "receipts_waterline";
}

/**
 * `view_meta` id of THIS DEVICE's first completed sync, written once by the engine's drain. A
 * reading stream whose line cannot be placed cuts here (`feedPartition`); before any visit nothing
 * is cut, and an unread letter is new until read.
 */
export const FEED_SINCE_ID = "feed_since";

// ── views ──────────────────────────────────────────────────────────────────

export const FOLDER_OF_VIEW: Record<OhmailView, Folder> = {
  ohbox: "INBOX",
  reads: "ohmail/News",
  receipts: "ohmail/Receipts",
  screener: "ohmail/Screener",
  screened: "ohmail/Screened",
  spam: "ohmail/Quarantine",
};

/**
 * The last path segment of a folder name — the only safe way to show a folder
 * this client has no view for.
 *
 * It exists rather than views falling back to the raw string because unknown
 * folders are expected: the server may add folders a shipped client has never
 * heard of (contract §8), and customers nest their own. The leaf of
 * `ohmail/Receipts` is `Receipts`; the leaf of a customer's own
 * `Archive/2026/Q1` is `Q1`. Both read correctly; neither shows a path.
 */
export function folderLeaf(folder: string): string {
  const leaf = folder.split("/").filter(Boolean).pop() ?? folder;
  return leaf.trim() || folder;
}

export const VIEW_OF_FOLDER: Record<Folder | typeof LEGACY_NEWS_FOLDER, OhmailView> = {
  "INBOX": "ohbox",
  "ohmail/News": "reads",
  // Rows written before the 0.22 folder rename: both spellings are the News pile, and admitting
  // the legacy key HERE keeps every lookup site whole on a mailbox the organizer has not renamed.
  [LEGACY_NEWS_FOLDER]: "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
  "ohmail/Screened": "screened",
  "ohmail/Quarantine": "spam",
};

// ── mutations ──────────────────────────────────────────────────────────────

/**
 * The mutation vocabulary as a runtime value — the census pin for the verb-parity harness.
 * {@link EngineMutation} is a type, so nothing at runtime can enumerate it, and the harness
 * that drives every user verb through the real API (`test/verb-parity/`, INSTANT-ARCH §6.2(e))
 * needs a runtime list or it covers whatever somebody remembered. Pinned both ways in a file
 * `tsc -b` checks: `satisfies` refuses a non-mutation entry, and the `Complete` proof under the
 * list goes red when the union grows without this list. Adding a verb
 * without extending the list fails typecheck; extending it without classifying the verb fails
 * the parity census.
 */
export const MUTATION_KINDS = [
  "move",
  "message_delete",
  "triage_set",
  "screener_decide",
  "tag_assign",
  "tag_create",
  "tag_rename",
  "tag_recolor",
  "tag_delete",
  "folder_create",
  "folder_rename",
  "folder_delete",
  "folder_op_dismiss",
  "feed_mark_seen",
  "mark_seen",
  "mail_send",
  "draft_accept",
  "draft_schedule_cancel",
  "draft_save",
  "draft_discard",
  "draft_resolve",
  "rule_delete",
  "rule_update",
  "rule_create",
] as const satisfies readonly EngineMutation["kind"][];

/**
 * The union → array half of the pin: `true` while every {@link EngineMutation} kind appears in
 * {@link MUTATION_KINDS}; a type naming the MISSING KIND the moment one does not, so the compile
 * error on the line below names the verb that was added without being listed.
 */
type _MutationKindsComplete = Assert<Complete<MutationKind, typeof MUTATION_KINDS>>;

// ── errors ─────────────────────────────────────────────────────────────────

/** `410 cursor_expired` — discard local state and re-bootstrap with since=0 (§3.2). */
export class CursorExpiredError extends Error {
  constructor(message = "sync cursor expired; re-bootstrap with since=0") {
    super(message);
    this.name = "CursorExpiredError";
  }
}

/**
 * The door refused the cursor its own snapshot had just issued — or a 410 arrived while the
 * engine is still holding off after one. A defect of the door, never of the mirror: the engine
 * keeps the snapshot's rows and re-snapshots only when the hold ends. A `CursorExpiredError`, so
 * a reader that asks "was the cursor refused" still reads yes.
 */
export class SnapshotCursorRefusedError extends CursorExpiredError {
  constructor(message = "the door refused the cursor its own snapshot issued") {
    super(message);
    this.name = "SnapshotCursorRefusedError";
  }
}

/** A mutation the server (or adapter) refused. `retryable` gates the offline queue. */
export class MutationRejectedError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  /**
   * How long the server asked us to wait, in ms, from its `Retry-After` —
   * `null` when it said nothing. Load-bearing for the outbox's give-up
   * ceiling: a refusal that names its interval is a server declining work
   * it knows it cannot do yet (`503 db_busy`), which must not consume the
   * queue's patience — a twenty-minute pool outage would abandon every
   * legitimate verb — while an unmodelled failure must, or a poisoned verb
   * hammers forever (`OUTBOX_MAX_SERVER_FAILURES`). `null` and `0` differ:
   * `0` is the server saying "immediately", which is still the server speaking.
   */
  readonly retryAfterMs: number | null;
  /**
   * The server row this refusal is about, when the refusal knows one — `null` otherwise.
   * `MutationResult.entityId` rides the confirmed result only; the exception that matters is a
   * send pressed before the first autosave: the adapter creates a row, the answer comes back
   * `unverified`, and without this the client is never told which row was marked — it sits in
   * Drafts looking ordinary and one press delivers the message twice. The row is NAMED, not
   * adopted (nothing may PUT to it), so the durable record can park the message it belongs to.
   * Same for a `queued` answer: a reload that cannot name the row mints a second one.
   */
  readonly entityId: string | null;
  /**
   * The refusal's own structured facts, from the server's `{error:{details}}`. `message` is
   * server English — rendering it puts an untranslated protocol sentence inside a translated
   * interface (shipped once already), so surfaces branch on `code`. But a code cannot carry a
   * FACT, and some refusals turn on one: a duplicate send is refused differently depending on
   * whether the first attempt is known-sent, unconfirmed or still running. The details ride
   * along, opaque to this class, read by the surface that knows the shape. Distinct from
   * `retryAfterMs`: that is modelled and branched on; this is carried.
   */
  readonly details: unknown;
  /**
   * TRUE when this refusal follows a CREATE that went out and whose answer could not be read.
   *
   * `POST /drafts` ignores the idempotency key, so a second attempt writes a second row. The
   * adapter remembers the key and refuses the repeat — but that memory dies with the adapter, and
   * the outbox entry outlives it, so the flag rides the refusal and is persisted WITH the intent.
   */
  readonly createAttempted: boolean;
  constructor(
    message: string,
    opts: {
      status?: number | null; code?: string | null; retryable?: boolean; retryAfterMs?: number | null;
      entityId?: string | null;
      details?: unknown;
      createAttempted?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "MutationRejectedError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.entityId = opts.entityId ?? null;
    this.details = opts.details;
    this.createAttempted = opts.createAttempted === true;
  }
}

/** A mutation kind this adapter has no wire mapping for (e.g. tags pre-Stage-2). */
export class UnsupportedMutationError extends MutationRejectedError {
  constructor(kind: string) {
    super(`mutation kind "${kind}" is not supported by this adapter`, { retryable: false, code: "unsupported_mutation" });
    this.name = "UnsupportedMutationError";
  }
}

// ── base64url helpers (browser + node) ─────────────────────────────────────

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encodeAscii(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    out += B64_CHARS[a >> 2]!;
    out += B64_CHARS[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]!;
    out += Number.isNaN(b) ? "=" : B64_CHARS[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]!;
    out += Number.isNaN(c) ? "=" : B64_CHARS[c & 63]!;
  }
  return out;
}

function b64decodeAscii(s: string): string {
  if (typeof atob === "function") return atob(s);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    if (ch === "=") break;
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) throw new Error("invalid base64");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Encode a numeric seq as an opaque base64url cursor (server-shape parity), carrying the run of
 * the server's store it belongs to when the server stated one ({@link SyncSnapshotPage}).
 *
 * The generation goes IN the cursor because the cursor is the one value every surface already
 * round-trips unread. A server that states none produces exactly the bytes this client has always
 * sent, so the hosted wire does not move.
 */
export function encodeSeqCursor(seq: number, generation?: number | null): Cursor {
  const body = generation == null ? String(seq) : `${generation}.${seq}`;
  return b64encodeAscii(body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url seq cursor; returns null when malformed ("0" ⇒ 0). */
export function decodeSeqCursor(cursor: Cursor): number | null {
  if (cursor === "0" || cursor === "") return 0;
  try {
    const raw = b64decodeAscii(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    // The generation, when present, is IN FRONT of the seq — the server's own spelling. A reader
    // that wants the position wants the seq; nobody on this side compares generations.
    const m = /^(?:\d+\.)?(\d+)$/.exec(raw);
    if (m === null) return null;
    return Number(m[1]);
  } catch {
    return null;
  }
}

/**
 * The two client-local types that survive a re-bootstrap. Declared here because the STORE
 * carries them through a wipe (`BaseMirrorStore.resetForBootstrap`) and the ENGINE writes and
 * replays them — "these two, and only these two, ride through a 410" has to be one declaration.
 * The carve-out is narrow: every seq-0 row is client-local, but most are re-derivable (a
 * `message_body` is re-fetched, a waterline costs one re-mark); these two derive from nothing —
 * a queued verb IS the user's intent, and an abandoned one is the intent nothing else will
 * deliver. A 410 is a statement about the CURSOR.
 */
/**
 * MAIL HELD AT THE GATE BEHIND A RULE ITS OWNER ALREADY WROTE — one row per sender group.
 *
 * A client-local type ({@link putLocal}, seq 0) and deliberately NOT a `/sync` entity. The set is a
 * DERIVATION the server does over the caller's own rules and folder state, and it is answered by a
 * REST read the way the mailbox and tracker facts are — no `change_log` vocabulary, no `EntityType`
 * growth, clients refetch. It lives in the mirror rather than in a shell's own state so that the
 * desktop, the web app and the phone read one selector instead of three derivations that agree
 * today. The row `id` is the RULE's id, which is exactly what the press posts back.
 */
export const HELD_RELEASE_TYPE = "held_release_group";

/**
 * DECIDED SENDERS THE CUTLINE HAS RETIRED, as the consent partition names them — never stored,
 * answered by `presentationReader` alone. Their unmoved mail stays at the gate, and
 * a decided sender is not asked about again: the server's queue retires them by the same cutline.
 * `screenerSegments` reads it beside {@link HELD_RELEASE_TYPE}.
 */
export const RETIRED_DECIDED_TYPE = "consent_retired_decided";

/**
 * OWN LETTERS HISTORY HOLDS IN A FOLDER THAT KEEPS THEM, as the consent partition names them
 * (`sentInHistory`) — never stored, answered by `presentationReader` alone. `ohboxView` leaves
 * them out of its own-sent union: History holds them, the folder lists them, "Earlier" does not.
 */
export const SENT_IN_HISTORY_TYPE = "consent_sent_in_history";

/**
 * OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — one row per sender group.
 *
 * A client-local type ({@link putLocal}, seq 0) and deliberately NOT a `/sync` entity, for
 * {@link HELD_RELEASE_TYPE}'s reason: the set is a DERIVATION the server does over the caller's
 * own Ohbox against the ARRIVAL GATE's own predicate, answered by a REST read the way the mailbox
 * and tracker facts are. It lives in the mirror rather than in a shell's own state so the desktop,
 * the web app and the phone read one selector instead of three derivations that agree today. The
 * row `id` is the sender's ADDRESS, which is exactly what the press posts back.
 */
export const UNSCREENED_TYPE = "unscreened_sender_group";

/**
 * THE SCREENER'S WAITING QUEUE AS THE STORE HOLDS IT — one page of `GET /screener`, client-local
 * (seq 0, never a `/sync` entity) and replaced wholesale by {@link OhmailEngine.refreshScreenerWaiting}.
 * The mirror is windowed and the queue is not, so the waiting set and its count come from here.
 * One `page` row names the answer (its absence is "not answered", never "nobody waiting"), and one
 * `sender` row per sender the page lists, in the page's order.
 */
export const SCREENER_WAITING_TYPE = "screener_waiting";
/** The id of the one `page` row; every sender row's id is `sender:` plus its key. */
export const SCREENER_WAITING_PAGE_ID = "page" satisfies ScreenerWaitingPageDTO["id"];

export const OUTBOX_TYPE = "outbox_entry";
export const OUTBOX_ABANDONED_TYPE = "outbox_abandoned";
/**
 * A routing window's journal, kept in the mirror by a surface with no `localStorage` (the phone):
 * one row per journal key, `{ value }` the jar's string. A press not yet sent derives from
 * nothing a re-bootstrap returns, so it rides the wipe with the outbox.
 */
export const ROUTING_JOURNAL_TYPE = "routing_journal";

/**
 * A letter being written on the phone, and each file picked for it: kept in the account's own
 * mirror so a hard stop loses neither, and carried through a wipe because nothing re-derives them.
 */
export const COMPOSE_LETTER_TYPE = "compose_letter";
export const COMPOSE_FILE_TYPE = "compose_file";

/** The rows the wipe carries — the outbox's two collections, the routing journal and the letters. */
export function isCarriedLocalType(type: string): boolean {
  return type === OUTBOX_TYPE || type === OUTBOX_ABANDONED_TYPE || type === ROUTING_JOURNAL_TYPE
    || type === COMPOSE_LETTER_TYPE || type === COMPOSE_FILE_TYPE;
}
