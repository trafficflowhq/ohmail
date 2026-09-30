/**
 * The admin wire contract — the server's half; the staff console declares its own copy (a
 * workspace package may not import from an app). A parity test parses BOTH files and asserts
 * identical field-name sets for every shared interface. The shape is the privacy gate: no
 * `subject`, `snippet`, `fromAddress`, `body*`, `payload`, `secretEnc` or `*Hash` anywhere here,
 * so no admin endpoint can express one; an api-level test seeds marked mail and asserts none
 * reaches any response. The `jsonb` bags (`LedgerEntry.meta`, `AuditEntry.payload`/`inverse`)
 * bound nothing — a real leak there is closed by `admin-service.ts` `staffMeta`, a default-deny
 * gate. Render path only: the column-granted Postgres role makes the database itself refuse.
 */

/* ── shared vocabulary ─────────────────────────────────────────────────────────────────── */

export type AdminSeverity = "ok" | "warn" | "bad" | "idle";
export type AdminAlertKind =
  | "worker_down" | "sends_stuck" | "sync_lag" | "storage_at_cap"
  | "device_sync_stale"
  | "session_sync_stale" | "session_reuse_revoked"
  // This union is a MIRROR of `AlertKind` in `alerts.ts`, and a census in the console's own suite
  // asserts the two are equal in BOTH directions — a kind this DTO cannot carry stops
  // `admin-service.ts` compiling, and a kind named here that no rule produces is dead vocabulary
  // on the wire that reads as coverage. Only the first of those is a type error, which is why the
  // census is not left to the compiler. The five subscription and credit-accounting kinds left
  // with the rules that emitted them; whoever operates a metered service watches those there.
  | "worker_degraded" | "api_5xx_rate" | "schema_behind" | "imap_admission_refused"
  | "ai_provider_down" | "alert_driver_dark" | "credential_replay_wide"
  | "session_refresh_replayed"
  // Cloud 0033's two first-party rules, read from `api_faults`: one route answering 5xx above a
  // floor, and the pooled-acquire ceiling refusing work. `api_5xx_rate` above them counts what
  // the PLATFORM served and needs a vendor token; these two need none and name the route.
  | "api_fault_rate" | "pooler_refusals";
/**
 * INCIDENT or SIGNAL — the class that decided whether this row went to a sink.
 *
 * The console splits its Reliability page on this and nothing else: incidents are the ones that
 * page, signals are informational. It is on the wire rather than re-derived from `kind` because
 * two rules compute it from POPULATION — the same lagging-sync condition is a signal at two
 * accounts and an incident at twenty — so a console-side lookup table would disagree with the
 * pager exactly when the answer matters.
 */
export type AdminAlertClass = "incident" | "signal";
export type AdminMailboxStatus = "connected" | "error" | "disabled";
/**
 * How old a panel's numbers are, and how old they are allowed to be. The API's `now` answers
 * "when was this read served", not "when was this number COMPUTED" — a page served this second
 * can render a roll-up from three hours ago and every freshness signal reports it fresh,
 * correctly. So an aggregate-backed panel carries its own pair: `computedAt` is the producer's
 * clock; `expectedEverySeconds` is that producer's cadence, which turns an age into a verdict —
 * three hours is healthy for a nightly figure and an incident for an hourly one. `computedAt:
 * null` means NEVER computed, distinct from "computed long ago": on a freshly migrated deployment
 * it is the true answer, and a zero in its place would be a number nobody measured.
 */
export interface PanelFreshness {
  computedAt: string | null;
  expectedEverySeconds: number;
}

export type AdminAccountFilter = "all" | "attention";
export type AdminActionId = "resync_mailbox" | "retry_send";

/* ── overview ──────────────────────────────────────────────────────────────────────────── */

export interface KekIdentity {
  active: number;
  count: number;
  fingerprint: string;
}

