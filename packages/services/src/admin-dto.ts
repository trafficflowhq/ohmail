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
export type AdminAlertKind = "worker_down" | "billing_events_failed" | "sends_stuck" | "sync_lag";
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
  };
  ledger: LedgerEntry[];
  audit: AuditEntry[];
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
 * MONEY. Every figure here is CENTS, and not one of them is cash received.
 *
 * ── WHY THERE IS NO REVENUE FIGURE ────────────────────────────────────────────────────────
 * The staff role cannot read an amount. `billing_events.payload` — the raw Stripe event, the
 * only place an `amount_paid` exists in this database — is deliberately UN-GRANTED
 * (`staff-grants.ts`, `public.billing_events`) because it carries the customer's name and
 * address. Nothing else in the schema stores a settled amount: `billing_subscriptions` holds a
 * `stripe_price_id` and an entitlement, never a sum.
 *
 * So this interface reports what a blind role CAN establish — the price list applied to
 * subscription state, and a COUNT of applied invoice events — and the console says in as many
 * words that Stripe is the authority for cash. Adding a `settledRevenueCents` here would mean
 * granting a column that carries a customer's postal address to a console that must never see
 * one, which is a worse trade than sending an operator to the Stripe dashboard.
 *
 * ── AND WHY `contracted` IS NOT A SYNONYM FOR `earned` ────────────────────────────────────
 * `contractedMrrCents` is `PLAN_LIMITS[plan].priceUsd × 100` summed over subscriptions in
 * `active`. It is the LIST price of what is contracted, before discount, coupon, proration,
 * tax, currency conversion and collection. A grandfathered deal reads at today's price here —
 * `billing_subscriptions` denormalises `mailbox_limit`/`monthly_credits` for exactly that
 * reason but carries no price, so the plan card is the only rate available.
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
   * Accounts whose OWN ledger sum disagrees with their OWN balance — the per-account form of
   * the reconciliation identity, counted on the same snapshot as the lifetime figures.
   *
   * The console cannot derive this from the figures above: both sides of the identity are sums
   * across every account, so +500 of drift on one account and −500 on another cancel and the
   * global check reads "balanced" over two corrupted rows. This is the count the
   * netting hides — the sum-vs-balance arm of `findCreditDivergence`, restated over the columns
   * the staff role holds (its `balance_after` arm needs a column that is not granted). Zero is
   * the only healthy value.
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
  ledger: LedgerEntry[];
  adjustableAccounts: Array<{ id: string; name: string; balance: number }>;
  failedEvents: FailedBillingEvent[];
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
  roster: Array<MailboxHealth & { accountName: string }>;
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
