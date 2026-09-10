/**
 * `@trafficflow/db/cloud` — the HOSTED half: billing, credits, alerts, the AI spend gate, the
 * admin database handle and its staff grants, plus the Cloud schema.
 *
 * ## Why this is its own entry point
 *
 * The desktop engine is a real consumer of this package and it is SHIPPED — the .app conveys
 * whatever the engine's bundle contains. While these lived on the root barrel, every module
 * that imported `@trafficflow/db` for a mail table also received billing, Stripe, the staff
 * tables and the Cloud schema, because `index.ts` re-exported them and `./schema.js` (the
 * barrel) rather than `./schema-mail.js`. That is not a weight argument: the first engine
 * bundle ever built failed its own artifact census on exactly this, counting `password_hash`
 * x4, `token_hash` x7, `credit_ledger` x10, `staff_users` x6, `stripe` x24 and the database
 * provider's name x3 in something a stranger would download.
 *
 * The root barrel now carries the MAIL schema and the primitives both halves share. A module
 * that genuinely needs a hosted symbol imports it from here and says so by importing it; the
 * ~280 that never referenced one simply stop receiving it.
 *
 * ## The rule
 *
 * Nothing that ships in the desktop engine may import this. `test/desktop-engine-closure.test.ts`
 * guards the migration entry point the same way, and `scripts/build-engine.mjs` censuses the
 * built artifact — a closure test reads imports, an artifact is what ships, and both exist
 * because neither alone caught this.
 */

/* The Cloud TABLES themselves. They were reaching consumers through the root barrel's
 * `export * from "./schema.js"`; they belong here, beside the code that reads them. */
export * from "./schema-cloud.js";

/**
 * `schema` — the COMBINED object — and the postgres CLIENTS built over it, on THIS entry point
 * rather than the root.
 *
 * Drizzle's query builder is typed on the schema its handle was constructed with, so a handle
 * that genuinely spans both halves — the hosted API's, the worker's — needs the whole object.
 * That is a hosted need by definition: the desktop engine builds its own handle from `mailSchema`
 * against a database the mail journal alone created (`apps/sidecar/src/db.ts`), and every one of
 * these functions dials a `postgres://` URL, which is not a thing a local install has.
 *
 * They are here and not on the root because a re-export is a RUNTIME edge even when no consumer
 * calls the function and every consumer writes only `typeof schema`. See the closure rule at the
 * top of `index.ts`.
 */
export { schema } from "./schema.js";
export {
  makeDb, closeDb, makeOwnedDb, makePooledDb, closePooledDbs, WORKER_TIMEOUTS, WORKER_POOL_MAX,
  POOLED_TIMEOUTS, API_MAX_DURATION_MS, ROLE_DEFAULT_TIMEOUTS,
  POOLED_ACQUIRE_TIMEOUT_MS, DbAcquireTimeoutError, isDbAcquireTimeout,
  type OwnedDb,
} from "./client.js";

/**
 * The `/events` per-instance LISTEN fan-out — one session-mode connection, many streams.
 *
 * Extracted from `apps/api-vercel/src/wake-hub.ts` (which re-exports it unchanged) the day a
 * second long-running host needed the same hub; see `change-wake.ts` for the invariant. Cloud
 * entry point because it dials a `postgres://` URL, which no shipped local engine has.
 */
export {
  makeChangeWakeHub, IDLE_CLOSE_MS as WAKE_IDLE_CLOSE_MS, RETRY_AFTER_MS as WAKE_RETRY_AFTER_MS,
  type ChangeWakeFanout,
} from "./change-wake.js";

/**
 * The cross-process cap on concurrent IMAP connections per mailbox.
 *
 * Not a billing or identity concern, and here anyway: it counts through `auth_throttle`, a table
 * the CLOUD journal creates. The mail journal has no such table, so a local database cannot
 * satisfy this module however the imports are arranged.
 */
export {
  acquireImapSlot, releaseImapSlot, imapAdmissionKey,
  recordImapRefusal, imapRefusalsInWindow,
  IMAP_ADMISSION_NAMESPACE, IMAP_ADMISSION_WINDOW_MS,
  IMAP_REFUSAL_KEY, IMAP_REFUSAL_WINDOW_MS,
  type ImapSlotInput,
} from "./imap-admission.js";




