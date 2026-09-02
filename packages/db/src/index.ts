export const DB_VERSION = "0.0.0";

/**
 * The RUNTIME surface of `@trafficflow/db`: the MAIL schema, the change-log primitive, the
 * idempotency primitive and the small shared vocabularies. Nothing here touches `node:fs` or
 * the migrator.
 *
 * Migration / provisioning lives in `@trafficflow/db/admin` — see the doc comment there for
 * why it is not re-exported from this root (serverless cold-start weight and bundle
 * tracing). Tests, CLIs and provisioning import that subpath explicitly.
 *
 * ── THE CLOSURE RULE, AND WHY IT IS A RULE AND NOT A PREFERENCE ────────────────────────────
 *
 * **No module named from this file may reach `schema.js`, `schema-cloud.js`, or anything that
 * imports them.** This barrel is inside the desktop engine's import closure, the engine is
 * SHIPPED, and the .app conveys whatever its bundle contains.
 *
 * It is a rule because the intuitive version of it is wrong in a way that compiles, passes every
 * test, and is invisible to a reader. Three lines that each looked like a type-only or
 * name-only reference were measured to put the whole Cloud schema into the artifact:
 *
 *  · `export { schema } from "./schema.js"` — every consumer writes `typeof schema`, so this
 *    reads as a type position. A re-export is a RUNTIME edge regardless of how consumers use it.
 *  · `export { makeDb, … } from "./client.js"` — the engine never calls any of them, but
 *    `client.ts` names the combined `schema` to construct its handle, and an unused re-export is
 *    still an edge: absent a `sideEffects` declaration a bundler must keep the module's bytes.
 *  · `export { acquireImapSlot, … } from "./imap-admission.js"` — a counter, apparently neutral,
 *    over a per-address attempt table, which the Cloud journal creates.
 *
 * All three now live on `@trafficflow/db/cloud`. The measurement that settles it is
 * the engine build's census over the finished artifact, and a test runs that same census
 * in the suite so the next one fails here rather than at a build somebody remembers to run.
 */
/* THE MAIL SCHEMA, not the barrel. `./schema.js` re-exports both halves, so exporting it here
 * put every Cloud table into every consumer of this package — including the desktop engine's
 * shipped bundle. Hosted tables live on `@trafficflow/db/cloud`. */
export * from "./schema-mail.js";
// The one-time Quarantine→Junk sweep's candidate predicate — one clause the API's preview and
// the worker's pass both count by. A pure predicate over the mail schema, nothing more.
export { junkSweepCandidateWhere, JUNK_SWEEP_SOURCE_PILE } from "./junk-sweep.js";

// The ONE spelling of the read-state intent — see the module header for why it lives here
// (both the services and the worker write it, and the worker may not import services at
// runtime). Reaches `schema-mail.js` alone, so the closure rule above holds.
export { upsertDesiredSeen } from "./flag-intent.js";

// The ONE spelling of "a stand-down closes the appointments it can no longer keep" — same
// argument as the line above, four call sites (the sidecar's lease gate and its launch catch-up,
// the worker's gate, the reconcile cron), and the worker may not import services at runtime.
// Reaches `schema-mail.js`, `change-log.js` and `mailbox-errors.js` alone.
export {
  closeStoodDownAppointments, STAND_DOWN_SEND_SENTENCES,
  // The REMOVAL arm of the same module. A user removing a mailbox orphans its appointments in
  // exactly the way a stand-down does, and the close was refused for it by construction — the
  // stand-down's precondition reads a null `disabled_reason` as "not my event" — so a removal
  // left a pending appointment that would never be delivered and never reported as failed.
  // Reached from `MailboxService.delete` alone; see that method for why it is in its transaction.
  closeRemovedMailboxAppointments, REMOVED_MAILBOX_SEND_SENTENCE,
  type StandDownSendsInput, type StandDownSendsResult, type RemovedMailboxSendsInput,
} from "./stand-down-sends.js";

