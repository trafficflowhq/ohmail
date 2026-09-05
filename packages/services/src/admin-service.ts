import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { accounts, auditLog, mailboxCredentials, mailboxes, users, isMailboxSyncBlockReason } from "@trafficflow/db";
import {
  accountSuspensions,
  alertState,
  authEvents,
  billingEvents,
  // The invoice mirror (cloud 0029) — cash actually received, and its own reconciliation
  // pass's run ledger. Granted to the staff role WHOLE (`staff-grants.ts`); see `CashRevenue`.
  billingInvoices,
  billingReconciliationRuns,
  billingSubscriptions,
  creditBalances,
  creditLedger,
  // The roll-up's three tables (cloud 0028). Every spend figure on this console is read from
  // them; `credit_ledger` is still read for the STATEMENT rows and for nothing else.
  creditUsageDaily,
  creditUsageTotals,
  creditRollupRuns,
  setupGrants,
  invites,
  waitlist,
  workerHeartbeats,
  evaluateAlerts,
  alertClass,
  listOpenAlerts,
  SCOPED_ALERT_KINDS,
  alertDriverStatuses,
  platformSignalWindow,
  SIGNAL_BUCKET_MS,
  listFailedBillingEvents,
  listStuckSends,
  DEFAULT_ALERT_THRESHOLDS,
  LIVE_SUBSCRIPTION_STATUSES,
  PLAN_LIMITS, ADDON_CARD,
  type ContentBlind,
} from "@trafficflow/db/cloud";
import type { Db } from "./context.js";
import type {
  AccountDetail, AccountPage, AccountQuery, AccountSummary, AccountUsage, ActionCatalog, ActionSpec,
  AdminAlertDriver, AdminLedgerReason, AdminPlan, AdminPlatformSignal, AdminSubscriptionStatus,
  AlertSummary, AuditEntry,
  BillingRevenue, BillingSnapshot, CashRevenue, CreditLiability, FunnelSnapshot, FunnelStage,
  InvoiceReconciliationView, LedgerDay, LedgerEntry, MailboxHealth, SecurityEvent, SetupPoolView,
  StaleSend, UsageDay, WorkerInstanceHealth, WorkerSnapshot,
} from "./admin-dto.js";

/**
 * THE ONLY CROSS-ACCOUNT READER IN THE REPO.
 *
 * Every other service in this package is account-scoped by construction: it takes a
 * `ServiceContext` whose `accountId` came from the session, and every query it writes carries
 * `where accountId = ctx.accountId`. That is the invariant the whole product's isolation rests
 * on, and the way it dies is not by someone deleting it — it is by someone relaxing ONE
 * existing service "just for admin" and leaving a method that can be called with any account
 * id from a route that forgot to check. So the cross-account reads live here, in a module that
 * takes a bare `Db` and no context at all, and the fact that it has no `ServiceContext` is what
 * makes "did this query have an account scope?" a question with an obvious answer everywhere
 * else.
 *
 * ── IT RUNS ON A DIFFERENT CONNECTION FROM THE REST OF THE API ────────────────────────────
 * Every function here takes an {@link AdminDb}, not a `Db`, and the difference is not
 * decorative: `AdminDb` is a NOMINAL BRAND that only `adminDbFor` in `@trafficflow/db` can
 * mint, and it only mints one after asking the database to refuse a mail-content read. So
 * handing this module the runtime handle — which is what every route once did — is a
 * COMPILE ERROR, and the handle it does get is connected as `ohmail_admin`, a Postgres role
 * with column grants that answer 42501 to the reads below that are forbidden.
 *
 * The boundary is staff-surface vs. user-serving runtime, NOT "the API must not read content":
 * the API must read a message's display fields to serve them to the account's own user — that
 * is the product working. Only THIS module's connection is blind.
 *
 * ── WHAT THIS MODULE MAY NOT SELECT ───────────────────────────────────────────────────────
 * Every select below names its columns explicitly. There is no `select()` without a projection
 * anywhere in this file, and that is a rule rather than a style. It is now the SECOND of two
 * mechanisms rather than the only one — the grant is the first — and it is still here because
 * a query that names a forbidden column now fails as a 503 rather than as a leak, and a 503
 * nobody predicted is a worse way to find out than a review comment.
 *
 *  · **No message content — and NO MESSAGE ROW EITHER.** `messages` is not touched at
 *    all, and the role holds no privilege on it — not `subject`, and not `id`. Nor on
 *    `change_log`, `folder_state` or `flag_state`. A review established that a two-column
 *    `messages(id, mailbox_id)` grant is minimal as a projection and still sufficient as a
 *    channel, because `count(*)` names no column and a row's EXISTENCE around a delivery the
 *    tester chose is a receipt fact — staff must never be able to confirm that a particular
 *    mail reached a particular account. See `pendingMoves` below for the three
 *    console fields that paid for it and the argument against replacing them.
 *    The published FAQ answer is a promise to customers, and it is enforced twice: an
 *    api-level test seeds real mail with distinctive markers and fails if one reaches a
 *    response, and a role-level test against real Postgres proves the role refuses the
 *    relations outright AND that a chosen delivery to one of two otherwise identical accounts
 *    changes nothing the role can select.
 *  · **No secrets.** `mailbox_credentials` is read for the PRESENCE of a row
 *    (`hasImapCredential`); the grant covers its composite primary key and nothing else, so
 *    the encrypted credential, its key version and its connection meta are not merely
 *    unprojected, they are unreadable. Nothing here touches `sessions`, `totp_secrets`,
 *    `recovery_codes`, `login_tokens` or `invites`, none of which the role holds a grant on.
 *  · **No Stripe payload.** `billing_events.payload` is the one column on that table that can
 *    carry a customer's name, address or line-item description. The operator queue needs
 *    `stripe_event_id` (what you paste into the dashboard) and `error` (why it failed), and
 *    `listFailedBillingEvents` in `packages/db` already projects exactly those.
 *  · **NO OPEN JSONB BAG AT ALL, and the un-granting is what changed here.** `credit_ledger.meta`,
 *    `audit_log.payload` and `audit_log.inverse` are columns whose CONTENTS no field name
 *    bounds. An earlier gate rendered them through a default-deny projection (`staffMeta`)
 *    after finding
 *    that `pipeline.ts` was writing the raw RFC822 Message-ID into a classify charge's meta.
 *    The grant now denies all three, so the projection is gone and so is the gate: the bags
 *    cannot be read, by this module or by the endpoint somebody adds next. `LedgerEntry.meta`
 *    and `AuditEntry.payload` are therefore always empty. That is a real, accepted loss of
 *    operator detail (the renewal invoice id was the useful one) and the way back is the only
 *    one that is safe: **the producer promotes the value to a NAMED COLUMN**, which is then
 *    granted by name. The bag is never granted.
 *  · **No mail-derived DIGEST either, and this one was a live false claim for a while — a
 *    review caught it.** `credit_ledger.source` is `classify:<mailbox>:<sha256(mid:<Message-ID>)>`
 *    and `draft:<message>:<sha256(<Idempotency-Key>)>`, and this module's own comment called
 *    that "safe by construction". It is not: both inputs are guessable — a sender chooses the
 *    `Message-ID` of mail it sends to the account, a natural client uses the SUBJECT as its
 *    idempotency token — so a staff reader who can see the digest can confirm candidates
 *    offline. The column is now un-granted, and `loadLedger` reads `admin.credit_ledger`,
 *    which truncates the digest away. History closed with the grant: the ledger is append-only
 *    and the plaintexts were destroyed when the digests were introduced, so no re-keying was
 *    possible even in principle.
 *  · **Only `admin.*` audit rows, and the filter is in the DATABASE now.** `audit_log` is
 *    shared with the PRODUCT's own domain audit — `move`, `adopt_external`, `hey_migrate`,
 *    `workflow_step` — and a `workflow_step` row's `payload.effect` is whatever the tool
 *    returned, which for `draft_reply` can quote mail. `ohmail_admin` holds no grant on
 *    `public.audit_log`; it reads `admin.audit_log`, a `security_barrier` view that carries the
 *    `LIKE 'admin.%'` predicate and projects four named scalars. The unqualified name below
 *    resolves to that view for this role through its `search_path`, and to the table for every
 *    other role — so ONE query serves the staff surface and the PGlite harness, and a widened
 *    projection fails on the role rather than quietly reading the bag.
 *
 * ── AND IT READS. IT DOES NOT WRITE. ──────────────────────────────────────────────────────
 * There is no INSERT, UPDATE or DELETE in this file. The staff writes (suspend, resume, resync,
 * retry, credit adjustment) are deliberately not built here: they need `users.role`, step-up,
 * an actor identity and an `audit_log` row each, and `adjustCredits` moves money through the
 * credit ledger. `adminActions()` reports the unbuilt ones as unavailable so the console can
 * say so out loud instead of offering a button that does nothing.
 *
 * ── SCALE, STATED HONESTLY ────────────────────────────────────────────────────────────────
 * The roster is assembled by scanning `accounts` and five grouped aggregates, then filtered,
 * ordered and paged IN THIS PROCESS. That is right for a beta whose roster is tens of accounts
 * and wrong for tens of thousands: the ordering key (`attentionRank`) is derived from three
 * aggregates at once, so pushing it into SQL means materialising it, and materialising it is a
 * schema decision this slice deliberately does not take. `total` is a real `count(*)`, so the
 * number on screen is never a guess; the paging is honest, just not cheap. When the roster
 * outgrows this, the fix is a view or a summary table — not a `LIMIT` here, which would make
 * `matched` a lie.
 *
 * THE LEDGER HALF OF THAT PARAGRAPH IS NO LONGER TRUE, and this is what replaced it. Three
 * UNCAPPED aggregates over `credit_ledger` ran on every Billing load, and the account page read
 * the newest fifty raw rows. `credit_ledger` is append-only and never pruned — for four separate
 * reasons the roll-up's own header sets out — so those reads grew with the deployment's whole
 * history. They now read `credit_usage_daily` (hourly) and `credit_usage_totals` (nightly),
 * written by a worker-side pass, and every panel backed by them carries
 * `{ computedAt, expectedEverySeconds }` — its OWN producer's clock and its OWN cadence, because
 * the two are on different ones and a single stamp would have to be wrong about one of them.
 * `credit_ledger` is still read directly for the STATEMENT rows — the non-debit reasons, over a
 * partial index built for exactly that predicate — and for nothing else.
 *
 * A LIST BEING CAPPED IS NOT A LICENCE TO COUNT OVER IT. `WorkerSnapshot.rosterCounts` exists
 * because the console's fault verdict counted mailboxes by filtering a 200-row roster, so a
 * deployment's 201st broken mailbox could not make the verdict worse. Counts come from
 * `count(*) filter (…)`; lists stay capped and say which cap they hit.
 */

/**
 * The handle every function in this module takes.
 *
 * `Db` widened by the nominal brand `@trafficflow/db` mints only after its boot attestation has
 * watched the connection be REFUSED a mail-content read AND compared the role's whole
 * effective capability set to `STAFF_SELECT_GRANTS` (a single denied column was the original
 * proof, and a review showed it proves almost nothing about the rest of the grant). `deps.db`
 * does not satisfy the brand, which is
 * what makes "the staff reads run on the staff connection" a fact the compiler checks for the
 * functions in THIS MODULE instead of a convention each of them has to remember.
 *
 * It brands `Db` (the PGlite ∪ postgres-js union) rather than the postgres-js handle alone,
 * because PGlite has no roles at all: the api-level tests brand a PGlite handle by an explicit
 * cast and prove the PROJECTION half, and a role-level test proves the
 * ROLE half against real Postgres. Neither substitutes for the other.
 */
export type AdminDb = Db & ContentBlind;

/* ════════════════════════════════════════════════════════════════════════════════════════
   Caps and constants
   ════════════════════════════════════════════════════════════════════════════════════════ */

/** Statement views are capped: an operator reads the newest rows, never all of them. */
export const ADMIN_LIST_LIMIT = 50;
/** The roster page size the console asks for by default. */
export const ADMIN_DEFAULT_PAGE_SIZE = 25;
/** A pageSize a caller may not exceed — the query string is attacker-controlled. */
export const ADMIN_MAX_PAGE_SIZE = 100;
/** Option lists on the Actions page, and the Billing page's adjustment targets. */
export const ADMIN_OPTIONS_LIMIT = 200;
/** Mailboxes listed on the Worker page's roster. */
export const ADMIN_ROSTER_LIMIT = 200;

/**
 * Lag only counts once it is actually notable — the same 300s the console's `attentionRank`
 * uses, for the same reason: an account whose worst mailbox is 44 seconds behind is not a
 * finding, and scoring it made healthy rows reshuffle on noise.
 */
const LAG_MATTERS_AFTER = 300;

const DB_STATUSES = [
  "trialing", "active", "past_due", "unpaid", "paused", "canceled", "incomplete",
  "incomplete_expired",
] as const;

/**
 * The order the Billing page's distribution strip renders, and it includes the ZERO entries
 * on purpose: a strip that only shows non-empty buckets reflows every time one empties.
 */
export const ADMIN_SUBSCRIPTION_ORDER: readonly AdminSubscriptionStatus[] = [
  "active", "trialing", "past_due", "unpaid", "paused", "incomplete", "incomplete_expired",
  "canceled", "none",
];

/**
 * The statuses that carry a CONTRACTED price, and the two buckets they fall into.
 *
 * This used to be one set — `{active, past_due}` — summed into a single `mrrCents` the console
 * labelled "MRR". That reported the list price of every subscription whose payment has FAILED
 * as monthly recurring income, which is the opposite of what a past-due row means. Stripe is
 * still retrying, so the money is not lost; it is also not received, and one number cannot say
 * both. Two buckets, two figures, and the console shows them apart.
 *
 * `trialing` bills nothing yet. `unpaid`, `paused`, `canceled` and the two `incomplete` states
 * bill nothing at all.
 */
const CONTRACTED_STATUSES = new Set<AdminSubscriptionStatus>(["active"]);
const AT_RISK_STATUSES = new Set<AdminSubscriptionStatus>(["past_due"]);

/**
 * The plan card, in cents. **This is a LIST price, not a rate anything was charged at.**
 *
 * `billing_subscriptions` denormalises `mailbox_limit` and `monthly_credits` onto the row
 * precisely so a price change cannot retro-rewrite a live entitlement — but it carries no
 * price column, so the sold-at rate is not in this database at all. Every figure derived from
 * this map is therefore today's price applied to yesterday's subscription, and a grandfathered
 * or discounted account reads wrong by exactly the difference. The console labels it.
 */
