import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  billingCustomers, billingInvoices, billingReconciliationRuns, upsertBillingInvoice,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Db } from "./../context.js";
import type { InvoiceReconcilePageDTO, InvoiceStateDTO } from "./entitlement-event.js";

/**
 * THE INVOICE RECONCILIATION — the daily pass that makes a lost `invoice.paid` a healed, counted
 * divergence instead of a month of revenue nobody ever sees.
 *
 * ## The failure this exists for
 *
 * `billing_invoices` has exactly one live writer: the webhook apply. Stripe retries a failed
 * delivery for ~3 days and then stops, for ever — so one outage window, one mis-answered 400, and
 * an invoice is absent from the mirror permanently, with every test green and nothing anywhere
 * saying a number is missing. That is the subscription reconciler's founding case one table over,
 * and it is WORSE here in one specific way: a missing subscription row is visible the moment
 * somebody looks at that account, and a missing invoice row is invisible by construction, because
 * what it changes is a total.
 *
 * ## It NEVER moves money, and that is the design rather than a happy consequence
 *
 * The subscription reconciler mints the `subscription`-kind event the missed webhook would have
 * carried and re-drives the real apply path. That shape is unavailable here and must not be
 * imitated: minting `invoice_paid` events would run `applyInvoicePaid` over the whole history,
 * and that function GRANTS CREDITS. The ledger's `UNIQUE (account_id, source)` would refuse the
 * replays correctly, so nothing would be double-granted — but every listed invoice would answer
 * `LedgerReplayError`, and a reconciler whose success is indistinguishable from its failure is
 * not a reconciler.
 *
 * So the plane hands over an OBSERVATION ({@link InvoiceStateDTO}) and this pass upserts the
 * mirror row directly, through the same fenced statement the webhook uses. Credits are granted by
 * the webhook and by nothing else. That is what makes a daily pass over paid history safe to run
 * at all, and it is the property to check first if this file ever grows a second write.
 *
 * ## What is compared, and the one thing that is deliberately NOT
 *
 * The pair (`status`, `amount_paid_cents`), as one record of one invoice. A lost `invoice.paid`
 * shows up in it twice over — the mirror holds `payment_failed` at 0 cents where Stripe holds
 * `paid` at 900 — which is why one code covers both halves rather than two codes splitting one
 * disagreement.
 *
 * **A mirror row in a terminal reversal state (`refunded` / `disputed`) is skipped entirely.**
 * Stripe's INVOICE object has no notion of a refund — refunds and disputes live on the charge —
 * so the freshest possible observation of a fully refunded invoice still reads `paid` at its full
 * amount. Comparing it would report `amount_mismatch` on every pass, for ever, on a mirror that
 * is right and a Stripe that is not wrong; and healing it would reset the refund nightly. The
 * upsert refuses those rows structurally (`billing-invoices.ts`), so this skip is belt to that
 * suspenders — but without it the pass would spend every night flagging its own correct rows.
 *
 * ## Bounds
 *
 * Pages of ≤100 from the plane, at most {@link INVOICE_RECONCILE_MAX_PAGES}, inside
 * {@link INVOICE_RECONCILE_DEADLINE_MS}. The LISTING is bounded by creation time
 * ({@link INVOICE_RECONCILE_WINDOW_DAYS}) rather than walked whole: invoices accumulate one per
 * customer per month for ever, and a nightly full-history walk would spend an ever-growing share
 * of a rate limit re-observing rows that cannot change. `since: null` asks for everything, which
 * is what a first pass on a deployment that has never reconciled invoices wants.
 *
 * If the bound stops the listing early, `truncated` is recorded and the ABSENCE check
 * (`invoice_missing_in_stripe`) is skipped for that pass — an unread page is not evidence of
 * absence, exactly as in the subscription pass.
 */

