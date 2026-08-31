import { asc, eq, inArray, sql } from "drizzle-orm";
import { accounts, type Tx } from "@trafficflow/db";
import {
  billingCustomers, billingReconciliationRuns, billingSubscriptions,
  LIVE_SUBSCRIPTION_STATUSES,
} from "@trafficflow/db/cloud";
import type { Db } from "./../context.js";
import type { EntitlementEvent, ReconcilePageDTO } from "./entitlement-event.js";
import type { WebhookResult } from "./entitlements-service.js";

/**
 * THE BILLING RECONCILIATION — the scheduled pass that makes a lost Stripe webhook a healed,
 * paged incident instead of a permanent, silent divergence (owner decision 2026-08-22).
 *
 * ## The failure this exists for
 *
 * The mirror (`billing_subscriptions`) moves ONLY on webhooks. Stripe retries a failed delivery
 * for ~3 days and then stops forever — so one unlucky outage window, one mis-answered 400, and
 * an account's mirror is wrong for good with every test green. The founding case: a no-card
 * trial ends, Stripe cancels the subscription, the `customer.subscription.deleted` never lands,
 * and the account keeps `trialing` with full features, forever, for free.
 *
 * ## The shape, and why it honours the extraction ruling
 *
 * The plane owns all Stripe access — the license boundary means this server never imports or
 * calls Stripe — and there is deliberately no plane→open callback direction, so the plane
 * cannot push a correction. The split is therefore:
 *
 *  · the PLANE lists its subscriptions (`status:"all"`) and translates each into the
 *    `subscription`-kind {@link EntitlementEvent} the missed webhook would have carried —
 *    `POST /v1/reconcile`, reached through the same one-directional port as every other call;
 *  · THIS pass, open-side where the mirror and the transactions live, compares each event
 *    against the mirror row and, on divergence, hands the event to the SAME
 *    `EntitlementsService.applyEvent` the webhook relay calls. Claim, fence, trial-bounty
 *    idempotency, failure recording, alerting: all of it is the one existing path. There is
 *    deliberately no second write path into the mirror — replay semantics, not repair.
 *
 * ## Idempotence, and the claim id's fence suffix
 *
 * The plane's event id is `recon_<sha256 of the DTO>` — a pure function of the observed state.
 * This pass claims it as `<planeId>_f<mirror fence epoch>`, suffixing the mirror row's current
 * `stripe_event_ts`. Both halves are load-bearing:
 *
 *  · same divergence observed twice (an apply that keeps failing) ⇒ same id ⇒ the failed
 *    `billing_events` row is RE-CLAIMED, exactly as a Stripe retry re-claims it — one durable
 *    queue item, not one per pass;
 *  · the same Stripe state needing re-application LATER (heal A; a webhook moves the mirror to
 *    B; the webhook moving it back to A is lost) ⇒ the fence moved ⇒ new id ⇒ it applies.
 *    Without the suffix that second heal would be a claim `duplicate` forever — a reconciler
 *    that silently cannot reconcile.
 *
 * …and the pass VERIFIES each heal landed: `applyEvent` answers 200 for applied, for
 * fenced-out AND for claim-duplicate, and the last of those can strand a divergence forever (a
 * claim consumed by a pass whose write the fence refused). When the row still drifts although
 * the fence would have admitted the event, the pass re-applies once under an
 * observation-salted id — see the emit path.
 *
 * A pass after convergence emits NOTHING: every comparison matches, no event is applied, and
 * the recorded run says `emitted: 0` — which is also what the alert reads as "resolved".
 *
 * ## What is compared, and what deliberately is not
 *
 * Status, plan price, add-on quantities, `cancel_at_period_end`, and the current period — the
 * fields subscription events carry. The three sold-at allowances (`mailbox_limit`,
 * `monthly_credits`, `storage_bytes_limit`) are NOT compared: they are grandfathered
 * denormalizations that legitimately differ from today's plan card, and no webhook carries
 * them. Invoices and the credit ledger are NOT reconciled — `invoice.paid` money stays on the
 * webhook path with its own failed-row pager; a subscription event replay grants no credits
 * (except the once-per-account trial bounty, idempotent by ledger source).
 *
 * ## Bounds
 *
 * Pages of ≤100 from the plane, at most {@link RECONCILE_MAX_PAGES} of them — written for
 * hundreds of subscriptions, refusing to loop unbounded on thousands. If the bound stops the
 * listing early, `truncated` is recorded and the absence checks (`missing_in_stripe`) are
 * SKIPPED for that pass: an unread page is not evidence of absence.
 */