const PLAN_MRR_CENTS: Record<AdminPlan, number> = {
  solo: PLAN_LIMITS.solo.priceUsd * 100,
  plus: PLAN_LIMITS.plus.priceUsd * 100,
  pro: PLAN_LIMITS.pro.priceUsd * 100,
};

/**
 * One row's MONTHLY-EQUIVALENT list price, in cents: the plan (an annual cadence pays ten
 * monthly months across twelve, so its MRR is 10/12 of the monthly card × 12ths — rounded per
 * row), plus the add-on line items the mirror carries (cloud 0022), which bill monthly at the
 * add-on card whatever the plan's cadence. Same LIST-price caveat as {@link PLAN_MRR_CENTS}.
 */
function rowMrrCents(plan: AdminPlan, sub: SubscriptionRow | undefined): number {
  const base = PLAN_MRR_CENTS[plan];
  const cadence = sub?.billingInterval === "year"
    ? Math.round((base * 10) / 12)
    : base;
  const addons =
    int(sub?.addonStorageUnits ?? 0) * ADDON_CARD.storage.priceUsd * 100 +
    int(sub?.addonMailboxes ?? 0) * ADDON_CARD.mailbox.priceUsd * 100;
  return cadence + addons;
}

/** Ledger reasons whose debit means SERVICE WAS DELIVERED — tokens we paid for. */
const CONSUMPTION_REASONS: readonly AdminLedgerReason[] = [
  "debit_classify", "debit_draft", "debit_propose", "debit_workflow",
];

/* ════════════════════════════════════════════════════════════════════════════════════════
   Small helpers
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Drizzle types a `timestamptz` column as `Date`, and postgres-js honours that while PGlite
 * hands back an ISO STRING for the same column. Both drivers run this code (production and the
 * test harness), so every timestamp is normalised through one function rather than by each
 * call site guessing which driver it is on — a class of bug that has bitten this codebase twice
 * (see the `mail-service.ts` note `alerts.ts` quotes).
 */
const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : asDate(value).toISOString();

const secondsSince = (now: Date, then: Date | string | null | undefined): number | null =>
  then === null || then === undefined
    ? null
    : Math.max(0, Math.round((now.getTime() - asDate(then).getTime()) / 1000));

const int = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Case- and accent-insensitive folding — the same rule the console applies to fixtures, so
 * a search that found a row in fixtures finds it live. NFD + stripping combining marks, not a
 * locale collator.
 */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE STAFF META GATE — BUILT, THEN REMOVED, AND WHY THE REMOVAL IS THE STRONGER STATE
   ════════════════════════════════════════════════════════════════════════════════════════

   The gate rendered `credit_ledger.meta`, `audit_log.payload` and `audit_log.inverse` to staff
   through `staffMeta`: default-deny by KEY (an allowlist naming each live producer) and then
   by VALUE SHAPE (a character class that no address, Message-ID or free text survives). It
   existed because the previous projection was a channel rather than a projection —
   `packages/core/src/pipeline.ts` was charging one AI classification with the raw RFC822
   Message-ID as `meta.dedupKey`, which put a sender, and sometimes a recipient, on the
   console's ledger table. Staff must see neither.

   All three columns are now UN-GRANTED to `ohmail_admin` (`scripts/harden-staff-role.sql`),
   so there is nothing left to project and the gate has been deleted rather than left standing
   as decoration. A gate nobody can forget beats a gate somebody has to remember, and a
   two-stage allowlist that no query can reach is worse than nothing: it reads like a live
   defence in review.

   What that costs, stated rather than buried: `LedgerEntry.meta` and `AuditEntry.payload` are
   now always `{}`, and the most useful thing they carried — the renewal's `in_…` invoice id on
   the Billing page — is gone with them. The way back is the only
   one that is safe by construction: **the PRODUCER promotes the value to a named column**, and
   that column is added to the grant by name. The bag is never granted.

   The response-level guard stays and still bites: `admin-content-isolation.test.ts` taints
   every column of the schema and asserts none of it reaches these six responses. It is now
   proving a property the database also enforces, which is the right number of independent
   mechanisms for the product's first stated priority: staff never see an account's mail. */

interface SubscriptionRow {
  accountId: string;
  plan: string;
  status: string;
  mailboxLimit: number;
  monthlyCredits: number;
  /** cloud 0022 — the plan price's cadence and the add-on quantities the mirror carries. */
  billingInterval: string;
  addonStorageUnits: number;
  addonMailboxes: number;
  currentPeriodStart: Date | string | null;
  currentPeriodEnd: Date | string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: Date | string | null;
  createdAt: Date | string;
}

const asPlan = (value: string): AdminPlan | null =>
  value === "solo" || value === "plus" || value === "pro" ? value : null;

const asStatus = (value: string | undefined): AdminSubscriptionStatus =>
  value !== undefined && (DB_STATUSES as readonly string[]).includes(value)
    ? (value as AdminSubscriptionStatus)
    : "none";

/**
 * The account's NEWEST subscription row, whatever its status.
 *
 * Not the LIVE one: an account whose subscription was canceled last week has no live row, and
 * a console that answered "no subscription" for it would be describing a different customer.
 * `created_at` then `id` breaks the tie the same way the ledger's statement view does.
 */
function newestByAccount(rows: SubscriptionRow[]): Map<string, SubscriptionRow> {
  const out = new Map<string, SubscriptionRow>();
  for (const row of rows) {
    const held = out.get(row.accountId);
    if (!held || asDate(row.createdAt) >= asDate(held.createdAt)) {
      out.set(row.accountId, row);
    }
  }
  return out;
}

/**
 * How much this account needs a human, as one number.
 *
 * IT IS A COPY, AND THE COPY IS ASSERTED. The console carries its own `attentionRank` and this
 * is the server's; a package may not import from an app, so they are written twice and the
 * console's test cases are re-run against this copy at the api level. If they disagree, page 1
 * and page 2 of a paged roster silently omit the same rows — the failure the `AccountPage` doc
 * warns about.
 */
export function adminAttentionRank(account: AccountSummary): number {
  let score = 0;
  if (account.suspendedAt) score += 5;
  if (account.subscription === "past_due") score += 40;
  if (account.mailboxesInError > 0) score += 200 + account.mailboxesInError * 10;
  // Range 165–200, and both bounds are arguments rather than taste — the console's copy of
  // this clause carries the full reasoning: above every plain error (a block is an upstream
  // refusal, not a transient fault), below the error ramp's ceiling.
  if (account.mailboxesBlocked > 0) score += 160 + Math.min(40, account.mailboxesBlocked * 5);
  if (account.syncLagSeconds !== null && account.syncLagSeconds > LAG_MATTERS_AFTER) {
    score += Math.min(150, account.syncLagSeconds / 60);
  }
  return score;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The roster
   ════════════════════════════════════════════════════════════════════════════════════════ */

async function loadRoster(db: AdminDb, now: Date): Promise<AccountSummary[]> {
  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, createdAt: accounts.createdAt })
    .from(accounts);
  if (accountRows.length === 0) return [];

  // The OWNER's login address — `users.email`, the account's own identity, never a sender.
  // Oldest user wins: `register` creates the account and its first user in one transaction, so
  // the earliest row is the account's owner.
  const userRows = await db
    .select({ accountId: users.accountId, email: users.email, createdAt: users.createdAt })
    .from(users);
  const ownerEmail = new Map<string, { email: string; createdAt: Date | string }>();
  for (const row of userRows) {
    const held = ownerEmail.get(row.accountId);
    if (!held || asDate(row.createdAt) < asDate(held.createdAt)) {
      ownerEmail.set(row.accountId, { email: row.email, createdAt: row.createdAt });
    }
  }

  const mailboxRows = await db
    .select({
      accountId: mailboxes.accountId,
      total: sql<number>`count(*)::int`,
      inError: sql<number>`count(*) filter (where ${mailboxes.status} <> 'connected')::int`,
      /* Mailboxes OUR infrastructure declined to serve (the block-reason columns of mail 0029).
       *
       * DISJOINT FROM `inError` BY CONSTRUCTION, not by coincidence: every writer that moves
       * `status` clears both block columns in the same statement (`apps/worker/src/mailboxes.ts`
       * :743, :768, :826 and `mailbox-service.ts:360-362`), so a row can carry a status other than
       * `connected` or a block, never both. The two counts are additive on `attentionRank` for
       * that reason.
       *
       * `is not null`, NOT `isMailboxSyncBlockReason` — deliberately, and it is the one place the
       * roster count and the detail page disagree. The two predicates differ on `''`, which this
       * counts and the detail page
       * (which narrows) would not show: an account would read "1 blocked" with no blocked mailbox
       * under it. That is unreachable ONLY WHILE `mailboxes_sync_blocked_reason_closed` exists —
       * and that constraint is probed BY NAME (`health.ts:117` is a column-existence probe), never
       * by membership. Accepted rather than
       * hidden: membership narrowing here would make the roster count disagree with a NEWER
       * worker's fourth reason, which is the far likelier failure and exactly the defect that was
       * removed when the block predicate stopped being gated on the reason's membership. */
      blocked: sql<number>`count(*) filter (where ${mailboxes.syncBlockedReason} is not null)::int`,
      // Worst lag across the mailboxes that are SUPPOSED to sync. A disabled mailbox is not
      // late — the downgrade path disables it on purpose — so it is excluded, exactly as
      // `evaluateAlerts`'s `sync_lag` rule excludes it.
      oldestSync: sql<string | null>`
        min(coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}))
          filter (where ${mailboxes.status} <> 'disabled')`,
    })
    .from(mailboxes)
    .groupBy(mailboxes.accountId);
  const mailboxByAccount = new Map(mailboxRows.map((r) => [r.accountId, r]));

  const subs = newestByAccount(await selectSubscriptions(db));

  const balanceRows = await db
    .select({ accountId: creditBalances.accountId, balance: creditBalances.balance })
    .from(creditBalances);
  const balances = new Map(balanceRows.map((r) => [r.accountId, int(r.balance)]));

  // Presence-is-state suspension (cloud 0008). The blind role holds SELECT on exactly
  // `(account_id, suspended_at)` here; `suspended_by`/`note` are
  // ungranted, so this projection cannot widen past what the console renders.
  const suspensionRows = await db
    .select({ accountId: accountSuspensions.accountId, suspendedAt: accountSuspensions.suspendedAt })
    .from(accountSuspensions);
  const suspendedAt = new Map(
    suspensionRows.map((r) => [r.accountId, asDate(r.suspendedAt).toISOString()]),
  );

  /* ── `lastActivityAt` USED TO BE READ HERE, AND IT WAS THE SHARPEST ORACLE ON THE SURFACE ──

     The query was `select account_id, max(created_at) from change_log group by account_id` —
     "is this account alive at all", one timestamp, no ids, and the narrowest possible read of a
     table whose grant was already minus its jsonb bag. It is also a receipt oracle with nothing
     left to narrow:

       `packages/core/src/pipeline.ts:512` calls
       `recordChange({ entityType: "message", entityId: stored.id, op: "create" })`
       for EVERY ingested message.

     So staff pick a target account, note its `lastActivityAt`, send mail carrying a chosen
     Message-ID, poll, and watch that one account's stamp advance. Nothing about the query is
     the problem — the ingest write is — and there is no version of this field that survives:

      · Truncating the stamp to the hour does not help. A delivery at 10:07 makes the value
        `10:00` immediately, so the delta is observable inside the same bucket. A bucket that a
        single event can advance is not aggregation, it is rounding.
      · Lagging it by a whole period only delays the observation. The test for a
        bucket argument is whether it DEFEATS a chosen-delivery probe or merely slows it.
      · A minimum-count threshold is a statement about a POPULATION, and this value's population
        is one account. k events reach any threshold k, and the observer chooses the events.

     So the grant on `change_log` is gone entirely — which is also what removes the
     `entity_id → messages.id` join key the same review flagged — and the field is null. The
     console renders null as "—", so the roster column degrades to a dash
     rather than to a wrong timestamp.

     WHAT AN OPERATOR STILL HAS for the same question: `syncLagSeconds` on this same row, from
     `mailboxes.last_sync_at` — the worker's own stamp, which advances on every cycle whether or
     not mail arrived and therefore carries no receipt information at all. "Is this account
     alive" was always better answered by "is the worker reaching their mailbox" than by "did
     anything change in their account", and the `sync_lag` alert rule pages on exactly that.

     THE WAY BACK, if a console ever needs change VOLUME rather than change IDENTITY: a
     deployment-wide count in an owner-side aggregate with no `account_id` column. Not a grant
     on this table. */

  return accountRows.map((account) => {
    const mb = mailboxByAccount.get(account.id);
    const sub = subs.get(account.id);
    return {
      id: account.id,
      name: account.name,
      ownerEmail: ownerEmail.get(account.id)?.email ?? "",
      plan: sub ? asPlan(sub.plan) : null,
      subscription: asStatus(sub?.status),
      // Presence in `account_suspensions` IS the suspension (cloud 0008), and its
      // `suspended_at` is what the roster and the `suspended` filter read. Null ⇒ not suspended.
      suspendedAt: suspendedAt.get(account.id) ?? null,
      mailboxCount: int(mb?.total),
      mailboxesInError: int(mb?.inError),
      mailboxesBlocked: int(mb?.blocked),
      // No subscription ⇒ entitled to ZERO mailboxes, not to a default.
      // The EFFECTIVE limit — base plus purchased add-on units — the same composition
      // `entitlementsFor` serves the product (cloud 0022).
      mailboxLimit: sub ? int(sub.mailboxLimit) + int(sub.addonMailboxes ?? 0) : 0,
      creditBalance: balances.get(account.id) ?? 0,
      syncLagSeconds: secondsSince(now, mb?.oldestSync ?? null),
      // ALWAYS NULL — see the block above `return` for why there is no safe version
      // of this field. The DTO keeps it so the console needs no change on the day a
      // deployment-wide change-volume aggregate replaces it.
      lastActivityAt: null,
      createdAt: asDate(account.createdAt).toISOString(),
    } satisfies AccountSummary;
  });
}

