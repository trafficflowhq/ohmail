/**
 * `@trafficflow/services/mail` — THE MAIL SERVICES, without the ones that make a Cloud account.
 *
 * The default barrel is the whole service layer, and it is `export *` over the auth ceremony,
 * the billing seam, invites, the waitlist and the cross-account admin reads. Importing one mail
 * service from it therefore loads all of them, which is free inside a server we deploy whole and
 * is not free when the same package is compiled into something we hand to a stranger.
 *
 * Measured rather than assumed: bundling the local engine against the default barrel put 29
 * private-half modules in the artifact, including the whole auth ceremony and (at the time) the
 * Stripe client — the Stripe machinery has since moved out of this repository entirely, into
 * its own billing service, but the billing seam and the ceremony still live behind the default
 * barrel. Tree-shaking does not remove them — a barrel re-exports live bindings, so the bundler
 * keeps them — which is why this is a second entry point and not a build flag.
 *
 * ── WHAT IS ABSENT, AND WHY EACH ONE ──────────────────────────────────────────────────────
 *
 *  · `auth/index.js` — the CEREMONY: registration, password verification, the lockout, WebAuthn,
 *    TOTP, recovery codes, OAuth, devices. A local engine has no registration and no second
 *    factor; the machine's own login is the boundary. See below for the two pieces that stay.
 *  · `entitlements/index.js` — the billing seam. Cloud is what you pay for; the desktop tier is
 *    free and has no signup. (The Stripe machinery itself is not in this repository at all —
 *    it lives in a separate billing service.)
 *  · `invites.js` / `waitlist-service.js` — there is no funnel to join on your own laptop.
 *  · `admin-dto.js` / `admin-service.js` — the only cross-account reader in the repo. An operator
 *    surface on a single user's machine is nothing but attack surface.
 *  · `mail/index.js` — transactional mail. The engine talks to the user's own server; it
 *    never sends on our behalf.
 *  · `ip-throttle.js`, `account-deletion-service.js`, `hey-migration.js`, `mailbox-allowance.js`,
 *    `learning-service.js`, and the two one-time backfills — every one of them is a hosted-service
 *    operation. Deleting the data directory is the erasure here, and the plan limit is Cloud's.
 *
 * ── AND THE TWO AUTH MODULES THAT DO STAY ─────────────────────────────────────────────────
 *
 * `withSession` resolves a bearer token against the `sessions` table, and the engine mints one
 * session per launch. So session RESOLUTION is mail infrastructure, not ceremony: without it the
 * local API has no way to tell its own shell from anything else that reaches the pipe.
 *
 * What stays is therefore `resolve-session.js` (look up a session by token hash) and the config
 * validator, plus the primitives they are built from. What does not is every module that
 * ESTABLISHES a session: nothing here can register an account, verify a password, or enrol a
 * factor.
 */

export const SERVICES_VERSION = "0.0.0";

export { ServiceError, IdempotencyRaceLost } from "./errors.js";
export type { ServiceContext, Db } from "./context.js";
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
export {
  resetScreeningState, unmovedReport, type ResetResult, type UnmovedPile,
} from "./consent-reset.js";
export {
  DEFAULT_DORMANCY_DAYS, cutlineCounts, hasUndecidedActiveSenders,
  type CutlineCounts, type CutlineOptions,
} from "./consent-cutline.js";
// The editable Ohbox preference: posture + free-text bar on account_settings.
// Mail-half clean — it reads/writes `account_settings` (schema-mail) and resolves the policy through
// `@trafficflow/core/mail`; no auth, billing or admin dependency, so it belongs in the engine barrel
// exactly as it does in the default one. The hosted `/account/screening` route imports it from here.
export {
  getScreeningPreference, setScreeningPreference, resolveOhboxPolicy,
  DEFAULT_OHBOX_BAR, OHBOX_BAR_MAX_BYTES, OHBOX_POLICIES,
  type ScreeningPreference, type ScreeningPreferenceUpdate,
} from "./screening-preference.js";


