export const SERVICES_VERSION = "0.0.0";

export { ServiceError, IdempotencyRaceLost } from "./errors.js";
export type { ServiceContext, Db } from "./context.js";
/* THE HOSTED DATABASE HANDLES. `context.ts` declares the registry with the one member a local
 * install can offer; this adds the two a hosted deployment has, by augmenting that interface.
 * Re-exporting a name from it is what carries the augmentation into every program built from this
 * barrel — a file that only declared a module augmentation would be a side-effect import, and
 * those are not reliably preserved into the declarations a consumer compiles against. So every
 * consumer of this barrel sees the full `Db`, and a build that never loads it sees exactly the
 * truth about itself. */
export type { CloudDb } from "./context-cloud.js";
export {
  SyncService, syncService, SNAPSHOT_WINDOW,
  type GetChangesOptions, type GetSnapshotOptions,
} from "./sync-service.js";
export * from "./dto/types.js";
export {
  materialize,
  materializeMessage, materializeMessages, materializeMessageState, materializeThread, materializeTag,
  materializeRoutingDecision, materializeApproval, materializeRule, materializeDraft,
} from "./dto/materialize.js";
export {
  clampLimit, encodeListCursor, decodeListCursor,
  DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT,
} from "./pagination.js";
export {
  LearningService, learningService, patternKeyFor,
  GRADUATION_THRESHOLD, DEMOTION_THRESHOLD,
  type LearningSignalInput, type LearningKind, type LearningLabel,
} from "./learning-service.js";
export {
  ScreenerService, makeScreenerService, SCREENER_FOLDER,
  type ScreenerDeps, type ScreenBody, type ScreenDecisionResult, type ScreenIdempotency,
} from "./screener-service.js";
export {
  TriageService, triageService,
  type TriageSetBody, type TriageIdempotency, type ListOptions, type FocusReplyView, type PowerThroughView,
} from "./triage-service.js";
export {
  ApprovalService, makeApprovalService,
  type ApprovalDeps, type ApprovalDecisionBody, type ApprovalIdempotency, type ListApprovalsOptions,
} from "./approval-service.js";
export {
  HeyMigrationService, makeHeyMigrationService,
  type MigrateInput, type MigrateOptions, type MigrateSummary,
} from "./hey-migration.js";
export {
  RulesService, rulesService,
  type CreateRuleBody, type PatchRuleBody, type RuleMutation,
} from "./rules-service.js";

// Consent: the sent-mail seed, the dormancy cutline, and putting an account back to unscreened.
export {
  SEED_SCAN_LIMIT, SUPPORTED_LOCALES,
  buildSeedReview, confirmSeed, consentSettings, setAutoSuggest, setBlockAutoUnsubscribe,
  setBlockRemoteImages, setBlockTrackingPixels, setDormancyDays, setFoldersEnabled,
  setLocale, setMailboxFoldersEnabled, setMailboxSignature,
  mailboxSignatures, MAILBOX_SIGNATURE_MAX_CHARS,
  isMachineSent, isRobotAddress, parseAddressList,
  type SeedCandidate, type SeedConfirmResult, type SeedExclusionReason, type SeedReview,
} from "./consent-seed.js";
// The folders foundation's inventory reads (FOLDERS-SPEC.md §4): which of the mailbox's own
// folders exist, whether the account shows them, and why a path is excluded.
export {
  foldersEnabled, listMailboxUserFolders, listUserFolders, mailboxFoldersOff, userFolderById,
  userFolderExclusion, userFoldersByIds, type UserFolderRow,
} from "./folders.js";
// The editable Ohbox preference: posture + free-text bar on account_settings.
export {
  getScreeningPreference, setScreeningPreference, requestOhboxTidy, resolveOhboxPolicy,
  DEFAULT_OHBOX_BAR, OHBOX_BAR_MAX_BYTES, OHBOX_POLICIES,
  type ScreeningPreference, type ScreeningPreferenceUpdate,
} from "./screening-preference.js";
export {
  resetScreeningState, unmovedReport, type ResetResult, type UnmovedPile,
} from "./consent-reset.js";
export {
  DEFAULT_DORMANCY_DAYS, cutlineCounts, hasUndecidedActiveSenders,
  type CutlineCounts, type CutlineOptions,
} from "./consent-cutline.js";