function selectSubscriptions(db: AdminDb): Promise<SubscriptionRow[]> {
  return db
    .select({
      accountId: billingSubscriptions.accountId,
      plan: billingSubscriptions.plan,
      status: billingSubscriptions.status,
      mailboxLimit: billingSubscriptions.mailboxLimit,
      monthlyCredits: billingSubscriptions.monthlyCredits,
      billingInterval: billingSubscriptions.billingInterval,
      addonStorageUnits: billingSubscriptions.addonStorageUnits,
      addonMailboxes: billingSubscriptions.addonMailboxes,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      graceUntil: billingSubscriptions.graceUntil,
      createdAt: billingSubscriptions.createdAt,
    })
    .from(billingSubscriptions) as unknown as Promise<SubscriptionRow[]>;
}

/**
 * `AccountQuery` → `AccountPage`. The predicates, the order and the clamping are the same
 * rules the console's own roster selection applies to fixtures.
 */
export async function adminAccounts(db: AdminDb, now: Date, query: AccountQuery = {}): Promise<AccountPage> {
  const roster = await loadRoster(db, now);
  const filter = query.filter ?? "all";
  const search = fold((query.search ?? "").trim());
  const pageSize = Math.min(
    ADMIN_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize) || ADMIN_DEFAULT_PAGE_SIZE)),
  );

  const matched = roster.filter((account) => {
    if (filter === "attention" && adminAttentionRank(account) <= 0) return false;
    if (filter === "suspended" && account.suspendedAt === null) return false;
    if (filter === "past_due" && account.subscription !== "past_due") return false;
    if (filter === "no_subscription" && account.subscription !== "none") return false;
    if (!search) return true;
    return fold(account.name).includes(search) || fold(account.ownerEmail).includes(search);
  });

  matched.sort((a, b) => adminAttentionRank(b) - adminAttentionRank(a) || a.name.localeCompare(b.name));

  // A stale bookmark to page 9 of a roster that shrank is not an error condition; clamp.
  const lastPage = Math.max(0, Math.ceil(matched.length / pageSize) - 1);
  const page = Math.min(Math.max(0, Math.trunc(Number(query.page) || 0)), lastPage);

  return {
    now: now.toISOString(),
    accounts: matched.slice(page * pageSize, page * pageSize + pageSize),
    matched: matched.length,
    total: roster.length,
    page,
    pageSize,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   One account
   ════════════════════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE PER-MAILBOX PENDING-MOVE COUNT — REMOVED, AND WHY NO VIEW REPLACES IT
   ════════════════════════════════════════════════════════════════════════════════════════

   `pendingMovesByMailbox` used to live here. It was the ONE place in this file that touched
   `messages`, it selected exactly one column of it (`mailbox_id`, a foreign key), and the
   comment above it said so with some pride. A review rated it High:

     > The staff role first resolves the target account's mailbox address and UUID from
     > `mailboxes`, then reads the current `messages.id` set (or just `count(*)`) for that
     > `mailbox_id`. It sends the chosen probe carrying the candidate RFC822 Message-ID, polls
     > the same query, and observes a new message row in that mailbox.

   The grant was minimal AS A PROJECTION and sufficient AS A CHANNEL. The information is in the
   row's EXISTENCE, `count(*)` names no column, and no narrower column list reaches it. So
   `public.messages`, `public.folder_state` and `public.flag_state` are un-granted outright and
   this function is deleted; `MailboxHealth.pendingMoves` is 0 and `oldestPendingMoveSeconds`
   null for every mailbox.

   ── WHY THE OBVIOUS FIX — A BUCKETED admin VIEW — IS NOT BUILT ──────────────────────────────

   The review proposed replacing row access with "purpose-built aggregates in schema `admin`, carrying
   no stable per-message identifier, with timestamps bucketed or delayed and a minimum
   aggregation threshold". That is the right shape for a cluster number and the wrong shape for
   this one, and the reason is a single sentence:

     **Aggregation is a statement about a population, and the population of a per-mailbox number
     is one mailbox — which is one account.**

   Every mechanism on that list is a population argument, so none of them applies here:

    · A bucket ladder (report 0 below 10, then 10 / 25 / 50 …) is defeated by driving the
      mailbox to the boundary. The observer cannot do that on a HEALTHY mailbox — the reconcile
      pass drains it in seconds, so the standing count is 0 — but on a mailbox whose reconcile
      path is broken the count climbs and the boundary arrives on its own.
    · A delay (`updated_at < now() - interval '15 minutes'`) is the strongest single mechanism
      available, because a healthy reconcile pass applies a chosen delivery's move and removes
      the row long before it qualifies. It is still not enough alone: a target whose reconcile
      path IS broken lets the observer wait the delay out.
    · A minimum threshold of k rows is reached by k chosen deliveries. The observer picks the
      recipient, so keylessness buys nothing either — a delivery addressed to the target is
      self-attributing, and an aggregate with no key still answers "did MY message land" when
      the observer is the one who sent it.

   ── AND WHY THE CLUSTER-WIDE NUMBER IS NOT BUILT HERE EITHER ────────────────────────────────

   A deployment-wide backlog IS a real population, and the shape that works is:

       pending      = count(*)                      over folder_state ⋈ messages
       mailboxes    = count(DISTINCT m.mailbox_id)     where reconcile_status = 'pending'
       oldest       = min(f.updated_at)                  AND f.updated_at < now() - D
       …all three suppressed entirely unless `mailboxes >= k`,
       …`pending` and `mailboxes` reported as floors on a ladder of 5.

     **D = 15 minutes**, argued: the reconcile pass runs on the worker's cycle, so a move still
     pending after fifteen minutes has missed many cycles. Below D the surface is blind BY
     CONSTRUCTION, so a chosen delivery to a healthy deployment can never register in it at all
     — which is the property a bucket ladder cannot give, because a ladder always has a
     boundary and a delay has no boundary to sit on.

     **k = 5 distinct mailboxes**, argued — and the argument is not anonymity-set size, which
     would be arbitrary. Every fault mode this panel exists to detect is SYSTEMIC: a stopped
     worker, a lost shard lease, a provider throttling every connection. All of them put the
     whole shard's mailbox set into the pending state at once and clear k=5 immediately. A
     single mailbox that cannot apply its moves is not a reconciler fault — it is that mailbox's
     fault, and it is already fully visible to staff through `mailboxes.status`, `error_code`,
     `error_detail`, `failed_at`, `retry_count` and `last_sync_at`, all legitimately granted.
     So k=5 separates the two populations the panel is meant to distinguish, rather than merely
     making attribution statistically harder. Below it the aggregate would be a single account's
     row wearing an aggregate's name.

   That view is not created here, and the reason is mechanical rather than a judgement
   about the design. `admin.audit_log` and `admin.credit_ledger` are readable by ONE query that
   also serves the PGlite harness, because each is a column-subset of a `public` relation of the
   same name and `search_path = admin, public` picks the right one per role. An AGGREGATE has no
   `public` counterpart, so serving it needs either a migration creating `public.reconcile_backlog`
   or a second copy of the view's SQL inside a test harness, which is the built-tested-unreachable
   pattern this codebase has been burned by.

   ── THE WAY BACK, WHICH IS THE ONE THIS FILE ALREADY NAMES ──────────────────────────────────

   **The PRODUCER promotes the value to a named column.** The reconciler knows its own backlog;
   `worker_heartbeats` is already granted, already keyless (one row per SHARD, never per
   mailbox), already written once per cycle, and already the relation the review checked and
   cleared as "aggregate-only". A `pending_moves` column there, carrying the bucketed value
   computed worker-side with D and k above, is the same number with none of the joins — and it
   needs a migration and a worker change, so it is filed as deferred work rather than done
   here. Until then the panel reads zero, which is the same honest-nothing
   this module already publishes for `LedgerEntry.meta`, `AuditEntry.payload`, `crons` and
   `retryBackoffSeconds` — and a zero on an ops panel is a smaller lie than a live receipt
   oracle is a breach.
   ════════════════════════════════════════════════════════════════════════════════════════ */

async function loadMailboxes(db: AdminDb, now: Date, accountIds: string[] | null): Promise<MailboxHealth[]> {
  const base = db
    .select({
      id: mailboxes.id,
      accountId: mailboxes.accountId,
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      provider: mailboxes.provider,
      authKind: mailboxes.authKind,
      status: mailboxes.status,
      lastSyncAt: mailboxes.lastSyncAt,
      createdAt: mailboxes.createdAt,
      errorCode: mailboxes.errorCode,
      errorDetail: mailboxes.errorDetail,
      failedAt: mailboxes.failedAt,
      retryCount: mailboxes.retryCount,
      syncBlockedReason: mailboxes.syncBlockedReason,
      syncBlockedSince: mailboxes.syncBlockedSince,
    })
    .from(mailboxes);
  const rows = accountIds === null
    ? await base.orderBy(mailboxes.address).limit(ADMIN_ROSTER_LIMIT)
    : await base.where(inArray(mailboxes.accountId, accountIds)).orderBy(mailboxes.address);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // PRESENCE ONLY. `secret_enc`, `key_version` and `meta` are never projected — this reads
  // whether a mailbox is connectable at all, which is what an operator diagnosing a dead
  // mailbox needs, and reads none of what makes it connectable.
  const credRows = await db
    .select({ mailboxId: mailboxCredentials.mailboxId })
    .from(mailboxCredentials)
    .where(and(inArray(mailboxCredentials.mailboxId, ids), eq(mailboxCredentials.transport, "imap")));
  const hasCred = new Set(credRows.map((r) => r.mailboxId));

  return rows.map((row) => {
    return {
      id: row.id,
      accountId: row.accountId,
      address: row.address,
      displayName: row.displayName,
      provider: row.provider,
      authKind: row.authKind === "oauth" ? "oauth" : "password",
      status: row.status === "error" || row.status === "disabled" ? row.status : "connected",
      lastSyncAt: iso(row.lastSyncAt),
      syncLagSeconds:
        row.status === "disabled" ? null : secondsSince(now, row.lastSyncAt ?? row.createdAt),
      // Mail 0023 closed the gap this comment used to apologise for: `mailboxes` records WHY.
      //
      // `lastError` is the taxonomy plus an ALLOWLISTED token — an IMAP response code, a Node
      // errno, a TLS constant, an SQLSTATE — and NEVER the error's message. That is what makes
      // the field safe to show an operator at all: a raw sync error can embed RFC822 header
      // bytes, and staff never see an account's mail. The redaction is at the
      // WRITE (`markMailboxFailed`), so this projection does not have to remember to be narrow.
      //
      // `retryBackoffSeconds` stays null, honestly: the backoff lives in the worker's in-memory
      // quarantine map and is not persisted. `retryCount` (how big this outage is) and the
      // backoff (when the next attempt lands) are different questions, and only the first is
      // durable — see the 0023 migration header.
      lastError: row.status === "error"
        ? (row.errorDetail ? `${row.errorCode ?? "unknown"}: ${row.errorDetail}` : row.errorCode ?? "unknown")
        : null,
      lastErrorAt: row.status === "error" ? iso(row.failedAt) : null,
      // Mail 0029, and its OWN bucket — NOT folded into `lastError`, and NOT gated on `status`.
      //
      // Both of those are the point. This is the case `syncLagSeconds` used to present with no
      // explanation whatsoever: a mailbox reading `connected` with a growing lag and a `lastError`
      // of `null` — a state an operator otherwise stares at with no explanation.
      // A gate on `status === 'error'` — the rule the two lines above follow — would make this
      // field permanently null, because every state it describes happens while the status is
      // `connected`. See the field's own comment in `admin-dto.ts` for why the two buckets must
      // stay separable rather than tidy.
      syncBlockedReason: isMailboxSyncBlockReason(row.syncBlockedReason) ? row.syncBlockedReason : null,
      syncBlockedSince: iso(row.syncBlockedSince),
      retryBackoffSeconds: null,
      // ALWAYS 0 / null — a per-mailbox count of unapplied folder moves is a
      // receipt-confirmation oracle in EVERY form, because its population is one account. The
      // block above this function has the argument in full, the bucketed cluster-wide shape that
      // does work, and where it has to be produced. The DTO keeps both fields so the console
      // needs no change on the day the worker publishes them.
      pendingMoves: 0,
      oldestPendingMoveSeconds: null,
      hasImapCredential: hasCred.has(row.id),
    } satisfies MailboxHealth;
  });
}

async function accountNames(db: AdminDb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * THE STATEMENT REASONS — every ledger reason that is NOT a metered debit.
 *
 * Grants (invoice, trial, staff adjustment), the renewal expiry, a staff clawback and a refund.
 * Each is one economic decision an operator reads on its own, which is what makes them worth
 * rendering raw; the four `debit_*` reasons are meter readings and are counted in
 * `credit_usage_daily` instead.
 *
 * This list and `credit_ledger_events_idx`'s partial predicate are the same set, and they have to
 * stay the same set: a reason added here and not to the index costs a partial-index scan, and a
 * reason added to the index and not here is a row nobody sees. `admin-usage.pg.test.ts` compares
 * them against the migration's text.
 */
const LEDGER_EVENT_REASONS = [
  "invoice_grant", "trial_grant", "period_expiry",
  "adjustment_credit", "adjustment_debit", "refund",
] as const satisfies readonly AdminLedgerReason[];

/**
 * THE UUID SHAPE, and it is a real one.
 *
 * This used to be `/^[0-9a-fA-F-]{36}$/`, which admits 36 hyphens and 36 hex digits with no
 * hyphens at all — neither is a uuid, both reach `eq(…accountId, …)`, and Postgres answers
 * SQLSTATE 22P02 into the route's catch-all. The comment at each call site claimed a 404 rather
 * than a 500; this is what makes that true.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many raw rows one day's drill-down may return. A day, not a lifetime. */
export const ADMIN_LEDGER_DAY_LIMIT = 200;

/** Days of usage the account page shows. A month, which is the billing period's own unit. */
export const ADMIN_USAGE_DAYS = 30;

/**
 * The roll-up's HOURLY cadence, restated in seconds for {@link PanelFreshness}.
 *
 * Copied as a number rather than imported from `@trafficflow/db/cloud`'s pass constants on
 * purpose: what a console panel needs is the cadence a reader should JUDGE the number against,
 * and the hourly arm is the one that keeps the daily rows current. The nightly arm widens the
 * window and adds the totals; it does not make an hourly figure any less late.
 */
export const ADMIN_USAGE_EXPECTED_EVERY_SECONDS = 60 * 60;

/**
 * The roll-up's NIGHTLY cadence, in seconds — what the Billing board's lifetime figures are on.
 *
 * A DIFFERENT number from the one above, and the difference is the point. `credit_usage_totals`
 * and the divergence count are written only by the wide nightly arm, so judging them against the
 * hourly cadence would report an incident every morning on a deployment doing exactly what it was
 * built to do — and a signal that cries wolf daily is a signal nobody reads.
 *
 * It is also why the two panels carry separate stamps rather than one: the account page's daily
 * bars really are refreshed hourly, and flattening both to one cadence would have to be wrong
 * about one of them.
 */
export const ADMIN_TOTALS_EXPECTED_EVERY_SECONDS = 24 * 60 * 60;

/**
 * The invoice reconciliation's own cadence — `reconcile-invoices.ts`'s daily pass, in seconds.
 * What {@link CashRevenue.reconciliation}'s freshness stamp is judged against.
 */
export const ADMIN_INVOICE_RECON_EXPECTED_EVERY_SECONDS = 24 * 60 * 60;

/**
 * The ledger — and the SECOND query in this module whose unqualified relation name
 * is doing work.
 *
 * drizzle emits `from "credit_ledger"`, and `ohmail_admin`'s `search_path` is `admin, public`:
 *
 *  · `admin.credit_ledger` — a `security_barrier` VIEW projecting the six money columns
 *    verbatim and `source` REDACTED — when the connection is the staff role;
 *  · `public.credit_ledger` — the table — under PGlite, where the harness has no roles.
 *
 * The role holds NO grant on `public.credit_ledger.source`, so this is not a projection that
 * could be relaxed: the raw column is unreadable on that connection whatever this file says.
 * The role-level test seeds one row per `ledgerSources` namespace from a known Message-ID and
 * asserts that its digest appears in NOTHING the staff role can select.
 */
async function loadLedger(
  db: AdminDb,
  accountId: string | null,
  opts?: { events?: boolean; day?: string; limit?: number },
): Promise<LedgerEntry[]> {
  const base = db
    .select({
      id: creditLedger.id,
      accountId: creditLedger.accountId,
      delta: creditLedger.delta,
      balanceAfter: creditLedger.balanceAfter,
      reason: creditLedger.reason,
      source: creditLedger.source,
      // `credit_ledger.meta` IS NOT SELECTED, and it is not selectable: `ohmail_admin` holds
      // no grant on it, so naming it here would raise 42501 rather than leak. See the header.
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger);
  const filters = [
    ...(accountId === null ? [] : [eq(creditLedger.accountId, accountId)]),
    // THE STATEMENT PREDICATE — the complement of the four metered `debit_*` reasons, matching
    // `credit_ledger_events_idx`'s partial predicate EXACTLY. If the two ever diverge the query
    // still answers correctly and stops using the index, which is a silent performance loss;
    // they are written as one list in the migration and one list here, and the pg test asserts
    // the planner uses the index for this read.
    ...(opts?.events === true ? [inArray(creditLedger.reason, LEDGER_EVENT_REASONS as unknown as string[])] : []),
    // The drill-down's day window, half-open, on `created_at` — the same boundary the roll-up
    // aggregates by, so a day expanded here holds exactly the rows the bar above it counted.
    //
    // The offset is written into the literal (`+00`) rather than left to a `date` cast, because a
    // bare `'2026-09-03'::timestamptz` is midnight in the SESSION's time zone. On a database
    // configured anywhere but UTC that silently shifts every day boundary by the offset, so a
    // drill-down would show a day's rows the bar above it did not count — and nothing would fail.
    ...(opts?.day === undefined ? [] : [
      sql`${creditLedger.createdAt} >= (${opts.day} || ' 00:00:00+00')::timestamptz`,
      sql`${creditLedger.createdAt} < (${opts.day} || ' 00:00:00+00')::timestamptz + interval '1 day'`,
    ]),
  ];
  const rows = await (filters.length === 0 ? base : base.where(and(...filters)))
    .orderBy(desc(creditLedger.id))
    .limit(opts?.limit ?? ADMIN_LIST_LIMIT);
  const names = await accountNames(db, rows.map((r) => r.accountId));
  return rows.map((row) => ({
    id: String(row.id),
    accountId: row.accountId,
    accountName: names.get(row.accountId) ?? "",
    delta: int(row.delta),
    balanceAfter: int(row.balanceAfter),
    reason: row.reason as LedgerEntry["reason"],
    // **REDACTED BY THE DATABASE, not by this projection — and the sentence that used to
    // stand here ("SAFE BY CONSTRUCTION … every foreign input is sha256'd") WAS FALSE**,
    // as a review pointed out. A sha-256 of a guessable input is a confirmation oracle, not a
    // redaction:
    // hash a candidate Message-ID or subject, compare, and you have learned that this account
    // received that exact mail. On the staff connection this value comes from
    // `admin.credit_ledger`, which keeps the NAMESPACE TOKEN and drops everything after it —
    // including the `refund:classify:…` and `refund:draft:…` forms, which carry the original
    // digest one prefix deeper. That truncation was widened from "the final `:`-segment" to
    // "everything after the namespace", because `draft:<message uuid>:` was itself a join key
    // back to `messages.id`. Under PGlite there is no view
    // and no role, so this field is the raw source; the api-level tests assert the PROJECTION
    // half and the role-level test asserts the ROLE half. Neither substitutes for the other.
    source: row.source,
    createdAt: asDate(row.createdAt).toISOString(),
    // ALWAYS EMPTY, and the DTO keeps the field so the console's table needs no change on the
    // day a named column replaces the bag. `credit_ledger.meta` is un-granted; the staff-meta
    // gate that used to project it is gone with it — see the block above for what that costs
    // and how a value comes back.
    meta: {},
  }));
}

/**
 * WHEN THE AGGREGATES WERE LAST COMPUTED — the newest `credit_rollup_runs` row's clock.
 *
 * The newest COMPLETED run, and the `error is null` in the predicate is the whole point: a pass
 * that failed still writes a row (so that "it stopped running" and "it is failing" are
 * distinguishable), and reading that row's `ran_at` as a freshness stamp would report the
 * aggregates as current at the exact moment the thing that produces them broke. That is
 * `billing_reconciliation_runs`' rule for its own staleness read, and it is here for the same
 * reason it is there.
 *
 * `divergentAccounts` comes off the newest run that MEASURED it — a different row from the
 * freshness one, because the hourly arm does not measure divergence and would otherwise reset the
 * figure to "unknown" fifty-nine minutes out of every sixty.
 */
async function loadRollupState(db: AdminDb): Promise<RollupState> {
  // ── THE DAILY STAMP — the newest COMPLETED run ─────────────────────────────────────────
  //
  // `error is null` is the load-bearing half. A pass that FAILED still writes a row, so that "it
  // stopped running" and "it is failing" stay distinguishable; reading that row's `ran_at` as a
  // freshness stamp would report the aggregates as current at the exact moment the thing that
  // produces them broke. `billing_reconciliation_runs` follows the same rule for the same reason.
  const [fresh] = await db
    .select({ ranAt: creditRollupRuns.ranAt })
    .from(creditRollupRuns)
    .where(sql`${creditRollupRuns.error} is null`)
    .orderBy(desc(creditRollupRuns.ranAt))
    .limit(1);

  // ── THE TOTALS STAMP — READ OFF THE TOTALS THEMSELVES, not off a run row ───────────────
  //
  // This is the distinction that matters, and reading it off `credit_rollup_runs` was wrong:
  // `credit_usage_totals` is written ONLY by the nightly arm, and an HOURLY pass writes a
  // perfectly successful run row without touching it. A stamp taken from the newest completed run
  // would therefore say "computed four minutes ago" over totals a week old — which is precisely
  // the failure the per-panel stamp was added to prevent, reintroduced by the stamp itself.
  //
  // `max(computed_at)` off the table cannot lie about it: the pass sets that column to its own
  // clock on every row it writes, so the newest value IS the moment the totals were last
  // produced, whatever the run ledger says. `null` — no rows — means they never have been.
  const [totalsRow] = await db
    .select({ at: sql<string | null>`max(${creditUsageTotals.computedAt})` })
    .from(creditUsageTotals);
  const totalsComputedAt = totalsRow?.at ? asDate(totalsRow.at).toISOString() : null;

  const [measured] = await db
    .select({ divergent: creditRollupRuns.divergentAccounts })
    .from(creditRollupRuns)
    .where(sql`${creditRollupRuns.error} is null and ${creditRollupRuns.divergentAccounts} is not null`)
    .orderBy(desc(creditRollupRuns.ranAt))
    .limit(1);

  return {
    computedAt: fresh ? asDate(fresh.ranAt).toISOString() : null,
    totalsComputedAt,
    // −1 and not 0: "no roll-up has ever measured this" must not render as "no divergence".
    divergentAccounts: measured?.divergent == null ? -1 : int(measured.divergent),
  };
}

interface RollupState {
  /** Newest completed run of EITHER arm — what the hourly daily rows are as fresh as. */
  computedAt: string | null;
  /** When `credit_usage_totals` was last written. NIGHTLY, and a different clock entirely. */
  totalsComputedAt: string | null;
  /** `findCreditDivergence`'s count from the newest run that measured it; `-1` ⇒ never. */
  divergentAccounts: number;
}

/**
 * ONE ACCOUNT'S CREDIT USAGE — thirty days of aggregate, plus the statement.
 *
 * This replaced a read of the newest fifty raw ledger rows, which was two things at once and bad
 * at both. On an account that has been screening, forty-nine of those fifty are `debit_classify`
 * and the rows an operator opened the page for — the invoice grant, the renewal expiry, the
 * adjustment somebody made last week — are off the bottom of the list. Splitting the read by what
 * each half is FOR fixes both: the meter readings become a shape you can look at, and the
 * decisions become a list short enough to read.
 *
 * Both halves are bounded reads on indexes built for them:
 * `credit_usage_daily_account_day_idx` and the partial `credit_ledger_events_idx`.
 */
async function loadUsage(db: AdminDb, accountId: string, now: Date): Promise<AccountUsage> {
  // Half-open from midnight UTC of the oldest day shown, so the boundary day is whole. Computed
  // from the reader's `now` rather than from `current_date`, so the page and its own stamp agree
  // about which day is "today".
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  floor.setUTCDate(floor.getUTCDate() - (ADMIN_USAGE_DAYS - 1));
  const floorKey = floor.toISOString().slice(0, 10);

  const dailyRows = await db
    .select({
      day: creditUsageDaily.day,
      pool: creditUsageDaily.pool,
      reason: creditUsageDaily.reason,
      credits: creditUsageDaily.credits,
      rows: creditUsageDaily.rows,
    })
    .from(creditUsageDaily)
    .where(and(
      eq(creditUsageDaily.accountId, accountId),
      sql`${creditUsageDaily.day} >= ${floorKey}::date`,
    ))
    .orderBy(desc(creditUsageDaily.day));

  const events = await loadLedger(db, accountId, { events: true });
  const state = await loadRollupState(db);

  return {
    daily: dailyRows.map((r) => ({
      // `date` comes back as a string on one driver and a Date on the other. Normalize to the
      // key the drill-down takes, so the console can hand a bar's own day straight back.
      day: typeof r.day === "string" ? r.day.slice(0, 10) : asDate(r.day).toISOString().slice(0, 10),
      pool: r.pool as UsageDay["pool"],
      reason: r.reason as AdminLedgerReason,
      credits: int(r.credits),
      rows: int(r.rows),
    })),
    events,
    freshness: {
      computedAt: state.computedAt,
      expectedEverySeconds: ADMIN_USAGE_EXPECTED_EVERY_SECONDS,
    },
  };
}

/**
 * THE ACCOUNT'S SETUP POOL, as the console shows it.
 *
 * LIVE grants only — unexpired, with something left — which is the same predicate
 * `setupPoolOf` uses for the customer's own settings row. Staff and customer read one number, so
 * a support conversation cannot be two people looking at two different figures.
 *
 * `granted` and `remaining` are summed across those live grants because an account carrying
 * pre-0028 per-mailbox pools legitimately has several, and `expiresAt` is the FURTHEST horizon —
 * "usable until", the sentence a single row can honestly say about a set. `kind` reports
 * `'account'` when any live pool is one, because the presence of the new-style pool is the fact a
 * support answer turns on.
 *
 * `mailbox_id` is not read and is not readable: the blind role holds no grant on it.
 */
async function loadSetupPool(
  db: AdminDb, accountId: string, now: Date,
): Promise<SetupPoolView | null> {
  const rows = await db
    .select({
      kind: setupGrants.kind,
      granted: setupGrants.granted,
      remaining: setupGrants.remaining,
      expiresAt: setupGrants.expiresAt,
    })
    .from(setupGrants)
    .where(and(
      eq(setupGrants.accountId, accountId),
      sql`${setupGrants.expiresAt} > ${now.toISOString()}::timestamptz`,
      sql`${setupGrants.remaining} > 0`,
    ));
  if (rows.length === 0) return null;
  return {
    kind: rows.some((r) => r.kind === "account") ? "account" : "mailbox",
    granted: rows.reduce((n, r) => n + int(r.granted), 0),
    remaining: rows.reduce((n, r) => n + int(r.remaining), 0),
    expiresAt: new Date(Math.max(...rows.map((r) => asDate(r.expiresAt).getTime()))).toISOString(),
  };
}

/**
 * THE DRILL-DOWN — one account, one day, the raw rows, ON PRESS.
 *
 * Separate from {@link loadUsage} because of when it runs, not because of what it reads: the
 * account page shows thirty days of aggregate and this answers "what were those twelve
 * classifications" for ONE of them, when somebody asks. Fetching every day's rows in case a
 * reader expands one is exactly the read the aggregates were built to stop making.
 *
 * Capped at {@link ADMIN_LEDGER_DAY_LIMIT}, and the cap is REPORTED rather than silently
 * applied — a truncated day rendered as a complete one is a list that lies by being short.
 */
export async function adminAccountLedgerDay(
  db: AdminDb, now: Date, accountId: string, day: string,
): Promise<LedgerDay | null> {
  // Both inputs come off the URL. A malformed id is a 404 rather than a Postgres
  // `invalid input syntax for type uuid` 500, and a malformed day likewise — the day is
  // concatenated into a timestamptz cast, so this shape check IS the parameter's validation.
  if (!UUID_RE.test(accountId)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // AND THE CALENDAR HAS TO AGREE, not just the shape. `2026-13-45` matches the pattern; built
  // through `Date.UTC` it rolls forward into a different month, so the round-trip is what refuses
  // it. Without this the value reaching the database is a well-shaped string naming no day, and
  // Postgres decides what to do with it rather than this function.
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== day) return null;

  // One row over the cap, so "there were more" is measured rather than inferred from a full page.
  const rows = await loadLedger(db, accountId, { day, limit: ADMIN_LEDGER_DAY_LIMIT + 1 });
  return {
    now: now.toISOString(),
    accountId,
    day,
    entries: rows.slice(0, ADMIN_LEDGER_DAY_LIMIT),
    capped: rows.length > ADMIN_LEDGER_DAY_LIMIT,
  };
}

/**
 * `admin.*` audit rows only. Today there is no writer for that namespace, so the answer is
 * always `[]`, and the console renders that as the empty state it already has.
 *
 * ── THE UNQUALIFIED NAME IS DOING WORK ────────────────────────────────────────────────────
 *
 * drizzle emits `from "audit_log"` with no schema qualifier, and `ohmail_admin`'s `search_path`
 * is `admin, public`. So this ONE query reads:
 *
 *  · `admin.audit_log` — a `security_barrier` VIEW carrying the `LIKE 'admin.%'` predicate and
 *    projecting four named scalars — when the connection is the staff role;
 *  · `public.audit_log` — the table — under PGlite, where the harness has no roles at all.
 *
 * The role holds NO grant on `public.audit_log`, so widening this projection back to `payload`
 * or `inverse` raises 42501 in production instead of quietly reading a jsonb bag whose contents
 * no field name bounds. The `LIKE` below is therefore a duplicate of the view's own predicate,
 * and it stays: it is what keeps the PGlite path identical, and a filter stated in both places
 * cannot be widened in one.
 */
async function loadAudit(db: AdminDb, accountId: string | null): Promise<AuditEntry[]> {
  const adminNamespace = sql`${auditLog.action} like 'admin.%'`;
  const rows = await db
    .select({
      id: auditLog.id,
      accountId: auditLog.accountId,
      action: auditLog.action,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(accountId === null ? adminNamespace : and(adminNamespace, eq(auditLog.accountId, accountId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(ADMIN_LIST_LIMIT);
  const names = await accountNames(db, rows.map((r) => r.accountId));
  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    accountName: names.get(row.accountId) ?? "",
    action: row.action,
    // Both bags are un-granted and unread. The DTO keeps the fields so the console's table
    // needs no change on the day a staff write path promotes an actor to a named column.
    payload: {},
    inverse: null,
    // There is no `audit_log.actor` column and no admin write, so it is empty rather than
    // invented — and it can no longer be recovered from the payload, which is the point.
    actor: "",
    createdAt: asDate(row.createdAt).toISOString(),
  } satisfies AuditEntry));
}

/**
 * The account's SECURITY events — today exactly one kind, `refresh_reuse_revoked` (the rotation's
 * reuse branch writes it when a consumed refresh token is re-presented and the family is swept).
 * Surfaced on the account view because the sweep is silent on every user surface, and the Aug-21
 * incident was reconstructed from raw session rows for want of exactly this list.
 *
 * COLUMNS ARE THE STAFF ALLOWLIST'S (`staff-grants.ts`: auth_events id/account_id/user_id/
 * event/at) — never `device` (a client-chosen user-agent string, or the reuse row's family id:
 * both are investigation detail read over a privileged database connection, not console
 * material) and never `ip`. The filter is `event = 'refresh_reuse_revoked'`, not "all auth
 * events": login/logout traffic is activity, and this panel is for the rows that mean an
 * incident.
 *
 * ISOLATION POSTURE, same as the alert rules': a staff handle the provisioner's widened grant
 * has not reached yet answers 42501 — that must cost exactly this list (empty, and the page
 * renders), never the account view. Anything else propagates.
 */
async function loadSecurityEvents(db: AdminDb, accountId: string): Promise<SecurityEvent[]> {
  try {
    const rows = await db
      .select({ id: authEvents.id, event: authEvents.event, at: authEvents.at })
      .from(authEvents)
      .where(and(eq(authEvents.accountId, accountId), eq(authEvents.event, "refresh_reuse_revoked")))
      .orderBy(desc(authEvents.at))
      .limit(ADMIN_LIST_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      event: r.event as SecurityEvent["event"],
      at: asDate(r.at).toISOString(),
    }));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "42501") return [];
    throw err;
  }
}

export async function adminAccountDetail(db: AdminDb, now: Date, id: string): Promise<AccountDetail | null> {
  // A malformed id must be a 404, not a Postgres `invalid input syntax for type uuid` 500 —
  // the path segment is whatever the caller typed.
  if (!UUID_RE.test(id)) return null;
  const roster = await loadRoster(db, now);
  const account = roster.find((a) => a.id === id);
  if (!account) return null;

  const sub = newestByAccount(await selectSubscriptions(db)).get(id) ?? null;
  // Sequential — the max:1 blind pool deadlocks on parallel reads when one opens a
  // transaction (see adminWorker above). Same rule for every admin read group.
  const mailboxList = await loadMailboxes(db, now, [id]);
  const usage = await loadUsage(db, id, now);
  const setupCredits = await loadSetupPool(db, id, now);
  const audit = await loadAudit(db, id);
  const securityEvents = await loadSecurityEvents(db, id);

  return {
    now: now.toISOString(),
    account,
    mailboxes: mailboxList,
    entitlements: {
      // The EFFECTIVE limit — base plus purchased add-on units — the same composition
      // `entitlementsFor` serves the product (cloud 0022).
      mailboxLimit: sub ? int(sub.mailboxLimit) + int(sub.addonMailboxes ?? 0) : 0,
      monthlyCredits: sub ? int(sub.monthlyCredits) : 0,
      periodStart: sub ? iso(sub.currentPeriodStart) : null,
      periodEnd: sub ? iso(sub.currentPeriodEnd) : null,
      cancelAtPeriodEnd: sub ? Boolean(sub.cancelAtPeriodEnd) : false,
      graceUntil: sub ? iso(sub.graceUntil) : null,
      setupCredits,
    },
    usage,
    audit,
    securityEvents,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Billing
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE TWO QUANTITIES, KEPT APART.
 *
 * A review of the console put it plainly: *"you are mixing Credits outstanding and
 * actual billing / revenue data."* It was right, and the mixing was structural rather than
 * cosmetic — this function used to answer `totals: { accounts, creditsOutstanding, mrrCents }`,
 * one object holding an account count, a number of CREDITS and a number of CENTS, which the
 * console rendered as three peers in one definition list.
 *
 * A credit is a LIABILITY: service already owed, whether it was paid for or handed out. Money
 * is money. They are different sides of the business, they are denominated in different units,
 * and neither converts to the other at any rate this database knows. So the snapshot now
 * carries {@link BillingRevenue} (cents, and nothing but) and {@link CreditLiability} (credits,
 * and nothing but), and the console has a panel for each.
 *
 * ── WHAT THE BLIND ROLE CAN AND CANNOT ESTABLISH ──────────────────────────────────────────
 * `billing_events.payload` is still un-granted and still off limits — the raw Stripe event
 * carries the customer's name and postal address, and nothing here reads it. What CHANGED
 * (cloud 0029) is that a settled-revenue figure no longer requires it: `billing_invoices`
 * promotes the one integer the board needs onto a table with no name, no address and no line
 * item, granted to the staff role whole (`staff-grants.ts`). `revenue.cash` is read from it —
 * see {@link CashRevenue} and `loadCashRevenue` below. Every other query here reads columns
 * `ohmail_admin` already held before this slice:
 *   · `credit_ledger(account_id, delta, reason)` — via `admin.credit_ledger`, the redacting view
 *   · `credit_balances(account_id, balance)`
 *   · `billing_events(type, status)`
 *   · `billing_subscriptions(plan, status)`
 *
 * ── SEQUENTIAL, NOT PARALLEL ──────────────────────────────────────────────────────────────
 * The blind pool is `max: 1` and deadlocks when a second read opens while one holds the
 * connection. Every await below is deliberately serial; do not `Promise.all` them.
 */

/**
 * CASH, FROM `billing_invoices` — ONE aggregate statement, and the month bounds are in its
 * `WHERE`, not only in its `FILTER`s.
 *
 * **That distinction is the whole reason this read is bounded, and the first version got it
 * wrong.** With `where status = 'paid'` alone and the month expressed only inside
 * `count(*) filter (…)`, the planner has to hand EVERY paid invoice this deployment has ever
 * written to the aggregate node — there is no index on `status`, so the figure's cost grows with
 * the age of the account book while three comments (this one included) claimed it was bounded by
 * `billing_invoices_paid_at_idx`. It is bounded now because `paid_at` is in the predicate the
 * index can serve. `paidToday` stays a `FILTER` and is still correct: today is inside this month
 * by construction, so it narrows the same rows rather than needing any of its own.
 *
 * `paid_at`, never `created_at`: a reconcile-healed row keeps the invoice's real payment month
 * even though the MIRROR row was written later, on whatever day the pass ran.
 *
 * ── AND IT GROUPS BY CURRENCY RATHER THAN SUMMING ACROSS ONE ─────────────────────────────
 * `sum(amount_paid_cents)` over a month holding both USD and EUR invoices is minor units added
 * to different minor units: a number denominated in nothing, which `money()` would then render
 * with a `$`. So the statement groups, the largest-settling currency is the one reported, and
 * {@link CashRevenue.otherCurrencies} counts the ones this figure therefore does NOT include —
 * the same qualifier `AdminCostSnapshot.unmeasuredProviders` is for, and for the same reason:
 * silently dropping money is the failure this board exists to refuse, and so is inventing a sum
 * that no currency actually holds. It is 0 on every deployment that sells in one currency, which
 * is every deployment today.
 */
async function loadCashRevenue(db: AdminDb, now: Date): Promise<CashRevenue> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = monthStart.toISOString().slice(0, 7);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      currency: billingInvoices.currency,
      paidInvoices: sql<number>`count(*)::int`,
      paidCents: sql<string>`coalesce(sum(${billingInvoices.amountPaidCents}), 0)::bigint`,
      refundedCents: sql<string>`coalesce(sum(${billingInvoices.amountRefundedCents}), 0)::bigint`,
      paidToday: sql<number>`count(*) filter (where ${billingInvoices.paidAt} >= ${dayStart.toISOString()}::timestamptz and ${billingInvoices.paidAt} < ${dayEnd.toISOString()}::timestamptz)::int`,
    })
    .from(billingInvoices)
    .where(and(
      eq(billingInvoices.status, "paid"),
      sql`${billingInvoices.paidAt} >= ${monthStart.toISOString()}::timestamptz`,
      sql`${billingInvoices.paidAt} < ${monthEnd.toISOString()}::timestamptz`,
    ))
    .groupBy(billingInvoices.currency);

  // The currency that SETTLED the most this month is the one reported. Ordered here rather than
  // in SQL because the net (paid − refunded) is the comparison that matters and it is computed
  // per row below anyway; the set is one row per currency, so this sorts at most a handful.
  const byCurrency = rows
    .map((r) => ({
      currency: r.currency,
      paidInvoices: int(r.paidInvoices),
      netCents: int(r.paidCents) - int(r.refundedCents),
      paidToday: int(r.paidToday),
    }))
    .sort((a, b) => b.netCents - a.netCents);
  const lead = byCurrency[0] ?? null;

  const reconciliation = await loadInvoiceReconciliation(db);

  return {
    month,
    paidInvoices: lead?.paidInvoices ?? 0,
    mtdCents: lead?.netCents ?? 0,
    paidToday: lead?.paidToday ?? 0,
    // "usd" when the month holds no paid invoice at all — a label for an empty figure, not a
    // claim that anything settled in it.
    currency: lead?.currency ?? "usd",
    otherCurrencies: Math.max(0, byCurrency.length - 1),
    reconciliation,
  };
}

async function loadInvoiceReconciliation(db: AdminDb): Promise<InvoiceReconciliationView> {
  const [run] = await db
    .select({
      ranAt: billingReconciliationRuns.ranAt,
      flagged: billingReconciliationRuns.flagged,
      // The HEALED count. `flagged` includes rows the pass fixed itself, so without this the
      // console cannot tell a self-healed lost webhook from a divergence needing a person.
      invoicesUpserted: billingReconciliationRuns.invoicesUpserted,
      truncated: billingReconciliationRuns.truncated,
    })
    .from(billingReconciliationRuns)
    .where(and(
      sql`${billingReconciliationRuns.error} is null`,
      eq(billingReconciliationRuns.mode, "invoices"),
    ))
    .orderBy(desc(billingReconciliationRuns.ranAt))
    .limit(1);

  const flagged = (run?.flagged ?? {}) as Record<string, number>;
  const flaggedTotal = Object.values(flagged).reduce((sum, n) => sum + Number(n), 0);

  return {
    freshness: {
      // `null` ⇒ the pass has never completed on this deployment — a distinct state from "ran
      // and found nothing", and the console must be able to say which one it is holding.
      computedAt: run ? asDate(run.ranAt).toISOString() : null,
      expectedEverySeconds: ADMIN_INVOICE_RECON_EXPECTED_EVERY_SECONDS,
    },
    flagged,
    flaggedTotal,
    healed: int(run?.invoicesUpserted ?? 0),
    truncated: run?.truncated ?? false,
  };
}

export async function adminBilling(db: AdminDb, now: Date): Promise<BillingSnapshot> {
  const accountRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
  const subs = newestByAccount(await selectSubscriptions(db));

  type Bucket = { accounts: number; contractedMrrCents: number };
  const byStatus = new Map<AdminSubscriptionStatus, Bucket>();
  for (const status of ADMIN_SUBSCRIPTION_ORDER) byStatus.set(status, { accounts: 0, contractedMrrCents: 0 });
  for (const account of accountRows) {
    const sub = subs.get(account.id);
    const status = asStatus(sub?.status);
    const bucket = byStatus.get(status) ?? { accounts: 0, contractedMrrCents: 0 };
    bucket.accounts += 1;
    const plan = sub ? asPlan(sub.plan) : null;
    // Both buckets get the price; WHICH total it lands in is decided below, by status. A
    // per-status figure that silently zeroed `past_due` would hide the at-risk book entirely.
    if (plan && (CONTRACTED_STATUSES.has(status) || AT_RISK_STATUSES.has(status))) {
      bucket.contractedMrrCents += rowMrrCents(plan, sub);
    }
    byStatus.set(status, bucket);
  }
  const subscriptionStates = ADMIN_SUBSCRIPTION_ORDER.map((status) => ({
    status,
    accounts: byStatus.get(status)?.accounts ?? 0,
    contractedMrrCents: byStatus.get(status)?.contractedMrrCents ?? 0,
  }));

  // Read before `revenue` is built so the object literal can carry `cash` from construction
  // rather than being patched afterward — sequential on the same `max: 1` connection either way.
  const cash = await loadCashRevenue(db, now);

  const revenue: BillingRevenue = {
    contractedMrrCents: subscriptionStates
      .filter((s) => CONTRACTED_STATUSES.has(s.status))
      .reduce((sum, s) => sum + s.contractedMrrCents, 0),
    atRiskMrrCents: subscriptionStates
      .filter((s) => AT_RISK_STATUSES.has(s.status))
      .reduce((sum, s) => sum + s.contractedMrrCents, 0),
    // Filled in below from `billing_events`. COUNTS, never amounts — `billing_events.payload` is
    // still un-granted, so a role that cannot read it cannot exclude a trial's $0 rows from this
    // COUNT of applications. The settled figure now lives on `cash` instead, read from the
    // invoice mirror — this field's name still carries the older limit on purpose, because it
    // still is one: `appliedInvoiceEvents` counts applications, never payments.
    appliedInvoiceEvents: 0,
    failedPaymentEvents: 0,
    cash,
  };

  const eventCounts = await db
    .select({
      type: billingEvents.type,
      status: billingEvents.status,
      count: sql<number>`count(*)::int`,
    })
    .from(billingEvents)
    .groupBy(billingEvents.type, billingEvents.status);
  for (const row of eventCounts) {
    // `applied` only. A `failed` invoice.paid is money Stripe took and credits nobody granted —
    // it belongs to the failed queue above, not to a tally of applications that worked.
    if (row.type === "invoice.paid" && row.status === "applied") {
      revenue.appliedInvoiceEvents += int(row.count);
    }
    // Any status: a payment failure is a fact about the customer's card, and whether OUR apply
    // of that event succeeded says nothing about it.
    if (row.type === "invoice.payment_failed") revenue.failedPaymentEvents += int(row.count);
  }

  /**
   * THE LEDGER READS, ON ONE SNAPSHOT — and there are two of them now, not three.
   *
   * ── WHAT THIS USED TO BE, AND WHY IT COULD NOT STAY ───────────────────────────────────────
   *
   * Three UNCAPPED aggregates over `credit_ledger`, on every console load: the lifetime flows
   * grouped by reason, the same ledger grouped by account, and a distinct scan for accounts that
   * ever had an invoice. Each was correct. Together they were a full pass over a table that is
   * append-only, never pruned, and grows with every metered action — so the cost of opening the
   * Billing page grew with the age of the deployment and nothing about the page said so.
   *
   * They read `credit_usage_totals` now, which the roll-up aggregates from `credit_ledger` WHOLE,
   * once a night, on the worker. Not from `credit_usage_daily`: that table holds only the days
   * some pass recomputed — two or three — so totals summed from it would be the WINDOW's totals
   * wearing the word "lifetime", and this function compares them against `outstanding`, a live
   * sum over the account's whole history. The board would report a permanent drift of the
   * deployment's entire lifetime on a database with nothing wrong with it.
   *
   * The cost is a whole-table `GROUP BY` — a real one, and a NIGHTLY one, beside the divergence
   * pass that already walks the same table in the same run. What this change removed was that
   * scan running on every console page load, which is a different thing entirely.
   *
   * ── THE SNAPSHOT ARGUMENT, RESTATED HONESTLY BECAUSE IT CHANGED ───────────────────────────
   *
   * The transaction used to make the reconciliation identity well-defined: balances and flows
   * from ONE snapshot, so a credit movement committing between two statements could not appear as
   * drift. That is no longer what is happening — the totals are an aggregate computed at some
   * earlier moment, and no isolation level can put them in the same instant as a live balance
   * read. Pretending otherwise by keeping the transaction and saying nothing would be the worse
   * outcome: a comparison that LOOKS synchronised and is not.
   *
   * So the per-account divergence count moved to where it can still be one statement —
   * `findCreditDivergence`, run by the roll-up — and it arrives here with a `computedAt` beside
   * it. What is left in this transaction is the two reads the console still SUBTRACTS from each
   * other, and they are consistent with each other exactly as before.
   *
   * Still SEQUENTIAL inside, for the reason the header gives: the blind pool is `max: 1`.
   */
  const snapshot = await db.transaction(async (tx) => {
    const balanceRows = await tx
      .select({ accountId: creditBalances.accountId, balance: creditBalances.balance })
      .from(creditBalances);

    /**
     * The lifetime flows, from the roll-up's totals rather than from the ledger.
     *
     * `pool = 'ledger'` because these figures reconcile against `credit_balances`, and the setup
     * pool has no balance row — it is separate money with its own remainder and its own expiry.
     * Summing the two would put credits into a liability figure that `credit_balances` has never
     * heard of, and the console's reconciliation would report drift on a healthy database.
     */
    const flowRows = await tx
      .select({
        reason: creditUsageTotals.reason,
        total: sql<number>`coalesce(sum(${creditUsageTotals.credits}), 0)::int`,
      })
      .from(creditUsageTotals)
      .where(eq(creditUsageTotals.pool, "ledger"))
      .groupBy(creditUsageTotals.reason);

    /**
     * Accounts that have NEVER had an `invoice_grant` row. With no rollover — every renewal
     * expires the whole balance and grants the new month — an account that never had an invoice
     * can only be holding credits somebody gave it, so the balances of these accounts are
     * EXACTLY the granted-never-sold liability rather than an apportionment.
     *
     * One row per (account, reason) in the totals table, so this is a bounded read of the
     * accounts that HAVE been invoiced rather than a distinct scan of every ledger row.
     */
    const invoicedRows = await tx
      .select({ accountId: creditUsageTotals.accountId })
      .from(creditUsageTotals)
      .where(and(
        eq(creditUsageTotals.pool, "ledger"),
        eq(creditUsageTotals.reason, "invoice_grant"),
      ));

    return { balanceRows, flowRows, invoicedRows };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  // Outside the transaction deliberately: these are the roll-up's OWN stamps, and putting them
  // in the snapshot would suggest they share its instant. They do not, which is the whole reason
  // they travel as freshness rather than as figures.
  const rollup = await loadRollupState(db);

  const balances = new Map(snapshot.balanceRows.map((r) => [r.accountId, int(r.balance)]));
  const flow = new Map<string, number>(snapshot.flowRows.map((r) => [r.reason, int(r.total)]));
  const sumOf = (...reasons: readonly AdminLedgerReason[]): number =>
    reasons.reduce((sum, reason) => sum + (flow.get(reason) ?? 0), 0);
  const everInvoiced = new Set(snapshot.invoicedRows.map((r) => r.accountId));

  /**
   * The per-account divergence, as the roll-up measured it. See the DTO field: this is now
   * BOTH arms of `findCreditDivergence` (sum-vs-balance and `balance_after`-vs-balance) rather
   * than the one arm this function could express, and `-1` means no pass has ever measured it.
   */
  const divergentAccounts = rollup.divergentAccounts;

  let outstanding = 0;
  let outstandingNeverInvoiced = 0;
  let accountsWithBalance = 0;
  for (const [accountId, balance] of balances) {
    outstanding += balance;
    if (balance > 0) {
      accountsWithBalance += 1;
      if (!everInvoiced.has(accountId)) outstandingNeverInvoiced += balance;
    }
  }

  /**
   * THE ONE FIGURE WHOSE MEANING INVERTS WHEN THE AGGREGATE IS ABSENT, rather than merely
   * shrinking — which is why it gets the `-1` treatment and its neighbours do not.
   *
   * `outstandingNeverInvoiced` is computed by INVERTING `everInvoiced`: a balance counts toward it
   * when the account is NOT in the invoiced set. Every other lifetime figure is a sum, so an empty
   * `credit_usage_totals` makes it zero — visibly, obviously nothing. This one goes the other way:
   * an empty set means nobody has ever been invoiced, so the WHOLE liability is reported as
   * granted-never-sold. Before the worker's first roll-up the board would therefore say every
   * credit outstanding has no revenue behind it, in red, against the one invariant this figure
   * exists to police — a maximally alarming number that measured nothing.
   *
   * `-1` on the same terms as `divergentAccounts`: a value the console's `?? 0` fallback cannot
   * manufacture, so "not measured" and "none" stay distinguishable, and `grantedLiabilitySeverity`
   * reads a negative share as `idle` rather than grading it.
   */
  //
  // KEYED TO THE TOTALS AND NOT TO A RUN ROW, which is where the first draft of this guard was
  // wrong in a way that defeated it entirely. `everInvoiced` comes from `credit_usage_totals`,
  // written only by the NIGHTLY arm — so a guard reading "has any pass completed" is satisfied by
  // the first HOURLY pass, which writes no totals at all. On a deployment that migrated at 10:00
  // the 11:00 hourly run would flip the guard on over an empty invoiced set, and the board would
  // paint the whole liability red as granted-never-sold until 03:00 the next morning: the exact
  // alarm this guard exists to prevent, fired by the guard being satisfied.
  const neverInvoicedMeasured = rollup.totalsComputedAt !== null;

  const liability: CreditLiability = {
    outstanding,
    outstandingNeverInvoiced: neverInvoicedMeasured ? outstandingNeverInvoiced : -1,
    accountsWithBalance,
    // A MISSING `credit_balances` row is semantically a balance of zero (see the schema note on
    // the table), so this counts accounts, not rows — an account that never had a ledger
    // movement is at zero and belongs in this figure.
    accountsAtZero: accountRows.length - accountsWithBalance,
    soldLifetime: sumOf("invoice_grant"),
    grantedLifetime: sumOf("adjustment_credit"),
    // The trial bounty, on its own line rather than inside `grantedLifetime` — see the DTO. It is
    // summed here for a harder reason than presentation: the console reconciles these flows
    // against `credit_balances`, so a reason nothing sums makes a healthy database report drift.
    trialGrantedLifetime: sumOf("trial_grant"),
    refundedLifetime: sumOf("refund"),
    // Debits carry a NEGATIVE delta (`credit_ledger_sign_reason_check` makes that a database
    // fact), so the flows out are negated into positive magnitudes for display.
    consumedLifetime: -sumOf(...CONSUMPTION_REASONS),
    expiredLifetime: -sumOf("period_expiry"),
    clawedBackLifetime: -sumOf("adjustment_debit"),
    divergentAccounts,
  };

  const failedRows = await listFailedBillingEvents(db, ADMIN_LIST_LIMIT);
  const failedNames = await accountNames(db, failedRows.map((r) => r.accountId ?? ""));

  return {
    now: now.toISOString(),
    accountCount: accountRows.length,
    subscriptionStates,
    revenue,
    liability,
    // THE STATEMENT, not the meter. Non-debit rows only — see `LEDGER_EVENT_REASONS` — because
    // the metered debits that used to fill this list are counted in `credit_usage_daily` now,
    // and what a reader wants from a deployment-wide ledger list is the decisions.
    ledger: await loadLedger(db, null, { events: true }),
    // THE TOTALS' OWN STAMP, ON THE TOTALS' OWN CADENCE. Not the newest completed run and not
    // the hourly number: every figure this covers is written by the nightly arm alone, so a
    // stamp taken from an hourly pass would read "fresh" over week-old lifetime sums.
    freshness: {
      computedAt: rollup.totalsComputedAt,
      expectedEverySeconds: ADMIN_TOTALS_EXPECTED_EVERY_SECONDS,
    },
    adjustableAccounts: accountRows
      .slice(0, ADMIN_OPTIONS_LIMIT)
      .map((a) => ({ id: a.id, name: a.name, balance: balances.get(a.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    failedEvents: failedRows.map((row) => ({
      stripeEventId: row.stripeEventId,
      type: row.type,
      accountId: row.accountId,
      // Null accountId is itself a finding: the customer could not be resolved to an account.
      accountName: row.accountId ? failedNames.get(row.accountId) ?? "" : "",
      error: row.error,
      receivedAt: row.receivedAt.toISOString(),
      ageSeconds: secondsSince(now, row.receivedAt) ?? 0,
    })),
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Funnel
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE SIGNUP FUNNEL, as counts.
 *
 * Every figure is a COUNT and nothing here is joined to a person. The top reads the DATE columns
 * granted for the funnel (`staff-grants.ts`: `invites` created/consumed/revoked, `waitlist`
 * created/invited — no address); the four stages read columns the role already held.
 *
 * The stages are monotonic subsets of the accounts set — signed up ⊇ verified ⊇ connected ⊇
 * subscribed — computed as `count(distinct account_id)` so an account with two verified users or
 * three mailboxes still counts once, and a drop-off between two stages is a true conversion.
 *
 * Sequential reads on the `max: 1` blind pool, like every other admin read group here.
 */
export async function adminFunnel(db: AdminDb, now: Date): Promise<FunnelSnapshot> {
  const [inviteRow] = await db
    .select({
      issued: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${invites.consumedAt} is not null)::int`,
      revoked: sql<number>`count(*) filter (where ${invites.revokedAt} is not null)::int`,
    })
    .from(invites);

  const [waitRow] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${waitlist.invitedAt} is null)::int`,
      invited: sql<number>`count(*) filter (where ${waitlist.invitedAt} is not null)::int`,
    })
    .from(waitlist);

  const [signupRow] = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
  const [verifiedRow] = await db
    .select({ n: sql<number>`count(distinct ${users.accountId})::int` })
    .from(users)
    .where(sql`${users.emailVerifiedAt} is not null`);
  const [connectedRow] = await db
    .select({ n: sql<number>`count(distinct ${mailboxes.accountId})::int` })
    .from(mailboxes);
  const [subscribedRow] = await db
    .select({ n: sql<number>`count(distinct ${billingSubscriptions.accountId})::int` })
    .from(billingSubscriptions)
    .where(inArray(billingSubscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]));

  const signup = int(signupRow?.n);
  const verified = int(verifiedRow?.n);
  const connected = int(connectedRow?.n);
  const subscribed = int(subscribedRow?.n);

  // Conversion from the previous stage. `null` on the first; guarded against divide-by-zero —
  // a downstream count is a subset, so a zero upstream means a zero downstream, i.e. 0/0 ⇒ null.
  const conv = (count: number, previous: number): number | null =>
    previous === 0 ? null : count / previous;

  const stages: FunnelStage[] = [
    { key: "signup", label: "Signed up", count: signup, ofPrevious: null },
    { key: "verified", label: "Email verified", count: verified, ofPrevious: conv(verified, signup) },
    { key: "connected", label: "Mailbox connected", count: connected, ofPrevious: conv(connected, verified) },
    { key: "subscribed", label: "Subscribed", count: subscribed, ofPrevious: conv(subscribed, connected) },
  ];

  const issued = int(inviteRow?.issued);
  const accepted = int(inviteRow?.accepted);
  const revoked = int(inviteRow?.revoked);

  // Signups per ISO week (Monday-anchored), last 8 weeks including the current one, oldest
  // first. `date_trunc('week', …)` is Monday-anchored in Postgres. `created_at` only.
  const weekRows = await db
    .select({
      weekStart: sql<string>`to_char(date_trunc('week', ${accounts.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(accounts)
    .where(sql`${accounts.createdAt} >= date_trunc('week', ${now.toISOString()}::timestamptz) - interval '7 weeks'`)
    .groupBy(sql`date_trunc('week', ${accounts.createdAt})`)
    .orderBy(sql`date_trunc('week', ${accounts.createdAt})`);

  return {
    now: now.toISOString(),
    invites: {
      issued,
      accepted,
      revoked,
      // Outstanding = issued that were neither accepted nor revoked. This can exclude EXPIRED
      // invites (there is no `expires_at` grant), so it is "issued and not yet consumed or
      // revoked" — the console labels it that way rather than claiming "still valid".
      outstanding: Math.max(0, issued - accepted - revoked),
    },
    waitlist: { waiting: int(waitRow?.waiting), invited: int(waitRow?.invited) },
    stages,
    signupsByWeek: weekRows.map((r) => ({ weekStart: r.weekStart, count: int(r.count) })),
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Worker + alerts
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The worker, as the DATABASE sees it — which is less than the worker's own `/health` sees.
 *
 * `worker_heartbeats` holds one row per SHARD, written only by the process holding that shard's
 * advisory lock. So: there is at most one row per shard and never a standby row (a standby
 * writes nothing), `host` / `awaitingCredentials` / `truncated` / the KEK ring have no column,
 * and `healthy` is derived from freshness rather than reported. Every one of those is a `null`
 * on the wire, and the console's own types document why a null and not a zero.
 */
export async function adminWorkerInstances(db: AdminDb, now: Date): Promise<WorkerInstanceHealth[]> {
  const rows = await db
    .select({
      shardIndex: workerHeartbeats.shardIndex,
      instanceId: workerHeartbeats.instanceId,
      leader: workerHeartbeats.leader,
      shards: workerHeartbeats.shards,
      mailboxes: workerHeartbeats.mailboxes,
      expected: workerHeartbeats.expected,
      accounts: workerHeartbeats.accounts,
      quarantined: workerHeartbeats.quarantined,
      degraded: workerHeartbeats.degraded,
      lastCycleAt: workerHeartbeats.lastCycleAt,
      startedAt: workerHeartbeats.startedAt,
      beatAt: workerHeartbeats.beatAt,
    })
    .from(workerHeartbeats)
    .orderBy(workerHeartbeats.shardIndex);

  const staleMs = DEFAULT_ALERT_THRESHOLDS.leaderStaleMs;
  return rows.map((row) => {
    const beatAgeSeconds = secondsSince(now, row.beatAt) ?? 0;
    const beating = beatAgeSeconds * 1000 <= staleMs;
    return {
      instanceId: row.instanceId,
      host: null,
      leader: Boolean(row.leader),
      // A standby writes no heartbeat, so a row is never one. `leader: false` here means the
      // leader RESIGNED (`clearHeartbeat`) — an unheld shard, not a hot spare.
      standby: false,
      healthy: Boolean(row.leader) && beating,
      degraded: Boolean(row.degraded),
      mailboxes: int(row.mailboxes),
      expected: int(row.expected),
      accounts: int(row.accounts),
      quarantined: int(row.quarantined),
      awaitingCredentials: null,
      truncated: null,
      lastCycleAt: iso(row.lastCycleAt),
      lagSeconds: secondsSince(now, row.lastCycleAt),
      shard: { index: int(row.shardIndex), shards: int(row.shards) },
      kek: null,
      error: !Boolean(row.leader)
        ? "this shard has no leader — the last one resigned or lost its lock"
        : beating
          ? null
          : `no heartbeat for ${beatAgeSeconds}s (threshold ${Math.round(staleMs / 1000)}s)`,
      startedAt: asDate(row.startedAt).toISOString(),
    } satisfies WorkerInstanceHealth;
  });
}

/**
 * What is paging right now.
 *
 * `evaluateAlerts` is the SAME pure read the alerter runs, so the console cannot show "all
 * clear" while an operator's phone is buzzing. `alert_state` supplies the two facts an
 * evaluation cannot have — when the fault STARTED and whether a human was actually told.
 */
/**
 * Both alert drivers' last recorded pass — the panel that answers "is the pair still a pair".
 *
 * A thin pass-through over `alertDriverStatuses`, which always returns BOTH arms so an arm that
 * has never run is present and says so. It is a separate read from {@link adminAlerts} because it
 * answers a different question: that one is "what is wrong", this one is "is the thing that
 * would tell me still running".
 */
export async function adminAlertDrivers(db: AdminDb, now: Date): Promise<AdminAlertDriver[]> {
  void now;
  const rows = await alertDriverStatuses(db);
  return rows.map((r) => ({
    driver: r.driver,
    ranAt: iso(r.ranAt),
    firing: r.firing,
    delivered: r.delivered,
    failedSinks: r.failedSinks,
    sinkFailureStreak: r.sinkFailureStreak,
    sinksConfigured: r.sinksConfigured,
  }));
}

/**
 * What the platform served over the 5xx rule's own window.
 *
 * READ THROUGH THE SAME FUNCTION THE RULE USES (`platformSignalWindow`), which is the point: the
 * panel says "12 of 900 requests" and the rule pages on those two numbers, so the surface an
 * operator reads and the condition that wakes them cannot drift apart.
 *
 * AN EMPTY ARRAY IS THE UNCONFIGURED STATE and the console must render it as "not measured". It
 * is not a failure and it is not a zero: a deployment with no platform token writes no rows, so
 * there is no row here saying 0 to be mistaken for a measurement.
 */
export async function adminPlatformSignals(
  db: AdminDb, now: Date,
): Promise<AdminPlatformSignal[]> {
  const rows = await platformSignalWindow(db, now, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
  return rows
    // A PROJECT WITH NOTHING COMPLETE IS NOT MEASURED, and must not be rendered as measured.
    // Since sampled buckets are excluded from the sums, a window whose every bucket was sampled
    // comes back with zeroed figures — and emitting that row put "0 5xx of 0 requests" on the
    // board, which reads as a healthy measurement of a quiet deployment. It is the absence of
    // one. Dropping the row returns the panel to its "not measured" branch, which is the honest
    // rendering and the same one an unconfigured deployment gets.
    // AND A PARTIAL WINDOW IS NOT THE FIFTEEN MINUTES THIS PANEL NAMES. The line beside these
    // figures reads "in the last 15m", and with one poll missed it was the sum of ten. The rule
    // that pages on the same window refuses it outright — so an operator could read an apparently
    // measured rate off the board for a project the pager considers unmeasured, and the two
    // surfaces disagreeing about what is known is worse than either answer alone.
    //
    // The same expectation as the rule, computed the same way, so the two cannot drift: every
    // bucket of the window, complete. Short of that the row is dropped and the panel falls back
    // to "not measured", which is what it already says before the first poll lands.
    .filter((r) => r.completeBuckets >= Math.round(
      DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs / SIGNAL_BUCKET_MS,
    ))
    .map((r) => ({
    provider: r.provider,
    project: r.project,
    requests: r.requests,
    errors5xx: r.errors5xx,
    truncated: r.truncated,
    fetchedAt: r.fetchedAt.toISOString(),
  }));
}

export async function adminAlerts(db: AdminDb, now: Date): Promise<AlertSummary[]> {
  const firing = await evaluateAlerts(db, { now });
  const stateRows = await db
    .select({
      alertKey: alertState.alertKey,
      openedAt: alertState.openedAt,
      notifiedAt: alertState.notifiedAt,
    })
    .from(alertState);
  const state = new Map(stateRows.map((r) => [r.alertKey, r]));

  const evaluated = firing.map((alert) => {
    const row = state.get(alert.key);
    return {
      key: alert.key,
      kind: alert.kind,
      // `AlertSeverity` is critical|warning; the console's ramp is ok|warn|bad|idle.
      severity: alert.severity === "critical" ? "bad" : "warn",
      title: alert.title,
      detail: alert.detail,
      count: alert.count,
      // No `alert_state` row means this pass is the first observation — the fault opened as
      // far as anyone can tell now, and nobody has been told.
      openedAt: iso(row?.openedAt ?? null) ?? now.toISOString(),
      notifiedAt: iso(row?.notifiedAt ?? null),
      // READ FROM THE FIRING ALERT, not from the `alert_state` row, and the two can legitimately
      // differ for one pass: a promoting rule computes its class from a population that has just
      // moved, and the row still carries what the LAST pass wrote until this one's observation
      // lands. The console must render what is true now — which is what the evaluator just
      // computed — for the same reason this whole function evaluates rather than reading: the
      // surface an operator looks at and the condition that pages them must not drift apart.
      cls: alertClass(alert),
      affectedAccounts: alert.affectedAccounts ?? null,
      fixHref: alert.fixHref ?? null,
    } satisfies AlertSummary;
  });

  // ── AND THE ROWS THIS READ STRUCTURALLY CANNOT EVALUATE ───────────────────────────────
  //
  // The console is not an alert DRIVER. It evaluates without one, deliberately — a read that
  // named itself an arm would resolve a live driver's row and would report a scheduler dark that
  // is running perfectly. But two rules are gated on exactly that name (`schema_behind`, keyed by
  // the host whose journal is ahead, and `alert_driver_dark`, keyed by the arm being reported),
  // and one more family is gated on `shards`. So the evaluated set NEVER contains them.
  //
  // The consequence was that `schema_behind` — an incident with `fixHref: "/reliability"` — was
  // invisible on the one page its own deep link points at. An operator following the link from a
  // page would arrive at a board that showed nothing wrong.
  //
  // These rows are therefore READ from `alert_state` rather than evaluated: the drivers wrote
  // them, and what the drivers wrote is the only evidence this read can have. `openedAt` and
  // `notifiedAt` come from the row for the same reason. This does not reintroduce the drift the
  // comment above guards against — that argument is about a class the CURRENT pass just
  // recomputed, and here there is no current computation to prefer.
  // ── ONLY WHAT THIS READ GENUINELY COULD NOT EVALUATE ─────────────────────────────────
  //
  // "Scoped kind" is not the same claim as "this read could not evaluate it", and merging on the
  // kind alone reintroduced cleared incidents. `evaluateAlerts` defaults to shard 0 when no
  // shards are given, so THIS read does evaluate `worker_down:0`, `worker_degraded:0` and
  // `ai_provider_down:0` — and when shard 0 has recovered but the driver has not yet deleted the
  // row, their absence from `firing` is the correct answer, not a gap to fill. Merging them back
  // put a cleared critical on the board until the next driver pass.
  //
  // What this read truly cannot answer is narrower and is enumerable:
  //  · the DRIVER-keyed rules, because no driver is named here and both are gated on that;
  //  · the ROLE-scoped one, because the counter lives in a table the content-blind handle this
  //    console reads through is deliberately not granted — a property of the role, not a guess;
  //  · any SHARD-keyed row for a shard outside the set this read used.
  const READ_SHARDS = [0];
  const evaluatedHere = new Set<string>();
  for (const shard of READ_SHARDS) {
    evaluatedHere.add(`worker_down:${shard}`);
    evaluatedHere.add(`worker_degraded:${shard}`);
    evaluatedHere.add(`ai_provider_down:${shard}`);
  }
  const scoped = (await listOpenAlerts(db))
    .filter((r) => SCOPED_ALERT_KINDS.has(r.kind)
      && !evaluatedHere.has(r.alertKey)
      && !firing.some((a) => a.key === r.alertKey))
    .map((r) => ({
      key: r.alertKey,
      kind: r.kind as AlertSummary["kind"],
      severity: r.severity === "critical" ? "bad" : "warn",
      // ── PROJECTED, NEVER RECONSTRUCTED ────────────────────────────────────────────────
      //
      // These two used to be invented here: the count was a hardcoded 1 and the title was the
      // detail's FIRST SENTENCE. So a refusal burst of forty connections rendered as "1", under
      // a heading that was really the opening clause of a paragraph — and this branch is not the
      // exceptional path, it is the ONLY path for the two driver-keyed rules and the role-scoped
      // one, because a console read names no driver and runs on the content-blind handle.
      //
      // `alert_state` now persists what the rule said, so both are read. A null means the row
      // predates those columns — a driver mid-deploy — and the fallback SAYS that rather than
      // fabricating a sentence, which is the whole difference between projecting and guessing.
      title: r.title ?? `${r.kind} — recorded by the other alert driver`,
      detail: r.detail ?? "Recorded by the other alert driver; this read cannot evaluate it.",
      count: r.count ?? 0,
      openedAt: r.openedAt.toISOString(),
      notifiedAt: r.notifiedAt ? r.notifiedAt.toISOString() : null,
      cls: r.cls,
      affectedAccounts: r.affectedAccounts,
      fixHref: r.fixHref,
    } satisfies AlertSummary));

  return [...evaluated, ...scoped];
}

export async function adminWorker(db: AdminDb, now: Date): Promise<WorkerSnapshot> {
  // SEQUENTIAL on purpose — see overview() in routes/admin.ts: parallel reads on the max:1
  // blind pool deadlock when one of them opens a transaction. This pair hung /admin/worker
  // for its whole life.
  const instances = await adminWorkerInstances(db, now);
  const roster = await loadMailboxes(db, now, null);
  const names = await accountNames(db, roster.map((m) => m.accountId));

  /**
   * THE POPULATION, FROM SQL — because the roster above is capped at `ADMIN_ROSTER_LIMIT`.
   *
   * The console's customer-facing verdict counted faults by filtering that capped array. On a
   * deployment with more than 200 mailboxes the 201st cannot contribute to a fault count however
   * broken it is, so the verdict gets QUIETER as the deployment grows — the exact inversion of
   * what it is for, and invisible from any test whose fixture is smaller than the cap.
   *
   * `blocked` gates on the TIMESTAMP and never on `sync_blocked_reason`. The service narrows that
   * reason to this build's closed set, so a block this build cannot name still has a `since`, and
   * gating on the reason would read that row as a healthy mailbox — a defect this projection has
   * shipped once already, and the same rule the console's own `mailboxBlocked` helper carries.
   * Written in SQL here, so the two spellings of one predicate have to agree.
   *
   * Three `count(*) filter (…)` over one scan of a table bounded by the mailbox population, not
   * by the message volume — the same shape as every other count on this console.
   */
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      inError: sql<number>`count(*) filter (where ${mailboxes.status} <> 'connected')::int`,
      blocked: sql<number>`count(*) filter (where ${mailboxes.status} = 'connected' and ${mailboxes.syncBlockedSince} is not null)::int`,
    })
    .from(mailboxes);

  const stuck = await listStuckSends(
    db,
    new Date(now.getTime() - DEFAULT_ALERT_THRESHOLDS.stuckSendMs),
    ADMIN_LIST_LIMIT,
  );
  const stuckNames = await accountNames(db, stuck.map((s) => s.accountId));

  return {
    now: now.toISOString(),
    instances,
    roster: roster.map((m) => ({ ...m, accountName: names.get(m.accountId) ?? "" })),
    rosterCounts: {
      total: int(counts?.total),
      inError: int(counts?.inError),
      blocked: int(counts?.blocked),
    },
    // EMPTY IS THE HONEST ANSWER, AND THE SENTENCE EXPLAINING IT NAMES ONLY WHAT RUNS.
    //
    // What the worker's `cycle()` actually runs on a timer, per poll interval: folder
    // RECONCILE (`sync.ts`), the workflow TIME SCAN and DRAIN (`workflow-cron.ts`), and
    // the BUBBLE-UP resurfacing pass (`bubble-up-cron.ts`, gated by `BUBBLE_UP_EVERY_MS`).
    // Nothing writes a row when any of them do: there is no cron telemetry table anywhere in the
    // schema. A row per pass reporting `never` would be a false statement about a job that
    // finished two minutes ago, and a console caught lying once is a console whose other numbers
    // stop being read.
    //
    // This comment and the console string it mirrors used to name "the reconcile, stale-send and
    // proposal passes". Two of those three were false: `proposalGeneratePass` has no production
    // caller (deliberately — no proposer model is configured, so it is deferred with the AI
    // phase), and there is NO stale-send pass anywhere in the codebase — `staleSends` below is a
    // read-only listing computed from `outbound_sends` on this request, not the output of a job.
    // So the empty state explained a blank table by naming work that does not happen, to the one
    // reader who is trying to decide whether the system is healthy. Keep the list of passes here
    // in step with `SCHEDULE_MANIFEST` in `test/every-pass-has-a-producer.test.ts`.
    crons: [],
    // ZERO, for the same reason `crons` is empty: the honest answer is nothing, and
    // the surface that produced this one was a receipt oracle. The full argument, the D=15min /
    // k=5 bucketed shape a cluster-wide backlog number must have, and why it has to be produced
    // by the WORKER rather than joined out of `folder_state ⋈ messages` on a staff connection,
    // are in the block above `loadMailboxes`. Reading it before re-adding a query here is not
    // optional: the query this replaced looked as narrow as a query can look.
    pendingMoves: { total: 0, mailboxes: 0, oldestSeconds: null },
    staleSends: stuck.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      accountName: stuckNames.get(s.accountId) ?? "",
      // `outbound_sends.idempotency_key` IS NOT PROJECTED. It is the CLIENT's
      // `Idempotency-Key` header, verbatim and unvalidated (`routes/drafts.ts` takes any
      // non-empty string), so it is caller-chosen free text of unbounded length rendered on a
      // staff screen. A client that used a draft's SUBJECT as its "one intent" token — a
      // perfectly natural choice — would have put subjects on this console with nothing
      // failing anywhere. It bought an operator nothing either: `id` and the key are 1:1, and
      // `id` is the handle `admin.send.retry` would take.
      status: s.status === "unverified" ? "unverified" : "pending",
      createdAt: s.createdAt.toISOString(),
      ageSeconds: secondsSince(now, s.createdAt) ?? 0,
    } satisfies StaleSend)),
    // The alerter's own numbers, not a second opinion — the UI states the rule it is judging by.
    thresholds: {
      staleSendSeconds: Math.round(DEFAULT_ALERT_THRESHOLDS.stuckSendMs / 1000),
      // The EFFECTIVE sync-lag rule — threshold PLUS the sustain margin — because that sum is
      // what the pager actually fires at (alerts.ts rule 4's debounce: a healthy serialized
      // scan's tail reaches the bare threshold on its own, so the bare number here made the
      // console mark red exactly the boundary kiss the alerter declares healthy — a console
      // disagreeing with the pager, which is the drift this projection exists to prevent).
      syncLagSeconds: Math.round(
        (DEFAULT_ALERT_THRESHOLDS.syncLagMs + DEFAULT_ALERT_THRESHOLDS.syncLagSustainMs) / 1000,
      ),
      leaderStaleSeconds: Math.round(DEFAULT_ALERT_THRESHOLDS.leaderStaleMs / 1000),
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Actions — designed, documented, NOT BUILT
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Why an action is unavailable, rendered VERBATIM by the console.
 *
 * The console does not paraphrase this and does not hard-code `disabled`: `ActionSpec.available`
 * is data, so an action goes live with no design change the day its write lands. The
 * suspend/resume write has landed, so this reason now covers ONLY the two actions whose target subsystem
 * still does not exist — a button that reports success it cannot achieve is worse than no button.
 */
export const ADMIN_WRITES_UNAVAILABLE =
  "Not in this build. Suspension and mailbox release ship and are wired to staff-authenticated " +
  "writes that record an actor; this action's target subsystem does not exist yet (filed as a " +
  "gap), so wiring it would be a control that reports success it cannot achieve.";

export const ADMIN_ACTIONS_PRECONDITION =
  "Suspension, unsuspension and mailbox release are LIVE: each requires a staff session (past the " +
  "TOTP wall), not the console gate alone, and writes one audit_log row naming the operator. The " +
  "stuck-send retry is designed and not wired — its target subsystem does not exist yet — and " +
  "says so on its card.";

export async function adminActions(db: AdminDb, now: Date): Promise<ActionCatalog> {
  const accountRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).limit(ADMIN_OPTIONS_LIMIT);
  // Sequential — same max:1 deadlock rule as adminWorker.
  const mailboxRows = await db.select({ id: mailboxes.id, address: mailboxes.address, accountId: mailboxes.accountId })
    .from(mailboxes).orderBy(mailboxes.address).limit(ADMIN_OPTIONS_LIMIT);
  const stuck = await listStuckSends(
    db,
    new Date(now.getTime() - DEFAULT_ALERT_THRESHOLDS.stuckSendMs),
    ADMIN_LIST_LIMIT,
  );
  // The accounts currently suspended, for the resume action's target list. Same blind-role
  // read as the roster; `suspended_by`/`note` stay ungranted.
  const suspendedRows = await db
    .select({ accountId: accountSuspensions.accountId })
    .from(accountSuspensions)
    .limit(ADMIN_OPTIONS_LIMIT);
  const suspendedIds = new Set(suspendedRows.map((r) => r.accountId));

  const names = new Map(accountRows.map((a) => [a.id, a.name]));
  const owners = await ownerEmails(db, accountRows.map((a) => a.id));

  // An ERASED account (Art. 17 anonymises rather than deletes) has neither a name nor an owner
  // address, so the fixture-era `name · email` template renders a bare separator. Both halves
  // are conditional, and the label falls back to the id: an option an operator cannot tell
  // apart from the next one is not a choice.
  const accountOptions = accountRows.map((a) => {
    const owner = owners.get(a.id) ?? "";
    const parts = [a.name, owner].filter((p) => p.length > 0);
    return { id: a.id, label: parts.length > 0 ? parts.join(" · ") : `${a.id} (no name or owner on record)` };
  });
  // The resume action can only target an account that IS suspended — the same labels, filtered.
  const suspendedOptions = accountOptions.filter((o) => suspendedIds.has(o.id));
  const withAccount = (head: string, accountId: string): string => {
    const name = names.get(accountId) ?? "";
    return name.length > 0 ? `${head} · ${name}` : head;
  };
  const mailboxOptions = mailboxRows.map((m) => ({ id: m.id, label: withAccount(m.address, m.accountId) }));
  // The send's own id, never its idempotency key — see `staleSends` in `adminWorker` for why
  // the key does not leave the database. `id` is what `admin.send.retry` targets anyway.
  const sendOptions = stuck.map((s) => ({ id: s.id, label: withAccount(s.id, s.accountId) }));

  const actions: ActionSpec[] = [
    {
      id: "suspend_account",
      title: "Suspend an account",
      summary:
        "Stops the worker from serving the account and drops its entitlements to zero. Nothing is deleted.",
      effects: [
        "Writes an account_suspensions row — entitlementsFor() honors it on the next read",
        "The worker drops the account's mailboxes from the rotation on its next cycle",
        "The customer keeps every folder already organized on their own server",
      ],
      target: { label: "Account", placeholder: "Pick an account", options: accountOptions },
      requiresNote: true,
      available: true,
      unavailableReason: null,
      auditPreview: {
        action: "admin.account.suspend",
        payload: { account_id: "…", note: "<required>", actor: "staff_<uuid>" },
        inverse: { action: "admin.account.resume", account_id: "…" },
      },
    },
    {
      id: "resume_account",
      title: "Unsuspend an account",
      summary: "Clears the suspension and returns the account to the sync rotation.",
      effects: [
        "Deletes the account_suspensions row",
        "Entitlements return to whatever the live subscription sold",
        "The next worker cycle picks the mailboxes back up — no resync is needed",
      ],
      target: {
        label: "Suspended account",
        // Only suspended accounts can be resumed; the list IS the current suspensions. Empty with
        // a plain placeholder when nobody is suspended beats a list that pretends otherwise.
        placeholder: suspendedOptions.length ? "Pick a suspended account" : "No account is suspended right now",
        options: suspendedOptions,
      },
      requiresNote: true,
      available: true,
      unavailableReason: null,
      auditPreview: {
        action: "admin.account.resume",
        payload: { account_id: "…", note: "<required>", actor: "staff_<uuid>" },
        inverse: { action: "admin.account.suspend", account_id: "…" },
      },
    },
    {
      id: "resync_mailbox",
      title: "Release a quarantined mailbox",
      // ── THE COPY WAS NARROWED IN THE SAME CHANGE THAT WIRED THE WRITE (mail 0039) ────────
      //
      // It used to promise "requeues a full folder pass — UIDVALIDITY is re-read, not assumed",
      // and none of that ships. Clearing a column requeues nothing, and an attach
      // is connect + lease + folders + kickstart + IDLE and syncs nothing at all — there is no
      // forced folder pass on this path to trigger. The write clears `mailboxes.retry_after` and
      // the leader re-dials on its next roster pass; the honest description of that is one line,
      // so it is one line. A forced reconcile stays filed as its own thing.
      //
      // This matters more than tidiness here. `available` flipping to true is the console making
      // a public claim, and a button whose card overstates what it does is the same defect as one
      // that reports success it cannot achieve — the reason the other two cards say so out loud.
      summary:
        "Clears the retry backoff so the sync leader dials the mailbox again on its next roster pass.",
      effects: [
        "Clears mailboxes.retry_after — the durable backoff a failure recorded",
        "The leader re-attaches within one roster interval (30 s) and resumes from stored state",
        "The outage record is untouched: retry_count, error_code and failed_at all stand",
        "The backoff ladder is NOT reset — a mailbox that fails again waits as long as it would have",
      ],
      target: {
        label: "Mailbox",
        placeholder: mailboxOptions.length ? "Pick a mailbox" : "No mailbox is connected yet",
        options: mailboxOptions,
      },
      requiresNote: true,
      available: true,
      unavailableReason: null,
      auditPreview: {
        action: "admin.mailbox.resync",
        payload: { mailbox_id: "…", account_id: "…", note: "<required>", actor: "staff_<uuid>" },
        inverse: null,
      },
    },
    {
      id: "retry_send",
      title: "Retry a stuck send",
      summary:
        "Re-runs the verify-before-resend pass on an outbound_sends row that never finished. Never sends blind.",
      effects: [
        "Opens the send adapter and calls messageInSent(mintedMessageId) first",
        "Finalizes the row as sent when the message is already there — no second delivery",
        "Only an unambiguous absence is resent, and only under the original idempotency key",
      ],
      target: {
        label: "Stuck send",
        placeholder: sendOptions.length ? "Pick a stuck send" : "No sends are stuck right now",
        options: sendOptions,
      },
      requiresNote: true,
      available: false,
      unavailableReason: ADMIN_WRITES_UNAVAILABLE,
      auditPreview: {
        action: "admin.send.retry",
        payload: {
          send_id: "…", idempotency_key: "idem-…", verified_before_resend: "true",
          note: "<required>", actor: "staff_<uuid>",
        },
        inverse: null,
      },
    },
  ];

  return {
    now: now.toISOString(),
    precondition: ADMIN_ACTIONS_PRECONDITION,
    actions,
    recent: await loadAudit(db, null),
  };
}

async function ownerEmails(db: AdminDb, accountIds: string[]): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({ accountId: users.accountId, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(inArray(users.accountId, accountIds));
  const out = new Map<string, { email: string; createdAt: Date | string }>();
  for (const row of rows) {
    const held = out.get(row.accountId);
    if (!held || asDate(row.createdAt) < asDate(held.createdAt)) {
      out.set(row.accountId, { email: row.email, createdAt: row.createdAt });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.email]));
}