/**
 * Cloud 0009 — Exchange/M365 OAuth2 onboarding. Two stores, both hosted-only:
 *
 *  · the CEREMONY (`oauth-ceremony.ts`) — mint / consume-once / prune. The consume is the redirect
 *    flow's whole replay defence and there is exactly one writer of `consumed_at`.
 *  · the operator's APPLICATION REGISTRATION (`oauth-config.ts`) — one resolver called by BOTH the
 *    API and the worker, so the two can never sign with different clients, with env as the
 *    bootstrap and one precedence rule.
 */
export {
  createOAuthCeremony, consumeOAuthCeremony, pruneOAuthCeremonies,
  OAUTH_CEREMONY_TTL_MS, OAUTH_CEREMONY_RETENTION_MS,
  type OAuthCeremonyRow, type CreateOAuthCeremonyInput,
  type ConsumeOAuthCeremonyInput, type ConsumeOAuthCeremonyOutcome,
  /*
   * Cloud 0027 — the DEVICE-CODE ceremony's four arms, exported beside the redirect flow's because
   * they live in one module and share one law each way: `readDeviceCeremony` writes nothing, and
   * `claimDeviceCeremony` is the only writer of that table's `consumed_at`, exactly as
   * `consumeOAuthCeremony` is of the redirect table's. The separation is the security property —
   * see the module's own header for why one table with a flag would not be.
   */
  createDeviceCeremony, readDeviceCeremony, leaseDeviceCeremonyPoll,
  noteDeviceCeremonySlowDown, claimDeviceCeremony, pruneDeviceCeremonies,
  DEVICE_CEREMONY_RETENTION_MS,
  type DeviceCeremonyRow, type CreateDeviceCeremonyInput, type ReadDeviceCeremonyOutcome,
} from "./oauth-ceremony.js";

export {
  readOAuthProviderConfig, writeOAuthProviderConfig, resolveOAuthProviderConfig, webRedirectUri,
  rotateMailboxOAuthSecret,
  MICROSOFT_PROVIDER, MS_OAUTH_ENV, MS_OAUTH_ENV_ALIASES, msOAuthEnv, MS_DEFAULT_SCOPES,
  type Decrypt, type OAuthProviderConfigRow, type WriteOAuthProviderConfigInput,
  type ResolvedOAuthConfig, type ResolveOAuthConfigInput, type MsOAuthBootstrap,
  type OAuthConfigSource, type OAuthConfigGap,
} from "./oauth-config.js";

export {
  evaluateAlerts, runAlertPass, deliver, webhookAlertSink, nodePostJson, renderAlertText,
  writeHeartbeat, refreshHeartbeat, clearHeartbeat, humanAge,
  listStuckSends, listOpenAlerts, listOpenAlertStamps,
  selectOpenAlerts,
  newDeliveryStreak, newSinkStreak, redactEndpoint, classifyTransportError, sinkHealthOf,
  alertSignature, alertClass, incidentsOf, signalsOf,
  alertDriverStatuses, platformSignalWindow, CLOUD_JOURNAL_HEAD_WHEN,
  DEFAULT_ALERT_THRESHOLDS, DEFAULT_ALERT_REPEAT_MS, DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS,
  SCOPED_ALERT_KINDS,
  isSchemaBehind,
  alertSchemaReadable,
  SIGNAL_BUCKET_MS,
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_SINK_FAILURE_ESCALATION,
  type Alert, type AlertKind, type AlertSeverity, type AlertThresholds, type AlertSink,
  type AlertNotifyContext, type AlertPassOptions, type AlertPassResult, type EvaluateOptions,
  type HeartbeatInput, type HeartbeatRefresh, type PostJson, type AtCapAccount,
  type StuckSendRow, type AlertDeliveryResult, type DeliveryStreak, type SinkEscalation,
  type AlertSinkOutcome, type SinkOutcome, type DeliveryReport, type SinkStreak,
  type SinkDegradation, type AlertSinkHealth,
  type AlertClass, type AlertDriver, type AlertDriverStatus, type PlatformSignalWindow,
} from "./alerts.js";

