/**
 * @ohmail/client-engine — the delta-first client spine (brief §4), shared by the
 * web app now and mirrored by the native SwiftData port later:
 *
 *   MirrorStore  — IndexedDB (web) / in-memory (SSR, tests) local mirror with
 *                  the idempotent, seq-guarded apply the backend tests prove;
 *   Adapters     — FixturesAdapter (?demo + UI tests) and HttpAdapter (the real
 *                  /sync + mutation protocol) behind ONE interface;
 *   OhmailEngine — bootstrap → drain → apply, optimistic mutation queue
 *                  (user-always-wins), wake-signal hook, instant local search.
 */
export const ENGINE_VERSION = "0.1.0";

/**
 * The nameless-attachment naming pair, re-exported from core so every client names a
 * nameless calendar part the same way (`toAttachmentItem` here already does; the mobile
 * app's fixture tiles need the same rule and reach core only through this package).
 */
export { CALENDAR_FALLBACK_FILENAME, isCalendarMime } from "@trafficflow/core/ics";

/**
 * The folder-name validator, re-exported from core's browser-safe leaf (the `/ics` rule above):
 * the honest sentence BEFORE the wire is the SERVER's own rules, and every client that offers
 * the stage-2 folder verbs needs them — the webapp reaches core directly, the mobile app
 * reaches core only through this package.
 */
export {
  FOLDER_PATH_MAX,
  RESERVED_FOLDER_LEAF,
  folderNameError,
  type FolderNameError,
} from "@trafficflow/core/folder-name";

/**
 * The outgoing message's signature block — state model + serialization, shared by every
 * compose surface on every client (the webapp shell re-exports it; the mobile sheet imports
 * it through its live seam). See `signature.ts` for the whole contract.
 */
export {
  SIG_FOLLOWING,
  effectiveSignature,
  signatureHtml,
  withSignature,
  type SignatureState,
} from "./signature.js";

// Wire vocabulary + errors.
export {
  CursorExpiredError,
  MutationRejectedError,
  UnsupportedMutationError,
  FOLDER_OF_VIEW,
  VIEW_OF_FOLDER,
  folderLeaf,
  isProtectedMessage,
  encodeSeqCursor,
  decodeSeqCursor,
  type ChangeOp,
  type ComposeAttachment,
  type Cursor,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMessageExtras,
  type EngineMutation,
  // The runtime census of the union above — what lets the verb-parity harness enumerate
  // every user verb and refuse a new one until its parity is proven (see types.ts).
  MUTATION_KINDS,
  type MutationKind,
  type Folder,
  type ISODateTime,
  type OhmailView,
  type ScreenDest,
  type BodyState,
  type MessageBody,
  // The closed set behind `MessageBody.withheld` — exported because the surface owes each
  // member its own sentence (the reading pane's per-marker copy), and a surface that cannot
  // name the type re-derives it as string literals that drift.
  type WithheldMarker,
  type MessageBodyRecord,
  type MessageBodyBatchWire,
  type MessageBodyWire,
  type MessageStateDTO,
  type MirrorEntityType,
  type RuleDTO,
  type ScreenerHeldMail,
  type ScreenerSegment,
  type ScreenerSenderDTO,
  type SensitivityFlags,
  type SyncChange,
  type SyncEntityType,
  type SyncResponse,
  type SyncSnapshotPage,
  type FolderEntity,
  type TagDTO,
  type TriageItemDTO,
  type TriageState,
  type TriageWireState,
  type UnsubscribeHeaderState,
  type UnsubscribeRefusal,
  type UnsubscribeResult,
  type WaterlineMeta,
  type FeedView,
  waterlineIdOf,
} from "./types.js";

