// `@trafficflow/core/ics` maps to a dependency-free SOURCE module (see its header) — the ONE
// core entry point browser bundles may import. Never the barrel or `./mail` from here: both
// carry mailparser and `node:crypto`, which no consumer of this engine can load.
import { CALENDAR_FALLBACK_FILENAME, isCalendarMime } from "@trafficflow/core/ics";
import type { AttachmentWire, EngineAdapter, MutationOutcome } from "./adapters/adapter.js";
import { messageIdKey, mutationEffects, replySubject, sentOverlayMessage, type MutationEffect } from "./mutations.js";
import { SearchIndex, type LocalSearchResult } from "./search.js";
import { isResurfaced, sendingMailboxId } from "./selectors.js";
import { MemoryMirrorStore, type EntityReader, type MirrorStore } from "./store.js";
import {
  CursorExpiredError,
  FOLDER_OF_VIEW,
  MutationRejectedError,
  encodeSeqCursor,
  isProtectedMessage,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type MessageBodyBatchWire,
  type MessageBodyRecord,
  type MessageStateDTO,
  type OhmailView,
  type SyncSnapshotPage,
  type UnsubscribeResult,
} from "./types.js";

/**
 * The delta-sync engine (brief §4 — the load-bearing abstraction):
 *
 *   bootstrap (since=0) → drain (hasMore) → apply idempotently → cursor;
 *   410 → discard local state, re-bootstrap;
 *   optimistic mutations: overlay instantly (user-always-wins), fire the wire
 *   request with an Idempotency-Key, reconcile on the X-Sync-Seq echo (or the
 *   next /sync drain), roll back only on a hard rejection;
 *   SSE/push are WAKE SIGNALS only — attachWakeSignal() nudges a syncOnce.
 */

export type MutationStatus = "confirmed" | "queued" | "rolled_back";

export interface MutationResult {
  id: string;
  /** The Idempotency-Key used on the wire — stable across retries. */
  key: string;
  status: MutationStatus;
  seq: number | null;
  error?: MutationRejectedError;
  /**
   * The SERVER's id for a row this mutation created — see {@link MutationOutcome.entityId}.
   *
   * Present only where the caller has to keep using it, which today means `draft_save`'s create:
   * the compose surface adopts it, PATCHes it on every later autosave and sends THAT row, so one
   * draft exists from the first keystroke to delivery. Absent on every rejection, because a row
   * that was refused has no id to adopt.
   */
  entityId?: string;
}

interface PendingMutation {
  id: string;
  key: string;
  mutation: EngineMutation;
}

/**
 * WHAT `GET /search` ANSWERS, as much of it as this client reads.
 *
 * The route returns `{ items, facets, total }`. `items` are canonical `MessageDTO`s, and an
 * {@link EngineMessage} is exactly a `MessageDTO` plus optional fixture extras, so a DTO IS
 * one — no conversion, no second shape. `facets` is deliberately NOT read: the server's facet
 * keys are raw folder paths (`SearchService.folderExpr` → `desired_folder` / the native
 * locator), while the local index keys its facets by VIEW id or by folder leaf, and rendering
 * the server's keys would put a namespaced IMAP path straight on screen. The surface keeps its
 * local facets; forward-compatible parsing (§8) means the extra field is not an error.
 */
export interface ServerSearchWire {
  items: EngineMessage[];
  /** Matches for the query across the WHOLE corpus, which is more than `items.length`. */
  total: number;
}

/**
 * THE ORDER THE ARCHIVE IS ASKED FOR — the same closed vocabulary the search service declares
 * on the server, spelled out again here for the reason
 * `owner-cookie.ts` repeats a cookie name: this package is the STANDALONE desktop payload and
 * cannot import the hosted service, so the list is written out twice and held together by a
 * test on the server's side that reads both declarations and fails if they drift. Adding an
 * order HERE that the server does not accept is the dangerous direction — the route refuses
 * what it does not recognise, so every search a user ran with it would fail.
 *
 * `relevance` is the default at every layer, and an absent value means it: the parameter is
 * left OFF the wire rather than sent explicitly, so a client on this build asks an older server
 * exactly the question it asked before.
 */
export const SERVER_SEARCH_SORTS = ["relevance", "date_desc", "date_asc", "mailbox", "sender"] as const;
export type ServerSearchSort = (typeof SERVER_SEARCH_SORTS)[number];

/** What a caller may ask of one archive pass. */
export interface ServerSearchOpts {
  limit?: number;
  /** Absent ⇒ `relevance`, and nothing is put on the wire. */
  sort?: ServerSearchSort;
}

/**
 * The transport `searchServer` runs on. Optional everywhere: the demo has no server, the
 * desktop tier has no Cloud, and neither may be given one.
 */
export type ServerSearchFn = (
  query: string,
  opts: ServerSearchOpts,
) => Promise<ServerSearchWire | null>;

/**
 * The adapter capability this reaches for when no `serverSearch` was injected.
 *
 * Declared structurally HERE rather than as a member of `EngineAdapter` because the engine is
 * the only thing that calls it and the two adapters answer it differently in kind — the
 * FixturesAdapter has no server to ask and the HttpAdapter has one endpoint. An adapter
 * without the method is not broken; it is a client with no archive behind it, which
 * {@link OhmailEngine.serverSearchAvailable} reports and the UI states.
 */
interface ServerSearchCapableAdapter {
  searchServer?: ServerSearchFn;
}

/**
 * WHAT `GET /messages` ANSWERS for ONE view's page, as much of it as this client reads.
 *
 * The route returns `{ items, nextCursor }`, keyset-paged `date desc, id desc`. `items` are
 * canonical `MessageDTO`s, and an {@link EngineMessage} is exactly a `MessageDTO` plus optional
 * fixture extras — so a DTO IS one, with no conversion and no second shape (the same reasoning as
 * {@link ServerSearchWire}). `nextCursor` is the server's own opaque paging token: it is echoed
 * back untouched on the following call and is `null` on the last page.
 */
export interface ListOlderWire {
  items: EngineMessage[];
  nextCursor: string | null;
}

/**
 * The transport {@link OhmailEngine.listOlder} runs on. Optional everywhere, exactly as
 * {@link ServerSearchFn} is: a client whose whole mailbox is already on the device has nothing
 * behind the end of the list, and must be able to say so rather than spin.
 */
export type ListOlderFn = (
  view: OhmailView,
  opts: { cursor?: string; limit?: number },
) => Promise<ListOlderWire | null>;

/**
 * The adapter capability the out-of-window read reaches for.
 *
 * Declared STRUCTURALLY here, exactly as {@link ServerSearchCapableAdapter} and
 * {@link SnapshotCapableAdapter} are, and for the same reason: absence is a real answer. A
 * fixtures client has no server, and a client keeping the WHOLE mailbox has nothing older to
 * fetch — both must read as "there is nothing beyond this list", not as a broken adapter.
 *
 * It carries the same wiring risk the other two do, and the risk has been paid for three times
 * already: a wrapper that rebuilds the adapter surface as an object literal drops a structural
 * capability silently and still satisfies `EngineAdapter`. `apps/webapp/app/shell/sync-scheduler.ts`
 * has exactly such a wrapper, so it must spread this the way it spreads the others:
 *
 *     ...(adapter.listMessages ? { listMessages: adapter.listMessages.bind(adapter) } : {})
 *
 * conditionally, never unconditionally.
 */
interface ListMessagesCapableAdapter {
  listMessages?: ListOlderFn;
}

/** The batch body read, as {@link OhmailEngine.hydrateThread} calls it. */
export type FetchBodiesFn = (messageIds: string[]) => Promise<MessageBodyBatchWire[] | null>;

/**
 * The adapter capability a thread open reaches for.
 *
 * Declared STRUCTURALLY here for the same reason the three above it are, and carrying the same
 * wiring risk they do: `apps/webapp/app/shell/sync-scheduler.ts` rebuilds the adapter surface as
 * an object literal, and a literal that forgets a structural capability still satisfies
 * `EngineAdapter`. The failure would be invisible in the suite and live on the LIVE path only —
 * every real thread quietly back to N requests — so that wrapper must spread this the way it
 * spreads the others, conditionally and never unconditionally.
 */
interface FetchBodiesCapableAdapter {
  fetchBodies?: FetchBodiesFn;
}

/**
 * How many ids one batch body request may name.
 *
 * The server refuses more (400) rather than truncating, because a truncated answer is
 * indistinguishable from "those messages have no body". The engine therefore does the splitting
 * itself: a thread longer than this becomes two requests, not one refusal. Twenty is well past
 * any conversation a reader scrolls — the widest real thread measured here is nine — and it is the
 * count at which the byte budget rather than the id list is the binding constraint.
 */
export const BODIES_IDS_MAX = 20;

/**
 * `GET /sync/snapshot` as the engine calls it — see {@link SyncSnapshotPage} for the protocol.
 *
 * `cursor` is the server's own opaque paging token from the previous page, absent on the first.
 * `limit` is a hint the engine does not currently send: page 1 is defined as "all live state plus
 * the newest page of messages", and a client-imposed limit could cut that definition in half.
 */
export type SnapshotFn = (params: { cursor?: string; limit?: number }) => Promise<SyncSnapshotPage>;

/**
 * The adapter capability the cold-start path reaches for.
 *
 * Declared STRUCTURALLY here, exactly as {@link ServerSearchCapableAdapter} is, and for the same
 * reason: absence is a real answer, not a broken adapter. The FixturesAdapter has no server and a
 * `?demo=1` tab must issue zero requests; an older HttpAdapter, or a Cloud that has
 * not deployed the route, simply has no `snapshot` — and the engine falls back to `since=0`, which
 * is the path every client used before this existed and still converges to the same mirror.
 *
 * ── THE WIRING RISK THIS SHAPE CARRIES ────────────────────────────────────────────────────
 *
 * Because it is structural rather than a member of `EngineAdapter`, an adapter WRAPPER that
 * rebuilds the surface as an object literal will silently drop it and still satisfy
 * `EngineAdapter`. `apps/webapp/app/shell/sync-scheduler.ts` has exactly such a wrapper (`guard`),
 * and `fetchBody`, `searchServer` and the three attachment methods each shipped unforwarded on the
 * LIVE path at some point for precisely this reason — the demo is unwrapped, so every test stayed
 * green. A wrapper must spread it the way it spreads the others:
 *
 *     ...(adapter.snapshot ? { snapshot: adapter.snapshot.bind(adapter) } : {})
 *
 * conditionally, never unconditionally: defining it always would make a fixtures adapter behind a
 * gate claim a snapshot endpoint it has no server for.
 */
interface SnapshotCapableAdapter {
  snapshot?: SnapshotFn;
}

/**
 * HOW MUCH OF THE MAILBOX THIS CLIENT KEEPS ON DISK.
 *
 * `full` is the DEFAULT and the absent-config branch, and that ordering is the whole safety
 * property: the desktop tier's entire promise is that the mail is on the device, so a host that
 * forgets to configure this must get today's behaviour — nothing is ever evicted — rather than a
 * quietly truncated mailbox. A policy that pruned by omission would be a data-loss default.
 *
 * `windowed` is the browser's answer, where the mirror is a cache in front of a Cloud that still
 * holds everything: keep the newest `minRows` messages unconditionally, plus anything within
 * `days`, and drop the rest. Dropped rows are not lost — they are one `/sync` change or one
 * re-snapshot away, because {@link MirrorStore.prune} deletes rather than tombstones.
 */
export type StorePolicy =
  | { mode: "full" }
  | { mode: "windowed"; days: number; minRows: number };

/**
 * The two `/sync` entity types the pin set reads, narrowed to the ONE field each that decides
 * whether the user still owes it an answer.
 *
 * Declared here rather than in `types.ts` for the same reason {@link SnapshotCapableAdapter} is:
 * this is the only code in the package that looks at either type, and mirroring the server's whole
 * `RoutingDecisionDTO`/`ApprovalDTO` would be a second copy of a shape nothing else reads —
 * which is a shape that can drift without anything noticing. Every field is optional-safe: a
 * status this build has never heard of is simply not one of the pinning values, and the row is
 * treated as resolved.
 */
interface PendingRoutingDecision {
  messageId?: string;
  status?: string;
}
interface PendingApproval {
  messageId?: string | null;
  status?: string;
}

/**
 * WHEN a message is, for windowing purposes — the mail's own date, falling back to the row's
 * `updatedAt`, and 0 for a row with neither.
 *
 * 0 sorts oldest, which is the conservative direction ONLY because the `minRows` floor and the
 * pin set are both checked independently of this number: an undated row can be evicted for being
 * undated, but never one of the newest N and never one something still references.
 */
function messageTime(m: EngineMessage): number {
  const t = Date.parse(m.date ?? m.updatedAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * The outcome of one archive pass. It NEVER rejects — see {@link OhmailEngine.searchServer}.
 *
 * `unavailable` is a first-class answer and not an error: it is what the demo and the desktop
 * get, and the difference between "there is no archive behind this client" and "the archive
 * refused" is the difference between two true sentences the UI has to be able to tell apart.
 */
export type ServerSearchOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; total: number }
  | { state: "failed"; error: string };

/**
 * The outcome of one page of out-of-window mail. It NEVER rejects — see
 * {@link OhmailEngine.listOlder}.
 *
 * Deliberately shaped like {@link ServerSearchOutcome}, `unavailable` first-class and for the
 * same reason: "this client holds the whole mailbox, there is nothing further back" and "the
 * server refused" are two true sentences, and a list that renders them identically is lying about
 * one of them. `ready` with an EMPTY `items` is a third: the server answered and this view has
 * nothing older.
 *
 * `nextCursor` is `null` on the last page, which is what lets a surface stop asking rather than
 * poll the end of the mailbox forever.
 *
 * `code` on a failure is the server's own error code, or `null` when the failure never reached a
 * server (a dead network, a bug in this client). It is here because `error` is NOT uniformly
 * showable text: some of what a server puts in an error message is written for whoever reads a
 * log, and some of it — the spend gate's explanation of what ran out — is written for the person
 * holding the mailbox. Only the code tells them apart, and a surface that guesses ends up
 * printing an internal vocabulary into somebody's mail.
 */
export type ListOlderOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; nextCursor: string | null }
  | { state: "failed"; error: string; code: string | null };

// ── attachments ────────────────────────────────────────────────────────────
//
// ohmail STORES NO ATTACHMENT BYTES, anywhere, ever. Metadata is synced at ingest; the bytes live
// only in the user's own IMAP mailbox and are pulled from it at the moment somebody asks. What the
// types below model is therefore a CACHE WITH NO BACKING STORE: everything here dies with the tab,
// and that is the feature, not a limitation to be engineered away later.

/**
 * One attachment as a surface renders it.
 *
 * `mimeType` (not the wire's `contentType`) and a non-null `filename` — the shape the strip is
 * built against. {@link toAttachmentItem} is the ONE place the wire becomes this, so the fallback
 * name and the rename cannot drift into two answers.
 *
 * `state` is per ITEM because that is how it behaves: a message's strip is a list where one file
 * is open, one is still arriving and one failed, all at once. `objectUrl` is present only in
 * `ready`, and only until {@link OhmailEngine.releaseAttachments} revokes it.
 */
export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  state: "idle" | "loading" | "ready" | "failed" | "too_large";
  /**
   * Is this part one the html body REFERENCES (`cid:`) rather than one the sender attached as a
   * file — a signature logo, an embedded screenshot, a newsletter's header image.
   *
   * Carried rather than filtered away, because whether it is a "file" depends on something this
   * layer cannot see: HOW THE MESSAGE IS BEING DRAWN. In a framed rendering the html paints it
   * and listing it too would name the same picture twice. In the app's own frameless typography
   * no image is drawn at all, so an inline picture is unreachable unless something lists it —
   * which is what {@link OhmailEngine.attachmentsOf}'s `includeInlineImages` is for.
   */
  inline: boolean;
  /**
   * The part's `Content-ID` (brackets stripped at ingest), or `null` for a part carrying none.
   * It is the join key between the html body's `cid:<contentId>` references and this part —
   * what {@link OhmailEngine.loadInlineImages} matches on to draw an embedded image in place.
   */
  contentId: string | null;
  /**
   * A `blob:` URL for the fetched bytes, valid ONLY in the document that minted it.
   *
   * SAFE FOR `<img src>` AND `<a download>`. NOT safe to navigate to top-level: a `blob:` URL
   * inherits the app's origin, so a document type the browser will RENDER (SVG, HTML) executes
   * sender-controlled script as ohmail, with the session cookie in scope. The engine defends this
   * at the point the Blob is built — see {@link RENDERABLE_MIME} — rather than trusting every call
   * site to remember.
   */
  objectUrl?: string;
  /**
   * The fetched bytes, as the type-DOWNGRADED Blob the {@link objectUrl} was minted from.
   * Present exactly when `objectUrl` is, held only in memory, and dropped with the list.
   *
   * A preview surface reads this to parse a PDF or a text part rather than re-fetching the
   * object URL: `fetch(blob:…)` is governed by `connect-src`, and `'self'` does NOT match the
   * `blob:` scheme, so a re-fetch that passes every jsdom test dies on the deployed host. The
   * Blob already pins these bytes for the URL's lifetime, so carrying it costs nothing new.
   *
   * It is the POST-DOWNGRADE blob (see {@link RENDERABLE_MIME}): an `image/svg+xml` part is
   * `application/octet-stream` here, so a consumer that minted its own URL from it could not
   * reopen the document-execution hole the downgrade closes.
   */
  blob?: Blob;
  /** The server's own sentence when `state` is `failed` or `too_large`. */
  error?: string;
}

/**
 * The outcome of one message's metadata read. Never rejects, for the reason
 * {@link ServerSearchOutcome} does not: the caller is a React effect.
 *
 * `unavailable` is a first-class answer — the demo and the desktop tier have no server to ask —
 * and `ready` with an EMPTY `items` is a different, also-true answer that the surface must render
 * differently. The second one is COMMON rather than an edge case, and structurally so: a great
 * many messages carry `inline` parts and nothing else — an embedded logo in an HTML mail is one —
 * and {@link OhmailEngine.attachmentsOf} withholds those from a caller that did not ask for them.
 * The paperclip is painted from `hasAttachments`, which COUNTS them. So a paperclip over an empty
 * strip is not a rare inconsistency to be tidied away; it is a state the UI has to be able to say
 * something honest about.
 */
export type AttachmentsOutcome =
  | { state: "unavailable" }
  /**
   * `retrying` is set ONLY when a human pressed the list's own retry over a held `failed`.
   * A surface renders the first ask as nothing — the read is one indexed row and a
   * skeleton on every message open would be noise — but it must NOT go silent again the moment
   * somebody presses "Try again": the row they pressed would vanish for the whole round-trip
   * and come back, which reads as "it worked" followed by "no it didn't". The flag is what lets
   * the failure row stay put and say it is asking again.
   */
  | { state: "loading"; retrying?: boolean }
  | { state: "ready"; items: AttachmentItem[] }
  /**
   * `code` and `retryable` are the SERVER'S OWN CLASSIFICATION, carried through rather than
   * re-derived from the sentence. Before that, only `error` survived the catch and the surface
   * had no way to tell "you are offline" from "that message is not yours".
   *
   * WHAT CAN ACTUALLY LAND HERE, because copy written for the wrong failure is a lie:
   * `GET /messages/:id/attachments` is `cost: "read"` and `AttachmentsService.listForMessage`
   * opens no IMAP adapter, so this call NEVER touches the user's mail server. The 429
   * `mailbox_busy` refusal therefore cannot reach it — that one belongs to the two
   * `cost: "connection"` byte routes. What reaches it is `code: "network"`
   * (the fetch itself rejected — `HttpAdapter.request`), a 5xx from ohmail's own API, or a
   * definite 4xx refusal (401 after a session ends, 404 for a message this account cannot see).
   *
   * `retryable` is TRUE for anything the client could not classify: an unclassified throw means
   * we never established that the server refused, and re-asking costs one indexed row.
   *
   * `code: "timeout"` is the THIRD thing that lands here, and it exists only because the list read
   * was eventually given a deadline:
   * a request the server accepted and never answered used to produce no outcome at all, because
   * `fetch` has no deadline and neither did anything on this path. It now arrives bounded and
   * aborted from `HttpAdapter.withDeadline`, retryable for the strongest version of the reason
   * above — nothing refused us, nothing even spoke.
   */
  | { state: "failed"; error: string; code: string | null; retryable: boolean };