export {
  resendAlertSink, RESEND_EMAILS_URL, type ResendAlertSinkConfig,
} from "./alert-mail.js";

/**
 * The PUSH arm — the pager's second vendor. Same seam, same `PostJson`, a different company,
 * a different credential and a different delivery channel from the mail arm above; the whole
 * argument is in the module's own header.
 */
export {
  telegramAlertSink, TELEGRAM_API_ORIGIN, TELEGRAM_TEXT_LIMIT,
  type TelegramAlertSinkConfig,
} from "./alert-push.js";







/* The account-level AI off switch (migration 0022) — its OWN module, because the switch is the
 * product on every deployment while the metering that consults it is one operator's concern. */
export { aiEnabledFor, getAiAnswer, getAiEnabled, setAiEnabled } from "./ai-settings.js";


/**
 * The content-blind STAFF handle (staff can never read mail content). Runtime surface: `apps/api-vercel` builds
 * the factory at cold start and the staff routes await it per request.
 */
export {
  adminDbFor, assertContentBlind, attestStaffDbFault, resetAdminDbs, NotContentBlindError,
  CONTENT_BLIND_PROBE, CONTENT_BITE_TESTS, DENIED_SQLSTATE,
  type AdminDb, type ContentBlind,
} from "./admin-db.js";

/**
 * The ONE allowlist, and the census that measures a role against it. Imported by the
 * boot attestation above and by `test/staff-role.pg.test.ts`, so the thing
 * production attests and the thing CI asserts are the same object and cannot drift apart.
 */
export {
  STAFF_ROLE, STAFF_ROLE_LIVE_IN_PRODUCTION, STAFF_SCHEMAS, STAFF_ADMIN_VIEWS,
  STAFF_CAPABILITY_SQL,
  STAFF_SELECT_GRANTS, STAFF_TABLE_GRANTS, STAFF_SCHEMA_GRANTS,
  asCapabilities, describeCapability, staffCapabilityExcess, staffCapabilityShortfall,
  type StaffCapability,
} from "./staff-grants.js";

/**
 * CRYPTO-4 — the KEK re-wrap pass, and the census that licenses retiring a version.
 *
 * On THIS entry point and not the root, and the reason is the closure rule at the top of
 * `index.ts` rather than layering: the registry names four Cloud tables, so the module reaches
 * `schema-cloud.js` and a re-export from the root barrel would put the hosted schema back into
 * the desktop engine's bundle. A local install has no `totp_secrets` and no staff table.
 */
export {
  runKekRewrap, kekRewrapCensus, formatCensus,
  WRAPPED_SECRET_SITES, REWRAP_BATCH_LIMIT,
  type WrappedSecretSite, type RewrapKeyProvider, type KekRewrapDeps, type KekRewrapResult,
  type KekRewrapCensus, type SiteCensus, type RewrapFailure, type RewrapFailureReason,
  type RewrapEvent, type RewrapHooks,
} from "./kek-rewrap.js";

/**
 * ATTACHMENT STAGING — the hosted send's direct-upload transport (cloud 0015): the rows, the
 * bucket, and the retention sweep over both.
 *
 * HOSTED-ONLY by construction and not only by convention: a local install runs the send handler in
 * the same process as its own SMTP dial, so there is no request body to stage around and no object
 * storage to stage into. The table is created by the cloud journal, so a desktop database has no
 * such table to write into however the imports are arranged.
 *
 * THE OBJECT HALF IS HERE AND NOT IN `packages/services`, and this entry point is why it can be:
 * the sweep runs in the WORKER's maintenance slot, and the worker's runtime closure is `core` +
 * `db` and nothing else (pinned by the worker's dependency test). A storage client on a `/cloud`
 * entry point is also nothing new — `webhookAlertSink` above is a runtime `fetch` sink the worker
 * already composes. The send-facing half of the transport, which maps a failed read onto an HTTP
 * status, stays in `packages/services` where a service error means something.
 */