// Consent, the dormancy cutline, and History — presentation by who wrote, not by where it sits.
export {
  DEFAULT_DORMANCY_DAYS,
  consentIndex,
  consentPartition,
  cutlineFor,
  decidedDestination,
  domainOfAddress,
  historyView,
  physicalFolderOf,
  presentationReader,
  senderActivity,
  type ConsentCounts,
  type ConsentIndex,
  type ConsentOptions,
  type ConsentPartition,
  type SenderActivity,
} from "./consent-cutline.js";

// The Content Door's on-demand arm — the one session-body pattern (mechanics + the stored-body
// wire vocabulary) every surface binds instead of re-deriving; see the module header.
export {
  createSessionBodyDoor, narrowOlderBody, olderBodyVia,
  type OlderBodyOutcome, type OlderBodyWire,
  type SessionBodyDoor, type SessionBodyDoorOptions, type SessionBodyHeld,
} from "./session-body.js";

// Apply core (the convergence oracle) + stores.
export { applyToRecords, flattenResponse, maxSeqOf, recordKey, type MirrorRecord } from "./apply.js";
export {
  BaseMirrorStore, MemoryMirrorStore, MirrorGenerationChanged,
  type EntityReader, type MirrorStore,
} from "./store.js";
export {
  IndexedDbMirrorStore,
  LEGACY_MIRROR_DB,
  MIRROR_DB_PREFIX,
  clearAllMirrors,
  mirrorDbName,
  purgeLegacyMirror,
  type IndexedDbMirrorStoreOptions,
} from "./idb.js";
// The React Native arm of the mirror: same layout and ownership discipline as idb.ts, over an
// INJECTED SQL executor (expo-sqlite in the app, node:sqlite in tests) — no Node built-in, no
// browser global, so the module is inert everywhere the executor is not injected.
export {
  SqlMirrorStore,
  type SqlExecutor,
  type SqlMirrorStoreOptions,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "./sql-store.js";

// An instant as a wall clock in the reader's zone, and back. The one place that arithmetic lives —
// `selectors.ts` bands stamps with it and `apps/webapp/app/shell/format.ts` mints its resurface
// horizons with it, rather than each keeping a copy that drifts on a DST edge.
export {
  zonedDayNumber,
  zonedFields,
  zonedInstant,
  zonedWeekday,
  type ZonedFields,
  type ZonedWallClock,
} from "./zone.js";

// Selectors.
export {
  bodyOf,
  isOwnSent,
  isResurfaced,
  messageDisplayTime,
  messagesIn,
  ohboxView,
  // The pile derivation, exported so a guard can assert DISJOINTNESS over it directly rather
  // than inferring it from two lists that happen to agree on one fixture — see
  // `pileOfState`, which both `triagePiles` and `parkedMessageIds` read.
  parkedMessageIds,
  pileOfState,
  winningStates,
  feedPartition,
  readsPartition,
  receiptsByDay,
  draftsList,
  scheduledSendsList,
  SENDING_STALE_AFTER_MS,
  rulesList,
  screenerSegments,
  senderKey,
  sendingMailboxId,
  triagePiles,
  tagsCrossView,
  threadOf,
  threadParticipants,
  threadParticipantsIndex,
  threadSubject,
  THREAD_PARTICIPANTS_MAX,
  unreadCounts,
  type EngineCounts,
  type OhboxView,
  type FeedPartition,
  type ReceiptsDayGroup,
  type ScreenerSegments,
  type TagGroup,
  type TriagePileEntry,
  type TriagePiles,
} from "./selectors.js";

// The address book — every correspondent the mirror knows, for the compose field.
export {
  addressBook,
  formatRecipient,
  isRobotAddress,
  matchAddresses,
  rankOf,
  type AddressBookEntry,
} from "./address-book.js";

// Search.
export { SearchIndex, type LocalSearchResult, type SearchFacets, type SearchHit, type SearchMatch } from "./search.js";

// Mutation semantics (shared optimistic/demo source of truth).
export {
  decideFolder,
  forwardSubject,
  mutationEffects,
  replySubject,
  sentOverlayMessage,
  type EffectContext,
  type MutationEffect,
} from "./mutations.js";

// Adapters.
export type { EngineAdapter, MutationOutcome, SyncParams } from "./adapters/adapter.js";
export { DEMO_NOW, FixturesAdapter, parseFixtureTime, type FixturesAdapterOptions } from "./adapters/fixtures-adapter.js";
export {
  HttpAdapter,
  // The deadline a body fetch runs under. Exported so a SURFACE that says "still coming" can
  // bound that sentence by the engine's own number instead of guessing one: a spinner is only
  // honest for as long as a request can still be in the air, and this is how long that is.
  BODY_FETCH_TIMEOUT_MS,
  // The client↔server view vocabularies and the single table that joins them. Exported so the
  // translation can be checked against the server's own list rather than only through a request.
  SERVER_VIEW_OF,
  // The ceiling the INLINE send transport can carry. Exported because the compose form needs the
  // same number for a different job — it states a promise, this decides a transport — and the
  // parity suite pins both to the send service's constant.
  SEND_INLINE_MAX_TOTAL_BYTES,
  type FetchLike,
  type HttpAdapterOptions,
  type ServerMessageView,
} from "./adapters/http-adapter.js";

// The engine.
export {
  OhmailEngine,
  // The id-list cap the batch body read is split on. Exported for the same reason
  // `RENDERED_PINS` is: a guard that hand-copies a policy number goes green against a shipped
  // value it has never seen.
  BODIES_IDS_MAX,
  // How many on-screen messages the windowed prune holds. Exported so the guard reads the
  // shipped number rather than a hand-copied one — see `RENDERED_PINS` in engine.ts.
  RENDERED_PINS,
  // The stale-resume seam: the staleness threshold and the meta key the drain stamps. Exported
  // for the same reason the two above are — the guards must read the shipped values, not copies.
  STALE_RESUME_MS,
  BACKLOG_PAGE_LIMIT,
  LAST_DRAIN_AT_META,
  SNAPSHOT_PREFIX_SEQ_META,
  // The Freshness Contract's three states and the engine's one derivation of them — surfaces
  // render `engine.freshness()`, never a re-derivation from meta (INSTANT-ARCH §6.6).
  type FreshnessState,
  type MirrorFreshness,
  // The durable outbox's client-local record type. Exported so the kill-restart guards (and
  // any storage tooling) read the shipped name rather than a hand-copied string.
  OUTBOX_TYPE,
  // The boot replay's per-attempt deadline and the unkeyed-create replay horizon — exported so
  // the guards read the shipped numbers, not copies.
  OUTBOX_REPLAY_DEADLINE_MS,
  OUTBOX_UNKEYED_CREATE_TTL_MS,
  // The eager recent-window hydration bounds. Exported so the guards read the shipped numbers.
  EAGER_BODIES_MAX,
  EAGER_BODIES_SLICE,
  // How long an optimistic Sent copy (and its seeded attachment list) stands before the TTL
  // sweep. Exported so the seed-lifecycle guards read the shipped number, not a copy.
  OPTIMISTIC_SENT_TTL_MS,
  // A forward copy's inherited-parts ceiling — the send service's own bound, mirrored. Exported
  // for the same reason.
  SENT_FORWARD_MAX_PARTS,
  type EngineOptions,
  type MutationResult,
  type MutationStatus,
  // The two structural capabilities an adapter WRAPPER has to forward by hand. Exported so a
  // wrapper can name the types rather than re-derive them — see `SnapshotCapableAdapter` and
  // `ListMessagesCapableAdapter` in engine.ts.
  type ListOlderFn,
  type ListOlderOutcome,
  type ListOlderWire,
  type FetchBodiesFn,
  type ServerSearchOutcome,
  SERVER_SEARCH_SORTS,
  type ServerSearchSort,
  type ServerSearchOpts,
  type SnapshotFn,
  type StorePolicy,
  type WakeSignalSource,
} from "./engine.js";
