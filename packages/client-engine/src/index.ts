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
  type Folder,
  type ISODateTime,
  type OhmailView,
  type ScreenDest,
  type BodyState,
  type MessageBody,
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
  type TagDTO,
  type TriageItemDTO,
  type TriageState,
  type UnsubscribeHeaderState,
  type UnsubscribeRefusal,
  type UnsubscribeResult,
  type WaterlineMeta,
} from "./types.js";

// Consent, the dormancy cutline, and History — presentation by who wrote, not by where it sits.
export {
  DEFAULT_DORMANCY_DAYS,
  consentIndex,
  consentPartition,
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

// Apply core (the convergence oracle) + stores.
export { applyToRecords, flattenResponse, maxSeqOf, recordKey, type MirrorRecord } from "./apply.js";
export { BaseMirrorStore, MemoryMirrorStore, type EntityReader, type MirrorStore } from "./store.js";
export {
  IndexedDbMirrorStore,
  LEGACY_MIRROR_DB,
  MIRROR_DB_PREFIX,
  clearAllMirrors,
  mirrorDbName,
  purgeLegacyMirror,
  type IndexedDbMirrorStoreOptions,
} from "./idb.js";

// Selectors.
export {
  bodyOf,
  isOwnSent,
  isResurfaced,
  messageDisplayTime,
  messagesIn,
  ohboxView,
  readsPartition,
  receiptsByDay,
  draftsList,
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
  type ReadsPartition,
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
  LAST_DRAIN_AT_META,
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
  type SnapshotFn,
  type StorePolicy,
  type WakeSignalSource,
} from "./engine.js";