/** Divergence classes — a CLOSED vocabulary; these strings reach staff-readable rows. */
export type InvoiceReconcileCode =
  /**
   * Stripe holds an invoice the mirror does not. HEALED: the row is written from the
   * observation. The founding case — a lost `invoice.paid`, i.e. revenue the board never saw.
   *
   * It is also the code for an invoice whose ACCOUNT cannot be resolved, with `action: "flagged"`
   * rather than `"emitted"`: `account_id` is NOT NULL, so there is no row to write, and an
   * invoice nobody claims is a human's problem exactly as an unattributable subscription is.
   */
  | "invoice_missing_in_mirror"
  /**
   * The mirror holds an invoice inside the listed window that Stripe did not list. NEVER healed —
   * there is no truth to copy — only named. Meaningful only when the listing was complete.
   */
  | "invoice_missing_in_stripe"
  /**
   * The mirror's record of an invoice disagrees with Stripe's: a different `amount_paid_cents`,
   * a different status, or both. HEALED under the fence. A lost `invoice.paid` on an invoice that
   * first failed shows up here rather than as a missing row, because the dunning delivery already
   * created it at 0 cents.
   */
  | "amount_mismatch";

/** One divergence and what the pass did about it. Ids only, never payloads, never amounts. */
export interface InvoiceDivergence {
  code: InvoiceReconcileCode;
  stripeInvoiceId: string;
  accountId: string | null;
  /** `emitted` (the mirror was written), `flagged` (nothing was written). */
  action: "emitted" | "flagged";
}

/** One pass, summarized — what lands in `billing_reconciliation_runs` under `mode = 'invoices'`. */
export interface InvoiceReconcileReport {
  observedAt: Date;
  /** Invoices Stripe listed across every page this pass read. */
  invoicesListed: number;
  /** Invoices whose mirror row this pass actually wrote. Zero is the healthy steady state. */
  invoicesUpserted: number;
  /** Closed code→count map over EVERY divergence, healed or not. Complete even when capped. */
  flagged: Record<string, number>;
  divergences: InvoiceDivergence[];
  pages: number;
  truncated: boolean;
}

/** The page-walk bound: 20 pages × 100 = two thousand invoices before `truncated`. */
export const INVOICE_RECONCILE_MAX_PAGES = 20;

/** The default wall-clock budget — well inside the hosted route's 60 s `maxDuration`. */
export const INVOICE_RECONCILE_DEADLINE_MS = 40_000;

/**
 * How far back the DEFAULT listing reaches, in days.
 *
 * 35 rather than 30, and the five days are the whole point: a monthly cycle invoice is issued on
 * the same day each month, so a 30-day window run at 03:00 can miss an invoice issued at 23:00
 * thirty-one days ago — every month, for the same customer, for ever. The window has to be
 * strictly longer than the longest cadence it is asked to cover, and 35 covers a month with four
 * days of slack for a pass that skipped a night.
 *
 * ANNUAL invoices are deliberately NOT covered by the default window, and that is not an
 * oversight: covering them would mean a 366-day listing every night to catch one invoice per
 * customer per year. They are covered by a `since: null` backfill instead, which is the same
 * function with one argument changed.
 */
export const INVOICE_RECONCILE_WINDOW_DAYS = 35;

/** How many divergences the recorded run row keeps. The COUNTS are always complete. */
export const INVOICE_RECONCILE_DIVERGENCE_ROW_CAP = 100;

/** The `mode` an invoice pass records itself under — see the migration for why it is not `apply`. */
export const INVOICE_RECONCILE_MODE = "invoices" as const;

/** The port slice this pass needs — `BillingPlanePort.reconcileInvoices`, and nothing else. */
export interface InvoiceReconcilePlane {
  reconcileInvoices(req: {
    cursor: string | null; limit: number; since: number | null;
  }): Promise<InvoiceReconcilePageDTO>;
}