export interface ApiHealth {
  host: string;
  status: number;
  ok: boolean;
  version: string;
  dbLatencyMs: number | null;
  dbReachable: boolean;
  pgTrgm: boolean;
  schemaOk: boolean;
  schemaMarkers: { found: number; expected: number; through: string };
  cookieAuth: boolean;
  kek: KekIdentity | null;
  error: string | null;
  errorDetail: string | null;
  checkedAt: string;
}

export interface WorkerInstanceHealth {
  instanceId: string;
  host: string | null;
  leader: boolean;
  standby: boolean;
  healthy: boolean;
  degraded: boolean;
  mailboxes: number;
  expected: number;
  accounts: number;
  quarantined: number;
  awaitingCredentials: number | null;
  truncated: number | null;
  lastCycleAt: string | null;
  lagSeconds: number | null;
  shard: { index: number; shards: number };
  kek: KekIdentity | null;
  error: string | null;
  startedAt: string;
}

export interface AlertSummary {
  key: string;
  kind: AdminAlertKind;
  severity: AdminSeverity;
  title: string;
  detail: string;
  count: number;
  openedAt: string;
  notifiedAt: string | null;
  /**
   * When an evaluation last CONFIRMED this condition (`alert_state.last_seen_at`): now for a rule
   * this read evaluated, the row's stamp for one it could not — a sampled window, another arm's
   * rule — so an unmeasured alert shows its age instead of reading as healthy.
   */
  lastConfirmedAt: string;
  /** Whether this row was delivered to a sink. See {@link AdminAlertClass}. */
  cls: AdminAlertClass;
  /**
   * How many ACCOUNTS this affects, or null when the rule does not measure a population.
   *
   * NOT `count`, which the two differ on exactly where it matters: `sync_lag`'s count is
   * MAILBOXES, and forty lagging mailboxes on one account is a different incident from forty on
   * forty. null is not 0 — "one deployment-wide fact" and "counted accounts, found none" are
   * different claims and the console renders them differently.
   */
  affectedAccounts: number | null;
  /**
   * The console path an operator should open to act on this — `/worker`, `/accounts/<id>`.
   * A literal composed by the rule with, at most, an id interpolated in; rendered as a link and
   * never fetched.
   */
  fixHref: string | null;
}

/**
 * ONE ALERT DRIVER'S LAST PASS — rendered for BOTH arms, always, on the Reliability page.
 *
 * The pair of drivers exists because a process cannot report its own death, and this is how a
 * person checks the pair is actually a pair. `ranAt: null` means the arm has NEVER recorded a
 * pass, which the console renders as "never" rather than omitting the row: an absent arm and an
 * arm that has never run read identically to a person and mean opposite things.
 */
export interface AdminAlertDriver {
  driver: "worker" | "api";
  ranAt: string | null;
  firing: number;
  delivered: number;
  failedSinks: number;
  sinkFailureStreak: number;
  /**
   * How many sinks this arm had, or NULL if it has never run. ZERO means it cannot page anybody —
   * the worst state this subsystem has, and the one that read greenest: an arm that never
   * attempts a delivery never fails one. NULL is a DIFFERENT diagnosis and used to be flattened
   * into that zero: a driver with no pass on record reported 0, so the panel said "no sinks" —
   * configure one — about an arm whose scheduler had never fired, where the repair is the cron.
   * Zero is reserved for a pass that ran and counted none; unknown says unknown.
   */
  sinksConfigured: number | null;
}

/**
 * WHAT THE PLATFORM SERVED over the 5xx rule's own window, per project.
 *
 * AN EMPTY LIST IS THE UNCONFIGURED STATE and the console renders it as "5xx: not measured". It
 * is neither a failure nor a zero: a deployment with no platform token writes no rows at all, so
 * there is no row here saying 0 that could be mistaken for a measurement. That distinction is the
 * ruling's second ranked risk, and it is preserved by this being a list of what EXISTS rather
 * than a figure per known project.
 */
