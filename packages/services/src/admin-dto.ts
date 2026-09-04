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
  | "worker_down" | "billing_events_failed" | "sends_stuck" | "sync_lag" | "storage_at_cap"
  | "billing_reconciliation_divergence" | "billing_reconciliation_stale" | "device_sync_stale"
  | "session_sync_stale" | "session_reuse_revoked"
  // Cloud 0030's reliability rules. This union is a MIRROR of `AlertKind` in `alerts.ts`, and a
  // census in the console's own suite asserts the two are equal in BOTH directions — a kind this
  // DTO cannot carry stops `admin-service.ts` compiling, and a kind named here that no rule
  // produces is dead vocabulary on the wire that reads as coverage. Only the first of those is a
  // type error, which is why the census is not left to the compiler.
  | "worker_degraded" | "api_5xx_rate" | "schema_behind" | "imap_admission_refused"
  | "ai_provider_down" | "credit_rollup_stale" | "alert_driver_dark" | "credential_replay_wide"
  // A metered model call was billed to an account on a day the cost table recorded nothing for
  // any host — the recorder is injected, so a composition site left on its default logs the call
  // and writes no row, and the only visible trace is a debit with no cost beside it.
  | "ai_usage_unrecorded";
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
export type AdminPlan = "solo" | "plus" | "pro";
/** All eight `billing_subscriptions.status` values (migration 0018's CHECK) plus `none`. */
export type AdminSubscriptionStatus =
  | "none" | "trialing" | "active" | "past_due" | "unpaid" | "paused"
  | "canceled" | "incomplete" | "incomplete_expired";
/**
 * Every `credit_ledger.reason` the database can write, and it has to be EVERY one.
 *
 * The console's liability panel sums the ledger by reason and then reconciles the sum against
 * `credit_balances` — the one figure on the page that can falsify the page's own arithmetic. A
 * reason missing from this union is a reason missing from that sum, so the reconciliation reports
 * a DRIFT for a database that is perfectly healthy, on the check an operator trusts most.
 * `trial_grant` (cloud 0011) is the reason that taught this list it has to be exhaustive.
 */
export type AdminLedgerReason =
  | "invoice_grant" | "refund" | "adjustment_credit" | "trial_grant" | "period_expiry"
  | "debit_classify" | "debit_draft" | "debit_propose" | "debit_workflow" | "adjustment_debit";
/** The two places a credit can be spent, and they never sum — separate money, separate expiries. */
export type CreditPool = "ledger" | "setup";

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

export type AdminAccountFilter = "all" | "attention" | "suspended" | "past_due" | "no_subscription";
export type AdminActionId = "suspend_account" | "resume_account" | "resync_mailbox" | "retry_send";

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
  plan: AdminPlan | null;
  subscription: AdminSubscriptionStatus;
  suspendedAt: string | null;
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
  mailboxLimit: number;
  creditBalance: number;
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
  entitlements: {
    mailboxLimit: number;
    monthlyCredits: number;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
    /**
     * The account's screening-only setup pool, or `null` when it holds none.
     *
     * `kind` is `'account'` for a pool granted under the one-per-account rule and `'mailbox'` for
     * the historical per-mailbox pools; the console shows it because "this account has three
     * old-style pools" and "this account has one" are different support answers and the size
     * alone cannot distinguish them. `granted`/`remaining` are the account's TOTAL across its
     * live pools, and `expiresAt` the furthest horizon — the same composition `setupPoolOf`
     * makes for the customer's own settings row, so staff and customer read one number.
     */
    setupCredits: SetupPoolView | null;
  };
  /**
   * Credit usage — day-grained aggregates plus the raw non-debit events, replacing the raw
   * fifty-row ledger read this field used to be. See {@link AccountUsage}.
   */
  usage: AccountUsage;
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

/** The setup pool as the console shows it — a size, a remainder, a horizon. No mailbox id. */
export interface SetupPoolView {
  kind: "mailbox" | "account";
  granted: number;
  remaining: number;
  expiresAt: string | null;
}

/**
 * ONE DAY OF ONE ACCOUNT'S CREDIT MOVEMENT, in one pool, for one reason.
 *
 * `credits` carries the ledger's own sign convention (+ grant, − debit), so a day's rows sum to
 * that day's net movement and a range sums to the range's. `rows` is the population behind it,
 * carried separately because "12 credits" and "12 credits over 12 messages" are different
 * operator facts and one cannot be recovered from the other.
 */