/** Divergence classes — a CLOSED vocabulary; these strings reach staff-readable rows. */
export type ReconcileCode =
  /** The founding case: a `trialing` mirror row whose period end passed, healed from Stripe. */
  | "trial_expired_stale"
  /** Stripe's status word differs from the mirror's (canceled-vs-active is the money case). */
  | "status_drift"
  /** The plan price id differs — plan changes the mirror never heard. */
  | "price_drift"
  /** Add-on quantities differ (storage units / extra mailboxes). */
  | "addon_drift"
  /** `cancel_at_period_end` differs — a scheduled cancellation the mirror never heard. */
  | "cancel_flag_drift"
  /** The current period moved (a renewal the mirror never heard). */
  | "period_drift"
  /** Stripe holds a subscription resolvable to an account, with no mirror row at all. */
  | "missing_mirror_row"
  /** A live-status mirror row whose `sub_…` id Stripe's full listing does not contain. */
  | "missing_in_stripe"
  /** A LIVE Stripe subscription no account claims — unattributable, needs a human. */
  | "unattributable_subscription"
  /** A hand-inserted test row (`agent_trial_*`): flagged by name, never sent, never mutated. */
  | "test_row"
  /**
   * An operator-comped row (`comp_*`): a deliberate hand-mint that grants entitlements with no
   * Stripe subscription behind it (a `comp_…` id is minted by hand, not by Stripe). Flagged
   * by name on every pass, never mutated, and NOT paged: paging
   * critical forever about a decision someone made on purpose is how a pager gets filtered.
   */
  | "comp_row"
  /** A mirror row whose id is not a Stripe id and not in the operator vocabulary above. */
  | "unreconcilable_id"
  /** A Stripe subscription whose plan items are not exactly one price — a human's shape. */
  | "ambiguous_stripe_state";

/** What one divergence looked like and what the pass did about it. Ids only, never payloads. */
export interface ReconcileDivergence {
  code: ReconcileCode;
  stripeSubscriptionId: string;
  accountId: string | null;
  /** `emitted` (applied), `would_emit` (dry run), `flagged` (unreconcilable — no write). */
  action: "emitted" | "would_emit" | "flagged";
  /** Which mirror fields disagreed, for drift codes. */
  fields?: string[];
  /** `applyEvent`'s HTTP-shaped verdict, when action was `emitted`. */
  applyStatus?: number;
}

/** One pass, summarized — what lands in `billing_reconciliation_runs`. */
export interface ReconcileReport {
  mode: "dry-run" | "apply";
  observedAt: Date;
  stripeSubscriptions: number;
  mirrorRows: number;
  emitted: number;
  applyFailed: number;
  flagged: Record<string, number>;
  divergences: ReconcileDivergence[];
  pages: number;
  truncated: boolean;
}

/** The page-walk bound: 10 pages × 100 = a thousand subscriptions before `truncated`. */
export const RECONCILE_MAX_PAGES = 10;

/** The default wall-clock budget — well inside the hosted route's 60 s `maxDuration`. */
export const RECONCILE_DEADLINE_MS = 40_000;

/** How many divergences the recorded run row keeps. The counts are always complete. */
export const RECONCILE_DIVERGENCE_ROW_CAP = 100;

/** Recorded runs older than this are pruned by the next pass. */
export const RECONCILE_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The prefix of hand-inserted TEST rows (`agent_trial_*`) — a standing signed-in test account. */
export const RECONCILE_TEST_ROW_PREFIX = "agent_trial_";

/** The prefix of operator-comped rows (`comp_*`) — deliberate hand-mints, named and not paged. */
export const RECONCILE_COMP_ROW_PREFIX = "comp_";

/** The port slice this pass needs — `BillingPlanePort.reconcileSubscriptions`, and nothing else. */
export interface ReconcilePlane {
  reconcileSubscriptions(req: { cursor: string | null; limit: number }): Promise<ReconcilePageDTO>;
}