export interface AdminPlatformSignal {
  provider: string;
  project: string;
  requests: number;
  errors5xx: number;
  /** The counts are a lower bound over the window's newest slice — the panel says "sampled". */
  truncated: boolean;
  /**
   * How much of the advertised window these figures actually cover, and why the row exists rather
   * than being filtered away. The rule refuses to divide a partial population, and for a while
   * this projection expressed that by DROPPING such a project — handing the console an empty
   * list, the same answer as a deployment with no platform token at all: a failed poll and an
   * unconfigured one became indistinguishable, and the panel's "sampled" rendering was
   * unreachable. So the row is emitted with its coverage and the panel says what was measured;
   * silence is reserved for "nothing has ever been read".
   */
  completeBuckets: number;
  sampledBuckets: number;
  expectedBuckets: number;
  /**
   * WHY the samples in this window stopped — the closed set in `SAMPLE_CAUSES`, distinct.
   *
   * The panel used to describe every sample as page-budget exhaustion, which was one of six
   * causes and increasingly the rarest, so an operator was sent to a limit that was not
   * involved. The sentence is keyed on these values and an unknown one fails a test.
   */
  sampleCauses: string[];
  fetchedAt: string;
}

export interface OverviewSnapshot {
  now: string;
  environment: string;
  api: ApiHealth;
  worker: {
    instances: WorkerInstanceHealth[];
    leaderStaleAfterSeconds: number;
  };
  alerts: AlertSummary[];
  /** Both alert drivers' last pass — ALWAYS two entries. See {@link AdminAlertDriver}. */
  alertDrivers: AdminAlertDriver[];
  /** The 5xx window per project. EMPTY = unconfigured — see {@link AdminPlatformSignal}. */
  platformSignals: AdminPlatformSignal[];
  /**
   * TRUE when the three alert reads above were SKIPPED rather than answered, so the console
   * renders "not queried" instead of their empty states. Not `api.schemaOk`: that probes the
   * runtime connection and answers "did the migration land". There is a second, independent way
   * these reads cannot run — the migration landed and `harden-staff-role.sql` was not re-run, so
   * the content-blind handle still has no grant on the new columns; in that state `schemaOk` is
   * TRUE. Collapsing it into empty arrays drew "Nothing is wrong" and "0 drivers" over reads
   * nobody performed. An empty list and an unanswered question are different facts, and the wire
   * carries both.
   */
  alertsUnavailable: boolean;
  /**
   * The rules this read did not evaluate, and why: `no_reader` (this host composes no input for
   * it — the console runs no at-cap reader), `refused` (the blind role holds no grant for it) or
   * `partial`. A rule named here is not "nothing wrong"; the console says which it is.
   */
  alertsUnread: AdminAlertUnread[];
}

/** One rule the console's read did not evaluate, with the reason. */
export interface AdminAlertUnread {
  kind: AdminAlertKind;
  reason: "no_reader" | "refused" | "partial";
}

/* ── accounts ──────────────────────────────────────────────────────────────────────────── */

export interface AccountSummary {
  id: string;
  name: string;
  ownerEmail: string;
  mailboxCount: number;
  mailboxesInError: number;
  /**
   * Mailboxes OUR infrastructure declined to serve — `sync_blocked_reason is not null`. Its own
   * count, never folded into `mailboxesInError`: one is the provider refusing the customer's
   * mailbox, the other is us not serving it, and only the second is ours to fix. Disjoint from
   * `mailboxesInError` by construction — every writer that moves `status` clears both block
   * columns in one statement. A COUNT, not a boolean and not a worst-reason string: a boolean
   * loses the roster cell's number; a string would put a closed-set token on the account wire and
   * re-open the membership-narrowing defect one level up.
   */
  mailboxesBlocked: number;
  syncLagSeconds: number | null;
  lastActivityAt: string | null;
  createdAt: string;
}

export interface AccountQuery {
  search?: string;
  filter?: AdminAccountFilter;
  page?: number;
  pageSize?: number;
}