// The ONE spelling of "somebody else organizes this mailbox" (mail 0083) — the same argument as
// the two lines above: the worker may not import services at runtime, the sidecar's gate and the
// hosted gate both write the holder columns, and eleven service write doors share one refusal.
// Reaches `schema-mail.js`, `change-log.js` and `mailbox-errors.js` alone — the third for
// `standDownMemory`, which composes the same closed set `disabled_reason` carries and checks its
// own answer against it rather than casting. `mailbox-errors.js` is a LEAF (zero imports), so it
// widens the graph by one file and by nothing behind it.
//
// WHAT CHECKS THAT, precisely, because the obvious answer is wrong: NOT
// `desktop-engine-closure.test.ts` — that walker starts at `@trafficflow/db/journal`, the narrow
// entry, and never reaches this module at all (planting a `schema-cloud.js` import in
// `organizer-role.ts` leaves all six of its tests green — run, not assumed). What does check it is
// `publish-desktop.mjs`'s bundle pass, which walks the ENGINE's real closure and refuses any input
// outside the published payload. The sentence above is otherwise a source fact a reader verifies
// by reading the imports, and it is written here so nobody mistakes it for a guarded one.
export {
  assertOrganizerRole, assertAccountOrganizes, readOrganizerRole, organizerDisplayName,
  OrganizedElsewhereError, MailboxNotFoundError,
  // The ONE spelling of "this row remembers standing down, and to whom". Three desktop readers
  // asked it of `disabled_reason`, which mail 0083 left with no writer, so all three answered
  // NULL and nothing failed. See the function.
  standDownMemory,
  ORGANIZER_ROLES, ORGANIZER_KINDS, ORGANIZER_STATES, ORGANIZED_BY_NAME_MAX,
  isOrganizerRole, isOrganizerKind, isOrganizerState,
  type OrganizerRole, type OrganizerKind, type OrganizerState,
  type OrganizedBy, type OrganizerRoleRow,
} from "./organizer-role.js";

export {
  allocateSeq, allocateSeqRange, recordChange, recordChanges, minRetainedSeq, seqBounds,
  CHANGE_LOG_CHANNEL, changeWakePayload, parseChangeWake,
  type Tx, type LedgerTx, type EntityType, type ChangeOp, type ChangeInput, type SeqBounds,
} from "./change-log.js";
export {
  claimIdempotencyKey, readIdempotencyKey, pruneIdempotencyKeys,
  idempotencyExpiry, IDEMPOTENCY_TTL_MS,
  type IdempotencyClaimInput,
} from "./idempotency.js";
// Billing + the credit ledger, observability and the AI spend gate USED to
// be re-exported here. They are runtime surface — no `node:fs`, no migrator — so `/admin` was
// never the right home for them, and the worker (which may import core + db only) still reaches
// them without `@trafficflow/services`. They now live on `@trafficflow/db/cloud`, which the
// worker imports directly: the reason they moved is not layering but SHIPPING — see the header
// of `cloud.ts`.

/**
 * The stored-body byte accounting over `account_storage` (mail 0062) — the counter every body
 * writer moves in its own transaction, and the reserve `DrizzleRepo.insertMessageBody` gates
 * the managed storage cap on. Mail schema only; the cap READ (`storageCapOf`) and the at-cap
 * roster are billing reads and live on `@trafficflow/db/cloud`.
 */
export {
  bodyBytesOf, storageUsageOf, reserveBodyBytes, releaseBodyBytes, applyBodyBytesDelta,
  // The rolling window (ratified 2026-08-21): at cap the OLDEST stored bodies husk so new mail
  // keeps landing. The worker's background trim and the ingest fallback share these.
  evictOldestBodies, reserveBodyBytesEvicting,
  EVICT_HIGH_WATER_RATIO, EVICT_LOW_WATER_RATIO, EVICT_BATCH_BODIES, EVICT_INLINE_MAX_BODIES,
  type EvictionResult,
  recomputeAccountStorage,
} from "./storage.js";

/** One definition of "transaction pooler", shared by every host that must refuse one. */
export { transactionPoolerReason, sessionUrlRejection } from "./session-url.js";
/** And one definition of "unusable as the serverless runtime connection". */
export { runtimeUrlReason, providerFamily } from "./session-url.js";



// The IMAP admission counter used to be re-exported here, on the argument that it is neither
// billing nor identity and that both the API and the worker can reach it without
// `@trafficflow/services`. That argument is about LAYERING and the constraint here is SHIPPING:
// the counter's table is a per-address attempt log, which the Cloud journal creates and the mail
// journal does not, so the module cannot be pointed at `schema-mail.js` and cannot stay on this barrel.
// It lives on `@trafficflow/db/cloud`.

/**
 * The ledger-source VOCABULARY — pure string construction, on the root barrel because its
 * CALLERS are mail-half code that also ships in the desktop engine: the ingest pipeline labels a
 * classification, the Screener labels a suggestion, the drafting path labels a draft, the HTTP
 * edge brands a client-supplied key. `@trafficflow/db/cloud` re-exports the same names for the
 * code that reads and writes the ledger itself. See `ledger-source.ts` for why it is a leaf.
 */