export {
  createStagingTicket, createStagingTicketWithinQuota, outstandingStagingUsage, stagingTicketId,
  readStagingTickets, expiredStagingTickets, deleteStagingTickets,
  attachmentStagingExpiry, ATTACHMENT_STAGING_TTL_MS,
  makeSupabaseStagingStorage, makeS3StagingStorage, s3StagingObjectUrl, stagingObjectPath,
  sweepExpiredStaging, drainExpiredStaging, sweepExpiredStagingFor,
  StagedObjectTooLargeError, AttachmentStagingStorageError,
  STAGING_SWEEP_BATCH, STAGING_SWEEP_MAX_ROWS, STAGING_SWEEP_DEADLINE_MS,
  STAGING_MAX_OUTSTANDING_TICKETS, STAGING_MAX_OUTSTANDING_BYTES,
  STAGING_QUOTA_LOCK_CLASS, DEFAULT_STAGING_QUOTA, S3_UPLOAD_GRANT_TTL_SECONDS,
  type StagingTicket, type StagingTicketInput,
  type StagingMintOutcome, type StagingQuota, type StagingQuotaRefusal, type StagingUsage,
  type ExpiredStagingTicket, type StagingDrainResult,
  type AttachmentStagingStorage, type AttachmentStagingStorageConfig,
  type S3StagingStorageConfig,
} from "./attachment-staging.js";

/**
 * WHEN THE ORGANIZER'S LAST PASS FINISHED — read from `worker_heartbeats` for the filing strip's
 * "the last pass finished N seconds ago" clause (mail 0097).
 *
 * On THIS entry point and not the root barrel for the closure rule the root barrel's own header
 * states: `worker_heartbeats` is a Cloud table, and `packages/services/src/mailbox-service.ts` —
 * which renders the field — is inside the desktop engine's import graph. The hosted compositions
 * pass `organizerCycleReader` as `MailboxServiceDeps.lastOrganizerCycleAt`; the local tiers pass
 * nothing and the field is null, which the client renders as silence.
 */
export { readLastOrganizerCycleAt, organizerCycleReader } from "./organizer-cycle.js";

/**
 * The operator's one mailbox write — clearing a quarantined mailbox's durable retry backoff so
 * the sync leader re-dials it. Here rather than on the root barrel because it writes `audit_log`,
 * a Cloud table.
 */
export {
  resyncMailbox, type MailboxResyncWrite, type MailboxResyncOutcome,
} from "./mailbox-resync.js";

/**
 * THE SPEND VOCABULARY — the terms table, the one source composer, and the attempt-key builders.
 *
 * Defined on a leaf the engine compiles, presented here beside the port's answer: a call site
 * names an action and a bare attempt key, and `sourceFor` is the only thing that turns the pair
 * into a ledger source. Every implementation of the port composes through it, which is what keeps
 * two answers from meaning different things by one key.
 */
export {
  SPEND_ACTIONS, DRAFT_RETRY_WINDOW_MS, ATTEMPT_KEY_MAX, ledgerSources,
  sourceFor, assertAttemptKey, isSpendAction, clientIdempotencyKey,
  classifyAttemptKey, screenerAttemptKey, draftAttemptKey, workflowAttemptKey,
  classifyLedgerSource, screenerLedgerSource,
  AI_ACTION_WEIGHTS, WEIGHTED_DEBIT_REASONS, aiActionCost, assertWeightedScheduleActive,
  type SpendAction, type IdempotencyKey, type WeightedDebitReason,
} from "./ledger-source.js";

/** The AI gate's refusal vocabulary — the words a spend verdict carries. */
export {
  AI_REFUSAL_REASONS, ENTITLEMENT_REASONS, isAiRefusalReason,
  type AiRefusalReason, type AiSpendOutcome, type EntitlementReason,
} from "./ai-gate-port.js";

/**
 * THE ANSWER to the entitlements port (`@trafficflow/db#EntitlementsPort`): the HTTP client of an
 * entitlements program.
 *
 * On this entry point and not the root barrel because it reaches the network, and the engine
 * census refuses it in the desktop artifact. The port TYPE is on the root barrel, which is what
 * lets a host with no such program name the member it fills with `UNMETERED`.
 */
export {
  makeEntitlementsClient, ENTITLEMENTS_CALL_TIMEOUT_MS, ACCESS_TTL_MS,
  type EntitlementsClientConfig, type EntitlementsFetch,
} from "./entitlements-client.js";