/**
 * The MIME types whose bytes may keep their real content type on a client-minted Blob.
 *
 * Everything else is minted `application/octet-stream`, which makes a browser DOWNLOAD it rather
 * than render it. This closes the one hole the server's own defences cannot: `GET /attachments/:id`
 * sets `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, but an object URL
 * created here from the response body carries NEITHER — the headers described the response, and the
 * Blob is a new thing with only a type. An `image/svg+xml` attachment opened in a tab would then
 * run its own `<script>` on ohmail's origin.
 *
 * The list is what a strip actually renders inline, and nothing more. SVG is deliberately absent
 * despite being an image: it is a document format that executes script. 18 such attachments exist
 * in the live corpus, so this is a real case and not a hypothetical one.
 */
const RENDERABLE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

/**
 * Wire → surface, in one place (the mapper the whole strip is rendered from).
 *
 * The filename fallbacks are the SERVER'S own stems for a nameless part (`attachments-service.ts`
 * `uniqueName`): `invite.ics` for a calendar part — the COMMON nameless case, because Google and
 * Outlook nest the invitation as an unnamed `text/calendar` alternative — and
 * `attachment-${id}.bin` for everything else. Matching them deliberately: the name in the strip
 * is then the same name that appears in a download-all zip entry, so a user reading both sees
 * one file, not two.
 */
function toAttachmentItem(wire: AttachmentWire): AttachmentItem {
  return {
    id: wire.id,
    filename:
      wire.filename?.trim() ||
      (isCalendarMime(wire.contentType || "") ? CALENDAR_FALLBACK_FILENAME : `attachment-${wire.id}.bin`),
    mimeType: wire.contentType || "application/octet-stream",
    sizeBytes: wire.sizeBytes,
    state: "idle",
    inline: wire.inline === true,
    contentId: typeof wire.contentId === "string" && wire.contentId !== "" ? wire.contentId : null,
  };
}

/**
 * Is this part a PICTURE — the only kind of inline part a surface may promote to the strip.
 *
 * `image/*` and nothing wider. An inline `text/calendar` or a `cid:`-referenced stylesheet is not
 * something a reader looking at a frameless rendering is missing, so promoting it would be adding
 * a row nobody asked about. SVG is deliberately included here and refused one layer up by the
 * surface's own preview gate — the same posture every other SVG attachment gets, rather than a
 * second, differently-shaped refusal in this file.
 */
function isPictureItem(item: AttachmentItem): boolean {
  return item.mimeType.startsWith("image/");
}

/**
 * The MIME types an embedded (`cid:`) image may carry INTO THE MAIL DOCUMENT as a `data:` URI.
 *
 * A strict subset of {@link RENDERABLE_MIME}: the four raster image types and nothing else. PDF
 * is renderable in the preview overlay but is not an `<img>`; SVG is excluded for the same reason
 * it is excluded there — it is a document format that executes script, and although the mail
 * frame's sandbox allows none, "the second gate would have caught it" is not a reason to open the
 * first. Checked twice per part, deliberately: against the declared type before any bytes are
 * paid for, and against the fetched Blob's OWN type before the URI is minted — the declaration is
 * the sender's claim, the Blob type (post-downgrade, see {@link OhmailEngine.openAttachment}) is
 * what a browser will honour.
 */
const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The per-part ceiling on an AUTOMATICALLY fetched embedded image, in bytes — 4 MiB.
 *
 * Embedded images divide into two real populations: signature logos and newsletter art (tens to
 * hundreds of KB), and pasted screenshots/photos (up to a few MB). 4 MiB covers both. Above it
 * sits mail nobody embeds by reference, and the cost is not just the fetch: the image lands in
 * the frame as base64 (+33%), so a part at this ceiling adds ~5.6 MB to one message's document.
 * A part over the ceiling stays a blanked box — exactly what every message showed before this
 * existed — and is still reachable through the strip's own explicit-press fetch, which allows
 * eight times as much ({@link RENDERABLE_MIME}'s route enforces the server's 32 MiB).
 */
export const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The per-message ceilings on the same automatic fetch: at most 12 parts, at most 16 MiB of
 * DECLARED payload, taken in the order the document references them so the images a reader sees
 * first are the ones that win the budget.
 *
 * These exist because the trigger is opening a message, and the per-fetch cost is the most
 * expensive read in the product — one short-lived IMAP connection each ({@link
 * OhmailEngine.openAttachment}). A hostile message can reference any number of `cid:` parts; a
 * bound chosen by the sender is not a bound. Twelve covers every legitimate shape measured
 * (signature blocks run one to three images; picture-heavy newsletters that EMBED rather than
 * link run a handful) while capping what one open can spend.
 */
export const INLINE_IMAGE_MAX_PARTS = 12;
export const INLINE_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** The stable empty answer of {@link OhmailEngine.inlineImagesOf} — one identity, never mutated. */
const NO_INLINE_IMAGES: ReadonlyMap<string, string> = new Map();

/**
 * The per-part ceiling on an AUTOMATICALLY fetched calendar part, in bytes — 256 KiB.
 *
 * Real invites are 1–4 KB (the live corpus's 646 calendar parts top out at 4 035 bytes), so this
 * is two orders of magnitude of headroom, and it is an order of magnitude UNDER the inline-image
 * ceiling because the payload is a text file, not a photograph. A part over it is not fetched by
 * the automatic pass and stays an ordinary tile — the reader can still press it.
 */
export const CALENDAR_TEXT_MAX_BYTES = 256 * 1024;

/**
 * At most this many calendar parts fetched automatically per message. Real meeting mail carries
 * exactly one; a hostile message can declare hundreds, and each fetch is an IMAP connection.
 */
export const CALENDAR_TEXT_MAX_PARTS = 3;

/** The stable empty answer of {@link OhmailEngine.calendarTextsOf} — one identity, never mutated. */
const NO_CALENDAR_TEXTS: ReadonlyMap<string, string> = new Map();

/** The parts the automatic calendar pass may consider: real files declared as calendar data. */
function isCalendarItem(item: AttachmentItem): boolean {
  return !item.inline && isCalendarMime(item.mimeType);
}

/**
 * The fetched bytes of one embedded image, as a `data:` URI — or `null` for anything that is not
 * a small raster image.
 *
 * BOTH refusals here are the enforcement, not the optimisation (the declared-type pre-filter in
 * {@link OhmailEngine.loadInlineImages} is that):
 *
 *   · `blob.type` must be in {@link INLINE_IMAGE_MIME}. This is the POST-DOWNGRADE type — an
 *     `image/svg+xml` part reaches here typed `application/octet-stream` (see
 *     `RENDERABLE_MIME`) — so an SVG cannot be minted into a document no matter what the
 *     metadata claimed. The type is interpolated into the URI, so it comes from this closed set
 *     or the URI is never built; nothing sender-controlled is ever spliced into the scheme.
 *   · `blob.size` is the REAL byte count, checked against {@link INLINE_IMAGE_MAX_BYTES}
 *     because the metadata size the pre-filter read is only the sender's claim.
 */