export interface UsageDay {
  day: string;
  pool: CreditPool;
  reason: AdminLedgerReason;
  credits: number;
  rows: number;
}

/**
 * WHAT REPLACED THE RAW LEDGER READ ON THE ACCOUNT PAGE.
 *
 * The page used to render the newest fifty `credit_ledger` rows. On any account that has been
 * screening, forty-nine of those are `debit_classify` and the five rows an operator came to see —
 * the invoice grant, the expiry, the adjustment somebody made — are off the bottom. So the two
 * halves are separated by what they are FOR:
 *
 *  · `daily` is the metered spend, aggregated: thirty days of it, ready to draw as bars, read
 *    from `credit_usage_daily` and never from the ledger.
 *  · `events` is the STATEMENT: the non-debit rows — grants, expiries, adjustments, refunds —
 *    each of which is a distinct economic decision an operator reads one at a time. Capped, and
 *    served by a partial index over exactly that predicate.
 *
 * Neither carries a debit's `source`, which is a digest of a Message-ID and therefore a
 * confirmation oracle; the daily rows have no source column at all, and the events are read
 * through the same redacting view every other ledger read on this connection is.
 *
 * The per-day raw rows are NOT here. They are one press away — `GET /admin/accounts/:id/ledger`
 * with a `day` — because a page that fetches every day's rows in case somebody expands one is
 * the read this whole change exists to stop making.
 */
export interface AccountUsage {
  daily: UsageDay[];
  events: LedgerEntry[];
  freshness: PanelFreshness;
}

/** The drill-down: one account, one day, the raw rows, capped. */
export interface LedgerDay {
  now: string;
  accountId: string;
  day: string;
  entries: LedgerEntry[];
  /** True when the cap cut the day short — the console must say so rather than imply completeness. */
  capped: boolean;
}

/* ── billing ───────────────────────────────────────────────────────────────────────────── */

export interface LedgerEntry {
  id: string;
  accountId: string;
  accountName: string;
  delta: number;
  balanceAfter: number;
  reason: AdminLedgerReason;
  source: string;
  createdAt: string;
  /**
   * `credit_ledger.meta`, through the DEFAULT-DENY staff gate in
   * `admin-service.ts:staffMeta` — an allowlisted key AND a safe-scalar value, never the bag.
   * A field name cannot bound a `jsonb` column; the projector does.
   */
  meta: Record<string, string>;
}

export interface FailedBillingEvent {
  stripeEventId: string;
  type: string;
  accountId: string | null;
  accountName: string;
  error: string | null;
  receivedAt: string;
  ageSeconds: number;
}

/**
 * MONEY. Every figure here is CENTS.
 *
 * ── THE SETTLED-REVENUE FIGURE, AND WHERE IT COMES FROM (cloud 0029) ─────────────────────
 * This interface used to say there could never be one: the staff role held no grant on any
 * amount column, because the only `amount_paid` in the database lived inside
 * `billing_events.payload` — the raw Stripe event, which also carries the customer's name and
 * postal address. That is still true of `payload`. It stopped being the whole story the moment
 * `billing_invoices` (cloud 0029) started PROMOTING the one integer the board needs — `stripe_
 * invoice_id`, `account_id`, `status`, `amount_paid_cents`, `amount_refunded_cents`, a plan, a
 * period, three timestamps — onto a table with no name, no address and no line item, granted to
 * the staff role WHOLE for exactly that reason (`staff-grants.ts`). {@link CashRevenue} is what
 * that table lets this DTO say that it could not before: cash actually received, not a list
 * price applied to subscription state.
 *
 * ── AND WHY `contracted` IS STILL NOT A SYNONYM FOR `earned` ─────────────────────────────
 * `contractedMrrCents` is `PLAN_LIMITS[plan].priceUsd × 100` summed over subscriptions in
 * `active`. It is the LIST price of what is contracted, before discount, coupon, proration,
 * tax, currency conversion and collection. A grandfathered deal reads at today's price here —
 * `billing_subscriptions` denormalises `mailbox_limit`/`monthly_credits` for exactly that
 * reason but carries no price, so the plan card is the only rate available. `cash.mtdCents` is
 * the OTHER figure, actually collected, and the two are never summed into one number: one is a
 * forecast off subscription state, the other is what Stripe actually moved.
 */