export interface InvoiceReconcileOptions {
  plane: InvoiceReconcilePlane;
  now?: () => Date;
  maxPages?: number;
  pageSize?: number;
  deadlineMs?: number;
  /**
   * How far back to list, in days; `null` asks for the whole history (the backfill). Defaults to
   * {@link INVOICE_RECONCILE_WINDOW_DAYS}.
   */
  windowDays?: number | null;
  /** Skip the run-ledger insert (unit tests of the comparison alone). Defaults to recording. */
  record?: boolean;
}

/**
 * Stripe's invoice status → the mirror's, or `null` for a state the mirror does not carry.
 *
 * `draft` and `open` are not mirrored, deliberately. An open invoice is neither money received
 * nor a payment that failed — it is a bill that has been sent — and writing it as either would
 * put a number on the board that no figure should include. It counts as LISTED (the pass read it)
 * and is neither upserted nor flagged: nothing is wrong.
 */
function mirrorStatusOf(stripeStatus: string): "paid" | "void" | "uncollectible" | null {
  switch (stripeStatus) {
    case "paid": return "paid";
    case "void": return "void";
    case "uncollectible": return "uncollectible";
    default: return null;
  }
}

/** Unix seconds → Date, or null. */
const at = (seconds: number | null): Date | null => (seconds === null ? null : new Date(seconds * 1000));

/**
 * Run one invoice reconciliation pass. Never throws for a divergence — divergences are the
 * OUTPUT; it throws only when the pass itself cannot run (plane unreachable, database down), and
 * the caller records that as a failed run so the staleness rule sees a reconciler that stopped.
 */