async function mintInlineDataUrl(blob: Blob): Promise<string | null> {
  const type = blob.type.toLowerCase();
  if (!INLINE_IMAGE_MIME.has(type)) return null;
  if (blob.size === 0 || blob.size > INLINE_IMAGE_MAX_BYTES) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharCode is applied per-chunk: one call over MBs overflows the arg limit.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * WHEN A RESUMING MIRROR STOPS BEING "CURRENT" AND STARTS BEING "STALE" — the age of the last
 * completed drain beyond which the next drain fetches the newest page before replaying its
 * backlog. See {@link OhmailEngine.freshenStaleResume} for the whole mechanism.
 *
 * Five minutes, sized from both directions. Below it: a visible tab settles a drain every eight
 * seconds, so a healthy tab's stamp is never more than seconds old and the freshness path costs
 * every open tab exactly nothing — the property `stale-resume-freshness.test.ts` pins. Above it:
 * a tab hidden for five minutes has issued zero syncs (the scheduler's visibility gate), its
 * backlog is unknowable from here, and the price of guessing wrong is asymmetric — a false
 * positive is one extra `GET /sync/snapshot` page (~0.5 s measured), a false negative is the
 * newest mail arriving at the END of an oldest-first replay that production measured in whole
 * minutes.
 */
export const STALE_RESUME_MS = 5 * 60_000;

/**
 * The meta key under which a completed drain stamps its own clock — the mirror's record of "when
 * was this device last caught up", read by nothing but the staleness comparison above. Engine
 * clock on both sides (`opts.now`), never `serverTime`: cross-machine skew cannot touch a
 * comparison whose two operands come from the same clock.
 */
export const LAST_DRAIN_AT_META = "lastDrainAt";

export interface EngineOptions {
  adapter: EngineAdapter;
  /**
   * Override the archive transport. The shipped path takes it from the adapter (see
   * {@link ServerSearchCapableAdapter}); this exists so a test can drive the whole seam
   * without an adapter, and so a host that reaches `/search` some other way can supply it.
   */
  serverSearch?: ServerSearchFn;
  /** Defaults to an in-memory mirror (SSR/tests); pass IndexedDbMirrorStore on web. */
  store?: MirrorStore;
  /**
   * How much of the mailbox to keep locally. ABSENT ⇒ `{ mode: "full" }` — see
   * {@link StorePolicy}. Enforced by one pass at the end of each successful drain.
   */
  storePolicy?: StorePolicy;
  /** Optional `?types=` filter for /sync. */
  types?: string[];
  /** Page size for the drain loop. */
  syncLimit?: number;
  /**
   * Override {@link STALE_RESUME_MS}. A test seam: the shipped paths never pass it, so the one
   * number above is the one every client uses.
   */
  staleResumeMs?: number;
  /**
   * EAGER RECENT-WINDOW HYDRATION (owner ruling, 2026-08-21). Arms
   * {@link OhmailEngine.prefetchRecentBodies}: hydrate the bodies of the mirror's newest
   * {@link EAGER_BODIES_MAX} messages in the background, so opening any recent message finds its
   * body already local instead of paying a round trip (~100 ms warm, seconds on a serverless
   * cold start) at the moment of intent. The mirror IS the recent window every list surface
   * renders; the archive tail is not in it and stays fetch-on-open. The shell's sync scheduler
   * calls the pass after each settled drain — the engine never fires it on its own.
   *
   * OPT-IN, deliberately: the webapp shell and the desktop window pass `true`; an embedder that
   * never asked — apps/mobile with its windowed bootstrap semantics — changes nothing by
   * upgrading this package, and even a driver that calls the pass gets a no-op until the
   * embedder means it.
   */
  eagerBodies?: boolean;
  now?: () => Date;
  uuid?: () => string;
}

/**
 * How many of the mirror's newest messages one eager pass offers a body fetch.
 *
 * Sized to cover what the list surfaces actually present — the Ohbox's groups, Reads, Receipts
 * are each windows of hundreds — while keeping the worst-case pass bounded: a thousand bodies at
 * the hosted average is tens of megabytes ONCE, and every later pass costs nothing because a
 * `ready` record is never re-fetched ({@link OhmailEngine.bodyPlan}). A whole mailbox would be
 * hundreds of megabytes, which is why the tail deliberately never enters the pass.
 */
export const EAGER_BODIES_MAX = 1000;

/**
 * How many ids one eager step hands the batch machinery before re-checking its generation.
 *
 * Two server batches' worth. The step boundary is what makes the pass abortable (a navigation
 * or teardown bumps the generation and the next step sees it) and what keeps the four-slot
 * queue shared: a single 1,000-id call would enqueue fifty chunks ahead of every Screener
 * preview, while urgent opens always bypass the queue either way.
 */
export const EAGER_BODIES_SLICE = 2 * BODIES_IDS_MAX;

/** Minimal EventSource-shaped surface (an attach point, not a dependency). */
export interface WakeSignalSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Read-through view: the mirror with the optimistic overlay applied on top. */
class OverlayReader implements EntityReader {
  constructor(
    private readonly store: MirrorStore,
    private readonly overlays: Map<string, MutationEffect[]>,
    private readonly rev: () => number,
  ) {}

  private overlayFor(type: string, id: string): MutationEffect | undefined {
    let hit: MutationEffect | undefined;
    for (const effects of this.overlays.values()) {
      for (const e of effects) if (e.type === type && e.id === id) hit = e; // last wins
    }
    return hit;
  }

  get<T = unknown>(type: string, id: string): T | undefined {
    const o = this.overlayFor(type, id);
    if (o) return o.entity === null ? undefined : (o.entity as T);
    return this.store.get<T>(type, id);
  }

  entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
    if (this.overlays.size === 0) return this.store.entries<T>(type);
    const byId = new Map<string, T>();
    for (const e of this.store.entries<T>(type)) byId.set(e.id, e.entity);
    for (const effects of this.overlays.values()) {
      for (const e of effects) {
        if (e.type !== type) continue;
        if (e.entity === null) byId.delete(e.id);
        else byId.set(e.id, e.entity as T);
      }
    }
    return [...byId.entries()].map(([id, entity]) => ({ id, entity }));
  }

  list<T = unknown>(type: string): T[] {
    if (this.overlays.size === 0) return this.store.list<T>(type);
    return this.entries<T>(type).map((e) => e.entity);
  }

  version(): number {
    return this.store.version() * 1_000_003 + this.rev();
  }
}

/**
 * The most body fetches in the air at once, across all messages.
 *
 * Four rather than one: a thread of a handful of messages should still fill in at roughly the
 * speed it does today, and browsers cap per-host connections in this region anyway — the point is
 * to stop a forty-message sender from opening forty at once, not to serialise reading.
 */
const MAX_CONCURRENT_BODIES = 4;

/**
 * HOW MANY OF THE MESSAGES A SURFACE LAST ASKED TO RENDER THE WINDOWED PRUNE HOLDS ON TO.
 *
 * Exported because it is a policy number a guard depends on, and a guard that hand-copies the
 * number it is checking goes green against a shipped value it has never seen.
 *
 * Sized so that everything one screen can hold fits several times over — the widest caller is the
 * Screener preview, which hydrates one sender's whole held list in a single effect, and forty is
 * the largest such list this codebase has had a defect about ({@link MAX_CONCURRENT_BODIES}).
 * It is a HOLD, not a cache: it never touches the store, it dies with the tab, and its only
 * effect is to keep the windowed prune off rows a reader is looking at.
 */
export const RENDERED_PINS = 64;

/**
 * HOW LONG AN OPTIMISTIC SENT COPY STANDS before it is dropped on TTL alone.
 *
 * The overlay's real job is to bridge the gap between "the server confirmed the send" and "the
 * worker's Sent-folder watch ingested the copy", which is normally minutes; {@link
 * OhmailEngine.reconcileOptimisticSent} drops it the moment the real row arrives, so this ceiling
 * only bites when that ingest never lands in this session (the tab is closed, the mailbox is slow).
 * Ten minutes is past the ordinary Sent-watch latency and matches `SEND_STALE_AFTER_MS` on the
 * server, so a copy that outlives it is genuinely one whose real row this session will not see, and
 * a stale "sent" row is worse than none — the conversation would carry a message the mirror cannot
 * confirm.
 */
export const OPTIMISTIC_SENT_TTL_MS = 10 * 60 * 1000;

export class OhmailEngine {
  readonly store: MirrorStore;
  private readonly adapter: EngineAdapter;
  private readonly types: string[] | undefined;
  private readonly syncLimit: number | undefined;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  private readonly overlays = new Map<string, MutationEffect[]>();
  private overlayRev = 0;
  /**
   * THE OPTIMISTIC SENT COPIES, keyed by their overlay id — the confirm-time half of `mail_send`.
   *
   * Each names the entry it added to {@link overlays} (a provisional Sent message), the
   * `messageIdHeader` the real row will arrive under, and when it expires. It is SEPARATE from the
   * mutation overlays on purpose: a mutation overlay is dropped the instant its own request
   * resolves (`dispatch`), and this one must OUTLIVE that — it stands from the send's confirmation
   * until the worker's Sent-folder watch ingests the real row minutes later. {@link
   * reconcileOptimisticSent} drops each when its header appears in the mirror or its TTL passes.
   */
  private readonly optimisticSent = new Map<string, { header: string; expiresAtMs: number }>();
  private readonly queue: PendingMutation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly readerView: OverlayReader;
  private searchCache: { version: number; index: SearchIndex } | null = null;
  private syncing: Promise<void> | null = null;
  /** The in-flight mirror read, so concurrent callers coalesce. See {@link OhmailEngine.hydrate}. */
  private hydrating: Promise<void> | null = null;
  /** {@link EngineOptions.eagerBodies}, resolved once. */
  private readonly eagerBodiesOn: boolean;
  /** The in-flight eager pass — single-flight; a kick during a pass queues exactly one more. */
  private eagerRun: Promise<void> | null = null;
  private eagerAgain = false;
  /** Bumped by {@link OhmailEngine.stopEagerBodies}; a running pass checks it between steps. */
  private eagerGen = 0;
  /** In-flight body fetches by message id — see {@link OhmailEngine.hydrateBody}. */
  private readonly bodyRequests = new Map<string, Promise<void>>();
  /**
   * The messages a surface has most recently asked to render, oldest first, capped at
   * {@link RENDERED_PINS}. Read by {@link OhmailEngine.pinnedMessageIds}; written by
   * {@link OhmailEngine.hydrateBody}, which is the call every reading surface already makes.
   */
  private readonly renderedIds = new Set<string>();
  /** In-flight body fetches, and the ones waiting for a slot. See {@link bodySlot}. */
  private bodyActive = 0;
  private readonly bodyQueue: Array<() => void> = [];
  /**
   * WHEN THIS ENGINE STARTED, epoch ms — the line a `failed` body record is compared against.
   *
   * See {@link MessageBodyRecord.failedAt}: "never re-ask a server that refused" is a rule about
   * one session, and these records are persisted, so without a boot stamp it was a rule about for
   * ever. Read from `this.now` rather than `Date.now` so a test with a fixed clock gets the
   * in-session behaviour (`failedAt === bootedAt` is not "before"), which is the arm that must not
   * change.
   */
  private readonly bootedAt: number;
  /**
   * The ids whose stale `failed` record this session has ALREADY re-asked once.
   *
   * In memory, never persisted, and it is what makes the heal terminate as a property of the
   * ENGINE rather than of the mirror. `failBody`'s write can itself be refused — a full quota, a
   * private window — which would leave the old stamp-less record in place and put the re-ask
   * straight back on the table for the next render. One entry here closes that, the same way
   * `fetchBodyInto` normalising `html` closes the re-read loop.
   */
  private readonly bodyHealed = new Set<string>();
  /** The batch body read, or `null` when this adapter has none — see {@link FetchBodiesCapableAdapter}. */
  private readonly fetchBodiesFn: FetchBodiesFn | null;
  /** The archive transport, or `null` when this client has no server behind it. */
  private readonly serverSearchFn: ServerSearchFn | null;
  /** `GET /sync/snapshot`, or `null` when this adapter has no such route — see {@link SnapshotCapableAdapter}. */
  private readonly snapshotFn: SnapshotFn | null;
  /**
   * Latched TRUE once the snapshot route has proven unusable on its FIRST page — see
   * {@link OhmailEngine.runSnapshot}. It bounds the cost of a client that ships ahead of the
   * server to exactly one wasted request per engine, rather than one per drain forever.
   */
  private snapshotUnavailable = false;
  /** How much of the mailbox to keep. Resolved once; `full` when the host said nothing. */
  private readonly storePolicy: StorePolicy;
  /** See {@link STALE_RESUME_MS}; the option exists for tests. */
  private readonly staleResumeMs: number;
  /** In-flight archive passes by query key — see {@link OhmailEngine.searchServer}. */
  private readonly serverSearches = new Map<string, Promise<ServerSearchOutcome>>();
  /** `GET /messages`, or `null` when this adapter has none — see {@link ListMessagesCapableAdapter}. */
  private readonly listOlderFn: ListOlderFn | null;
  /** In-flight out-of-window pages by view+cursor — see {@link OhmailEngine.listOlder}. */
  private readonly olderPages = new Map<string, Promise<ListOlderOutcome>>();

  /**
   * Attachment metadata + byte state by message id.
   *
   * IN MEMORY, NEVER `store.putLocal`, and that is a correctness requirement rather than a
   * preference. ohmail stores no attachment bytes anywhere — not server-side, not here — and an
   * `objectUrl` is only valid for the lifetime of the document that minted it. A record persisted
   * to IndexedDB would come back after a reload still holding a `blob:` string pointing at nothing,
   * and the surface would render a `ready` attachment whose image is permanently broken. Scoping
   * this to the tab is what makes "fetched on demand, held for the session" true.
   */
  private readonly attachmentLists = new Map<string, AttachmentsOutcome>();
  /** In-flight metadata reads by message id — single-flight, see {@link OhmailEngine.loadAttachments}. */
  private readonly attachmentListRequests = new Map<string, Promise<AttachmentsOutcome>>();
  /** In-flight byte fetches by attachment id — see {@link OhmailEngine.openAttachment}. */
  private readonly attachmentRequests = new Map<string, Promise<void>>();
  /**
   * `contentId → data: URI` per message — the embedded images already minted for the reader's
   * frame, dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments}. The held map is REPLACED on every mint, never
   * mutated, so a React memo keyed on its identity re-renders exactly when an image arrives.
   */
  private readonly inlineImages = new Map<string, ReadonlyMap<string, string>>();
  /** In-flight inline-image passes by message id — single-flight, see {@link OhmailEngine.loadInlineImages}. */
  private readonly inlineImageRequests = new Map<string, Promise<void>>();
  /**
   * `attachmentId → decoded ics text` per message — what an event-preview surface parses and
   * renders. Text, not a parsed structure: the engine holds bytes and their decodings, and the
   * ics grammar belongs to `@trafficflow/core/ics` at the render site. Replaced on every fill,
   * never mutated, and dropped with the rest of the message's byte state by
   * {@link OhmailEngine.releaseAttachments} — the same lifecycle as {@link inlineImages}.
   */
  private readonly calendarTexts = new Map<string, ReadonlyMap<string, string>>();
  /** In-flight calendar passes by message id — single-flight, see {@link OhmailEngine.loadCalendarTexts}. */
  private readonly calendarTextRequests = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.adapter = opts.adapter;
    // The adapter's own capability is the shipped path; the option is the override. Resolved
    // ONCE, here, so `serverSearchAvailable()` cannot answer differently from what
    // `searchServer` will do a moment later.
    this.serverSearchFn =
      opts.serverSearch ??
      (opts.adapter as ServerSearchCapableAdapter).searchServer?.bind(opts.adapter) ??
      null;
    // Same resolution rule as `serverSearchFn`: the adapter's own capability, bound ONCE, so
    // nothing can answer "there is a snapshot route" differently from what `drain` will do.
    this.snapshotFn = (opts.adapter as SnapshotCapableAdapter).snapshot?.bind(opts.adapter) ?? null;
    // And again for the out-of-window read. No `opts` override beside it, unlike `serverSearch`:
    // one source means `listOlderAvailable()` and `listOlder` cannot disagree, and there is no
    // second way for a host to arm a capability the gate did not forward.
    this.listOlderFn = (opts.adapter as ListMessagesCapableAdapter).listMessages?.bind(opts.adapter) ?? null;
    // And a fourth time, same rule: bound ONCE here so `hydrateThread` cannot decide it has a
    // batch route and then call something else.
    this.fetchBodiesFn = (opts.adapter as FetchBodiesCapableAdapter).fetchBodies?.bind(opts.adapter) ?? null;
    // THE ABSENT BRANCH IS `full`. See {@link StorePolicy} — a host that configures nothing gets
    // today's behaviour, and no mirror is ever pruned by omission.
    this.storePolicy = opts.storePolicy ?? { mode: "full" };
    this.eagerBodiesOn = opts.eagerBodies === true;
    this.store = opts.store ?? new MemoryMirrorStore();
    this.types = opts.types;
    this.syncLimit = opts.syncLimit;
    this.staleResumeMs = opts.staleResumeMs ?? STALE_RESUME_MS;
    this.now = opts.now ?? (() => new Date());
    this.bootedAt = this.now().getTime();
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.readerView = new OverlayReader(this.store, this.overlays, () => this.overlayRev);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * READ THE DEVICE'S COPY OF THE MAILBOX INTO MEMORY — **and say so.**
   *
   * ── THE DEFECT THIS METHOD EXISTS FOR ───────────────────────────────────
   *
   * `store.load()` reads the whole persisted mirror and bumps the store's version. It notifies
   * NOBODY: the listener set lives here, not in the store, and {@link OhmailEngine.notify} was
   * reachable only from `drain()` and the mutation paths. So a returning user's entire mailbox
   * was hydrated out of IndexedDB into memory and the UI was never told — `useSyncExternalStore`
   * holds the snapshot it last read, and the rows appeared only when the FIRST `/sync` page
   * landed. On a slow connection that is the second of two serial round trips, and the screen
   * says "Nothing in your Ohbox." for the whole of it, over mail that is already on the device.
   *
   * Measured: seed a store, close it, open a new engine over the same database, `load()` →
   * two messages readable, store version 0 → 1000003, **listeners fired: 0**.
   *
   * That the mail sometimes appeared earlier was luck, not design — any unrelated re-render
   * re-reads the snapshot, and the mailbox probe landing was usually the one that did it.
   *
   * ── SINGLE-FLIGHT, AND CLEARED IN `finally` ─────────────────────────────
   *
   * `syncOnce()`'s exact pattern, for the first of its reasons and one of its own. Concurrent
   * callers coalesce onto one read; and the promise is CLEARED when it settles, including when
   * it REJECTS, so a hydration that failed (IndexedDB blocked, storage refused) can be tried
   * again on the next wake. A memoized-forever "idempotent" version would turn one transient
   * storage error into a mirror that can never be read for the lifetime of the tab.
   *
   * `notify()` fires only on success. A failed read changed nothing, so there is nothing to
   * publish — and the scheduler counts the rejection as a failed tick, which is what makes the
   * retry happen.
   *
   * Re-hydrating mid-session (a second call after a drain has applied pages) is not reachable
   * today: the scheduler latches after the first success and `start()` runs this before its
   * only drain. It is noted rather than guarded, because a guard nothing can trigger is a claim
   * no test can put under load.
   */
  async hydrate(): Promise<void> {
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.store
      .load()
      // Reconcile the no-raw-secret-at-rest rule before publishing: a body cached by an older
      // engine (or by a
      // delta that arrived before the protect cascade shipped) for a message that is protected in
      // the mirror this load just read must not survive. See {@link purgeProtectedBodies}.
      .then(() => this.purgeProtectedBodies())
      .then(() => {
        this.notify();
      })
      .finally(() => {
        this.hydrating = null;
      });
    return this.hydrating;
  }

  /**
   * NO SENSITIVE BODY AT REST, RECONCILED ON LOAD.
   *
   * The delta cascade in {@link MirrorStore} purges a body the moment a message TRANSITIONS to
   * protected. This covers the two cases that transition cannot reach: a body cached by an engine
   * build from before that cascade existed, and a message that is ALREADY protected in the mirror
   * this load read (its protecting delta landed while a purge-less build was running). A protected
   * message must hold no cached `message_body`, and because {@link SearchIndex} is built from
   * those records, purging here is also what keeps the raw text out of the local search index —
   * so a client that cached the body under an old engine, then updates, converges.
   *
   * One pass over the client-local bodies, tombstoning only the ids whose message is protected; on
   * the ordinary mirror — where no protected message ever cached a body — it writes nothing. It
   * does not `notify()`: `hydrate` publishes once after this settles, over the already-bumped
   * store version.
   */
  private async purgeProtectedBodies(): Promise<void> {
    const reader = this.read();
    const victims: string[] = [];
    for (const { id } of this.store.entries<MessageBodyRecord>("message_body")) {
      if (isProtectedMessage(reader.get<EngineMessage>("message", id))) victims.push(id);
    }
    for (const id of victims) await this.store.putLocal("message_body", id, null);
  }

  /**
   * Hydrate the mirror, then bootstrap/catch up.
   *
   * THE COLD-START SNAPSHOT IS NOT A SEPARATE CALL HERE. `syncOnce()` → `drain()`, and `drain()`
   * checks for a cursor of "0" at the top of its loop, which is the same condition a cold start
   * is. Writing the check here TOO would be a second seam that has to stay in agreement with the
   * first — and the drain's copy is the one that has to exist regardless, because the 410
   * re-bootstrap re-enters the loop with a cursor of "0" without ever passing through `start()`.
   * So there is one condition in one place, and a cold start reaches it by calling `syncOnce`.
   */
  async start(): Promise<void> {
    await this.hydrate();
    await this.syncOnce();
  }

  /**
   * One full drain: pull pages from the cursor of record until hasMore:false,
   * applying each page idempotently. A 410 discards local state and re-enters
   * as a bootstrap (once — a second 410 within one drain is surfaced).
   */
  async syncOnce(): Promise<void> {
    // Serialize concurrent callers onto one drain.
    if (this.syncing) return this.syncing;
    this.syncing = this.drain().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async drain(): Promise<void> {
    let rebootstrapped = false;
    // A STALE resume converges its newest page FIRST — see the method for the whole argument.
    // Before the loop, once per drain: the 410 branch re-enters the loop with a wiped mirror,
    // where the bootstrap snapshot below already owns "newest first".
    await this.freshenStaleResume();
    for (;;) {
      // COLD MIRROR + A SNAPSHOT ROUTE ⇒ TAKE THE SNAPSHOT INSTEAD OF REPLAYING THE LOG.
      //
      // This is the ONE place the condition is written, and it is reached by all three callers
      // that can present a cursor of "0": a first-ever `start()`, a `start()` over a mirror whose
      // last bootstrap crashed before its final page, and the 410 branch below — which resets to
      // "0" and `continue`s straight back here. See {@link OhmailEngine.runSnapshot}.
      if (this.store.getCursor() === "0" && this.snapshotFn) await this.runSnapshot();

      let resp;
      try {
        resp = await this.adapter.sync({
          since: this.store.getCursor(),
          ...(this.syncLimit !== undefined ? { limit: this.syncLimit } : {}),
          ...(this.types ? { types: this.types } : {}),
        });
      } catch (err) {
        if (err instanceof CursorExpiredError && !rebootstrapped) {
          // The once-per-drain guard stays exactly as it was: a SECOND 410 inside one drain is a
          // server that expires the cursor it just issued, and is surfaced rather than looped on.
          // It bounds the snapshot path too — at most one snapshot can follow a 410 per drain.
          rebootstrapped = true;
          await this.store.resetForBootstrap(); // cursor → "0"
          this.notify();
          // Back to the top: with a snapshot route the cursor of "0" selects the snapshot and the
          // delta drain then resumes from `asOfSeq`; without one it selects `since=0`, which is
          // the pre-snapshot path and still converges. The fallback is not dead code — it is what
          // the FixturesAdapter and any adapter older than this route take.
          continue;
        }
        throw err;
      }
      await this.store.applyResponse(resp);
      this.notify();
      if (resp.hasMore) continue;

      // ONE PRUNE PASS PER SUCCESSFUL DRAIN, at the point the mirror is caught up and therefore
      // at its most complete — which is when a windowed client's eviction decision is least
      // likely to be made about a half-arrived mailbox. A `full` policy returns immediately.
      if (await this.pruneToPolicy()) this.notify();
      // A drain is the one thing that can deliver the REAL Sent row an optimistic copy is standing
      // in for — retire any copy the mirror now holds under the same header (or that has aged out),
      // so the conversation shows the ingested row alone rather than a duplicate.
      const before = this.optimisticSent.size;
      this.reconcileOptimisticSent();
      if (this.optimisticSent.size !== before) { this.overlayRev++; this.notify(); }
      // THE DRAIN'S LAST WORD: this mirror was fully caught up at this moment, on this device's
      // own clock. Written at COMPLETION and nowhere earlier — a drain that fails or aborts
      // mid-backlog leaves the old stamp standing, so the next drain still reads as a stale
      // resume and freshens again (idempotent: the seq guard absorbs the repeat).
      await this.store.setMeta(LAST_DRAIN_AT_META, this.now().toISOString());
      return;
    }
  }

  // ── eager recent-window hydration ──────────────────────────────────────────

  /**
   * Start (or queue) one eager pass. See {@link EngineOptions.eagerBodies} for what it is for
   * and {@link EAGER_BODIES_MAX}/{@link EAGER_BODIES_SLICE} for the bounds.
   *
   * CALLED BY THE SHELL'S SCHEDULER after a settled drain — deliberately NOT by `drain()`
   * itself. The engine owns the MECHANISM (bounded, admission-gated, abortable); WHEN background
   * work is welcome is the driver's knowledge, exactly the split the sync gate already draws.
   * The first wiring had `drain()` fire it, and what that shipped was a transport nothing could
   * reason about: every bare `syncOnce()` in a test — and every discarded engine whose drain
   * settled after teardown — issued body fetches from behind the caller's back, which is the
   * same "requests on behalf of nobody" shape the gate exists to refuse. An engine an embedder
   * drives by hand (apps/mobile's loop, a bare `engine.start()`) prefetches exactly when and if
   * it is asked to, and the OPT-IN flag makes even that ask a no-op until the embedder means it.
   *
   * SINGLE-FLIGHT WITH ONE QUEUED RE-RUN: every settled drain kicks, and a kick during a pass
   * must not stack passes — but it must not be LOST either, because the drain that kicked may
   * have applied new mail the running pass's snapshot of the mirror predates. One boolean is
   * exactly "run once more with fresh eyes", and a settled mailbox's re-run costs nothing —
   * every id plans to `skip`.
   *
   * NEVER REJECTS: failures land as per-id `failed` records exactly as an explicit open's would.
   * The returned promise settles when the pass this call joined (or started) is done.
   */
  prefetchRecentBodies(): Promise<void> {
    if (!this.eagerBodiesOn) return Promise.resolve();
    if (this.eagerRun) {
      this.eagerAgain = true;
      return this.eagerRun;
    }
    const gen = this.eagerGen;
    this.eagerRun = this.runEagerBodies(gen)
      .catch(() => {
        /* per-id failures are records the surfaces render; the pass has nothing to throw AT */
      })
      .finally(() => {
        this.eagerRun = null;
        if (this.eagerAgain) {
          this.eagerAgain = false;
          void this.prefetchRecentBodies();
        }
      });
    return this.eagerRun;
  }

  /**
   * ABORT the background pass between steps — a teardown's call (a live→demo navigation swaps
   * the engine; the discarded one must not keep fetching on behalf of nobody). Bodies already
   * in the air complete into the store; no new step starts. The next drain's kick resumes from
   * whatever is still missing, because the pass re-derives its want-list from the mirror.
   */
  stopEagerBodies(): void {
    this.eagerGen++;
  }

  /** Settles when no eager pass is in flight — the deterministic seam a test (or teardown) awaits. */
  async eagerBodiesIdle(): Promise<void> {
    while (this.eagerRun) await this.eagerRun;
  }

  /**
   * One pass: the mirror's newest {@link EAGER_BODIES_MAX} messages, offered to the SAME
   * admission and transport every explicit hydration uses ({@link bodyPlan} through
   * {@link hydrateMany}) — a ready body is never re-fetched, a failed one is never re-asked
   * within the session, protected and fixture-bodied rows issue nothing, and the four-wide
   * non-urgent slot queue is shared so an OPEN always jumps ahead. `rendered: false` is the one
   * divergence from a thread open, and it is load-bearing: a thousand prefetched ids must not
   * flush the {@link RENDERED_PINS} LRU that keeps the windowed prune off a message someone is
   * actually reading.
   */
  private async runEagerBodies(gen: number): Promise<void> {
    const entries = this.read().entries<EngineMessage>("message");
    const ids = entries
      .sort((a, b) => (b.entity.date ?? "").localeCompare(a.entity.date ?? ""))
      .slice(0, EAGER_BODIES_MAX)
      .map((e) => e.id);
    for (let i = 0; i < ids.length; i += EAGER_BODIES_SLICE) {
      if (gen !== this.eagerGen) return;
      await this.hydrateMany(ids.slice(i, i + EAGER_BODIES_SLICE), { rendered: false });
    }
  }

  /**
   * A STALE RESUME FETCHES THE NEWEST PAGE BEFORE IT REPLAYS ITS BACKLOG.
   *
   * ## THE DEFECT THIS EXISTS FOR — measured, not assumed (2026-08-10, production)
   *
   * The delta feed is ascending-seq by contract, so a warm mirror that resumes hours or days
   * stale replays its backlog OLDEST-FIRST: the thing a returning user is looking for — the mail
   * that arrived while they were away, the triage they did on another device — is in the LAST
   * page of the drain, behind every page of history before it. Against a live account, a
   * full-log replay took 4 pages and 28.5 s of wall clock, and the newest message's create
   * applied at +28.5 s — the very end — while `GET /sync/snapshot` page 1 (the newest page of
   * messages, every live thread, ALL small state: rules, message_states, decisions, approvals,
   * drafts, tags) answered in 509 ms. On a real mailbox the same shape reads as "the app takes
   * minutes to show what I did on the other machine".
   *
   * So: when the stamp {@link LAST_DRAIN_AT_META} says this mirror has not completed a drain
   * within {@link STALE_RESUME_MS}, fetch snapshot page 1 and apply it ROWS-ONLY before the
   * delta loop runs. Ohbox above the fold, unread counts and the Screener are current after one
   * round trip; the backlog then replays behind content that is already right.
   *
   * ## WHY APPLYING A SNAPSHOT PAGE OVER A WARM MIRROR IS SOUND
   *
   * Snapshot rows carry `seq === asOfSeq`, the consistent point the server read them at, which
   * is ≥ every seq in the backlog. The apply contract does the rest:
   *
   *  · the backlog's replay of those same rows — every intermediate state, ending at or below
   *    `asOfSeq` — is refused by the older-or-equal guard, so history cannot un-freshen them;
   *  · anything that changes AFTER the snapshot read arrives with a seq above `asOfSeq` and
   *    wins, exactly as it would have without this;
   *  · a row deleted while the client was away is simply absent from the snapshot — nothing
   *    shields the stale copy, and the delta's tombstone removes it when the replay gets there.
   *
   * ## THE CURSOR IS NEVER TOUCHED — this is `applyChanges`, deliberately
   *
   * Committing `asOfSeq` here would be the unsound version: a snapshot page carries live rows
   * only, so jumping the cursor over the backlog skips every tombstone in it and the mirror
   * keeps ghosts of everything deleted while it was away, forever. The delta replay from the OLD
   * cursor stays the one mechanism of record; this method only decides what the user is looking
   * at while it runs. (Mutations are untouched for the same reason: this is a READ overlay — the
   * queue's write ordering never passes through here.)
   *
   * ## FAILURE IS SWALLOWED, AND MUST NOT LATCH {@link snapshotUnavailable}
   *
   * Freshness is an optimization; the delta is the contract. A resume against a server without
   * the route costs its head start and nothing else. And it must not latch the unavailable flag:
   * that latch belongs to the BOOTSTRAP path's page-1 probe — latching it here on a transient
   * failure would push a later 410 re-bootstrap onto the full `since=0` log replay for the life
   * of the tab.
   *
   * ## A MISSING STAMP ON A WARM CURSOR IS STALE
   *
   * That is every mirror persisted before this shipped, resuming for the first time — exactly
   * the mailboxes that reported the symptom. Within a session the stamp always exists after the
   * first completed drain, so this arm fires at most once per pre-upgrade mirror.
   */
  private async freshenStaleResume(): Promise<void> {
    if (!this.snapshotFn || this.snapshotUnavailable) return;
    if (this.store.getCursor() === "0") return; // a cold mirror is the bootstrap's, not ours
    const stamp = this.store.getMeta<string>(LAST_DRAIN_AT_META);
    if (stamp !== undefined && this.now().getTime() - Date.parse(stamp) <= this.staleResumeMs) return;
    let page: SyncSnapshotPage;
    try {
      page = await this.snapshotFn({});
    } catch {
      return; // the delta drain that follows is the source of truth, and of error reporting
    }
    await this.store.applyChanges(page.changes); // rows only — the cursor is the delta's
    this.notify();
  }

  /**
   * FETCH `GET /sync/snapshot` TO COMPLETION, COMMITTING THE CURSOR WITH THE LAST PAGE AND NOT
   * ONE PAGE EARLIER.
   *
   * ## THE ATOMICITY THAT MAKES A CRASH SAFE
   *
   * Every page but the last goes through `applyChanges`, which writes rows and DOES NOT TOUCH THE
   * CURSOR. Only the last page goes through `applyResponse`, whose single flush carries the rows
   * and `String(asOfSeq)` together (contract §3.3 step 3). So the mirror is only ever in one of
   * two states a restart can observe:
   *
   *  · cursor "0" — some prefix of the snapshot is present, and the next drain re-snapshots. The
   *    rows already written are not wasted and not wrong: they carry `seq === asOfSeq`, so a
   *    re-snapshot at the same point skips them on the seq guard and a re-snapshot at a LATER
   *    point overwrites them. Either way it converges, which is what makes "just do it again" a
   *    complete recovery rather than a hope.
   *  · cursor `asOfSeq` — the whole snapshot landed, and the delta drain resumes from a point the
   *    mirror genuinely holds.
   *
   * There is no third state. The one that would be fatal — a cursor past rows that never
   * arrived — is unreachable, because nothing but the final page can write the cursor at all.
   *
   * ## WHY RESUMING AT `asOfSeq` MISSES NOTHING
   *
   * `asOfSeq` is the point the snapshot was READ at, identical on every page, not "where paging
   * got to". Changes committed while the pages were being fetched have seqs above it and are
   * still in the log, so the delta drain that follows picks them up. A cursor of "the last page's
   * high-water mark" would be the version of this that silently loses writes.
   *
   * ## THE PAGING TOKEN IS NEVER THE CURSOR, AND THE CURSOR IS NOT A DECIMAL
   *
   * `nextCursor` is the server's opaque paging state and is passed straight back; it is not
   * written to the mirror and has no relationship to a `/sync` cursor. Conflating the two would
   * put a token `/sync` cannot read into `since=`.
   *
   * The cursor written for `asOfSeq` is {@link encodeSeqCursor}'s base64url, NOT `String(seq)`.
   * This was measured, not assumed: `String(asOfSeq)` is what the first version committed, and
   * `contract.test.ts` — which drives a real backend — turned eight tests red with
   * `CursorExpiredError`, because `SyncService.decodeCursor` base64url-decodes what it is given
   * and treats a non-numeric result as an expired cursor. A bare "900" decodes to bytes that are
   * not digits, so every drain after a snapshot 410'd. The two encoders are the same function on
   * both sides of the wire and must stay that way.
   *
   * ## A FIRST-PAGE FAILURE FALLS BACK; A LATER ONE DOES NOT
   *
   * This route is newer than the clients that call it, and an engine whose cold start HARD-FAILS
   * when it is missing or misbehaving is a mailbox that renders empty in silence —
   * `http-adapter-binding.test.ts` exists because that exact thing shipped once already. So a
   * failure on page 1 latches {@link snapshotUnavailable} and returns, and the caller proceeds
   * down the `since=0` path that every client used before this existed.
   *
   * That swallow cannot hide an outage, which is the only reason it is acceptable: the very next
   * thing the drain does is call `/sync` on the same origin, so a server that is down, refusing,
   * or unreachable still rejects the drain a moment later, through the path that has always
   * reported it.
   *
   * A failure on a LATER page is different in kind and is rethrown. Rows carrying `seq ===
   * asOfSeq` are already in the mirror, and `since=0` over them would be silently WRONG: the seq
   * guard drops every replayed change at or below `asOfSeq`, so the pages the snapshot had not
   * reached yet would never be delivered by either path, and the mirror would settle into a
   * permanently truncated state that looks healthy. Rethrowing leaves the cursor at "0", so the
   * next drain re-snapshots from page 1 — and if the route really has gone, that page-1 attempt
   * takes the fallback above.
   */
  private async runSnapshot(): Promise<void> {
    const snapshot = this.snapshotFn;
    if (!snapshot || this.snapshotUnavailable) return;
    let cursor: string | undefined;
    let applied = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await snapshot(cursor !== undefined ? { cursor } : {});
      } catch (err) {
        if (applied) throw err; // unsound to fall back — see the note above
        this.snapshotUnavailable = true;
        return; // nothing was written; `since=0` takes over
      }
      const last = page.nextCursor == null || page.nextCursor === "";
      if (last) {
        // Rows + cursor in ONE flush. The buckets are a formality: `flattenResponse` concatenates
        // all four and `applyToRecords` dispatches on each change's own `op`, so which bucket a
        // change sits in cannot affect the result. Snapshot changes are all `op:"create"`.
        await this.store.applyResponse({
          changes: { creates: page.changes, updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(page.asOfSeq),
          hasMore: false,
          serverTime: this.now().toISOString(),
        });
      } else {
        await this.store.applyChanges(page.changes); // rows only — the cursor stays "0"
      }
      applied = true;
      this.notify();
      if (last) return;
      cursor = page.nextCursor as string;
    }
  }

  // ── the windowed store: keeping only part of the mailbox on disk ─────────

  /**
   * EVICT THE MESSAGES THIS CLIENT HAS CHOSEN NOT TO KEEP. Returns whether anything went.
   *
   * The shape is {@link OhmailEngine.purgeProtectedBodies}'s: one pass over the mirror computing
   * a victim list, then the store write. It runs after a drain rather than on a timer because a
   * timer would evict rows in the middle of a bootstrap, and because "we are caught up" is the
   * only moment at which the newest-N half of the window means what it says.
   *
   * ── THE RULE ────────────────────────────────────────────────────────────────────────────
   *
   * Keep the newest `minRows` messages whatever their age; of the rest, keep anything newer than
   * `days`; evict what is left. `minRows` is not a nicety — it is what stops a mailbox that has
   * been quiet for a month from evicting itself down to nothing and rendering an empty app.
   *
   * ── MINUS THE PIN SET, WHICH IS THE PART THAT MATTERS ───────────────────────────────────
   *
   * A message the product is still USING must never be evicted for being old, because the thing
   * referencing it renders from the mirror and would render a hole. Five references pin, and the
   * FIRST of them is not a row in the mirror at all:
   *
   *  · a surface currently RENDERING it — the message the reader has open. Nothing in the mirror
   *    points at it (reading is not a mutation), so the four record clauses below could all be
   *    satisfied while the prune deleted the mail on screen mid-read. See
   *    {@link OhmailEngine.pinnedMessageIds} for why `hydrateBody` is the signal;
   *
   *  · a `draft` replying to it (`inReplyToMessageId`) — the compose view shows what is being
   *    replied to, and a reply-later draft can easily outlive the window;
   *  · a `message_state` that is not `none` — every triage pile IS a set of these, and
   *    `bubbled_up` in particular is a TIMER on an old message: the whole point is that it is old
   *    and comes back. Evicting it would delete the reminder;
   *  · a `routing_decision` still `pending_approval`, and
   *  · an `approval` still `pending` — both are questions the user has not answered yet, and the
   *    question is unanswerable without the mail it is about.
   *
   * Anything already resolved (`approved`, `rejected`, `expired`, `auto_applied`) does NOT pin:
   * it is history, and history is what the window is for.
   */
  private async pruneToPolicy(): Promise<boolean> {
    const policy = this.storePolicy;
    if (policy.mode !== "windowed") return false; // `full` — the default. Nothing is ever evicted.

    const rows = this.store.entries<EngineMessage>("message");
    if (rows.length <= policy.minRows) return false;

    // Newest first. `date` is the mail's own time and the order every pile renders in; a row
    // without one (or with an unparseable one) sorts oldest, but is still protected by the
    // minRows floor and by the pin set — it is never singled out.
    const sorted = [...rows].sort((a, b) => messageTime(b.entity) - messageTime(a.entity));
    const cutoff = this.now().getTime() - policy.days * 86_400_000;
    const pinned = this.pinnedMessageIds();

    const victims: Array<{ type: string; id: string }> = [];
    for (let i = policy.minRows; i < sorted.length; i++) {
      const row = sorted[i]!;
      if (messageTime(row.entity) >= cutoff) continue;
      if (pinned.has(row.id)) continue;
      victims.push({ type: "message", id: row.id });
    }
    if (victims.length === 0) return false;
    await this.store.prune(victims); // hard delete + the `message_body` cascade
    return true;
  }

  /**
   * Note that a surface has asked to render this message. Newest last; the oldest fall off at
   * {@link RENDERED_PINS}. Re-asking moves an id back to the newest end, so a message that is
   * re-opened is held again rather than ageing out mid-read.
   */
  private noteRendered(messageId: string): void {
    this.renderedIds.delete(messageId);
    this.renderedIds.add(messageId);
    while (this.renderedIds.size > RENDERED_PINS) {
      const oldest = this.renderedIds.values().next();
      if (oldest.done) break;
      this.renderedIds.delete(oldest.value);
    }
  }

  /** The pin set — every message id the mirror is still referencing. See {@link pruneToPolicy}. */
  private pinnedMessageIds(): Set<string> {
    const pinned = new Set<string>();

    /**
     * ── THE MESSAGE ON SCREEN, WHICH NOTHING IN THE MIRROR REFERENCES ───────────────────────
     *
     * Every other clause below reads a ROW that points at a message. An open message is pointed
     * at by nothing: reading is not a mutation, the Screener's preview is deliberately
     * side-effect-free, and a message the reader has merely opened has no draft, no triage
     * state and no pending question. So the four record clauses could all be satisfied and the
     * windowed prune would still hard-delete, with its `message_body` cascade, the mail
     * currently under the reader's eyes — mid-read, on the drain that follows.
     *
     * WHY `hydrateBody` IS THE SIGNAL AND NOT A NEW REGISTRATION CALL. The engine holds no view
     * state and should not start. But every reading surface ALREADY tells it which message it is
     * rendering, from an effect keyed on the open id: the Ohbox selection and the reader sheet
     * (`AppShell`), the Screener's selected sender, the Reads/Receipts/History cards. That call
     * is the statement "I am rendering this message's body" — not a proxy for it — so honouring
     * it needs no second seam that a surface could forget to call, and no shell knows about the
     * prune at all.
     *
     * WHAT IT IS NOT: a promise that everything ever opened survives. The hold is capped
     * ({@link RENDERED_PINS}) and lives only in this tab, so it is "what the surfaces are
     * showing", not a second retention policy competing with the window.
     */
    for (const id of this.renderedIds) pinned.add(id);

    for (const d of this.store.list<EngineDraft>("draft")) {
      if (d.inReplyToMessageId) pinned.add(d.inReplyToMessageId);
    }
    // The record id IS the message id for `message_state` (see `mutations.ts`), but the DTO
    // carries it too — read the field first so a server that ever keys these differently does not
    // silently empty this half of the set.
    for (const { id, entity } of this.store.entries<MessageStateDTO>("message_state")) {
      if (entity.state && entity.state !== "none") pinned.add(entity.messageId || id);
    }
    for (const r of this.store.list<PendingRoutingDecision>("routing_decision")) {
      if (r.status === "pending_approval" && r.messageId) pinned.add(r.messageId);
    }
    for (const a of this.store.list<PendingApproval>("approval")) {
      if (a.status === "pending" && a.messageId) pinned.add(a.messageId);
    }
    return pinned;
  }

  /**
   * A drain that is guaranteed to have STARTED AFTER the caller's write committed.
   *
   * ## THE DEFECT THIS EXISTS FOR
   *
   * `syncOnce()` coalesces: a second caller gets the drain already running. For a poll or a wake
   * that is exactly right — they only ever want "catch up", and one drain does. For a mutation
   * reconciling its own write it is WRONG, and wrong in the way that is hardest to see: a drain
   * issued BEFORE the POST committed read the change log at a seq below the mutation's row, so it
   * cannot carry it however long it takes to come back. `dispatch` awaited it anyway, concluded
   * the write had landed, deleted the optimistic overlay — and the mail snapped back to the
   * Screener until the next 8 s poll.
   *
   * Reported twice from real use, as "when I select one as ohbox, it does not seem to work" —
   * and then it does. It depends on whether a poll happens to be in flight when the click lands, which
   * is why it looked intermittent: unpredictable by construction, not by luck.
   *
   * ## WHY "STARTED AFTER THE POST RETURNED" IS SUFFICIENT — AND WHAT WOULD BREAK IT
   *
   * The server allocates each sequence number through an `UPDATE … RETURNING`
   * on the account's `account_sync_state` row, inside the mutation's own transaction, and
   * appends the `change_log` row in that same transaction. So the row lock makes
   * seq order equal COMMIT order per account: seq N is durable before N+1 is ever handed out. A
   * drain issued after our POST returned therefore reads a log in which our row is already
   * visible, and no concurrent drain can move the cursor PAST our seq while our row is still
   * invisible. That is the whole argument, and it rests entirely on that lock — a future
   * `bigserial` seq (allocated outside the transaction, committed out of order) would leave every
   * test here green while making this silently unsound.
   *
   * This is deliberately NOT a wait for `cursor >= outcome.seq`. That is unsound in a way this is
   * not: `SyncService` sets the cursor to the max seq actually RETURNED, computed after the
   * `types` filter, so with `EngineOptions.types` set a seq belonging to a filtered-out entity
   * type is never reached and the wait never terminates. It also needs a fallback anyway —
   * `rule_delete`'s 404 and any absent or non-finite `X-Sync-Seq` give `seq: null` — and a wait
   * loop is unbounded requests — API cost with nobody behind it — where this is exactly one
   * drain.
   *
   * ## WHAT IT COSTS, WHICH IS NOTHING IN THE COMMON CASE
   *
   * No drain in flight ⇒ `syncOnce()` starts one NOW, which is already "after". That is the same
   * single drain the mutation paid for before this existed: no extra round trip, no doubled
   * request rate.
   *
   * A drain in flight ⇒ ONE follow-up, chained behind it and shared by every mutation that lands
   * in the same window. Three clicks during one poll are three overlays and one extra drain, not
   * three.
   *
   * That bound comes from `syncOnce()` itself and needs no bookkeeping here, which is worth
   * stating because the obvious "remember the queued drain" field is redundant and was removed
   * after being written: every mutation waiting on the same in-flight drain has its callback on
   * that ONE promise's reaction list, so the callbacks run as consecutive microtasks; the first
   * calls `syncOnce()`, which assigns `this.syncing` SYNCHRONOUSLY before returning; every
   * sibling therefore finds it set and coalesces. No macrotask can interleave between adjacent
   * microtasks, and a drain cannot finish inside that window because its own first step is an
   * `await`. Proven by experiment rather than argued: with the sharing field disabled the whole
   * suite — including the three-clicks-in-one-window bound — stayed green.
   *
   * Drains therefore never overlap. NOT because of `getCursor()`, which is a plain synchronous
   * field read that serializes nothing, but because the follow-up is created by calling
   * `syncOnce()` from inside a `.then` on the drain it is waiting for, so the single-flight is
   * never bypassed. Concurrency stays 1, which is the property
   * `apps/webapp/app/shell/sync-scheduler.ts` states and `sync-liveness.test.ts` asserts.
   *
   * Two costs are accepted rather than engineered away. A mutation that lands during the ~37-page
   * cold bootstrap now waits for the bootstrap AND a follow-up before it confirms — the overlay
   * keeps the screen correct throughout, and the mutation was already hostage to that bootstrap
   * through `syncOnce`'s coalescing. And a POST that returned before the current drain STARTED
   * chains one drain it did not need: the client cannot tell that case from the broken one,
   * because the only happens-before it owns is "the POST returned". The over-approximation is
   * sound and bounded at one drain; distinguishing it would need a wall clock, and the only clock
   * here is the injectable `now` seam that fixtures freeze.
   */
  private syncFresh(): Promise<void> {
    const inFlight = this.syncing;
    // Nothing running ⇒ this starts a drain now, which is already after the commit.
    if (!inFlight) return this.syncOnce();
    return inFlight
      // The IN-FLIGHT drain's failure is not this mutation's failure — it is a poll that has
      // nothing to do with the write, and this mutation still needs its own drain afterwards.
      // Its rejection still reaches its own caller (the scheduler counts it and arms backoff):
      // `.catch` derives a NEW promise and steals no handler.
      .catch(() => { /* see above */ })
      .then(() => this.syncOnce());
  }

  /** Hook an SSE/EventSource (or push relay) as a wake signal: `sync` events nudge a drain. */
  attachWakeSignal(source: WakeSignalSource, event = "sync"): () => void {
    const onWake = (): void => {
      void this.syncOnce().catch(() => {
        /* a wake nudge must never throw into the event loop; the next tick retries */
      });
    };
    source.addEventListener(event, onWake);
    return () => source.removeEventListener(event, onWake);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** The overlay-merged reader — what selectors and the UI consume. */
  read(): EntityReader {
    return this.readerView;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // ── message bodies ───────────────────────────────────────────────────────

  /**
   * FETCH ONE MESSAGE'S BODY, ON EXPLICIT INTENT.
   *
   * The one capability behind every reading surface. Before it, the wire `MessageDTO`
   * carried `snippet` and never `body`, so on a live account `m.body ?? m.snippet` rendered
   * a single line in the Ohbox, in Reads, in Receipts and in the Screener; every
   * `StreamCard` measured "short"; and `.scast.short .sc-x{display:none}` hid the Expand
   * pill. There was no pill because there was nothing to expand.
   *
   * ── THE RESULT DOES NOT GO ON THE MESSAGE ROW ──────────────────────────────────────────
   *
   * It goes into a client-local `message_body` record — see {@link MessageBodyRecord} for
   * the mechanism and for the live-only bug that shape makes unreachable. Nothing here
   * touches `message`.
   *
   * ── IDEMPOTENT, SINGLE-FLIGHT ──────────────────────────────────────────────────────────
   *
   * Two surfaces can want the same body at once — the Ohbox read column and the reader sheet
   * render the same message simultaneously — so concurrent callers join one request. A body
   * already `ready` is never re-fetched.
   *
   * A `loading` record with no promise behind it — a tab that died mid-request; the record
   * persists, the promise does not — IS re-fetched. That cannot loop, because a `loading`
   * record written by THIS engine always has an entry in the in-flight map above it. The map
   * is the dedup that matters; deciding from the record's state alone would make a zombie
   * `loading` a permanent spinner with no way out.
   *
   * ── `retry` — WHY A FAILURE IS NOT RETRIED BY DEFAULT ───────────────────────────────────
   *
   * Most callers are React effects: "the card became current", "this sender was selected".
   * They re-run whenever their inputs change, and a failed fetch writes a record, which bumps
   * the mirror version, which re-renders — so a `failed` state that re-fetched on the default
   * path would be a request loop against a server that is already refusing, billed per
   * attempt, for as long as the view stays open, with nobody behind any of it. Found by exactly
   * that: a
   * 500-ing adapter under a view whose callback identity changed per render spun until the
   * test timed out.
   *
   * So the rule is about WHO is asking, not about the state. An automatic trigger asks once
   * and reports the failure; a HUMAN act — re-expanding a card, pressing Retry — passes
   * `retry` and asks again. That also makes the failed state's exit a thing the user chose,
   * which is what a control on screen is for.
   *
   * ── WHY IT NEVER REJECTS ───────────────────────────────────────────────────────────────
   *
   * Every caller is a React effect or a click handler; a rejection there is an unhandled
   * promise and, at worst, an error boundary over somebody's mailbox. The outcome is the
   * RECORD — `ready` or `failed` — which is a thing the UI can render. The failure is
   * reported on screen, not thrown at the DOM.
   *
   * ── `urgent` — A MESSAGE SOMEBODY IS LOOKING AT DOES NOT WAIT BEHIND A BACKLOG ────────────
   *
   * {@link bodySlot} lets four fetches run at once and queues the rest, which is what keeps a
   * forty-message sender from opening forty connections. But the queue is FIFO and has no notion
   * of what is on screen, so the message the reader just SELECTED could be queued behind a
   * Screener preview's backlog that nobody is watching — the one body that is the whole screen
   * waiting on bodies that are not.
   *
   * `urgent` jumps that queue. It is passed by the shell's two selection effects and by nothing
   * else, because "this is the message being opened" is knowledge only the selection has.
   *
   * IT IS A SEPARATE FLAG FROM `retry`, DELIBERATELY. `retry` also jumps the queue — a human
   * pressing "try again" must not wait — and overloading it here would have been one word
   * shorter and wrong: `retry` ALSO bypasses the failed-guard above, so a selection effect
   * carrying it would re-ask a refusing server on every render, which is exactly the billed
   * poll-with-nobody-behind-it that guard exists to prevent. Two facts, two flags.
   */
  async hydrateBody(messageId: string, opts: { retry?: boolean; urgent?: boolean } = {}): Promise<void> {
    /**
     * ── AND IT DOUBLES AS "A SURFACE IS RENDERING THIS MESSAGE" ─────────────────────────────
     *
     * Recorded FIRST, above every early return, because the statement is true whatever the
     * answer turns out to be — a protected message and a body already `ready` are both on
     * screen. {@link OhmailEngine.pinnedMessageIds} reads it so the windowed prune cannot evict
     * the message a reader is looking at; see there for why this call is the signal.
     */
    this.noteRendered(messageId);
    const inFlight = this.bodyRequests.get(messageId);
    if (inFlight) return inFlight;

    const plan = this.bodyPlan(messageId, opts.retry === true);
    if (plan.kind === "skip") return;
    if (plan.kind === "purge") return this.putBody(messageId, null);

    /**
     * ── EVERYTHING UP TO THIS `set` IS SYNCHRONOUS, AND IT HAS TO BE ────────────────────────
     *
     * The single-flight is the map, and a map written after an `await` is not one: two effects
     * firing in the same tick — which is what React does, twice over in StrictMode — would both
     * see an empty entry and both issue a request. `bodyPlan` is therefore a pure, synchronous
     * decision, and the first thing that may suspend is the marker write inside `startBody`,
     * which happens AFTER the promise is already registered here.
     */
    const request = this.startBody(messageId, plan.held, opts.urgent === true || opts.retry === true);
    this.bodyRequests.set(messageId, request);
    return request;
  }

  /**
   * IS THERE A BODY TO ASK FOR, AND WHAT IS HELD NOW — the whole admission decision, in one
   * synchronous place because two callers need exactly the same answer.
   *
   * {@link OhmailEngine.hydrateBody} asks about one message and {@link OhmailEngine.hydrateThread}
   * about a conversation's worth at once. Re-deriving these rules in the second caller would put
   * "does the demo issue requests", "is a protected body purged" and "is a failed body re-asked"
   * in two places that are only ever tested through one of them.
   *
   * `purge` is separated from `skip` because it is a WRITE, and this function performs none — see
   * the note in `hydrateBody` about why nothing here may suspend.
   */
  private bodyPlan(
    messageId: string,
    retry: boolean,
  ): { kind: "skip" } | { kind: "purge" } | { kind: "fetch"; held: MessageBodyRecord | undefined } {
    const msg = this.read().get<EngineMessage>("message", messageId);
    // Not in the mirror at all — a fixture `screener_sender`'s held id, or a row that has
    // since been drained away. Nothing to ask about.
    if (!msg) return { kind: "skip" };
    /**
     * ALREADY WHOLE. The demo's message rows carry `body` (`fixtures-adapter.ts` →
     * `toMessage`), and `bodyOf` answers `full` from exactly this field — so the two agree
     * by construction rather than by both being remembered. This is also what keeps the
     * demo at zero requests without the demo being a special case here.
     */
    if (msg.body !== undefined) return { kind: "skip" };
    /**
     * A PROTECTED MESSAGE HAS NO BODY TO ASK FOR — AND MUST HOLD NONE AT REST.
     *
     * Its surface renders `ProtectedBlock` and no text whatever the mirror holds (`MessagePane`
     * is where that decision lives), so a fetch here could only ever produce a
     * record nothing reads. Skipping it also keeps the demo's one body-less fixture from churning
     * a loading record every time it is selected.
     *
     * The second clause is the at-rest half. A message that cached a body while it was ORDINARY
     * and then became protected is the raw secret sensitive mail is redacted to avoid, sitting
     * in IndexedDB (and,
     * via {@link SearchIndex}, the local search index). The delta cascade in {@link MirrorStore}
     * purges on the transition; this is the belt-and-braces for a body cached by an older engine,
     * or one the transition missed — purge any held record before returning. `isProtectedMessage`
     * keys on `sensitivity.sensitive` (the Cloud signal) as well as the fixture `protected` extra,
     * so the real reclassification case is covered, not only the demo.
     */
    if (isProtectedMessage(msg)) {
      const held = this.read().get<MessageBodyRecord>("message_body", messageId);
      return held === undefined ? { kind: "skip" } : { kind: "purge" };
    }
    const held = this.read().get<MessageBodyRecord>("message_body", messageId);
    /**
     * ── ALREADY READY — **AND FROM A BUILD THAT KNEW ABOUT `html`** ─────────────────────
     *
     * The html part and a renderer for it shipped together, and a message already opened was
     * STILL a text dump ending in a tracking pixel's url. Not a stale deploy (the live mailbox
     * chunk contains the renderer) and not a missing server field (that message's `html` was
     * there, and long): it was THIS LINE.
     *
     * `message_body` records are persisted (`IndexedDbMirrorStore`), and one written by any
     * build from before it is `{messageId, state, text}` with no `html` key at all. `ready`
     * suppressed the fetch, `bodyOf` read `rec.html ?? null`, and every message the reader had
     * already opened stayed frozen in the pre-fix shape for ever — while newly-arrived mail
     * rendered correctly, which is why the product looked unfixed only to the people already
     * using it.
     *
     * `html !== undefined` and NOT `html != null`, and the difference is the whole of it:
     *
     *   `undefined`  no build ever answered this record's question. Ask now.
     *   `null`       a build DID ask, and the answer was "this message has no html" — a
     *                plain-text mail, or a sensitive one whose html is deliberately not stored
     *                (`pipeline.ts`). Re-asking would be a permanent billed poll with nobody
     *                behind it, against a server that will keep answering the same thing.
     *
     * It is a re-read, not a migration: {@link MessageBodyRecord} says why inventing `html:
     * null` for these rows is forbidden — it is indistinguishable from a message that genuinely
     * has none. And it is not a sweep. `hydrateBody` is called per message on explicit intent,
     * so this costs ONE extra `GET /messages/:id/body` per message the reader opens again,
     * once, and nothing for mail they never open.
     *
     * IT TERMINATES BECAUSE `fetchBodyInto` ALWAYS WRITES THE KEY — `HttpAdapter.fetchBody`
     * normalises a missing wire field to `null`, and the `failed` arm sets it explicitly — so
     * no transport can produce a record that lands back in this branch. `body-hydration.test.ts`
     * asserts the count, not just the outcome, for exactly that reason.
     */
    if (held?.state === "ready" && held.html !== undefined) {
      /**
       * ── THE ONE READY RECORD THAT IS STILL WORTH ASKING ABOUT ───────────────────────────────
       *
       * A record written by a build that predates the storage-cap marker cannot be told from a
       * genuinely empty message: `{state: "ready", text: "", html: null}` is exactly what a
       * pre-slice client persists for a body the server has begun WITHHOLDING, because it drops
       * the wire field it does not know. Left alone, the clause above skips it for ever and
       * `bodyOf` reports `full` over nothing — the marker's whole purpose defeated, permanently,
       * for every tab that was open across the deploy.
       *
       * `withheld === undefined` is the discriminator, and it exists only because both write
       * sites now ALWAYS set the key (`null` for an ordinarily stored body). So this is not a
       * poll: one re-ask heals the record, the answer writes the key either way, and the record
       * can never match this branch again.
       *
       * NARROW ON PURPOSE — the cost argument above is load-bearing. Only `text === ""` AND
       * `html === null` qualifies, which is the shape a withheld body has. A plain-text mail with
       * real text and `html: null` is the common `html`-absence case and must never become a
       * request; a record already carrying the key, in either value, has been answered by a build
       * that could tell. And `bodyHealed` bounds it to ONCE per engine even if the mirror write
       * is refused, exactly as the `failed` arm below does.
       */
      const preCapEmpty = held.text === "" && held.html === null && held.withheld === undefined;
      if (!preCapEmpty || this.bodyHealed.has(messageId)) return { kind: "skip" };
      this.bodyHealed.add(messageId);
      return { kind: "fetch", held };
    }
    /**
     * ── A FAILURE IS FOR THIS SESSION, NOT FOR EVER ────────────────────────────────────────
     *
     * See `retry` above for why an automatic trigger must not re-ask a server that already
     * refused: the effects behind this call re-run on every mirror bump, and a failed record IS a
     * mirror bump, so re-asking on the default path is a billed poll with nobody behind it.
     *
     * That argument is about ONE SESSION and was being applied for ever, because these records
     * are persisted. A body that failed during a deploy, on a lost connection, or on a lambda
     * that cold-started past the 12 s deadline stayed `failed` in that browser until the reader
     * pressed Retry on that exact message — and reloading the tab, which is what everybody
     * actually does, changed nothing at all.
     *
     * So the guard is narrowed to the thing it was defending: within this engine's life, never
     * re-ask. A record stamped before {@link OhmailEngine.bootedAt} — or carrying no stamp,
     * which by construction means a build that predates the field and therefore an earlier
     * session ({@link MessageBodyRecord.failedAt}, read exactly as `html !== undefined` above is)
     * — is re-asked ONCE, and `bodyHealed` is what makes that "once" a property of the engine
     * rather than of a mirror write that can itself be refused.
     */
    if (held?.state === "failed" && !retry) {
      const stale = held.failedAt === undefined || held.failedAt < this.bootedAt;
      if (!stale || this.bodyHealed.has(messageId)) return { kind: "skip" };
      this.bodyHealed.add(messageId);
    }
    return { kind: "fetch", held };
  }

  /**
   * ── THE `loading` MARKER IS WRITTEN AT ENQUEUE, NOT AT DEPARTURE ─────────────────────────
   *
   * This used to live at the top of `fetchBodyInto`, which runs inside {@link bodySlot} — i.e.
   * only once a slot is free. Four fetches may be in the air, so the fifth message a reader
   * opened had NO `message_body` record at all for as long as the queue held it, and a message
   * with no record is exactly what `bodyOf` answers `snippet` for. The surfaces then rendered
   * that snippet as though it were the mail: 200 characters cut mid-word, inside full message
   * anatomy, with nothing on screen saying anything was still coming. Silent, and worst precisely
   * when the app is busiest.
   *
   * Writing it here closes the window structurally: from the moment a fetch is DECIDED there is a
   * record saying so, whether it departs now or in four round trips. The surfaces' snippet branch
   * becomes unreachable for a message being hydrated, which is why they may now treat a resting
   * `snippet` as the defect it is.
   *
   * The `.finally` clears the single-flight entry on both arms, rejection included — a leaked
   * entry would make every later call join a promise that is never coming back, which is the
   * failure {@link BODY_FETCH_TIMEOUT_MS} exists for, reached from the other side.
   */
  private startBody(
    messageId: string,
    held: MessageBodyRecord | undefined,
    urgent: boolean,
  ): Promise<void> {
    return this.markLoading(messageId, held)
      .then(() => this.bodySlot(urgent, () => this.fetchBodyInto(messageId)))
      .finally(() => {
        this.bodyRequests.delete(messageId);
      });
  }

  /**
   * ── `held` IS HERE SO A RE-READ DOES NOT TAKE THE MESSAGE OFF THE SCREEN ────────────────
   *
   * This write used to be unconditional, and that is destructive: `bodyOf` answers a `loading`
   * record with the SNIPPET, so a message the reader is looking at collapsed to one line the
   * instant anything asked for it again. The re-read above (`ready` with no `html` key, from a
   * build that predates the html part) is exactly such a caller, and it fires on a message the
   * reader has just opened — so the visible effect of fixing that record was the body
   * disappearing first. If the fetch then failed or hung, they had LOST a body they already had.
   *
   * A record that is already `ready` is therefore left alone until there is something better to
   * put in its place. The reader keeps reading; the swap happens when the answer arrives.
   *
   * ── AND THE REFUSAL IS SWALLOWED, WHICH IS NOT A TIDY-UP ────────────────────────────────
   *
   * `putBody` reaches IndexedDB, and IndexedDB refuses: a quota that is full, a private window, a
   * connection closed by a version change, an `IdbMirrorStore` whose owner moved. This write now
   * sits OUTSIDE `fetchBodyInto`'s try, so an unguarded rejection here would propagate out of
   * `hydrateBody` — breaking its "WHY IT NEVER REJECTS" contract, in a React effect, where the
   * outcome is an unhandled rejection over somebody's mailbox. The fetch still goes ahead: a
   * mirror that cannot hold a marker can very well hold the answer.
   */
  private async markLoading(messageId: string, held: MessageBodyRecord | undefined): Promise<void> {
    if (held?.state === "ready") return;
    try {
      await this.putBody(messageId, {
        messageId, state: "loading", text: "", html: null, loadedRemoteContent: false,
      });
    } catch {
      /* the mirror refused the marker; ask anyway — see above, never rethrow */
    }
  }

  /**
   * ── ONE REQUEST FOR A WHOLE CONVERSATION ────────────────────────────────────────────────
   *
   * Opening a thread needs every sibling's body, and until this existed the surface asked for them
   * one at a time from a single effect: eight siblings were eight `GET /messages/:id/body` calls
   * through a four-wide limiter, so the last two did not even START until a full round trip had
   * finished, and the reader watched the conversation assemble itself in visible steps. The
   * batch route answers all of them in one.
   *
   * ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────────────────
   *
   * The admission rules are `hydrateBody`'s own, through {@link bodyPlan}: a demo row that carries
   * its body is not asked for, a protected sibling is PURGED rather than fetched (which is why
   * these ids are passed in rather than filtered by the caller), a `ready` body with an `html` key
   * is left alone, and a failure is re-asked only across a session boundary. The markers are
   * written for the whole set BEFORE anything leaves, for the reason {@link startBody} gives, and
   * the single-flight entries are registered synchronously so that React's double-invoked effect
   * produces one request rather than two.
   *
   * ── AND IT IS NOT REQUIRED TO EXIST ─────────────────────────────────────────────────────
   *
   * An adapter with no batch route falls back to asking per message — the FixturesAdapter, the
   * desktop shell, a test with a bare double. That fallback is also what makes a server which
   * ignores the parameter merely slower: ids the answer did not carry are fetched singly below.
   */
  hydrateThread(messageIds: string[]): Promise<void> {
    return this.hydrateMany(messageIds, { rendered: true });
  }

  /**
   * The shared batch core behind {@link hydrateThread} and the eager pass. `rendered` is the
   * one difference between the two callers, and it is a fact only the caller knows: a thread
   * open means every one of these ids is ON SCREEN and must be pinned against the windowed
   * prune; a background prefetch means none of them is, and pinning them would flush the
   * {@link RENDERED_PINS} LRU of the ids that genuinely are.
   */
  private hydrateMany(messageIds: string[], opts: { rendered: boolean }): Promise<void> {
    const fetchBodies = this.fetchBodiesFn;
    const ids = [...new Set(messageIds)];
    if (!fetchBodies) {
      if (opts.rendered) {
        return Promise.all(ids.map((id) => this.hydrateBody(id))).then(() => undefined);
      }
      // The per-id fallback WITHOUT the pin write `hydrateBody` opens with — same admission,
      // same single-flight registration, no claim that a surface is rendering anything.
      const runs = ids.map((id) => {
        const inFlight = this.bodyRequests.get(id);
        if (inFlight) return inFlight;
        const plan = this.bodyPlan(id, false);
        if (plan.kind === "purge") return this.putBody(id, null);
        if (plan.kind === "skip") return Promise.resolve();
        const request = this.startBody(id, plan.held, false);
        this.bodyRequests.set(id, request);
        return request;
      });
      return Promise.all(runs).then(() => undefined);
    }

    const take: Array<{ id: string; held: MessageBodyRecord | undefined }> = [];
    const writes: Array<Promise<void>> = [];
    for (const id of ids) {
      if (opts.rendered) this.noteRendered(id);
      // Already in the air, alone or in another batch — join it rather than ask twice.
      if (this.bodyRequests.has(id)) continue;
      const plan = this.bodyPlan(id, false);
      if (plan.kind === "purge") { writes.push(this.putBody(id, null)); continue; }
      if (plan.kind === "skip") continue;
      take.push({ id, held: plan.held });
    }

    // Split rather than refuse: the server caps an id list at {@link BODIES_IDS_MAX} because a
    // truncated answer is indistinguishable from "those messages have no body", so a conversation
    // longer than the cap becomes two requests here and never a 400 the reader would see.
    for (let i = 0; i < take.length; i += BODIES_IDS_MAX) {
      const chunk = take.slice(i, i + BODIES_IDS_MAX);
      const chunkIds = chunk.map((c) => c.id);
      const run = Promise.all(chunk.map((c) => this.markLoading(c.id, c.held)))
        .then(() => this.bodySlot(false, () => this.fetchBodiesInto(chunkIds, fetchBodies)))
        .finally(() => {
          for (const id of chunkIds) this.bodyRequests.delete(id);
        });
      for (const id of chunkIds) this.bodyRequests.set(id, run);
      writes.push(run);
    }
    return Promise.all(writes).then(() => undefined);
  }

  /**
   * Distribute one batch answer into `message_body` records.
   *
   * THE ROWS ARE MATCHED BY ID, NEVER BY POSITION. The server answers only the ids the caller's
   * own account owns and omits the rest — silently, so the response cannot be read as an existence
   * oracle for somebody else's ids — and it may also stop early on its byte budget. So "shorter
   * than asked" is a normal answer, and an id the batch did not carry is asked for on its own
   * rather than left as a marker nothing will ever replace. That per-id tail is also what makes a
   * server which does not understand the parameter degrade to the old behaviour instead of to a
   * thread of empty messages.
   *
   * A THROW IS THE WHOLE BATCH'S. One request carried all of these, so its refusal is each of
   * their refusals — every id gets the `failed` record it would have got asking alone, which is a
   * state the surfaces render with a Retry beside it.
   */
  private async fetchBodiesInto(ids: string[], fetchBodies: FetchBodiesFn): Promise<void> {
    let rows: MessageBodyBatchWire[] | null;
    try {
      rows = await fetchBodies(ids);
    } catch (err) {
      await Promise.all(ids.map((id) => this.failBody(id, err)));
      return;
    }
    // `null` ⇒ this adapter serves no bodies. Same meaning and same handling as `fetchBody`'s
    // `null`: tombstone the markers rather than leave a surface saying "loading…" for ever.
    if (rows === null) {
      for (const id of ids) {
        try { await this.putBody(id, null); } catch { /* the mirror refused; nothing to report */ }
      }
      return;
    }
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    const missing: string[] = [];
    for (const id of ids) {
      const wire = byId.get(id);
      if (wire === undefined) { missing.push(id); continue; }
      try {
        // The same record `fetchBodyInto` writes, field for field — including the `?? null`
        // normalisations, which are about the KEY existing rather than about the value. See
        // there: a record that could leave `html` absent lands back in the re-read branch and
        // polls for ever.
        await this.putBody(id, {
          messageId: id,
          state: "ready",
          text: wire.text,
          html: wire.html ?? null,
          loadedRemoteContent: wire.loadedRemoteContent === true,
          unsubscribe: wire.unsubscribe ?? "no_header",
          unsubscribeUrl: wire.unsubscribeUrl ?? null,
          // ALWAYS written, never spread conditionally — `null` is "a withheld-aware build
          // answered, and this body is ordinarily stored". Absence is reserved for records no
          // such build ever touched, which is what makes the pre-slice heal terminate. The batch
          // path and the single path must agree; see `MessageBodyRecord.withheld`.
          withheld: wire.withheld === "storage_cap" ? ("storage_cap" as const) : null,
        });
      } catch (err) {
        await this.failBody(id, err);
      }
    }
    for (const id of missing) await this.fetchBodyInto(id);
  }

  /**
   * ── HOW MANY BODIES MAY BE IN THE AIR AT ONCE ──────────────────────────────────
   *
   * `bodyRequests` single-flights per MESSAGE, which is the wrong axis for the caller that
   * matters. The Screener preview hydrates every held message of the selected sender in one
   * effect, so a sender with forty held messages opened forty `GET /messages/:id/body` requests
   * in a single tick — none of them duplicates, so nothing above deduplicated them.
   *
   * What that looks like on screen is the reported defect. `fetchBodyInto` writes `failed` on any
   * throw, `bodyOf` answers `html: null` for a record that is not `ready`, and `MessageBody`
   * renders its text fallback when `html` is null — so a burst that overruns the browser's or the
   * server's connection limit turns into a preview of plain-text dumps beside one or two properly
   * rendered frames. It looks like the viewer failing on threads. It is the fan-out.
   *
   * A HUMAN JUMPS THE QUEUE, on either of the two facts that mean somebody is waiting for THIS
   * message. `retry: true` is a person pressing "try again" on a message in front of them, and
   * making that wait behind an automatic backlog would make the one control that exists for this
   * feel broken. `urgent: true` is the shell saying a message has just been OPENED — the body
   * that is the entire screen must not queue behind a Screener preview's backlog nobody is
   * watching. Both arrive here as the same `urgent` parameter, because to the limiter they are
   * one fact; they are two flags at the call site because only one of them may also re-ask a
   * server that refused (see `hydrateBody`).
   *
   * The slot is released in `finally`, including on rejection. A limiter that leaked a slot on
   * failure would starve every later hydration and do it silently — the same class of defect as
   * the one above, reached from the other side.
   */
  private bodySlot<T>(urgent: boolean, run: () => Promise<T>): Promise<T> {
    if (urgent || this.bodyActive < MAX_CONCURRENT_BODIES) {
      this.bodyActive++;
      return run().finally(() => {
        this.bodyActive--;
        this.bodyQueue.shift()?.();
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.bodyQueue.push(() => {
        this.bodyActive++;
        run().then(resolve, reject).finally(() => {
          this.bodyActive--;
          this.bodyQueue.shift()?.();
        });
      });
    });
  }

  /**
   * Unsubscribe this message's sender (RFC 8058 one-click, performed server-side). A passthrough
   * to the adapter, because there is nothing to reconcile into the mirror — the effect lives at a
   * third party, and the record of "we already asked" is the SERVER's `unsubscribe_records`
   * table, not a client entity. Returns `null` when the adapter serves no unsubscribe (the
   * FixturesAdapter — the demo, a test with no API), so a surface offers no control rather than a
   * dead one. A refusal REJECTS with the server's own sentence (`MutationRejectedError`), which
   * is the string the surface renders.
   */
  async unsubscribe(messageId: string): Promise<UnsubscribeResult | null> {
    if (!this.adapter.unsubscribe) return null;
    return this.adapter.unsubscribe(messageId);
  }

  /**
   * ── THE WRITE IS INSIDE THE TRY, WHICH IS NOT A TIDY-UP ─────────────────────────────────
   *
   * `putBody` reaches IndexedDB, and IndexedDB refuses: a quota that is full, a private window,
   * a connection closed by a version change, an `IdbMirrorStore` whose owner moved. A write
   * outside the `try` propagates that refusal out of `hydrateBody` — breaking the "WHY IT NEVER
   * REJECTS" contract stated above it, in a React effect, where the outcome is an unhandled
   * rejection over somebody's mailbox. Everything that can throw is inside, and the failure arm
   * has its own guard: see {@link OhmailEngine.failBody}.
   *
   * The `loading` marker is NO LONGER WRITTEN HERE. It moved up to {@link markLoading}, which
   * runs at enqueue rather than at departure — see there for the window that closed.
   */
  private async fetchBodyInto(messageId: string): Promise<void> {
    try {
      const wire = await this.adapter.fetchBody(messageId);
      // `null` ⇒ this adapter serves no bodies (the fixtures world). Tombstone the loading
      // marker rather than leaving a surface saying "loading…" forever; `bodyOf` then falls
      // back to the snippet, which is the honest answer for an adapter with no endpoint.
      //
      // `html` rides along, UNTOUCHED. This is the one hop between the wire and the
      // renderer and it must stay a carry: sanitizing here would put attacker markup through
      // a transform in the engine, where no surface can see what it did and where the result
      // would be written into the mirror. What is stored is what the sender wrote.
      //
      // ── `?? null` IS ABOUT THE KEY EXISTING, NOT ABOUT THE VALUE ────────────────────────
      //
      // No string is altered by it: it maps `undefined` — a field this adapter did not answer —
      // onto the `null` that MEANS "there is no html", so that a record THIS ENGINE WROTE
      // always carries the key. `hydrateBody` decides a record predates the html part, and
      // re-fetches it,
      // from `html === undefined`; a write that could leave the field absent would land back in
      // that branch on the next open and poll for ever.
      //
      // `HttpAdapter.fetchBody` already normalises, so the shipped path never needed this — and
      // that is exactly the argument against relying on it. `EngineAdapter.fetchBody` is a seam
      // with four implementations and no compiler check that a value is present rather than
      // `undefined`, so the termination of a loop must be a property of the engine and not of
      // one adapter's manners. Proven, not assumed: this file's own test double answers
      // `{ text }` alone, and with the plain carry two long-standing "a READY body is not
      // re-fetched" tests went red the moment `hydrateBody` learned to distrust an absent key.
      await this.putBody(
        messageId,
        wire === null
          ? null
          : {
              messageId,
              state: "ready",
              text: wire.text,
              html: wire.html ?? null,
              loadedRemoteContent: wire.loadedRemoteContent === true,
              // The unsubscribe posture rides the same ready record. `HttpAdapter.fetchBody`
              // already normalised the wire (default `"no_header"` / `null`); `?? …` here keeps
              // a bare test double or the FixturesAdapter — which answer `{ text }` — honest.
              unsubscribe: wire.unsubscribe ?? "no_header",
              unsubscribeUrl: wire.unsubscribeUrl ?? null,
              // The server's withheld marker, ALWAYS written — `null` when the body is
              // ordinarily stored, never omitted. The record stays `ready` (the server ANSWERED,
              // so the single-flight ledger and every "a READY body is not re-fetched" rule
              // apply unchanged) and `bodyOf` derives the terminal `withheld` surface state from
              // the marker, never from emptiness. Writing the key unconditionally is what lets
              // the guard below distinguish "not withheld" from "never asked by a build that
              // could tell", and so what makes the pre-slice heal happen ONCE and stop.
              withheld: wire.withheld === "storage_cap" ? ("storage_cap" as const) : null,
            },
      );
    } catch (err) {
      await this.failBody(messageId, err);
    }
  }

  /**
   * Record that this body could not be read — the state the surfaces render as "couldn't load
   * the full message" with a Retry beside it.
   *
   * ITS OWN WRITE IS GUARDED, AND THAT IS THE POINT OF SPLITTING IT OUT. This runs on the arm
   * that already knows something has gone wrong, and it reaches the same IndexedDB that may be
   * the thing going wrong. A throw from here would escape `fetchBodyInto`'s `catch` — there is
   * no outer one — and reject `hydrateBody`, so the mirror refusing a write would turn a
   * reportable failure into an unhandled rejection. Swallowed deliberately: the record keeps
   * whatever it held, `hydrateBody` still resolves, the single-flight entry is still cleared by
   * the `.finally` above it, and the reader can ask again.
   */
  private async failBody(messageId: string, err: unknown): Promise<void> {
    try {
      await this.putBody(messageId, {
        messageId,
        state: "failed",
        text: "",
        html: null,
        loadedRemoteContent: false,
        error: err instanceof Error ? err.message : String(err),
        // WHEN, so a reload can tell this failure apart from one this session already made and
        // refused to repeat. See {@link MessageBodyRecord.failedAt} and `bodyPlan`'s failed arm.
        failedAt: this.now().getTime(),
      });
    } catch {
      /* the mirror refused the failure record too; see above — never rethrow */
    }
  }


  private async putBody(messageId: string, record: MessageBodyRecord | null): Promise<void> {
    await this.store.putLocal("message_body", messageId, record);
    this.notify();
  }

  // ── optimistic mutations ─────────────────────────────────────────────────

  /**
   * DROP THE RESURFACED IDS — the one place a glance is narrowed, for every verb that is one.
   *
   * Both callers sit in {@link enrich}, which is deliberate and is the whole design: the enriched
   * mutation is what freezes onto the queue, and `mutationEffects` and the adapters all read the
   * id list off it afterwards. So a single filter here moves the optimistic overlay, the demo
   * backend's echo and the outgoing PATCHes together. Filtering per-consumer instead would let
   * the wire spend a pin the overlay still showed, or the reverse — the same divergence in two
   * directions, and neither is reachable from a chokepoint.
   *
   * An id the mirror does not hold is KEPT. It is not knowably a pin, and `mutationEffects`
   * already declines to invent an effect for it; dropping it here would quietly turn "not synced
   * yet" into "refused to send".
   */
  private withoutPins(ids: string[]): string[] {
    const reader = this.read();
    return ids.filter((id) => {
      const msg = reader.get<EngineMessage>("message", id);
      return msg === undefined || !isResurfaced(msg);
    });
  }

  /** Fill in wire-derivable fields so adapter + overlay agree on the payload. */
  private enrich(m: EngineMutation): EngineMutation {
    if (m.kind === "tag_assign" && m.labels === undefined) {
      const msg = this.read().get<EngineMessage>("message", m.messageId);
      if (msg) {
        const labels = m.assigned
          ? [...new Set([...msg.labels, m.tagId])]
          : msg.labels.filter((l) => l !== m.tagId);
        return { ...m, labels };
      }
    }
    if (m.kind === "feed_mark_seen") {
      const reader = this.read();
      // The mark-the-whole-feed form: every unread id of the VIEW'S folder, so the wire PATCHes
      // exactly the set the optimistic effect flips — per `FeedView`, no longer Reads-only.
      const folder = FOLDER_OF_VIEW[m.view ?? "reads"];
      const given = m.messageIds ?? reader
        .list<EngineMessage>("message")
        .filter((msg) => msg.folder === folder && msg.unread)
        .map((msg) => msg.id);
      /**
       * ── A GLANCE DOES NOT SPEND A RESURFACE, AND THIS IS THE ONLY PLACE THAT CAN SAY SO ─────
       *
       * `feed_mark_seen` is the client's INVOLUNTARY read: the per-card dwell mark fires while
       * somebody is merely scrolling, and the leave-commit fires because they left. Its wire side
       * is `PATCH /messages/:id {unread:false}` per id, which is a route that calls
       * `MessageService.spendResurface` — so before this filter existed, scrolling past a pinned
       * row, or just leaving the stream it sat in, took the pin down. The server's own comment
       * states the rule the client was breaking: "Merely OPENING the row is deliberately neither:
       * a glance does not spend the resurface."
       *
       * A resurfaced row is answered by DEALING with it — the read pill, `⇧I`, a bulk selection,
       * read-all, filing it, or a reply whose settle marks the parent read. Not one of those
       * comes through this verb, so this narrows the accidental read alone. See
       * {@link withoutPins} for why the filter lives at this seam rather than at its consumers.
       *
       * BOTH FORMS ARE FILTERED, which is why this arm no longer waits for `messageIds ===
       * undefined`: the whole-feed sweep derives its own ids just above, and "mark everything
       * read" is no more an answer to a particular message than a scroll is.
       *
       * The consequence, stated because it is deliberate and looks like a bug: a pinned row that
       * has been READ stays bold. `unread` and the pin are spent by the same act, so there is no
       * state in which one is gone and the other stands. It is the honest rendering of "you have
       * not dealt with this yet".
       */
      return { ...m, messageIds: this.withoutPins(given) };
    }
    if (m.kind === "mark_seen" && m.via === "glance" && !m.unread) {
      /**
       * THE OTHER GLANCE, and it is the one that matters most — because resurfaced rows are
       * pinned in the OHBOX, and the Ohbox does not use `feed_mark_seen` at all.
       *
       * `feed_mark_seen` is a stream verb (Reads, Receipts). The Ohbox marks mail read through
       * `mark_seen`, and it does so on a two-second cursor DWELL whose debt is spent on the way
       * out — `OhboxView.commitPendingRead`, fired by leaving the view, closing the reader on a
       * narrow width, or `pagehide`. That path is a glance by any reading of the word: nobody
       * pressed anything. Without this arm, "resurface a message, open it, navigate away" spent
       * the pin, which is precisely the thing that must not happen.
       *
       * GATED ON `via`, NOT GUESSED. A deliberate read and a dwell commit are identical here —
       * same ids, same flag — so the surface that decided for the reader is the only thing that
       * can know, and it says so. Absent ⇒ deliberate ⇒ spends, so the read pill, `⇧I`, bulk,
       * read-all and the settled reply are all untouched by this and go on answering pins.
       *
       * `!m.unread` because marking UNREAD never spent a resurface on either side of the wire
       * (`MessageService.patch` skips `spendResurface` unless `unread === false`), so filtering
       * that direction would drop ids for no reason — and it is `u`, which is deliberate anyway.
       */
      return { ...m, messageIds: this.withoutPins(m.messageIds) };
    }
    if (m.kind === "mail_send") {
      // FREEZE THE ENVELOPE HERE, and nowhere else. The overlay effect and the wire body are
      // both computed from this one object, so they cannot disagree — and because the
      // enriched mutation is what goes on the queue, a retry after a network failure sends
      // the SAME envelope rather than re-deriving it from a mirror that has since drained.
      if (m.inReplyTo === null) {
        // A COMPOSE. The recipient and the subject are the USER's and are not derived from
        // anything; the only unknown is which of the account's mailboxes it goes out from,
        // and `threadId` is pinned to null so nothing downstream can wander into a thread.
        return {
          ...m,
          mailboxId: m.mailboxId ?? sendingMailboxId(this.read()) ?? undefined,
          threadId: null,
        };
      }
      const parent = this.read().get<EngineMessage>("message", m.inReplyTo);
      if (!parent) return m; // unknown parent ⇒ no effects ⇒ mutate() rejects it below
      return {
        ...m,
        mailboxId: m.mailboxId ?? parent.mailboxId,
        threadId: m.threadId ?? parent.threadId,
        subject: m.subject ?? replySubject(parent.subject),
        // The reply goes to the sender of the message being answered. `Reply-To` is not in
        // the mirror (the DTO has no field for it), so a sender who set one is answered at
        // their From — filed as owed rather than silently approximated.
        to: m.to ?? [parent.from],
      };
    }
    return m;
  }

  /**
   * Apply locally NOW, fire the request, reconcile on the echo. Hard rejection
   * ⇒ overlay rolled back; retryable failure ⇒ mutation stays queued (and
   * visible — user-always-wins) for flushPending() with the SAME key.
   */
  async mutate(m: EngineMutation): Promise<MutationResult> {
    const enriched = this.enrich(m);
    const id = this.uuid();
    const key = this.uuid();

    const effects = mutationEffects(this.read(), enriched, { now: this.now, uuid: this.uuid });
    if (effects.length === 0) {
      const error = new MutationRejectedError(`mutation target not found (${m.kind})`, {
        status: 404, code: "not_found",
      });
      return { id, key, status: "rolled_back", seq: null, error };
    }
    this.overlays.set(id, effects);
    this.overlayRev++;
    this.notify();

    return this.dispatch({ id, key, mutation: enriched });
  }

  private async dispatch(p: PendingMutation): Promise<MutationResult> {
    try {
      const outcome = await this.adapter.mutate(p.mutation, { idempotencyKey: p.key });
      /**
       * THE SENT COPY IS MATERIALISED ON THE SERVER'S WORD AND ON NOTHING ELSE'S — which means
       * HERE, the line after that word arrives, and not below the reconciliation branch.
       *
       * The invariant is unchanged and is the reason this is not simply moved into
       * `mutationEffects`: a send is the one verb whose optimistic effect cannot be taken back,
       * so its Sent row may only ever be a statement the server has already made. `outcome` IS
       * that statement. What changes is that the statement is acted on immediately.
       *
       * ── WHY IT WAS BELOW THE DRAIN, AND WHAT THAT COST ─────────────────────────────────────
       *
       * This call used to sit after `await this.syncFresh()`, so the mechanism built to show a
       * just-sent message "in under a second" was gated behind a full reconciliation drain — and
       * that drain can never carry the message it was delaying. The only change a send records is
       * the draft moving to `sent`; the Sent MESSAGE is not recorded at send time at all, and
       * enters the feed minutes later, when the Sent folder is read back from the mail server.
       * Meanwhile the drain itself is unbounded on a mailbox mid-backfill — see
       * {@link OhmailEngine.syncFresh}, which states that a mutation landing during a cold
       * bootstrap waits for the bootstrap AND a follow-up. The symptom was a message that
       * appeared in the Ohbox about a minute after it had been sent.
       *
       * `notify` fires on its own overlay bump rather than riding the one below, because the
       * whole point is that the row is on screen before the branch underneath is entered.
       */
      if (this.materializeSentOverlay(p.mutation, outcome)) {
        this.overlayRev++;
        this.notify();
      }
      if (outcome.changes.length > 0) {
        // Read-your-writes echo (§3.4): idempotent apply — converges with the
        // delta that will arrive at the same seq.
        await this.store.applyChanges(outcome.changes);
      } else if (p.mutation.kind === "mail_send") {
        /**
         * A SEND RECONCILES IN THE BACKGROUND, and it is the one kind that may.
         *
         * Every other no-echo mutation needs the drain before it can confirm: its overlay is
         * dropped on confirm, and the settled row that has to replace it comes from that drain.
         * Wait less and the row snaps back on screen — the whole subject of
         * {@link OhmailEngine.syncFresh}.
         *
         * A send has no such row. Its overlay is a `sending` DRAFT nothing renders (`draftsList`
         * excludes fresh `sending` rows), the message the reader is waiting for is the Sent copy
         * materialised above, and the delta this drain carries is the account draft's flip to
         * `sent` — a status `draftsList` also excludes, so the flip changes no list either way.
         * Awaiting it therefore buys nothing and costs the whole latency of a drain on the one
         * gesture where the user is watching for a result: `mutate()` resolves into
         * `useMailSend`, which is what closes the compose, clears the form and returns to the
         * Ohbox. That navigation may not be hostage to a poll.
         *
         * Still ISSUED, and issued the same way — the flip has to land, and this is a drain that
         * started after the POST returned, so it carries it. Its failure is swallowed for
         * exactly the reason the awaited branch swallows its own: the write succeeded, and the
         * next poll catches the mirror up. `confirmed` remains the true statement about a
         * delivered mail — reporting anything else is the double-delivery this path exists to
         * make impossible.
         */
        void this.syncFresh().catch(() => { /* see above — the write landed */ });
      } else {
        /**
         * NO ECHO BODY — pull the authoritative delta from a drain that STARTED after this POST
         * returned. See {@link OhmailEngine.syncFresh} for why merely "a drain" is not enough.
         *
         * This is not the screener's branch, or triage's. EVERY mutation kind can reach it:
         * `triage_set`, `screener_decide`, `mark_seen`, `tag_assign`, `rule_delete` and
         * `mail_send` answer `changes: []` unconditionally, and `move`, `rule_update` and
         * `feed_mark_seen` degrade to it whenever `X-Sync-Seq` is absent or non-finite
         * (`http-adapter.ts` `noteSeq`) — a proxy that strips the header puts the whole product
         * on this path. Only `draft_accept` cannot, because the HTTP adapter refuses it outright.
         *
         * ── ITS FAILURE IS NOT THE MUTATION'S FAILURE ────────────────────────────────────────
         *
         * `adapter.mutate` RESOLVED: the server answered 2xx and committed its `change_log` row.
         * A reconciliation drain that then fails — a hidden tab (the webapp's `SyncGate` aborts
         * the next page), a blip, a second 410 — used to fall into the `catch` below, be wrapped
         * NON-retryable, and report `rolled_back` for a write that had already succeeded.
         *
         * For `mail_send` that is a delivered email reported as failed, and it does not stop at a
         * wrong label: `useMailSend.absorb` (`apps/webapp/app/shell/mail-send.ts`) releases the
         * send lock on every status except `queued` and runs `settle` on `confirmed` ONLY, so the
         * draft survives and the next press mints a NEW Idempotency-Key — a SECOND delivery of
         * the same mail, which the send path exists to make impossible. "Press Send, then
         * switch apps" is enough to reach it.
         *
         * So the drain's failure is swallowed, and that is strictly more truthful rather than
         * less: the overlay is dropped either way, so the screen is identical, and `confirmed` is
         * the true statement about a write the server took. What is NOT swallowed is a rejection
         * from `adapter.mutate` itself — the server refusing is the only thing that means the
         * mutation failed, and it still rolls back or queues in the `catch` below.
         *
         * The residual: on a failed drain the mirror has not caught up, so the row reverts on
         * screen until the next poll. That is the symptom this method exists to prevent, in the
         * one case where the network genuinely broke rather than in the ordinary case of a poll
         * being in flight.
         */
        try {
          await this.syncFresh();
        } catch { /* see above — the write landed; the mirror catches up on the next poll */ }
      }
      /**
       * `view_meta` EFFECTS OUTLIVE THE OVERLAY — written into the mirror before the overlay
       * drops, because nothing else will ever write them: `/sync` has no `view_meta` entity
       * type at all (a Cloud account can never receive such a row — `fixtures-adapter.ts`
       * documents the same fact from the other side). Without this, a waterline committed by
       * `feed_mark_seen` existed only for the milliseconds its own mutation was in flight —
       * on a live account the line evaporated on every confirm, which is why Reads' "seen up
       * to here" never held still outside the demo. `putLocal` (seq 0, outside the seq
       * guard) is the channel local-only rows already use (`message_body`); on the fixtures
       * adapter the same entity also arrived authoritatively via the echo, so this write is
       * value-identical there and idempotent.
       */
      const confirmed = this.overlays.get(p.id);
      if (confirmed) {
        for (const e of confirmed) {
          if (e.type === "view_meta") await this.store.putLocal("view_meta", e.id, e.entity);
        }
      }
      this.overlays.delete(p.id);
      // The Sent copy was materialised the instant the server confirmed, above — a rejection
      // reaches the `catch` below and never gets here, which is the "DROP on send rejection"
      // half, unchanged by moving the call up.
      // Sweep the confirm's own drain-side reconcile (a real Sent row for an EARLIER send may have
      // just landed) and any expired copies, so the map cannot accumulate across a long session.
      this.reconcileOptimisticSent();
      this.overlayRev++;
      this.notify();
      // `entityId` rides only on the CONFIRMED result. A queued or rolled-back mutation has no
      // server row to name, and handing back an id for one would be the worst kind of wrong
      // answer here — a compose surface would adopt it and go on PATCHing a draft that is not
      // there, or send it.
      return {
        id: p.id, key: p.key, status: "confirmed", seq: outcome.seq,
        ...(outcome.entityId ? { entityId: outcome.entityId } : {}),
      };
    } catch (err) {
      const rejection = err instanceof MutationRejectedError
        ? err
        : new MutationRejectedError(String(err), { retryable: false });
      if (rejection.retryable) {
        // Keep the overlay (the user's intent stands) + queue for a retry with
        // the SAME Idempotency-Key — the server dedupes a half-landed attempt.
        this.queue.push(p);
        return { id: p.id, key: p.key, status: "queued", seq: null, error: rejection };
      }
      this.overlays.delete(p.id);
      this.overlayRev++;
      this.notify();
      return { id: p.id, key: p.key, status: "rolled_back", seq: null, error: rejection };
    }
  }

  /**
   * ADD THE OPTIMISTIC SENT COPY of a confirmed send. A no-op for anything else.
   *
   * Gated on `mail_send` AND a `providerMessageId`: the id is the server's word that the message
   * left and was appended to Sent, and its absence (the FixturesAdapter, an older server) means no
   * overlay rather than a fabricated one. The copy goes into {@link overlays} under a dedicated key
   * so the {@link OverlayReader} merges it into every message read — the conversation and the Ohbox
   * see it with no change of their own — and its `messageIdHeader`/expiry are recorded in {@link
   * optimisticSent} for {@link reconcileOptimisticSent} to retire it by.
   *
   * Answers whether a copy was added, so the caller can paint immediately and only then — a
   * bare `notify()` on every mutation would wake every subscriber for the seven kinds that
   * never produce one.
   */
  private materializeSentOverlay(m: EngineMutation, outcome: MutationOutcome): boolean {
    if (m.kind !== "mail_send") return false;
    const header = outcome.providerMessageId;
    if (!header) return false;
    const sent = sentOverlayMessage(this.read(), m, header, { now: this.now, uuid: this.uuid });
    if (!sent) return false;
    const overlayId = `sent:${sent.id}`;
    this.overlays.set(overlayId, [{ type: "message", id: sent.id, entity: sent }]);
    this.optimisticSent.set(overlayId, {
      header,
      expiresAtMs: this.now().getTime() + OPTIMISTIC_SENT_TTL_MS,
    });
    return true;
  }

  /**
   * RETIRE optimistic Sent copies — by the real row arriving, or by the TTL.
   *
   * The real row is the authoritative one: once the mirror holds a message carrying the same
   * `messageIdHeader` the copy was minted under, the copy is a duplicate and is dropped, so the
   * conversation shows the ingested row alone. The TTL is the backstop for a copy whose real row
   * this session never sees. Cheap by construction — it scans the mirror only while at least one
   * copy is outstanding, which is the rare case.
   */
  private reconcileOptimisticSent(): void {
    if (this.optimisticSent.size === 0) return;
    const nowMs = this.now().getTime();
    // BOTH sides through `messageIdKey`: the confirmation carries `<id@domain>`, the ingested row
    // carries `id@domain`, and the raw compare that stood here retired copies by TTL alone — see
    // the helper's docblock in `mutations.ts`.
    const landed = new Set<string>();
    for (const { entity } of this.store.entries<EngineMessage>("message")) {
      const h = entity.messageIdHeader;
      if (h) landed.add(messageIdKey(h));
    }
    for (const [overlayId, meta] of this.optimisticSent) {
      if (landed.has(messageIdKey(meta.header)) || nowMs >= meta.expiresAtMs) {
        this.overlays.delete(overlayId);
        this.optimisticSent.delete(overlayId);
      }
    }
  }

  pendingMutations(): ReadonlyArray<{ id: string; key: string; mutation: EngineMutation }> {
    return [...this.queue];
  }

  /** Retry every queued mutation (reconnect path), preserving keys and order. */
  async flushPending(): Promise<MutationResult[]> {
    const batch = this.queue.splice(0, this.queue.length);
    const results: MutationResult[] = [];
    for (const p of batch) results.push(await this.dispatch(p));
    return results;
  }

  // ── local search ─────────────────────────────────────────────────────────

  /**
   * THE FAST PATH, and it stays the fast path.
   *
   * Synchronous, no round trip, answers from the mirror on every keystroke. It reads
   * subject, sender, the ≤200-character snippet and whatever body text this device holds —
   * `LocalSearchResult.coverage` says how much of the corpus that was, and the surface is
   * required to say so rather than let the count of hits imply completeness.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const version = this.readerView.version();
    if (!this.searchCache || this.searchCache.version !== version) {
      this.searchCache = { version, index: SearchIndex.build(this.readerView) };
    }
    return this.searchCache.index.search(query, opts);
  }

  // ── the archive pass ─────────────────────────────────────────────────────

  /**
   * Is there a server archive behind this client at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for
   * the desktop tier, whose master is the IMAP mailbox and which has no Cloud API. Both are
   * states the UI must be able to STATE, not states it should hide: "there is no archive
   * here" and "the archive has not answered yet" are different sentences.
   */
  serverSearchAvailable(): boolean {
    return this.serverSearchFn !== null;
  }

  /**
   * SEARCH THE WHOLE CORPUS — `GET /search`, the RRF-ranked hybrid that had zero callers.
   *
   * This is the SECOND answer, never the first. {@link OhmailEngine.search} has already
   * painted; this arrives after and extends it. A surface that awaited this before rendering
   * would have traded an instant local result for a round trip, which is the one thing the
   * local index exists to prevent.
   *
   * ── THE RESULT DOES NOT GO IN THE MIRROR ────────────────────────────────────────────────
   *
   * Same rule as the hydrated bodies', for a sharper reason. `/sync` owns the mirror: rows arrive at a
   * seq, deletes arrive at a seq, and `applyToRecords` reconciles by seq. A search hit has no
   * seq. Writing one in would create a row no delta can ever update or remove — a message
   * that outlives its own deletion, in a store whose whole contract is that it converges. So
   * the items are RETURNED, the caller renders them, and they are gone when the query changes.
   *
   * In practice a Cloud mirror already holds the message ROW for nearly every hit (the
   * bootstrap drains all of them); what it lacked was the body TEXT to match on. The caller
   * should therefore prefer its own mirror entity by id — that one carries the optimistic
   * overlay — and fall back to the wire item only for a row the mirror does not have.
   *
   * ── SINGLE-FLIGHT, AND WHY IT NEVER REJECTS ─────────────────────────────────────────────
   *
   * Concurrent callers for the same query join one request. And the caller is a React effect
   * behind a debounce: a rejection there is an unhandled promise over somebody's mailbox, so
   * the outcome is a VALUE — `unavailable`, `ready`, or `failed` with the server's own
   * sentence — which is a thing the UI can render. A 402 from the spend gate arrives as its
   * message, not as an error boundary.
   *
   * `GET /search` is `cost: "read"` on the server, so wiring this
   * caller changes no cost class and no line of the route-cost census. It reads rows already
   * stored for the caller's own account, writes nothing, opens no socket and calls no metered
   * third party. It is not, however, free of judgement: it is one request per settled query,
   * fired from a debounce and never per keystroke, for the same reason `hydrateBody` fires on
   * explicit intent only: a paid request needs somebody behind it.
   */
  async searchServer(query: string, opts: ServerSearchOpts = {}): Promise<ServerSearchOutcome> {
    const fn = this.serverSearchFn;
    if (fn === null) return { state: "unavailable" };
    const q = query.trim();
    if (q === "") return { state: "ready", items: [], total: 0 };

    /**
     * THE SORT IS PART OF THE KEY, and omitting it would be a defect rather than a missed
     * optimisation. Single-flight joins concurrent callers onto ONE request, so a `date_desc`
     * pass issued while a `relevance` pass for the same query is still open would be handed the
     * relevance answer and render it under the newly-chosen control. Changing the order would
     * appear to do nothing — but only inside the debounce window, which is the shape that gets
     * filed as flakiness and never reproduced.
     */
    const key = `${opts.limit ?? ""}\u0000${opts.sort ?? ""}\u0000${q}`;
    const inFlight = this.serverSearches.get(key);
    if (inFlight) return inFlight;

    const request = fn(q, opts)
      .then((wire): ServerSearchOutcome => {
        // `null` ⇒ this transport serves no archive. Same shape as `fetchBody`'s `null`, and
        // it must not become an empty `ready`: "we searched everything and found nothing" is
        // a claim, and this is the case where we searched nothing at all.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          total: typeof wire.total === "number" ? wire.total : (wire.items?.length ?? 0),
        };
      })
      .catch((err: unknown): ServerSearchOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => {
        this.serverSearches.delete(key);
      });

    this.serverSearches.set(key, request);
    return request;
  }

  // ── reading past the end of the window ───────────────────────────────────

  /**
   * Is there anything BEHIND the end of this client's lists?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network) and for the
   * desktop tier, whose master is the IMAP mailbox and which keeps the whole of it on the device.
   * Both are states a list must be able to STATE: "you have reached the end of your mail" and "you
   * have reached the end of what this device keeps" are different sentences, and only one of them
   * has a control under it.
   */
  listOlderAvailable(): boolean {
    return this.listOlderFn !== null;
  }

  /**
   * ONE PAGE OF MAIL OLDER THAN THIS DEVICE KEPT — `GET /messages?view=&cursor=`.
   *
   * The companion to {@link StorePolicy}'s `windowed` mode. A windowed client deliberately holds
   * only the newest slice of the mailbox; the rest is not lost, it is on the Cloud that still holds
   * everything. This is how a surface reaches it when somebody scrolls to the bottom of a pile —
   * a keyset page at a time, on an explicit act, never speculatively.
   *
   * ── THE RESULT DOES NOT GO IN THE MIRROR ────────────────────────────────────────────────
   *
   * Exactly {@link OhmailEngine.searchServer}'s rule, and here it is sharper still. `/sync` owns
   * the mirror: rows arrive at a seq, deletes arrive at a seq, and `applyToRecords` reconciles by
   * seq. A row from this route has NO seq. Writing one in would create a record no delta can ever
   * update or remove, in a store whose whole contract is that it converges — and it would go
   * straight back out again on the next prune pass, which is the only thing keeping the window a
   * window. So the items are RETURNED, the caller renders them below its own list, and they are
   * gone when the view changes.
   *
   * The caller should PREFER ITS OWN MIRROR ROW by id where it has one — that row carries the
   * optimistic overlay and this device's triage state, while the wire item is a snapshot from
   * before whatever the user just did.
   *
   * ── SINGLE-FLIGHT PER VIEW+CURSOR, AND WHY IT NEVER REJECTS ─────────────────────────────
   *
   * Keyed on the page being asked for, so a list that fires its "I have reached the bottom" effect
   * twice — a scroll container settling, an observer firing on a re-render — issues one request,
   * not two. And the caller is a React effect: a rejection there is an unhandled promise over
   * somebody's mailbox, so the outcome is a VALUE the UI can render. A 402 from the spend gate
   * arrives as its sentence, not as an error boundary.
   *
   * `GET /messages` is `cost: "read"` on the server, so wiring this caller changes no cost class
   * and no line of the route-cost census: it reads rows already stored for the caller's own
   * account, writes nothing, opens no socket and calls no metered third party.
   */
  async listOlder(
    view: OhmailView,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ListOlderOutcome> {
    const fn = this.listOlderFn;
    if (fn === null) return { state: "unavailable" };

    // JSON rather than a joined string: the three parts have no shared alphabet to separate them
    // with, and a hand-picked delimiter is how two different pages come to share one key. It also
    // keeps the separator out of the SOURCE. A single invisible control character here is a
    // file-wide hazard: it makes tooling classify this whole file as binary and skip it.
    const key = JSON.stringify([view, opts.cursor ?? null, opts.limit ?? null]);
    const inFlight = this.olderPages.get(key);
    if (inFlight) return inFlight;

    const request = fn(view, opts)
      .then((wire): ListOlderOutcome => {
        // `null` ⇒ this transport serves no older mail. Same shape as `fetchBody`'s and
        // `searchServer`'s `null`, and it must not become an empty `ready`: "the server answered
        // and there is nothing older" is a claim, and this is the case where nothing was asked.
        if (wire === null) return { state: "unavailable" };
        return {
          state: "ready",
          items: Array.isArray(wire.items) ? wire.items : [],
          nextCursor: typeof wire.nextCursor === "string" && wire.nextCursor !== "" ? wire.nextCursor : null,
        };
      })
      .catch((err: unknown): ListOlderOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        // The code travels with the sentence so the surface can decide whether the sentence is
        // one a person should be shown. `null` for anything that never reached a server.
        code: err instanceof MutationRejectedError ? err.code : null,
      }))
      .finally(() => {
        this.olderPages.delete(key);
      });

    this.olderPages.set(key, request);
    return request;
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Can this client open attachments at all?
   *
   * `false` for the demo (`?demo=1` is fixtures and zero network), where the
   * paperclip must not offer a control that cannot work. Resolved from the adapter's own optional
   * capability, so it cannot disagree with what the methods below will do.
   */
  attachmentsAvailable(): boolean {
    return typeof this.adapter.listAttachments === "function"
      && typeof this.adapter.fetchAttachment === "function";
  }

  /**
   * What the surface renders RIGHT NOW for one message. Synchronous, no side effects.
   *
   * Separate from {@link OhmailEngine.loadAttachments} on purpose: React renders far more often
   * than it should fetch, so the render path reads state and the effect path asks for it. A method
   * that fetched on read would issue a request per render, billed with nobody behind it.
   *
   * ── `includeInlineImages` — THE PICTURES, FOR A SURFACE THAT DRAWS NONE ──────────────────
   *
   * The default answer is FILES ONLY, which is what every caller has always got and what both
   * `GET /files` and the server's `download-all` mean by "attachment". A `cid:` logo listed beside
   * a real invoice, in a rendering that already paints that logo, is the same picture named twice.
   *
   * The exception is the rendering that paints NO pictures. Mail that declares no layout canvas is
   * drawn in the app's own typography over the message's TEXT part — deliberately, and the sender's
   * own rendering is one press away — and on that path an inline image is drawn nowhere at all. It
   * was in the message, the reader cannot see it, and before this flag there was no surface in the
   * product that could reach it. A caller that knows it is drawing the frameless rendering asks for
   * them and gets them as ordinary items: same fetch, same size ceiling, same preview gate, same
   * download. The flag widens WHAT IS LISTED and nothing else.
   *
   * Filtering here rather than at ingest is what keeps the two answers available at once: the pane
   * asks one way while its own "Download all" asks the same way, and every other caller is
   * untouched by a message being drawn one way rather than the other.
   */
  attachmentsOf(messageId: string, opts: { includeInlineImages?: boolean } = {}): AttachmentsOutcome {
    if (!this.attachmentsAvailable()) return { state: "unavailable" };
    const held = this.attachmentLists.get(messageId) ?? { state: "loading" as const };
    if (held.state !== "ready") return held;
    const shown = held.items.filter(
      (item) => !item.inline || (opts.includeInlineImages === true && isPictureItem(item)),
    );
    // Identity preserved when nothing is withheld — the common case is a message with no inline
    // parts at all, and a fresh object per render for it would be churn with no reader.
    return shown.length === held.items.length ? held : { state: "ready", items: shown };
  }

  /**
   * The FETCHED BYTES of one ready attachment — the type-downgraded Blob the object URL was
   * minted from — or `undefined` when it has not been fetched yet.
   *
   * A preview surface reads this to parse a PDF (`blob.arrayBuffer()`) or a text part
   * (`blob.text()`) WITHOUT re-fetching the object URL. See {@link AttachmentItem.blob} for why
   * a re-fetch is not an option and why this is the post-downgrade blob, not the wire one.
   */
  attachmentBlobOf(messageId: string, attachmentId: string): Blob | undefined {
    return this.itemOf(messageId, attachmentId)?.blob;
  }

  /**
   * Read one message's attachment METADATA — filenames, types, sizes. No bytes, no IMAP.
   *
   * `cost: "read"` on the route: this is an indexed row read against the caller's own account and
   * nothing here reaches the mail server, which is what makes it acceptable to call when a message
   * is opened. The bytes are a separate, deliberate act.
   *
   * ## INLINE PARTS ARE KEPT HERE AND WITHHELD AT THE READ
   *
   * `inline` parts are `cid:` images the HTML body already references — a newsletter's logo, a
   * signature graphic. They are not files a person means when they say "attachment", and the server
   * agrees: both `GET /files` and per-message `download-all` exclude them.
   *
   * They used to be dropped in this method, on that argument, and the argument is right about what
   * a FILE is and wrong about what a picture is. It is only true that an inline image is already
   * on screen while the message is drawn from its html; the app's own frameless rendering draws no
   * images at all, and against that rendering the drop made a picture the sender sent unreachable
   * from anywhere in the product. So the list keeps every part and {@link OhmailEngine.attachmentsOf}
   * decides — files only by default, pictures too for a caller that says it is drawing none.
   *
   * The paperclip agrees with this list now: `hasAttachments` is derived from REAL FILES at
   * ingest (`mime.ts` — `isRealFile`, with cid-referenced parts classified inline wherever they
   * sit in the MIME tree), and the flag backfill corrected the rows written under the old
   * all-parts rule. What remains possible is a row ingested before the cid-reference signal
   * existed whose signature logo sits under `multipart/mixed` — that one still counts as a file
   * until re-ingested or backfilled, which is a fact about stored rows, not about this method.
   *
   * WHAT THIS METHOD ANSWERS IS STILL FILES, whatever the record holds. Every return below goes
   * through {@link OhmailEngine.attachmentsOf} with no options, so an awaiting caller gets exactly
   * the list it got before — the widened one is something a surface has to ASK for, and a caller
   * that did not ask cannot be handed a strip that grew rows it never accounted for.
   *
   * Never rejects: single-flight per message, and the failure is a value the UI can render.
   */
  async loadAttachments(messageId: string, opts: { retry?: boolean } = {}): Promise<AttachmentsOutcome> {
    const list = this.adapter.listAttachments;
    if (!list || !this.attachmentsAvailable()) return { state: "unavailable" };

    const inFlight = this.attachmentListRequests.get(messageId);
    if (inFlight) return inFlight.then(() => this.attachmentsOf(messageId));

    const held = this.attachmentLists.get(messageId);
    // Already answered. Re-reading would discard the per-item byte state (`ready` object URLs and
    // all) for a list that cannot have changed — attachments are immutable parts of a stored message.
    if (held && held.state === "ready") return this.attachmentsOf(messageId);
    // See `hydrateBody`'s `retry` note: an automatic trigger must not re-ask a server that refused,
    // or a React effect whose identity changes per render loops against it for as long as the view
    // is open. A human pressing Retry passes `retry`.
    if (held && held.state === "failed" && !opts.retry) return held;

    // `retrying` marks a HUMAN re-ask over a failure, and nothing else: the first ask of a
    // message must stay `{ state: "loading" }` with the field absent, because that is the state
    // the surface renders as silence.
    const retrying = opts.retry === true && held?.state === "failed";
    this.attachmentLists.set(messageId, retrying ? { state: "loading", retrying: true } : { state: "loading" });
    this.notify();

    const request = list.call(this.adapter, messageId)
      .then((wire): AttachmentsOutcome => {
        return { state: "ready", items: wire.map(toAttachmentItem) };
      })
      // The adapter's own classification, kept. `MutationRejectedError` is the one thing
      // `HttpAdapter` throws, and it throws it for THREE reasons: a non-2xx (`rejectionOf`: the
      // server's code, and `retryable` defaulted from the status), a fetch that rejected outright
      // (`code: "network"`), and — since the read was given a deadline — a request that answered
      // nothing at all inside
      // `ATTACHMENT_LIST_TIMEOUT_MS` (`code: "timeout"`, `retryable: true`, raised by
      // `HttpAdapter.withDeadline`, which aborts the request as it throws). That third one is why
      // this catch exists at all now: before it, a hung read never reached here, the outcome stayed
      // `loading`, and the surface drew nothing for ever.
      // Anything else reaching here is unclassified, and unclassified means we never established
      // that the server refused, so asking again is honest. See {@link AttachmentsOutcome}.
      .catch((err: unknown): AttachmentsOutcome => ({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof MutationRejectedError ? err.code : null,
        retryable: err instanceof MutationRejectedError ? err.retryable : true,
      }))
      .then((outcome) => {
        this.attachmentLists.set(messageId, outcome);
        this.notify();
        return outcome;
      })
      .finally(() => {
        this.attachmentListRequests.delete(messageId);
      });

    this.attachmentListRequests.set(messageId, request);
    // The RECORD keeps every part (`request` resolves to it); what this returns is the files view.
    return request.then(() => this.attachmentsOf(messageId));
  }

  /**
   * FETCH ONE ATTACHMENT'S BYTES from the user's IMAP mailbox and mint a Blob URL for it.
   *
   * `cost: "connection"` — this opens a real IMAP connection to somebody's mail server, which is
   * the most expensive read in the product. So it fires on an explicit human act only: a click on
   * that file. Never on render, never on selection, never speculatively for a strip.
   *
   * Never rejects (the caller is a click handler). The outcome is the item's `state`:
   *
   *   · `too_large` — the server refused at its size ceiling (`payload_too_large`). A distinct
   *     state, not a failure, because the answer is permanent and a Retry button would be a lie.
   *   · `failed`    — anything else, carrying the server's own sentence.
   *
   * Single-flight per attachment id: a double-click is one fetch, not two IMAP connections.
   */
  async openAttachment(messageId: string, attachmentId: string, opts: { retry?: boolean } = {}): Promise<void> {
    const fetchOne = this.adapter.fetchAttachment;
    if (!fetchOne) return;

    const inFlight = this.attachmentRequests.get(attachmentId);
    if (inFlight) return inFlight;

    const current = this.itemOf(messageId, attachmentId);
    if (!current) return;
    // Already fetched, and the URL is still live — the bytes are in the tab, nothing to ask for.
    if (current.state === "ready" && current.objectUrl) return;
    // A refusal at the ceiling cannot become a success by asking again.
    if (current.state === "too_large") return;
    if (current.state === "failed" && !opts.retry) return;

    this.patchAttachment(messageId, attachmentId, { state: "loading", error: undefined });

    const request = fetchOne.call(this.adapter, attachmentId)
      .then((blob) => {
        // REVOKE BEFORE RE-MINTING. A retry over a `failed` item that had somehow minted a URL,
        // or any second pass, would otherwise leak the old one for the life of the document.
        this.revokeItem(messageId, attachmentId);
        const minted = this.mintObjectUrl(blob, current.mimeType);
        // The URL and the typed Blob are stored together: a preview parses the Blob (no
        // `fetch(blob:)`, which `connect-src 'self'` refuses on the live host), the strip and
        // `<a download>` use the URL, and both are dropped by `releaseAttachments` at once.
        this.patchAttachment(messageId, attachmentId, {
          state: "ready",
          ...(minted ? { objectUrl: minted.url, blob: minted.blob } : {}),
        });
      })
      .catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        const message = err instanceof Error ? err.message : String(err);
        this.patchAttachment(messageId, attachmentId, {
          state: code === "payload_too_large" ? "too_large" : "failed",
          error: message,
        });
      })
      .finally(() => {
        this.attachmentRequests.delete(attachmentId);
      });

    this.attachmentRequests.set(attachmentId, request);
    return request;
  }

  /**
   * FETCH EVERY non-inline attachment on a message as ONE zip, assembled server-side.
   *
   * One request and one IMAP connection for the whole set, which is why this is not a loop over
   * {@link OhmailEngine.openAttachment} — N files would otherwise mean N logins to the user's mail
   * server, and providers throttle exactly that pattern.
   *
   * Returns the Blob for the caller to save (`<a download>`), or `null` when this client has no
   * server or the archive could not be built.
   *
   * ## THE FAILURE IS THE CALLER'S TO REPORT, AND THE LIST IS LEFT ALONE
   *
   * An earlier shape wrote `{state: "failed"}` over the message's list here. That was wrong twice:
   * the metadata is still perfectly good — only the archive request failed — so replacing the list
   * would blank a strip the user is looking at, discarding every `ready` object URL in it; and at
   * the time the strip had no per-list error surface at all, so the state was overwritten and
   * restored in the same tick and no render could ever observe it. A state nothing can render is
   * not error handling.
   *
   * THE SECOND HALF OF THAT IS NO LONGER TRUE — the strip has a list state now, and `failed`
   * reaches it. The FIRST half is why this still must not use it: a failed zip says nothing
   * about the metadata, and a list-level failure row here would claim the files are unknown when
   * they are on screen.
   *
   * So the signal is the return value and the caller says so — a toast, next to the button that
   * was pressed.
   *
   * The zip may legitimately be missing files: the server skips a part it cannot fetch and names it
   * in `_errors.txt` inside the archive. A non-null answer is therefore NOT a promise that every
   * file is present.
   */
  async downloadAllAttachments(messageId: string): Promise<Blob | null> {
    const fetchAll = this.adapter.fetchAllAttachments;
    if (!fetchAll) return null;
    try {
      return await fetchAll.call(this.adapter, messageId);
    } catch {
      return null;
    }
  }

  /**
   * The embedded images already minted for one message: `contentId → data: URI`, the map a
   * renderer resolves the html body's `cid:` references against. Synchronous, no side effects —
   * the render path reads, {@link OhmailEngine.loadInlineImages} is what asks.
   *
   * The identity is stable between mints and changes exactly when an image arrives, so it is
   * safe to use as a memo dependency around an expensive sanitize pass.
   */
  inlineImagesOf(messageId: string): ReadonlyMap<string, string> {
    return this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES;
  }

  /**
   * FETCH THE EMBEDDED IMAGES a message's html actually references, and mint each as a
   * `data:` URI for the mail frame. `contentIds` comes from the renderer's own pass over the
   * sanitized document — the parts the reader is looking at blanked boxes for, in document
   * order — and parts nothing references are never fetched.
   *
   * ── WHAT THIS SPENDS, AND WHY OPENING A MESSAGE MAY SPEND IT ─────────────────────────────
   *
   * One `cost: "connection"` fetch per part, through {@link OhmailEngine.openAttachment} —
   * the same call a press on the strip makes, single-flight and never re-asked after a refusal.
   * `openAttachment`'s own rule is "an explicit human act only", and this is that rule's second
   * legitimate act: the reader OPENED this message, the document in front of them names these
   * parts, and a signature logo rendered as a grey box in every mail from a colleague is the
   * defect, not thrift. What keeps it bounded where a press is bounded by the pressing:
   *
   *   · only parts the html references, by `Content-ID` — never "everything on the message";
   *   · only declared raster images within {@link INLINE_IMAGE_MAX_BYTES}, at most
   *     {@link INLINE_IMAGE_MAX_PARTS} parts / {@link INLINE_IMAGE_MAX_TOTAL_BYTES} declared
   *     bytes per message ({@link INLINE_IMAGE_MIME} has the second, post-fetch gate);
   *   · SEQUENTIALLY, so the user's mail server sees one conversation at a time;
   *   · a part that failed stays failed — `openAttachment` refuses the automatic re-ask, so a
   *     re-render cannot loop a connection-cost fetch against a server that refused.
   *
   * Never rejects; the caller is a render effect. Single-flight per message: the pane is
   * mounted twice while the reader is open, and both mounts ask for the same document.
   */
  async loadInlineImages(messageId: string, contentIds: readonly string[]): Promise<void> {
    if (!this.attachmentsAvailable() || contentIds.length === 0) return;

    const inFlight = this.inlineImageRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchInlineImages(messageId, contentIds)
      .catch(() => {})
      .finally(() => {
        this.inlineImageRequests.delete(messageId);
      });
    this.inlineImageRequests.set(messageId, request);
    return request;
  }

  /** The working half of {@link OhmailEngine.loadInlineImages}, behind its single-flight gate. */
  private async fetchInlineImages(messageId: string, contentIds: readonly string[]): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.inlineImages.get(messageId);
    const wanted: AttachmentItem[] = [];
    const seen = new Set<string>();
    let budget = INLINE_IMAGE_MAX_TOTAL_BYTES;
    // Reference order — the order the reader meets the images — so the budget is spent on what
    // is nearest the top of the document, not on whatever sorts first.
    for (const cid of contentIds) {
      if (wanted.length >= INLINE_IMAGE_MAX_PARTS) break;
      if (seen.has(cid) || have?.has(cid)) continue;
      seen.add(cid);
      const item = held.items.find((i) => i.contentId === cid);
      if (!item) continue;
      // The declared-type/size gate: don't pay a connection for a part the mint below would
      // refuse anyway. The declaration is the sender's claim; the REAL gates are post-fetch.
      if (!INLINE_IMAGE_MIME.has(item.mimeType.toLowerCase())) continue;
      if (item.sizeBytes > INLINE_IMAGE_MAX_BYTES || item.sizeBytes > budget) continue;
      budget -= item.sizeBytes;
      wanted.push(item);
    }

    const minted: Array<[string, string]> = [];
    for (const item of wanted) {
      await this.openAttachment(messageId, item.id);
      const blob = this.attachmentBlobOf(messageId, item.id);
      if (!blob) continue;
      const url = await mintInlineDataUrl(blob);
      if (url) minted.push([item.contentId!, url]);
    }
    if (minted.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.inlineImages.get(messageId) ?? NO_INLINE_IMAGES);
    for (const [cid, url] of minted) next.set(cid, url);
    // ONE replacement and ONE notification for the whole pass, not one per image: every map
    // identity change re-sanitizes and re-measures the mail document downstream.
    this.inlineImages.set(messageId, next);
    this.notify();
  }

  /**
   * The decoded text of a message's calendar parts already in hand: `attachmentId → ics text`,
   * what an event-preview surface parses ({@link import("@trafficflow/core/ics").parseIcsEvent})
   * and renders. Synchronous, no side effects — the render path reads,
   * {@link OhmailEngine.loadCalendarTexts} is what asks. Identity-stable between fills, so a
   * memoized parse can key on the map.
   */
  calendarTextsOf(messageId: string): ReadonlyMap<string, string> {
    return this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS;
  }

  /**
   * FETCH THE CALENDAR PARTS a message carries and hold their decoded text for the event
   * preview. The third legitimate automatic act on the `cost: "connection"` path, and it stands
   * on {@link OhmailEngine.loadInlineImages}'s argument verbatim: the reader OPENED this message,
   * a meeting invitation drawn as an opaque tile named `invite.ics` is the defect rather than
   * thrift, and what keeps an automatic trigger bounded where a press is bounded by the pressing:
   *
   *   · only parts DECLARED as calendar data ({@link isCalendarItem}) within
   *     {@link CALENDAR_TEXT_MAX_BYTES}, at most {@link CALENDAR_TEXT_MAX_PARTS} per message —
   *     real meeting mail carries exactly one, 1–4 KB;
   *   · the real byte count is re-checked post-fetch — the declaration is the sender's claim;
   *   · SEQUENTIALLY, through {@link OhmailEngine.openAttachment} — single-flight per part, and
   *     a part that failed stays failed (no automatic re-ask against a server that refused);
   *   · the bytes were being fetched for the tile anyway on the first press — this pass just
   *     spends them on a card the reader can read instead of a name they can only save.
   *
   * Never rejects; the caller is a render effect. Single-flight per message (the pane is
   * mounted twice while the reader is open, and both mounts ask).
   */
  async loadCalendarTexts(messageId: string): Promise<void> {
    if (!this.attachmentsAvailable()) return;

    const inFlight = this.calendarTextRequests.get(messageId);
    if (inFlight) return inFlight;

    const request = this.fetchCalendarTexts(messageId)
      .catch(() => {})
      .finally(() => {
        this.calendarTextRequests.delete(messageId);
      });
    this.calendarTextRequests.set(messageId, request);
    return request;
  }

  /** The working half of {@link OhmailEngine.loadCalendarTexts}, behind its single-flight gate. */
  private async fetchCalendarTexts(messageId: string): Promise<void> {
    await this.loadAttachments(messageId);
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;

    const have = this.calendarTexts.get(messageId);
    const wanted = held.items
      .filter((i) => isCalendarItem(i) && !have?.has(i.id) && i.sizeBytes <= CALENDAR_TEXT_MAX_BYTES)
      .slice(0, CALENDAR_TEXT_MAX_PARTS);
    if (wanted.length === 0) return;

    const decoded: Array<[string, string]> = [];
    for (const item of wanted) {
      await this.openAttachment(messageId, item.id);
      const blob = this.attachmentBlobOf(messageId, item.id);
      // The REAL byte gate — `sizeBytes` above was only the sender's claim.
      if (!blob || blob.size === 0 || blob.size > CALENDAR_TEXT_MAX_BYTES) continue;
      try {
        decoded.push([item.id, await blob.text()]);
      } catch {
        // Undecodable bytes: the tile stands, the card simply never appears.
      }
    }
    if (decoded.length === 0) return;

    // Re-checked AFTER the awaits: a message released mid-pass (the reader moved on) must not
    // have its map re-created to outlive the byte state it belongs with.
    if (this.attachmentLists.get(messageId)?.state !== "ready") return;
    const next = new Map(this.calendarTexts.get(messageId) ?? NO_CALENDAR_TEXTS);
    for (const [id, text] of decoded) next.set(id, text);
    // ONE replacement and ONE notification for the whole pass — a map identity change re-parses
    // and re-renders the card downstream.
    this.calendarTexts.set(messageId, next);
    this.notify();
  }

  /**
   * Revoke every object URL held for a message and forget its byte state.
   *
   * MUST be called when the surface stops rendering the message (a pane unmount, a different
   * message selected). A `blob:` URL pins its bytes in memory until it is revoked or the document
   * dies, so a session spent opening PDFs in a long-lived tab would otherwise accumulate every one
   * of them — the exact cost the "nothing is stored" design exists to avoid, reintroduced in the
   * browser instead of the database. The minted `data:` URIs go with it — they pin the same bytes
   * as base64 in a string instead of behind a URL. The calendar texts too: they are decodings of
   * the same released bytes.
   */
  releaseAttachments(messageId: string): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state === "ready") {
      for (const item of held.items) this.revokeUrl(item.objectUrl);
    }
    this.attachmentLists.delete(messageId);
    this.inlineImages.delete(messageId);
    this.calendarTexts.delete(messageId);
    this.notify();
  }

  /** Revoke everything, for a teardown that is losing the whole engine. */
  releaseAllAttachments(): void {
    for (const messageId of [...this.attachmentLists.keys()]) this.releaseAttachments(messageId);
  }

  private itemOf(messageId: string, attachmentId: string): AttachmentItem | undefined {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return undefined;
    return held.items.find((i) => i.id === attachmentId);
  }

  /** Replace one item in a message's list and re-render. */
  private patchAttachment(messageId: string, attachmentId: string, patch: Partial<AttachmentItem>): void {
    const held = this.attachmentLists.get(messageId);
    if (held?.state !== "ready") return;
    this.attachmentLists.set(messageId, {
      state: "ready",
      items: held.items.map((i) => (i.id === attachmentId ? { ...i, ...patch } : i)),
    });
    this.notify();
  }

  private revokeItem(messageId: string, attachmentId: string): void {
    this.revokeUrl(this.itemOf(messageId, attachmentId)?.objectUrl);
  }

  private revokeUrl(url: string | undefined): void {
    if (!url) return;
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    U?.revokeObjectURL?.(url);
  }

  /**
   * Mint a Blob URL, DOWNGRADING the content type of anything a browser would render as a document.
   *
   * See {@link RENDERABLE_MIME}. The re-typing happens at construction because that is the only
   * point that governs every consumer: a call site can forget to check a type, and the two the
   * server sets (`Content-Disposition`, `nosniff`) describe the RESPONSE and do not survive into a
   * Blob made from its body.
   *
   * Returns `undefined` where there is no `URL.createObjectURL` — SSR and the node test
   * environment — so a `ready` item there simply carries no URL rather than throwing inside a
   * render.
   *
   * It returns the typed Blob ALONGSIDE the URL, not just the URL, so the two cannot diverge:
   * the bytes a preview parses are byte-for-byte the ones the browser would render or save, at
   * the same downgraded type. Minting and retention are one act for exactly that reason.
   */
  private mintObjectUrl(blob: Blob, declaredMime: string): { url: string; blob: Blob } | undefined {
    const U = (globalThis as {
      URL?: { createObjectURL?: (b: Blob) => string };
    }).URL;
    if (typeof U?.createObjectURL !== "function") return undefined;
    const safeType = RENDERABLE_MIME.has(declaredMime.toLowerCase()) ? declaredMime : "application/octet-stream";
    const typed = blob.type === safeType ? blob : new Blob([blob], { type: safeType });
    return { url: U.createObjectURL(typed), blob: typed };
  }
}