export interface BillingRevenue {
  /** List price × plan, `active` subscriptions only. Cents. Contracted, not collected. */
  contractedMrrCents: number;
  /**
   * The same arithmetic over `past_due` — contracted, invoice UNPAID. Held apart from
   * `contractedMrrCents` because folding the two together (which this snapshot used to do)
   * reports a failing payer's list price as monthly recurring income.
   */
  atRiskMrrCents: number;
  /**
   * `billing_events` rows: `invoice.paid`, `status='applied'`. A COUNT of applied events —
   * and deliberately NOT named a count of payments, because it is not one: a trial-start
   * invoice nets to $0 and still applies, so every trial that begins inflates this figure by
   * one "payment" nobody made. Excluding the $0 rows would take `payload`, the one
   * column that holds an amount and a postal address, which the staff role must never read —
   * so the honest move is the name, not the filter.
   */
  appliedInvoiceEvents: number;
  /** `invoice.payment_failed` events, any status. A COUNT. */
  failedPaymentEvents: number;
  /** Cash actually received, from `billing_invoices`. See this interface's header. */
  cash: CashRevenue;
}

/**
 * CASH, FROM `billing_invoices` (cloud 0029) — what Stripe actually settled, mirrored.
 *
 * `paidInvoices` and `mtdCents` are bucketed by `paid_at`, never by `created_at`: a reconcile
 * pass that heals a lost webhook writes the row with today's `created_at` and the invoice's
 * real `paid_at`, and bucketing by the wrong column would move a February payment into whatever
 * month happened to heal it. The read is bounded by `billing_invoices_paid_at_idx` because the
 * month is in the statement's `WHERE` — a version that put it only in the aggregates' `FILTER`
 * clauses made this same sentence false, since `status` carries no index and the planner then
 * had to read every paid invoice ever written.
 *
 * `mtdCents` NETS refunds (`amount_paid_cents − amount_refunded_cents`) because a refunded
 * invoice is still `status = 'paid'` — Stripe's invoice object cannot express a refund, only the
 * charge can — so counting `amount_paid_cents` alone would report cash that came back out the
 * same month as if it were still on hand.
 */
export interface CashRevenue {
  /** `YYYY-MM` — the month `paidInvoices` and `mtdCents` are bucketed into, by `paid_at`. */
  month: string;
  /** `billing_invoices` rows, `status = 'paid'`, `paid_at` inside `month`. A count. */
  paidInvoices: number;
  /** Σ `amount_paid_cents` − Σ `amount_refunded_cents`, same predicate. Cents actually kept. */
  mtdCents: number;
  /** The same predicate, `paid_at` = today (UTC). What the Today page's count reads. */
  paidToday: number;
  /**
   * ISO-4217, as Stripe reports it — the currency that SETTLED THE MOST this month, and the one
   * `mtdCents` is denominated in. `"usd"` when the month holds no paid invoice at all.
   *
   * The figure is never summed ACROSS currencies: minor units of USD added to minor units of EUR
   * are a number denominated in nothing, which `money()` would then print with a `$`. The read
   * groups by currency and reports the largest; {@link CashRevenue.otherCurrencies} says how many
   * it therefore left out.
   */
  currency: string;
  /**
   * How many OTHER currencies settled invoices this month that `mtdCents` does NOT include.
   *
   * The qualifier without which the figure reads as the whole month's cash — the same job
   * `AdminCostSnapshot.unmeasuredProviders` does for an unmeasured vendor. `0` on any deployment
   * selling in one currency, which is every deployment today; non-zero makes the omission
   * visible rather than silently shrinking the number.
   */
  otherCurrencies: number;
  /** The invoice mirror's own reconciliation health. See {@link InvoiceReconciliationView}. */
  reconciliation: InvoiceReconciliationView;
}