export async function reconcileBillingInvoices(
  db: Db, opts: InvoiceReconcileOptions,
): Promise<InvoiceReconcileReport> {
  const now = opts.now ?? ((): Date => new Date());
  const maxPages = opts.maxPages ?? INVOICE_RECONCILE_MAX_PAGES;
  const pageSize = opts.pageSize ?? 100;
  const deadlineMs = opts.deadlineMs ?? INVOICE_RECONCILE_DEADLINE_MS;
  const windowDays = opts.windowDays === undefined ? INVOICE_RECONCILE_WINDOW_DAYS : opts.windowDays;
  const startedAt = now().getTime();
  const outOfTime = (): boolean => now().getTime() - startedAt > deadlineMs;
  const tx = db as unknown as Tx;

  const windowStart = windowDays === null
    ? null
    : new Date(startedAt - windowDays * 24 * 60 * 60 * 1000);
  const since = windowStart === null ? null : Math.floor(windowStart.getTime() / 1000);

  // ── 1. the observed truth: page the plane's invoice listing, bounded ────────────────────
  const observed: InvoiceStateDTO[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;
  let observedAt = now();
  for (;;) {
    if (pages >= maxPages || outOfTime()) {
      truncated = true;
      break;
    }
    const page: InvoiceReconcilePageDTO = await opts.plane.reconcileInvoices({
      cursor, limit: pageSize, since,
    });
    pages += 1;
    // The plane's clock, not ours, and the LAST page's rather than the first's: it is what the
    // pass stamps as `stripe_event_ts` on every row it writes, so it must not predate an
    // observation this pass actually made.
    observedAt = new Date(page.observedAt * 1000);
    for (const inv of page.invoices) observed.push(inv);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  const divergences: InvoiceDivergence[] = [];
  const flagged: Record<string, number> = {};
  const note = (
    code: InvoiceReconcileCode, id: string, accountId: string | null,
    action: "emitted" | "flagged",
  ): void => {
    flagged[code] = (flagged[code] ?? 0) + 1;
    if (divergences.length < INVOICE_RECONCILE_DIVERGENCE_ROW_CAP) {
      divergences.push({ code, stripeInvoiceId: id, accountId, action });
    }
  };

  const report = (upserted: number): InvoiceReconcileReport => ({
    observedAt, invoicesListed: observed.length, invoicesUpserted: upserted,
    flagged, divergences, pages, truncated,
  });

  // A SPENT BUDGET SKIPS STRAIGHT TO THE RECORD, on the subscription pass's argument: past the
  // deadline every further await is a chance for the platform to kill the invocation before the
  // run row is written, recreating the silent end the budget exists to remove.
  if (outOfTime()) {
    const spent = report(0);
    spent.truncated = true;
    if (opts.record !== false) await recordInvoiceReconcileRun(tx, spent);
    return spent;
  }

  // ── 2. the mirror's side of the same window ────────────────────────────────────────────
  //
  // Read whole rather than one row per observation: the pass compares up to two thousand
  // invoices, and two thousand indexed point reads on a `max: 1` pool is the shape this repo
  // moved the console's ledger reads away from. The predicate is the same window the listing
  // used, so the two sides are populations of the same size.
  const mirrorRows = await tx
    .select({
      stripeInvoiceId: billingInvoices.stripeInvoiceId,
      accountId: billingInvoices.accountId,
      status: billingInvoices.status,
      amountPaidCents: billingInvoices.amountPaidCents,
    })
    .from(billingInvoices)
    .where(windowStart === null ? sql`true` : gte(billingInvoices.createdAt, windowStart));
  const mirror = new Map(mirrorRows.map((r) => [r.stripeInvoiceId, r]));

  // ── 3. account resolution, in ONE query rather than per invoice ────────────────────────
  //
  // The webhook's `resolveAccount` order verbatim: subscription metadata first, the customer
  // link as the fallback. The link half is a lookup over the customer ids this page mentions,
  // batched — the alternative is a query per unmirrored invoice on the blind pool.
  const customerIds = [...new Set(
    observed.map((i) => i.customerId).filter((c): c is string => !!c),
  )];
  const links = customerIds.length === 0 ? [] : await tx
    .select({
      stripeCustomerId: billingCustomers.stripeCustomerId,
      accountId: billingCustomers.accountId,
    })
    .from(billingCustomers)
    .where(inArray(billingCustomers.stripeCustomerId, customerIds));
  const accountOfCustomer = new Map(links.map((l) => [l.stripeCustomerId, l.accountId]));

  // ── 4. compare, and heal what can be healed ────────────────────────────────────────────
  let upserted = 0;
  for (const inv of observed) {
    const status = mirrorStatusOf(inv.status);
    if (status === null) continue;              // draft/open — a bill, not a figure. See above.

    const row = mirror.get(inv.id);
    // A TERMINAL REVERSAL IS NOT A DIVERGENCE. Stripe's invoice object cannot express a refund,
    // so its freshest observation of a refunded invoice reads `paid` at the full amount —
    // comparing it would flag the same correct row every night for ever.
    if (row && (row.status === "refunded" || row.status === "disputed")) continue;

    if (row && row.status === status && row.amountPaidCents === inv.amountPaid) continue;

    const accountId = inv.accountIdFromMetadata
      ?? (inv.customerId ? accountOfCustomer.get(inv.customerId) ?? null : null)
      ?? row?.accountId
      ?? null;
    const code: InvoiceReconcileCode = row ? "amount_mismatch" : "invoice_missing_in_mirror";
    if (accountId === null) {
      // `account_id` is NOT NULL, so there is no row to write. Named and left for a human,
      // exactly as an unattributable subscription is — the alternative is inventing an owner
      // for money.
      note(code, inv.id, null, "flagged");
      continue;
    }

    const wrote = await upsertBillingInvoice(tx, {
      stripeInvoiceId: inv.id,
      accountId,
      stripeSubscriptionId: inv.subscriptionId,
      stripeCustomerId: inv.customerId,
      billingReason: inv.billingReason,
      status,
      currency: inv.currency,
      amountPaidCents: inv.amountPaid,
      plan: inv.plan,
      billingInterval: inv.interval,
      periodStart: at(inv.periodStart),
      periodEnd: at(inv.periodEnd),
      paidAt: at(inv.paidAt),
      // THE OBSERVATION'S OWN CLOCK, never the invoice's `created`. The fence compares stamps,
      // and an invoice created six weeks ago carries a six-week-old `created` — stamping the row
      // with it would make every heal lose to the fence and the pass would report a divergence
      // it silently failed to fix, every night.
      stripeEventTs: observedAt,
      source: "reconcile",
    });
    if (wrote) upserted += 1;
    note(code, inv.id, accountId, wrote ? "emitted" : "flagged");
  }

  // ── 5. the mirror's side: rows Stripe did not list ─────────────────────────────────────
  //
  // Only meaningful when the listing was COMPLETE. Never healed — there is no truth to copy —
  // and never deleted: an invoice row is a financial record, and a reconciler that removed one
  // because a listing did not mention it would be the money trail deleting itself on a schedule.
  if (!truncated) {
    const listed = new Set(observed.map((i) => i.id));
    for (const row of mirrorRows) {
      if (!listed.has(row.stripeInvoiceId)) {
        note("invoice_missing_in_stripe", row.stripeInvoiceId, row.accountId, "flagged");
      }
    }
  }

  const done = report(upserted);
  if (opts.record !== false) await recordInvoiceReconcileRun(tx, done);
  return done;
}

/** Persist one completed pass. Codes and ids only — no payloads and no amounts. */
async function recordInvoiceReconcileRun(tx: Tx, r: InvoiceReconcileReport): Promise<void> {
  await tx.insert(billingReconciliationRuns).values({
    ranAt: r.observedAt,
    mode: INVOICE_RECONCILE_MODE,
    // The four SUBSCRIPTION counters are 0 on an invoice row, and that is true of it: this pass
    // listed no subscriptions, read no mirror rows and emitted no events. The invoice counters
    // are the two columns cloud 0029 adds.
    stripeSubscriptions: 0,
    mirrorRows: 0,
    emitted: 0,
    applyFailed: 0,
    invoicesListed: r.invoicesListed,
    invoicesUpserted: r.invoicesUpserted,
    flagged: r.flagged,
    divergences: r.divergences.slice(0, INVOICE_RECONCILE_DIVERGENCE_ROW_CAP),
    pages: r.pages,
    truncated: r.truncated,
  });
}

/**
 * Record an invoice pass that DID NOT COMPLETE — the plane unreachable, a database refusal
 * mid-walk.
 *
 * `error` is class:code scrubbed by the CALLER, never message text: the column is granted to the
 * blind staff role and a driver message carries connection strings. A failed run deliberately
 * does not reset any staleness clock.
 */
export async function recordInvoiceReconcileFailure(
  db: Db, error: string, now: Date = new Date(),
): Promise<void> {
  const tx = db as unknown as Tx;
  await tx.insert(billingReconciliationRuns).values({
    ranAt: now,
    mode: INVOICE_RECONCILE_MODE,
    stripeSubscriptions: 0,
    mirrorRows: 0,
    emitted: 0,
    applyFailed: 0,
    invoicesListed: 0,
    invoicesUpserted: 0,
    flagged: {},
    divergences: [],
    pages: 0,
    truncated: false,
    error,
  });
}

/**
 * The newest COMPLETED invoice pass, for the console's freshness stamp. `null` when no invoice
 * pass has ever completed on this deployment — which is a distinct state from "it ran and found
 * nothing", and the console must be able to say so.
 */
export async function lastInvoiceReconcileAt(db: Db): Promise<Date | null> {
  const tx = db as unknown as Tx;
  const rows = await tx
    .select({ ranAt: billingReconciliationRuns.ranAt })
    .from(billingReconciliationRuns)
    .where(and(
      eq(billingReconciliationRuns.mode, INVOICE_RECONCILE_MODE),
      sql`${billingReconciliationRuns.error} is null`,
    ))
    .orderBy(sql`${billingReconciliationRuns.ranAt} desc`)
    .limit(1);
  return rows[0]?.ranAt ?? null;
}
