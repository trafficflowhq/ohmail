/**
 * THE ADMIN WIRE CONTRACT — the server's half; the staff console declares its own copy.
 *
 * The console declares the shape it renders; this declares the shape the API answers with.
 * They are the same shape, and they are written twice because a workspace PACKAGE may not
 * import from an APP — `packages/services` is consumed by the worker and by two hosts, and
 * reaching into the console app would make it a build dependency of the product's
 * backend.
 *
 * ── THE COPY IS MECHANICALLY POLICED ──────────────────────────────────────────────────────
 * A parity test parses BOTH files, and for every interface
 * declared in both it asserts the field-name sets are identical. A field added on one side and
 * not the other fails the suite on the day it is added, rather than at 3am when the console
 * renders `undefined` next to a number an operator is about to act on. The interfaces that
 * must exist on both sides are enumerated there, so deleting one is a failure too.
 *
 * ── AND THE SHAPE IS THE PRIVACY GATE ─────────────────────────────────────────────────────
 * The console's file says this and it is doubly true here, where the database is one join away:
 * there is no `subject`, no `snippet`, no `fromAddress`, no `body*`, no `payload`, no
 * `secretEnc` and no `*Hash` anywhere in this file, so no admin endpoint can express one.
 * A projection that cannot name a column cannot leak it. An api-level test
 * seeds real mail with distinctive markers and asserts none of it reaches any response.
 *
 * ── A SHAPE IS NOT ENOUGH FOR THE THREE OPEN BAGS ─────────────────────────────────────────
 * `LedgerEntry.meta` and `AuditEntry.payload`/`inverse` are `Record<string, string>` over
 * `jsonb` columns, so their FIELD NAMES bound nothing at all — the value is whatever a
 * producer wrote. A review found a real leak there (a raw RFC822 Message-ID on every
 * `debit_classify` row); it was closed in `admin-service.ts:staffMeta`, a default-deny gate on
 * both the key and the value. `StaleSend` lost `idempotencyKey` in the same change.
 *
 * ── AND THIS IS THE RENDER PATH ONLY ──────────────────────────────────────────────────────
 * "Staff never see an account's mail" demands STRUCTURAL enforcement. A projection with an
 * automated rememberer in front
 * of it is not that: the database would still answer `SELECT subject FROM messages` if this
 * process asked. The column-granted Postgres role is what makes it refuse — see
 * `admin-service.ts`. Do not read this file as the whole of the invariant.
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
 * HOW OLD A PANEL'S NUMBERS ARE, AND HOW OLD THEY ARE ALLOWED TO BE.
 *
 * The console already stamps every page with the API's `now`, which answers "when was this read
 * served". It cannot answer "when was this number COMPUTED", and for a panel backed by a
 * scheduled aggregate those are different questions with different answers: a page served this
 * second can be rendering a roll-up from three hours ago, and every existing freshness signal
 * reports it as fresh, correctly, because the READ was.
 *
 * So an aggregate-backed panel carries its own pair. `computedAt` is the producer's clock;
 * `expectedEverySeconds` is the cadence that producer runs at, which is what turns an age into a
 * verdict — three hours old is healthy for a nightly figure and an incident for an hourly one,
 * and no threshold that does not know the cadence can tell those apart.
 *
 * `computedAt: null` means the aggregate has NEVER been computed. That is a distinct state from
 * "computed a long time ago" and the console must be able to say so: on a freshly migrated
 * deployment it is the true and expected answer for one cadence, and a zero rendered in its place
 * would be a number nobody measured.
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
   * How many sinks this arm had, or NULL if it has never run.
   *
   * ZERO means it cannot page anybody — the worst state this subsystem has, and the one that
   * read greenest, because an arm that never attempts a delivery never fails one and its failure
   * streak stays at zero.
   *
   * NULL is a DIFFERENT diagnosis and used to be flattened into that zero: a driver with no pass
   * on record had this reported as 0, so the panel said "no sinks" — go and configure one — about
   * an arm whose scheduler had simply never fired, where the repair is the cron and not the sink
   * list. Zero is now reserved for a pass that ran and counted none; unknown says unknown.
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
   * How much of the advertised window these figures actually cover, and why the row exists at
   * all rather than being filtered away.
   *
   * The rule refuses to divide a partial population, and for a while this projection expressed
   * that by DROPPING such a project — which handed the console an empty list, the same answer it
   * gets from a deployment with no platform token at all. A failed poll and an unconfigured one
   * became indistinguishable, and the panel's own "sampled" rendering was made unreachable,
   * since every row that survived was by construction complete.
   *
   * So the row is emitted with its coverage and the panel says what was measured. Silence is
   * reserved for the one thing it should mean: nothing has ever been read.
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
   * must render "not queried" instead of their empty states.
   *
   * ── WHY THIS IS NOT `api.schemaOk` ────────────────────────────────────────────────────
   *
   * `api.schemaOk` probes the RUNTIME connection and answers one question: did the migration
   * land. There is a second, independent way these reads cannot run — the migration landed and
   * `harden-staff-role.sql` was not re-run, so the content-blind handle the console reads
   * through still has no grant on the new columns and tables. That is the deployment ruling's
   * first ranked risk, and in that state `schemaOk` is TRUE.
   *
   * Collapsing it into empty arrays is what made the page draw "Nothing is wrong", "No signals"
   * and "0 drivers" over reads nobody performed — the false-health rendering this whole lane
   * kept meeting. An empty list and an unanswered question are different facts and the wire has
   * to carry both, so the console is never left inferring one from the other.
   */
  alertsUnavailable: boolean;
}