/**
 * THE INVOICE MIRROR'S RECONCILIATION HEALTH — the newest COMPLETED `mode = 'invoices'` pass on
 * `billing_reconciliation_runs` (cloud 0029's daily heal, `reconcile-invoices.ts`).
 *
 * Distinct from the SUBSCRIPTION reconciler's alert (`billing_reconciliation_divergence`,
 * `mode in ('dry-run','apply')`): the two modes are different populations on the same table, and
 * reading the newest row of either without the mode filter reports one pass's verdict as the
 * other's. This view is invoice-mode only.
 *
 * `flagged` carries every divergence code that pass recorded (`invoice_missing_in_mirror`,
 * `invoice_missing_in_stripe`, `amount_mismatch` — see `reconcile-invoices.ts`), never the
 * per-invoice `divergences` array, which is un-granted (it carries Stripe subscription and
 * account ids the alert rule does not need and this panel does not either).
 *
 * ── `flagged` COUNTS HEALED ROWS TOO, AND THAT IS WHY {@link healed} EXISTS ───────────────
 * **This comment used to say `flaggedTotal === 0` was the only healthy reading. It was wrong,
 * and it was wrong in the direction that cries wolf.** `reconcile-invoices.ts` increments
 * `flagged[code]` inside `note()` for EVERY divergence — including the ones it healed in the
 * same breath (`note(code, id, accountId, wrote ? "emitted" : "flagged")`), which its own field
 * doc says out loud: *"Closed code→count map over EVERY divergence, healed or not."* So one lost
 * `invoice.paid` webhook, healed overnight by the pass exactly as designed, would have rendered
 * a red "the invoice mirror disagrees with Stripe — money state needs a person" on a deployment
 * where the machinery had just worked. A board that goes red when the self-heal succeeds is a
 * board an operator learns to close.
 *
 * `healed` is `billing_reconciliation_runs.invoices_upserted` — the rows that pass actually
 * wrote — and it is granted to the blind role already. `flaggedTotal − healed` is the count that
 * NEEDS somebody: an invoice nobody could attribute to an account, a row the mirror holds and
 * Stripe's listing did not, an amount the fence refused to overwrite. That is the split the
 * subscription reconciler's own alert rule already makes (`emitted > 0` is a warning; unhealed
 * flags are the page), and it is made here for the same reason.
 */
export interface InvoiceReconciliationView {
  /** The newest completed pass's own clock, and the cadence it is expected at. */
  freshness: PanelFreshness;
  /** Divergence code → count, from that run's `flagged` column. Empty ⇒ nothing flagged. */
  flagged: Record<string, number>;
  /** Σ of `flagged`'s values — healed and unhealed together. See this interface's header. */
  flaggedTotal: number;
  /**
   * How many of `flaggedTotal` that pass HEALED (`invoices_upserted`) — a lost webhook replayed
   * from Stripe's own record. `flaggedTotal - healed` is what still needs a person, and only
   * that remainder is a fault.
   */
  healed: number;
  /** That run's own `truncated` — a bound stopped the pass early; `flagged` is a partial view. */
  truncated: boolean;
}

/**
 * THE CREDIT LIABILITY. Every figure here is CREDITS, and no figure here is money.
 *
 * A credit is service already owed: the account may spend it on an AI action whose token cost
 * we pay. Credits arrive three ways and only one of them was ever revenue —
 *
 *   · `invoice_grant`      — sold. Cash was received for it; unconsumed, it is DEFERRED revenue.
 *   · `adjustment_credit`  — granted by staff. A liability that was never revenue at all.
 *   · `refund`             — a reversal of a debit, restoring a credit already accounted for.
 *
 * and leave four ways: consumed (`debit_*` — service delivered, tokens paid for), expired
 * (`period_expiry` — the no-rollover renewal wipes the balance, extinguishing the liability
 * with no cost incurred), clawed back (`adjustment_debit`), or held.
 *
 * ── THE LIFETIME FIGURES RECONCILE, AND THE CONSOLE CHECKS IT ─────────────────────────────
 *   sold + granted + refunded − consumed − expired − clawedBack === outstanding
 * `credit_ledger` is append-only and `credit_balances_coupled` is a DEFERRED constraint trigger
 * that refuses to COMMIT a balance the ledger does not account for, so the identity is a
 * database fact rather than a hope. Account deletion cannot break it either: erasure is
 * anonymisation — `accounts`, `credit_balances` and `credit_ledger` all survive
 * (`account-deletion-service.ts`), so no half of the identity is ever removed without the other.
 * A mismatch on the console therefore means a genuine defect, which is why it is worth showing.
 *
 * ── WHAT IS DELIBERATELY NOT SPLIT ────────────────────────────────────────────────────────
 * `outstanding` is NOT broken into "purchased" and "granted" portions. Credits are fungible:
 * an account holding 100 credits after buying 2 000 and being granted 200 gives no fact about
 * which 100 remain, and any split would be an invented FIFO/LIFO convention presented as a
 * measurement. {@link CreditLiability.outstandingNeverInvoiced} is the part of the question
 * that IS exactly answerable — an account with no `invoice_grant` row in its whole history can
 * only be holding granted credits.
 */