export interface AccountPage {
  now: string;
  accounts: AccountSummary[];
  matched: number;
  total: number;
  page: number;
  pageSize: number;
}

export interface MailboxHealth {
  id: string;
  accountId: string;
  address: string;
  displayName: string | null;
  provider: string;
  authKind: "password" | "oauth";
  status: AdminMailboxStatus;
  lastSyncAt: string | null;
  syncLagSeconds: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /**
   * Why a `connected` mailbox is not being synced — a bucket DISTINCT from `lastError` (mail
   * 0029). `lastError` is "the provider refused" — the customer's problem, `status='error'`, on
   * backoff. `syncBlockedReason` is "OUR infrastructure declined", with `status` still
   * `connected`. Folding them would file our fault under the customer's. A closed set of three
   * (`MAILBOX_SYNC_BLOCK_REASONS`) with a CHECK behind it, so no value a mail server chose
   * reaches an operator's screen here. COPY ONLY — the block predicate is {@link
   * MailboxHealth.syncBlockedSince}: the service narrows this column on read, so a member this
   * build does not know maps to `null` while the timestamp is forwarded verbatim.
   */
  syncBlockedReason: string | null;
  /**
   * When the current block began — and the authoritative "this mailbox is blocked" signal. NOT
   * "`null` whenever `syncBlockedReason` is null": that is true of the database row and false on
   * the wire — `{syncBlockedReason: null, syncBlockedSince: <ts>}` is a legal DTO meaning
   * "blocked, for a reason this API build cannot name", rendered with console-authored copy. The
   * reverse implication holds, by CODE: all five writers set and clear both columns in one
   * statement (`apps/worker/src/mailboxes.ts`, `mailbox-service.ts`); the migration constrains
   * membership only. Do not "restore the symmetry" by narrowing this field too — that reinstates
   * the defect the narrowing fix removed.
   */
  syncBlockedSince: string | null;
  retryBackoffSeconds: number | null;
  pendingMoves: number;
  oldestPendingMoveSeconds: number | null;
  hasImapCredential: boolean;
}

export interface AccountDetail {
  now: string;
  account: AccountSummary;
  mailboxes: MailboxHealth[];
  audit: AuditEntry[];
  /**
   * The account's SECURITY events — `auth_events` rows whose event names an incident rather
   * than activity. Today that is exactly `refresh_reuse_revoked` (the rotation's reuse branch
   * swept a session family: a stolen token replayed, or a client rotating wrongly — silent on
   * every user surface, which is why it is on this one). Names and timestamps only, per the
   * staff allowlist; the family id lives in the row's un-granted `device` column and is read
   * over a privileged database connection when an investigation needs it. Newest first.
   */
  securityEvents: SecurityEvent[];
}

/** One row of {@link AccountDetail.securityEvents} — a closed event name and its moment. */
export interface SecurityEvent {
  id: string;
  event: "refresh_reuse_revoked";
  at: string;
}

/**
 * The signup funnel — the one thing "nobody knows" on an invite-only beta, made into counts.
 * Every figure is a COUNT, never a person: the top (invites, waitlist) reads only the DATE
 * columns granted in `staff-grants.ts`, no address ever; the stages read columns the role already
 * held. The stages are MONOTONIC SUBSETS of the accounts set — signed up ⊇ verified ⊇ connected ⊇
 * subscribed — so the drop-off between two is an honest conversion, not a comparison of unlike
 * populations.
 */
export interface FunnelStage {
  key: "signup" | "verified" | "connected" | "subscribed";
  label: string;
  count: number;
  /** Conversion from the previous stage, 0..1. `null` on the first stage. */
  ofPrevious: number | null;
}

