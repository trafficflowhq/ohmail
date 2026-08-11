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

export {
  allocateSeq, allocateSeqRange, recordChange, recordChanges, minRetainedSeq, seqBounds,
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
  AI_ACTION_COST, classifyLedgerSource, screenerLedgerSource,
  type IdempotencyKey,
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