export interface CreditLiability {
  /** Σ `credit_balances.balance`. Unconsumed credits across every account. Credits, not money. */
  outstanding: number;
  /**
   * The part of `outstanding` held by accounts that have NEVER had an `invoice_grant` row.
   * Granted, never sold — future token cost with no revenue behind it.
   *
   * **`-1` means the roll-up has never run, and this is the ONE lifetime figure that needs the
   * sentinel.** Every other one is a sum, so an empty aggregate makes it zero — visibly nothing.
   * This one is computed by INVERTING the set of ever-invoiced accounts, so an empty aggregate
   * makes it the WHOLE liability: before the first roll-up on a deployment, a board that rendered
   * it plainly would report every outstanding credit as having no revenue behind it, in red,
   * against the one invariant this figure exists to police — maximally alarming, and measuring
   * nothing. Negative renders as "not computed yet" and grades as `idle`.
   */
  outstandingNeverInvoiced: number;
  /** Accounts holding a non-zero balance. */
  accountsWithBalance: number;
  /** Accounts at exactly zero — rules-only degradation, the designed floor, not an outage. */
  accountsAtZero: number;
  /** Lifetime Σ `invoice_grant`. Credits SOLD — the only origin that was ever revenue. */
  soldLifetime: number;
  /** Lifetime Σ `adjustment_credit`. Credits GIVEN AWAY by staff. Never revenue. */
  grantedLifetime: number;
  /**
   * Lifetime Σ `trial_grant`. The trial bounty — given away, never revenue, and deliberately
   * NOT folded into `grantedLifetime`.
   *
   * Both are credits nobody paid for, so folding them would keep the reconciliation balanced and
   * lose the only distinction that matters here: a staff comp is a decision somebody made about
   * one account, and the trial bounty is a fixed cost of acquiring any account at all. One is a
   * support workload, the other is marketing spend measured in tokens, and a single "granted"
   * figure that grew would not say which had happened.
   */
  trialGrantedLifetime: number;
  /** Lifetime Σ `refund`. Credits restored after a debit was reversed. */
  refundedLifetime: number;
  /** Lifetime Σ |`debit_classify` + `debit_draft` + `debit_propose` + `debit_workflow`|. Service delivered. */
  consumedLifetime: number;
  /** Lifetime Σ |`period_expiry`|. Liability extinguished by the no-rollover renewal, unspent. */
  expiredLifetime: number;
  /** Lifetime Σ |`adjustment_debit`|. Credits taken back by staff. */
  clawedBackLifetime: number;
  /**
   * Accounts whose OWN ledger disagrees with their OWN balance. Zero is the only healthy value.
   *
   * The console cannot derive this from the figures above: both sides of the identity are sums
   * across every account, so +500 of drift on one account and −500 on another cancel and the
   * global check reads "balanced" over two corrupted rows. This is the count the netting hides.
   *
   * MEASURED BY THE ROLL-UP, not by this read, and that is a strengthening rather than a
   * convenience. This function used to recompute it from a whole-ledger `GROUP BY account_id` —
   * correct, and an uncapped scan of the money trail on every console load. The nightly pass runs
   * `findCreditDivergence` instead, which is ONE statement and therefore internally consistent,
   * and which asks BOTH arms of the question: the sum-vs-balance arm this read could express, and
   * the `balance_after` arm it could not (that column is granted, but comparing it needs the
   * ledger's newest row per account, which is the scan being removed). So the number is now
   * strictly better informed and up to a day old — which is why it arrives with
   * {@link BillingSnapshot.freshness} beside it rather than on its own.
   *
   * `-1` means no roll-up has ever run, and it is deliberately not `0`: zero is the healthy
   * answer, and rendering "no divergence" from "nobody has looked" is precisely the reassurance
   * this figure exists to refuse.
   */
  divergentAccounts: number;
}