export interface FunnelSnapshot {
  now: string;
  /** Invite ledger, as counts. `outstanding = issued − accepted − revoked`. */
  invites: { issued: number; accepted: number; revoked: number; outstanding: number };
  /** Waitlist, as counts. `waiting` have no `invited_at`; `invited` do. */
  waitlist: { waiting: number; invited: number };
  /** signup → verified → connected → subscribed, each a subset of the one before it. */
  stages: FunnelStage[];
  /** Signups per ISO week, oldest first — the top-of-funnel trend. `weekStart` is a Monday. */
  signupsByWeek: Array<{ weekStart: string; count: number }>;
}

/* ── worker ────────────────────────────────────────────────────────────────────────────── */

export interface CronPass {
  id: string;
  module: string;
  description: string;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: "ok" | "partial" | "failed" | "never";
  detail: string | null;
}

/**
 * An `outbound_sends` row stuck in `pending`. Identified by its own id and its age.
 *
 * NOTE WHAT IS ABSENT: `idempotencyKey`. That column holds the CLIENT's
 * `Idempotency-Key` header verbatim — caller-chosen free text, unvalidated and unbounded — so
 * a client that keyed a send by its subject would have rendered subjects on a staff screen.
 * `id` identifies the row 1:1 and is the handle a retry would take, so nothing was lost.
 */
export interface StaleSend {
  id: string;
  accountId: string;
  accountName: string;
  status: "pending" | "unverified";
  createdAt: string;
  ageSeconds: number;
}

export interface WorkerSnapshot {
  now: string;
  instances: WorkerInstanceHealth[];
  /**
   * The mailbox roster, CAPPED — the first `ADMIN_ROSTER_LIMIT` by address. Beyond that cap this
   * list is a sample and must be labelled as one; {@link WorkerSnapshot.rosterCounts} is what a
   * count is read from.
   */
  roster: Array<MailboxHealth & { accountName: string }>;
  /**
   * The mailbox population, from `count(*) filter (…)` — not from {@link WorkerSnapshot.roster}.
   * The verdict once counted faults by filtering the roster array, which is capped at 200, so on
   * a deployment with 201 mailboxes the 201st could not contribute however broken — a verdict
   * that gets QUIETER as the deployment grows. The counts come from SQL and cover every row; the
   * roster stays capped and says so. `blocked` counts CONNECTED mailboxes carrying
   * `syncBlockedSince` — gated on the TIMESTAMP, never the narrowed reason, so a block this build
   * cannot name still counts. `inError` counts every mailbox not `connected`; the two are
   * disjoint, neither a subset.
   */
  rosterCounts: { total: number; inError: number; blocked: number };
  crons: CronPass[];
  pendingMoves: { total: number; mailboxes: number; oldestSeconds: number | null };
  staleSends: StaleSend[];
  thresholds: { staleSendSeconds: number; syncLagSeconds: number; leaderStaleSeconds: number };
}

/* ── actions + audit ───────────────────────────────────────────────────────────────────── */

export interface AuditEntry {
  id: string;
  accountId: string;
  accountName: string;
  action: string;
  payload: Record<string, string>;
  inverse: Record<string, string> | null;
  actor: string;
  createdAt: string;
}

export interface ActionSpec {
  id: AdminActionId;
  title: string;
  summary: string;
  effects: string[];
  target: { label: string; placeholder: string; options: Array<{ id: string; label: string }> };
  requiresNote: boolean;
  available: boolean;
  unavailableReason: string | null;
  auditPreview: { action: string; payload: Record<string, string>; inverse: Record<string, string> | null };
}

export interface ActionCatalog {
  now: string;
  precondition: string;
  /**
   * How recent a staff second factor has to be for a WRITE to run, in seconds. On the wire
   * because the console renders its own sentence from it: the surface states what the handler
   * enforces (`STAFF_STEP_UP_WINDOW_SECONDS`), and never the other way round.
   */
  stepUpWindowSeconds: number;
  actions: ActionSpec[];
  recent: AuditEntry[];
}

/* ── staff roles and the staff audit (cloud 0047) ──────────────────────────────────────── */