export {
  MailboxService, makeMailboxService, mailboxService, decryptCredential,
  type CreateMailboxBody, type UpdateMailboxBody, type TransportInput, type MailboxServiceDeps,
  // Cloud 0009 — the OAuth consent flow's write end. `connectOAuth` resolves its target row
  // by ADDRESS (the `id_token` claim), so these types carry no `mailboxId`.
  type ConnectOAuthMailboxInput, type ConnectOAuthOptions, type ConnectOAuthResult,
  type MailboxProbe, type MailboxProbeInput, type MailboxProbeVerdict,
  type SmtpProbe, type SmtpProbeInput, type ProbeTransport,
  type ProbeTlsDetail, type ProbeTlsFailureKind, type ProvenEndpoint,
} from "./mailbox-service.js";
// The plan-limit gate the mailbox write path runs inside its transaction.
export {
  assertMayAddMailbox, readMailboxAllowance, decideMailboxAllowance, MailboxAllowanceError,
  type MailboxAllowance, type MailboxRefusal,
} from "./mailbox-allowance.js";

/* AND REGISTERING IT AS THE DEFAULT IS THIS BARREL'S JOB.
 *
 * `mailbox-service.ts` used to import `assertMayAddMailbox` directly for its default, which put
 * billing and the credit ledger into the desktop engine bundle — the engine is built from
 * `./mail.js`, and that barrel mounts the mailbox service. Loading THIS barrel is what makes a
 * process a hosted one, so this is where the paid gate is declared. See
 * `mailbox-allowance-registry.ts` for why the unregistered case refuses instead of admitting. */