/**
 * The billing snapshot. **There is no `totals` bag, and its absence is the fix.**
 *
 * It used to read `totals: { accounts, creditsOutstanding, mrrCents }` — an account count, a
 * count of CREDITS and a sum of CENTS in one object, rendered as three adjacent figures under
 * one hairline. A liability denominated in service units and a contracted price denominated in
 * dollars are different quantities about different sides of the business, and presenting them
 * as peers misstates both. They are now two interfaces with two units and two panels.
 */
export interface BillingSnapshot {
  now: string;
  /** Every account, whatever its subscription state. */
  accountCount: number;
  subscriptionStates: Array<{
    status: AdminSubscriptionStatus;
    accounts: number;
    /** List price × plan for accounts in THIS state. Zero for every state that does not bill. */
    contractedMrrCents: number;
  }>;
  revenue: BillingRevenue;
  liability: CreditLiability;
  /**
   * The deployment-wide STATEMENT: the newest non-debit ledger rows — grants, expiries,
   * adjustments, refunds. Capped, and served by the partial index over exactly that predicate.
   *
   * Metered debits are deliberately absent. They were the overwhelming majority of what this list
   * used to show, they are the same three shapes over and over, and they are now counted in
   * `credit_usage_daily` where a count is what anybody wanted. What is left is every row that
   * represents a decision rather than a meter reading.
   */
  ledger: LedgerEntry[];
  /**
   * How old the aggregate-backed figures on this snapshot are — `liability`'s lifetime sums and
   * `divergentAccounts`, all of which the roll-up produces. `accountCount`,
   * `subscriptionStates`, `revenue`, `ledger` and `failedEvents` are live reads and are as fresh
   * as the page's own `now`.
   */
  freshness: PanelFreshness;
  adjustableAccounts: Array<{ id: string; name: string; balance: number }>;
  failedEvents: FailedBillingEvent[];
}


/* ── cost out (cloud 0029) ──────────────────────────────────────────────────────────────── */

/** The five providers the cost board knows. `platform_costs.provider`'s CHECK. */
export type AdminCostProvider = "vercel" | "supabase" | "anthropic" | "railway" | "resend";

/**
 * ONE PROVIDER'S FIGURE, AND HOW MUCH OF A FIGURE IT IS.
 *
 * `cents: null` is the state this whole panel is designed around, because it is the state
 * production is in: none of the three provider keys exists, so the honest answer for every one of
 * them today is "not measured". A `0` here would be a margin somebody believes.
 *
 * `source` is what separates the four ways a number can be on this row:
 *
 *  · `api`          — a vendor answered, inside one cadence. The only "current" reading.
 *  · `manual`       — a person read an invoice. Better evidence than an API reporting
 *                     usage-to-date, which is why it WINS when both exist for one window.
 *  · `stale`        — an API row nobody has been able to refresh. The FIGURE stands and the word
 *                     says how old it is; a provider that stopped answering must not read as one
 *                     that reported the same number again.
 *  · `unconfigured` — no key, or no adapter at all (`railway`/`resend` are manual by design).
 *                     `cents` is null and the board says "not configured".
 */
export interface ProviderCostView {
  provider: AdminCostProvider;
  /** `null` means NOT MEASURED. It is never 0 for want of a measurement. */
  cents: number | null;
  currency: string;
  /** When the figure was OBTAINED — not when the window closed. `null` when there is none. */
  fetchedAt: string | null;
  source: "api" | "manual" | "unconfigured" | "stale";
  /** The operator's note on a manual row — why this figure replaced the API's. */
  note: string | null;
  /** The `staff_users` id of whoever typed a manual row. `null` on an API row. */
  enteredBy: string | null;
}

/** One model's month: what it was called for and what it cost. Measured, not apportioned. */
export interface AiModelCost {
  model: string;
  calls: number;
  /** Calls that returned. A day whose two counts diverge is a provider incident. */
  okCalls: number;
  inputTokens: number;
  outputTokens: number;
  cents: number;
}