/** A staff role. `owner` implies every other; roles are read live on every request. */
export type StaffRole = "support" | "billing" | "ops" | "owner";

/**
 * What an operator did, as `staff_audit_events.action` records it — a closed set with the
 * same members as `STAFF_AUDIT_ACTIONS` in `staff-audit-detail.ts`.
 */
export type StaffAuditAction =
  | "read.overview" | "read.roster" | "read.search" | "read.account" | "read.account.activity"
  | "read.sync_roster" | "read.funnel" | "read.worker" | "read.actions"
  | "read.oauth_provider" | "assert.external" | "write.mailbox.resync" | "write.oauth_provider"
  | "staff.signin" | "staff.signin_failed" | "staff.stepup" | "staff.stepup_failed"
  | "staff.signout" | "staff.role_grant" | "staff.role_revoke" | "staff.totp_reset";

export type StaffAuditOutcome = "ok" | "no_change" | "refused" | "failed";

export type StaffReasonCode =
  | "customer_request" | "incident" | "billing_dispute" | "fraud_or_abuse" | "ops_maintenance" | "legal";

/**
 * One `staff_audit_events` row as the console renders it. `detail` holds closed-set scalars
 * only (the per-action allowlist in `staff-audit.ts`); the search term is never stored, only
 * its keyed hash, and that hash does not travel.
 */
export interface StaffEvent {
  id: string;
  at: string;
  requestId: string;
  staffUserId: string;
  actorLabel: string;
  roles: StaffRole[];
  action: StaffAuditAction;
  outcome: StaffAuditOutcome;
  refusalCode: string | null;
  reasonCode: StaffReasonCode | null;
  ticketRef: string | null;
  targetAccountId: string | null;
  targetUserId: string | null;
  targetMailboxId: string | null;
  resultCount: number | null;
  audience: string | null;
  detail: Record<string, string | number | boolean | null>;
}

/** `GET /admin/accounts/:id/staff-activity`. `views` (the reads) is present for `owner` only. */
export interface StaffActivityPage {
  now: string;
  actions: StaffEvent[];
  views?: StaffEvent[];
  nextCursor: string | null;
}

/* ── search, batch and the sync roster ─────────────────────────────────────────────────── */

export type AdminSearchMatchedOn =
  | "account_id" | "account_id_prefix" | "user" | "mailbox"
  | "login_address" | "mailbox_address" | "mailbox_domain" | "account_name";

/**
 * One account a search found, and which exact rule found it. Matches are exact or prefix,
 * never a substring. `label` carries the account's first login address, masked for `ops`.
 */
export interface AdminSearchResult {
  accountId: string;
  matchedOn: AdminSearchMatchedOn;
  label: string;
  erasedAt: string | null;
}

/** `GET /admin/search?q=` — at most 25 results; `truncated` says more matched. */
export interface AdminSearchPage {
  now: string;
  results: AdminSearchResult[];
  truncated: boolean;
}

/** `GET /admin/accounts?ids=` — rows in the order asked; ids with no account listed apart. */
export interface AccountBatch {
  now: string;
  rows: AccountSummary[];
  unknownIds: string[];
}

/**
 * The open server's sync facts for one account, for joining against another program's view.
 * `releasedNoHolder` counts mailboxes whose organizer released them with nobody holding the
 * lease since: `organizer_role = 'reader'`, `organizer_released_at` set, state not `held`.
 */
export interface OpenSyncFacts {
  accountId: string;
  mailboxes: number;
  disabled: number;
  blockedAccountClosed: number;
  oldestBlockedSince: string | null;
  releasedNoHolder: number;
  oldestReleasedAt: string | null;
  lastSyncMax: string | null;
  lastClosedNoticeAnchor: string | null;
  lastReopenedNoticeAnchor: string | null;
  erasedAt: string | null;
}

