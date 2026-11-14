/**
 * No write, no wire: a verb whose durable record this device could not
 * write does not go to the server, in exactly two cases. A SEND — its
 * Idempotency-Key is the only thing between a retry and a second copy, and
 * the key lives in the row that just failed. And a verb that REPLACES
 * queued ones — the refused transaction retired nothing, so the older verbs
 * are still the disk's truth and a kill would replay them over the newer
 * intent. Both are refused to the person's face with the store's reason;
 * every other verb still goes — repeating a state change is a no-op.
 */
import { EngineLifecycle } from "./engine/lifecycle.js";

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
export class OhmailEngine extends EngineLifecycle {}

export {
  type AppliedRuleRequest, type KeptAsNewDraft, type MutationResult, type MutationStatus, type OrganizerRequestView,
  OUTBOX_WITHDRAWN_CODE, type QueuedRuleWrite, STALE_PRESS_CODE, UNSCREENED_REASK_MS, type UnsettledRulePress,
  type WaitingOnOrganizerView, WHY_STAYED_PAGE, type WithdrawOutcome,
} from "./engine/mutation-views.js";
export {
  type AbandonedMutation, joinableStandingSend, NO_WAITING, OUTBOX_ABANDONED_TYPE, OUTBOX_ENTRY_VERSION,
  OUTBOX_TYPE, PRESS_AGE_KINDS, type QueuedChange, targetOf, type WaitingSend,
} from "./engine/outbox-record.js";
export {
  BODIES_IDS_MAX, DEFAULT_STORE_POLICY, errorClassOf, type FetchBodiesFn, type FetchMessageOutcome,
  type ListOlderFn, type ListOlderOutcome, type ListOlderWire, type ListTrashFn, type ListTrashOutcome,
  type ListTrashWire, type MessageByIdFn, type RestoreFromTrashFn, type RestoreFromTrashWire, type RestoreOutcome,
  SERVER_ADDRESS_DIRECTIONS, SERVER_ADDRESS_DIRECTIONS_SERVED, SERVER_SEARCH_SORTS, type ServerAddressDirection,
  type ServerAddressOpts, type ServerAddressOutcome, type ServerAddressSearchFn, type ServerAddressWire,
  type ServerEstimateOutcome, type ServerSearchFacets, type ServerSearchFilters, type ServerSearchFn,
  type ServerSearchOpts, type ServerSearchOutcome, type ServerSearchPart, type ServerSearchSort,
  type ServerSearchWire, SNAPSHOT_PAGE_1_STATE_KINDS, type SnapshotFn, type StoreCoverage, type StorePolicy,
  type TrashRowWire,
} from "./engine/server-wire.js";
export {
  type AttachmentItem, type AttachmentsOutcome, CALENDAR_TEXT_MAX_BYTES, CALENDAR_TEXT_MAX_PARTS,
  INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_PARTS, INLINE_IMAGE_MAX_TOTAL_BYTES, PART_REASK_DELAYS_MS,
  STAGED_PREVIEWS_KEPT, type StagedPreview,
} from "./engine/attachment-items.js";
export {
  BACKLOG_PAGE_LIMIT, BACKLOG_PUBLISH_PAGES, DRAIN_REQUEST_CEILING_MS, EAGER_BODIES_MAX, EAGER_BODIES_SLICE,
  type EngineLocks, type EngineOptions, type FreshnessState, LAST_DRAIN_AT_META, type MirrorFreshness,
  ORGANIZER_REQUEST_SLOW_MS, ORGANIZER_REQUESTS_REREAD_MS, OUTBOX_BACKOFF_BASE_MS, OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_HOLD_CEILING_MS, OUTBOX_MAX_SERVER_FAILURES, OUTBOX_REPLAY_DEADLINE_MS, OUTBOX_TRY_AGAIN_ENDS_HOLD_MS,
  OUTBOX_UNKEYED_CREATE_TTL_MS, OUTBOX_UNREACHABLE_CEILING_MS, RECEIVED_MESSAGES_META, SEARCH_WARM_IDLE_MS,
  SENT_FOLDERS_META, SNAPSHOT_PREFIX_SEQ_META, SNAPSHOT_REFUSAL_HOLD_BASE_MS, SNAPSHOT_REFUSAL_HOLD_CAP_MS,
  STALE_RESUME_MS, STORE_POLICY_GENERATION, STORE_POLICY_GENERATION_META, type WakeSignalSource,
  WINDOW_REFILL_OWED_META,
} from "./engine/options.js";
export {
  BODY_CACHE_MAX, FAILED_BODY_HOLD_MS, MAX_CONCURRENT_BODIES, OPTIMISTIC_SENT_TTL_MS, RENDERED_PINS,
  SENT_FORWARD_MAX_PARTS,
} from "./engine/ceilings.js";