export {
  MailboxService, makeMailboxService, mailboxService, decryptCredential,
  type CreateMailboxBody, type UpdateMailboxBody, type TransportInput, type MailboxServiceDeps,
  // Cloud 0009 — the OAuth consent flow's write end. `connectOAuth` resolves its target row
  // by ADDRESS (the `id_token` claim), so these types carry no `mailboxId`.
  type ConnectOAuthMailboxInput, type ConnectOAuthOptions, type ConnectOAuthResult,
  type MailboxProbe, type MailboxProbeInput, type MailboxProbeVerdict,
  type SmtpProbe, type SmtpProbeInput, type ProbeTransport,
  type ProbeTlsDetail, type ProbeTlsFailureKind, type ProvenEndpoint,
  // The gate's TYPE, so a host can state its tier. No permissive VALUE is exported from this
  // package — the only one that exists is in `apps/sidecar`, where the hosted API cannot name it.
  type MailboxAllowancePolicy,
} from "./mailbox-service.js";
// The plan-limit gate the mailbox write path runs inside its transaction.
/* PUSH: the TYPES only, never the class or the singleton — and from the module that holds only
 * types, which is the part that changed. The implementation reads and writes a subscriptions
 * table the hosted journal creates and a local database does not have, so the real service could
 * never work here; a value import of it would additionally put the hosted schema into the shipped
 * engine bundle.
 *
 * Naming its module even in a type position was still a disclosure and still an import a public
 * checkout could not resolve, so the vocabulary and the port now live apart from the service. The
 * local build supplies its own refusing stand-in against the port, and the implementation declares
 * `implements` against it so the two cannot drift. */
export type {
  PushService,
  PushSubscribeBody, PushSubscribeResult, PushIdempotency, PushTransport,
} from "./push-types.js";
export {
  // `BODIES_IDS_MAX` is exported because a CALLER has to respect it: the desktop mirror batches its
  // body requests and the server REFUSES an over-long id list rather than truncating it, so the cap
  // is shared rather than copied — a change here cannot leave a client asking for one too many.
  MessageService, messageService, MARK_SEEN_MAX_IDS, BODIES_IDS_MAX,
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
// mail port in the module; the auth verdict it persists is demote-only — it can never promote.
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
  ScheduleService, scheduleService, SCHEDULE_MAX_AHEAD_MS,
} from "./schedule-service.js";
export {
  runScheduledSendPass, SCHEDULED_SEND_BATCH, SCHEDULED_SEND_EXPIRY_MS,
  type ScheduledSendPassDeps, type ScheduledSendPassResult,
} from "./schedule-send-pass.js";
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
// `proposals-service.js` is deliberately ABSENT. It is the only mail-shaped service that reaches
// for `@trafficflow/core`'s default barrel, because the proposer it wraps calls the classifier and
// the drafter. Re-exporting it here would pull the taxonomy and drafting prompts back into every
// artifact built from this entry point — which is the one thing this file exists to prevent.
// A host that wants proposals builds them from `@trafficflow/services`.
// Art. 17 erasure. Anonymisation, not DELETE — the reasoning is in the file.
// Blocking precondition for the "delete your account anytime"
// sentence on the landing page.

// ── SESSION RESOLUTION ONLY — see the header. Never `./auth/index.js`, which is the ceremony.
export {
  scryptHasher, generateToken, hashToken, sha256, StaticKeyProvider,
  type PasswordHasher, type KeyProvider,
} from "./auth/crypto.js";
export { DEFAULT_AUTH_CONFIG, makeAuthConfig } from "./auth/config.js";
export { resolveSession, type ResolvedSessionCore, type SessionScope } from "./auth/resolve-session.js";
export {
  allowedOrigins, assertOriginConfig, defaultOrigin, isAllowedOrigin,
  normalizeOrigin, tryNormalizeOrigin, resolveCeremonyOrigin,
} from "./auth/origins.js";
/* THE CONFIGURATION SHAPE ONLY, and from the leaf that holds it rather than from the ceremony's
 * module. `AuthDeps` is deliberately absent: it carries the transactional mailer, so exporting it
 * from this mail-half entry point would make every consumer of the entry point name the hosted
 * mail service. Nothing built from here constructs an auth service — it resolves a session, which
 * needs the configuration and no dependencies at all. */
export type { AuthConfig, SessionSurface } from "./auth/config-types.js";