/** `GET /admin/sync-roster?cursor=&limit=` — keyset by account id; `nextCursor` null at the end. */
export interface SyncRosterPage {
  now: string;
  rows: OpenSyncFacts[];
  nextCursor: string | null;
  workerRosterIntervalSeconds: number;
}

/* ── the account page, v2 ──────────────────────────────────────────────────────────────── */

export interface AdminAccountRecord extends AccountSummary {
  erasedAt: string | null;
}

/** A login on the account. `lastLoginAt` is always null until the security block ships. */
export interface AdminAccountUser {
  id: string;
  email: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  lastLoginAt: null;
}

/**
 * A mailbox with its organizer facts — closed sets and timestamps only. The holder's display
 * name, install id and capabilities are never read: each is a header value off the lease
 * message, which anything able to write to the mailbox can choose. `consentOnRecord` is
 * `organize_consented_at` set.
 */
export interface AdminMailboxDetail extends MailboxHealth {
  createdAt: string;
  organizerRole: string;
  organizerState: string | null;
  organizedByKind: string | null;
  organizedSince: string | null;
  organizerReleasedAt: string | null;
  releaseRequestedAt: string | null;
  releaseRefusal: string | null;
  takeoverAuthorizedAt: string | null;
  takeoverIntent: string;
  consentOnRecord: boolean;
  disabledReason: string | null;
  retryAfter: string | null;
  syncProgressAt: string | null;
}

export interface AdminLifecycleNotice {
  kind: "trial_two_days" | "closed" | "erasure_week" | "reopened";
  anchor: string;
  sentAt: string;
}

export interface AdminDevice {
  id: string;
  kind: string;
  pairedAt: string;
  lastSyncedAt: string | null;
}

/** Session counts: live now by scope, revoked in the last 30 days, and the newest activity. */
export interface AdminSessionFacts {
  active: { full: number; enrollment: number };
  revoked30d: number;
  lastSeenAt: string | null;
}

/** One `auth_events` row from the last 30 days — the event name and its moment. */
export interface AdminAuthEvent {
  userId: string | null;
  event: string;
  at: string;
}

/** Credit reversals this server owes the entitlements program and has not settled. */
export interface AdminOwedReversals {
  count: number;
  oldestOwedAt: string;
  tries: number;
  lastFault: string | null;
}

/**
 * `GET /admin/accounts/:id`. A superset of {@link AccountDetail}: `audit` and
 * `securityEvents` stay so a console reading the older shape keeps working. `staffActions` is
 * the last 20 non-read staff events on this account; `ownerEmail` and every user's `email` are
 * masked for the `ops` role.
 */
export interface AccountDetailV2 {
  now: string;
  account: AdminAccountRecord;
  users: AdminAccountUser[];
  mailboxes: AdminMailboxDetail[];
  lifecycleNotices: AdminLifecycleNotice[];
  storage: { bytes: number; updatedAt: string } | null;
  devices: AdminDevice[];
  sessions: AdminSessionFacts;
  authEvents: AdminAuthEvent[];
  owedReversals: AdminOwedReversals | null;
  staffActions: StaffEvent[];
  audit: AuditEntry[];
  securityEvents: SecurityEvent[];
}

/* ── the staff assertion mint ──────────────────────────────────────────────────────────── */

/** One request an assertion is minted for: the method, the path with its query, the body hash. */
export interface StaffAssertionRequest {
  method: string;
  path: string;
  bodySha256: string;
}

/**
 * `POST /admin/staff/assertion` — one assertion per request, in the order asked. The console
 * chooses the header that carries each one; this API names none.
 */
export interface StaffAssertionAnswer {
  assertions: string[];
  expiresAt: string;
  kid: string;
  tier: 0 | 1 | 2;
}

/** `POST /admin/staff/whoami`'s identity, with the roles read live for this request. */
export interface StaffWhoami {
  ok: true;
  email: string;
  roles: StaffRole[];
  stepUpWindowSeconds: number;
  stepUpFresh: boolean;
}