import { assertMayAddMailbox as paidMailboxGate } from "./mailbox-allowance.js";
import { setDefaultMailboxAllowance } from "./mailbox-allowance-registry.js";
setDefaultMailboxAllowance(paidMailboxGate);
export { setDefaultMailboxAllowance } from "./mailbox-allowance-registry.js";
export {
  PushService, pushService, makePushService,
  type PushSubscribeBody, type PushSubscribeResult, type PushIdempotency, type PushTransport,
} from "./push-service.js";
export {
  MessageService, messageService, MARK_SEEN_MAX_IDS,
  type MessageView, type ListMessagesOptions, type MessagePatchBody,
  type MarkSeenBody, type MarkSeenResult,
  type MoveBody, type MoveIdempotency, type MoveResult, type PatchResult,
} from "./message-service.js";
export {
  ThreadService, threadService,
  type ThreadPatchBody, type ThreadRenameBody, type ThreadMergeBody,
} from "./thread-service.js";
export {
  SearchService, searchService, SEARCH_SORTS, isSearchSort,
  type SearchOptions, type SearchFilters, type SearchResult, type Facets, type SearchSort,
} from "./search-service.js";
export {
  PrivacyService, makePrivacyService, nodeRemoteFetch, makeNodeRemoteFetch,
  type RemoteFetch, type PrivacyServiceDeps, type ProxyImageInput, type ProxyImageResult,
} from "./privacy-service.js";
export {
  assertPublicHttpUrl, assertPublicHost, isBlockedAddress, nodeHostResolver, type HostResolver,
} from "./ssrf-guard.js";
// RFC 8058 one-click unsubscribe, server-side. `mailto:` is never used and there is no
// mail port in the module; the auth verdict it persists is demote-only.
export {
  UnsubscribeService, makeUnsubscribeService, nodeOneClickPost, makeNodeOneClickPost,
  ONE_CLICK_BODY, unsubscribeListKey,
  type UnsubscribeDeps, type OneClickPost, type UnsubscribeResult, type UnsubscribeRefusal,
  type UnsubscribeSweep,
} from "./unsubscribe-service.js";
export {
  ContactsService, contactsService,
  type ListContactsOptions, type ListNotesOptions,
} from "./contacts-service.js";
export {
  SnippetsService, snippetsService,
  type SnippetBody, type ListSnippetsOptions,
} from "./snippets-service.js";
export {
  NotifyRulesService, notifyRulesService,
  type CreateNotifyRuleBody, type ListNotifyRulesOptions,
} from "./notify-rules-service.js";
export {
  AwayResponderService, awayResponderService,
  type AwayResponderBody,
} from "./away-responder-service.js";
export {
  ProfileImportService, profileImportService,
  type ProfileImportCandidateDTO, type ProfileImportApplied, type ProfileImportCounts,
  type ProfileReader,
} from "./profile-import-service.js";
export {
  AttachmentsService, attachmentsService, BIG_FILE_DEFAULT_BYTES,
  type AttachmentDTO, type FileDTO, type FetchedBytes, type AttachmentAdapter,
  type OpenAdapter, type FetchDeps, type FilesFilter, type ListFilesOptions,
  type DownloadAllInput, type DownloadAllResult,
} from "./attachments-service.js";
export {
  KbService, kbService,
  type KbEntryBody, type ListKbOptions,
} from "./kb-service.js";
export {
  TagsService, tagsService, RENDERABLE_HUES,
  type TagBody, type TagHue, type AssignResult,
} from "./tags-service.js";
export {
  FolderOpsService, folderOpsService,
  type FolderCreateBody, type FolderRenameBody, type FolderScopeSummary,
} from "./folder-ops-service.js";
export {
  DraftsService, draftsService,
  type CreateDraftBody, type PatchDraftBody, type DraftMutation,
} from "./drafts-service.js";
export {
  DraftingService, draftingService,
  type DraftFromMessageDeps,
} from "./drafting-service.js";
export {
  SendService, sendService, SEND_STALE_AFTER_MS,
  SEND_ATTACHMENT_MAX_TOTAL_BYTES, SEND_MAX_ATTACHMENT_PARTS, dedupeStagedIds,
  SEND_MIME_ENVELOPE_BYTES, SEND_STAGED_OBJECT_MAX_BYTES, attachmentBudgetFor,
  effectiveAttachmentCap, sendSurfaceFor,
  type SendDeps, type SendResult, type SendAttachment, type SendInput,
  type StagedAttachmentSource,
} from "./send-service.js";
export {
  WorkflowsService, workflowsService,
  type CreateWorkflowBody, type PatchWorkflowBody, type RunIdempotency, type ListRunsOptions,
} from "./workflows-service.js";
export {
  ProposalsService, proposalsService,
} from "./proposals-service.js";
// Art. 17 erasure. Anonymisation, not DELETE — the reasoning is in the file.
// Blocking precondition for the "delete your account anytime"
// sentence on the landing page.
export {
  deleteAccount, type DeleteAccountResult,
} from "./account-deletion-service.js";
export * from "./auth/index.js";
// Transactional mail: MailerPort, the policy layer above it, and the templates —
// the waitlist confirmation, the invite, the sign-in notice, verification and the
// account-exists mail. See `./mail/index.ts` for the sender identity and the rules.
export * from "./mail/index.js";
// The SMTP transport for the SAME port — the self-host composition's mailer. On THIS barrel and
// deliberately NOT on `./mail/index.ts` beside ResendMailer, and never on the `/mail` entry: the
// desktop engine bundles `@trafficflow/services/mail`, and this is the one module in the package
// that imports `nodemailer`. `mail-entry-census.test.ts` pins both directions — the `/mail`
// module graph carries no nodemailer, and nothing but this barrel imports the file.
export { SmtpMailer, type SmtpMailerConfig } from "./mail/smtp-mailer.js";
// Billing, post-extraction: `entitlements/` is the open half — all state, all
// transactions, the `EntitlementEvent` v1 wire contract and the `BillingPlanePort` the private
// Stripe plane is reached through (plus its HTTP client). The Stripe machinery itself lives in
// the private billing plane; this repository holds NO `stripe` dependency and
// no Stripe import, and a db-level test pins that. API-side by
// construction, because the worker may import core + db only.
export * from "./entitlements/index.js";
// Registration + onboarding: the landing waitlist and the consumable, expiring,
// email-bound invite that replaced the static bootstrap codes.
// `AuthService.register` consumes an invite inside its own transaction; `WaitlistService`
// is the only holder of a MailService outside the alert path.
export {
  consumeInvite, issueInvite, liveInvitesFor, markInviteDelivered, revokeInvitesFor, pruneExpiredInvites,
  generateInviteCode, normalizeInviteCode, inviteError,
  type InviteRefusal, type InviteOutcome, type InviteConsumed, type InviteRefused,
} from "./invites.js";
// The pairing-token lifecycle (`/pair*` on the self-host composition; the first-boot setup
// token; QR device pairing). Split since Phase 3: `pairing.ts` reaches only the shared half
// and rides the `./auth` entry too, while the INVITE-grant redeem — the half that bridges to
// the Cloud-half `invites` table — lives in `pairing-invite.ts` and stays FULL BARREL ONLY,
// like `invites.ts` beside it: `./mail/index.ts` and `./auth` must never re-export it.
export {
  mintPairingToken, listPairingTokens, revokePairingToken, consumePairingToken,
  redeemDevicePair, pairingInvalid,
  PAIRING_TTL_BOUNDS, PAIRING_LABEL_MAX, PAIRING_LIVE_TOKENS_MAX,
  type PairingGrant, type PairingTokenMinted, type PairingTokenListed, type PairingTokenStatus,
  type PairingConsumed, type PairedDeviceSessionMinter,
} from "./pairing.js";
export {
  redeemInviteGrant, PAIRING_INVITE_TTL_MS, type InviteGrantRedeemed,
} from "./pairing-invite.js";
export {
  WaitlistService, makeWaitlistService, DEFAULT_INVITE_TTL_MS, MAX_JOINS_PER_IP_WINDOW,
  type WaitlistServiceDeps, type WaitlistJoinInput, type WaitlistJoinResult,
  type MintInviteInput, type MintInviteResult, type WaitlistEntry,
} from "./waitlist-service.js";
// The staff read surface — the ONLY cross-account reader in the repo. Six pure reads behind
// `GET /admin/*`; no write, no `ServiceContext`, and a projection that cannot name a subject,
// a body, a credential or a Stripe payload. See the header of `admin-service.ts`.
export * from "./admin-dto.js";
export {
  adminAccounts, adminAccountDetail, adminBilling, adminFunnel, adminWorker, adminWorkerInstances,
  adminAlerts, adminActions, adminAttentionRank,
  ADMIN_LIST_LIMIT, ADMIN_DEFAULT_PAGE_SIZE, ADMIN_MAX_PAGE_SIZE, ADMIN_OPTIONS_LIMIT,
  ADMIN_ROSTER_LIMIT, ADMIN_SUBSCRIPTION_ORDER,
  ADMIN_WRITES_UNAVAILABLE, ADMIN_ACTIONS_PRECONDITION,
  // The branded, content-blind handle every one of those reads takes. Exported so
  // `packages/api` can type `ApiDeps.adminDb` with it and make `deps.db` a compile error.
  type AdminDb,
} from "./admin-service.js";
// The one per-IP slot limiter, shared by the waitlist and by registration.
export { reserveIpSlot } from "./ip-throttle.js";
// The ONE-TIME re-evaluation (mail 0030) of mail that `pipeline.ts:393`'s sensitivity
// override had already misrouted into the Ohbox. The routing was fixed forward; this moves
// what was already filed. Marker-last, idempotent, and it opens NO IMAP connection — it writes
// `folder_state.desired_folder` and the worker's reconciler performs the move. The CLI beside it
// (`sensitive-rescreen-cli.ts`) is deliberately NOT exported: it opens a pool at import.
export {
  runSensitiveRescreen, SENSITIVE_RESCREEN_BATCH, SENSITIVE_RESCREEN_MAX_PAGES,
  type SensitiveRescreenDeps, type SensitiveRescreenResult,
} from "./sensitive-rescreen.js";
// The ONE-TIME correction (no migration) of `messages.has_attachments` /
// `attachment_count`, which counted `inline` cid: parts as downloadable files and put a
// paperclip on well over a third of the messages it had flagged. Idempotent by candidate query rather than by a
// marker column, so there is nothing to stamp and nothing to `--force`. Emits one
// `message`/`update` change per corrected row — without that the fix never reaches a client's
// mirror. The CLI beside it is deliberately NOT exported: it opens a pool at import.
export {
  runAttachmentFlagBackfill, planAttachmentFlagBackfill,
  ATTACHMENT_FLAG_BATCH, ATTACHMENT_FLAG_MAX_PAGES,
  type AttachmentFlagBackfillDeps, type AttachmentFlagBackfillResult,
} from "./attachment-flag-backfill.js";
// The ONE-TIME REDACTION (no migration) of credentials a detector false NEGATIVE stored
// in the clear (German/EU OTPs, TANs, issued passwords the earlier detector left `no_ai = false`).

/**
 * ATTACHMENT STAGING — the SEND-FACING half of the hosted send's direct-upload transport.
 *
 * On THIS barrel and deliberately not on `./mail`: the desktop engine imports `@trafficflow/services/mail`
 * and nothing else, and a local install has no object storage to stage into. Keeping these names off
 * the mail entry point is what makes "the standalone door never stages" a fact about the import
 * graph rather than a rule somebody has to remember.
 *
 * THE STORAGE CLIENT AND THE RETENTION SWEEP ARE NOT RE-EXPORTED HERE. They live on
 * `@trafficflow/db/cloud`, because their caller is the worker's maintenance slot and the worker
 * may not depend on this package. A convenience re-export would put this barrel back in the
 * worker's import graph for a symbol that is not this package's — which is the whole failure the
 * move undid; see the header of `attachment-staging.ts`. A host that needs both imports both, and
 * `apps/api-vercel/src/deps.ts` does exactly that.
 */
export {
  makeAttachmentStagingPort, resolveStagedAttachments,
  type StagedUploadGrant, type ResolvedStagedAttachment, type StagedResolutionFailure,
} from "./attachment-staging.js";