export {
  clientIdempotencyKey, ledgerSources,
  AI_ACTION_WEIGHTS, WEIGHTED_DEBIT_REASONS, aiActionCost, assertWeightedScheduleActive,
  classifyLedgerSource, screenerLedgerSource,
  type IdempotencyKey, type WeightedDebitReason,
} from "./ledger-source.js";

/**
 * THE AI SPEND GATE'S PORT — the question, never the answer.
 *
 * The gate itself needs a subscription, a credit ledger and the tables behind both, and lives on
 * `@trafficflow/db/cloud` with them. But the code that CALLS it is shared: the ingest pipeline,
 * the Screener and the drafting path are the same modules in a hosted deployment that meters AI
 * and in a local install that has no subscription and nobody to ask. Those modules must be able to
 * say "I may be handed a gate" without depending on the half that answers.
 *
 * Nothing here constructs a gate and nothing here has a default. A deployment that supplies none
 * supplies none, and every caller already treats that as "skip the AI" rather than "proceed
 * unmetered" — which is what keeps the no-cost-without-revenue rule structural rather than a
 * matter of remembering to wire something up.
 */
export type {
  AiCreditGate, AiSpendOutcome, AiRefusalReason, EntitlementReason,
} from "./ai-gate-port.js";

/** One definition of the `mailboxes.error_code` taxonomy, for the worker and the API. */
export { MAILBOX_ERROR_CODES, isMailboxErrorCode, type MailboxErrorCode } from "./mailbox-errors.js";
// Exported because construction sites live outside this package too (`leader-lock.ts`), and
// every one of them must pass `onNotice` or postgres.js writes raw notice objects to the drain.
export {
  onNotice, setNoticeSink, noticeSinkInstalled, noticeSinkFor,
  type NoticeSink, type PgNoticeFacts, type NoticeLogger,
} from "./notices.js";
export {
  MAILBOX_DISABLED_REASONS, isMailboxDisabledReason, type MailboxDisabledReason,
} from "./mailbox-errors.js";
export {
  MAILBOX_SYNC_BLOCK_REASONS, isMailboxSyncBlockReason, type MailboxSyncBlockReason,
} from "./mailbox-errors.js";
/** Mail 0063's closed set for `mailboxes.smtp_size_probe_code`, beside the column it constrains. */
export {
  SMTP_SIZE_PROBE_CODES, isSmtpSizeProbeCode, type SmtpSizeProbeCode,
} from "./mailbox-errors.js";

/**
 * ONE definition of the row a bought Screener suggestion is stored as — the provenance that marks
 * it, the status that keeps it inert, and the per-message transaction that writes it.
 *
 * On the ROOT barrel, and it belongs there for the reason the ledger-source vocabulary does: its
 * callers straddle the deployment. The user-pressed purchase lives in `@trafficflow/services`;
 * the always-on pass that buys for incoming held senders lives in the worker, which may import
 * core and db and nothing else from the workspace. It reaches `schema-mail.js` alone, so it is
 * inside this barrel's closure rule.
 */
export {
  storeScreenerSuggestion,
  // The SENDER identity of a suggestion — the automatic path's entitlement, and the read that
  // shows a sender's advice whichever of their messages it was bought about. Same barrel and the
  // same closure rule: these name `messages` and `routing_decisions` and nothing else.
  screenerSuggestedSenderExists, screenerSuggestionsBySender, hasScreenerSuggestionForSender,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
  type ScreenerSuggestionRow, type StoredSenderSuggestion,
} from "./screener-suggestion.js";

/**
 * The portable profile's import markers — the found-document record the organizer writes and
 * the user-answer record that releases its hold. Same barrel and the same closure rule as the
 * screener-suggestion block above, for the same straddle: the answer side is called from
 * `@trafficflow/services`, the organizer side runs in the worker (core + db and nothing else),
 * and the module reaches `schema-mail.js` alone.
 */
export {
  PROFILE_FOUND_AUDIT_ACTION, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION,
  latestProfileFoundMarker, profileImportResolutionExists,
  profileImportResolutionSince, recordProfileImportResolution,
  type ProfileFoundMarker, type ProfileImportDecision, type ProfileImportSubject,
} from "./organizer-profile-import.js";