/* ── accounts ──────────────────────────────────────────────────────────────────────────── */

export interface AccountSummary {
  id: string;
  name: string;
  ownerEmail: string;
  mailboxCount: number;
  mailboxesInError: number;
  /**
   * Mailboxes OUR infrastructure declined to serve — `sync_blocked_reason is not null`.
   *
   * Its own count, never folded into `mailboxesInError`, for the same reason
   * {@link MailboxHealth.syncBlockedReason} is its own bucket: one is the provider refusing the
   * customer's mailbox and the other is us not serving it, and only the second is ours to fix.
   * Disjoint from `mailboxesInError` by construction — every writer that moves `status` clears
   * both block columns in the same statement.
   *
   * A COUNT, not a boolean and not a worst-reason string. A boolean loses the roster cell's
   * number; a string would put a closed-set token on the account wire, double the narrowing
   * surface and re-open the membership-narrowing defect one level up.
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
   * WHY A `connected` MAILBOX IS NOT BEING SYNCED — a bucket DISTINCT from `lastError` (mail 0029).
   *
   * Distinct because the two answer different questions and an operator triaging a dead mailbox has
   * to be able to tell them apart. `lastError` is "the worker tried to reach this mailbox and the
   * provider refused" — the customer's problem, `status='error'`, on a retry backoff.
   * `syncBlockedReason` is "OUR infrastructure declined to serve it" — an unreadable organizer
   * lease, credentials not yet provisioned, this deployment's own mailbox cap — with `status` still
   * `connected`, no error recorded and no backoff earned. Folding it into `lastError` would file
   * our fault under the customer's — the same misattribution an earlier disk-full incident
   * taught, in a new place.
   *
   * A closed set of three (`MAILBOX_SYNC_BLOCK_REASONS`) with a CHECK behind it, so — unlike the
   * `errorDetail` half of `lastError` — no value a mail server chose can ever reach an operator's
   * screen through this field.
   *
   * **COPY ONLY. IT IS NOT THE BLOCK PREDICATE — {@link MailboxHealth.syncBlockedSince} IS.**
   * `admin-service.ts:647` narrows this column to the closed set on read, so a member the API's own
   * build does not know maps to `null` here while the timestamp beside it is forwarded verbatim.
   * A consumer that asks "is this mailbox blocked?" of THIS field answers "no" for exactly the
   * mailbox nobody is organizing.
   */
  syncBlockedReason: string | null;
  /**
   * When the current block began — **and the authoritative "this mailbox is blocked" signal.**
   *
   * THIS COMMENT USED TO SAY *"`null` whenever `syncBlockedReason` is null"*, WHICH WAS FALSE ON
   * THE WIRE. It was true of the DATABASE ROW, and the narrowing one line above it in
   * `admin-service.ts` is what breaks the implication: `{syncBlockedReason: null, syncBlockedSince:
   * <ts>}` is a legal and meaningful DTO meaning *"blocked, for a reason this API build cannot
   * name"*. The console renders it with console-authored copy of its own.
   *
   * The reverse implication is the one that holds, and it is held by CODE rather than by a
   * constraint: all five writers set and clear both columns in one statement
   * (`apps/worker/src/mailboxes.ts:743,768,826,896,919` and `mailbox-service.ts:360-362`);
   * `0029_mailbox_sync_block.sql:113` constrains membership only. **Do not "restore the symmetry"
   * by narrowing this field too** — that reinstates the defect the narrowing fix removed, and
   * this paragraph is the only thing
   * standing between the fix and its own reversal.
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
 * THE SIGNUP FUNNEL — the one thing "nobody knows" on an invite-only beta, made into counts.
 *
 * Every figure is a COUNT, never a person. The top (invites, waitlist) reads the DATE columns
 * granted in `staff-grants.ts` §funnel — issued/consumed/revoked dates and joined/invited dates,
 * no address ever. The stages read columns the role already held: `accounts`, `users.
 * email_verified_at`, `mailboxes`, `billing_subscriptions.status`.
 *
 * The stages are MONOTONIC SUBSETS of the accounts set — signed up ⊇ verified ⊇ connected ⊇
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
   * THE MAILBOX POPULATION, from `count(*) filter (…)` — not from {@link WorkerSnapshot.roster}.
   *
   * The console's customer-facing verdict counted mailboxes in error and mailboxes blocked by
   * filtering the roster array. That array is capped at 200, so on a deployment with 201
   * mailboxes the 201st cannot contribute to a fault count however broken it is — a verdict that
   * gets QUIETER as the deployment grows, which is the exact opposite of what it is for. The
   * counts come from SQL and cover every row; the roster stays capped and says so.
   *
   * `blocked` counts mailboxes that are CONNECTED and carry a `syncBlockedSince` — our
   * infrastructure declining to sync a mailbox the provider is perfectly happy with. It gates on
   * the TIMESTAMP and never on `syncBlockedReason`, because the service narrows that reason to
   * this build's closed set and a block this build cannot name would otherwise count as healthy.
   * `inError` counts every mailbox whose status is not `connected`. The two are disjoint by
   * construction, and neither is a subset of the other.
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
  actions: ActionSpec[];
  recent: AuditEntry[];
}