export interface ReconcileOptions {
  /** `dry-run` compares and reports; `apply` re-emits through claim+apply. */
  mode: "dry-run" | "apply";
  plane: ReconcilePlane;
  /**
   * THE ONE WRITE PATH — `EntitlementsService.applyEvent`, injected so this module cannot grow
   * its own mirror write. Unused on a dry run.
   */
  applyEvent: (db: Db, event: EntitlementEvent) => Promise<WebhookResult>;
  now?: () => Date;
  maxPages?: number;
  pageSize?: number;
  /**
   * The wall-clock budget for the whole pass, in ms. The hosted cron runs inside a route whose
   * `maxDuration` is 60 s (`apps/api-vercel/app/[[...path]]/route.ts`), and a pass the platform
   * KILLS records nothing — the exact silent end this module exists to remove. When the budget
   * is spent the pass stops listing and stops emitting, marks the run `truncated` (which the
   * divergence alert pages on), records it, and answers. Progress, then honesty — never a kill.
   */
  deadlineMs?: number;
  /** Skip the run-ledger insert (unit tests of the comparison alone). Defaults to recording. */
  record?: boolean;
}

/** The subscription-kind arm of the union — the only kind the reconcile read carries. */
type SubscriptionEvent = Extract<EntitlementEvent, { kind: "subscription" }>;

interface MirrorRow {
  accountId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  addonStorageUnits: number;
  addonMailboxes: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  stripeEventTs: Date;
}

/** Epoch seconds or null — one comparable shape for both sides' period timestamps. */
const secondsOf = (d: Date | number | null): number | null =>
  d === null ? null : typeof d === "number" ? d : Math.floor(d.getTime() / 1000);

/**
 * The subscription's PLAN price per the DTO — exactly one distinct plan-item price, or null
 * when the shape is not one this pass may reason about (`ambiguous_stripe_state`). The same
 * one-distinct-price rule `entitlements-service.ts#priceOf` enforces with a throw; stated
 * again here because a comparison must be able to REFUSE without throwing away the whole pass.
 */
function planPriceOf(sub: SubscriptionEvent["subscription"]): string | null {
  const ids = [...new Set(
    sub.items.filter((i) => i.addon == null).map((i) => i.priceId).filter((p): p is string => !!p),
  )];
  return ids.length === 1 ? ids[0]! : null;
}

/** Add-on quantities summed per kind — the mirror's `addonUnitsOf`, verbatim semantics. */
function addonUnitsOf(sub: SubscriptionEvent["subscription"]): { storage: number; mailbox: number } {
  const sum = (kind: "storage" | "mailbox"): number =>
    sub.items.filter((i) => i.addon === kind).reduce((n, i) => n + (i.quantity ?? 1), 0);
  return { storage: sum("storage"), mailbox: sum("mailbox") };
}

/** The DTO's period — min start / max end across items, as the mirror upsert computes it. */
function periodOf(sub: SubscriptionEvent["subscription"]): { start: number | null; end: number | null } {
  const starts = sub.items.map((i) => i.currentPeriodStart).filter((n): n is number => typeof n === "number");
  const ends = sub.items.map((i) => i.currentPeriodEnd).filter((n): n is number => typeof n === "number");
  return {
    start: starts.length > 0 ? Math.min(...starts) : null,
    end: ends.length > 0 ? Math.max(...ends) : null,
  };
}

/** Which mirror fields disagree with the observed state. Empty ⇒ converged. */
function driftOf(row: MirrorRow, sub: SubscriptionEvent["subscription"]): string[] {
  const fields: string[] = [];
  if (row.status !== sub.status) fields.push("status");
  const price = planPriceOf(sub);
  if (price !== null && price !== row.stripePriceId) fields.push("stripe_price_id");
  const addons = addonUnitsOf(sub);
  if (addons.storage !== row.addonStorageUnits) fields.push("addon_storage_units");
  if (addons.mailbox !== row.addonMailboxes) fields.push("addon_mailboxes");
  if (row.cancelAtPeriodEnd !== sub.cancelAtPeriodEnd) fields.push("cancel_at_period_end");
  const period = periodOf(sub);
  if (secondsOf(row.currentPeriodStart) !== period.start) fields.push("current_period_start");
  if (secondsOf(row.currentPeriodEnd) !== period.end) fields.push("current_period_end");
  return fields;
}