/**
 * ONE ACCOUNT'S UNIT ECONOMICS — and every AI figure on it is APPORTIONED, which the type says
 * out loud on every row rather than in a comment somewhere.
 *
 * Nothing in this system knows which account a model call belonged to. Attributing one inside the
 * AI package was refused: that package is desktop payload and knows nothing about accounts. So an
 * account's share is derived from the credits it spent against the credits the deployment spent,
 * per day and per model family — a good estimate, and not a measurement.
 *
 * `attribution` is a single-member union rather than a boolean or a comment, so a console that
 * rendered `aiCents` without the label would have to delete a field to do it.
 */
export interface AccountUnitCost {
  accountId: string;
  name: string | null;
  plan: AdminPlan | null;
  /** Metered credits this account spent this month — the apportionment's numerator. */
  credits: number;
  /** ALWAYS `"apportioned"`. See this interface's header. */
  attribution: "apportioned";
  /** This account's apportioned share of the deployment's model spend, in cents. */
  aiCents: number;
  /**
   * What the account contributes in a month, at list price. Annual billing is ten monthly months
   * paid up front, so an annual customer's monthly-equivalent is a twelfth of the year — which is
   * what makes the two comparable in one column.
   *
   * `null` when there is no live subscription: a trial or a lapsed account has no price, and 0
   * would make every margin below read as −100 %.
   */
  monthlyPriceCents: number | null;
  /**
   * `(price − apportioned AI) ÷ price`, as a whole percentage. `null` when there is no price —
   * an account with no subscription has no margin, and a number there would be an invention.
   */
  grossMarginPct: number | null;
}

/**
 * THE COST BOARD, for the current month.
 *
 * Three figures with three different epistemic statuses, and this shape exists to keep them
 * apart: infrastructure is measured or explicitly not, AI is measured at the call, and AI per
 * account is apportioned and labelled. A panel that summed them into one confident number would
 * be the failure the whole slice is built to avoid.
 */
export interface AdminCostSnapshot {
  now: string;
  /** `YYYY-MM` — the month every figure below is about. */
  month: string;
  providers: ProviderCostView[];
  /**
   * Σ of the providers that HAVE a figure, in cents. `null` when not one of them does — which is
   * the state a deployment with no provider keys is in, and it is not zero.
   */
  infrastructureCents: number | null;
  /**
   * How many providers contributed NOTHING because nobody measured them.
   *
   * The qualifier without which `infrastructureCents` reads as a bill. Four measured providers and
   * one absent sum to a number that is too small by exactly the amount nobody looked at, and this
   * is the field that says so.
   */
  unmeasuredProviders: number;
  /** Σ of every model's cost this month, in cents. Measured at the call. */
  aiCents: number;
  models: AiModelCost[];
  /**
   * Per HOST. Three processes make metered calls and they fail independently — an arm that drops
   * to zero here is the recorder that stopped, which no deployment-wide total could show.
   */
  hosts: Array<{ host: string; calls: number; cents: number }>;
  /** Infrastructure + AI, month to date. */
  monthToDateCents: number;
  /**
   * MTD ÷ elapsed days × the month's length. `null` when there is nothing measured to project
   * from — a projection of an unmeasured month is a number about nothing.
   */
  projectedMonthCents: number | null;
  /** How many days the projection is extrapolating FROM. On day one this is 1, and it shows. */
  projectionBasisDays: number;
  daysInMonth: number;
  accounts: {
    /** The most expensive accounts to serve, by apportioned AI cost. */
    topByCost: AccountUnitCost[];
    /** The thinnest margins — the ones the tier's pricing is wrong about. */
    bottomByMargin: AccountUnitCost[];
    /** Accounts whose apportioned cost exceeds what they pay. Zero is the healthy value. */
    underwater: number;
    /** How many accounts the ranking was computed over. */
    walked: number;
    /**
     * The scan hit its cap, so the rankings are over a SUBSET. A "top ten" computed from an
     * arbitrary slice must not present itself as the top ten, and this is what stops it.
     */
    truncated: boolean;
  };
}

/* ── funnel ────────────────────────────────────────────────────────────────────────────── */

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