/** An hour of slack before a passed period end is called the founding case by name. */
const TRIAL_STALE_SLACK_MS = 60 * 60 * 1000;

/**
 * Run one reconciliation pass. Never throws for a divergence — divergences are the OUTPUT; it
 * throws only when the pass itself cannot run (plane unreachable, database down), and the
 * caller records that as a failed run (`recordReconcileFailure`) so the staleness alert can see
 * a reconciler that stopped, not a gap.
 */
export async function reconcileBillingMirror(db: Db, opts: ReconcileOptions): Promise<ReconcileReport> {
  const now = opts.now ?? ((): Date => new Date());
  const maxPages = opts.maxPages ?? RECONCILE_MAX_PAGES;
  const pageSize = opts.pageSize ?? 100;
  const deadlineMs = opts.deadlineMs ?? RECONCILE_DEADLINE_MS;
  const startedAt = now().getTime();
  const outOfTime = (): boolean => now().getTime() - startedAt > deadlineMs;
  const tx = db as unknown as Tx;

  // ── 1. the observed truth: page the plane's status:"all" listing, bounded ──────────────
  const events: SubscriptionEvent[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= maxPages || outOfTime()) {
      truncated = true;
      break;
    }
    const page: ReconcilePageDTO = await opts.plane.reconcileSubscriptions({ cursor, limit: pageSize });
    pages += 1;
    for (const ev of page.events) {
      // The reconcile read carries subscription events only; anything else is a version skew
      // this pass must not guess about — applyEvent's own version pin is the loud path, but a
      // comparison cannot even begin, so the event is simply not compared.
      if (ev.kind === "subscription") events.push(ev);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  // A SPENT BUDGET SKIPS STRAIGHT TO THE RECORD. Past the deadline, every
  // further await — the mirror scan, the listed-id completion, an emit — is a chance for the
  // platform to kill the invocation before `recordReconcileRun`, recreating the silent end the
  // budget exists to remove. Nothing was compared, so nothing is emitted or flagged: the run
  // says truncated, the divergence alert pages the truncation, and the next pass resumes.
  if (outOfTime()) {
    const report: ReconcileReport = {
      mode: opts.mode, observedAt: now(), stripeSubscriptions: events.length, mirrorRows: 0,
      emitted: 0, applyFailed: 0, flagged: {}, divergences: [], pages, truncated: true,
    };
    if (opts.record !== false) await recordReconcileRun(tx, report);
    return report;
  }

  // ── 2. the mirror, whole (bounded by the same order of magnitude as the listing) ───────
  const MIRROR_COLUMNS = {
    accountId: billingSubscriptions.accountId,
    stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
    stripePriceId: billingSubscriptions.stripePriceId,
    status: billingSubscriptions.status,
    addonStorageUnits: billingSubscriptions.addonStorageUnits,
    addonMailboxes: billingSubscriptions.addonMailboxes,
    cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
    currentPeriodStart: billingSubscriptions.currentPeriodStart,
    currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
    stripeEventTs: billingSubscriptions.stripeEventTs,
  } as const;

  /** One fresh row, for the post-apply verification below. */
  const readMirrorRow = async (subId: string): Promise<MirrorRow | null> => {
    const fresh = await tx.select(MIRROR_COLUMNS).from(billingSubscriptions)
      .where(eq(billingSubscriptions.stripeSubscriptionId, subId)).limit(1);
    return fresh[0] ?? null;
  };

  const rows: MirrorRow[] = await tx
    .select({
      accountId: billingSubscriptions.accountId,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      stripePriceId: billingSubscriptions.stripePriceId,
      status: billingSubscriptions.status,
      addonStorageUnits: billingSubscriptions.addonStorageUnits,
      addonMailboxes: billingSubscriptions.addonMailboxes,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      stripeEventTs: billingSubscriptions.stripeEventTs,
    })
    .from(billingSubscriptions)
    .orderBy(asc(billingSubscriptions.createdAt))
    .limit(maxPages * pageSize + 1);
  // The scan is COMPLETE only when it came back under its own bound — the sentinel +1 row is
  // how "exactly at the bound" and "there was more" stay distinguishable. An incomplete scan
  // must not run the absence checks (a row the scan never read is not a row Stripe lost), and
  // it marks the run truncated so the divergence alert makes the bound operator-visible.
  const mirrorScanComplete = rows.length <= maxPages * pageSize;
  if (!mirrorScanComplete) {
    rows.pop();
    truncated = true;
  }
  const mirror = new Map(rows.map((r) => [r.stripeSubscriptionId, r]));

  // EVERY LISTED SUBSCRIPTION GETS ITS REAL ROW, bound or no bound: the bounded
  // oldest-first scan above is the ABSENCE side's population, but using it as
  // the existence map would misread a beyond-bound row as "no mirror row" — and for canceled
  // truth that misread lands in the dormant-history skip, which is precisely the expired-trial
  // heal this module exists for. Fetch the listed ids the scan missed, in bounded chunks.
  {
    const missing = [...new Set(events.map((e) => e.subscription.id))]
      .filter((id) => !mirror.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const found: MirrorRow[] = await tx.select({
        accountId: billingSubscriptions.accountId,
        stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
        stripePriceId: billingSubscriptions.stripePriceId,
        status: billingSubscriptions.status,
        addonStorageUnits: billingSubscriptions.addonStorageUnits,
        addonMailboxes: billingSubscriptions.addonMailboxes,
        cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
        currentPeriodStart: billingSubscriptions.currentPeriodStart,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        stripeEventTs: billingSubscriptions.stripeEventTs,
      }).from(billingSubscriptions)
        .where(inArray(billingSubscriptions.stripeSubscriptionId, chunk));
      for (const r of found) mirror.set(r.stripeSubscriptionId, r);
    }
  }

  const divergences: ReconcileDivergence[] = [];
  let emitted = 0;
  let applyFailed = 0;
  const nowDate = now();

  /** Apply (or record the intent to), through the ONE path. */
  const emit = async (
    ev: SubscriptionEvent, code: ReconcileCode, row: MirrorRow | null, fields?: string[],
    resolvedOwner?: string | null,
  ): Promise<void> => {
    const accountId = row?.accountId ?? resolvedOwner ?? ev.subscription.accountIdFromMetadata;
    const d: ReconcileDivergence = {
      code,
      stripeSubscriptionId: ev.subscription.id,
      accountId,
      action: opts.mode === "apply" ? "emitted" : "would_emit",
      ...(fields && fields.length > 0 ? { fields } : {}),
    };
    if (opts.mode === "apply") {
      // THE FENCE SUFFIX — see the module header. `_f0` for a row the mirror does not hold.
      const fence = row ? Math.floor(row.stripeEventTs.getTime() / 1000) : 0;
      // ATTRIBUTION FOR A KNOWN ROW. `applyEvent` resolves the account from the event's own
      // witnesses (subscription metadata, then the customer link) — right for a webhook, whose
      // subject may predate any mirror row. A reconciliation event about a row the mirror
      // ALREADY HOLDS has a third witness: the row's `account_id`, itself established by a
      // verified event and immovable by upserts (`account_id` is deliberately not in the
      // mirror's SET list). Without this, a Dashboard-created subscription — no metadata
      // stamp, and a customer link that may never have been made — would fail resolution on
      // every heal of a row whose owner was never in question.
      const sub = ev.subscription.accountIdFromMetadata === null && row !== null
        ? { ...ev.subscription, accountIdFromMetadata: row.accountId }
        : ev.subscription;
      const healEvent = { ...ev, id: `${ev.id}_f${fence}`, subscription: sub };
      const result = await opts.applyEvent(db, healEvent);
      d.applyStatus = result.status;
      if (result.status !== 200) {
        applyFailed += 1;
      } else if (row !== null) {
        // THE CONSUMED-CLAIM DEAD END. `applyEvent` answers 200 for
        // three different outcomes: applied, FENCED OUT (the mirror held a newer truth), and
        // CLAIM DUPLICATE (this id was recorded on an earlier pass). The third can strand a
        // divergence forever: a pass whose apply was fenced out still recorded the claim, so
        // when the same Stripe state later becomes the truth again (its webhook lost) the same
        // id — same content, same unchanged fence — is a duplicate that heals nothing, every
        // pass, silently. Verify the heal LANDED; when the row still drifts although the fence
        // WOULD have admitted our event (so a fence-out cannot explain it — only a consumed
        // claim can), re-apply once under an observation-salted id. Salted only on this
        // detected path: the ordinary failed apply keeps its stable id and its single
        // re-claimable billing_events row.
        const after = await readMirrorRow(sub.id);
        const stillDrifting = after !== null && driftOf(after, sub).length > 0;
        const fenceWouldAdmit = after !== null
          && Math.floor(after.stripeEventTs.getTime() / 1000) < ev.created;
        if (stillDrifting && fenceWouldAdmit) {
          const retry = await opts.applyEvent(db, { ...healEvent, id: `${healEvent.id}_r${ev.created}` });
          d.applyStatus = retry.status;
          if (retry.status !== 200) applyFailed += 1;
        }
      }
    }
    emitted += 1;
    divergences.push(d);
  };

  const flag = (
    code: ReconcileCode, stripeSubscriptionId: string, accountId: string | null, fields?: string[],
  ): void => {
    divergences.push({
      code, stripeSubscriptionId, accountId, action: "flagged",
      ...(fields && fields.length > 0 ? { fields } : {}),
    });
  };

  // ── 3. Stripe's side: every listed subscription vs its mirror row ──────────────────────
  for (const ev of events) {
    if (outOfTime()) {
      // The budget is spent: stop emitting, say so, and let the recorded `truncated` page.
      // Unprocessed events are simply not compared this pass — progress resumes next hour.
      truncated = true;
      break;
    }
    const sub = ev.subscription;
    const row = mirror.get(sub.id) ?? null;

    if (row) {
      const fields = driftOf(row, sub);
      if (fields.length === 0) continue;                       // converged — emit nothing
      if (planPriceOf(sub) === null) {
        // A shape the mirror upsert would refuse (`ambiguous_price`): flag it instead of
        // parking a forever-failing billing_events row every pass.
        flag("ambiguous_stripe_state", sub.id, row.accountId, fields);
        continue;
      }
      const staleTrial = row.status === "trialing"
        && row.currentPeriodEnd !== null
        && row.currentPeriodEnd.getTime() < nowDate.getTime() - TRIAL_STALE_SLACK_MS;
      await emit(ev, staleTrial ? "trial_expired_stale" : (
        fields.includes("status") ? "status_drift"
        : fields.includes("stripe_price_id") ? "price_drift"
        : (fields.includes("addon_storage_units") || fields.includes("addon_mailboxes")) ? "addon_drift"
        : fields.includes("cancel_at_period_end") ? "cancel_flag_drift"
        : "period_drift"
      ), row, fields);
      continue;
    }

    // No mirror row. Who owns this subscription?
    const metaAccount = sub.accountIdFromMetadata;
    let owner: string | null = null;
    if (metaAccount) {
      const alive = await tx
        .select({ id: accounts.id }).from(accounts).where(eq(accounts.id, metaAccount)).limit(1);
      owner = alive[0]?.id ?? null;
    }
    if (!owner && sub.customerId) {
      const linked = await tx
        .select({ accountId: billingCustomers.accountId })
        .from(billingCustomers)
        .where(eq(billingCustomers.stripeCustomerId, sub.customerId))
        .limit(1);
      owner = linked[0]?.accountId ?? null;
    }
    if (owner) {
      if (sub.status === "canceled") {
        // A canceled subscription with no mirror row is dormant history: inserting it would
        // move nothing anyone reads (no entitlement flows from `canceled`), and the safe
        // direction for absent state is absent. Deliberately not even flagged — this is the
        // steady state for pre-mirror history.
        continue;
      }
      if (planPriceOf(sub) === null) {
        flag("ambiguous_stripe_state", sub.id, owner);
        continue;
      }
      // A LIVE subscription the mirror never heard of — the lost `customer.subscription.created`.
      await emit(ev, "missing_mirror_row", null, undefined, owner);
      continue;
    }
    // Nobody claims it. Live money moving with no account behind it is a human's problem —
    // flagged by name, never applied (applyEvent would park a forever-failing row).
    if ((LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status)) {
      flag("unattributable_subscription", sub.id, null);
    }
  }

  // ── 4. the mirror's side: rows Stripe did not list. The flags below iterate the BOUNDED
  //      scan, so an incomplete scan flags only what it actually read — and `truncated` (set
  //      above) is what tells the operator the census did not finish.
  const listed = new Set(events.map((e) => e.subscription.id));
  for (const row of rows) {
    const id = row.stripeSubscriptionId;
    if (id.startsWith(RECONCILE_TEST_ROW_PREFIX)) {
      // THE HAND-INSERTED TEST ROW (a standing test account's eternal trial, by design): not
      // reconcilable against Stripe, named by its own code, and NEVER mutated or deleted —
      // the flag is the whole action.
      flag("test_row", id, row.accountId);
      continue;
    }
    if (id.startsWith(RECONCILE_COMP_ROW_PREFIX)) {
      // The operator-comp vocabulary — same posture as the test row: named, untouched, unpaged.
      flag("comp_row", id, row.accountId);
      continue;
    }
    if (!id.startsWith("sub_")) {
      flag("unreconcilable_id", id, row.accountId);
      continue;
    }
    if (!listed.has(id)) {
      // Absent from every page we read. Only meaningful when the listing was COMPLETE, and
      // only alarming for a row that grants something today — there is no truth to copy, so
      // this is never healed, only named.
      if (truncated) continue;
      if ((LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(row.status)) {
        flag("missing_in_stripe", id, row.accountId);
      }
    }
  }

  const flagged: Record<string, number> = {};
  for (const d of divergences) {
    if (d.action === "flagged") flagged[d.code] = (flagged[d.code] ?? 0) + 1;
  }

  const report: ReconcileReport = {
    mode: opts.mode,
    observedAt: nowDate,
    stripeSubscriptions: events.length,
    mirrorRows: rows.length,
    emitted,
    applyFailed,
    flagged,
    divergences,
    pages,
    truncated,
  };

  if (opts.record !== false) {
    await recordReconcileRun(tx, report);
  }
  return report;
}

/** Persist one completed pass and prune the ledger's tail. Codes and ids only — no payloads. */
async function recordReconcileRun(tx: Tx, report: ReconcileReport): Promise<void> {
  await tx.insert(billingReconciliationRuns).values({
    ranAt: report.observedAt,
    mode: report.mode,
    stripeSubscriptions: report.stripeSubscriptions,
    mirrorRows: report.mirrorRows,
    emitted: report.emitted,
    applyFailed: report.applyFailed,
    flagged: report.flagged,
    divergences: report.divergences.slice(0, RECONCILE_DIVERGENCE_ROW_CAP).map((d) => ({
      code: d.code,
      stripeSubscriptionId: d.stripeSubscriptionId,
      accountId: d.accountId,
      action: d.action,
      ...(d.applyStatus !== undefined ? { applyStatus: d.applyStatus } : {}),
    })),
    pages: report.pages,
    truncated: report.truncated,
  });
  const cutoff = new Date(report.observedAt.getTime() - RECONCILE_RUN_RETENTION_MS);
  await tx.delete(billingReconciliationRuns)
    .where(sql`${billingReconciliationRuns.ranAt} < ${cutoff.toISOString()}::timestamptz`);
}

/**
 * Record a pass that DID NOT COMPLETE — plane unreachable, a database refusal mid-walk.
 *
 * `error` is class:code scrubbed by the CALLER (`scrub`'s rule: never message text — a driver
 * message carries connection strings, a fetch error carries URLs). A failed run deliberately
 * does NOT reset the staleness clock: `evaluateAlerts` reads the newest COMPLETED apply-mode
 * row, so a reconciler that fails every pass pages exactly like one that stopped.
 */
export async function recordReconcileFailure(
  db: Db, mode: "dry-run" | "apply", error: string, now: Date = new Date(),
): Promise<void> {
  const tx = db as unknown as Tx;
  await tx.insert(billingReconciliationRuns).values({
    ranAt: now,
    mode,
    stripeSubscriptions: 0,
    mirrorRows: 0,
    emitted: 0,
    applyFailed: 0,
    flagged: {},
    divergences: [],
    pages: 0,
    truncated: false,
    error,
  });
}
